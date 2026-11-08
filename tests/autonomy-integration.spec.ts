/** Runtime-level checks for the new supervision, result, routing and memory connections. */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { completionKey, latestAssignment } from '../src/core/index.ts'
import { QqBridge, QqConfigSchema } from '../src/app/qq-source.ts'
import { webSource } from '../src/app/web-tasks.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let host: Host | undefined
const releases: (() => void)[] = [], bridges: QqBridge[] = []
afterEach(async () => {
  for (const release of releases.splice(0)) release()
  for (const bridge of bridges.splice(0)) await bridge.stop()
  await host?.stop(); host = undefined
})
interface ReviewInput {
  acceptance: { criteria: { id: string }[] }
  evidence: { ref: string; kind: string; text: string; coverage: string }[]
}
function reviewer(h: Host, state: 'passed' | 'needs_changes' = 'passed') {
  const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<ReviewInput>()
  releases.push(() => gate.resolve())
  const calls: ReviewInput[] = []
  const stream = vi.fn((request: { messages: { content: { type: string; text?: string }[] }[] }) => (async function* () {
    const input = JSON.parse(request.messages[0]!.content.find(item => item.type === 'text')!.text!) as ReviewInput
    calls.push(input); entered.resolve(input); await gate.promise
    const artifact = input.evidence.find(item => item.kind === 'artifact' && item.coverage === 'complete')
    const text = JSON.stringify({ state, summary: state === 'passed' ? 'Observed JSON contains total 2.' : 'Observed result needs a correction.',
      checks: input.acceptance.criteria.map(criterion => ({ criterionId: criterion.id, state, summary: 'Read actual artifact bytes.', evidenceRefs: [artifact!.ref] })) })
    yield { type: 'text-delta', text }; yield { type: 'finish', reason: { kind: 'stop' } }
  })())
  Object.assign(h.ctx.llm, { stream })
  return { gate, entered: entered.promise, calls, stream }
}
async function reportJson(h: Host, task: Awaited<ReturnType<Host['acceptedTicket']>>, text = '{"total":2}') {
  mkdirSync(task.ticket.execution!.directory, { recursive: true })
  const path = join(task.ticket.execution!.directory, 'result.json'); writeFileSync(path, text)
  return await h.runTool(task.sessionId, 'orchestrator_report', { state: 'ready', summary: 'Generated result.json.', artifacts: [{ path, name: 'result.json' }] })
}
const mainDeliveries = (h: Host) => h.deliveries.mock.calls.filter(([call]) => call.sessionId === h.runtime.masterId).length

it('runs enforce verification through Runtime, reads actual snapshots, and permits result delivery after the bound verdict', async () => {
  host = await startRuntime(); const h = host
  vi.spyOn(h.runtime.sources, 'send').mockResolvedValue('sent')
  expect((await h.api('PUT', 'verification/config', { mode: 'enforce', maxRepairs: 0 })).status).toBe(200)
  const review = reviewer(h), task = await h.acceptedTicket(feishu('101', '生成 JSON 文件，total 必须是 2。'))
  expect(h.runtime.store.tickets.get(task.ticket.id)?.acceptance?.mode).toBe('enforce')
  await reportJson(h, task)
  const input = await review.entered
  expect(input.evidence.some(item => item.kind === 'artifact' && item.text.includes('total') && item.text.includes('2'))).toBe(true)
  expect(h.runtime.store.tickets.get(task.ticket.id)?.verification?.state).toBe('running')
  expect(() => h.runtime.engine.reply({ purpose: 'result', ticketId: task.ticket.id, text: '已完成' })).toThrow()
  review.gate.resolve(); await h.runtime.idle()
  const current = h.runtime.store.tickets.get(task.ticket.id)!
  expect(current.verification?.state).toBe('passed')
  expect(current.verification?.reportKey).toBe(completionKey(current))
  expect(current.ended?.outcome).toBe('completed')
  const result = await h.runTool(h.runtime.masterId, 'orchestrator_reply', { purpose: 'result', ticket_id: current.id, text: 'JSON 文件已核验。' })
  await h.runtime.sendReplies()
  expect(h.runtime.store.replyStatus(String(result.receipt_id))).toBe('sent')
  expect((await h.api('GET', `tickets/${current.id}/verification`)).body).toMatchObject({ verification: { state: 'passed' } })
})

