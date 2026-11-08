/** Outbox delivery when processing is paused or a Source kind registers late. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { OutboundMessage } from '../src/core/index.ts'
import { Commands } from '../src/infra/commands.ts'
import type { SourceKind } from '../src/sources/kind.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'
import { deferred } from './fixtures/async.ts'

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { await h.stop() })
async function at(ms: number) {
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + ms })
  try { await h.runtime.pump(); await h.runtime.sendReplies() } finally { vi.useRealTimers() }
}

it('revokes queued ticket replies on a stop and keeps their IDs cancelled when replayed', async () => {
  const { ticket, trigger } = await h.acceptedTicket(feishu('100', '@bot 获取安装包'))
  await h.runtime.settings.pause(true, 'panel')
  const message: OutboundMessage = { id: 'cancelled-result', channel: trigger.channel!, ticketId: ticket.id, text: '安装包', kind: 'reply' }
  h.runtime.outbox.send(message)
  h.runtime.engine.stopTicket(ticket.id)
  expect(h.runtime.store.receipts.get(message.id)).toMatchObject({ status: 'dropped', dropped: { reason: 'deliveryRevoked' } })
  expect(h.runtime.effects.pending('reply', message.id)).toBe(false)
  h.runtime.outbox.send(message)
  await h.runtime.settings.pause(false, 'panel')
  await h.runtime.sendReplies()
  expect(h.runtime.outbox.status(message.id)).toBe('dropped')
})

it('revokes legacy pending results for a stopped ticket before checking source availability, and still answers new status questions', async () => {
  const { ticket } = await h.acceptedTicket(feishu('101', '@bot 获取安装包'))
  h.runtime.engine.stopTicket(ticket.id)
  const source = 'uninstalled-qq'
  const message: OutboundMessage = { id: 'legacy-result', channel: { source, thread: 'qq:private', address: {} }, ticketId: ticket.id,
    text: '遗留结果', kind: 'reply' }
  h.runtime.store.receipts.add(message)
  h.runtime.effects.enqueue('reply', message.id, {})
  await h.runtime.sendReplies()
  expect(h.runtime.store.receipts.get(message.id)).toMatchObject({ status: 'dropped', dropped: { reason: 'deliveryRevoked' } })
  expect(h.runtime.effects.pending('reply', message.id)).toBe(false)
  const sent: string[] = []
  h.runtime.sources.register({ kind: source, title: { zh: '探针', en: 'Probe' }, description: { zh: '', en: '' }, health: [],
    schema: z.object({}).strict(), fields: [], channel: { send: async (_host, item) => { sent.push(item.id); return 'sent' },
      link: () => ({ url: '', label: { zh: '探针', en: 'Probe' } }) } })
  h.runtime.outbox.send({ ...message, id: 'new-status', purpose: 'status', delivery: 'interactive', text: '发送已停止。' })
  await h.runtime.sendReplies()
  expect(sent).toEqual(['new-status'])
})

it('holds every message while processing is paused, and sends it once processing resumes', async () => {
  const lark = vi.mocked(Commands.prototype.lark)
  await h.runtime.settings.pause(true, 'panel')
  lark.mockClear()
  h.runtime.outbox.send({ id: 'held', channel: feishu('1', 'x').channel!, text: '已合并。', kind: 'notice' })
  await h.runtime.sendReplies()
  expect([h.runtime.outbox.status('held'), lark.mock.calls.length]).toEqual(['pending', 0])
  await h.runtime.settings.pause(false, 'panel')
  await h.runtime.pump(); await h.runtime.sendReplies()
  expect(h.runtime.outbox.status('held')).toBe('sent')
  expect(JSON.stringify(lark.mock.calls)).toContain('已合并。')
})

it('keeps a message for a Source that is not installed waiting, and sends it once the Source\'s kind registers', async () => {
  const sent: OutboundMessage[] = []
  const probe: SourceKind<Record<string, never>> = { kind: 'probe', title: { zh: '探针', en: 'Probe' }, description: { zh: '', en: '' }, health: [],
    schema: z.object({}).strict(), fields: [],
    channel: { send: async (_host, message) => { sent.push(message); return 'sent' }, link: () => ({ url: '', label: { zh: '探针', en: 'Probe' } }) } }
  h.runtime.outbox.send({ id: 'waiting', channel: { source: 'probe', thread: 'probe:1', address: {} }, text: 'Done', kind: 'reply' })
  await h.runtime.sendReplies()
  expect([h.runtime.outbox.status('waiting'), h.runtime.health.reply?.state]).toEqual(['pending', 'ready'])
  h.runtime.sources.register(probe)
  // A message whose Source was not installed is tried again after 5 seconds.
  await at(5000)
  expect([h.runtime.outbox.status('waiting'), sent.map(message => message.id)]).toEqual(['sent', ['waiting']])
})

it('lets an interactive status in the same conversation pass a slow normal delivery, while preserving normal lane order', async () => {
  const hold = deferred<void>()
  const sent: string[] = []
  const probe: SourceKind<Record<string, never>> = { kind: 'probe', title: { zh: '探针', en: 'Probe' }, description: { zh: '', en: '' }, health: [],
    schema: z.object({}).strict(), fields: [],
    channel: { send: async (_host, message) => { sent.push(message.id); if (message.id.startsWith('normal-') || message.id.startsWith('slow-')) await hold.promise; return 'sent' },
      link: () => ({ url: '', label: { zh: '探针', en: 'Probe' } }) } }
  h.runtime.sources.register(probe)
  const channel = { source: 'probe', thread: 'probe:shared', address: {} }
  h.runtime.outbox.send({ id: 'normal-1', channel, text: 'attachment', kind: 'reply', ticketId: 'ticket' })
  h.runtime.outbox.send({ id: 'normal-2', channel, text: 'next result', kind: 'reply', ticketId: 'ticket' })
  for (const id of ['slow-2', 'slow-3']) h.runtime.outbox.send({ id, channel: { ...channel, thread: `probe:${id}` }, text: 'slow attachment', kind: 'reply' })
  await vi.waitFor(() => expect(sent).toContain('normal-1'))
  await vi.waitFor(() => expect(sent).toEqual(expect.arrayContaining(['slow-2', 'slow-3'])))
  expect(sent).toHaveLength(3)
  // Four normal messages are already queued when the status arrives; the reserved slot starts it immediately.
  h.runtime.outbox.send({ id: 'status', channel, text: 'current status', kind: 'reply', ticketId: 'ticket', delivery: 'interactive' })
  await vi.waitFor(() => expect(sent).toContain('status'))
  expect(sent).not.toContain('normal-2')
  expect([h.runtime.outbox.status('normal-1'), h.runtime.outbox.status('normal-2'), h.runtime.outbox.status('status')]).toEqual(['pending', 'pending', 'sent'])
  hold.resolve()
  await h.runtime.sendReplies()
  expect(sent.indexOf('normal-1')).toBeLessThan(sent.indexOf('normal-2'))
  expect(h.runtime.outbox.status('normal-2')).toBe('sent')
})

it('starts a second ready interactive lane before refilling a slot released by a normal send', async () => {
  const started: string[] = []
  const holds = new Map(['interactive-1', 'normal-1', 'normal-2', 'normal-3', 'normal-4']
    .map(id => [id, deferred<void>()] as const))
  const probe: SourceKind<Record<string, never>> = { kind: 'probe', title: { zh: '探针', en: 'Probe' }, description: { zh: '', en: '' }, health: [],
    schema: z.object({}).strict(), fields: [],
    channel: { send: async (_host, message) => {
      started.push(message.id)
      await holds.get(message.id)?.promise
      return 'sent'
    }, link: () => ({ url: '', label: { zh: '探针', en: 'Probe' } }) } }
  h.runtime.sources.register(probe)
  const channel = (id: string) => ({ source: 'probe', thread: `probe:${id}`, address: {} })
  h.runtime.outbox.send({ id: 'interactive-1', channel: channel('interactive-1'), text: 'status one', kind: 'reply', delivery: 'interactive' })
  for (const id of ['normal-1', 'normal-2', 'normal-3']) h.runtime.outbox.send({ id, channel: channel(id), text: 'slow result', kind: 'reply' })
  await vi.waitFor(() => expect(started).toEqual(expect.arrayContaining(['interactive-1', 'normal-1', 'normal-2', 'normal-3'])))
  expect(started).toHaveLength(4)

  h.runtime.outbox.send({ id: 'normal-4', channel: channel('normal-4'), text: 'next result', kind: 'reply' })
  h.runtime.outbox.send({ id: 'interactive-2', channel: channel('interactive-2'), text: 'status two', kind: 'reply', delivery: 'interactive' })
  holds.get('normal-1')!.resolve()
  await vi.waitFor(() => expect(started).toContain('interactive-2'))
  await vi.waitFor(() => expect(started).toContain('normal-4'))
  expect(started.indexOf('interactive-2')).toBeLessThan(started.indexOf('normal-4'))

  for (const id of ['interactive-1', 'normal-2', 'normal-3', 'normal-4']) holds.get(id)!.resolve()
  await h.runtime.sendReplies()
  expect(h.runtime.outbox.status('interactive-2')).toBe('sent')
})

it('lets a different ticket in the same conversation send while another ticket has a slow attachment', async () => {
  const hold = deferred<void>()
  const sent: string[] = []
  const probe: SourceKind<Record<string, never>> = { kind: 'probe', title: { zh: '探针', en: 'Probe' }, description: { zh: '', en: '' }, health: [],
    schema: z.object({}).strict(), fields: [],
    channel: { send: async (_host, message) => { sent.push(message.id); if (message.id === 'ticket-a-attachment') await hold.promise; return 'sent' },
      link: () => ({ url: '', label: { zh: '探针', en: 'Probe' } }) } }
  h.runtime.sources.register(probe)
  const channel = { source: 'probe', thread: 'probe:shared-qq-chat', address: {} }
  h.runtime.outbox.send({ id: 'ticket-a-attachment', channel, text: 'large artifact', kind: 'reply', ticketId: 'ticket-a' })
  h.runtime.outbox.send({ id: 'ticket-b-result', channel, text: 'other task is done', kind: 'reply', ticketId: 'ticket-b' })
  await vi.waitFor(() => expect(sent).toEqual(expect.arrayContaining(['ticket-a-attachment', 'ticket-b-result'])))
  expect([h.runtime.outbox.status('ticket-a-attachment'), h.runtime.outbox.status('ticket-b-result')]).toEqual(['pending', 'sent'])
  hold.resolve()
  await h.runtime.sendReplies()
  expect(h.runtime.outbox.status('ticket-a-attachment')).toBe('sent')
})

it('lets a worker acknowledge its own request without waiting for an unrelated slow upload', async () => {
  const { sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const hold = deferred<void>()
  const started: string[] = []
  const probe: SourceKind<Record<string, never>> = { kind: 'probe', title: { zh: '探针', en: 'Probe' }, description: { zh: '', en: '' }, health: [],
    schema: z.object({}).strict(), fields: [], channel: { send: async (_host, message) => {
      started.push(message.id); await hold.promise; return 'sent'
    }, link: () => ({ url: '', label: { zh: '探针', en: 'Probe' } }) } }
  h.runtime.sources.register(probe)
  try {
    h.runtime.outbox.send({ id: 'unrelated-upload', channel: { source: 'probe', thread: 'probe:other', address: {} }, text: 'slow artifact', kind: 'reply' })
    await vi.waitFor(() => expect(started).toContain('unrelated-upload'))
    const message = feishu('2', '补充要求', { root_id: 'om_1', mentions: [] })
    h.runtime.receive(message)
    let result: Record<string, unknown> | undefined
    const acknowledged = h.runTool(sessionId, 'orchestrator_ack', { trigger_id: message.id, text: '收到，也处理补充要求。' }).then(value => { result = value })
    await vi.waitFor(() => expect(result).toMatchObject({ acknowledgement: 'sent' }))
    expect(h.runtime.outbox.status('unrelated-upload')).toBe('pending')
    await acknowledged
  } finally { hold.resolve(); await h.runtime.sendReplies() }
})
