import { describe, expect, it } from 'vitest'
import { normalizeOneBotMessage } from '../src/sources/onebot-message.ts'

const event = (overrides: Record<string, unknown> = {}) => ({
  post_type: 'message', message_type: 'group', self_id: 100, user_id: 200, group_id: 300,
  message_id: -42, time: 1_700_000_000, message: [], sender: { nickname: '小明', card: '' }, ...overrides,
})

describe('normalizeOneBotMessage', () => {
  it('normalizes segment messages, IDs, time, mentions, replies and attachment metadata', () => {
    const result = normalizeOneBotMessage(event({ message: [
      { type: 'text', data: { text: '你好 ' } },
      { type: 'at', data: { qq: '456' } },
      { type: 'reply', data: { id: '-9' } },
      { type: 'image', data: { file: 'photo.png', url: 'https://cdn.test/photo.png', size: 123 } },
      { type: 'file', data: { name: 'report.pdf', file: 'f-1' } },
      { type: 'video', data: { url: 'https://cdn.test/movie.mp4' } },
      { type: 'file', data: { file_id: 'uuid-7', file: 'invoice.pdf', file_name: 'invoice.pdf', file_size: 456, url: 'https://cdn.test/invoice.pdf' } },
    ] }))
    expect(result).toMatchObject({ id: '-42', selfId: '100', userId: '200', groupId: '300', messageType: 'group',
      at: '2023-11-14T22:13:20.000Z', text: '你好 @456[图片][文件][视频][文件]', mentions: ['456'], replyTo: '-9', senderName: '小明' })
    expect(result?.attachments).toEqual([
      { type: 'image', file: 'photo.png', url: 'https://cdn.test/photo.png', size: 123 },
      { type: 'file', name: 'report.pdf', file: 'f-1' },
      { type: 'video', url: 'https://cdn.test/movie.mp4' },
      { type: 'file', file_id: 'uuid-7', file: 'invoice.pdf', file_name: 'invoice.pdf', file_size: 456, url: 'https://cdn.test/invoice.pdf' },
    ])
  })

  it('parses escaped CQ controls and keeps escaped bracket text literal', () => {
    const result = normalizeOneBotMessage(event({ message: 'Hi &#91;literal&#93; [CQ:at,qq=123][CQ:reply,id=-5][CQ:image,file=abc,url=https://example.test/a&amp;b.png]' }))
    expect(result?.text).toBe('Hi [literal] @123[图片]')
    expect(result?.mentions).toEqual(['123'])
    expect(result?.replyTo).toBe('-5')
    expect(result?.attachments[0]).toEqual({ type: 'image', file: 'abc', url: 'https://example.test/a&b.png' })
  })

  it('preserves locator, filename and size metadata from array and CQ file segments', () => {
    const array = normalizeOneBotMessage(event({ message: [{ type: 'file', data: { id: 'opaque-1', file: 'a.txt', file_size: 99, size: 100 } }] }))
    expect(array?.attachments[0]).toEqual({ type: 'file', id: 'opaque-1', file: 'a.txt', file_size: 99, size: 100 })
    const cq = normalizeOneBotMessage(event({ message: '[CQ:file,file_id=opaque-2,file_name=doc.pdf,file_size=123,file=doc.pdf,url=https://cdn.test/doc.pdf]' }))
    expect(cq?.attachments[0]).toEqual({ type: 'file', file_id: 'opaque-2', file: 'doc.pdf', file_name: 'doc.pdf', url: 'https://cdn.test/doc.pdf', file_size: 123 })
  })

  it('does not interpret CQ-like text segments as controls', () => {
    const result = normalizeOneBotMessage(event({ message: [{ type: 'text', data: { text: 'literal [CQ:at,qq=999]' } }] }))
    expect(result?.text).toBe('literal [CQ:at,qq=999]')
    expect(result?.mentions).toEqual([])
  })

  it('supports private messages and drops self messages, non-message events and invalid IDs', () => {
    expect(normalizeOneBotMessage(event({ message_type: 'private', group_id: undefined, message: 'hey' }))).toMatchObject({ messageType: 'private', text: 'hey' })
    expect(normalizeOneBotMessage(event({ user_id: 100 }))).toBeNull()
    expect(normalizeOneBotMessage(event({ post_type: 'notice' }))).toBeNull()
    expect(normalizeOneBotMessage(event({ sub_type: 'message_sent' }))).toBeNull()
    expect(normalizeOneBotMessage(event({ user_id: 0 }))).toBeNull()
    expect(normalizeOneBotMessage(event({ self_id: 'oops' }))).toBeNull()
    expect(normalizeOneBotMessage(event({ group_id: -1 }))).toBeNull()
    expect(normalizeOneBotMessage(event({ message_id: '2.5' }))).toBeNull()
    expect(normalizeOneBotMessage(event({ time: 'invalid' }))).toBeNull()
    expect(normalizeOneBotMessage(null)).toBeNull()
  })
})
