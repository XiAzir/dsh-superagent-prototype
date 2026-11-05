/** Exact-request authorization and crash-safe action execution with adapter verification. */
import { createHash, randomUUID } from 'node:crypto'
import type { PersonalRecordMap } from '../core/personal/model.ts'
import type { PersonalStore } from './personal-store.ts'
import type { Store } from './store.ts'

type Action = PersonalRecordMap['action']
type Authorization = PersonalRecordMap['authorization']
type PersonalRepo = Pick<PersonalStore, 'get' | 'list' | 'save'>
type TicketRepo = Pick<Store['tickets'], 'get'>
export type ActionStore = { personal: PersonalRepo; tickets: TicketRepo; atomic: Store['atomic'] }
export type ActionRequest = { idempotencyKey: string; action: string; target: string; payload: unknown; scope: string[]; risk: Authorization['risk']; expiresAt?: string }
export type ActionVerification = { state: 'executed'; result?: unknown } | { state: 'not_executed' } | { state: 'unknown'; reason?: string }
export interface ActionAdapter {
  /** Performs one registered operation. A thrown error has unknown execution outcome. */
  execute(action: Readonly<Action>): Promise<unknown> | unknown
  /** Must inspect the target state and report whether this exact request took effect. */
  verify(action: Readonly<Action>): Promise<ActionVerification> | ActionVerification
}
/** An action request conflicts with a prior idempotency key, current state, or verified result. */
export class ActionConflict extends Error { constructor(message: string) { super(message); this.name = 'ActionConflict' } }
/** The exact action request lacks a current matching owner authorization. */
export class ActionAuthorizationError extends Error { constructor(message: string) { super(message); this.name = 'ActionAuthorizationError' } }

const iso = (date: Date) => date.toISOString()
function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Action payload must contain finite numbers')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  }
  throw new TypeError('Action payload must be JSON-compatible')
}
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex')

/** Safe action lifecycle. Call grant/revoke only from the owner-authenticated HTTP boundary. */
export class PersonalActionsService {
  private readonly running = new Map<string, Promise<Action>>()
  constructor(private readonly deps: { store: ActionStore; adapters: Record<string, ActionAdapter>; now?: () => Date }) {}
  private now(): Date { return this.deps.now?.() ?? new Date() }
  private all<K extends 'action' | 'authorization'>(kind: K): PersonalRecordMap[K][] {
    const out: PersonalRecordMap[K][] = []
    for (let offset = 0; ; offset += 200) {
      const page = this.deps.store.personal.list(kind, { limit: 200, offset })
      out.push(...page)
      if (page.length < 200) return out
    }
  }
  private requestHash(ticketId: string, input: ActionRequest): string {
    return hash({ ticketId, action: input.action, target: input.target, payload: input.payload, scope: [...new Set(input.scope)].sort(), risk: input.risk })
  }

  /** Persists a request and a dedicated authorization record; duplicate keys replay only identical requests. */
  prepare(ticketId: string, input: ActionRequest): Action {
    const ticket = this.deps.store.tickets.get(ticketId)
    if (!ticket || ticket.ended) throw new ActionConflict(`Ticket ${ticketId} is missing or stopped`)
    if (!input.idempotencyKey || !input.action || !input.target || !Array.isArray(input.scope) || !input.scope.length) throw new TypeError('idempotencyKey, action, target, and scope are required')
    if (!Object.hasOwn(this.deps.adapters, input.action)) throw new ActionConflict(`No adapter registered for action ${input.action}`)
    const requestHash = this.requestHash(ticketId, input)
    const existing = this.all('action').find(row => row.idempotencyKey === input.idempotencyKey)
    if (existing) {
      if (existing.requestHash !== requestHash || existing.ticketId !== ticketId) throw new ActionConflict('Idempotency key already belongs to a different request')
      return existing
    }
    const now = iso(this.now())
    const expiresAt = input.expiresAt ? new Date(input.expiresAt).toISOString() : undefined
    if (expiresAt && new Date(expiresAt) <= new Date(now)) throw new ActionConflict('Authorization expiry must be in the future')
    const authorizationId = randomUUID(), actionId = randomUUID()
    return this.deps.store.atomic(() => {
      const auth: Authorization = { id: authorizationId, revision: 0, createdAt: now, updatedAt: now, sourceRefs: [], ticketId,
        risk: input.risk, scope: [...new Set(input.scope)].sort(), status: 'requested', requestHash, ...(expiresAt ? { expiresAt } : {}) }
      this.deps.store.personal.save('authorization', auth, 0)
      const record: Action = { id: actionId, revision: 0, createdAt: now, updatedAt: now, sourceRefs: [], ticketId, authorizationId,
        idempotencyKey: input.idempotencyKey, action: input.action, target: input.target, payload: JSON.parse(canonical(input.payload)) as Action['payload'],
        requestHash, status: 'prepared' }
      return this.deps.store.personal.save('action', record, 0)
    })
  }

