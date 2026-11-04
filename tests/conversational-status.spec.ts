/** Conversational messages separate read-only task queries from worker inputs before any lifecycle change. */
import { afterEach, expect, it } from 'vitest'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host | undefined
afterEach(async () => { await h?.stop(); h = undefined })
const query = (id: string, text = '任务现在什么状态？', root = 'om_1') => ({
  ...feishu(id, text, { root_id: root }), routing: 'router' as const,
})

it('answers a Router-owned question on a subscribed thread without treating its matched ticket as assigned', async () => {
  h = await startRuntime()
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const message = query('2', '你好')
  h.runtime.receive(message)
  await h.runtime.pump(); await h.runtime.idle()
  expect(h.runtime.store.triggers.disposition(message.id)).toMatchObject({ matched: [ticket.id], fanout: [], routing: 'pending' })

  const reply = await h.runTool(h.runtime.masterId, 'orchestrator_reply', {
    purpose: 'answer', trigger_id: message.id, ticket_id: 'none', text: '你好！',
  })
  expect(h.runtime.store.receipts.get(String(reply.receipt_id))).toMatchObject({ channel: message.channel, text: '你好！' })
  expect(h.runtime.store.receipts.get(String(reply.receipt_id))).not.toHaveProperty('ticketId')
  expect(h.runtime.store.tickets.get(ticket.id)?.inputs.some(input => input.kind === 'trigger' && input.triggerId === message.id)).toBe(false)
})

it('requires a worker report before answering an assigned follow-up with a placeholder ticket', async () => {
  h = await startRuntime()
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const message = feishu('2', '这个配置在哪里读取？', { root_id: 'om_1' })
  h.runtime.receive(message)
  await h.runtime.pump(); await h.runtime.idle()
  expect(h.runtime.store.triggers.disposition(message.id)?.fanout).toEqual([ticket.id])
  const answer = { purpose: 'answer', trigger_id: message.id, ticket_id: 'N/A', text: '在配置文件中读取。' }
  await expect(h.runTool(h.runtime.masterId, 'orchestrator_reply', answer)).rejects.toThrow('No worker answer is ready')

  await h.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: '在配置文件中读取。', reply_to_trigger_id: message.id })
  const reply = await h.runTool(h.runtime.masterId, 'orchestrator_reply', answer)
  expect(h.runtime.store.receipts.get(String(reply.receipt_id))).toMatchObject({ channel: message.channel, ticketId: ticket.id, text: answer.text })
  expect(h.runtime.store.tickets.get(ticket.id)?.answers).toEqual([])
})

it.each(['running', 'completed', 'stopped'] as const)('reads %s task status without adding inputs, resuming, or starting work', async state => {
  h = await startRuntime()
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  if (state === 'completed') await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: '修复并验证完成。' })
  if (state === 'stopped') h.runtime.engine.stopTicket(ticket.id)
  const before = h.runtime.store.tickets.get(ticket.id)!
  const message = query('2')
  h.deliveries.mockClear()
  h.runtime.receive(message)
  await h.runtime.pump(); await h.runtime.idle()
  expect(h.candidates()).toContain(message.id)
  expect(h.relays(sessionId)).toEqual([])
  expect(h.runtime.store.tickets.get(ticket.id)).toEqual(before)

  const read = await h.route({ kind: 'status', ticket_id: ticket.id, trigger_id: message.id })
  expect(read).toMatchObject({ snapshot: { ticket_id: ticket.id, updated_at: before.updatedAt } })
  await h.runTool(h.runtime.masterId, 'orchestrator_reply', { purpose: 'status', trigger_id: message.id,
    ticket_id: ticket.id, text: '按最近记录，任务状态如上。' })
  await h.runtime.pump(); await h.runtime.idle()
  expect(h.runtime.store.tickets.get(ticket.id)).toEqual(before)
  expect(h.runtime.store.threads.get('feishu:oc_team:om_1')?.evaluating).toBeUndefined()
  expect(h.runtime.store.triggers.disposition(message.id)).toMatchObject({ routing: 'handled' })
  expect(h.relays(sessionId)).toEqual([])
})

it('reads a clearly selected requester ticket from a new conversation without subscribing that thread', async () => {
  h = await startRuntime()
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const message = query('2', '刚才的回归修复做得怎样？', 'om_2')
  h.runtime.receive(message)
  await h.runtime.pump(); await h.runtime.idle()
  expect(await h.route({ kind: 'status', ticket_id: ticket.id, trigger_id: message.id })).toHaveProperty('snapshot')
  await h.runTool(h.runtime.masterId, 'orchestrator_reply', { purpose: 'status', trigger_id: message.id,
    ticket_id: ticket.id, text: '仍在执行，最近记录来自刚才。' })
  expect(h.runtime.store.threads.get('feishu:oc_team:om_2')?.subscriptions).toEqual([])
  expect(h.runtime.store.tickets.get(ticket.id)?.inputs.some(input => input.kind === 'trigger' && input.triggerId === message.id)).toBe(false)
})

