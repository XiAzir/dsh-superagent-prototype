export interface OneBotAttachment {
  type: 'image' | 'file' | 'record' | 'video'
  file?: string
  url?: string
  name?: string
  size?: number
}

export interface NormalizedOneBotMessage {
  id: string
  selfId: string
  userId: string
  groupId?: string
  messageType: 'private' | 'group'
  at: string
  text: string
  /** IDs targeted by OneBot `at` segments. */
  mentions: string[]
  replyTo?: string
  attachments: OneBotAttachment[]
  senderName?: string
}

type Segment = { type?: unknown; data?: unknown }

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined

function positiveId(value: unknown): string | undefined {
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : typeof value === 'string' ? value : ''
  return /^[1-9]\d*$/.test(text) ? text : undefined
}

function messageId(value: unknown): string | undefined {
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : typeof value === 'string' ? value : ''
  return /^-?\d+$/.test(text) && text !== '-0' ? text : undefined
}

function decodeCQ(value: string): string {
  return value.replace(/&#91;/gi, '[').replace(/&#93;/gi, ']').replace(/&#44;/gi, ',').replace(/&amp;/gi, '&')
}

function timestamp(value: unknown): string | undefined {
  const seconds = typeof value === 'number' ? value : typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined
  const date = new Date(seconds * 1000)
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined
}

function attachment(type: string, data: Record<string, unknown>): OneBotAttachment | undefined {
  if (type !== 'image' && type !== 'file' && type !== 'record' && type !== 'video') return undefined
  const result: OneBotAttachment = { type }
  for (const key of ['file', 'url', 'name'] as const) if (typeof data[key] === 'string' && data[key]) result[key] = data[key] as string
  if (typeof data.size === 'number' && Number.isFinite(data.size) && data.size >= 0) result.size = data.size
  return result
}

function normalizeSegments(input: unknown): { text: string; at: string[]; replyTo?: string; attachments: OneBotAttachment[] } {
  const chunks: string[] = [], at: string[] = [], attachments: OneBotAttachment[] = []
  let replyTo: string | undefined
  const add = (segmentType: string, data: Record<string, unknown>): boolean => {
    if (segmentType === 'text') { if (typeof data.text === 'string') chunks.push(data.text); return true }
    if (segmentType === 'at') {
      const target = data.qq === 'all' ? 'all' : positiveId(data.qq)
      if (!target) return false
      if (target && !at.includes(target)) at.push(target)
      if (target && target !== 'all') chunks.push(`@${target}`)
      else if (target === 'all') chunks.push('@全体成员')
      return true
    }
    if (segmentType === 'reply') { replyTo = messageId(data.id); return !!replyTo }
    const file = attachment(segmentType, data)
    if (!file) return false
    attachments.push(file)
    chunks.push(`[${segmentType === 'record' ? '语音' : segmentType === 'video' ? '视频' : segmentType === 'image' ? '图片' : '文件'}]`)
    return true
  }

  if (typeof input === 'string') {
    // CQ entities are decoded only outside the matched control segment; plain text from segment arrays stays literal.
    const cq = /\[CQ:([a-zA-Z0-9_-]+)((?:,[^\]]*)?)\]/g
    let offset = 0, match: RegExpExecArray | null
    while ((match = cq.exec(input))) {
      chunks.push(decodeCQ(input.slice(offset, match.index)))
      const values: Record<string, unknown> = {}
      for (const part of (match[2] ?? '').replace(/^,/, '').split(',')) {
        const separator = part.indexOf('=')
        if (separator > 0) values[part.slice(0, separator)] = decodeCQ(part.slice(separator + 1))
      }
      if (!add(match[1]!.toLowerCase(), values)) chunks.push(decodeCQ(match[0]))
      offset = cq.lastIndex
    }
    chunks.push(decodeCQ(input.slice(offset)))
  } else if (Array.isArray(input)) {
    for (const value of input) {
      const segment = record(value) as Segment | undefined
      const data = record(segment?.data)
      if (typeof segment?.type === 'string' && data) add(segment.type, data)
    }
  }
  return { text: chunks.join(''), at, ...(replyTo ? { replyTo } : {}), attachments }
}

/** Safely maps an inbound OneBot v11 message event; unsupported events and malformed payloads return null. */
export function normalizeOneBotMessage(input: unknown, knownSelfId?: string): NormalizedOneBotMessage | null {
  const event = record(input)
  if (!event || event.post_type !== 'message' || (event.message_type !== 'private' && event.message_type !== 'group')) return null
  if (event.message_sent === true || event.sub_type === 'message_sent') return null
  const messageType = event.message_type
  const selfId = positiveId(event.self_id) ?? (knownSelfId ? positiveId(knownSelfId) : undefined)
  const userId = positiveId(event.user_id)
  const id = messageId(event.message_id)
  const at = timestamp(event.time)
  const groupId = messageType === 'group' ? positiveId(event.group_id) : undefined
  if (!selfId || !userId || !id || !at || (messageType === 'group' && !groupId)) return null
  if (userId === selfId) return null
  const normalized = normalizeSegments(event.message)
  const sender = record(event.sender)
  const senderName = [sender?.card, sender?.nickname].find(value => typeof value === 'string' && value.trim())
  return {
    id, selfId, userId, ...(groupId ? { groupId } : {}), messageType, at,
    text: normalized.text, mentions: normalized.at,
    ...(normalized.replyTo ? { replyTo: normalized.replyTo } : {}), attachments: normalized.attachments,
    ...(typeof senderName === 'string' ? { senderName } : {}),
  }
}
