/** Task-room projections: owner-visible collaboration history, targeted input, and on-demand execution details. */
import { z } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { key, latestReport, liveTicket, ticketStage, type Engine, type Thread, type Ticket, type Trigger } from '../core/index.ts'
import { workerSessionId } from '../executor/dsh.ts'
import { threadTitle } from './views/records.ts'
import { transcriptEntry } from './context.ts'
import { WebTaskError } from './web-tasks.ts'
import type { RoomEntry } from './room-journal.ts'
import type { Store } from './store.ts'
import type { ArtifactRegistry, TaskArtifact } from './artifacts.ts'
import { record } from '../kv.ts'
export interface RoomWorker {
  id: string; title: string; stage: string; summary: string; sessionId: string
  active: boolean; subscribed: boolean
}
export interface TaskRoomSummary {
  key: string; title: string; source: string; updatedAt: string; workers: RoomWorker[]; pending: boolean
}
export interface RoomMessage {
  id: string; at: string; kind: 'user' | 'router' | 'collaboration' | 'report' | 'assignment' | 'system'
  actor: { role: 'user' | 'router' | 'worker' | 'system'; name: string; ticketId?: string }
  text: string; audience: 'router' | 'worker' | 'thread' | 'record'; recipient?: string
  ticketId?: string; details?: string
  artifacts?: { id: string; name: string; size: number }[]
  delivery?: 'queued' | 'delivered' | 'read' | 'held' | 'failed'
}
export interface TaskRoomView extends TaskRoomSummary {
  messages: RoomMessage[]; earlier: string | null; writable: boolean; paused: boolean
}
export interface RoomActivity {
  items: { id: string; type: string; text: string }[]; next_offset: number | null
}

export const RoomMessageRequest = z.object({ text: z.string().trim().min(1).max(16000),
  requestId: z.string().regex(/^[A-Za-z0-9_-]{8,80}$/), recipient: z.string().min(1).max(200).optional() }).strict()
