/** Append-only, indexed room history derived transactionally from durable domain records. */
import type { DatabaseSync } from 'node:sqlite'
import { key, threadKey, type Thread, type Ticket, type Trigger } from '../core/index.ts'
import type { OutboundMessage } from '../core/ports.ts'

export interface RoomEntry {
  id: string; thread: string; at: string
  kind: 'trigger' | 'report' | 'assignment' | 'reply' | 'note'
  ticketId?: string; triggerId?: string; receiptId?: string; text?: string; details?: string
  reportState?: string
}

/** Keeps report revisions and paged room events without growing the Thread aggregate. */
export class RoomJournal {
  constructor(private readonly db: DatabaseSync) {}
  setup(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS room_event (
      thread TEXT NOT NULL, id TEXT NOT NULL, at TEXT NOT NULL, value TEXT NOT NULL,
      PRIMARY KEY (thread, id));
      CREATE INDEX IF NOT EXISTS room_event_page ON room_event(thread, at DESC, id DESC);
      CREATE TABLE IF NOT EXISTS room_member (thread TEXT NOT NULL, ticket_id TEXT NOT NULL,
        PRIMARY KEY (thread, ticket_id));
      CREATE INDEX IF NOT EXISTS room_member_ticket ON room_member(ticket_id, thread);
      CREATE TABLE IF NOT EXISTS room_subscription (thread TEXT NOT NULL, ticket_id TEXT NOT NULL,
        PRIMARY KEY (thread, ticket_id));
      CREATE INDEX IF NOT EXISTS room_subscription_ticket ON room_subscription(ticket_id,thread);`)
  }
  private append(entry: RoomEntry): void {
    this.db.prepare('INSERT OR IGNORE INTO room_event(thread,id,at,value) VALUES (?,?,?,?)')
      .run(entry.thread, entry.id, entry.at, JSON.stringify(entry))
  }
  trigger(trigger: Trigger): void {
    for (const ref of trigger.threads) this.append({ id: `trigger:${trigger.id}`, thread: threadKey(ref), at: trigger.at,
      kind: 'trigger', triggerId: trigger.id })
  }
  /** Show one coordinated owner message in a selected member's room without changing delivery subscriptions. */
  link(trigger: Trigger, thread: string): void {
    this.append({ id: `trigger:${trigger.id}`, thread, at: trigger.at, kind: 'trigger', triggerId: trigger.id })
  }
  thread(thread: Thread): void {
    this.db.prepare('DELETE FROM room_subscription WHERE thread=?').run(thread.key)
    for (const id of thread.subscriptions) {
      this.db.prepare('INSERT INTO room_subscription(thread,ticket_id) VALUES (?,?)').run(thread.key, id)
      const added = this.db.prepare('INSERT OR IGNORE INTO room_member(thread,ticket_id) VALUES (?,?)').run(thread.key, id)
      if (Number(added.changes)) {
        const row = this.db.prepare('SELECT value FROM ticket WHERE id=?').get(id)
        if (row) this.ticket(JSON.parse(String(row.value)) as Ticket)
      }
    }
  }
  ticket(ticket: Ticket, previous?: Ticket): void {
    // Old/partial diagnostic records remain readable through their original tables.
    if (!ticket.channels || !ticket.origin || !ticket.assignments || !ticket.inputs) return
    const threads = new Set(ticket.channels.map(channel => channel.thread))
    const origins = new Set<string>()
    for (const id of ticket.origin.triggerIds) {
      const row = this.db.prepare('SELECT value FROM trigger WHERE id=?').get(id)
      if (row) for (const ref of (JSON.parse(String(row.value)) as Trigger).threads) { threads.add(threadKey(ref)); origins.add(threadKey(ref)) }
    }
    // Include subscriptions added after the original acceptance; retained membership provides historical visibility.
    for (const row of this.db.prepare('SELECT thread FROM room_subscription WHERE ticket_id=?').all(ticket.id)) threads.add(String(row.thread))
    const oldReports = new Set((previous?.assignments ?? []).flatMap(item => item.report ? [key(item.id, item.report.at, item.report.state, item.report.summary)] : []))
    const oldInputs = new Set((previous?.inputs ?? []).map(input => input.id))
    for (const thread of threads) {
      this.db.prepare('INSERT OR IGNORE INTO room_member(thread,ticket_id) VALUES (?,?)').run(thread, ticket.id)
      this.append({ id: `assignment:${ticket.id}`, thread, kind: 'assignment', at: ticket.createdAt,
        ticketId: ticket.id, text: ticket.title, details: ticket.mandate?.scope })
      for (const assignment of ticket.assignments) if (assignment.report) {
        const report = assignment.report
        if (oldReports.has(key(assignment.id, report.at, report.state, report.summary))) continue
        this.append({ id: `report:${key(ticket.id, assignment.id, report.at, report.state, report.summary)}`,
          thread, kind: 'report', at: report.at, ticketId: ticket.id, text: report.summary, reportState: report.state })
      }
      for (const input of ticket.inputs) if (input.kind === 'note' && !input.collaborationTriggerId && origins.has(thread) && !oldInputs.has(input.id)) {
        this.append({ id: `note:${ticket.id}:${input.id}`, thread, kind: 'note', at: input.at, ticketId: ticket.id, text: input.text })
      }
    }
  }
  reply(message: OutboundMessage, at = new Date().toISOString()): void {
    this.append({ id: `reply:${message.id}`, thread: message.channel.thread, kind: 'reply', at,
      receiptId: message.id, ...message.ticketId ? { ticketId: message.ticketId } : {} })
  }
  /** One-time backfill is transactionally marked by Store; unavailable old intermediate reports remain in session history. */
  backfill(): void {
    const marker = 'room-journal-v2-ready'
    if (this.db.prepare('SELECT 1 FROM kv WHERE key=?').get(marker)) return
    for (const row of this.db.prepare('SELECT value FROM trigger ORDER BY rowid').iterate()) this.trigger(JSON.parse(String(row.value)) as Trigger)
    for (const row of this.db.prepare('SELECT value FROM thread ORDER BY rowid').iterate()) this.thread(JSON.parse(String(row.value)) as Thread)
    for (const row of this.db.prepare('SELECT value FROM ticket ORDER BY rowid').iterate()) this.ticket(JSON.parse(String(row.value)) as Ticket)
    for (const row of this.db.prepare('SELECT value FROM outbox ORDER BY rowid').iterate()) {
      const message = JSON.parse(String(row.value)) as OutboundMessage
      const ticket = message.ticketId ? this.db.prepare('SELECT value FROM ticket WHERE id=?').get(message.ticketId) : undefined
      const at = ticket ? (JSON.parse(String(ticket.value)) as Ticket).updatedAt : '1970-01-01T00:00:00.000Z'
      this.reply(message, at)
    }
    this.db.prepare('INSERT INTO kv(key,value) VALUES (?,?)').run(marker, 'true')
  }
  page(thread: string, limit: number, before?: { at: string; id: string }): RoomEntry[] {
    const condition = before ? ' AND (at,id) < (?,?)' : ''
    return this.db.prepare(`SELECT value FROM room_event WHERE thread=?${condition} ORDER BY at DESC,id DESC LIMIT ?`)
      .all(thread, ...before ? [before.at, before.id] : [], limit).map(row => JSON.parse(String(row.value)) as RoomEntry)
  }
  members(thread: string): string[] {
    return this.db.prepare('SELECT ticket_id FROM room_member WHERE thread=? ORDER BY rowid').all(thread).map(row => String(row.ticket_id))
  }
}
