/** Personal goals, commitments and user-confirmed context on the existing transactional Store. */
import { z } from 'zod'
import { key, liveTicket, type Trigger } from '../core/index.ts'
import { PersonalSchemas, type PersonalKind, type PersonalRecord, type PersonalRecordMap } from '../core/personal/model.ts'
import type { Store } from './store.ts'

export const EditablePersonalKinds = ['goal', 'commitment', 'fact', 'constraint'] as const
export type EditablePersonalKind = typeof EditablePersonalKinds[number]
export class PersonalError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409, message: string) { super(message) }
}
export const PersonalWriteSchema = z.object({
  id: z.string().min(1).max(200), revision: z.number().int().nonnegative(), value: z.record(z.string(), z.unknown()),
}).strict()
export type PersonalWrite = z.infer<typeof PersonalWriteSchema>
const editable = z.enum(EditablePersonalKinds)
const protectedKeys = new Set(['id', 'revision', 'createdAt', 'updatedAt', 'sourceRefs'])
const defaults = {
  goal: { priority: 50, successCriteria: [], status: 'active' },
  commitment: { owner: 'assistant', status: 'open', goalIds: [], ticketIds: [] },
  fact: { confidence: 1, confirmation: 'user', status: 'active' },
  constraint: { severity: 'soft', status: 'active' },
}
export interface PersonalCoordinatorHost {
  store: Store
  personalMode(): boolean
  now?(): Date
}

