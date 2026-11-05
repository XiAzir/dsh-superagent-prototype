/** Quiet-hour-aware attention queue with revision-bound, idempotent delivery snapshots. */
import { createHash } from 'node:crypto'
import type { PersonalRecordMap, PersonalSettings } from '../core/personal/model.ts'
import type { PersonalStore } from './personal-store.ts'
import type { Store } from './store.ts'

type Attention = PersonalRecordMap['attention']
type PersonalRepo = Pick<PersonalStore, 'get' | 'list' | 'save' | 'settings'>
type TicketRepo = Pick<Store['tickets'], 'get'>
export type AttentionStore = { personal: PersonalRepo; tickets?: TicketRepo; atomic?: Store['atomic'] }
export type AttentionInput = {
  title: string; summary: string; priority: Attention['priority']; digestKey: string
  ticketId?: string; commitmentId?: string; notBefore?: string; dueAt?: string; sourceRefs?: string[]
}
export type AttentionDelivery = { deliveryId: string; digestKey: string; priority: Attention['priority']; items: Attention[]; text: string }
export type AttentionSink = (delivery: AttentionDelivery) => Promise<'sent' | 'pending'> | 'sent' | 'pending'
/** An attention item or delivery snapshot is missing, stale, or no longer eligible for its transition. */
export class AttentionConflict extends Error { constructor(message: string) { super(message); this.name = 'AttentionConflict' } }

const iso = (date: Date) => date.toISOString()
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value !== null && typeof value === 'object' ? `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}` : JSON.stringify(value)
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex')
const deliveryId = (items: readonly Attention[]) => `attention:${digest([...items].sort((a, b) => a.id.localeCompare(b.id)).map(item => [item.id, item.revision]))}`

/** Stores attention items and returns stable delivery snapshots for a caller-owned sink. */
export class PersonalAttentionService {
  constructor(private readonly deps: { store: AttentionStore; now?: () => Date }) {}
  private now(): Date { return this.deps.now?.() ?? new Date() }
  private listAll(status?: string): Attention[] {
    const out: Attention[] = []
    for (let offset = 0; ; offset += 200) {
      const page = this.deps.store.personal.list('attention', { limit: 200, offset, ...(status ? { status } : {}) })
      out.push(...page)
      if (page.length < 200) return out
    }
  }

  /** Idempotent per requestId; individual records are grouped into digest batches at delivery time. */
  queue(input: AttentionInput, requestId: string): Attention {
    if (!requestId) throw new TypeError('requestId is required')
    const current = this.now(), now = iso(current), requestHash = digest(input), id = `attention:${digest(requestId)}`
    const requestRef = `attention-request:${requestHash}`
    const replay = this.deps.store.personal.get('attention', id)
    if (replay) {
      if (!replay.sourceRefs.includes(requestRef)) throw new AttentionConflict('requestId already belongs to different attention content')
      return replay
    }
    const title = input.title.slice(0, 200), summary = input.summary.slice(0, 4000)
    const values = {
      title, summary, priority: input.priority,
      ...(input.ticketId ? { ticketId: input.ticketId } : {}), ...(input.commitmentId ? { commitmentId: input.commitmentId } : {}),
      digestKey: input.digestKey,
      ...((input.notBefore || input.priority === 'P2') ? { notBefore: new Date(input.notBefore ?? current.getTime() + this.deps.store.personal.settings().digestMinutes * 60_000).toISOString() } : {}),
      ...(input.dueAt ? { dueAt: new Date(input.dueAt).toISOString() } : {}),
    }
    const created: Attention = { id, revision: 0, createdAt: now, updatedAt: now,
      sourceRefs: [...new Set([...(input.sourceRefs ?? []).slice(0, 99), requestRef])],
      ...values, status: 'queued' }
    return this.deps.store.personal.save('attention', created, 0)
  }

  /** Resolve queued items linked to a commitment or ticket; stopped/missing tickets are filtered during collection. */
  resolve(criteria: { ticketId?: string; commitmentId?: string }): number {
    if (!criteria.ticketId && !criteria.commitmentId) throw new TypeError('ticketId or commitmentId is required')
    const now = iso(this.now()); let changed = 0
    for (const row of this.listAll('queued')) {
      if (criteria.ticketId && !criteria.commitmentId && row.commitmentId) continue
      if ((criteria.ticketId && row.ticketId !== criteria.ticketId) || (criteria.commitmentId && row.commitmentId !== criteria.commitmentId)) continue
      this.deps.store.personal.save('attention', { ...row, status: 'resolved', updatedAt: now }, row.revision); changed++
    }
    return changed
  }

