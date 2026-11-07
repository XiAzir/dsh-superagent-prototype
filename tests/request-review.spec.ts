/** Real SQLite coverage review: failure isolation, original authority, race protection and bounded recovery. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Engine, key, type Trigger, type Policy } from '../src/core/index.ts'
import { Store } from '../src/app/store.ts'
import { Effects } from '../src/app/effects.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { RequestReviewService } from '../src/app/request-review.ts'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
type Model = (input: string, signal: AbortSignal) => Promise<{ text: string }>
function fixture(model: Model) {
  const directory = mkdtempSync(join(tmpdir(), 'request-coverage-')), database = join(directory, 'state.sqlite')
  let clock = Date.parse('2026-11-07T00:00:00Z'), authorized = true, paused = false
  let store = new Store(database), effects = new Effects(store, new HealthBoard(), () => clock), controller = new AbortController()
  const starts = vi.fn(), pass = vi.fn(), recovered = vi.fn()
  const policy: Policy = { version: 'coverage-test', paused: false, evalTimeoutMs: 60_000, revalidate: () => authorized,
    admitsInferred: () => true, gate: () => authorized ? { admissible: true, strength: 'explicit', basis: { via: 'listed' } }
      : { admissible: false, reason: 'revoked' } }
  const createEngine = () => new Engine({ repo: store, provisionalRouting: true, policy: () => policy,
    scope: { scope: () => ({ listened: true, observed: false }) }, assessor: { request() {} },
    executor: { start: starts, deliver() {}, stop() {} }, outbox: { send() {}, status: () => undefined, withdraw() {} },
    now: () => new Date(clock).toISOString() })
  let engine = createEngine()
  const createService = () => new RequestReviewService({ store, engine, effects, runModel: model,
    authorized: () => authorized, paused: () => paused, lifetime: controller.signal, requestPass: pass, recovered, now: () => clock })
  let service = createService()
  effects.start()
  function source(id = 'original-action', text = '查看目前进度，并生成 export.csv。', extra: Partial<Trigger> = {}) {
    const trigger: Trigger = { id, text, human: true, routing: 'router', addressed: 'direct', at: new Date(clock++).toISOString(),
      source: 'web', actor: { source: 'web', id: 'owner' }, threads: [{ source: 'web', id: `room-${id}` }],
      channel: { source: 'web', thread: `web:room-${id}`, address: {} }, meta: {}, ...extra }
    engine.receive(trigger); engine.evaluateDue(); engine.decide(id, { kind: 'ignore', reason: 'Mistakenly treated as a status-only request.' })
    return trigger
  }
  const idle = () => effects.idle('request-review')
  const close = async () => { controller.abort(); await effects.drain(); store.close() }
  async function reopen() {
    await close(); store = new Store(database); effects = new Effects(store, new HealthBoard(), () => clock); controller = new AbortController()
    engine = createEngine(); service = createService(); effects.start()
  }
  cleanups.push(async () => { await close(); rmSync(directory, { recursive: true, force: true }) })
  return { get store() { return store }, get engine() { return engine }, get service() { return service }, get effects() { return effects },
    source, idle, reopen, starts, pass, recovered, authorize: (value: boolean) => { authorized = value },
    pause: (value: boolean) => { paused = value }, advance: (ms: number) => { clock += ms } }
}
const missed: Model = async () => ({ text: JSON.stringify({ state: 'needs_work', reason: 'The export action has no owner.', actionQuote: '生成 export.csv' }) })

it('reopens the exact original action after an ignore and preserves its stable manual receipt', async () => {
  const f = fixture(missed), source = f.source(), before = f.engine.requestResponsibility(source.id)!
  const id = f.service.submit(source.id, 'same-review-request')!
  await f.idle()
  expect(f.service.get(id)).toMatchObject({ state: 'needs_work', recovery: 'reopened', actionQuote: '生成 export.csv' })
  expect(f.store.triggers.get(source.id)).toEqual(source)
  expect(f.engine.requestResponsibility(source.id)).toMatchObject({ id: source.id, state: 'pending', revision: before.revision + 1 })
  expect(f.service.submit(source.id, 'same-review-request')).toBe(id)
  expect(f.starts).not.toHaveBeenCalled()
  expect(f.recovered).toHaveBeenCalledTimes(1)
  f.engine.evaluateDue()
  expect(f.engine.candidate(source.id)?.triggers[0]?.id).toBe(source.id)
})

it('records covered status and observed omissions without automatically changing ownership', async () => {
  const model = vi.fn(missed), f = fixture(model), source = f.source()
  f.service.config({ mode: 'observe' })
  const id = f.service.submit(source.id)!, before = f.engine.requestResponsibility(source.id)
  await f.idle()
  expect(f.service.get(id)).toMatchObject({ state: 'needs_work', recovery: 'observe' })
  expect(f.engine.requestResponsibility(source.id)).toEqual(before)
  model.mockImplementation(async () => ({ text: JSON.stringify({ state: 'covered', reason: 'The original only asks for saved progress.' }) }))
  const query = f.source('query', '目前进度如何？'), review = f.service.submit(query.id)!
  await f.idle(); expect(f.service.get(review)).toMatchObject({ state: 'covered', recovery: 'none' })
})

it('rejects invented action quotes and isolates model/protocol failures from routing state', async () => {
  const model = vi.fn<Model>().mockResolvedValueOnce({ text: JSON.stringify({ state: 'needs_work', reason: 'A new action', actionQuote: '删除全部任务' }) })
    .mockRejectedValueOnce(new Error('token="secret-must-stay-hidden" service unavailable')).mockResolvedValueOnce({ text: '{invalid' })
  const f = fixture(model)
  for (const id of ['unquoted', 'offline', 'malformed']) {
    const source = f.source(id), before = f.engine.requestResponsibility(id), review = f.service.submit(source.id)!
    await f.idle()
    expect(f.service.get(review)?.state).toBe('unknown')
    expect(JSON.stringify(f.service.get(review))).not.toContain('secret-must-stay-hidden')
    expect(f.engine.requestResponsibility(id)).toEqual(before)
  }
  expect(f.starts).not.toHaveBeenCalled()
})

it('refuses a stale result when ownership changes or authorization is revoked during inference', async () => {
  let change = () => {}
  const f = fixture(async (...args) => { change(); return missed(...args) })
  const source = f.source(), before = f.engine.requestResponsibility(source.id)!
  change = () => { f.engine.reopenRequest(source.id, 'Owner already corrected it', 'owner-repair', before.revision) }
  const id = f.service.submit(source.id)!
  await f.idle(); expect(f.service.get(id)?.state).toBe('superseded')
  const next = f.source('revoked')
  change = () => f.authorize(false)
  const nextId = f.service.submit(next.id)!
  await f.idle(); expect(f.service.get(nextId)?.state).toBe('superseded')
  expect(f.recovered).not.toHaveBeenCalled()
})

it('bounds repeated automatic corrections and resumes queued reviews across SQLite reopen', async () => {
  const f = fixture(missed), source = f.source()
  f.service.config({ mode: 'repair', maxRecoveries: 1, maxReviewsPerHour: 30 })
  const first = f.service.submit(source.id)!
  await f.idle(); expect(f.service.get(first)?.recovery).toBe('reopened')
  f.engine.evaluateDue(); f.engine.decide(source.id, { kind: 'ignore', reason: 'Second mistaken ignore' })
  f.pause(true)
  const second = f.service.submit(source.id)!
  await f.reopen(); f.pause(false); f.effects.kick(); await f.idle()
  expect(f.service.get(second)).toMatchObject({ state: 'needs_work', recovery: 'limit' })
  expect(f.engine.requestResponsibility(source.id)?.state).toBe('ignored')
})

it('keeps structured status controls, inferred observation and currently unauthorized inputs outside automatic review', async () => {
  const model = vi.fn(missed), f = fixture(model)
  const direct = f.source('structured', '查看状态', { meta: { action: 'status' } })
  const observed = f.source('observation', '生成 export.csv', { meta: { observation: { groupId: 'team' } } })
  expect(f.service.submit(direct.id)).toBeUndefined(); expect(f.service.submit(observed.id)).toBeUndefined()
  const unauthorized = f.source('unauthorized'); f.authorize(false)
  expect(f.service.submit(unauthorized.id)).toBeUndefined()
  expect(model).not.toHaveBeenCalled()
})

it('honors disabling or pausing coverage recovery while a model request is already running', async () => {
  for (const change of ['off', 'paused'] as const) {
    let alter = () => {}
    const f = fixture(async (...args) => { alter(); return missed(...args) }), source = f.source(change)
    const before = f.engine.requestResponsibility(source.id)
    alter = () => { if (change === 'off') f.service.config({ mode: 'off' }); else f.pause(true) }
    const id = f.service.submit(source.id)!
    await f.idle()
    expect(f.service.get(id)?.state).toBe('superseded')
    expect(f.engine.requestResponsibility(source.id)).toEqual(before)
    expect(f.recovered).not.toHaveBeenCalled()
  }
})

it('refreshes exact status receipts at execution and isolates other requests and sources sharing a thread', async () => {
  const model = vi.fn(async (_input: string) => ({ text: JSON.stringify({ state: 'covered', reason: 'Saved progress was answered.' }) }))
  const f = fixture(model), source = f.source('status', '进度如何？')
  const disposition = f.store.triggers.disposition(source.id)!
  const request = f.engine.requestResponsibility(source.id)!
  f.store.triggers.saveDisposition(source.id, { ...disposition, request: { ...request, state: 'answered', history: [
    ...request.history, { revision: request.revision, at: source.at, kind: 'status', ticketId: 'work' },
    { revision: request.revision, at: source.at, kind: 'status', ticketId: 'foreign' },
  ] } })
  f.pause(true)
  const id = f.service.submit(source.id)!
  expect(JSON.parse(f.service.get(id)!.input).savedReplies).toEqual([])
  f.store.receipts.add({ id: key('status-reply', source.id, 'work'), channel: source.channel!, text: '已处理 3/5 个文件。', kind: 'reply', ticketId: 'work', purpose: 'status' })
  f.store.receipts.add({ id: key('status-reply', source.id, 'foreign'), channel: { ...source.channel!, source: 'qq' }, text: '另一个来源的状态', kind: 'reply', ticketId: 'foreign', purpose: 'status' })
  f.store.receipts.add({ id: key('status-reply', 'other-request', 'work'), channel: source.channel!, text: '同会话的其他请求', kind: 'reply', ticketId: 'work', purpose: 'status' })
  f.pause(false); f.effects.kick(); await f.idle()
  expect(JSON.parse(model.mock.calls[0]![0]!).savedReplies).toEqual([
    expect.objectContaining({ id: key('status-reply', source.id, 'work'), text: '已处理 3/5 个文件。' }),
  ])
  expect(f.service.get(id)?.state).toBe('covered')
})

it('rechecks a status reply arriving during inference before applying an omission recovery', async () => {
  let f!: ReturnType<typeof fixture>, source!: Trigger
  const model = vi.fn<Model>().mockImplementationOnce(async (...args) => {
    f.store.receipts.add({ id: key('status-reply', source.id, 'work'), channel: source.channel!,
      text: '已记录状态，本次没有执行请求。', kind: 'reply', ticketId: 'work', purpose: 'status' })
    return missed(...args)
  }).mockImplementation(async () => ({ text: JSON.stringify({ state: 'covered', reason: 'Current saved reply covers the query.' }) }))
  f = fixture(model); source = f.source('late-status')
  const request = f.engine.requestResponsibility(source.id)!, disposition = f.store.triggers.disposition(source.id)!
  f.store.triggers.saveDisposition(source.id, { ...disposition, request: { ...request, state: 'answered', history: [
    ...request.history, { revision: request.revision, at: source.at, kind: 'status', ticketId: 'work' },
  ] } })
  const id = f.service.submit(source.id)!
  await f.idle()
  expect(f.service.get(id)?.state).toBe('queued')
  expect(f.engine.requestResponsibility(source.id)?.state).toBe('answered')
  f.advance(2001); f.effects.kick(); await f.idle()
  expect(f.service.get(id)?.state).toBe('covered')
  expect(model).toHaveBeenCalledTimes(2)
  expect(f.recovered).not.toHaveBeenCalled()
})

it('persists hourly model budgets across restart and resumes only in the next hour', async () => {
  const model = vi.fn(missed), f = fixture(model)
  f.service.config({ mode: 'observe', maxReviewsPerHour: 1 })
  const first = f.source('first'), second = f.source('second')
  const firstId = f.service.submit(first.id)!, secondId = f.service.submit(second.id)!
  await f.idle()
  expect(model).toHaveBeenCalledTimes(1)
  expect(f.service.get(firstId)?.state).toBe('needs_work')
  expect(f.service.get(secondId)?.state).toBe('queued')
  await f.reopen(); await f.idle()
  expect(model).toHaveBeenCalledTimes(1)
  f.advance(3_600_000); f.effects.kick(); await f.idle()
  expect(model).toHaveBeenCalledTimes(2)
  expect(f.service.get(secondId)?.state).toBe('needs_work')
})
