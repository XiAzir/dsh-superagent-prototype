import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Store } from '../src/app/store.ts'
import { QqThreads } from '../src/app/qq-threads.ts'
import type { NormalizedOneBotMessage } from '../src/sources/onebot-message.ts'

let dir: string
let store: Store
let threads: QqThreads
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'qq-threads-')); store = new Store(join(dir, 'db.sqlite')); threads = new QqThreads(store) })
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })

const message = (id: string, values: Partial<NormalizedOneBotMessage> = {}): NormalizedOneBotMessage => ({
  id, selfId: '900', userId: '100', messageType: 'group', groupId: '500', at: '2026-10-31T10:00:00.000Z',
  text: `message ${id}`, mentions: [], attachments: [], ...values,
})
const opts = (values: Partial<{ sessionMinutes: number; groupFollowups: 'reply' | 'sender-window'; forceNew?: boolean; addressed: boolean }> = {}) => ({
  sessionMinutes: 30, groupFollowups: 'reply' as const, addressed: false, ...values,
})
const resolveAndRecord = (msg: NormalizedOneBotMessage, options = opts()) => {
  const resolved = threads.resolve(msg, options)
  if (resolved) threads.recordIncoming(msg, resolved.threadId, `trigger-${msg.id}`)
  return resolved
}

describe('QqThreads', () => {
  it('keeps group replies on the known parent thread, including replies to bot messages', async () => {
    const root = message('1', { mentions: ['900'], text: '@bot do task' })
    const first = resolveAndRecord(root, opts({ addressed: true }))!
    threads.recordOutgoing('2', first.threadId, { messageType: 'group', recipientId: '500', selfId: '900' }, 'working')
    const reply = message('3', { replyTo: '2', text: 'more detail' })
    expect(threads.resolve(reply, opts())).toEqual({ threadId: first.threadId, replyKnown: true })
    resolveAndRecord(reply)
    expect(await threads.context(first.threadId, 'parent', undefined, '2')).toMatchObject({ messages: [{ id: '2', from: '900', bot: true }] })
  })

  it('isolates same message IDs across chats and bot identities', async () => {
    const root = message('10', { mentions: ['900'] })
    const one = resolveAndRecord(root, opts({ addressed: true }))!
    const crossGroup = message('11', { groupId: '501', replyTo: '10' })
    const crossBot = message('12', { selfId: '901', replyTo: '10' })
    expect(threads.resolve(crossGroup, opts())).toBeUndefined()
    expect(threads.resolve(crossBot, opts())).toBeUndefined()
    const collidingIdOtherChat = message('10', { groupId: '501', mentions: ['900'] })
    expect(resolveAndRecord(collidingIdOtherChat, opts({ addressed: true }))?.threadId).not.toBe(one.threadId)
    expect(await threads.context(one.threadId, 'thread')).toMatchObject({ messages: [{ id: '10' }] })
  })

  it('continues private sessions inside the window and starts a new thread with forceNew', () => {
    const first = message('20', { messageType: 'private', groupId: undefined, at: '2026-10-31T10:00:00.000Z' })
    const initial = resolveAndRecord(first)!
    const followup = message('21', { messageType: 'private', groupId: undefined, at: '2026-10-31T10:20:00.000Z' })
    expect(resolveAndRecord(followup)?.threadId).toBe(initial.threadId)
    const fresh = message('22', { messageType: 'private', groupId: undefined, at: '2026-10-31T10:21:00.000Z' })
    expect(threads.resolve(fresh, opts({ forceNew: true }))?.threadId).toBe('p:900:100:22')
  })

  it('does not move the active private window backward for out-of-order messages', () => {
    const first = message('30', { messageType: 'private', groupId: undefined, at: '2026-10-31T10:00:00.000Z' })
    const root = resolveAndRecord(first)!
    resolveAndRecord(message('31', { messageType: 'private', groupId: undefined, at: '2026-10-31T10:25:00.000Z' }))
    const old = message('32', { messageType: 'private', groupId: undefined, at: '2026-10-31T10:05:00.000Z' })
    expect(resolveAndRecord(old)?.threadId).toBe(root.threadId)
    const afterExpiry = message('33', { messageType: 'private', groupId: undefined, at: '2026-10-31T10:56:00.000Z' })
    expect(threads.resolve(afterExpiry, opts())?.threadId).toBe('p:900:100:33')
  })

  it('ignores unaddressed group chatter by default and supports sender-window followups', () => {
    expect(threads.resolve(message('40'), opts())).toBeUndefined()
    const addressed = message('41', { mentions: ['900'] })
    const root = resolveAndRecord(addressed, opts({ addressed: true }))!
    const next = message('42', { at: '2026-10-31T10:10:00.000Z' })
    expect(threads.resolve(next, opts({ groupFollowups: 'sender-window' }))?.threadId).toBe(root.threadId)
    expect(threads.resolve(next, opts({ groupFollowups: 'reply' }))).toBeUndefined()
  })

  it('keeps message mappings idempotent and restores them after reopening Store', async () => {
    const root = message('50', { mentions: ['900'] })
    const resolved = resolveAndRecord(root, opts({ addressed: true }))!
    const conflicting = message('50', { mentions: ['900'], text: 'changed' })
    expect(threads.resolve(conflicting, opts({ addressed: true }))?.threadId).toBe(resolved.threadId)
    threads.recordIncoming(conflicting, 'g:900:500:other', 'replacement-trigger')
    threads.recordOutgoing('51', resolved.threadId, { messageType: 'group', recipientId: '500', selfId: '900' }, 'answer')
    threads.recordOutgoing('51', 'other', { messageType: 'group', recipientId: '500', selfId: '900' }, 'changed')
    store.close()
    store = new Store(join(dir, 'db.sqlite'))
    threads = new QqThreads(store)
    expect(threads.resolve(message('52', { replyTo: '51' }), opts())).toEqual({ threadId: resolved.threadId, replyKnown: true })
    expect(await threads.context(resolved.threadId, 'root')).toMatchObject({ messages: [{ id: '50', text: 'message 50' }] })
  })

  it('paginates history in pages of 30 and validates bounded numeric cursors', async () => {
    const root = message('100', { mentions: ['900'] })
    const resolved = resolveAndRecord(root, opts({ addressed: true }))!
    for (let i = 101; i < 137; i++) {
      const msg = message(String(i), { replyTo: '100', at: `2026-10-31T10:${String(i - 100).padStart(2, '0')}:00.000Z` })
      threads.recordIncoming(msg, resolved.threadId, `trigger-${i}`)
    }
    const first = await threads.context(resolved.threadId, 'thread')
    expect(first.messages).toHaveLength(30)
    expect(first.next).toBe('30')
    const second = await threads.context(resolved.threadId, 'thread', first.next)
    expect(second.messages).toHaveLength(7)
    expect(second.next).toBeUndefined()
    await expect(threads.context(resolved.threadId, 'thread', '1.5')).rejects.toThrow(/integer/)
    await expect(threads.context(resolved.threadId, 'thread', '10001')).rejects.toThrow(/range/)
  })
})