it.each(['report-change', 'human-supplement', 'human-stop'] as const)('revokes an already queued enforce result before sending after %s', async change => {
  host = await startRuntime(); const h = host
  const sent = vi.spyOn(h.runtime.sources, 'send').mockResolvedValue('sent')
  h.runtime.verification.config({ mode: 'enforce', maxRepairs: 0 })
  const review = reviewer(h), task = await h.acceptedTicket(feishu('111', '生成 total 为 2 的 JSON 文件，等待合并。'))
  // Keep the approved Worker live while the PR is open, so each mutation uses its normal running-task command.
  h.runtime.engine.bindThread(task.ticket.id, { source: 'github', id: '411' }, true)
  await reportJson(h, task); await review.entered
  review.gate.resolve(); await h.runtime.idle()
  const approved = h.runtime.store.tickets.get(task.ticket.id)!
  expect(approved.verification?.state).toBe('passed')
  expect(approved.ended).toBeUndefined()
  await h.runtime.settings.pause(true, 'panel')
  sent.mockClear()
  const result = await h.runTool(h.runtime.masterId, 'orchestrator_reply', { purpose: 'result', ticket_id: task.ticket.id, text: '旧结果等待发送。' })
  const id = String(result.receipt_id), proof = completionKey(approved)
  expect(h.runtime.store.receipts.get(id)).toMatchObject({ status: 'pending', completionKey: proof })
  expect(sent.mock.calls.some(([message]) => message.id === id)).toBe(false)
  if (change === 'report-change') {
    await h.runTool(task.sessionId, 'orchestrator_report', { state: 'progress', summary: 'Reviewing a newly discovered defect before delivery.' })
  } else if (change === 'human-supplement') {
    const followup = feishu('112', '更正：最终结果改为 total 3。', { mentions: [], root_id: 'om_111' })
    h.runtime.receive(followup)
    expect(h.runtime.store.tickets.get(task.ticket.id)?.inputs).toContainEqual(expect.objectContaining({ kind: 'trigger', triggerId: followup.id }))
    expect(h.runtime.store.tickets.get(task.ticket.id)?.acceptance?.revision).toBeGreaterThan(approved.acceptance!.revision)
  } else {
    expect((await h.api('POST', `tickets/${task.ticket.id}/stop`))).toMatchObject({ status: 200, body: { stopped: true } })
    expect(h.runtime.store.tickets.get(task.ticket.id)?.ended).toMatchObject({ by: 'human', outcome: 'stopped' })
  }
  if (change !== 'human-stop') expect(completionKey(h.runtime.store.tickets.get(task.ticket.id)!)).not.toBe(proof)
  expect(h.runtime.store.replyStatus(id)).toBe(change === 'human-stop' ? 'dropped' : 'pending')
  await h.runtime.settings.pause(false, 'panel')
  await h.runtime.pump(); await h.runtime.idle(); await h.runtime.sendReplies()
  expect(h.runtime.store.receipts.get(id)).toMatchObject({ completionKey: proof, status: 'dropped', dropped: { reason: 'deliveryRevoked' } })
  expect(sent.mock.calls.some(([message]) => message.id === id)).toBe(false)
})

it('keeps observe delivery and avoids a second Router wake after the independent review', async () => {
  host = await startRuntime(); const h = host
  h.runtime.verification.config({ mode: 'observe', maxRepairs: 0 })
  const review = reviewer(h, 'needs_changes'), task = await h.acceptedTicket(feishu('102', '生成 total 为 2 的 JSON 文件。'))
  await reportJson(h, task, '{"total":3}'); await review.entered
  expect(h.runtime.store.tickets.get(task.ticket.id)?.ended?.outcome).toBe('completed')
  const afterReady = mainDeliveries(h)
  review.gate.resolve(); await h.runtime.idle()
  expect(mainDeliveries(h)).toBe(afterReady)
  expect(h.runtime.verification.view(task.ticket.id).verification?.state).toBe('needs_changes')
  expect(h.runtime.store.tickets.get(task.ticket.id)?.inputs.filter(input => input.kind === 'note' && input.text.includes('acceptance review'))).toHaveLength(0)
})