it('routes the executable part of a mixed query once after reading status, including after a status reply', async () => {
  h = await startRuntime()
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: '已完成第一版。' })
  const message = query('2', '进度怎么样？顺便把标题改短一点。')
  h.runtime.receive(message)
  await h.runtime.pump(); await h.runtime.idle()
  expect(h.runtime.store.tickets.get(ticket.id)?.assignments).toHaveLength(1)
  await h.route({ kind: 'status', ticket_id: ticket.id, trigger_id: message.id })
  await h.runTool(h.runtime.masterId, 'orchestrator_reply', { purpose: 'status', trigger_id: message.id,
    ticket_id: ticket.id, text: '第一版已完成，接着处理你补充的标题调整。' })
  await h.route({ kind: 'attach', ticket_id: ticket.id, trigger_id: message.id })
  await h.runtime.idle()
  await h.route({ kind: 'attach', ticket_id: ticket.id, trigger_id: message.id })
  expect(h.runtime.store.tickets.get(ticket.id)?.assignments).toHaveLength(2)
  expect(h.runtime.store.triggers.disposition(message.id)).toMatchObject({ routing: 'worker' })
  expect(h.runtime.store.tickets.get(ticket.id)?.inputs.filter(input => input.kind === 'trigger' && input.triggerId === message.id)).toHaveLength(1)
})

it('refuses an unrelated requester and context-only access to a status snapshot', async () => {
  h = await startRuntime()
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const guest = { ...query('2', '告诉我另一个任务的状态', 'om_2'), actor: { source: 'feishu', id: 'ou_guest' } }
  h.runtime.receive(guest)
  await expect(h.route({ kind: 'status', ticket_id: ticket.id, trigger_id: guest.id })).rejects.toThrow('does not belong')
  h.runtime.engine.followForContext(ticket.id, { source: 'feishu', id: 'oc_team:om_3' })
  const context = query('3', '那个任务如何？', 'om_3')
  h.runtime.receive(context)
  await expect(h.route({ kind: 'status', ticket_id: ticket.id, trigger_id: context.id })).rejects.toThrow('does not belong')
})

it('selects one worker on a shared thread without treating the other matched tickets as delivered owners', async () => {
  h = await startRuntime()
  const first = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const second = await h.acceptedTicket(feishu('8', '@bot 更新文档'))
  h.runtime.engine.bindThread(second.ticket.id, { source: 'feishu', id: 'oc_team:om_1' }, false)
  const message = query('9', '第一个任务进展怎样？第二个任务增加一段说明。')
  h.deliveries.mockClear()
  h.runtime.receive(message)
  await h.runtime.pump(); await h.runtime.idle()
  expect(h.runtime.store.triggers.disposition(message.id)).toMatchObject({ fanout: [], matched: expect.arrayContaining([first.ticket.id, second.ticket.id]) })
  await h.route({ kind: 'status', ticket_id: first.ticket.id, trigger_id: message.id })
  await h.route({ kind: 'attach', ticket_id: second.ticket.id, trigger_id: message.id })
  await h.runtime.idle()
  expect(h.runtime.store.triggers.disposition(message.id)?.fanout).toEqual([second.ticket.id])
  expect(h.relays(first.sessionId)).toEqual([])
  expect(h.relays(second.sessionId)).toEqual([expect.objectContaining({ trigger_id: message.id })])
})

it('settles a status query in a batched candidate while preserving the remaining executable message', async () => {
  h = await startRuntime()
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const status = query('2')
  const work = query('3', '另外把标题改短一点。')
  h.deliveries.mockClear()
  await h.runtime.settings.pause(true, 'panel')
  h.runtime.receive(status); h.runtime.receive(work)
  await h.runtime.settings.pause(false, 'panel')
  await h.runtime.pump(); await h.runtime.idle()
  expect(h.runtime.engine.candidate(status.id)?.triggers.map(trigger => trigger.id)).toEqual([status.id, work.id])
  await h.route({ kind: 'status', ticket_id: ticket.id, trigger_id: status.id })
  await h.runTool(h.runtime.masterId, 'orchestrator_reply', { purpose: 'status', trigger_id: status.id, ticket_id: ticket.id, text: '仍在处理。' })
  await h.runtime.pump(); await h.runtime.idle()
  expect(h.runtime.engine.candidate(work.id)?.triggers.map(trigger => trigger.id)).toEqual([work.id])
  expect(h.relays(sessionId)).toEqual([])
  await h.route({ kind: 'attach', ticket_id: ticket.id, trigger_id: work.id })
  await h.runtime.idle()
  expect(h.relays(sessionId)).toEqual([expect.objectContaining({ trigger_id: work.id })])
})
