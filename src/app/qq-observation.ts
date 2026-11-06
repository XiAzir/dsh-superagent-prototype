/** Durable admission and execution budgets for opt-in QQ group observation. */
import { latestAssignment, liveTicket, reasonText, type Ticket } from '../core/index.ts'
import { record } from '../kv.ts'
import type { Store } from './store.ts'

export interface ObservationLimits {
  maxCandidatesPerHour: number
  maxInputCharsPerHour: number
  maxActiveTasks: number
  maxTaskMinutes: number
  maxModelCallsPerDay: number
  maxTokensPerDay: number
  /** Optional cap in the model service's configured accounting unit. */
  maxCostPerDay?: number
}
export interface ObservationMarker { groupId: string; windowId: string }
export interface ObservationRecord {
  id: string; at: string; groupId: string; kind: 'candidate' | 'discarded' | 'launch' | 'hold' | 'usage'
  triggerId?: string; ticketId?: string; reason?: string; tokens?: number; cost?: number
  usage: 'known' | 'unknown'; callId?: string
  outcome?: { kind: string; ticketId?: string; reason: string }
}
export interface ObservationGuard { allowed: boolean; reason?: string; retryAt?: string }
export interface ObservationHold { id: string; ticketId: string; reason: string; kind: 'runtime' | 'tokens' | 'revoked' }
interface Usage { calls: number; tokens: number; cost: number; unknown: boolean }
interface Hour { count: number; chars: number }
const PREFIX = 'qq-observation:'
const rowKey = (id: string) => record<ObservationRecord>(`${PREFIX}record:${id}`)
const usageKey = (group: string, day: string) => record<Usage>(`${PREFIX}usage:${group}:${day}`)
const hourKey = (group: string, hour: string) => record<Hour>(`${PREFIX}hour:${group}:${hour}`)
const nextHour = (now: Date) => new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000 + 3_600_000).toISOString()
const nextDay = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString()

/** The host applies returned holds; this component never withdraws a task's mandate or sends messages. */
export class QqObservationBudget {
  constructor(private readonly host: {
    store: Pick<Store, 'get' | 'set' | 'keys' | 'atomic' | 'tickets' | 'triggers' | 'decisions'>
      & Partial<Pick<Store, 'db'>>
    limits(): ObservationLimits
    allowed(groupId: string): boolean
  }, private readonly now = () => new Date()) {}

