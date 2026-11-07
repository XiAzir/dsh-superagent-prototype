import { mkdtempSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { Store } from '../src/app/store.ts'
import { EvaluationLedger } from '../src/evaluation/ledger.ts'
import { pairedEvaluationSchedule, runAutonomyEvaluation } from '../src/evaluation/runner.ts'
import { AUTONOMY_TASK_SET_VERSION, replayFixtures } from '../src/evaluation/fixtures.ts'
import { cliEvaluationProvider, EvaluationProviderError, parseEvaluationRoute, type EvaluationProvider } from '../src/evaluation/provider.ts'

const directories: string[] = []
const temporary = () => { const path = mkdtempSync(join(tmpdir(), 'autonomy-evaluation-')); directories.push(path); return path }
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })

type FileTaskInput = Parameters<NonNullable<EvaluationProvider['executeTask']>>[0]
function filesFromInputs(input: FileTaskInput) {
  const content = (name: string) => input.existingFiles.find(file => file.name === name)!.content
  if (input.task === 'summary') {
    const { values } = JSON.parse(content('input.json')) as { values: number[] }
    const title = /标题使用“([^”]+)”/.exec(input.instruction)?.[1] ?? '数据汇总'
    return [{ name: 'summary.json', content: JSON.stringify({ count: values.length, total: values.reduce((sum, value) => sum + value, 0) }) },
      { name: 'report.txt', content: `${title}\n${JSON.stringify(values)}` }]
  }
  if (input.task === 'recovery') {
    const checkpoint = JSON.parse(content('effects.json')) as string[]
    return [{ name: 'receipt.json', content: JSON.stringify({ operationId: checkpoint[0], count: checkpoint.length }) }]
  }
  if (input.task === 'reproduction') {
    const observed = JSON.parse(content('observed-runtime.json')) as { input: string; result: { errorName: string } }
    return [{ name: 'reproduction.txt', content: `${observed.result.errorName}\n${observed.input}` }]
  }
  return [{ name: 'resumed.txt', content: content('external.txt') }]
}
function fileProvider(executeTask: NonNullable<EvaluationProvider['executeTask']> = async input => ({ files: filesFromInputs(input) })): EvaluationProvider {
  return { name: 'observed-files-provider', executeTask, route: async ({ trigger, tickets }) => ({ decision: trigger.text === '这份汇总后续会用于内部核对。'
    ? { kind: 'attach', ticketId: tickets.find(ticket => ticket.sourceText.includes('summary.json'))!.id }
    : { kind: 'accept', title: trigger.text.slice(0, 50) } }) }
}

it('keeps durable, deduplicated runtime measurements and distinguishes absent usage and judgments', () => {
  const directory = temporary(), path = join(directory, 'state.sqlite')
  let store = new Store(path), ledger = new EvaluationLedger(store, { runId: 'test' })
  const request = { id: 'request', kind: 'request' as const, ticketId: 'task', at: '2026-11-07T00:00:00.000Z' }
  ledger.record(request); ledger.record(request)
  ledger.record({ id: 'route', kind: 'route', data: { path: 'router', durationMs: 15 } })
  expect(ledger.summary().metrics).toMatchObject({ tokens: null, cost: null, wrongRoutes: null, falseCompletions: null, adoptionRate: null })
  ledger.record({ id: 'usage-one', kind: 'usage', data: { tokens: 120, cost: 0.02 } })
  ledger.record({ id: 'usage-two', kind: 'usage', data: { tokens: null, cost: null } })
  ledger.record({ id: 'completion', kind: 'completion', ticketId: 'task', at: '2026-11-07T00:00:02.000Z', data: { correct: true, published: true } })
  store.close(); store = new Store(path); ledger = new EvaluationLedger(store, { runId: 'test' })
  expect(ledger.summary()).toMatchObject({ events: 5, knownUsage: { tokens: 120, unknownTokens: 1, unknownCost: 1 },
    metrics: { tokens: null, cost: null, falseCompletions: 0, completionLatencyMs: { p50: 2000, p95: 2000 } } })
  expect(() => ledger.record({ ...request, ticketId: 'different' })).toThrow('reused')
  store.close()
})

