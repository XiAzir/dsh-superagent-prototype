import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/app/store.ts'
import { dshSupervisionModel, SupervisionService, type SupervisionHost } from '../src/app/supervision.ts'
import { watchdogSnapshot, watchdogTicketRevision, type WatchdogExecutionEvidence } from '../src/app/watchdog.ts'
import type { Ticket } from '../src/core/index.ts'

const directories: string[] = [], stores: Store[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
const AT = '2026-11-07T00:00:00.000Z'
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'supervision-')); directories.push(directory)
  let store = new Store(join(directory, 'state.sqlite')); stores.push(store)
  const ticket: Ticket = { id: 'work', title: 'Restore login redirect', decisionId: 'd',
    mandate: { strength: 'explicit', scope: 'Restore login redirect; keep API unchanged', policyVersion: 'v', actor: { source: 'web', id: 'owner' },
      basis: { via: 'addressed', addressed: 'direct' } } as Ticket['mandate'], channels: [],
    assignments: [{ id: 'a1', state: 'running', createdAt: AT, startedAt: AT, report: { state: 'progress', summary: 'Investigating redirect', at: AT } }],
    inputs: [{ id: 'i1', kind: 'trigger', triggerId: 'correction', human: true, at: AT }], undelivered: [],
    createdAt: AT, updatedAt: AT, origin: { triggerId: 'original', triggerIds: ['original'] } }
  store.tickets.save(ticket)
  for (const [id, text] of [['original', 'Restore the login redirect. api_key="private-value"'], ['correction', 'Keep the public API unchanged.']]) {
    store.triggers.save({ id: id!, source: 'web', threads: [{ source: 'web', id: 'room' }], actor: { source: 'web', id: 'owner' },
      human: true, addressed: 'direct', text: text!, at: AT, meta: {} })
  }
  let now = Date.parse(AT), calls = 0, notes = 0, holds = 0, paused = false
  let evidence: WatchdogExecutionEvidence[] = [{ id: 'tool:1', at: AT, kind: 'tool', state: 'completed', summary: 'curl returned redirect loop three times' }]
  let answer: Record<string, unknown> = { status: 'stalled', findings: [{ ticketId: 'work', status: 'stalled', evidence: ['Same request failed three times without changing input'],
    evidenceRefs: ['tool:1'], recommendation: 'Inspect the redirect configuration before repeating the request.' }] }
  const host: SupervisionHost = { store, paused: () => paused, now: () => now,
    snapshot: options => watchdogSnapshot({ store, configured: () => true, machine: {}, health: {}, executor: { activeCount: () => 1 },
      executionEvidence: () => evidence }, { ...options, now: new Date(now) }),
    runModel: async () => { calls++; return { text: JSON.stringify(answer), model: { provider: 'stub', model: 'supervisor' },
      usage: { inputTokens: 100, outputTokens: 20 } } },
    advise: () => { notes++ },
  }
  const service = new SupervisionService(host)
  return { get store() { return store }, ticket, host, service, directory, get calls() { return calls }, get notes() { return notes }, get holds() { return holds },
    enableHold: () => {
      host.currentExecutionEvidence = () => evidence
      host.hold = (ticketId, reason) => {
        const current = store.tickets.get(ticketId)!
        current.hold = { kind: 'operator', at: new Date(now).toISOString(), reason }
        current.assignments.at(-1)!.state = 'ended'; current.updatedAt = new Date(now).toISOString()
        store.tickets.save(current); holds++; return true
      }
    },
    reopen: () => { store.close(); stores.splice(stores.indexOf(store), 1); store = new Store(join(directory, 'state.sqlite')); stores.push(store); host.store = store },
    outcome: (id: string): WatchdogExecutionEvidence => ({ id, at: new Date(now).toISOString(), kind: 'tool', state: 'observed', summary: 'Repeated redirect request still loops' }),
    setAnswer: (next: Record<string, unknown>) => { answer = next }, setEvidence: (next: WatchdogExecutionEvidence[]) => { evidence = next },
    setPaused: () => { paused = true }, advance: (ms: number) => { now += ms },
    update: () => { ticket.updatedAt = new Date(++now).toISOString(); store.tickets.save(ticket) } }
}

