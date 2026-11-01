import { record } from '../kv.ts'
import type { Store } from './store.ts'
import type { ContextMessage, ContextPart, SourceAttachmentRef } from '../sources/kind.ts'
import type { NormalizedOneBotMessage } from '../sources/onebot-message.ts'

const MESSAGE_PREFIX = 'qq-message:'
const THREAD_PREFIX = 'qq-thread:'
const ACTIVE_PREFIX = 'qq-active:'
const PAGE_SIZE = 30
const HISTORY_LIMIT = 200
const MAX_CURSOR = 10_000

interface ChatIdentity { selfId: string; messageType: 'private' | 'group'; chatId: string }
interface MessageLink extends ChatIdentity {
  id: string; userId: string; threadId: string; triggerId: string; at: string; text: string; replyTo?: string
}
interface ThreadData extends ChatIdentity { rootId: string; history: ContextMessage[] }
interface ActiveThread extends ChatIdentity { userId: string; threadId: string; lastAt: string }

export interface QqThreadOptions {
  sessionMinutes: number
  groupFollowups: 'reply' | 'sender-window'
  forceNew?: boolean
  addressed: boolean
}

/** Persists QQ message-to-thread links, sender session windows and bounded source context. */
export class QqThreads {
  constructor(private readonly store: Store) {}

  resolve(message: NormalizedOneBotMessage, options: QqThreadOptions): { threadId: string; replyKnown: boolean } | undefined {
    const identity = identityOf(message)
    if (!identity || !validTime(message.at) || !Number.isFinite(options.sessionMinutes) || options.sessionMinutes < 0) return undefined
    const incomingKey = messageKey(identity, message.id)
    const already = this.store.get(record<MessageLink>(incomingKey))
    if (already && sameChat(already, identity) && already.userId === message.userId) return { threadId: already.threadId, replyKnown: false }

    const parent = message.replyTo ? this.store.get(record<MessageLink>(messageKey(identity, message.replyTo))) : undefined
    const replyKnown = !!parent && sameChat(parent, identity)
    if (options.forceNew) return { threadId: threadId(identity, message.id), replyKnown }
    if (replyKnown) return { threadId: parent!.threadId, replyKnown: true }

    if (identity.messageType === 'private') {
      const activeKey = activeKeyOf(identity, message.userId)
      const active = this.store.get(record<ActiveThread>(activeKey))
      if (active && sameChat(active, identity) && active.userId === message.userId && withinWindow(message.at, active.lastAt, options.sessionMinutes)) {
        return { threadId: active.threadId, replyKnown: false }
      }
      return { threadId: threadId(identity, message.id), replyKnown: false }
    }
    if (options.addressed) return { threadId: threadId(identity, message.id), replyKnown: false }
    if (options.groupFollowups === 'sender-window') {
      const activeKey = activeKeyOf(identity, message.userId)
      const active = this.store.get(record<ActiveThread>(activeKey))
      if (active && sameChat(active, identity) && active.userId === message.userId && withinWindow(message.at, active.lastAt, options.sessionMinutes)) {
        return { threadId: active.threadId, replyKnown: false }
      }
    }
    return undefined
  }

  recordIncoming(message: NormalizedOneBotMessage, threadId: string, triggerId: string, attachments: SourceAttachmentRef[] = []): void {
    const identity = identityOf(message)
    if (!identity || !validTime(message.at)) return
    this.store.atomic(() => {
      const mapKey = messageKey(identity, message.id)
      const old = this.store.get(record<MessageLink>(mapKey))
      if (old) return
      const thread = this.thread(threadId, identity, message.id)
      if (!thread) return
      const link: MessageLink = { ...identity, id: message.id, userId: message.userId, threadId, triggerId, at: message.at,
        text: message.text, ...(message.replyTo ? { replyTo: message.replyTo } : {}) }
      this.store.set(record<MessageLink>(mapKey), link)
      this.append(threadId, thread, { id: message.id, from: message.userId, at: message.at, text: message.text,
        ...attachments.length ? { attachments } : {},
        ...(message.replyTo ? { reply_to: message.replyTo } : {}) })
      const key = activeKeyOf(identity, message.userId)
      const current = this.store.get(record<ActiveThread>(key))
      if (!current || !sameChat(current, identity) || Date.parse(message.at) > Date.parse(current.lastAt)) {
        this.store.set(record<ActiveThread>(key), { ...identity, userId: message.userId, threadId, lastAt: message.at })
      }
    })
  }

