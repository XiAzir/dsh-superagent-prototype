import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Engine, completionKey, type Policy, type Ticket, type Trigger } from '../src/core/index.ts'
import { Store } from '../src/app/store.ts'
import { Effects } from '../src/app/effects.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { ArtifactRegistry } from '../src/app/artifacts.ts'
import { VerificationService } from '../src/app/verification.ts'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const done of cleanup.splice(0).reverse()) await done() })
type Model = (input: string, signal?: AbortSignal) => Promise<{ text: string }>
function fixture(model: Model, mode: 'observe' | 'enforce' = 'enforce') {
  const directory = mkdtempSync(join(tmpdir(), 'acceptance-')), db = join(directory, 'state.sqlite')
  const store = new Store(db), effects = new Effects(store, new HealthBoard()), artifacts = new ArtifactRegistry(store, directory)
  const controller = new AbortController(), relay = vi.fn(), stop = vi.fn(), notes = vi.fn()
  const policy: Policy = { version: 'test', paused: false, evalTimeoutMs: 60_000, revalidate: () => true,
    admitsInferred: () => true, gate: () => ({ admissible: true, strength: 'explicit', basis: { via: 'listed' } }) }
  let service: VerificationService, clock = Date.parse('2026-11-07T00:00:00Z')
  const engine: Engine = new Engine({ repo: store, scope: { scope: () => ({ listened: true, observed: false }) }, policy: () => policy,
    assessor: { request() {} }, executor: { start: (ticket, assignment) => engine.assignmentStarted(ticket.id, assignment.id), deliver: notes, stop },
    outbox: { send() {}, status: () => undefined, withdraw() {} }, now: () => new Date(clock++).toISOString(),
    prepareTicket: ticket => service.prepare({ ...ticket, execution: { name: ticket.id, directory: join(directory, ticket.id), assignment: 'Create the requested JSON result.' } }) })
  service = new VerificationService({ store, effects, engine, artifacts, runModel: model, relay, requestPass() {}, paused: () => false,
    lifetime: controller.signal, executionEvidence: async () => [] })
  service.config({ mode, maxRepairs: 2 }); effects.start()
  cleanup.push(async () => { controller.abort(); await effects.drain(); store.close(); rmSync(directory, { recursive: true, force: true }) })
  const trigger: Trigger = { id: 'request', source: 'web', threads: [{ source: 'web', id: 'conversation' }], actor: { source: 'web', id: 'owner' },
    human: true, addressed: 'direct', routing: 'router', at: new Date(clock++).toISOString(), text: 'Create result.json containing {"total":2}.',
    channel: { source: 'web', thread: 'web:conversation', address: {} }, meta: {} }
  engine.receive(trigger); engine.evaluateDue()
  const decision = engine.decide(trigger.id, { kind: 'accept', title: 'JSON result', scope: trigger.text, reason: 'Explicit request', name: 'json-result' })
  const id = decision.ticketId!, ticket = () => store.tickets.get(id)!
  mkdirSync(ticket().execution!.directory, { recursive: true })
  async function ready(content: string) {
    const path = join(ticket().execution!.directory, 'result.json'); writeFileSync(path, content)
    const artifact = await artifacts.stage(id, ticket().execution!.directory, path)
    const updated = engine.report(id, { state: 'ready', summary: 'Created result.json.', artifacts: [artifact.id] })
    return { updated, artifact }
  }
  return { store, effects, service, engine, id, ticket, ready, relay, stop, notes, db }
}
const verdict = (input: string, state: 'passed' | 'needs_changes' = 'passed') => {
  const data = JSON.parse(input), artifact = data.evidence.find((item: { kind: string }) => item.kind === 'artifact')
  return { text: JSON.stringify({ state, summary: state === 'passed' ? 'The actual JSON matches the request.' : 'The JSON has the wrong total.',
    checks: data.acceptance.criteria.map((criterion: { id: string }) => ({ criterionId: criterion.id, state,
      summary: 'Read and checked the saved artifact.', evidenceRefs: [artifact.ref] })) }) }
}