it('keeps ordinary snapshots small and builds redacted goal/correction/tool evidence only for semantic review', async () => {
  const f = fixture(), ordinary = await f.host.snapshot({ offset: 0, maxTickets: 20, includeEvidence: false })
  expect(ordinary.tickets[0]?.goal).toBeUndefined()
  const result = await f.service.review({ expectedHash: ordinary.snapshotHash })
  expect(result).toMatchObject({ status: 'stalled', semanticStatus: 'reviewed', mode: 'observe' })
  const saved = f.service.get(result.reviewId)!
  expect(saved.input).toContain('Keep the public API unchanged')
  expect(saved.input).toContain('curl returned redirect loop three times')
  expect(saved.input).not.toContain('private-value')
  expect(saved.usage).toEqual({ inputTokens: 100, outputTokens: 20 })
  expect(saved.snapshotHash).toBe(result.snapshotHash)
  expect(f.service.applyAdvice({ reviewId: result.reviewId, ticketId: 'work', expectedRevision: watchdogTicketRevision(f.ticket) }).reason).toBe('observe')
  expect(f.notes).toBe(0)
})

it('persists a review and deduplicates revision-bound advice across service restart', async () => {
  const f = fixture(), result = await f.service.review(), revision = watchdogTicketRevision(f.ticket)
  f.service.config({ mode: 'advise' })
  expect(f.service.applyAdvice({ reviewId: result.reviewId, ticketId: 'work', expectedRevision: revision }).requested).toBe(true)
  const restarted = new SupervisionService(f.host)
  expect(restarted.history({ ticketId: 'work' })[0]).toMatchObject({ id: result.reviewId, state: 'completed' })
  expect(restarted.applyAdvice({ reviewId: result.reviewId, ticketId: 'work', expectedRevision: revision }).requested).toBe(true)
  expect(f.notes).toBe(1)
  expect(restarted.history()[0]).not.toHaveProperty('input')
})

it('rejects obsolete goals or reports and never applies a stale recommendation', async () => {
  const f = fixture(), before = await f.host.snapshot({ offset: 0, maxTickets: 20, includeEvidence: false })
  f.update()
  expect(await f.service.review({ expectedHash: before.snapshotHash })).toMatchObject({ status: 'unknown', semanticStatus: 'stale' })
  expect(f.calls).toBe(0)
  const review = await f.service.review(), revision = watchdogTicketRevision(f.ticket)
  f.ticket.assignments[0]!.report!.summary = 'Found the cause and started the fix'; f.update()
  f.service.config({ mode: 'advise' })
  expect(f.service.applyAdvice({ reviewId: review.reviewId, ticketId: 'work', expectedRevision: revision }).reason).toBe('stale')
  expect(f.notes).toBe(0)
})

it('marks an assessment stale when the worker advances during model inference', async () => {
  const f = fixture(), run = f.host.runModel
  f.host.runModel = async (input, signal) => { const result = await run(input, signal); f.update(); return result }
  const review = await f.service.review()
  expect(review).toMatchObject({ status: 'unknown', semanticStatus: 'stale' })
  expect(f.service.get(review.reviewId)?.state).toBe('stale')
})

it('preserves a legitimate long external/background wait and protects stopped or human-held work', async () => {
  const f = fixture()
  f.setEvidence([{ id: 'job:1', at: AT, kind: 'background', state: 'running', summary: 'Integration build is running' }])
  f.ticket.assignments[0]!.report = { state: 'waiting', summary: 'Waiting for the build', at: AT,
    waitingFor: { kind: 'external', subject: 'integration build' } }; f.update()
  f.setAnswer({ status: 'waiting', findings: [{ ticketId: 'work', status: 'waiting', evidence: ['Build job remains running'], evidenceRefs: ['job:1'], recommendation: 'Wait for the recorded job.' }] })
  const review = await f.service.review()
  expect(review.status).toBe('waiting')
  f.service.config({ mode: 'advise' })
  expect(f.service.applyAdvice({ reviewId: review.reviewId, ticketId: 'work', expectedRevision: watchdogTicketRevision(f.ticket) }).reason).toBe('protected')
  expect(f.notes).toBe(0)
  f.ticket.ended = { by: 'human', outcome: 'stopped', at: AT }; f.update()
  const stopped = await f.service.review()
  expect(f.service.applyAdvice({ reviewId: stopped.reviewId, ticketId: 'work', expectedRevision: watchdogTicketRevision(f.ticket) }).reason).toBe('protected')
})