  recordOutgoing(messageId: string, threadId: string,
    address: { messageType: 'private' | 'group'; recipientId: string; selfId: string }, text: string): void {
    if (!validMessageId(messageId) || !validId(address.selfId) || !validId(address.recipientId)) return
    const identity: ChatIdentity = { selfId: address.selfId, messageType: address.messageType, chatId: address.recipientId }
    this.store.atomic(() => {
      const key = messageKey(identity, messageId)
      if (this.store.get(record<MessageLink>(key))) return
      const thread = this.thread(threadId, identity)
      if (!thread) return
      const at = new Date().toISOString()
      this.store.set(record<MessageLink>(key), { ...identity, id: messageId, userId: address.selfId, threadId, triggerId: '', at, text })
      this.append(threadId, thread, { id: messageId, from: address.selfId, at, text, bot: true })
    })
  }

  async context(threadId: string, part: 'thread' | 'root' | 'parent', cursor?: string, replyTo?: string): Promise<ContextPart> {
    const data = this.store.get(record<ThreadData>(threadKeyOf(threadId)))
    if (!data) return { messages: [], body: {} }
    const messages = data.history
    if (part === 'root') return { messages: messages.length ? [messages[0]!] : [], body: {} }
    if (part === 'parent') {
      if (!replyTo) return { messages: [], body: {} }
      const parent = this.store.get(record<MessageLink>(messageKey(data, replyTo)))
      if (!parent || parent.threadId !== threadId || !sameChat(parent, data)) return { messages: [], body: {} }
      const found = messages.find(message => message.id === replyTo)
      return { messages: found ? [found] : [], body: {} }
    }
    const offset = parseCursor(cursor)
    const page = messages.slice(offset, offset + PAGE_SIZE)
    return { messages: page, ...(offset + page.length < messages.length ? { next: String(offset + page.length) } : {}), body: {} }
  }

  private thread(threadId: string, identity: ChatIdentity, rootId?: string): ThreadData | undefined {
    const key = threadKeyOf(threadId)
    const saved = this.store.get(record<ThreadData>(key))
    if (saved) return sameChat(saved, identity) ? saved : undefined
    const data: ThreadData = { ...identity, rootId: rootId ?? threadRootId(threadId), history: [] }
    this.store.set(record<ThreadData>(key), data)
    return data
  }

  private append(threadId: string, thread: ThreadData, message: ContextMessage): void {
    if (thread.history.some(item => item.id === message.id && item.from === message.from)) return
    let history = [...thread.history, message]
    if (history.length > HISTORY_LIMIT) history = [history[0]!, ...history.slice(-(HISTORY_LIMIT - 1))]
    this.store.set(record<ThreadData>(threadKeyOf(threadId)), { ...thread, history })
  }
}

function identityOf(message: NormalizedOneBotMessage): ChatIdentity | undefined {
  if (!validId(message.selfId) || !validId(message.userId) || !validMessageId(message.id)) return undefined
  if (message.messageType === 'private') return { selfId: message.selfId, messageType: 'private', chatId: message.userId }
  if (message.messageType === 'group' && validId(message.groupId)) return { selfId: message.selfId, messageType: 'group', chatId: message.groupId }
  return undefined
}
function validId(value: string | undefined): value is string { return typeof value === 'string' && /^[1-9]\d*$/.test(value) }
function validMessageId(value: string): boolean { return /^-?\d+$/.test(value) && value !== '-0' }
function validTime(value: string): boolean { return Number.isFinite(Date.parse(value)) }
function sameChat(left: ChatIdentity, right: ChatIdentity): boolean {
  return left.selfId === right.selfId && left.messageType === right.messageType && left.chatId === right.chatId
}
function encoded(value: string): string { return encodeURIComponent(value) }
function messageKey(identity: ChatIdentity, messageId: string): string {
  return `${MESSAGE_PREFIX}${encoded(identity.selfId)}:${identity.messageType}:${encoded(identity.chatId)}:${encoded(messageId)}`
}
function threadKeyOf(threadId: string): string { return `${THREAD_PREFIX}${encoded(threadId)}` }
function activeKeyOf(identity: ChatIdentity, userId: string): string {
  return `${ACTIVE_PREFIX}${encoded(identity.selfId)}:${identity.messageType}:${encoded(identity.chatId)}:${encoded(userId)}`
}
function threadId(identity: ChatIdentity, rootId: string): string {
  return `${identity.messageType === 'private' ? 'p' : 'g'}:${identity.selfId}:${identity.chatId}:${rootId}`
}
function threadRootId(id: string): string { return id.slice(id.lastIndexOf(':') + 1) }
function withinWindow(messageAt: string, activeAt: string, minutes: number): boolean {
  const difference = Date.parse(messageAt) - Date.parse(activeAt)
  return difference <= minutes * 60_000 && difference >= -minutes * 60_000
}
function parseCursor(cursor?: string): number {
  if (cursor === undefined) return 0
  if (!/^\d+$/.test(cursor)) throw new Error('QQ context cursor must be a non-negative integer')
  const offset = Number(cursor)
  if (!Number.isSafeInteger(offset) || offset > MAX_CURSOR) throw new Error('QQ context cursor is out of range')
  return offset
}