  marker(ticket: Ticket): ObservationMarker | undefined {
    if (ticket.mandate.strength !== 'inferred') return undefined
    const value = this.host.store.triggers.get(ticket.origin.triggerId)?.meta.observation
    return value && typeof value === 'object' && typeof (value as ObservationMarker).groupId === 'string'
      && typeof (value as ObservationMarker).windowId === 'string' ? value as ObservationMarker : undefined
  }
  private write(value: ObservationRecord): void { this.host.store.set(rowKey(value.id), value) }
  private usageOf(group: string): Usage {
    return this.host.store.get(usageKey(group, this.now().toISOString().slice(0, 10))) ?? { calls: 0, tokens: 0, cost: 0, unknown: false }
  }
  private quota(groupId: string): ObservationGuard {
    const usage = this.usageOf(groupId), limits = this.host.limits()
    if (usage.calls >= limits.maxModelCallsPerDay || usage.tokens >= limits.maxTokensPerDay
      || limits.maxCostPerDay !== undefined && usage.cost >= limits.maxCostPerDay) {
      return { allowed: false, reason: usage.tokens >= limits.maxTokensPerDay ? 'QQ observation token budget exhausted.'
        : limits.maxCostPerDay !== undefined && usage.cost >= limits.maxCostPerDay ? 'QQ observation model-cost budget exhausted.' : 'QQ observation model-call budget exhausted.',
        retryAt: nextDay(this.now()) }
    }
    return { allowed: true }
  }
  /** Reserve candidate input before it can create an assessment effect. Replays reuse the same result. */
  admit(groupId: string, triggerId: string, chars: number): ObservationGuard {
    return this.host.store.atomic(() => {
      const old = this.host.store.get(rowKey(`candidate:${triggerId}`))
      if (old) return { allowed: old.kind === 'candidate', ...old.reason ? { reason: old.reason } : {} }
      const now = this.now(), at = now.toISOString(), limits = this.host.limits(), key = hourKey(groupId, at.slice(0, 13))
      const hour = this.host.store.get(key) ?? { count: 0, chars: 0 }
      const quota = this.quota(groupId)
      const refusal = !this.host.allowed(groupId) ? 'QQ group observation is disabled.' : !quota.allowed ? quota.reason
        : hour.count >= limits.maxCandidatesPerHour ? 'QQ observation candidate budget exhausted.'
          : hour.chars + chars > limits.maxInputCharsPerHour ? 'QQ observation input budget exhausted.' : undefined
      this.write({ id: `candidate:${triggerId}`, at, groupId, triggerId, kind: refusal ? 'discarded' : 'candidate', usage: 'unknown',
        ...refusal ? { reason: refusal } : {} })
      if (refusal) return { allowed: false, reason: refusal, retryAt: quota.retryAt ?? nextHour(now) }
      this.host.store.set(key, { count: hour.count + 1, chars: hour.chars + chars })
      return { allowed: true }
    })
  }
  /** Launch-time guard: queued tasks wait for capacity, revoked groups and daily quotas. */
  launchGuard(ticket: Ticket): ObservationGuard {
    const marker = this.marker(ticket)
    if (!marker) return { allowed: true }
    if (!this.host.allowed(marker.groupId)) return { allowed: false, reason: 'QQ group observation authorization changed.' }
    const quota = this.quota(marker.groupId)
    if (!quota.allowed) return quota
    return this.host.store.atomic(() => {
      const running = this.host.store.tickets.open().filter(item => {
        if (item.id === ticket.id || !liveTicket(item) || this.marker(item)?.groupId !== marker.groupId) return false
        const assignment = latestAssignment(item)
        const lease = this.host.store.get<{ assignmentId: string; until: number }>(`${PREFIX}lease:${item.id}`)
        return assignment?.state === 'running' || assignment?.state === 'pending' && lease?.assignmentId === assignment.id && lease.until > this.now().getTime()
      })
      if (running.length >= this.host.limits().maxActiveTasks) return { allowed: false, reason: 'QQ observation concurrency budget reached.',
        retryAt: new Date(this.now().getTime() + 30_000).toISOString() }
      const assignment = latestAssignment(ticket)
      if (assignment) this.host.store.set(record<{ assignmentId: string; until: number }>(`${PREFIX}lease:${ticket.id}`),
        { assignmentId: assignment.id, until: this.now().getTime() + 5 * 60_000 })
      const id = `launch:${ticket.id}:${assignment?.id ?? 'pending'}`
      if (!this.host.store.get(rowKey(id))) this.write({ id, at: this.now().toISOString(), groupId: marker.groupId,
        ticketId: ticket.id, kind: 'launch', usage: 'unknown' })
      return { allowed: true }
    })
  }
  /** Record an actual model call once. Missing counters remain explicitly unknown. */
  usage(ticketId: string, input: { tokens?: number; cost?: number; callId: string; at?: string }): void {
    const ticket = this.host.store.tickets.get(ticketId), marker = ticket && this.marker(ticket)
    if (!marker) return
    this.charge(marker.groupId, ticketId, input)
  }
  /** Apportion a batched Router assessment call across the distinct observed groups it actually saw. */
  assessmentUsage(triggerIds: string[], input: { tokens?: number; cost?: number; callId: string }): void {
    const groups = [...new Set(triggerIds.flatMap(id => {
      const marker = this.host.store.triggers.get(id)?.meta.observation as ObservationMarker | undefined
      return marker?.groupId ? [marker.groupId] : []
    }))].sort()
    groups.forEach((group, index) => {
      const tokens = input.tokens === undefined ? undefined : Math.floor(input.tokens / groups.length) + (index < input.tokens % groups.length ? 1 : 0)
      this.charge(group, undefined, { ...input, ...tokens === undefined ? {} : { tokens },
        ...input.cost === undefined ? {} : { cost: input.cost / groups.length } })
    })
  }
  private charge(groupId: string, ticketId: string | undefined, input: { tokens?: number; cost?: number; callId: string }): void {
    if (!input.callId || input.callId.length > 500 || input.tokens !== undefined && (!Number.isSafeInteger(input.tokens) || input.tokens < 0)
      || input.cost !== undefined && (!Number.isFinite(input.cost) || input.cost < 0)) throw new Error('Invalid observation usage')
    this.host.store.atomic(() => {
      const id = `call:${groupId}:${input.callId}`
      if (this.host.store.get(rowKey(id))) return
      const at = this.now().toISOString(), key = usageKey(groupId, at.slice(0, 10)), usage = this.host.store.get(key)
        ?? { calls: 0, tokens: 0, cost: 0, unknown: false }
      this.write({ id, at, groupId, ...ticketId ? { ticketId } : {}, kind: 'usage', callId: input.callId,
        usage: input.tokens === undefined ? 'unknown' : 'known', ...input.tokens === undefined ? {} : { tokens: input.tokens },
        ...input.cost === undefined ? {} : { cost: input.cost } })
      this.host.store.set(key, { calls: usage.calls + 1, tokens: usage.tokens + (input.tokens ?? 0), cost: usage.cost + (input.cost ?? 0),
        unknown: usage.unknown || input.tokens === undefined })
    })
  }
  /** Repeated calls return the same stable hold identity until the host has held or ended the assignment. */
  tick(): ObservationHold[] {
    const holds: ObservationHold[] = [], limits = this.host.limits(), now = this.now()
    for (const ticket of this.host.store.tickets.open()) {
      const marker = this.marker(ticket), assignment = latestAssignment(ticket)
      if (!marker || !liveTicket(ticket) || assignment?.state !== 'running') continue
      const quota = this.quota(marker.groupId)
      const elapsed = assignment.startedAt ? now.getTime() - Date.parse(assignment.startedAt) : 0
      const kind = !this.host.allowed(marker.groupId) ? 'revoked' : !quota.allowed ? 'tokens'
        : elapsed >= limits.maxTaskMinutes * 60_000 ? 'runtime' : undefined
      if (!kind) continue
      const reason = kind === 'revoked' ? 'QQ group observation authorization changed.'
        : kind === 'tokens' ? quota.reason! : 'QQ observation task runtime budget exhausted.'
      const id = `hold:${ticket.id}:${assignment.id}:${kind}:${now.toISOString().slice(0, 10)}`
      if (!this.host.store.get(rowKey(id))) this.write({ id, at: now.toISOString(), groupId: marker.groupId,
        ticketId: ticket.id, kind: 'hold', reason, usage: 'unknown' })
      holds.push({ id, ticketId: ticket.id, reason, kind })
    }
    return holds
  }
  records(args: { groupId?: string; offset?: number; limit?: number } = {}): { items: ObservationRecord[]; nextOffset: number | null } {
    const offset = Math.max(0, Math.floor(args.offset ?? 0)), limit = Math.max(1, Math.min(100, Math.floor(args.limit ?? 30)))
    const prefix = `${PREFIX}record:`
    const page = this.host.store.db ? this.host.store.db.prepare(`SELECT value FROM kv WHERE key >= ? AND key < ?
      AND (? IS NULL OR value ->> '$.groupId' = ?) ORDER BY value ->> '$.at' DESC, key LIMIT ? OFFSET ?`)
      .all(prefix, `${prefix}\uffff`, args.groupId ?? null, args.groupId ?? null, limit + 1, offset).map(row => JSON.parse(String(row.value)) as ObservationRecord)
      : this.host.store.keys(prefix).map(key => this.host.store.get<ObservationRecord>(key))
        .filter((row): row is ObservationRecord => !!row && (!args.groupId || row.groupId === args.groupId))
        .sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id)).slice(offset, offset + limit + 1)
    const items = page.slice(0, limit).map(row => {
      const decisionId = row.triggerId && this.host.store.triggers.disposition(row.triggerId)?.decisionId
      const decision = decisionId && this.host.store.decisions.get(decisionId)
      return decision ? { ...row, outcome: { kind: decision.kind, ...decision.ticketId ? { ticketId: decision.ticketId } : {},
        reason: reasonText(decision.reason) } } : row
    })
    return { items, nextOffset: page.length > limit ? offset + limit : null }
  }
  summary(groupId: string): Usage { return this.usageOf(groupId) }
}