interface RoomHost {
  store: Store; engine: Pick<Engine, 'receive' | 'direct'>
  personal(): boolean; configured(): boolean; requestPass(): void
  artifacts?: Pick<ArtifactRegistry, 'verify'> | undefined
  inspectWorker?(ticketId: string): Promise<readonly SessionEvent[]>
}
const Cursor = z.object({ at: z.string().datetime(), id: z.string().min(1).max(512) }).strict()
const cursorOf = (entry: RoomEntry): string => Buffer.from(JSON.stringify({ at: entry.at, id: entry.id })).toString('base64url')
const parseCursor = (value?: string) => {
  if (value === undefined) return undefined
  try { if (value.length > 2048) throw new Error(); return Cursor.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))) }
  catch { throw new WebTaskError(400, '消息分页位置无效，请刷新任务群。') }
}
/** Redacts common credential forms before owner-visible execution excerpts leave the host. */
const safeText = (text: string): string => text
  .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[redacted]')
  .replace(/\b(?:gh[pousr]_|github_pat_|xox[baprs]-|sk-)[A-Za-z0-9_-]{12,}\b/g, '[redacted]')
  .replace(/(["']?(?:access[_-]?token|refresh[_-]?token|token|secret|password|passwd|authorization|api[_-]?key)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}\]]+)/gi, '$1"[redacted]"')
  .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[private key redacted]')
const bounded = (text: string, max = 12000): string => {
  const clean = safeText(text)
  return clean.length > max ? `${clean.slice(0, max)}\n[内容已截断；完整记录可在 Worker 会话中查看]` : clean
}

/** Reads task-room history and sends owner input through explicit Router or Worker delivery paths. */
export class TaskRooms {
  constructor(private readonly host: RoomHost) {}
  private thread(key: string): Thread {
    const thread = this.host.store.threads.get(key)
    if (!thread) throw new WebTaskError(404, '任务群不存在。')
    return thread
  }
  private writable(): boolean {
    const settings = this.host.store.settings()
    return this.host.personal() && this.host.configured() && settings.sources.web?.enabled !== false
      && !!settings.policy.sources.web?.allowed.some(actor => actor.id === 'owner')
  }
  private tickets(thread: Thread): Ticket[] {
    return [...new Set([...this.host.store.rooms.members(thread.key), ...thread.subscriptions])]
      .flatMap(id => this.host.store.tickets.get(id) ?? [])
  }
  private summary(thread: Thread, tickets = this.tickets(thread)): TaskRoomSummary {
    const workers = tickets.map(ticket => ({ id: ticket.id, title: ticket.title, stage: ticketStage(ticket).stage,
      summary: bounded(latestReport(ticket)?.summary ?? '', 600), sessionId: ticket.assignments.some(item => item.startedAt) ? workerSessionId(ticket.id) : '',
      active: liveTicket(ticket), subscribed: thread.subscriptions.includes(ticket.id) }))
    const last = this.host.store.rooms.page(thread.key, 1)[0]?.at ?? ''
    return { key: thread.key, title: threadTitle(this.host.store, thread), source: thread.ref.source,
      updatedAt: [thread.lastAt ?? thread.createdAt, last, ...tickets.map(ticket => ticket.updatedAt)].sort().at(-1)!,
      workers, pending: !!thread.pending.length || !!thread.evaluating }
  }
  list(offset = 0, limit = 50): { items: TaskRoomSummary[]; next_offset: number | null } {
    const rows = this.host.store.db.prepare(`SELECT t.value FROM thread t JOIN room_event e ON e.thread=t.key
      WHERE EXISTS (SELECT 1 FROM room_member m WHERE m.thread=t.key) OR t.value ->> '$.ref.source'='web'
      GROUP BY t.key ORDER BY MAX(e.at) DESC,t.key ASC LIMIT ? OFFSET ?`).all(Math.min(100, limit) + 1, Math.max(0, offset))
    return { items: rows.slice(0, limit).map(row => this.summary(JSON.parse(String(row.value)) as Thread)),
      next_offset: rows.length > limit ? offset + limit : null }
  }
  get(key: string, before?: string, limit = 50): TaskRoomView {
    const thread = this.thread(key), tickets = this.tickets(thread), size = Math.max(1, Math.min(100, limit))
    const rows = this.host.store.rooms.page(key, size + 1, parseCursor(before)), shown = rows.slice(0, size)
    return { ...this.summary(thread, tickets), messages: shown.reverse().flatMap(row => this.message(row, tickets) ?? []),
      earlier: rows.length > size && shown[0] ? cursorOf(shown[0]) : null,
      writable: this.writable(), paused: this.host.store.settings().paused }
  }
  private message(entry: RoomEntry, tickets: Ticket[]): RoomMessage | undefined {
    const store = this.host.store, ticket = tickets.find(ticket => ticket.id === entry.ticketId)
    const base = { id: entry.id, at: entry.at, ...entry.ticketId ? { ticketId: entry.ticketId } : {} }
    if (entry.kind === 'trigger') {
      const trigger = entry.triggerId && store.triggers.get(entry.triggerId)
      if (!trigger) return undefined
      const disposition = store.triggers.disposition(trigger.id), collaboration = trigger.collaboration
      const sender = collaboration && store.tickets.get(collaboration.ticketId)
      const target = disposition?.directTicketId
      const owners = disposition?.fanout ?? []
      const delivered = owners.flatMap(id => {
        const ticket = store.tickets.get(id)
        const input = ticket?.inputs.find(input => input.kind === 'trigger' ? input.triggerId === trigger.id
          : input.kind === 'note' && input.collaborationTriggerId === trigger.id)
        if (!input || !ticket) return []
        if (ticket.delivery) return ['failed' as const]
        if (input.kind === 'trigger' && input.readAt) return ['read' as const]
        if (input.kind === 'trigger' && input.deliveredTo) return ['delivered' as const]
        // Context notes do not carry per-message read receipts; report only a queue state we can verify.
        return ticket.undelivered.includes(input.id) ? ['queued' as const] : []
      })
      const delivery = delivered.includes('failed') ? 'failed' : delivered.includes('queued') ? 'queued'
        : delivered.length && delivered.every(value => value === 'read') ? 'read'
          : delivered.length ? 'delivered' : undefined
      return { ...base, kind: collaboration ? 'collaboration' : trigger.human ? 'user' : 'system',
        actor: collaboration ? { role: 'worker', name: sender?.title ?? collaboration.ticketId, ticketId: collaboration.ticketId }
          : { role: trigger.human ? 'user' : 'system', name: trigger.actor.source === 'web' && trigger.actor.id === 'owner' ? '我' : trigger.actor.id },
        text: bounded(trigger.text, 16000), audience: collaboration ? 'thread' : target ? 'worker' : trigger.routing === 'router' ? 'router' : 'thread',
        ...target ? { recipient: target } : {}, ...delivery ? { delivery } : {} }
    }
    if (entry.kind === 'reply') {
      const receipt = entry.receiptId && store.receipts.get(entry.receiptId)
      if (!receipt) return undefined
      return { ...base, kind: 'router', actor: { role: 'router', name: 'Router' }, text: bounded(receipt.text, 20000), audience: 'record',
        ...receipt.status === 'sent' && receipt.artifacts?.length ? { artifacts: receipt.artifacts.flatMap(id => {
          const artifact = store.get(record<TaskArtifact>(`task-artifact:${id}`))
          return artifact && artifact.ticketId === receipt.ticketId
            ? [{ id: artifact.id, name: artifact.name, size: artifact.size }] : []
        }) } : {},
        delivery: receipt.status === 'pending' ? 'queued' : receipt.status === 'dropped' ? 'failed' : 'delivered' }
    }
    const worker = { role: 'worker' as const, name: ticket?.title ?? entry.ticketId ?? 'Worker', ticketId: entry.ticketId }
    return { ...base, kind: entry.kind === 'note' ? 'router' : entry.kind,
      actor: entry.kind === 'assignment' || entry.kind === 'note' ? { role: 'router', name: 'Router' } : worker,
      text: bounded(entry.text ?? ''), audience: entry.kind === 'assignment' || entry.kind === 'note' ? 'worker'
        : entry.reportState === 'progress' || entry.reportState === 'waiting' ? 'record' : 'router',
      ...entry.kind === 'assignment' || entry.kind === 'note' ? { recipient: entry.ticketId } : {},
      ...entry.details ? { details: bounded(entry.details) } : {} }
  }
  post(keyValue: string, input: unknown): TaskRoomView {
    if (!this.writable()) throw new WebTaskError(409, '任务群当前仅供查看，请检查个人模式、Web 来源与 owner 授权。')
    const thread = this.thread(keyValue), { text, requestId, recipient = 'router' } = RoomMessageRequest.parse(input)
    const id = `room-message-${key(keyValue, requestId)}`, store = this.host.store
    const previous = store.triggers.get(id)
    if (previous) {
      if (previous.text !== text || previous.meta.roomRecipient !== recipient) throw new WebTaskError(409, '发送编号已经用于另一条消息，请重新发送。')
      return this.get(keyValue)
    }
    if (store.settings().paused) throw new WebTaskError(409, '任务处理已暂停，请恢复后再发送。')
    if (recipient !== 'router') {
      const target = store.tickets.get(recipient)
      if (!target || !liveTicket(target) || !thread.subscriptions.includes(recipient)) throw new WebTaskError(409, '该 Worker 已离开或结束工作，请选择 Router 重新安排。')
    }
    const trigger: Trigger = { id, source: 'web', routing: 'router', threads: [thread.ref], actor: { source: 'web', id: 'owner' },
      human: true, addressed: 'direct', at: new Date().toISOString(), text,
      channel: { source: 'web', thread: keyValue, address: { room: keyValue } }, meta: { room: keyValue, roomRecipient: recipient } }
    store.atomic(() => {
      if (recipient === 'router') {
        if (this.host.engine.receive(trigger) === 'filtered') throw new WebTaskError(409, '任务群来源已暂停接收，请检查来源设置。')
      } else this.host.engine.direct(recipient, trigger)
    })
    this.host.requestPass()
    return this.get(keyValue)
  }
  async activity(key: string, ticketId: string, offset = 0, limit = 30): Promise<RoomActivity> {
    const thread = this.thread(key)
    if (!this.tickets(thread).some(ticket => ticket.id === ticketId)) throw new WebTaskError(404, '该任务群没有这位 Worker。')
    if (!this.host.inspectWorker) throw new WebTaskError(503, '执行记录暂时不可用，请稍后重试。')
    const events = await this.host.inspectWorker(ticketId), items: RoomActivity['items'] = []
    for (const [index, event] of events.entries()) {
      const entry = transcriptEntry(event)
      if (!entry) continue
      const text = entry.message.content.map(block => {
        if (block.type === 'text') return block.text
        if (block.type === 'tool-call') return JSON.stringify(block)
        return `[${block.type}]`
      }).join('\n')
      if (text) items.push({ id: `${ticketId}:${index}`, type: entry.type, text: bounded(text) })
    }
    const start = Math.max(0, offset), size = Math.max(1, Math.min(50, limit))
    return { items: items.slice(start, start + size), next_offset: start + size < items.length ? start + size : null }
  }
  /** Downloads require a sent receipt in this room, its owning ticket, and a fresh immutable-spool verification. */
  async artifact(room: string, id: string): Promise<TaskArtifact> {
    if (!this.writable()) throw new WebTaskError(409, '请恢复个人模式的 Web 来源与 owner 授权后下载。')
    const thread = this.thread(room)
    const row = this.host.store.db.prepare(`SELECT o.value ->> '$.ticketId' AS ticket_id FROM outbox o
      WHERE o.value ->> '$.status'='sent' AND o.value ->> '$.channel.thread'=?
        AND EXISTS (SELECT 1 FROM json_each(o.value,'$.artifacts') a WHERE a.value=?) LIMIT 1`).get(room, id)
    const ticketId = row && String(row.ticket_id)
    const descriptor = this.host.store.get(record<TaskArtifact>(`task-artifact:${id}`))
    if (!ticketId || descriptor?.ticketId !== ticketId || !this.tickets(thread).some(ticket => ticket.id === ticketId) || !this.host.artifacts) {
      throw new WebTaskError(404, '该任务群尚未交付这个文件。')
    }
    const artifact = await this.host.artifacts.verify(id, ticketId)
    if (!this.writable()) throw new WebTaskError(409, '下载权限已更新，请刷新后重试。')
    return artifact
  }
}