it('invalidates an in-flight passing review after a new human input and enforces acceptance CAS', async () => {
  host = await startRuntime(); const h = host
  h.runtime.verification.config({ mode: 'enforce', maxRepairs: 0 })
  const review = reviewer(h), task = await h.acceptedTicket(feishu('103', '生成 total 为 2 的 JSON 文件。'))
  await reportJson(h, task); await review.entered
  const oldKey = h.runtime.store.tickets.get(task.ticket.id)!.verification!.reportKey
  const followup = feishu('104', '修正：total 现在应为 3。', { mentions: [], root_id: 'om_103' })
  h.runtime.receive(followup)
  await h.runTool(task.sessionId, 'orchestrator_report', { state: 'progress', summary: 'Applying the new total.' })
  const revision = h.runtime.store.tickets.get(task.ticket.id)!.acceptance!.revision
  expect(revision).toBeGreaterThan(1)
  h.runtime.verification.setCriteria(task.ticket.id, revision, [{ id: 'updated-total', kind: 'content', description: 'total 必须为 3。', sourceRefs: [`trigger/${followup.id}`] }])
  expect(() => h.runtime.verification.setCriteria(task.ticket.id, 1, [{ id: 'stale', kind: 'content', description: '旧修改', sourceRefs: [`trigger/${task.trigger.id}`] }])).toThrow('revision conflict')
  review.gate.resolve(); await h.runtime.idle()
  const current = h.runtime.store.tickets.get(task.ticket.id)!
  expect(current.ended).toBeUndefined()
  expect(current.verification?.state).not.toBe('passed')
  expect(completionKey(current)).not.toBe(oldKey)
  expect(() => h.runtime.engine.reply({ purpose: 'result', ticketId: current.id, text: '完成' })).toThrow()
  expect(h.runtime.verification.history(current.id)).toContainEqual(expect.objectContaining({ reportKey: oldKey, state: 'passed' }))
})

it('runs QQ launch reservations and actual usage events through Runtime into a recoverable budget hold', async () => {
  host = await startRuntime(); const h = host, store = h.runtime.store
  const settings = store.settings()
  settings.sources.qq = { enabled: true, config: QqConfigSchema.parse({ groups: [{ id: '23456', listen: 'observe' }], observation: { maxActiveTasks: 1, maxTokensPerDay: 100 } }) }
  settings.policy.sources.qq = { allowed: [{ id: '12345' }], admission: {} }
  settings.policy.rules.push({ id: 'fixture-observation', name: 'Fixture observation', enabled: true, instruction: 'Reproduce this explicitly allowed fixture issue in the task directory silently.' })
  store.saveSettings(settings)
  const bridge = h.runtime.qq = new QqBridge({ store, stateDir: h.directory, configured: () => true, receive: trigger => h.runtime.receive(trigger),
    report: () => {}, resolveToken: async () => undefined, writeToken: async () => {} })
  bridges.push(bridge); const unregister = h.runtime.sources.register(bridge.kind)
  const received = (id: number) => ({ post_type: 'message', message_type: 'group', self_id: 98765, user_id: 12345, group_id: 23456,
    message_id: id, time: Math.floor(Date.now() / 1000), message: [{ type: 'text', data: { text: `独立复现问题 ${id}` } }], sender: { nickname: 'Owner' } })
  const accept = async (id: number) => {
    bridge.ingest(received(id)); await h.runtime.idle()
    const trigger = store.read.recentTriggers(0, 50).find(value => value.source === 'qq' && value.meta.messageId === String(id))!
    const decision = h.runtime.engine.decide(trigger.id, { kind: 'accept', title: `观察 ${id}`, name: `observe-${id}`, scope: 'Reproduce this fixture.', reason: 'Fixture policy', rules: ['fixture-observation'] })
    h.runtime.passes.request(); await h.runtime.idle()
    return store.tickets.get(decision.ticketId!)!
  }
  try {
    const first = await accept(1001), second = await accept(1002)
    expect(latestAssignment(store.tickets.get(first.id)!)?.state).toBe('running')
    expect(latestAssignment(store.tickets.get(second.id)!)?.state).toBe('pending')
    expect(latestAssignment(store.tickets.get(second.id)!)?.report?.state).not.toBe('failed')
    const worker = h.agents.get(`worker-${first.id}`)! as unknown as { session: { id: string } }
    const event = { seq: 9001, time: Date.now(), type: 'assistant/message', data: { role: 'assistant', content: [], usage: { inputTokens: 60, outputTokens: 50 } } }
    h.ctx.emit('session/event', worker.session as never, event as never)
    h.ctx.emit('session/event', worker.session as never, event as never)
    await h.runtime.pump(); await h.runtime.idle()
    expect(bridge.observations.summary('23456')).toMatchObject({ tokens: 110, calls: 1, unknown: false })
    expect(store.tickets.get(first.id)).toMatchObject({ hold: { kind: 'budget' }, mandate: first.mandate })
    expect(store.tickets.get(first.id)?.ended).toBeUndefined()
    const audit = await h.api('GET', 'qq/observations')
    expect(audit.status).toBe(200)
    expect(audit.body.items).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'hold', ticketId: first.id })]))
  } finally { unregister() }
})

