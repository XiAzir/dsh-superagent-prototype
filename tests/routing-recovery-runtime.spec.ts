/** Runtime/HTTP coverage of internal claims, original-request transfers and missed mixed actions. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { startRuntime, feishu, type Host } from './fixtures/host.ts'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RequestHandoff } from '../src/app/request-handoff.ts'

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { if (h) await h.stop() })
function reviewModel(state: 'needs_work' | 'covered' | 'unknown', actionQuote?: string) {
  const llm = h.ctx.llm as unknown as { stream(options: { messages: { content: { text: string }[] }[] }): AsyncIterable<unknown> }
  llm.stream = async function* (options) {
    const input = JSON.parse(options.messages[0]!.content[0]!.text)
    const answer = input.original ? { state, reason: state === 'needs_work' ? 'The export clause has no execution owner.' : 'The original request is covered.',
      ...actionQuote ? { actionQuote } : {} } : { state: 'unknown', summary: 'This fixture checks routing ownership.', checks: [] }
    yield { type: 'text-delta', index: 0, text: JSON.stringify(answer) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

it('copies real registered report bytes into the receiving Runtime task and retains both artifact snapshots', async () => {
  const target = await h.acceptedTicket(feishu('603', '@bot 维护已有报告'))
  const source = await h.acceptedTicket(feishu('604', '@bot 为已有报告生成数据附件'))
  const sourceDirectory = source.ticket.execution!.directory, targetDirectory = target.ticket.execution!.directory
  mkdirSync(sourceDirectory, { recursive: true }); mkdirSync(targetDirectory, { recursive: true })
  const path = join(sourceDirectory, 'checkpoint.bin'), bytes = Buffer.from([0, 255, 7, 128, 42])
  writeFileSync(path, bytes)
  const artifact = await h.runtime.artifacts.stage(source.ticket.id, sourceDirectory, path)
  h.runtime.engine.report(source.ticket.id, { state: 'progress', summary: 'Saved reusable binary checkpoint.', artifacts: [artifact.id] })
  await h.runTool(source.sessionId, 'orchestrator_request_transfer', { trigger_id: source.trigger.id, to_ticket_id: target.ticket.id,
    expected_revision: h.runtime.engine.requestResponsibility(source.trigger.id)!.revision, request_id: 'copy-checkpoint', reason: 'This data file belongs to the existing report.' })
  await h.runtime.idle()
  const records = h.runtime.store.keys('request-handoff:').map(key => h.runtime.store.get<RequestHandoff>(key)!)
  expect(records).toHaveLength(1)
  const handoff = records[0]!
  expect(handoff.state).toBe('completed')
  const copy = handoff.items[0]!
  expect(copy.artifact).toMatchObject({ ticketId: target.ticket.id, sha256: artifact.sha256, size: bytes.length })
  expect(readFileSync(copy.localPath!)).toEqual(bytes)
  expect(readFileSync((await h.runtime.artifacts.verify(artifact.id, source.ticket.id)).path)).toEqual(bytes)
  expect(readFileSync((await h.runtime.artifacts.verify(copy.artifact!.id, target.ticket.id)).path)).toEqual(bytes)
  const notice = h.runtime.store.tickets.get(target.ticket.id)!.inputs.find(input => input.kind === 'note' && input.text.includes('registered artifacts copied'))!
  expect(notice.kind).toBe('note')
  expect(JSON.parse(('text' in notice ? notice.text : '').split('\n').at(-1)!)).toEqual([
    expect.objectContaining({ artifactId: copy.artifact!.id, sha256: artifact.sha256, path: copy.localPath }),
  ])
  h.runtime.requestHandoff.submit(source.trigger.id); await h.runtime.idle()
  expect(h.runtime.store.keys('request-handoff:')).toHaveLength(1)
})

it('delivers a cross-thread request as a trial and subscribes only after an internal revision-bound claim', async () => {
  const work = await h.acceptedTicket(feishu('501', '@bot 生成报告'))
  const incoming = { ...feishu('502', '@bot 报告采用表格。'), routing: 'router' as const }
  h.runtime.receive(incoming); await h.runtime.idle()
  await h.route({ trigger_id: incoming.id, kind: 'attach', ticket_id: work.ticket.id })
  await h.runtime.idle()
  const request = h.runtime.engine.requestResponsibility(incoming.id)!
  expect(request.state).toBe('proposed')
  expect(h.runtime.store.threads.get(`${incoming.source}:${incoming.threads[0]!.id}`)?.subscriptions).not.toContain(work.ticket.id)
  const delivered = h.deliveries.mock.calls.map(([call]) => call).find(call => call.sessionId === work.sessionId && call.text.includes(incoming.id))!
  expect(delivered.text).toContain('"provisional":true')
  expect(delivered.text).toContain(`trigger/${incoming.id}/request`)
  const claimed = await h.runTool(work.sessionId, 'orchestrator_request_claim', { trigger_id: incoming.id,
    expected_revision: request.revision, reason: 'This clause changes the format of this report.' })
  expect(JSON.stringify(claimed)).toContain('active')
  expect(h.runtime.store.threads.get(`${incoming.source}:${incoming.threads[0]!.id}`)?.subscriptions).toContain(work.ticket.id)
  expect((await h.api('GET', `tickets/${work.ticket.id}/requests`)).body).toMatchObject({ items: expect.arrayContaining([
    expect.objectContaining({ request: expect.objectContaining({ triggerId: incoming.id, state: 'active' }), source: expect.objectContaining({ preview: incoming.text }) }),
  ]) })
})

it('corrects an initially separate continuation to its actual owner while releasing the old acceptance responsibility', async () => {
  const canonical = await h.acceptedTicket(feishu('503', '@bot 生成报告'))
  const wrong = await h.acceptedTicket(feishu('504', '@bot 报告采用表格。'))
  const original = h.runtime.engine.requestResponsibility(wrong.trigger.id)!
  const transfer = { trigger_id: wrong.trigger.id, to_ticket_id: canonical.ticket.id, expected_revision: original.revision,
    request_id: 'canonical-report-once', reason: 'The original clause specifies the report format.' }
  const first = await h.runTool(wrong.sessionId, 'orchestrator_request_transfer', transfer)
  expect(await h.runTool(wrong.sessionId, 'orchestrator_request_transfer', transfer)).toEqual(first)
  const state = h.runtime.engine.requestResponsibility(wrong.trigger.id)!
  expect(state.id).toBe(wrong.trigger.id)
  expect(state.owners.find(owner => owner.ticketId === canonical.ticket.id)?.state).toBe('proposed')
  expect(h.runtime.store.tickets.get(wrong.ticket.id)).toMatchObject({ requestRedirect: { toTicketId: canonical.ticket.id }, ended: { outcome: 'dropped' } })
  expect(h.runtime.store.tickets.get(wrong.ticket.id)?.acceptance?.criteria).toEqual([])
  const refreshed = await h.api('GET', `tickets/${wrong.ticket.id}/requests`)
  expect(JSON.stringify(refreshed.body)).toContain('transferred')
  expect(JSON.stringify(refreshed.body)).toContain(canonical.ticket.id)
  const rejected = await h.api('PUT', `tickets/${wrong.ticket.id}/acceptance`, { expectedRevision: 2,
    criteria: [{ id: 'returned', description: 'Old owner should do it again', kind: 'content', sourceRefs: [`trigger/${wrong.trigger.id}`] }] })
  expect(rejected.status).toBe(400)
  expect(h.runtime.store.triggers.get(wrong.trigger.id)?.text).toBe(wrong.trigger.text)
})

it('answers saved status then independently recovers the original mixed message action without user intervention', async () => {
  reviewModel('needs_work', '生成 export.csv')
  const work = await h.acceptedTicket(feishu('505', '@bot 整理已有数据'))
  const incoming = { ...feishu('506', '@bot 查看进度，并生成 export.csv。', { root_id: 'om_505' }), routing: 'router' as const }
  h.runtime.receive(incoming); await h.runtime.idle()
  await h.route({ trigger_id: incoming.id, kind: 'status', ticket_id: work.ticket.id })
  await h.runtime.pump(); await h.runtime.idle()
  await vi.waitFor(() => expect(h.runtime.engine.requestResponsibility(incoming.id)?.state).toBe('pending'))
  const history = await h.api('GET', `routing-review/history?triggerId=${encodeURIComponent(incoming.id)}`)
  expect(history.body).toMatchObject([expect.objectContaining({ state: 'needs_work', recovery: 'reopened', actionQuote: '生成 export.csv' })])
  expect(h.runtime.store.triggers.get(incoming.id)?.text).toBe(incoming.text)
  expect(h.runtime.engine.candidate(incoming.id)?.triggers.some(trigger => trigger.id === incoming.id)).toBe(true)
  const reviewId = (history.body as unknown as { id: string }[])[0]!.id
  expect(h.runtime.requestReview.get(reviewId)?.requestRevision).toBeLessThan(h.runtime.engine.requestResponsibility(incoming.id)!.revision)
  expect((await h.api('GET', 'routing-review/config')).body).toMatchObject({ mode: 'repair', maxRecoveries: 2 })
})

it('keeps a false-ignore review failure visible and preserves stop controls and original routing state', async () => {
  const work = await h.acceptedTicket(feishu('507', '@bot 保留运行任务'))
  const incoming = { ...feishu('508', '@bot 生成 export.csv。'), routing: 'router' as const }
  h.runtime.receive(incoming); await h.runtime.idle()
  await h.route({ trigger_id: incoming.id, kind: 'ignore', reason: 'Mistakenly classed as chatter.' })
  await h.runtime.idle()
  expect(h.runtime.engine.requestResponsibility(incoming.id)?.state).toBe('ignored')
  const reviews = await h.api('GET', `routing-review/history?triggerId=${encodeURIComponent(incoming.id)}`)
  expect(reviews.body).toMatchObject([expect.objectContaining({ state: 'unknown', recovery: 'none' })])
  expect((await h.api('POST', `tickets/${work.ticket.id}/stop`)).status).toBe(200)
  expect(h.runtime.store.tickets.get(work.ticket.id)?.ended?.by).toBe('human')
  expect((await h.api('PUT', 'routing-review/config', { mode: 'observe', maxRecoveries: 1, maxReviewsPerHour: 10 })).body)
    .toEqual({ mode: 'observe', maxRecoveries: 1, maxReviewsPerHour: 10 })
})