it('runs real Engine and SQLite event replay with actual file generation, verification and host restart recovery', async () => {
  const result = await runAutonomyEvaluation({ directory: temporary(), mode: 'structured-fast-path', runId: 'real-fixtures', gitRevision: 'test-revision' })
  expect(result.failures).toEqual([])
  expect(result.tasks.map(task => task.task)).toEqual(['recovery', 'reproduction', 'summary', 'waiting'])
  expect(result.tasks.every(task => task.passed && task.files.every(file => /^[a-f0-9]{64}$/.test(file.sha256)))).toBe(true)
  expect(result.summary.metrics).toMatchObject({ wrongRoutes: 0, falseCompletions: 0, duplicateSideEffects: 0,
    tokens: null, cost: null, adoptionRate: null, recoveryLatencyMs: { count: 1 } })
  const summary = JSON.parse(await readFile(join(result.output.result, '..', 'tasks', 'summary', 'summary.json'), 'utf8'))
  expect(summary).toEqual({ count: 3, total: 15 })
  const events = JSON.parse(await readFile(result.output.events, 'utf8')) as unknown[]
  expect(events.length).toBe(result.summary.events)
  const persisted = JSON.parse(await readFile(result.output.result, 'utf8'))
  expect(persisted.routingPolicy).toBe('fixture-oracle')
  expect(persisted.model).toBeNull()
  expect(persisted.taskSetVersion).toBe('autonomy-fixtures-v4')
}, 20000)

it('gives the provider public schemas, original source context and a real host JSON.parse observation before file generation', async () => {
  const directory = temporary(), tasks: FileTaskInput[] = [], provider = fileProvider(async input => {
    tasks.push(input)
    const files = filesFromInputs(input)
    if (input.task === 'summary') files.find(file => file.name === 'report.txt')!.content = '经核实的汇总\n原始数据：[3, 5, 7]'
    if (input.task === 'reproduction') {
      const observed = input.existingFiles.find(file => file.name === 'observed-runtime.json')!
      expect(observed.content).toBe(await readFile(join(directory, 'tasks', 'reproduction', 'observed-runtime.json'), 'utf8'))
      expect(JSON.parse(observed.content)).toMatchObject({ parser: 'Node.js JSON.parse', nodeVersion: process.versions.node,
        inputFile: 'invalid.json', input: '{invalid-json}', result: { state: 'threw', errorName: 'SyntaxError', errorMessage: expect.any(String) } })
    }
    return { files }
  })
  const contexts: Parameters<EvaluationProvider['route']>[0][] = [], route = provider.route
  provider.route = async input => { contexts.push(input); return route(input) }
  const result = await runAutonomyEvaluation({ directory, mode: 'structured-fast-path', provider })
  expect(result.taskSetVersion).toBe(AUTONOMY_TASK_SET_VERSION)
  expect(result.failures).toEqual([])
  expect(result.tasks.every(task => task.passed)).toBe(true)
  expect(tasks.find(input => input.task === 'summary')?.instruction).toContain('count 字段为数据总数，total 字段为合计')
  expect(tasks.find(input => input.task === 'recovery')?.instruction).toContain('operationId 字段为 "fixture-operation"，count 字段为该操作的记账次数，成功时应为 1')
  expect(tasks.find(input => input.task === 'reproduction')?.instruction).toContain('Node.js JSON.parse')
  expect(tasks.find(input => input.task === 'reproduction')?.instruction).toContain('实际错误名称和原始输入')
  const exposed = contexts.flatMap(input => input.tickets)
  expect(exposed.length).toBeGreaterThan(0)
  for (const ticket of exposed) {
    const origin = replayFixtures.find(event => event.text === ticket.sourceText)!
    const source = origin.kind === 'observation' ? 'qq' : 'evaluation'
    expect(ticket.source).toBe(source)
    expect(ticket.threads).toEqual([{ source, id: origin.thread }])
  }
  expect(JSON.stringify(contexts)).not.toContain('"expected":')
  expect(result.summary.metrics.wrongRoutes).toBe(0)
}, 20000)

it('composes the production Router policy for a selected profile and retains exact provider inputs and outputs', async () => {
  const directory = temporary(), provider = fileProvider(), route = provider.route
  const inputs: Parameters<EvaluationProvider['route']>[0][] = []
  provider.route = async input => { inputs.push(input); return route(input) }
  const result = await runAutonomyEvaluation({ directory, mode: 'structured-fast-path', promptProfile: 'repository', provider })
  expect(result.failures).toEqual([])
  expect(result.promptProfile).toBe('repository')
  const prompt = JSON.parse(await readFile(result.output.prompt!, 'utf8'))
  expect(prompt.text).toContain('## Policy')
  expect(prompt.text).toContain('orchestrator_route')
  expect(prompt.sha256).toBe(createHash('sha256').update(prompt.text).digest('hex'))
  expect(result.promptHash).toBe(prompt.sha256)
  expect(inputs.every(input => input.routerPrompt?.text === prompt.text)).toBe(true)
  const traces = JSON.parse(await readFile(result.output.traces, 'utf8')) as { task: string; input: unknown; inputSha256: string; output: string; state: string }[]
  expect(traces.length).toBeGreaterThan(inputs.length)
  expect(traces.every(trace => trace.state === 'valid' && trace.output)).toBe(true)
  for (const trace of traces) expect(trace.inputSha256).toBe(createHash('sha256').update(JSON.stringify(trace.input)).digest('hex'))
  const origin = replayFixtures.find(event => event.id === 'waiting-request')!
  expect(origin.text).toContain('新建一项独立任务')
  expect(origin.text).not.toContain('继续原工单')
  const store = new Store(result.output.database)
  const followup = store.triggers.get('evaluation-waiting-continuation')!
  const waiting = store.tickets.list().find(ticket => ticket.origin.triggerId === 'evaluation-waiting-request')!
  expect(followup.text).toContain(waiting.id)
  expect(followup.text).not.toContain('{{ticket:')
  store.close()
  expect(result.interpretation.join(' ')).toContain('Routing replay completes before any worker concurrency')
}, 20000)

