/** Durable, jittered reminders for concise owner-visible Worker progress reports. */
import { key, latestAssignment, latestReport, liveTicket, runningAssignment, type Ticket } from '../core/index.ts'
import { record } from '../kv.ts'
import type { Store } from './store.ts'

const PREFIX = 'worker-progress:'
const MIN_INTERVAL = 5 * 60_000, MAX_INTERVAL = 15 * 60_000
interface ProgressClock {
  anchor: string
  dueAt: number
  sequence: number
  previousRequestId?: string
}
const clockKey = (id: string) => record<ProgressClock>(`${PREFIX}${id}`)

/** Actual report revisions reset the clock; restart metadata and unrelated ticket updates do not. */
export function progressAnchor(ticket: Ticket): string {
  const report = latestReport(ticket)
  return report ? key(report.at, report.state, report.summary) : key(ticket.id, ticket.createdAt)
}

/** An automatic status reminder leaves completed work and requests for a person undisturbed. */
export function progressEligible(ticket: Ticket): boolean {
  const assignment = runningAssignment(ticket), report = assignment?.report
  return liveTicket(ticket) && !!assignment && !ticket.attention && !ticket.delivery
    && report?.waitingFor?.kind !== 'human'
    && !['ready', 'blocked', 'failed', 'dropped'].includes(report?.state ?? '')
}

export interface ProgressReminder {
  ticketId: string
  assignmentId: string
  anchor: string
  requestId: string
  previousRequestId?: string
}
interface ProgressHost {
  store: Pick<Store, 'tickets' | 'get' | 'set' | 'delete' | 'keys'>
  paused(): boolean
  closing(): boolean
  /** True once accepted; false when a prior reminder is still unread or delivery is held. */
  remind(reminder: ProgressReminder): Promise<boolean>
  cancel?(ticketId: string, requestIds: string[]): void
  onError?(error: unknown): void
}

/** Checked by Runtime's existing pass; deadlines and delivery identities survive host restarts. */
export class WorkerProgress {
  private readonly sending = new Map<string, Promise<void>>()
  constructor(private readonly host: ProgressHost, private readonly now = () => Date.now(), private readonly random = Math.random) {}
  private interval(): number {
    return MIN_INTERVAL + Math.floor(Math.max(0, Math.min(1, this.random())) * (MAX_INTERVAL - MIN_INTERVAL))
  }
  private cancel(ticketId: string, clock: ProgressClock | undefined): void {
    if (clock) this.host.cancel?.(ticketId, [...new Set([`progress:${ticketId}:${clock.anchor}:${clock.sequence}`,
      ...clock.previousRequestId ? [clock.previousRequestId] : []])])
  }
  tick(): void {
    if (this.host.closing() || this.host.paused()) return
    const { store } = this.host, tickets = store.tickets.open(), open = new Set(tickets.map(ticket => ticket.id))
    for (const name of store.keys(PREFIX)) if (!open.has(name.slice(PREFIX.length))) {
      this.cancel(name.slice(PREFIX.length), store.get(record<ProgressClock>(name))); store.delete(name)
    }
    for (const ticket of tickets) {
      if (!progressEligible(ticket)) {
        // Restart recovery briefly returns an interrupted assignment to the launch queue. Keep its clock.
        if (latestAssignment(ticket)?.state !== 'pending' || ticket.attention || ticket.delivery) {
          this.cancel(ticket.id, store.get(clockKey(ticket.id))); store.delete(clockKey(ticket.id))
        }
        continue
      }
      const anchor = progressAnchor(ticket), previous = store.get(clockKey(ticket.id))
      let clock = previous
      if (!clock || clock.anchor !== anchor) {
        this.cancel(ticket.id, clock)
        const report = latestReport(ticket), assignment = runningAssignment(ticket)!
        const at = Date.parse(report?.at ?? assignment.startedAt ?? ticket.createdAt)
        clock = { anchor, dueAt: (Number.isFinite(at) ? Math.min(at, this.now()) : this.now()) + this.interval(), sequence: 0 }
        store.set(clockKey(ticket.id), clock)
      }
      if (clock.dueAt > this.now() || this.sending.has(ticket.id)) continue
      const reminder: ProgressReminder = { ticketId: ticket.id, assignmentId: runningAssignment(ticket)!.id, anchor,
        requestId: `progress:${ticket.id}:${anchor}:${clock.sequence}`, ...clock.previousRequestId ? { previousRequestId: clock.previousRequestId } : {} }
      const expected = clock
      const work = Promise.resolve().then(() => this.host.remind(reminder)).then(accepted => {
        if (!accepted || this.host.closing()) return
        const currentTicket = store.tickets.get(ticket.id), current = store.get(clockKey(ticket.id))
        // A stage report may arrive while Session persistence is flushing. Preserve its newer clock.
        if (!currentTicket || !progressEligible(currentTicket) || progressAnchor(currentTicket) !== anchor
          || current?.anchor !== anchor || current.sequence !== expected.sequence) return
        store.set(clockKey(ticket.id), { anchor, dueAt: this.now() + this.interval(), sequence: expected.sequence + 1,
          previousRequestId: reminder.requestId })
      }).catch(error => { this.host.onError?.(error) }).finally(() => { this.sending.delete(ticket.id) })
      this.sending.set(ticket.id, work)
    }
  }
  /** Runtime waits for outstanding deliveries before closing Store. */
  async drain(): Promise<void> { await Promise.allSettled(this.sending.values()) }
}