it('holds ready delivery until the exact result has independent artifact evidence', async () => {
  const model = vi.fn(async (input: string) => {
    const data = JSON.parse(input), artifact = data.evidence.find((item: { kind: string }) => item.kind === 'artifact')
    expect(JSON.parse(JSON.parse(artifact.text).content)).toEqual({ total: 2 })
    return verdict(input)
  })
  const h = fixture(model), { updated } = await h.ready('{"total":2}')
  expect(updated.ended).toBeUndefined()
  expect(() => h.engine.reply({ purpose: 'result', ticketId: h.id, text: 'Done.' })).toThrow()
  h.service.enqueue(updated); await h.effects.idle('verification')
  expect(h.ticket().verification?.state).toBe('passed')
  expect(h.ticket().ended?.outcome).toBe('completed')
  expect(() => h.engine.reply({ purpose: 'result', ticketId: h.id, text: 'Done.' })).not.toThrow()
  h.service.tick(); await h.effects.idle('verification'); expect(model).toHaveBeenCalledTimes(1)
})

it('demonstrated malformed output returns concrete repair work to the original worker', async () => {
  const model = vi.fn(async (input: string) => verdict(input)), h = fixture(model), { updated } = await h.ready('{broken')
  h.service.enqueue(updated); await h.effects.idle('verification')
  expect(h.service.history(h.id)[0]?.state).toBe('needs_changes')
  expect(h.ticket().ended).toBeUndefined()
  expect(h.ticket().inputs.filter(item => item.kind === 'note' && item.text.includes('Independent acceptance'))).toHaveLength(1)
  expect(model).not.toHaveBeenCalled()
  h.service.tick(); await h.effects.idle('verification')
  expect(h.ticket().inputs.filter(item => item.kind === 'note')).toHaveLength(1)
})

it('a model cannot pass by quoting the requirement or inventing a proof reference', async () => {
  const h = fixture(async () => ({ text: JSON.stringify({ state: 'passed', summary: 'Claimed pass', checks: [
    { criterionId: 'original-request', state: 'passed', summary: 'The request says total 2.', evidenceRefs: ['trigger/request'] }] }) }))
  const { updated } = await h.ready('{"total":2}'); h.service.enqueue(updated); await h.effects.idle('verification')
  expect(h.ticket().verification?.state).toBe('unknown')
  expect(h.ticket().ended).toBeUndefined()
})

it('provider failure leaves execution and owner controls available with an unknown review', async () => {
  const h = fixture(async () => { throw new Error('Provider unavailable') }), { updated } = await h.ready('{"total":2}')
  h.service.enqueue(updated); await h.effects.idle('verification')
  expect(h.ticket().verification?.state).toBe('unknown')
  expect(h.stop).not.toHaveBeenCalled()
  h.engine.stopTicket(h.id)
  expect(h.ticket().ended?.by).toBe('human')
})

it('rejects a passing review when the worker has since produced a newer report', async () => {
  let release!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  const h = fixture(async input => { await waiting; return verdict(input) }), { updated } = await h.ready('{"total":2}')
  h.service.enqueue(updated)
  await vi.waitFor(() => expect(h.effects.pending('verification')).toBe(true))
  h.engine.report(h.id, { state: 'progress', summary: 'Applying a new requirement.' })
  release(); await h.effects.idle('verification')
  expect(h.ticket().verification).toBeUndefined()
  expect(h.ticket().ended).toBeUndefined()
})

it('observe mode preserves the existing lifecycle and stores a review without worker correction', async () => {
  const h = fixture(async input => verdict(input, 'needs_changes'), 'observe'), { updated } = await h.ready('{"total":3}')
  expect(updated.ended?.outcome).toBe('completed')
  h.service.enqueue(updated); await h.effects.idle('verification')
  expect(h.service.view(h.id).verification?.state).toBe('needs_changes')
  expect(h.ticket().inputs.filter(item => item.kind === 'note')).toHaveLength(0)
})

