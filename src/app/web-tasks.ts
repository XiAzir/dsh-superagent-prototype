/** Durable conversations submitted by the local Web UI and delivered through the regular event pipeline. */
import { z } from 'zod'
import { key, latestReport, reasonText, ticketStage, type ReceiveResult, type Trigger } from '../core/index.ts'
import { record } from '../kv.ts'
import type { Health } from '../sources/host.ts'
import type { SourceKind } from '../sources/kind.ts'
import { SourcePolicySchema } from '../policy.ts'
import type { Store } from './store.ts'
import type { ArtifactRegistry, TaskArtifact } from './artifacts.ts'

export interface WebMessageArtifact { id: string; ticketId: string; name: string; size: number; kind: TaskArtifact['kind'] }
export interface WebMessage { id: string; role: 'user' | 'assistant'; text: string; at: string; artifacts?: WebMessageArtifact[] }
export interface WebTaskSummary {
  id: string; title: string; createdAt: string; updatedAt: string
  status: 'queued' | 'working' | 'person' | 'done' | 'idle' | 'paused'
  tickets: { id: string; title: string; stage: string; summary: string }[]
}
export interface WebTaskView extends WebTaskSummary { messages: WebMessage[]; error?: string }
interface WebTaskRecord { id: string; title: string; createdAt: string; updatedAt: string; messages: WebMessage[] }
interface WebTaskHost {
  store: Store
  mode(): string
  configured(): boolean
  health(): Readonly<Record<string, Health>>
  failure?(ticketIds: string[]): { message: string; at: string } | undefined
  artifacts?: Pick<ArtifactRegistry, 'verify'>
  receive(trigger: Trigger): ReceiveResult
  requestPass(): void
}
const PREFIX = 'web-task:'
const taskKey = (id: string) => record<WebTaskRecord>(`${PREFIX}${id}`)
export const WebMessageRequest = z.object({
  text: z.string().trim().min(1).max(16000),
  requestId: z.string().regex(/^[A-Za-z0-9_-]{8,80}$/),
}).strict()
/** A user-facing Web task refusal with the HTTP status its route should return. */
export class WebTaskError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 503, message: string) { super(message) }
}