it('treats repeated self-reports without tool evidence as unknown and rejects invented citations', async () => {
  const f = fixture(); f.setEvidence([])
  f.setAnswer({ status: 'healthy', findings: [{ ticketId: 'work', status: 'healthy', evidence: ['Worker says progress'],
    evidenceRefs: [`report:work:${AT}`], recommendation: 'Continue' }] })
  const pseudo = await f.service.review()
  expect(pseudo.status).toBe('unknown')
  expect(f.service.get(pseudo.reviewId)?.error).toContain('actual execution evidence')
  f.setAnswer({ status: 'diverged', findings: [{ ticketId: 'work', status: 'diverged', evidence: ['Invented change'], evidenceRefs: ['missing:1'], recommendation: 'Undo it' }] })
  expect((await f.service.review()).status).toBe('unknown')
})

it('isolates provider failure, malformed output and cancellation from running work', async () => {
  const f = fixture()
  f.host.runModel = async () => { throw new Error('token="never-log-this" provider unavailable') }
  const failed = await f.service.review()
  expect(failed).toMatchObject({ status: 'unknown', semanticStatus: 'unknown' })
  expect(f.service.get(failed.reviewId)?.error).not.toContain('never-log-this')
  expect(f.store.tickets.get('work')?.assignments[0]?.state).toBe('running')
  expect(f.notes).toBe(0)
  const controller = new AbortController(); controller.abort()
  const cancelled = await f.service.review({}, controller.signal)
  expect(cancelled.status).toBe('unknown')
  expect(f.service.get(cancelled.reviewId)?.state).toBe('failed')
})

it('bounds corrective advice with cooldown, maximum attempts and pause checks', async () => {
  const f = fixture(); f.service.config({ mode: 'advise' })
  const apply = async () => { const review = await f.service.review(); return f.service.applyAdvice({ reviewId: review.reviewId,
    ticketId: 'work', expectedRevision: watchdogTicketRevision(f.ticket) }) }
  expect((await apply()).requested).toBe(true)
  f.update(); expect((await apply()).reason).toBe('cooldown')
  f.advance(31 * 60_000); f.update(); expect((await apply()).requested).toBe(true)
  f.advance(31 * 60_000); f.update(); expect((await apply()).reason).toBe('limit')
  f.setPaused(); expect((await apply()).reason).toBe('paused')
  expect(f.notes).toBe(2)
})

it('holds persistent ineffective work after two notes and two newly observed tool results, once across a database restart', async () => {
  const f = fixture(); f.enableHold(); f.service.config({ mode: 'advise' })
  const apply = async (service = f.service) => {
    const review = await service.review()
    return service.applyAdvice({ reviewId: review.reviewId, ticketId: 'work', expectedRevision: watchdogTicketRevision(f.store.tickets.get('work')!) })
  }
  expect(await apply()).toMatchObject({ requested: true, action: 'note' })
  f.advance(31 * 60_000); f.update()
  expect(await apply()).toMatchObject({ requested: true, action: 'note' })
  f.advance(31 * 60_000); f.update()
  f.setEvidence([f.outcome('tool:2'), f.outcome('tool:3')])
  f.setAnswer({ status: 'stalled', findings: [{ ticketId: 'work', status: 'stalled', evidence: ['Two new retries still return the same redirect loop'],
    evidenceRefs: ['tool:2', 'tool:3'], recommendation: 'Inspect the configured redirect target.' }] })
  const mandate = f.store.tickets.get('work')!.mandate
  f.reopen()
  const resumed = new SupervisionService(f.host), review = await resumed.review(), revision = watchdogTicketRevision(f.store.tickets.get('work')!)
  const result = resumed.applyAdvice({ reviewId: review.reviewId, ticketId: 'work', expectedRevision: revision })
  expect(result).toMatchObject({ requested: true, action: 'hold', newExecutionCount: 2 })
  expect(f.store.tickets.get('work')).toMatchObject({ mandate, hold: { kind: 'operator', reason: expect.stringContaining('two corrective notes') } })
  expect(f.store.tickets.get('work')!.assignments.at(-1)!.state).toBe('ended')
  f.reopen()
  expect(new SupervisionService(f.host).applyAdvice({ reviewId: review.reviewId, ticketId: 'work', expectedRevision: revision })).toEqual(result)
  expect(f.notes).toBe(2); expect(f.holds).toBe(1)
})