it('pairs repeated modes on the same workload, rotates order and keeps a finite repeat limit', () => {
  const modes = ['router-first', 'single-worker'] as const
  expect(pairedEvaluationSchedule([...modes], 2)).toEqual([
    { replicate: 1, mode: 'router-first' }, { replicate: 1, mode: 'single-worker' },
    { replicate: 2, mode: 'single-worker' }, { replicate: 2, mode: 'router-first' },
  ])
  for (const repeats of [0, 21, 1.5]) expect(() => pairedEvaluationSchedule([...modes], repeats)).toThrow('1 to 20')
})

it('normalizes only semantically unused null route fields and rejects missing attachment targets', () => {
  expect(parseEvaluationRoute({ decision: { kind: 'accept', ticketId: null, title: null } })).toEqual({
    response: { decision: { kind: 'accept' } }, normalizations: [
      'Omitted an unused null ticketId for accept/ignore.', 'Omitted an optional null title.',
    ],
  })
  for (const kind of ['attach', 'stop', 'status']) {
    expect(() => parseEvaluationRoute({ decision: { kind, ticketId: null } })).toThrow()
    expect(() => parseEvaluationRoute({ decision: { kind } })).toThrow('real ticketId')
  }
})

it('retains the exact invalid provider response and usage before schema validation rejects it', async () => {
  const modelTrace = { input: { model: 'fixture', messages: [{ role: 'user', content: 'continue task' }] },
    output: '```json\n{"decision":{"kind":"attach","ticketId":null}}\n```', model: 'fixture', finishReason: 'stop' }
  const raw = JSON.stringify({ decision: { kind: 'attach', ticketId: null }, usage: { tokens: 23, cost: 0.02 }, evaluationTrace: modelTrace })
  const provider = cliEvaluationProvider([process.execPath, '-e', `process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(${JSON.stringify(raw)}))`],
    { name: 'invalid-route-fixture', timeoutMs: 10000 })
  const input = { trigger: { id: 'invalid-message', source: 'fixture', actor: { source: 'fixture', id: 'owner' }, human: true,
    text: 'continue task', at: new Date().toISOString(), meta: {}, threads: [{ source: 'fixture', id: 'room' }] }, tickets: [] }
  let failure: unknown
  try { await provider.route(input) } catch (error) { failure = error }
  expect(failure).toBeInstanceOf(EvaluationProviderError)
  expect((failure as EvaluationProviderError).trace).toMatchObject({ state: 'invalid', output: raw, usage: { tokens: 23, cost: 0.02 }, provider: modelTrace })
  expect(provider.traces?.()).toHaveLength(1)
  const trace = provider.traces!()[0]!
  expect(trace.outputSha256).toBe(createHash('sha256').update(raw).digest('hex'))
  expect((trace.input as { context: unknown }).context).toEqual(input)
})

it.each([
  { list: '[\n 3,\n 5,\n 7\n]', passed: true },
  { list: '[3, 5, 70]', passed: false },
  { list: '[3, 5, 7, 9]', passed: false },
  { list: '[-3, 5, 7]', passed: false },
])('checks the same numeric list with whitespace tolerance while retaining exact values: $list', async ({ list, passed }) => {
  const provider = fileProvider(async input => {
    const files = filesFromInputs(input)
    if (input.task === 'summary') files.find(file => file.name === 'report.txt')!.content = `经核实的汇总\n原始数据：${list}`
    return { files }
  })
  const result = await runAutonomyEvaluation({ directory: temporary(), mode: 'structured-fast-path', provider })
  expect(result.tasks.find(task => task.task === 'summary')?.passed).toBe(passed)
  expect(result.tasks.filter(task => task.task !== 'summary').every(task => task.passed)).toBe(true)
  expect(result.summary.metrics.wrongRoutes).toBe(0)
  expect(result.failures.filter(failure => failure.task === 'summary')).toHaveLength(passed ? 0 : 1)
}, 20000)