/** Every caller supplies the server-side owner identity; request bodies supply only text and an idempotency key. */
export class WebTasks {
  constructor(private readonly host: WebTaskHost) {}
  private requireMode(): void {
    if (this.host.mode() !== 'personal') throw new WebTaskError(400, '请先在设置 → 部署中切换到个人模式。')
  }
  private requireWritable(): void {
    this.requireMode()
    if (!this.host.configured()) throw new WebTaskError(503, '个人助理仍在初始化，请查看概览中的运行状态。')
    const settings = this.host.store.settings()
    if (settings.sources.web?.enabled === false) throw new WebTaskError(409, 'Web 任务来源已关闭，请在设置 → 来源中启用。')
    if (!settings.policy.sources.web?.allowed.some(actor => actor.id === 'owner')) {
      throw new WebTaskError(409, 'Web 任务的个人账号授权已关闭，请在设置 → 评估中恢复 owner 授权。')
    }
  }
  private record(id: string): WebTaskRecord {
    const task = this.host.store.get(taskKey(id))
    if (!task) throw new WebTaskError(404, '任务对话不存在。')
    return task
  }
  list(offset = 0, limit = 50): { items: WebTaskSummary[]; next_offset: number | null } {
    this.requireMode()
    const rows = this.host.store.webTasks.page(offset, limit + 1)
    const page = rows.slice(0, limit)
    const items = page.map(row => {
      const { messages: _messages, error: _error, ...summary } = this.view({ ...row, messages: [] }, row.lastUserAt)
      return summary
    })
    return { items, next_offset: rows.length > limit ? offset + limit : null }
  }
  get(id: string): WebTaskView { this.requireMode(); return this.view(this.record(id)) }
  /** Returns a verified snapshot only when an assistant message in this conversation has already delivered it. */
  async artifact(conversation: string, id: string): Promise<TaskArtifact> {
    this.requireWritable()
    const task = this.record(conversation)
    const delivered = task.messages.filter(message => message.role === 'assistant').flatMap(message => message.artifacts ?? []).find(item => item.id === id)
    if (!delivered || !this.host.artifacts) throw new WebTaskError(404, '交付文件不存在。')
    const artifact = await this.host.artifacts.verify(id, delivered.ticketId)
    if (artifact.name !== delivered.name || artifact.size !== delivered.size || artifact.kind !== delivered.kind) {
      throw new WebTaskError(404, '交付文件不存在。')
    }
    return artifact
  }
  create(input: unknown): WebTaskView {
    this.requireWritable()
    const { text, requestId } = WebMessageRequest.parse(input)
    const id = key('web-task', requestId)
    const existing = this.host.store.get(taskKey(id))
    if (existing) {
      if (existing.messages[0]?.text !== text) throw new WebTaskError(409, '这次发送的编号已经用于另一段内容，请重新发送。')
      return this.view(existing)
    }
    const at = new Date().toISOString()
    const task: WebTaskRecord = { id, title: text.split('\n')[0]!.slice(0, 100), createdAt: at, updatedAt: at, messages: [] }
    this.append(task, text, requestId)
    return this.get(id)
  }
  followup(id: string, input: unknown): WebTaskView {
    this.requireWritable()
    const task = this.record(id)
    const { text, requestId } = WebMessageRequest.parse(input)
    this.append(task, text, requestId)
    return this.get(id)
  }
  private append(task: WebTaskRecord, text: string, requestId: string): void {
    const id = `web-message-${key(task.id, requestId)}`
    const previous = task.messages.find(message => message.id === id)
    if (previous) {
      if (previous.text !== text) throw new WebTaskError(409, '这次发送的编号已经用于另一段内容，请重新发送。')
      return
    }
    const at = new Date().toISOString()
    const trigger: Trigger = { id, source: 'web', routing: 'router', threads: [{ source: 'web', id: task.id }],
      actor: { source: 'web', id: 'owner' }, human: true, addressed: 'direct', text, at,
      channel: { source: 'web', thread: `web:${task.id}`, address: { conversation: task.id } }, meta: { conversation: task.id } }
    this.host.store.atomic(() => {
      task.messages.push({ id, role: 'user', text, at }); task.updatedAt = task.updatedAt < at ? at : task.updatedAt
      this.host.store.set(taskKey(task.id), task)
      this.host.store.webTasks.save({ id: task.id, title: task.title, createdAt: task.createdAt, updatedAt: task.updatedAt, lastUserAt: at })
      const result = this.host.receive(trigger)
      if (result === 'filtered') throw new WebTaskError(409, 'Web 任务来源已暂停接收，请检查来源设置。')
      this.host.store.threads.describe(`web:${task.id}`, { label: task.title })
    })
    this.host.requestPass()
  }
  private view(task: WebTaskRecord, indexedLastUserAt?: string): WebTaskView {
    const store = this.host.store, thread = store.threads.get(`web:${task.id}`)
    const tickets = [...new Set(thread?.subscriptions ?? [])].flatMap(id => {
      const ticket = store.tickets.get(id)
      return ticket ? [{ ...ticket, derived: ticketStage(ticket) }] : []
    })
    const latestDecision = store.decisions.byThread(`web:${task.id}`).at(-1)
    const pending = !!thread?.pending.length || !!thread?.evaluating
    const working = tickets.some(ticket => ticket.derived.stage === 'working' && ticket.derived.action !== 'queued')
    const queued = pending || tickets.some(ticket => ticket.derived.stage === 'working')
    const open = tickets.some(ticket => !ticket.ended)
    let status: WebTaskSummary['status'] = store.settings().paused && (queued || open) ? 'paused'
      : working ? 'working' : queued ? 'queued' : tickets.some(ticket => ticket.derived.stage === 'person') ? 'person'
        : tickets.length && !open ? 'done' : tickets.length ? 'idle' : latestDecision ? 'idle' : 'queued'
    const updatedAt = [task.updatedAt, ...tickets.map(ticket => ticket.updatedAt), latestDecision?.at ?? ''].sort().at(-1)!
    const userAt = indexedLastUserAt ?? task.messages.findLast(message => message.role === 'user')?.at ?? task.createdAt
    const failure = this.host.failure?.(tickets.map(ticket => ticket.id))
    const error = this.host.health().runtime?.state === 'error' ? this.host.health().runtime?.detail
      : failure && failure.at >= userAt && status !== 'done' ? failure.message
        : !pending && latestDecision?.kind === 'unavailable' && latestDecision.at >= userAt ? reasonText(latestDecision.reason) : undefined
    if (error && status !== 'done' && status !== 'paused') status = 'person'
    return { id: task.id, title: task.title, createdAt: task.createdAt, updatedAt, status, messages: task.messages,
      tickets: tickets.map(ticket => ({ id: ticket.id, title: ticket.title, stage: ticket.derived.stage, summary: latestReport(ticket)?.summary ?? '' })),
      ...error ? { error } : {} }
  }
}