it('requires fresh cited tool consumption and an unchanged live evidence version before a hold', async () => {
  const f = fixture(); f.enableHold(); f.service.config({ mode: 'advise' })
  const apply = async () => { const review = await f.service.review(); return f.service.applyAdvice({ reviewId: review.reviewId,
    ticketId: 'work', expectedRevision: watchdogTicketRevision(f.ticket) }) }
  await apply(); f.advance(31 * 60_000); f.update(); await apply()
  f.advance(31 * 60_000); f.update()
  expect(await apply()).toMatchObject({ requested: false, reason: 'no-new-execution', newExecutionCount: 0 })
  f.setEvidence([f.outcome('tool:2')])
  f.setAnswer({ status: 'stalled', findings: [{ ticketId: 'work', status: 'stalled', evidence: ['Retry still loops'],
    evidenceRefs: ['tool:2'], recommendation: 'Inspect the redirect target.' }] })
  expect(await apply()).toMatchObject({ requested: false, reason: 'no-new-execution', newExecutionCount: 1 })
  f.setEvidence([f.outcome('tool:2'), f.outcome('tool:3')])
  const review = await f.service.review(), revision = watchdogTicketRevision(f.ticket)
  f.setEvidence([f.outcome('tool:2'), f.outcome('tool:3'), f.outcome('tool:4')])
  expect(f.service.applyAdvice({ reviewId: review.reviewId, ticketId: 'work', expectedRevision: revision })).toMatchObject({ requested: false, reason: 'stale' })
  expect(f.holds).toBe(0)
})

it('keeps recovered, corrected and explicitly held tasks out of the stop-loss sequence', async () => {
  for (const change of ['recovered', 'corrected', 'held', 'background', 'unknown'] as const) {
    const f = fixture(); f.enableHold(); f.service.config({ mode: 'advise' })
    const apply = async () => { const review = await f.service.review(); return f.service.applyAdvice({ reviewId: review.reviewId,
      ticketId: 'work', expectedRevision: watchdogTicketRevision(f.ticket) }) }
    await apply(); f.advance(31 * 60_000); f.update(); await apply()
    f.advance(31 * 60_000); f.update()
    f.setEvidence([f.outcome('tool:2'), f.outcome('tool:3')])
    if (change === 'recovered') {
      f.setAnswer({ status: 'healthy', findings: [{ ticketId: 'work', status: 'healthy', evidence: ['Configuration changed and verification passed'],
        evidenceRefs: ['tool:3'], recommendation: 'Continue' }] }); await f.service.review(); f.advance(1)
    }
    if (change === 'corrected') f.ticket.inputs.push({ id: 'new-goal', kind: 'trigger', human: true, triggerId: 'new-goal', at: new Date().toISOString() })
    if (change === 'held') f.ticket.hold = { kind: 'operator', at: AT, reason: 'Owner investigating' }
    if (change === 'background') f.setEvidence([f.outcome('tool:2'), f.outcome('tool:3'), { id: 'job:1', at: AT, kind: 'background', state: 'running', summary: 'Build running' }])
    f.update()
    f.setAnswer(change === 'unknown' ? { status: 'unknown', findings: [] } : { status: 'stalled', findings: [{ ticketId: 'work', status: 'stalled',
      evidence: ['Repeated retries loop'], evidenceRefs: ['tool:3'], recommendation: 'Inspect the target.' }] })
    expect((await apply()).requested).toBe(false)
    expect(f.holds).toBe(0)
  }
})

it('runs an isolated tool-free DSH request and retains token usage', async () => {
  let captured: Record<string, unknown> | undefined
  const context = { llm: { async *stream(options: Record<string, unknown>) {
    captured = options
    yield { type: 'text-delta', index: 0, text: '{"status":"unknown","findings":[]}' }
    yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 4 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } } }
  const run = dshSupervisionModel(context as never, () => ({ provider: 'stub', model: 'independent' }))
  const result = await run('Exact review input', new AbortController().signal)
  expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 4 })
  expect(captured).toMatchObject({ tools: [], provider: 'stub', model: 'independent',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Exact review input' }] }] })
  expect(captured).not.toHaveProperty('sessionId')
  await expect(dshSupervisionModel(context as never, () => undefined)('x', new AbortController().signal)).rejects.toThrow('No configured model')
})
