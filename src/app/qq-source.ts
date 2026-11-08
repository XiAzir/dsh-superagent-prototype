/** OneBot v11 QQ source: admission, persistent thread routing and replies to the original QQ chat. */
import { z } from 'zod'
import { readFile } from 'node:fs/promises'
import { key, type OutboundMessage, type ReceiveResult, type Trigger } from '../core/index.ts'
import { record } from '../kv.ts'
import { SourcePolicySchema } from '../policy.ts'
import type { Health } from '../sources/host.ts'
import type { FieldSpec, SourceKind } from '../sources/kind.ts'
import { OneBotClient, OneBotRpcError, type OneBotState } from '../sources/onebot-client.ts'
import { normalizeOneBotMessage } from '../sources/onebot-message.ts'
import { QqThreads } from './qq-threads.ts'
import { safeFailureMessage } from './session-failures.ts'
import { QqAttachmentStore } from './qq-attachment-store.ts'
import { readQqMedia } from '../sources/qq-media.ts'
import type { ArtifactRegistry } from './artifacts.ts'
import type { Store } from './store.ts'
import { QqObservationBudget } from './qq-observation.ts'

const qqId = z.string().trim().regex(/^[1-9]\d{3,19}$/, '有效的 QQ 号或群号')
const websocketUrl = z.string().trim().refine(value => {
  try { const url = new URL(value); return ['ws:', 'wss:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash }
  catch { return false }
}, '使用 ws:// 或 wss:// 地址，Access Token 通过独立入口保存')
export const QqConfigSchema = z.object({
  connection: z.enum(['forward', 'reverse']).default('forward'), url: websocketUrl.default('ws://127.0.0.1:3001'),
  host: z.enum(['127.0.0.1', 'localhost', '::1']).default('127.0.0.1'), port: z.number().int().min(1024).max(65535).default(6199),
  path: z.string().regex(/^\/[A-Za-z0-9/_-]*$/).max(160).default('/onebot/v11/ws'),
  tokenRef: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).default('DSH_SUPERAGENT_QQ_TOKEN'),
  privateMessages: z.boolean().default(false),
  groups: z.array(z.object({ id: qqId, name: z.string().trim().max(100).optional(), listen: z.enum(['requests', 'observe']).default('requests') }).strict()).max(100)
    .refine(groups => new Set(groups.map(group => group.id)).size === groups.length, '群号重复').default([]),
  commandPrefix: z.string().trim().min(1).max(30).default('/agent'),
  sessionMinutes: z.number().int().min(1).max(1440).default(30), groupFollowups: z.enum(['reply', 'sender-window']).default('reply'),
  privateFollowups: z.enum(['semantic', 'sender-window']).default('semantic'),
  replyChunkSize: z.number().int().min(200).max(4000).default(1800), maxReplyChunks: z.number().int().min(1).max(50).default(20),
  requestTimeoutMs: z.number().int().min(1000).max(60000).default(15000),
  fileUploadTimeoutMs: z.number().int().min(1000).max(600000).default(120000),
  observation: z.object({
    windowMinutes: z.number().int().min(1).max(30).default(5),
    maxCandidatesPerHour: z.number().int().min(1).max(1000).default(30),
    maxInputCharsPerHour: z.number().int().min(100).max(1_000_000).default(60000),
    maxActiveTasks: z.number().int().min(1).max(20).default(1),
    maxTaskMinutes: z.number().int().min(1).max(1440).default(30),
    maxModelCallsPerDay: z.number().int().min(1).max(10000).default(200),
    maxTokensPerDay: z.number().int().min(100).max(100_000_000).default(200000),
    maxCostPerDay: z.number().positive().max(1_000_000).optional(),
  }).strict().default(() => ({ windowMinutes: 5, maxCandidatesPerHour: 30, maxInputCharsPerHour: 60000,
    maxActiveTasks: 1, maxTaskMinutes: 30, maxModelCallsPerDay: 200, maxTokensPerDay: 200000 })),
}).strict()
export type QqConfig = z.infer<typeof QqConfigSchema>
export interface QqStatus {
  enabled: boolean; mode: 'forward' | 'reverse'; state: 'disabled' | OneBotState; detail: string; selfId?: string
  forwardUrl: string; reverseUrl: string; tokenConfigured: boolean; allowedUsers: number; groups: number
  received: number; lastMessageAt?: string
}
interface QqHost {
  stateDir: string
  artifacts?: Pick<ArtifactRegistry, 'verify'>
  store: Store; configured(): boolean; receive(trigger: Trigger): ReceiveResult; report(health: Health): void
  notify?(message: OutboundMessage): void
  resolveToken(name: string): Promise<string | undefined>; writeToken(name: string, value: string): Promise<void>
}
interface QqStats { received: number; lastMessageAt?: string }
interface Delivery {
  chunks: { text: string; messageId: string }[]
  artifacts?: { id: string; fileId: string | null }[]
  /** Written before a send; retained across transport failure and restarts until confirmed. */
  pending?: { part: string; at: string }
}
const statsKey = record<QqStats>('qq-stats')
const deliveryKey = (id: string) => record<Delivery>(`qq-delivery:${id}`)
const triggerId = (self: string, type: string, chat: string, message: string) => `qq-message-${key(self, type, chat, message)}`

/** A source operation refused with an explanation suitable for the local management panel. */
export class QqSourceError extends Error {
  constructor(readonly status: 400 | 409 | 503, message: string) { super(message) }
}
/** Split plain text into Unicode-safe QQ messages, preferring paragraph boundaries. */
export function qqReplyChunks(text: string, size: number): string[] {
  const result: string[] = [], characters = Array.from(text)
  for (let offset = 0; offset < characters.length;) {
    let end = Math.min(offset + size, characters.length)
    if (end < characters.length) { const newline = characters.lastIndexOf('\n', end - 1); if (newline >= offset + Math.floor(size / 2)) end = newline + 1 }
    result.push(characters.slice(offset, end).join('')); offset = end
  }
  return result
}

/** Owns the live OneBot connection; the Store retains every admitted event, thread mapping and confirmed reply chunk. */
export class QqBridge {
  readonly kind: SourceKind<QqConfig>
  private readonly threads: QqThreads
  private client?: OneBotClient
  private timer?: ReturnType<typeof setInterval>
  private loginRetryTimer?: ReturnType<typeof setTimeout>
  private loginAbort?: AbortController
  private loginSequence = 0
  private loginRetryAttempt = 0
  private checking?: Promise<void>
  private events: Promise<void> = Promise.resolve()
  private fingerprint = ''
  private stopped = true
  private state: QqStatus['state'] = 'disabled'
  private detail = 'QQ 来源已关闭。'
  private selfId?: string
  private downloads = new AbortController()
  readonly attachments: QqAttachmentStore
  readonly observations: QqObservationBudget
  constructor(private readonly host: QqHost) {
    this.observations = new QqObservationBudget({ store: host.store, limits: () => this.config().observation,
      allowed: groupId => this.enabled() && this.host.configured() && this.config().groups.find(group => group.id === groupId)?.listen === 'observe'
        && this.host.store.settings().eval.mode !== 'off' })
    this.attachments = new QqAttachmentStore({ store: host.store, stateDir: host.stateDir, signal: () => this.downloads.signal,
      allowed: trigger => trigger.source === 'qq' && !!trigger.channel && this.canSend(trigger.channel.address)
        && (!this.selfId || trigger.meta.selfId === this.selfId),
      call: async (action, params, signal) => {
        if (!this.client?.connected || !this.selfId) throw new Error('OneBot 尚未连接，附件可在恢复连接后重试读取')
        return this.client.call(action, params, signal)
      },
      localPeer: () => { const config = this.config(); return config.connection === 'reverse'
        || ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(config.url).hostname) } })
    this.threads = new QqThreads(host.store)
    const settings = host.store.settings(); let changed = false
    if (!settings.sources.qq) { settings.sources.qq = { enabled: false, config: {} }; changed = true }
    if (!settings.policy.sources.qq) { settings.policy.sources.qq = { allowed: [], admission: {} }; changed = true }
    if (changed) host.store.saveSettings(settings)
    this.kind = this.source()
  }
  private config(): QqConfig { return QqConfigSchema.parse(this.host.store.settings().sources.qq?.config ?? {}) }
  private enabled(): boolean { return this.host.store.settings().sources.qq?.enabled === true }
  async status(): Promise<QqStatus> {
    const config = this.config(), stats = this.host.store.get(statsKey)
    return { enabled: this.enabled(), mode: config.connection, state: this.state, detail: this.detail,
      ...this.selfId ? { selfId: this.selfId } : {}, forwardUrl: config.url,
      reverseUrl: `ws://${config.host === '::1' ? '[::1]' : config.host}:${config.port}${config.path}`,
      tokenConfigured: !!await this.host.resolveToken(config.tokenRef).catch(() => undefined),
      allowedUsers: this.host.store.settings().policy.sources.qq?.allowed.length ?? 0, groups: config.groups.length,
      received: stats?.received ?? 0, ...stats?.lastMessageAt ? { lastMessageAt: stats.lastMessageAt } : {} }
  }
  async setToken(value: string): Promise<{ configured: boolean }> {
    const token = z.string().max(4000).parse(value).trim()
    if (/[\r\n]/.test(token)) throw new QqSourceError(400, 'Access Token 请使用单行文本。')
    await this.host.writeToken(this.config().tokenRef, token)
    this.fingerprint = ''; await this.check()
    return { configured: !!token }
  }
  async start(): Promise<void> {
    if (!this.stopped) return
    if (this.downloads.signal.aborted) this.downloads = new AbortController()
    this.stopped = false; await this.check()
    this.timer = setInterval(() => { void this.check() }, 2000); this.timer.unref?.()
  }
  async stop(): Promise<void> {
    this.downloads.abort()
    this.stopped = true; clearInterval(this.timer); this.cancelLoginInfo(); await this.checking
    await this.client?.stop(); this.client = undefined; await this.events; await this.attachments.idle()
  }
  private setState(state: QqStatus['state'], detail: string): void {
    this.state = state; this.detail = safeFailureMessage(detail)
    this.host.report({ state: state === 'connected' ? 'ready' : state === 'error' ? 'error' : state === 'disabled' ? 'paused' : 'starting',
      detail: this.detail, at: new Date().toISOString() })
  }
  private cancelLoginInfo(): void {
    clearTimeout(this.loginRetryTimer); this.loginRetryTimer = undefined
    this.loginSequence++
    this.loginAbort?.abort(); this.loginAbort = undefined
  }
  private queryLoginInfo(client: OneBotClient): void {
    if (this.client !== client || !client.connected || this.stopped || this.loginAbort || this.loginRetryTimer) return
    const sequence = ++this.loginSequence, controller = new AbortController()
    this.loginAbort = controller
    void client.getLoginInfo(controller.signal).then(info => {
      if (sequence !== this.loginSequence || this.client !== client || !client.connected || this.stopped) return
      this.loginRetryAttempt = 0
      this.selfId = info.user_id; this.setState('connected', `OneBot 已连接，QQ ${info.user_id}。`)
    }, error => {
      if (sequence !== this.loginSequence || this.client !== client || !client.connected || this.stopped) return
      this.setState('error', safeFailureMessage(error))
      const delay = Math.min(30_000, 1_000 * 2 ** Math.min(this.loginRetryAttempt++, 5))
      this.loginRetryTimer = setTimeout(() => {
        this.loginRetryTimer = undefined
        this.queryLoginInfo(client)
      }, delay)
      this.loginRetryTimer.unref?.()
    }).finally(() => {
      if (this.loginAbort === controller) this.loginAbort = undefined
    })
  }
  private check(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    return this.checking ??= this.configure().catch(error => this.setState('error', safeFailureMessage(error)))
      .finally(() => { this.checking = undefined })
  }
  private async configure(): Promise<void> {
    const config = this.config(), enabled = this.enabled() && this.host.configured()
    const token = await this.host.resolveToken(config.tokenRef) ?? ''
    const fingerprint = key(JSON.stringify(config), String(enabled), token)
    if (this.stopped || fingerprint === this.fingerprint) return
    this.fingerprint = fingerprint
    this.cancelLoginInfo(); this.loginRetryAttempt = 0
    const previous = this.client; this.client = undefined; this.selfId = undefined; await previous?.stop()
    if (this.stopped) return
    if (!enabled) { this.setState('disabled', this.enabled() ? '等待个人助理启动。' : 'QQ 来源已关闭。'); return }
    const client = new OneBotClient({
      connection: config.connection === 'forward' ? { mode: 'forward', url: config.url, token, requestTimeoutMs: config.requestTimeoutMs }
        : { mode: 'reverse', host: config.host, port: config.port, path: config.path, token, requestTimeoutMs: config.requestTimeoutMs },
      onState: (state, detail) => {
        if (this.client !== client || this.stopped) return
        if (state === 'connected') {
          this.cancelLoginInfo(); this.loginRetryAttempt = 0
          this.selfId = undefined
          this.setState('connecting', '正在确认 OneBot 登录账号。')
          this.queryLoginInfo(client)
        } else {
          this.cancelLoginInfo()
          this.selfId = undefined
          this.setState(state, detail ?? (state === 'connecting' ? '等待 OneBot WebSocket 连接。' : 'OneBot 连接已断开，等待重新连接。'))
        }
      },
      onEvent: event => {
        this.events = this.events.then(() => { if (this.client === client && !this.stopped) this.ingest(event) })
          .catch(error => this.setState('error', safeFailureMessage(error)))
        return this.events
      }, onError: error => { if (this.client === client && !this.stopped) this.setState('error', safeFailureMessage(error)) },
    })
    this.client = client
    try { await client.start() } catch (error) { this.fingerprint = ''; await client.stop(); throw error }
  }
  /** Reject unconfigured chats and unlisted senders before any LLM-bound event is created. */
  ingest(event: unknown): ReceiveResult | undefined {
    if (!this.enabled() || !this.host.configured()) return
    const message = normalizeOneBotMessage(event, this.selfId)
    if (!message || (this.selfId && message.selfId !== this.selfId)) return
    const config = this.config(), settings = this.host.store.settings()
    if (message.messageType === 'private' ? !config.privateMessages : !config.groups.some(group => group.id === message.groupId)) return
    if (!settings.policy.sources.qq?.allowed.some(user => user.id === message.userId)) return
    const chat = message.messageType === 'group' ? message.groupId! : message.userId
    const eventId = triggerId(message.selfId, message.messageType, chat, message.id)
    if (this.host.store.triggers.get(eventId)) return 'duplicate'
    let text = message.text.trim()
    if (message.mentions.includes(message.selfId) && text.startsWith(`@${message.selfId}`)) text = text.slice(message.selfId.length + 1).trimStart()
    const prefix = config.commandPrefix, prefixed = text === prefix || text.startsWith(`${prefix} `) || text.startsWith(`${prefix}\n`)
    if (prefixed) text = text.slice(prefix.length).trimStart()
    const newCommand = /^\/new(?:\s|$)/.test(text) || prefixed && /^new(?:\s|$)/i.test(text)
    if (newCommand) text = text.replace(/^(?:\/new|new)(?:\s|$)/i, '').trimStart()
    const resetKey = record<boolean>(`qq-new:${message.selfId}:${message.messageType}:${chat}:${message.userId}`)
    const forceNew = newCommand || this.host.store.get(resetKey) === true
    if (newCommand && !text) {
      const controlKey = record<boolean>(`qq-control:${eventId}`)
      if (this.host.store.get(controlKey)) return 'duplicate'
      const controlThread = `${message.messageType === 'group' ? 'g' : 'p'}:${message.selfId}:${chat}:${message.id}`
      this.host.store.atomic(() => {
        this.host.store.set(controlKey, true); this.host.store.set(resetKey, true)
        this.threads.recordIncoming(message, controlThread, eventId)
        this.host.notify?.({ id: key('qq-new', eventId), kind: 'reply', text: '新会话已准备好，请发送任务内容。',
          channel: { source: 'qq', thread: `qq:${controlThread}`, address: { self_id: message.selfId, message_type: message.messageType,
            recipient_id: chat, user_id: message.userId, message_id: message.id, thread_id: controlThread } } })
      })
      return 'stored'
    }
    if (!text || text.length > 16000) return
    const addressed = message.messageType === 'private' || message.mentions.includes(message.selfId) || prefixed || forceNew
    const observing = message.messageType === 'group' && config.groups.find(group => group.id === message.groupId)?.listen === 'observe'
    const resolved = this.threads.resolve(message, { sessionMinutes: config.sessionMinutes, groupFollowups: config.groupFollowups,
      privateFollowups: config.privateFollowups, forceNew, addressed,
      ...observing ? { observationWindowMinutes: config.observation.windowMinutes } : {} })
    if (!resolved) return
    const observation = observing && !addressed && (!resolved.replyKnown || resolved.threadId.startsWith('o:'))
    if (observation && !this.observations.admit(chat, eventId, text.length).allowed) return 'filtered'
    const channel = { source: 'qq', thread: `qq:${resolved.threadId}`, address: { self_id: message.selfId, message_type: message.messageType,
      recipient_id: chat, user_id: message.userId, message_id: message.id, thread_id: resolved.threadId } }
    const trigger: Trigger = { id: eventId, source: 'qq', threads: [{ source: 'qq', id: resolved.threadId }],
      actor: { source: 'qq', id: message.userId }, human: true, routing: 'router',
      ...message.messageType === 'private' ? { addressed: 'direct' as const } : addressed || resolved.replyKnown && !observation ? { addressed: 'mention' as const } : {},
      at: message.at, text, channel, meta: { selfId: message.selfId, userId: message.userId, groupId: message.groupId,
        messageType: message.messageType, messageId: message.id, threadId: resolved.threadId, replyTo: message.replyTo,
        senderName: message.senderName, attachments: message.attachments,
        ...observation ? { observation: { groupId: chat, windowId: resolved.threadId },
          routingInstruction: 'Unaddressed QQ observation; no Worker has received this message. In auto mode, attach relevant context to an existing authorized ticket instead of creating duplicate work. In observe mode, record the assessment only; do not attach or dispatch. Keep background attempts silent and deliver useful results only. Preserve the original discussion and current policy.' } : {} } }
    const attachments = this.attachments.references(trigger)
    if (attachments.length) trigger.attachments = attachments
    if (!forceNew && !resolved.replyKnown) {
      const context = this.threads.contextFor(message, config.sessionMinutes)
      if (context.length) trigger.context = context
    }
    return this.host.store.atomic(() => {
      this.threads.recordIncoming(message, resolved.threadId, eventId, attachments)
      const result = this.host.receive(trigger)
      if (result === 'stored') {
        this.host.store.delete(resetKey)
        this.host.store.threads.describe(`qq:${resolved.threadId}`, { label: `${message.messageType === 'group' ? `QQ 群 ${chat}` : 'QQ 私聊'} · ${message.senderName ?? message.userId}` })
        const stats = this.host.store.get(statsKey) ?? { received: 0 }
        this.host.store.set(statsKey, { received: stats.received + 1, lastMessageAt: message.at })
      }
      return result
    })
  }
  private canSend(address: Record<string, string>): boolean {
    if (!this.enabled() || !this.host.store.settings().policy.sources.qq?.allowed.some(user => user.id === address.user_id)) return false
    const config = this.config()
    return address.message_type === 'private' ? config.privateMessages && address.recipient_id === address.user_id
      : address.message_type === 'group' && config.groups.some(group => group.id === address.recipient_id)
  }
  private async send(message: OutboundMessage, cancellation?: AbortSignal): Promise<'sent' | 'gone' | 'uncertain'> {
    const signal = AbortSignal.any([this.downloads.signal, ...cancellation ? [cancellation] : []])
    if (signal.aborted) return 'gone'
    if (!this.canSend(message.channel.address)) return 'gone'
    const client = this.client, address = message.channel.address, config = this.config()
    if (!client?.connected || !this.selfId) throw new Error('OneBot 尚未连接，回复会在连接恢复后重试。')
    if (address.self_id !== this.selfId) throw new Error('当前 OneBot 登录账号与任务所属机器人不同，请恢复原账号。')
    const chunks = qqReplyChunks(message.text, config.replyChunkSize)
    if (chunks.length > config.maxReplyChunks) throw new Error('回复超过 QQ 分段上限，请在来源设置中提高最大分段数。')
    let delivery = this.host.store.get(deliveryKey(message.id)) ?? { chunks: [] }
    if (delivery.pending) return 'uncertain'
    const sending = (part: string) => {
      if (!client.connected) throw new Error('OneBot is not connected')
      delivery.pending = { part, at: new Date().toISOString() }
      this.host.store.set(deliveryKey(message.id), delivery)
    }
    try {
      for (const id of message.artifacts ?? []) {
        if (delivery.artifacts?.some(item => item.id === id)) continue
        if (!this.host.artifacts || !message.ticketId) throw new Error('Artifact delivery requires its originating task and durable artifact registry')
        const artifact = await this.host.artifacts.verify(id, message.ticketId)
        if (signal.aborted || !this.canSend(address)) return 'gone'
        const native = artifact.kind === 'image' || artifact.kind === 'video'
        if (native && !artifact.mediaType.startsWith(`${artifact.kind}/`)) throw new Error('Artifact media kind and format do not match')
        const contents = await readFile(artifact.path)
        if (signal.aborted || !this.canSend(address)) return 'gone'
        const file = `base64://${contents.toString('base64')}`
        sending(`artifact:${id}`)
        const reply = native
          ? await client.call<{ message_id?: string | number }>(address.message_type === 'group' ? 'send_group_msg' : 'send_private_msg',
            { [address.message_type === 'group' ? 'group_id' : 'user_id']: address.recipient_id,
              message: [{ type: artifact.kind, data: { file } }] }, signal, config.fileUploadTimeoutMs)
          : await client.call<{ file_id?: string | null }>(address.message_type === 'group' ? 'upload_group_file' : 'upload_private_file',
            { [address.message_type === 'group' ? 'group_id' : 'user_id']: address.recipient_id, file, name: artifact.name }, signal, config.fileUploadTimeoutMs)
        // Upload APIs may return empty data on success; the successful RPC is their confirmation.
        const fileId = native ? String((reply as { message_id?: string | number })?.message_id ?? '') : (reply as { file_id?: string | null })?.file_id
        if (native ? !/^-?\d+$/.test(String(fileId)) : fileId != null && typeof fileId !== 'string') throw new Error('OneBot did not confirm the artifact delivery')
        this.host.store.atomic(() => {
          delivery = this.host.store.get(deliveryKey(message.id)) ?? { chunks: [] }
          delivery.artifacts = [...delivery.artifacts ?? [], { id, fileId: fileId ?? null }]
          delete delivery.pending
          this.host.store.set(deliveryKey(message.id), delivery)
          if (native) this.threads.recordOutgoing(String(fileId), address.thread_id!, {
            messageType: address.message_type as 'private' | 'group', recipientId: address.recipient_id!, selfId: address.self_id! }, `[${artifact.kind}] ${artifact.name}`)
        })
      }
      if (delivery.chunks.some((chunk, index) => chunk.text !== chunks[index])) throw new Error('QQ 回复分段配置发生变化，请恢复原分段大小后重试。')
      for (let index = delivery.chunks.length; index < chunks.length; index++) {
        if (signal.aborted || !this.canSend(address)) return 'gone'
        const segments = [...index === 0 && address.message_id ? [{ type: 'reply', data: { id: address.message_id } }] : [],
          { type: 'text', data: { text: chunks[index]! } }]
        sending(`chunk:${index}`)
        const reply = await client.call<{ message_id: string | number }>(address.message_type === 'group' ? 'send_group_msg' : 'send_private_msg',
          { [address.message_type === 'group' ? 'group_id' : 'user_id']: address.recipient_id, message: segments }, signal)
        const messageId = String(reply?.message_id ?? '')
        if (!/^-?\d+$/.test(messageId)) throw new Error('OneBot 未返回有效的回复消息编号。')
        this.host.store.atomic(() => {
          delivery = this.host.store.get(deliveryKey(message.id)) ?? { chunks: [] }
          if (delivery.chunks.length === index) delivery.chunks.push({ text: chunks[index]!, messageId })
          delete delivery.pending
          this.host.store.set(deliveryKey(message.id), delivery)
          this.threads.recordOutgoing(messageId, address.thread_id!, { messageType: address.message_type as 'private' | 'group', recipientId: address.recipient_id!, selfId: address.self_id! }, chunks[index]!)
        })
      }
      return 'sent'
    } catch (error) {
      if (error instanceof OneBotRpcError) {
        delivery = this.host.store.get(deliveryKey(message.id)) ?? { chunks: [] }
        delete delivery.pending
        this.host.store.set(deliveryKey(message.id), delivery)
        throw error
      }
      // A timeout or disconnect does not cancel an upload already accepted by the peer.
      if (this.host.store.get(deliveryKey(message.id))?.pending) return 'uncertain'
      throw error
    }
  }
  private source(): SourceKind<QqConfig> {
    return { kind: 'qq', title: { zh: 'QQ · OneBot v11', en: 'QQ · OneBot v11' },
      description: { zh: '通过 OneBot v11（如 NapCat、SnowLuma）接收 QQ 私聊和群聊任务，并回复原会话。', en: 'Receive QQ tasks through OneBot v11 (such as NapCat or SnowLuma) and reply in the original chat.' },
      schema: QqConfigSchema, health: ['qq'], fields: qqFields(),
      attachments: { references: trigger => this.attachments.references(trigger),
        read: async (trigger, id, agent, signal) => {
          const result = await this.attachments.read(trigger, id, signal)
          return agent && (result.type === 'image' || result.type === 'video') ? readQqMedia(agent, result, signal) : result
        } },
      scope: ({ meta }, config) => {
        if (meta.messageType === 'private') return config.privateMessages ? { listened: true, observed: false, row: 'direct' } : { listened: false, reason: 'source_disabled' }
        const group = config.groups.find(group => group.id === meta.groupId)
        return group ? { listened: true, observed: group.listen === 'observe', row: group.id } : { listened: false, reason: 'source_disabled' }
      },
      channel: { artifacts: true, allowed: address => this.canSend(address), send: (_host, message, signal) => this.send(message, signal), link: () => ({ url: '', label: { zh: 'QQ 会话', en: 'QQ chat' } }) },
      policy: { schema: SourcePolicySchema, fields: [{ key: 'allowed', type: 'rows', label: { zh: '允许交办任务的 QQ 账号', en: 'Allowed QQ senders' },
        columns: [{ key: 'id', type: 'text', pattern: '[1-9][0-9]{3,19}', label: { zh: 'QQ 号', en: 'QQ ID' } }, { key: 'name', type: 'text', optional: true, label: { zh: '名称', en: 'Name' } }] }],
        rows: value => QqConfigSchema.parse(value).groups.map(group => ({ id: group.id, label: group.name ?? `QQ ${group.id}`,
          note: group.listen === 'observe' ? { zh: '接收已授权账号的群内讨论，沿用 observe/auto 策略和观察预算。', en: 'Observe authorized senders with observe/auto policy and budgets.' }
            : { zh: '接收明确交办与已知任务回复。', en: 'Receive addressed requests and known task replies.' },
          cells: { listedUnaddressed: group.listen === 'observe', unlistedAddressed: false, unlistedUnaddressed: false } })),
        explicit: { zh: '已授权的私聊、群内 @ 机器人、命令前缀和引用已知任务消息可直接交办。', en: 'Authorized private messages, mentions, command prefixes and quoted task replies are direct requests.' } },
      threadContext: { messageId: trigger => String(trigger.meta.messageId), read: async (_commands, trigger, part, cursor) =>
        this.threads.context(String(trigger.meta.threadId), part, cursor, typeof trigger.meta.replyTo === 'string' ? trigger.meta.replyTo : undefined) },
      repliesTo: trigger => typeof trigger.meta.replyTo === 'string' ? triggerId(String(trigger.meta.selfId), String(trigger.meta.messageType),
        String(trigger.meta.messageType === 'group' ? trigger.meta.groupId : trigger.meta.userId), trigger.meta.replyTo) : undefined }
  }
}

