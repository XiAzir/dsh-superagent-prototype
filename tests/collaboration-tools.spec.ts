/** Collaboration tools, peer visibility, and Router-first resource isolation. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Commands } from '../src/infra/commands.ts'
import { CHAT, feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { await h.stop() })

it('keeps another ticket’s direct message out of trigger, attachment, thread and Feishu source reads', async () => {
  const first = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const second = await h.acceptedTicket(feishu('2', '@bot 独立任务'))
  h.runtime.engine.bindThread(second.ticket.id, { source: 'feishu', id: `${CHAT}:om_1` }, false)
  const direct = { ...feishu('3', '@bot 给第二项的私信', { root_id: 'om_1' }), addressed: 'mention' as const }
  h.runtime.engine.direct(second.ticket.id, direct)
  const readAsFirst = (resource: string) => h.runTool(first.sessionId, 'orchestrator_read', { resource })
  await expect(readAsFirst(`trigger/${direct.id}`)).rejects.toThrow('does not belong to this worker')
  await expect(readAsFirst(`attachment/${direct.id}/file-1`)).rejects.toThrow('does not belong to this worker')
  const thread = await readAsFirst(`thread/feishu:${CHAT}:om_1`) as { items: { trigger_id: string }[] }
  expect(thread.items.map(item => item.trigger_id)).not.toContain(direct.id)
  expect(JSON.stringify(thread)).not.toContain(direct.text)
  expect(thread).not.toHaveProperty('pending')
  expect(thread).not.toHaveProperty('evaluating')

  vi.mocked(Commands.prototype.lark).mockImplementation(async args => args[0] === 'api'
    ? { items: [{ message_id: 'om_1', chat_id: CHAT, thread_id: 'omt_thread' }] }
    : { thread_id: 'omt_thread', has_more: false, messages: [
      { message_id: 'om_1', chat_id: CHAT, content: 'Original request', msg_type: 'text', sender: { id: 'ou_a', sender_type: 'user' }, create_time: '2026-10-01' },
      { message_id: 'om_3', chat_id: CHAT, content: direct.text, msg_type: 'text', sender: { id: 'ou_b', sender_type: 'user' }, create_time: '2026-10-02' },
    ] } as never)
  const sourcePage = await readAsFirst(`feishu/${first.trigger.id}/thread`) as { text: string }
  expect(sourcePage.text).toContain('om_1')
  expect(sourcePage.text).not.toContain('om_3')
  expect(sourcePage.text).not.toContain(direct.text)
})

it('publishes an idempotent peer note, visible to recipients and only those recipients', async () => {
  const sender = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const thread = `feishu:${CHAT}:om_1`
  const peer = await h.acceptedTicket(feishu('2', '@bot 独立任务'))
  h.runtime.engine.bindThread(peer.ticket.id, { source: 'feishu', id: `${CHAT}:om_1` }, false)
  expect(h.runtime.store.threads.get(thread)?.subscriptions).toContain(peer.ticket.id)
  expect(h.runtime.store.tickets.get(peer.ticket.id)?.assignments.at(-1)?.state).not.toBe('ended')
  const publish = (request_id: string, text: string) => h.runTool(sender.sessionId, 'orchestrator_thread_publish', { thread, text, request_id })
  const first = await publish('finding-1', '定位到公共表单的校验缺陷。')
  expect(first).toMatchObject({ published: true, thread, text: '定位到公共表单的校验缺陷。', fromTicketId: sender.ticket.id,
    recipients: [peer.ticket.id] })
  expect(await publish('finding-1', '定位到公共表单的校验缺陷。')).toEqual(first)
  await expect(publish('finding-1', '内容不同')).rejects.toThrow('requestId was reused')
  expect(await h.runTool(peer.sessionId, 'orchestrator_read', { resource: `trigger/${first.id}` }))
    .toMatchObject({ trigger_id: first.id, text: '定位到公共表单的校验缺陷。' })
  await expect(h.runTool(sender.sessionId, 'orchestrator_read', { resource: `trigger/${first.id}` }))
    .rejects.toThrow('does not belong to this worker')
  expect(h.runtime.store.tickets.get(peer.ticket.id)!.inputs).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'note', text: '定位到公共表单的校验缺陷。' }),
  ]))
})

it('delegates an independent sibling through the Router with stable request IDs', async () => {
  const parent = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const args = { ticket_id: parent.ticket.id, thread: `feishu:${CHAT}:om_1`, title: 'parallel input validation check', request_id: 'split-1' }
  const first = await h.runTool(h.runtime.masterId, 'orchestrator_delegate', args) as { ticket: { ticket_id: string; title: string } }
  expect(first.ticket).toMatchObject({ title: args.title })
  const again = await h.runTool(h.runtime.masterId, 'orchestrator_delegate', args) as { ticket: { ticket_id: string } }
  expect(again.ticket.ticket_id).toBe(first.ticket.ticket_id)
  expect(h.runtime.store.tickets.get(first.ticket.ticket_id)?.delegation?.parentTicketId).toBe(parent.ticket.id)
})