it('binds criteria to human source references and invalidates an earlier review on revision', async () => {
  const h = fixture(async input => verdict(input))
  expect(() => h.service.setCriteria(h.id, 1, [{ id: 'x', kind: 'artifact', description: 'A different task', sourceRefs: ['trigger/other'] }])).toThrow()
  const before = completionKey(h.ticket())
  h.service.setCriteria(h.id, 1, [{ id: 'json', kind: 'artifact', description: 'Contains total 2', sourceRefs: ['trigger/request'] }])
  expect(completionKey(h.ticket())).not.toBe(before)
  expect(() => h.service.setCriteria(h.id, 1, [{ id: 'x', kind: 'content', description: 'Stale', sourceRefs: ['trigger/request'] }])).toThrow(/revision/)
})

it('resource holds preserve authority, reject late reports and resume the same task idempotently', () => {
  const h = fixture(async input => verdict(input)), before = structuredClone(h.ticket()), assignment = before.assignments.at(-1)!
  h.engine.holdTicket(h.id, { kind: 'budget', reason: 'Daily observation quota exhausted', at: new Date().toISOString() })
  expect(h.ticket().mandate).toEqual(before.mandate)
  expect(() => h.engine.report(h.id, { state: 'ready', summary: 'Late result' }, assignment.id)).toThrow()
  h.engine.releaseTicket(h.id)
  const count = h.ticket().assignments.length
  h.engine.releaseTicket(h.id)
  expect(h.ticket().assignments).toHaveLength(count)
  expect(h.ticket().hold).toBeUndefined()
  expect(h.ticket().id).toBe(before.id)
})

it('coalesces simultaneous recheck requests for one ready report into one model call', async () => {
  let release!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  const model = vi.fn(async (input: string) => { await waiting; return verdict(input) })
  const h = fixture(model), { updated } = await h.ready('{"total":2}')
  const first = h.service.enqueue(updated, 'first-click'), second = h.service.enqueue(updated, 'second-click')
  expect(second).toBe(first)
  await vi.waitFor(() => expect(model).toHaveBeenCalledTimes(1))
  release(); await h.effects.idle('verification')
  expect(h.service.enqueue(h.ticket(), 'second-click')).toBe(first)
  expect(h.service.history(h.id)).toHaveLength(1)
})

it('protects a newer review generation from an older result for the same report', async () => {
  const h = fixture(async input => verdict(input)), { updated } = await h.ready('{"total":2}'), reportKey = completionKey(updated)
  h.engine.verify(h.id, { reportKey, state: 'running', at: new Date().toISOString(), summary: 'Newer review', checks: [], attempt: 2 })
  expect(() => h.engine.verify(h.id, { reportKey, state: 'passed', at: new Date().toISOString(), summary: 'Older pass', checks: [], attempt: 1 })).toThrow(/newer/)
  expect(h.ticket().verification?.attempt).toBe(2)
  expect(h.ticket().ended).toBeUndefined()
})

it('memory or remote-result corrections invalidate an in-flight review until the worker submits a new result', async () => {
  let release!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  const model = vi.fn(async (input: string) => { await waiting; return verdict(input) })
  const h = fixture(model), { updated } = await h.ready('{"total":2}')
  h.service.enqueue(updated)
  await vi.waitFor(() => expect(model).toHaveBeenCalledTimes(1))
  h.engine.note(h.id, 'A verified project fact changed; inspect it before completing this task.', 'memory-correction-r2')
  release(); await h.effects.idle('verification')
  h.service.tick(); await h.effects.idle('verification')
  expect(model).toHaveBeenCalledTimes(1)
  expect(h.service.view(h.id).verification).toBeNull()
  expect(h.service.history(h.id)[0]?.superseded).toBe(true)
  expect(h.ticket().ended).toBeUndefined()
})