/** Channel delivery is persisted atomically and idempotently before the outbox marks the reply sent. */
export function webSource(store: Store, personal: () => boolean, artifacts?: Pick<ArtifactRegistry, 'verify'>): SourceKind<Record<string, never>> {
  const authorized = (): boolean => {
    const settings = store.settings()
    return personal() && settings.sources.web?.enabled !== false && !!settings.policy.sources.web?.allowed.some(actor => actor.id === 'owner')
  }
  return {
    kind: 'web', title: { zh: 'Web 任务', en: 'Web tasks' },
    description: { zh: '从本机 Web 面板交办任务，并在原对话查看回复与结果。', en: 'Submit tasks and read replies in the local Web panel.' },
    schema: z.object({}).strict(), fields: [], health: [],
    scope: () => personal() ? { listened: true, observed: false } : { listened: false, reason: 'source_disabled' },
    policy: { schema: SourcePolicySchema, fields: [{ key: 'allowed', type: 'rows', label: { zh: '允许交办的个人账号', en: 'Allowed owners' },
      columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' } }, { key: 'name', type: 'text', optional: true, label: { zh: '名称', en: 'Name' } }] }],
    explicit: { zh: '在 Web 任务中发送的消息视为直接交办，账号固定为 owner。', en: 'Web messages are direct requests from the local owner account.' } },
    threadContext: {
      messageId: trigger => trigger.id,
      read: async (_commands, trigger, part, cursor) => {
        const task = store.get(taskKey(String(trigger.meta.conversation)))
        const all = task?.messages ?? []
        const start = part === 'root' ? 0 : Math.max(0, Number(cursor) || 0)
        const size = part === 'root' ? 1 : 30
        const messages = all.slice(start, start + size).map(message => ({ id: message.id, from: message.role === 'user' ? 'owner' : 'agent',
          at: message.at, text: message.text, ...message.role === 'assistant' ? { bot: true as const } : {} }))
        return { messages, body: { messages }, ...part === 'thread' && start + size < all.length ? { next: String(start + size) } : {} }
      },
    },
    channel: {
      artifacts: true,
      allowed: address => authorized() && (address.room ? !!store.threads.get(address.room) : !!store.get(taskKey(address.conversation ?? ''))),
      link: () => ({ url: '', label: { zh: 'Web 任务', en: 'Web task' } }),
      send: async (_host, message) => {
        if (!authorized()) return 'gone'
        // The durable outbox/room journal is the delivery surface for owner messages on non-Web task rooms too.
        if (message.channel.address.room) {
          if (!store.threads.get(message.channel.address.room)) return 'gone'
          for (const id of [...new Set(message.artifacts ?? [])]) {
            if (!message.ticketId || !artifacts) throw new Error('Room artifact delivery requires its originating ticket and registry')
            await artifacts.verify(id, message.ticketId)
          }
          return authorized() && store.threads.get(message.channel.address.room) ? 'sent' : 'gone'
        }
        const taskId = message.channel.address.conversation ?? ''
        const task = store.get(taskKey(taskId))
        if (!task) return 'gone'
        const artifactIds = [...new Set(message.artifacts ?? [])]
        const sameDeliveredArtifacts = (existing: WebMessage | undefined): boolean => {
          const delivered = existing?.artifacts ?? []
          return JSON.stringify(delivered.map(item => item.id)) === JSON.stringify(artifactIds)
            && delivered.every(item => item.ticketId === message.ticketId)
        }
        const previous = task.messages.find(item => item.id === message.id)
        if (previous) {
          if (previous.role !== 'assistant' || previous.text !== message.text || !sameDeliveredArtifacts(previous)) throw new Error('Web message ID was reused for different content')
          return 'sent'
        }
        let descriptors: WebMessageArtifact[] | undefined
        if (artifactIds.length) {
          if (!message.ticketId || !artifacts) throw new Error('Web artifact delivery requires its originating ticket and durable artifact registry')
          descriptors = await Promise.all(artifactIds.map(async id => {
            const artifact = await artifacts.verify(id, message.ticketId)
            return { id: artifact.id, ticketId: artifact.ticketId, name: artifact.name, size: artifact.size, kind: artifact.kind }
          }))
          if (!authorized()) return 'gone'
        }
        return store.atomic(() => {
          if (!authorized()) return 'gone'
          const current = store.get(taskKey(taskId))
          if (!current) return 'gone'
          const raced = current.messages.find(item => item.id === message.id)
          if (raced) {
            if (raced.role !== 'assistant' || raced.text !== message.text || !sameDeliveredArtifacts(raced)) throw new Error('Web message ID was reused for different content')
            return 'sent'
          }
          const at = new Date().toISOString()
          current.messages.push({ id: message.id, role: 'assistant', text: message.text, at, ...descriptors?.length ? { artifacts: descriptors } : {} })
          current.updatedAt = current.updatedAt < at ? at : current.updatedAt
          store.set(taskKey(current.id), current)
          store.webTasks.save({ id: current.id, title: current.title, createdAt: current.createdAt, updatedAt: current.updatedAt,
            lastUserAt: [...current.messages].reverse().find(item => item.role === 'user')?.at ?? current.createdAt })
          return 'sent'
        })
      },
    },
  }
}