export class PersonalCoordinator {
  constructor(readonly host: PersonalCoordinatorHost) {}
  private now(): string { return (this.host.now?.() ?? new Date()).toISOString() }
  enabled(): boolean { return this.host.personalMode() && this.host.store.personal.settings().enabled }
  requireEnabled(): void {
    if (!this.enabled()) throw new PersonalError(403, '请先在个人助理页面启用此功能。')
  }
  /** Model tools carry an original, admitted owner message instead of accepting a claimed identity. */
  ownerTrigger(id: string): Trigger {
    this.requireEnabled()
    const { store } = this.host, trigger = store.triggers.get(id)
    const actor = trigger && `${trigger.actor.source}:${trigger.actor.id}`
    const allowed = trigger && store.settings().sources[trigger.source]?.enabled
      && store.settings().policy.sources[trigger.source]?.allowed.some(item => item.id === trigger.actor.id)
    if (!trigger?.human || (trigger.source !== 'web' && trigger.addressed !== 'direct') || !actor || !allowed || store.triggers.disposition(id)?.filtered
      || !store.personal.settings().ownerActors.includes(actor)) {
      throw new PersonalError(403, '此请求来源未获个人状态访问授权。')
    }
    return trigger
  }
  ownerTicket(id: string): void {
    const ticket = this.host.store.tickets.get(id)
    if (!ticket || !liveTicket(ticket)) throw new PersonalError(403, '此工单已结束或不存在。')
    this.ownerTrigger(ticket.origin.triggerId)
  }
  list(kind: PersonalKind, query: { offset?: number; limit?: number; status?: string; ticketId?: string } = {}) {
    const limit = Math.min(100, Math.max(1, query.limit ?? 50)), offset = query.offset ?? 0
    const items = this.host.store.personal.list(kind, { ...query, offset, limit: limit + 1 })
    return { items: items.slice(0, limit), next_offset: items.length > limit ? offset + limit : null }
  }
  /** Owner-only panel updates may confirm facts; model writes always retain facts as proposals. */
  write<K extends EditablePersonalKind>(kind: K, request: PersonalWrite, origin: { triggerId?: string } = {}): PersonalRecordMap[K] {
    this.requireEnabled()
    editable.parse(kind); PersonalWriteSchema.parse(request)
    if (origin.triggerId) this.ownerTrigger(origin.triggerId)
    if (Object.keys(request.value).some(field => protectedKeys.has(field))) throw new PersonalError(400, '身份、来源和版本由服务端保存。')
    const { store } = this.host
    return store.atomic(() => {
      const before = store.personal.get(kind, request.id), at = this.now()
      const source = origin.triggerId ? `trigger/${origin.triggerId}` : 'owner/panel'
      const fields: Record<string, unknown> = { ...defaults[kind], ...before, ...request.value, id: request.id, revision: before?.revision ?? 0,
        createdAt: before?.createdAt ?? at, updatedAt: at, sourceRefs: [...new Set([...(before?.sourceRefs ?? []), source])].slice(-100) }
      if (origin.triggerId && kind === 'fact') Object.assign(fields, { status: 'candidate', confirmation: 'inferred', confidence: Math.min(Number(fields.confidence ?? 0.5), 0.8) })
      if (origin.triggerId && kind === 'constraint' && fields.severity === 'hard') {
        throw new PersonalError(400, '硬性约束请在个人助理页面确认。')
      }
      const item = PersonalSchemas[kind].parse(fields)
      if (kind === 'commitment') this.validateCommitment(item as PersonalRecordMap['commitment'])
      if (kind === 'fact') this.validateFact(item as PersonalRecordMap['fact'])
      const saved = store.personal.save(kind, item as PersonalRecordMap[K], request.revision)
      if (kind === 'fact') {
        const fact = saved as PersonalRecordMap['fact']
        if (fact.status === 'active' && fact.supersedes) {
          const old = store.personal.get('fact', fact.supersedes)!
          if (old.status === 'active') store.personal.save('fact', { ...old, status: 'superseded', updatedAt: at }, old.revision)
        }
      }
      if (kind === 'commitment' && ['fulfilled', 'cancelled'].includes(saved.status)) {
        for (const notice of this.all('attention')) if (notice.commitmentId === saved.id && notice.status !== 'resolved') {
          store.personal.save('attention', { ...notice, status: 'resolved', updatedAt: at }, notice.revision)
        }
      }
      return saved
    })
  }
  private validateCommitment(item: PersonalRecordMap['commitment']): void {
    const { store } = this.host
    for (const id of item.goalIds) if (!store.personal.get('goal', id)) throw new PersonalError(400, `关联目标不存在：${id}`)
    for (const id of item.ticketIds) {
      const ticket = store.tickets.get(id)
      if (!ticket) throw new PersonalError(400, `关联工单不存在：${id}`)
      this.ownerTrigger(ticket.origin.triggerId)
    }
    if (['open', 'waiting', 'overdue'].includes(item.status) && !(item.nextCheckAt || item.dueAt || item.expectedAt)) {
      throw new PersonalError(400, '开放事项请填写截止、预计回复或复查时间。')
    }
  }
  private validateFact(item: PersonalRecordMap['fact']): void {
    if (item.validFrom && item.validUntil && item.validFrom >= item.validUntil) throw new PersonalError(400, '失效时间应晚于生效时间。')
    if (item.supersedes) {
      const previous = this.host.store.personal.get('fact', item.supersedes)
      const current = this.host.store.personal.get('fact', item.id)
      const retainedReplacement = current?.status === 'active' && current.supersedes === item.supersedes && previous?.status === 'superseded'
      if (!previous || (previous.status !== 'active' && !retainedReplacement) || previous.id === item.id || previous.subject !== item.subject || previous.predicate !== item.predicate || previous.scope !== item.scope) {
        throw new PersonalError(400, '替代记录须属于同一主体、属性和场景。')
      }
    }
  }
  remove(kind: EditablePersonalKind, id: string, revision: number): void {
    this.requireEnabled(); editable.parse(kind)
    const { store } = this.host
    if (kind === 'goal' && this.all('commitment').some(item => item.goalIds.includes(id))) {
      throw new PersonalError(409, '请先解除事项与此目标的关联。')
    }
    store.personal.delete(kind, id, revision)
  }
  /** Bounded pages keep the SQL interface shared with the panel; stable snapshots precede writes. */
  all<K extends PersonalKind>(kind: K): PersonalRecordMap[K][] {
    const result: PersonalRecordMap[K][] = []
    for (let offset = 0; ; offset += 100) {
      const page = this.host.store.personal.list(kind, { offset, limit: 100 })
      result.push(...page)
      if (page.length < 100) return result
    }
  }
  context(ticketId?: string) {
    this.requireEnabled()
    if (ticketId) this.ownerTicket(ticketId)
    const now = this.now(), store = this.host.store
    const commitments = this.all('commitment').filter(item => !['fulfilled', 'cancelled'].includes(item.status)
      && (!ticketId || item.ticketIds.includes(ticketId)))
    const goals = this.all('goal').filter(item => item.status === 'active'
      && (!ticketId || commitments.some(commitment => commitment.goalIds.includes(item.id))))
    const facts = this.all('fact').filter(item => item.status === 'active' && item.confirmation === 'user'
      && (!item.validFrom || item.validFrom <= now) && (!item.validUntil || item.validUntil > now)
      && (!ticketId || item.scope === `ticket:${ticketId}` || item.scope === 'global'))
    const constraints = this.all('constraint').filter(item => item.status === 'active'
      && (!item.startAt || item.startAt <= now) && (!item.endAt || item.endAt > now)
      && (!ticketId || item.scope === `ticket:${ticketId}` || item.scope === 'global'))
    return { goals: goals.slice(0, 30), commitments: commitments.slice(0, 50), facts: facts.slice(0, 50), constraints: constraints.slice(0, 50),
      truncated: goals.length > 30 || commitments.length > 50 || facts.length > 50 || constraints.length > 50,
      timezone: store.personal.settings().timezone, observedAt: now }
  }
  /** Explicitly evaluate a proposal before reserving time or money; findings name their evidence. */
  conflicts(proposal: { startAt?: string; endAt?: string; amount?: number; currency?: string; scope?: string }) {
    const date = z.string().datetime({ offset: true }).transform(value => new Date(value).toISOString())
    const input = z.object({ startAt: date.optional(), endAt: date.optional(), amount: z.number().nonnegative().optional(),
      currency: z.string().optional(), scope: z.string().optional() }).strict().parse(proposal)
    if (input.startAt && input.endAt && input.startAt >= input.endAt) throw new PersonalError(400, '结束时间应晚于开始时间。')
    return this.all('constraint').filter(item => item.status === 'active' && (!item.scope || item.scope === 'global' || item.scope === input.scope))
      .flatMap(item => {
        const time = item.kind === 'time' && input.startAt && input.endAt && item.startAt && item.endAt
          && input.startAt < item.endAt && input.endAt > item.startAt
        const budget = item.kind === 'budget' && input.amount !== undefined && item.amount !== undefined
          && input.currency === item.currency && input.amount > item.amount
        return time || budget ? [{ id: item.id, title: item.title, severity: item.severity, sourceRefs: item.sourceRefs }] : []
      })
  }
  /** The caller queues reminders in the same transaction before acknowledging a due commitment. */
  evaluateDue(queue: (item: { title: string; summary: string; priority: 'P1' | 'P2'; digestKey: string; commitmentId: string; ticketId?: string }, id: string) => void): void {
    if (!this.enabled()) return
    const now = this.now(), { store } = this.host
    for (const old of this.all('commitment')) {
      if (['fulfilled', 'cancelled'].includes(old.status)) continue
      const due = old.nextCheckAt ?? old.expectedAt ?? old.dueAt
      if (!due || due > now) continue
      const occurrence = key('commitment', old.id, due)
      store.atomic(() => {
        const item = store.personal.get('commitment', old.id)
        if (!item || item.revision !== old.revision) return
        const overdue = !!item.dueAt && item.dueAt <= now
        queue({ title: item.title, summary: overdue ? '已到截止时间，请核实结果或安排下一步。' : '已到复查时间，请核实等待事项。',
          priority: overdue ? 'P1' : 'P2', commitmentId: item.id, digestKey: `commitment:${item.id}`,
          ...(item.ticketIds[0] ? { ticketId: item.ticketIds[0] } : {}) }, occurrence)
        // Record the next bounded check even when the model or external service is unavailable.
        const nextCheckAt = new Date(Date.parse(now) + 24 * 60 * 60_000).toISOString()
        store.personal.save('commitment', { ...item, nextCheckAt, status: overdue ? 'overdue' : item.status, updatedAt: now }, item.revision)
      })
    }
  }
}