  /** Owner boundary: grants one exact request hash using authorization revision CAS. */
  grant(id: string, input: { expectedRevision: number; requestHash: string; expiresAt?: string; grantedBy: string }): Authorization {
    const current = this.deps.store.personal.get('authorization', id)
    if (!current) throw new ActionConflict(`Unknown authorization ${id}`)
    this.assertAuthorizationHash(current, input.requestHash)
    if (!input.grantedBy) throw new ActionAuthorizationError('Owner identity is required')
    if (current.status !== 'requested') throw new ActionConflict(`Authorization is ${current.status}`)
    const expiry = input.expiresAt ?? current.expiresAt
    if (expiry && new Date(expiry) <= this.now()) throw new ActionConflict('Authorization expiry must be in the future')
    return this.deps.store.personal.save('authorization', { ...current, status: 'granted', grantedBy: input.grantedBy,
      grantedAt: iso(this.now()), updatedAt: iso(this.now()), ...(expiry ? { expiresAt: new Date(expiry).toISOString() } : {}) }, input.expectedRevision)
  }

  /** Owner boundary: revokes using revision CAS and exact request hash. */
  revoke(id: string, input: { expectedRevision: number; requestHash: string }): Authorization {
    const current = this.deps.store.personal.get('authorization', id)
    if (!current) throw new ActionConflict(`Unknown authorization ${id}`)
    this.assertAuthorizationHash(current, input.requestHash)
    if (current.status === 'revoked') return current
    return this.deps.store.personal.save('authorization', { ...current, status: 'revoked', updatedAt: iso(this.now()) }, input.expectedRevision)
  }

  check(actionId: string): { allowed: boolean; action: Action; reason?: string } {
    const action = this.deps.store.personal.get('action', actionId)
    if (!action) throw new ActionConflict(`Unknown action ${actionId}`)
    const reason = this.blockReason(action)
    return reason ? { allowed: false, action, reason } : { allowed: true, action }
  }

  /** Idempotent concurrent execute; interrupted `executing` records are verified before any retry. */
  execute(actionId: string): Promise<Action> {
    const active = this.running.get(actionId)
    if (active) return active
    const task = this.run(actionId).finally(() => this.running.delete(actionId))
    this.running.set(actionId, task)
    return task
  }