/** Source forms use the same field contract as GitHub, Feishu and Web tasks. */
function qqFields(): FieldSpec[] {
  const label = (zh: string, en: string) => ({ zh, en })
  const number = (key: string, zh: string, en: string, min: number, max: number): FieldSpec => ({ key, type: 'number', label: label(zh, en), min, max, advanced: true })
  return [
    { key: 'connection', type: 'select', label: label('连接方式', 'Connection'), options: [
      { value: 'forward', label: label('正向 WebSocket', 'Forward WebSocket') }, { value: 'reverse', label: label('反向 WebSocket', 'Reverse WebSocket') }] },
    { key: 'url', type: 'text', label: label('OneBot WebSocket 地址', 'OneBot WebSocket URL'), hint: label('正向模式使用，例如 ws://127.0.0.1:3001；同一 Docker 网络可用 ws://snowluma:3001/。', 'For forward mode, for example ws://127.0.0.1:3001; use ws://snowluma:3001/ on the same Docker network.') },
    { key: 'privateMessages', type: 'switch', label: label('接收已授权账号的私聊', 'Receive authorized private messages') },
    { key: 'groups', type: 'rows', label: label('接收的 QQ 群', 'Allowed groups'), hint: label('空列表接收 0 个群，群内发送者另需账号授权。', 'An empty list receives no groups; senders also need authorization.'), columns: [
      { key: 'id', type: 'text', label: label('群号', 'Group ID'), pattern: '[1-9][0-9]{3,19}' }, { key: 'name', type: 'text', optional: true, label: label('名称', 'Name') },
      { key: 'listen', type: 'select', label: label('接收范围', 'Listen scope'), options: [
        { value: 'requests', label: label('交办与任务回复', 'Requests and task replies') },
        { value: 'observe', label: label('观察群内讨论', 'Observe group discussion') }] }] },
    { key: 'commandPrefix', type: 'text', label: label('交办命令前缀', 'Command prefix') },
    { key: 'groupFollowups', type: 'select', label: label('群聊追问关联', 'Group follow-ups'), options: [
      { value: 'reply', label: label('引用回复原消息', 'Quoted replies') }, { value: 'sender-window', label: label('同一发送者的会话窗口', 'Sender session window') }] },
    { key: 'privateFollowups', type: 'select', label: label('私聊任务归属', 'Private task routing'), options: [
      { value: 'semantic', label: label('由 Router 判断新消息归属', 'Router semantic routing') },
      { value: 'sender-window', label: label('沿用发送者会话窗口', 'Sender session window') }] },
    number('sessionMinutes', '会话窗口 / 分钟', 'Session window / minutes', 1, 1440),
    { key: 'host', type: 'select', advanced: true, label: label('反向监听地址', 'Reverse listen host'), options: ['127.0.0.1', 'localhost', '::1'].map(value => ({ value, label: label(value, value) })) },
    number('port', '反向监听端口', 'Reverse listen port', 1024, 65535),
    { key: 'path', type: 'text', advanced: true, label: label('反向连接路径', 'Reverse path') },
    { key: 'tokenRef', type: 'text', advanced: true, label: label('令牌凭据名称', 'Token credential reference') },
    number('replyChunkSize', '每段回复字符数', 'Reply chunk characters', 200, 4000),
    number('maxReplyChunks', '每条回复最多分段数', 'Maximum reply chunks', 1, 50),
    number('requestTimeoutMs', 'OneBot 请求超时 / 毫秒', 'OneBot timeout / ms', 1000, 60000),
    number('fileUploadTimeoutMs', 'QQ 文件上传超时 / 毫秒', 'QQ file upload timeout / ms', 1000, 600000),
  ]
}