  acknowledge(id: string): Attention {
    const row = this.deps.store.personal.get('attention', id)
    if (!row) throw new AttentionConflict(`Unknown attention item ${id}`)
    if (row.status === 'acknowledged') return row
    const saved = this.deps.store.personal.save('attention', { ...row, status: 'acknowledged', updatedAt: iso(this.now()) }, row.revision)
    return saved
  }

  /** Creates deterministic, revision-bound delivery batches. P0 ignores quiet hours; P3 remains history only. */
  collectDue(options: { at?: Date; paused?: boolean } = {}): AttentionDelivery[] {
    const at = options.at ?? this.now(), settings = this.deps.store.personal.settings()
    if (options.paused || !settings.enabled) return []
    const quiet = this.isQuiet(at, settings)
    const due = this.listAll('queued').filter(item => item.priority !== 'P3' && this.isDeliverable(item, at, settings, quiet))
    const groups = new Map<string, Attention[]>()
    for (const item of due) {
      const key = `${item.priority}\0${item.digestKey}`
      groups.set(key, [...(groups.get(key) ?? []), item])
    }
    return [...groups.entries()].flatMap(([key, grouped]) => {
      const [priority, digestKey] = key.split('\0') as [Attention['priority'], string]
      const sorted = grouped.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      const batches: Attention[][] = []
      for (let i = 0; i < sorted.length; i += 20) batches.push(sorted.slice(i, i + 20))
      return batches.map(items => {
        const stableDeliveryId = deliveryId(items)
        return { deliveryId: stableDeliveryId, digestKey, priority, items,
          text: items.map(item => `${item.title}\n${item.summary}`).join('\n\n') }
      })
    })
  }

  /** Marks exactly the delivered snapshot. A merged/changed item invalidates its old delivery token. */
  markSent(delivery: Pick<AttentionDelivery, 'deliveryId' | 'items'>, sentAt = this.now()): Attention[] {
    const expectedId = deliveryId(delivery.items)
    if (delivery.deliveryId !== expectedId) throw new AttentionConflict('Invalid delivery snapshot')
    const timestamp = iso(sentAt), saved: Attention[] = []
    const work = () => {
      for (const snapshot of delivery.items) {
        const current = this.deps.store.personal.get('attention', snapshot.id)
        if (!current || current.status !== 'queued' || current.revision !== snapshot.revision) throw new AttentionConflict(`Stale delivery snapshot for ${snapshot.id}`)
      }
      for (const snapshot of delivery.items) {
        saved.push(this.deps.store.personal.save('attention', { ...snapshot, status: 'sent', sentAt: timestamp, updatedAt: timestamp }, snapshot.revision))
      }
    }
    if (this.deps.store.atomic) { this.deps.store.atomic(work); return saved }
    work(); return saved
  }

  /** Dispatches currently due snapshots. Only a sink's explicit sent receipt changes durable status. */
  async dispatch(sink: AttentionSink, options: { at?: Date; paused?: boolean } = {}): Promise<{ sent: string[]; pending: string[] }> {
    const sent: string[] = [], pending: string[] = []
    for (const delivery of this.collectDue(options)) {
      if (await sink(delivery) === 'sent') { this.markSent(delivery, options.at ?? this.now()); sent.push(delivery.deliveryId) }
      else pending.push(delivery.deliveryId)
    }
    return { sent, pending }
  }

  private isDeliverable(item: Attention, at: Date, settings: PersonalSettings, quiet: boolean): boolean {
    if (item.commitmentId) {
      const commitment = this.deps.store.personal.get('commitment', item.commitmentId)
      if (!commitment || ['fulfilled', 'cancelled'].includes(commitment.status)) return false
    } else if (item.ticketId && (!this.deps.store.tickets || !this.deps.store.tickets.get(item.ticketId) || this.deps.store.tickets.get(item.ticketId)?.ended)) return false
    const notBefore = item.notBefore ? new Date(item.notBefore) : undefined
    if (item.priority === 'P0') return true
    if (notBefore && notBefore > at) return false
    return !quiet
  }
  private localMinute(at: Date, timezone: string): number {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at)
    const part = (type: string) => parts.find(value => value.type === type)?.value ?? ''
    return Number(part('hour')) * 60 + Number(part('minute'))
  }
  private isQuiet(at: Date, settings: PersonalSettings): boolean {
    const minute = this.localMinute(at, settings.timezone)
    const [sh, sm] = settings.quietStart.split(':').map(Number), [eh, em] = settings.quietEnd.split(':').map(Number)
    const start = sh! * 60 + sm!, end = eh! * 60 + em!
    if (start === end) return false
    return start < end ? minute >= start && minute < end : minute >= start || minute < end
  }
}