  private async run(actionId: string): Promise<Action> {
    let action = this.deps.store.personal.get('action', actionId)
    if (!action) throw new ActionConflict(`Unknown action ${actionId}`)
    if (action.status === 'verified') return action
    const adapter = Object.hasOwn(this.deps.adapters, action.action) ? this.deps.adapters[action.action] : undefined
    if (!adapter) throw new ActionConflict(`No adapter registered for action ${action.action}`)
    if (action.status === 'executing' || action.status === 'failed' || action.status === 'uncertain') {
      let checked: ActionVerification
      try { checked = await adapter.verify(action) }
      catch (error) { return this.saveResult(action, 'uncertain', { verification: 'adapter verify failed', error: this.errorText(error) }, false) }
      if (checked.state === 'executed') return this.saveResult(action, 'verified', checked.result, true)
      if (checked.state === 'unknown') return this.saveResult(action, 'uncertain', { verification: checked.reason ?? 'unknown' }, false)
      if (action.status === 'uncertain') return this.saveResult(action, 'failed', { verification: 'not_executed' }, false)
      // A clear not_executed verification authorizes a safe retry only after rechecking ticket and grant.
      const retryBlock = this.blockReason(action)
      if (retryBlock) return this.saveResult(action, 'failed', { verification: 'not_executed', blockedBy: retryBlock }, false)
    }

    const reason = this.blockReason(action)
    if (reason) throw new ActionAuthorizationError(reason)

    // Durable executing marker is written before the adapter may cause an external side effect.
    action = this.deps.store.personal.save('action', { ...action, status: 'executing', updatedAt: iso(this.now()) }, action.revision)
    let adapterResult: unknown
    try { adapterResult = await adapter.execute(action) }
    catch (error) {
      const check = await Promise.resolve().then(() => adapter.verify(action!)).catch((): ActionVerification => ({ state: 'unknown', reason: 'adapter verify failed' }))
      if (check.state === 'executed') return this.saveResult(action, 'verified', check.result ?? adapterResult, true)
      if (check.state === 'not_executed') return this.saveResult(action, 'failed', { verification: 'not_executed', error: this.errorText(error) }, false)
      return this.saveResult(action, 'uncertain', { verification: check.reason ?? 'unknown', error: this.errorText(error) }, false)
    }

    // Recheck after the side effect. Ticket stop/revocation cannot erase a real verified external result.
    const check = await Promise.resolve().then(() => adapter.verify(action)).catch((): ActionVerification => ({ state: 'unknown', reason: 'adapter verify failed' }))
    if (check.state === 'executed') return this.saveResult(action, 'verified', check.result ?? adapterResult, true)
    if (check.state === 'not_executed') return this.saveResult(action, 'failed', { verification: 'not_executed', adapterResult }, false)
    return this.saveResult(action, 'uncertain', { verification: check.reason ?? 'unknown', adapterResult }, false)
  }

  private saveResult(action: Action, status: Action['status'], result: unknown, verified: boolean): Action {
    const current = this.deps.store.personal.get('action', action.id)
    if (!current) throw new ActionConflict(`Action ${action.id} disappeared`)
    if (current.status === 'verified') return current
    return this.deps.store.personal.save('action', { ...current, status, result, updatedAt: iso(this.now()), ...(verified ? { verifiedAt: iso(this.now()) } : {}) }, current.revision)
  }
  private blockReason(action: Action): string | undefined {
    const ticket = this.deps.store.tickets.get(action.ticketId)
    if (!ticket || ticket.ended) return 'ticket_stopped'
    if (!Object.hasOwn(this.deps.adapters, action.action)) return 'adapter_unavailable'
    if (!action.authorizationId) return 'authorization_missing'
    const authorization = this.deps.store.personal.get('authorization', action.authorizationId)
    if (!authorization) return 'authorization_missing'
    if (authorization.requestHash !== action.requestHash) return 'authorization_request_mismatch'
    const recomputed = hash({ ticketId: action.ticketId, action: action.action, target: action.target, payload: action.payload,
      scope: [...authorization.scope].sort(), risk: authorization.risk })
    if (recomputed !== action.requestHash) return 'action_request_tampered'
    if (authorization.status !== 'granted') return `authorization_${authorization.status}`
    if (authorization.expiresAt && new Date(authorization.expiresAt) <= this.now()) return 'authorization_expired'
    return undefined
  }
  private assertAuthorizationHash(authorization: Authorization, hashValue: string): void {
    if (authorization.requestHash !== hashValue) throw new ActionAuthorizationError('Authorization hash does not match the exact prepared request')
  }
  private errorText(error: unknown): string { return error instanceof Error ? error.message : String(error) }
}