it('serves structured HTTP status, supplement and stop with no semantic Router candidate and rejects revoked owner access', async () => {
  host = await startRuntime(); const h = host, store = h.runtime.store
  h.runtime.machine.mode = 'personal'
  h.runtime.sources.register(webSource(store, () => h.runtime.machine.mode === 'personal', h.runtime.artifacts))
  const settings = store.settings(); settings.sources.web = { enabled: true, config: {} }; settings.policy.sources.web = { allowed: [{ id: 'owner' }], admission: {} }; store.saveSettings(settings)
  const created = await h.api('POST', 'web/tasks', { text: '生成本地报告', requestId: 'http_task_origin' })
  expect(created.status).toBe(200)
  const task = created.body as unknown as { id: string; messages: { id: string }[] }
  const routed = await h.route({ kind: 'accept', trigger_id: task.messages[0]!.id, title: '本地报告', worktree_name: 'http-report', acknowledgement: '开始整理。' })
  await h.runtime.idle()
  const ticketId = (routed.ticket as { ticket_id: string }).ticket_id, before = h.candidates().length, beforeMaster = mainDeliveries(h)
  const first = await h.api('POST', `web/tasks/${task.id}/actions`, { kind: 'status', ticketId, requestId: 'http_task_status' })
  expect(first).toMatchObject({ status: 200, body: { snapshot: { ticket_id: ticketId } } })
  await h.runtime.idle()
  expect(h.candidates()).toHaveLength(before)
  expect(mainDeliveries(h)).toBe(beforeMaster)
  const supplement = { kind: 'supplement', ticketId, requestId: 'http_task_supplement', text: '补充中文标题' }
  expect((await h.api('POST', `web/tasks/${task.id}/actions`, supplement)).status).toBe(200)
  expect((await h.api('POST', `web/tasks/${task.id}/actions`, supplement)).status).toBe(200)
  await h.runtime.idle()
  expect(h.candidates()).toHaveLength(before)
  expect(mainDeliveries(h)).toBe(beforeMaster)
  expect((await h.api('POST', `web/tasks/${task.id}/actions`, { kind: 'stop', ticketId, requestId: 'http_task_stop' })).status).toBe(200)
  await h.runtime.idle()
  expect(h.candidates(), JSON.stringify(h.candidates())).toHaveLength(before)
  expect(mainDeliveries(h)).toBe(beforeMaster)
  expect(store.tickets.get(ticketId)?.inputs.filter(input => input.kind === 'trigger' && input.triggerId.startsWith('web-action-'))).toHaveLength(1)
  expect(store.tickets.get(ticketId)?.ended).toMatchObject({ by: 'human', outcome: 'stopped' })
  const revoked = store.settings(); revoked.policy.sources.web!.allowed = []; store.saveSettings(revoked)
  expect((await h.api('POST', `web/tasks/${task.id}/actions`, { kind: 'status', ticketId, requestId: 'http_task_revoked' })).status).toBe(409)
})

