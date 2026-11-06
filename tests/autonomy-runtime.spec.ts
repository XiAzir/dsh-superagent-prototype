/** Real Runtime/SQLite/HTTP integration for the autonomy control plane and a local environment daemon. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { startRuntime, feishu, type Host } from './fixtures/host.ts'
import { startEnvironmentDaemon, type RunningEnvironmentDaemon } from '../src/remote/daemon.ts'
import { commandPayload, payloadHash } from '../src/remote/protocol.ts'
import type { RemoteIntent } from '../src/remote/client.ts'

const TOKEN_REF = 'SUPERAGENT_AUTONOMY_TEST_DEVICE'
const TOKEN = 'autonomy-integration-device-token-0123456789abcdef'
let h: Host
const daemons: RunningEnvironmentDaemon[] = []
beforeEach(async () => { vi.stubEnv(TOKEN_REF, TOKEN); h = await startRuntime() })
afterEach(async () => {
  for (const daemon of daemons.splice(0).reverse()) await daemon.close()
  if (h) await h.stop()
  vi.unstubAllEnvs()
})
const encodedCommand = (script: string) => `node -e "eval(Buffer.from('${Buffer.from(script).toString('base64')}','base64').toString())"`
async function registerDevice(maxCommands?: number) {
  const daemon = await startEnvironmentDaemon({ root: join(h.directory, 'remote-work'), stateDir: join(h.directory, 'remote-state'), token: TOKEN, maxCommands })
  daemons.push(daemon)
  const registration = await h.api('POST', 'environments', { id: 'laptop', label: 'Test laptop', url: daemon.url, credentialRef: TOKEN_REF })
  expect(registration).toEqual({ status: 200, body: { registered: true } })
  return daemon
}
async function daemonRequest(daemon: RunningEnvironmentDaemon, path: string) {
  const response = await fetch(`${daemon.url}${path}`, { headers: { authorization: `Bearer ${TOKEN}` }, signal: AbortSignal.timeout(5000) })
  return { status: response.status, body: await response.json() as Record<string, unknown> }
}
async function completed(ticketId: string, commandId: string) {
  let result = await h.runtime.remote.status(ticketId, commandId)
  await vi.waitFor(async () => {
    result = await h.runtime.remote.status(ticketId, commandId)
    expect(['accepted', 'running', 'queued', 'waiting_environment']).not.toContain(result.state)
  }, { timeout: 12_000, interval: 40 })
  return result
}

it('exposes the new HTTP endpoints, captures verification policy only on future tickets and keeps baseline semantic status explicit', async () => {
  const first = await h.acceptedTicket(feishu('101', '@bot 修复第一个问题'))
  expect((await h.api('GET', 'verification/config')).body).toMatchObject({ mode: 'observe', maxRepairs: 2 })
  expect((await h.api('PUT', 'verification/config', { mode: 'enforce', maxRepairs: 1 })).status).toBe(200)
  const second = await h.acceptedTicket(feishu('102', '@bot 修复第二个问题'))
  expect(h.runtime.store.tickets.get(first.ticket.id)?.acceptance?.mode).toBe('observe')
  expect(h.runtime.store.tickets.get(second.ticket.id)?.acceptance?.mode).toBe('enforce')
  expect((await h.api('GET', `tickets/${second.ticket.id}/verification`)).body).toMatchObject({ acceptance: { mode: 'enforce' }, verification: null, history: [] })
  expect((await h.api('GET', 'watchdog/config')).body).toEqual({ mode: 'observe' })
  expect((await h.api('POST', 'watchdog/config', { mode: 'advise' })).body).toEqual({ mode: 'advise' })
  expect((await h.api('GET', 'watchdog/reviews')).body).toEqual([])
  expect((await h.api('GET', 'watchdog/snapshot')).body).toMatchObject({ baseline: { semanticReview: 'not_configured', semanticStatus: 'unreviewed' } })
  expect((await h.api('GET', 'qq/observations')).status).toBe(503)
})

it('registers and probes a real daemon through HTTP while exposing only safe device metadata', async () => {
  await registerDevice()
  const list = await h.api('GET', 'environments')
  expect(list.status).toBe(200)
  expect(list.body).toMatchObject({ items: [{ id: 'laptop', status: 'unprobed' }] })
  expect(JSON.stringify(list.body)).not.toContain(TOKEN)
  expect(JSON.stringify(list.body)).not.toContain('credentialRef')
  expect((await h.api('POST', 'environments/laptop/probe')).body).toMatchObject({ id: 'laptop', status: 'online', health: { protocol: 1, schema: 1 } })
  expect((await h.api('POST', 'environments', { id: 'bad', label: 'Bad input', url: 'http://127.0.0.1:1', credentialRef: TOKEN_REF, token: TOKEN })).status).toBe(400)
})

it('switches a running ticket to its owner-selected device, executes through the registered worker tool and preserves exact command identity', async () => {
  await registerDevice()
  const work = await h.acceptedTicket(feishu('103', '@bot 生成一份本地验证文件'))
  expect((await h.api('PUT', `tickets/${work.ticket.id}/environment`, { deviceId: 'laptop' })).body).toEqual({ deviceId: 'laptop' })
  await h.runtime.idle()
  await vi.waitFor(() => { expect(h.tools.get(work.sessionId)?.has('orchestrator_environment_start')).toBe(true) })
  const result = await h.runTool(work.sessionId, 'orchestrator_environment_start', { request_id: 'runtime-command-once',
    command: encodedCommand('require("node:fs").appendFileSync("proof.txt","once\\n"); console.log("credential-visible=" + Boolean(process.env.SUPERAGENT_AUTONOMY_TEST_DEVICE));') })
  const done = await completed(work.ticket.id, String(result.commandId))
  expect(done.state).toBe('completed')
  expect(done.remote?.stdout).toContain('credential-visible=false')
  const file = await h.runtime.remote.readFile(work.ticket.id, 'laptop', 'proof.txt')
  expect(Buffer.from(file.base64, 'base64').toString()).toBe('once\n')
  const replay = await h.runTool(work.sessionId, 'orchestrator_environment_start', { request_id: 'runtime-command-once',
    command: encodedCommand('require("node:fs").appendFileSync("proof.txt","once\\n"); console.log("credential-visible=" + Boolean(process.env.SUPERAGENT_AUTONOMY_TEST_DEVICE));') })
  expect(replay.commandId).toBe(result.commandId)
  expect(Buffer.from((await h.runtime.remote.readFile(work.ticket.id, 'laptop', 'proof.txt')).base64, 'base64').toString()).toBe('once\n')
  const projection = await h.api('GET', `tickets/${work.ticket.id}/environment`)
  expect(projection.body).toMatchObject({ deviceId: 'laptop', commands: [{ effectiveState: 'completed' }] })
  expect(JSON.stringify(projection.body)).not.toContain(TOKEN)
}, 20_000)

it('holds an offline task, durably cancels its queued command and reconnects without executing that cancelled request', async () => {
  const daemon = await registerDevice()
  const work = await h.acceptedTicket(feishu('104', '@bot 等待设备处理资料'))
  await h.api('PUT', `tickets/${work.ticket.id}/environment`, { deviceId: 'laptop' }); await h.runtime.idle()
  await daemon.close(); daemons.splice(daemons.indexOf(daemon), 1)
  const started = await h.runtime.remote.start('laptop', work.ticket.id, { requestId: 'offline-cancel', command: encodedCommand('require("node:fs").writeFileSync("should-not-exist.txt","side effect")') })
  expect(started.state).toBe('waiting_environment')
  await h.runtime.pump(); await h.runtime.idle()
  expect(h.runtime.store.tickets.get(work.ticket.id)?.hold?.kind).toBe('environment')
  const cancelled = await h.api('POST', `tickets/${work.ticket.id}/environment/commands/${started.commandId}/cancel`)
  expect(cancelled.status).toBe(200)
  expect(cancelled.body).toMatchObject({ cancelRequested: true })
  const revived = await startEnvironmentDaemon({ root: join(h.directory, 'remote-work'), stateDir: join(h.directory, 'remote-state'), token: TOKEN,
    port: Number(new URL(daemon.url).port) }); daemons.push(revived)
  const result = await h.runtime.remote.status(work.ticket.id, started.commandId)
  expect(result.state).toBe('cancelled')
  await expect(h.runtime.remote.readFile(work.ticket.id, 'laptop', 'should-not-exist.txt')).rejects.toThrow()
  await h.runtime.pump(); await h.runtime.idle()
  expect(h.runtime.store.tickets.get(work.ticket.id)?.ended).toBeUndefined()
}, 20_000)

it('requires current observed evidence for unknown owner resolution and preserves the original command history', async () => {
  await registerDevice()
  const work = await h.acceptedTicket(feishu('105', '@bot 核实遗留执行结果'))
  await h.api('PUT', `tickets/${work.ticket.id}/environment`, { deviceId: 'laptop' }); await h.runtime.idle()
  const payload = commandPayload({ ticketId: work.ticket.id, command: 'inspect preserved output' })
  const at = new Date().toISOString(), commandId = 'runtime-unknown-command'
  const intent: RemoteIntent = { commandId, ticketId: work.ticket.id, deviceId: 'laptop', requestId: 'unknown-request', payload,
    payloadHash: payloadHash(payload), state: 'unknown', createdAt: at, updatedAt: at }
  h.runtime.store.set(`remote-command:${commandId}`, intent)
  h.runtime.engine.holdTicket(work.ticket.id, { kind: 'environment', at, reason: 'Inspect the unknown remote command before continuing.' })
  await h.runtime.idle()
  const held = structuredClone(h.runtime.store.tickets.get(work.ticket.id)!)
  expect(held.hold?.kind).toBe('environment')
  expect((await h.api('POST', `tickets/${work.ticket.id}/resume`))).toMatchObject({ status: 400, body: { error: expect.stringContaining('unknown remote command') } })
  expect(h.runtime.store.tickets.get(work.ticket.id)?.hold).toEqual(held.hold)
  expect(h.runtime.store.tickets.get(work.ticket.id)?.assignments).toEqual(held.assignments)
  const stale = await h.api('POST', `tickets/${work.ticket.id}/environment/commands/${commandId}/resolve`, {
    outcome: 'completed', evidence: '已读取保留的交付文件。', expectedUpdatedAt: '2000-01-01T00:00:00Z' })
  expect(stale.status).toBe(409)
  expect(h.runtime.remote.commands(work.ticket.id)[0]).toMatchObject({ effectiveState: 'unknown' })
  expect((await h.api('POST', `tickets/${work.ticket.id}/environment/commands/${commandId}/resolve`, { outcome: 'completed', evidence: '' })).status).toBe(400)
  const resolved = await h.api('POST', `tickets/${work.ticket.id}/environment/commands/${commandId}/resolve`, {
    outcome: 'completed', evidence: '已读取保留的交付文件。', expectedUpdatedAt: at })
  expect(resolved.status).toBe(200)
  expect(resolved.body).toMatchObject({ state: 'completed', ownerResolution: { evidence: '已读取保留的交付文件。' } })
  expect(h.runtime.remote.commands(work.ticket.id)[0]).toMatchObject({ state: 'unknown', effectiveState: 'completed' })
  expect((await h.api('POST', `tickets/${work.ticket.id}/resume`))).toMatchObject({ status: 200, body: { resumed: true } })
  await h.runtime.idle()
  const resumed = h.runtime.store.tickets.get(work.ticket.id)!
  expect(resumed.hold).toBeUndefined()
  expect(resumed.ended).toBeUndefined()
  expect(resumed.mandate).toStrictEqual(held.mandate)
  expect(resumed.assignments.at(-1)?.state).toBe('running')
  expect(resumed.assignments.at(-1)?.id).not.toBe(held.assignments.at(-1)?.id)
})

it.each(['human-stop', 'pr-merged'] as const)('cancels running and capacity-queued remote commands when the Runtime ends a task by %s', async ending => {
  const daemon = await registerDevice(1)
  const work = await h.acceptedTicket(feishu('111', '@bot 执行有界远端任务，并保留取消记录。'))
  const pull = { source: 'github', id: '311' }
  if (ending === 'pr-merged') h.runtime.engine.bindThread(work.ticket.id, pull, true)
  expect((await h.api('PUT', `tickets/${work.ticket.id}/environment`, { deviceId: 'laptop' })).status).toBe(200)
  await h.runtime.idle()
  const running = await h.runTool(work.sessionId, 'orchestrator_environment_start', {
    request_id: 'terminal-running-command', timeout_ms: 30_000,
    command: encodedCommand('require("node:fs").writeFileSync("running.pid",String(process.pid)); console.log("ready-to-cancel"); setInterval(() => {},1000);'),
  })
  const runningId = String(running.commandId)
  await vi.waitFor(async () => {
    const actual = await daemonRequest(daemon, `/v1/commands/${runningId}?ticketId=${work.ticket.id}`)
    expect(actual).toMatchObject({ status: 200, body: { state: 'running', stdout: expect.stringContaining('ready-to-cancel') } })
  }, { timeout: 12_000, interval: 40 })
  const queued = await h.runtime.remote.start('laptop', work.ticket.id, { requestId: 'terminal-capacity-queue',
    command: encodedCommand('require("node:fs").writeFileSync("queued-must-not-run.txt","unexpected execution");') })
  expect(queued).toMatchObject({ state: 'waiting_environment', error: expect.stringContaining('slots are full') })
  await h.runtime.pump(); await h.runtime.idle()
  expect(h.runtime.store.tickets.get(work.ticket.id)?.hold?.kind).toBe('environment')
  if (ending === 'human-stop') {
    expect((await h.api('POST', `tickets/${work.ticket.id}/stop`))).toMatchObject({ status: 200, body: { stopped: true } })
  } else h.runtime.engine.threadClosed(pull, 'merged', new Date().toISOString())
  expect(h.runtime.store.tickets.get(work.ticket.id)?.ended).toMatchObject(ending === 'human-stop'
    ? { by: 'human', outcome: 'stopped' } : { by: 'executor', outcome: 'merged' })
  // Read saved host state only: an explicit status/cancel request here would hide missing ticket.ended wiring.
  await vi.waitFor(() => {
    for (const id of [runningId, queued.commandId]) {
      expect(h.runtime.remote.commandResult(work.ticket.id, id)).toMatchObject({ state: 'cancelled', cancelRequested: true })
    }
  }, { timeout: 12_000, interval: 40 })
  expect(await daemonRequest(daemon, `/v1/commands/${runningId}?ticketId=${work.ticket.id}`)).toMatchObject({ status: 200,
    body: { commandId: runningId, state: 'cancelled', endedAt: expect.any(String) } })
  expect((await daemonRequest(daemon, `/v1/commands/${queued.commandId}?ticketId=${work.ticket.id}`)).status).toBe(404)
  expect((await daemonRequest(daemon, '/v1/health')).body).toMatchObject({ activeCommands: 0 })
  await expect(h.runtime.remote.readFile(work.ticket.id, 'laptop', 'queued-must-not-run.txt')).rejects.toThrow()
  const ended = structuredClone(h.runtime.store.tickets.get(work.ticket.id)!.ended)
  await h.runtime.pump(); await h.runtime.idle()
  expect(h.runtime.store.tickets.get(work.ticket.id)?.ended).toStrictEqual(ended)
}, 30_000)

it('delivers memory corrections through Runtime to the original live worker once and preserves a human stop', async () => {
  const work = await h.acceptedTicket(feishu('106', '@bot 使用上海时区安排会议'))
  const saved = await h.runTool(h.runtime.masterId, 'orchestrator_memory_save', { topic: 'runtime-timezone', title: '会议时区', summary: '使用上海时区。',
    content: 'Asia/Shanghai', expected_revision: 0, evidence: 'user', sources: [{ kind: 'trigger', ref: work.trigger.id, quote: '使用上海时区' }] })
  expect(saved).toMatchObject({ confidence: 'supported', status: 'active' })
  await h.runTool(h.runtime.masterId, 'orchestrator_memory_read', { topic: 'runtime-timezone', ticketId: work.ticket.id })
  const correction = feishu('107', '改用东京时区。'); h.runtime.store.triggers.save(correction)
  await h.runTool(h.runtime.masterId, 'orchestrator_memory_save', { topic: 'runtime-timezone', title: '会议时区', summary: '改用东京时区。',
    content: 'Asia/Tokyo', expected_revision: 1, evidence: 'user', sources: [{ kind: 'trigger', ref: correction.id, quote: '改用东京时区' }] })
  await h.runtime.memory.flushCorrections(); await h.runtime.idle()
  await h.runtime.memory.flushCorrections(); await h.runtime.idle()
  const corrected = h.runtime.store.tickets.get(work.ticket.id)!
  expect(corrected.inputs.filter(input => input.kind === 'note' && input.text.includes('Shared memory runtime-timezone'))).toHaveLength(1)
  h.runtime.engine.stopTicket(work.ticket.id); await h.runtime.idle()
  await h.runTool(h.runtime.masterId, 'orchestrator_memory_save', { topic: 'runtime-timezone', title: '会议时区', summary: '再次确认东京时区。',
    content: 'Asia/Tokyo', expected_revision: 2, evidence: 'user', sources: [{ kind: 'trigger', ref: correction.id, quote: '改用东京时区' }] })
  await h.runtime.memory.flushCorrections(); await h.runtime.idle()
  expect(h.runtime.store.tickets.get(work.ticket.id)).toMatchObject({ ended: { by: 'human', outcome: 'stopped' } })
  expect(h.runtime.store.tickets.get(work.ticket.id)!.inputs.filter(input => input.kind === 'note' && input.text.includes('Shared memory runtime-timezone'))).toHaveLength(1)
})

it('records replay-safe human adoption, quality and routing feedback with explicit unknown usage coverage', async () => {
  const work = await h.acceptedTicket(feishu('108', '@bot 处理一次可评价的任务'))
  const before = (await h.api('GET', 'evaluation/summary')).body as unknown as { counts: Record<string, number> }
  const feedback = { requestId: 'owner-feedback-1', accepted: true, correct: false, routingCorrection: true }
  expect((await h.api('POST', `tickets/${work.ticket.id}/feedback`, feedback)).body).toEqual({ recorded: true })
  expect((await h.api('POST', `tickets/${work.ticket.id}/feedback`, feedback)).body).toEqual({ recorded: true })
  const after = (await h.api('GET', 'evaluation/summary')).body as unknown as { counts: Record<string, number>; metrics: Record<string, unknown>; coverage: Record<string, number> }
  expect(after.counts.adoption).toBe((before.counts.adoption ?? 0) + 1)
  expect(after.counts.completion).toBe((before.counts.completion ?? 0) + 1)
  expect(after.counts.intervention).toBe((before.counts.intervention ?? 0) + 1)
  expect(after.metrics).toMatchObject({ adoptionRate: 1, cost: null, tokens: null, routingCorrections: 1 })
  expect(after.coverage).toMatchObject({ adoptionJudgments: 1, completionJudgments: 1 })
  expect((await h.api('POST', `tickets/${work.ticket.id}/feedback`, { requestId: 'bad', accepted: true, token: TOKEN })).status).toBe(400)
})

it('records independent-supervisor model failure as unknown while preserving the live worker and its controls', async () => {
  const work = await h.acceptedTicket(feishu('109', '@bot 继续定位一个运行问题'))
  const before = structuredClone(h.runtime.store.tickets.get(work.ticket.id)!)
  const assessment = await h.api('POST', 'watchdog/assess', {})
  expect(assessment.status).toBe(200)
  expect(assessment.body).toMatchObject({ status: 'unknown', mode: 'observe', semanticStatus: 'unknown' })
  const after = h.runtime.store.tickets.get(work.ticket.id)!
  expect(after.inputs).toEqual(before.inputs)
  expect(after.assignments).toEqual(before.assignments)
  expect(after.hold).toBeUndefined()
  const reviews = await h.api('GET', `watchdog/reviews?ticketId=${work.ticket.id}`)
  expect(reviews.status).toBe(200)
  expect(reviews.body).toEqual([expect.objectContaining({ state: 'failed' })])
  expect(JSON.stringify(reviews.body)).not.toContain(TOKEN)
})

it('applies the supervisor stop-loss through HTTP and resumes the original mandate after owner inspection', async () => {
  const work = await h.acceptedTicket(feishu('119', '@bot 定位重试循环并核对修复结果'))
  const mandate = structuredClone(work.ticket.mandate)
  let clock = Date.now(), sequence = 200
  vi.spyOn(Date, 'now').mockImplementation(() => clock)
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, eval: { ...settings.eval, model: { provider: 'fixture', model: 'supervisor' } } })
  const llm = h.ctx.llm as unknown as { stream(options: { messages: { content: { text: string }[] }[] }): AsyncIterable<unknown> }
  llm.stream = async function* (options) {
    const { snapshot } = JSON.parse(options.messages[0]!.content[0]!.text) as { snapshot: { tickets: { id: string; evidence: { id: string }[] }[] } }
    const task = snapshot.tickets.find(item => item.id === work.ticket.id)!
    yield { type: 'text-delta', index: 0, text: JSON.stringify({ status: 'stalled', findings: [{ ticketId: task.id, status: 'stalled',
      evidence: ['Observed retry results repeat the same redirect failure.'], evidenceRefs: [task.evidence.at(-1)!.id], recommendation: 'Inspect the configured redirect target.' }] }) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const outcome = () => h.runtime.evidence.capture(work.ticket.id, { seq: ++sequence, time: clock, type: 'tool/result',
    data: { turn: 1, message: { role: 'tool', toolCallId: `retry-${sequence}`, isError: true,
      content: [{ type: 'text', text: 'Redirect retry failed with the same target.' }] } } } as never)
  await h.api('POST', 'watchdog/config', { mode: 'advise' })
  outcome()
  const apply = async () => {
    const assessed = await h.api('POST', 'watchdog/assess', {})
    expect(assessed.body).toMatchObject({ status: 'stalled', semanticStatus: 'reviewed' })
    const review = h.runtime.supervision.get(String(assessed.body.reviewId))!
    return h.api('POST', 'watchdog/advice', { reviewId: review.id, ticketId: work.ticket.id,
      expectedRevision: review.ticketRevisions[work.ticket.id] })
  }
  expect((await apply()).body).toMatchObject({ requested: true, action: 'note' })
  await h.runtime.idle()
  clock += 31 * 60_000
  expect((await apply()).body).toMatchObject({ requested: true, action: 'note' })
  await h.runtime.idle()
  clock += 31 * 60_000; outcome(); clock++; outcome()
  // A daemon's unknown result is durable before its asynchronous transition pass installs an environment hold.
  const unknownPayload = commandPayload({ ticketId: work.ticket.id, command: 'preserved pending result' })
  const unknownAt = new Date(clock).toISOString(), unknownId = 'stoploss-unresolved-command'
  const unknown: RemoteIntent = { commandId: unknownId, ticketId: work.ticket.id, deviceId: 'offline-device', requestId: unknownId,
    payload: unknownPayload, payloadHash: payloadHash(unknownPayload), state: 'unknown', createdAt: unknownAt, updatedAt: unknownAt }
  h.runtime.store.set(`remote-command:${unknownId}`, unknown)
  expect(h.runtime.store.tickets.get(work.ticket.id)?.hold).toBeUndefined()
  expect((await apply()).body).toMatchObject({ requested: false, reason: 'protected' })
  expect(h.runtime.store.tickets.get(work.ticket.id)?.hold).toBeUndefined()
  h.runtime.store.delete(`remote-command:${unknownId}`)
  expect((await apply()).body).toMatchObject({ requested: true, action: 'hold', newExecutionCount: 2 })
  await h.runtime.idle()
  const held = h.runtime.store.tickets.get(work.ticket.id)!
  expect(held.hold).toMatchObject({ kind: 'operator', reason: expect.stringContaining('two corrective notes') })
  expect(held.assignments.at(-1)?.state).toBe('ended')
  expect(held.mandate).toStrictEqual(mandate)
  expect((await h.api('POST', `tickets/${work.ticket.id}/resume`)).status).toBe(200)
  await h.runtime.idle()
  const resumed = h.runtime.store.tickets.get(work.ticket.id)!
  expect(resumed.hold).toBeUndefined()
  expect(resumed.assignments.at(-1)?.state).toBe('running')
  expect(resumed.mandate).toStrictEqual(mandate)
})

it('persists an observation verification result without changing a completed task lifecycle', async () => {
  const work = await h.acceptedTicket(feishu('110', '@bot 整理已知资料'))
  await h.runTool(work.sessionId, 'orchestrator_report', { state: 'ready', summary: '资料已经整理。' })
  const before = structuredClone(h.runtime.store.tickets.get(work.ticket.id)!)
  await h.runtime.pump(); await h.runtime.idle()
  const after = h.runtime.store.tickets.get(work.ticket.id)!
  expect(after.ended).toEqual(before.ended)
  expect(after.verification).toBeUndefined()
  const view = await h.api('GET', `tickets/${work.ticket.id}/verification`)
  expect(view.status).toBe(200)
  expect(view.body).toMatchObject({ acceptance: { mode: 'observe' }, verification: { state: 'unknown' }, history: [expect.objectContaining({ state: 'unknown' })] })
})