it.each(['omitted-name', 'wrong-name'] as const)('rejects a reproduction report that ignores the observed error name: %s', async kind => {
  const provider = fileProvider(async input => {
    const files = filesFromInputs(input)
    if (input.task === 'reproduction') {
      const observed = JSON.parse(input.existingFiles.find(file => file.name === 'observed-runtime.json')!.content)
      files[0]!.content = `${kind === 'omitted-name' ? 'JSON parse error' : 'TypeError'}\n${observed.input}`
    }
    return { files }
  })
  const result = await runAutonomyEvaluation({ directory: temporary(), mode: 'structured-fast-path', provider })
  expect(result.tasks.find(task => task.task === 'reproduction')?.passed).toBe(false)
  expect(result.tasks.filter(task => task.task !== 'reproduction').every(task => task.passed)).toBe(true)
  expect(result.failures).toContainEqual({ task: 'reproduction', reason: 'Reproduction must record the host-observed error name and original input.' })
  expect(result.summary.metrics).toMatchObject({ wrongRoutes: 0, preventedFalseCompletions: 1, falseCompletions: 0 })
}, 20000)

it('measures the routing calls saved by deterministic controls against the same replay workload', async () => {
  const baseline = await runAutonomyEvaluation({ directory: temporary(), mode: 'router-first', runId: 'router-first' })
  const optimized = await runAutonomyEvaluation({ directory: temporary(), mode: 'subscription-fast-path', runId: 'subscription' })
  expect(baseline.failures).toEqual([]); expect(optimized.failures).toEqual([])
  expect(optimized.summary.metrics.routerDecisions).toBeLessThan(baseline.summary.metrics.routerDecisions)
  expect(optimized.summary.metrics.wrongRoutes).toBe(0)
  expect(optimized.routingPolicy).toBe('fixture-oracle')
  expect(optimized.interpretation.join(' ')).toContain('does not measure model coding ability')
}, 30000)

it('withholds scoring expectations from provider input and records wrong model routes without inventing usage', async () => {
  const inputs: unknown[] = []
  const result = await runAutonomyEvaluation({ directory: temporary(), mode: 'router-first', runId: 'bad-provider',
    provider: { name: 'test-provider', model: 'test-model', route: async input => {
      inputs.push(input)
      if (inputs.length === 1) throw new Error('Authorization: Bearer sk-private-evaluation-fixture-token')
      return { decision: { kind: 'ignore' } }
    } } })
  expect(result.failures.length).toBeGreaterThan(0)
  expect(result.summary.metrics.wrongRoutes).toBeGreaterThan(0)
  expect(result.model).toEqual({ provider: 'test-provider', model: 'test-model' })
  expect(result.summary.metrics.tokens).toBeNull()
  expect(JSON.stringify(inputs)).not.toContain('expected')
  expect(JSON.stringify(inputs)).not.toContain('fixture-oracle')
  expect(JSON.stringify(result.failures)).not.toContain('sk-private-evaluation-fixture-token')
}, 20000)

it('rejects incorrect provider files through independent real checks and retains the failed verification', async () => {
  const result = await runAutonomyEvaluation({ directory: temporary(), mode: 'structured-fast-path', runId: 'bad-files', provider: {
    name: 'test-files-provider', route: async input => ({ decision: { kind: 'accept', title: input.trigger.text.slice(0, 50) } }),
    executeTask: async input => ({ files: input.task === 'summary' ? [] : input.outputNames.map(name => ({ name, content: name.endsWith('.json') ? '{}' : 'incorrect' })) }),
  } })
  expect(result.tasks).toHaveLength(4)
  expect(result.tasks.every(task => !task.passed)).toBe(true)
  expect(result.summary.metrics.preventedFalseCompletions).toBe(4)
  expect(result.summary.metrics.falseCompletions).toBe(0)
  const store = new Store(result.output.database)
  expect(store.tickets.list().filter(ticket => ticket.verification?.state === 'needs_changes')).toHaveLength(4)
  store.close()
}, 20000)

it('uses the configured provider JSON protocol in a separate process with measured counters', async () => {
  const provider = cliEvaluationProvider([process.execPath, '-e',
    "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{const x=JSON.parse(s);process.stdout.write(JSON.stringify({decision:{kind:x.task==='route'?'ignore':'stop'},usage:{tokens:17,cost:0.01}}))})"], { name: 'local-protocol-fixture', timeoutMs: 10000 })
  const response = await provider.route({ trigger: { id: 'message', source: 'fixture', actor: { source: 'fixture', id: 'owner' }, human: true,
    text: 'chat', at: new Date().toISOString(), meta: {}, threads: [{ source: 'fixture', id: 'room' }] }, tickets: [] })
  expect(response).toEqual({ decision: { kind: 'ignore' }, usage: { tokens: 17, cost: 0.01 } })
})