it('delivers a shared-memory correction once to its active Runtime consumer', async () => {
  host = await startRuntime(); const h = host
  const task = await h.acceptedTicket(feishu('105', '请记住会议使用上海时区。然后继续整理会议资料。'))
  const memory = h.runtime.memory
  memory.save({ topic: 'meeting-timezone', title: '会议时区', summary: '会议使用上海时区。', content: 'Asia/Shanghai', expected_revision: 0,
    evidence: 'user', sources: [{ kind: 'trigger', ref: task.trigger.id, quote: '会议使用上海时区。' }] })
  memory.read({ topic: 'meeting-timezone', ticketId: task.ticket.id })
  const correction = feishu('106', '更正：会议改用东京时区。'); h.runtime.receive(correction)
  memory.save({ topic: 'meeting-timezone', title: '会议时区', summary: '会议改用东京时区。', content: 'Asia/Tokyo', expected_revision: 1,
    evidence: 'user', sources: [{ kind: 'trigger', ref: correction.id, quote: '会议改用东京时区。' }], correction_reason: '原用户明确更正。' })
  await h.runtime.pump(); await h.runtime.idle()
  await vi.waitFor(() => expect(memory.corrections(task.ticket.id)).toContainEqual(expect.objectContaining({ status: 'delivered' })))
  await h.runtime.pump(); await h.runtime.pump(); await h.runtime.idle()
  const notes = h.runtime.store.tickets.get(task.ticket.id)!.inputs.filter(input => input.kind === 'note' && input.text.includes('Shared memory meeting-timezone'))
  expect(notes).toHaveLength(1)
  expect(h.deliveries.mock.calls.filter(([call]) => call.sessionId === task.sessionId && call.text.includes('Shared memory meeting-timezone'))).toHaveLength(1)
})

it('refuses execution immediately after authority revocation, holds the task and resumes with a new assignment after restoration', async () => {
  host = await startRuntime(); const h = host
  const task = await h.acceptedTicket(feishu('107', '修复允许范围内的回归。'))
  const mandate = structuredClone(task.ticket.mandate)
  const worker = h.agents.get(task.sessionId)! as unknown as { ctx: { tools: { guard: ReturnType<typeof vi.fn> } } }
  const guard = worker.ctx.tools.guard.mock.calls.at(-1)![0] as (execution: { name: string; arguments: unknown }) => unknown
  expect(guard({ name: 'pwsh', arguments: {} })).toBeUndefined()
  const original = h.runtime.store.settings(), revoked = h.runtime.store.settings()
  revoked.policy.sources.feishu!.allowed = []; h.runtime.store.saveSettings(revoked)
  expect(h.runtime.store.tickets.get(task.ticket.id)?.mandate).toStrictEqual(mandate)
  expect(guard({ name: 'pwsh', arguments: {} })).toBeTruthy()
  expect(guard({ name: 'read', arguments: {} })).toBeTruthy()
  await h.runtime.pump(); await h.runtime.idle()
  const held = h.runtime.store.tickets.get(task.ticket.id)!
  expect(held.hold?.kind).toBe('operator')
  expect(held.mandate).toStrictEqual(mandate)
  expect(held.ended).toBeUndefined()
  expect((await h.api('POST', `tickets/${task.ticket.id}/resume`)).status).not.toBe(200)
  expect(h.runtime.store.tickets.get(task.ticket.id)?.mandate).toStrictEqual(mandate)
  h.runtime.store.saveSettings(original)
  expect((await h.api('POST', `tickets/${task.ticket.id}/resume`)).status).toBe(200)
  await h.runtime.idle()
  const resumed = h.runtime.store.tickets.get(task.ticket.id)!
  expect(resumed.hold).toBeUndefined()
  expect(resumed.mandate).toStrictEqual(mandate)
  expect(latestAssignment(resumed)?.id).not.toBe(latestAssignment(task.ticket)?.id)
  expect(latestAssignment(resumed)?.state).toBe('running')
  expect(guard({ name: 'pwsh', arguments: {} })).toBeUndefined()
  expect(() => h.runtime.engine.report(resumed.id, { state: 'ready', summary: 'Late result from the revoked assignment.' }, latestAssignment(task.ticket)!.id)).toThrow()
})
