/** Real Engine/SQLite event replay plus file-producing subprocess tasks and a crash checkpoint. */
import { createHash } from 'node:crypto'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { Engine, latestAssignment, liveTicket, type Trigger } from '../core/index.ts'
import { completionKey } from '../core/verification.ts'
import { Store } from '../app/store.ts'
import { Prompts, defaultPrompts } from '../app/prompts.ts'
import { safeFailureMessage } from '../app/session-failures.ts'
import { SettingsSchema, SourcePolicySchema, settingsPolicy } from '../policy.ts'
import { SourceRegistry } from '../sources/registry.ts'
import { runCommand } from '../../scripts/dsh-superagent-watchdog.mjs'
import { EvaluationLedger, type EvaluationSummary } from './ledger.ts'
import { AUTONOMY_TASK_SET_VERSION, replayFixtures, taskFixtures, type FixtureTask, type ReplayFixture } from './fixtures.ts'
import { EvaluationProviderError, evaluationEnvironment, type EvaluationCallTrace, type EvaluationProvider, type EvaluationRoute,
  type EvaluationRouterPrompt, type EvaluationUsage } from './provider.ts'

export type EvaluationMode = 'router-first' | 'structured-fast-path' | 'subscription-fast-path' | 'single-worker'
export interface AutonomyEvaluationOptions {
  directory: string; mode?: EvaluationMode; runId?: string; gitRevision?: string; buildHash?: string
  provider?: EvaluationProvider
  promptProfile?: 'protocol' | 'repository' | 'personal'
  replicate?: number
}
export interface AutonomyEvaluationResult {
  schema: 1; runId: string; startedAt: string; finishedAt: string; taskSetVersion: string; gitRevision: string | null
  mode: EvaluationMode; configHash: string; buildHash: string | null; model: { provider: string; model: string | null } | null
  routingPolicy: 'fixture-oracle' | 'provider'; executionPolicy: 'fixture-programs' | 'provider-files'
  promptProfile: 'protocol' | 'repository' | 'personal'; promptHash: string | null; replicate: number
  interpretation: string[]; summary: EvaluationSummary; failures: { eventId?: string; task?: string; reason: string }[]
  routes: { eventId: string; path: string; kind: string; correct: boolean; ticketId?: string }[]
  tasks: { task: FixtureTask; ticketId: string; passed: boolean; files: { name: string; sha256: string; bytes: number }[] }[]
  requestOutcomes: { task: FixtureTask; triggerId: string; state: string; ownerTicketIds: string[] }[]
  output: { database: string; result: string; events: string; traces: string; prompt?: string }
}
const PROGRAM = String.raw`const fs=require('node:fs');const s=JSON.parse(fs.readFileSync(0,'utf8'));process.chdir(s.directory);
if(s.externalEvent){fs.writeFileSync('external.txt','external-ready');process.exit(0);}
if(s.checkpoint){let a=fs.existsSync('effects.json')?JSON.parse(fs.readFileSync('effects.json','utf8')):[];if(!a.includes('fixture-operation')){a.push('fixture-operation');fs.writeFileSync('effects.json',JSON.stringify(a));}process.exit(23);}
if(s.observeRuntime){const input=fs.readFileSync('invalid.json','utf8');let result;try{result={state:'returned',value:JSON.parse(input)}}catch(e){result={state:'threw',errorName:e.name,errorMessage:e.message}}fs.writeFileSync('observed-runtime.json',JSON.stringify({parser:'Node.js JSON.parse',nodeVersion:process.versions.node,inputFile:'invalid.json',input,result}));process.exit(0);}
if(!s.providerGenerated){
 if(s.task==='summary'){const a=JSON.parse(fs.readFileSync('input.json','utf8')).values;fs.writeFileSync('summary.json',JSON.stringify({count:a.length,total:a.reduce((x,y)=>x+y,0)}));fs.writeFileSync('report.txt',s.title+String.fromCharCode(10)+(s.includeOriginal?a.join(','):''));}
 if(s.task==='recovery'){const a=JSON.parse(fs.readFileSync('effects.json','utf8'));fs.writeFileSync('receipt.json',JSON.stringify({operationId:'fixture-operation',count:a.length}));}
 if(s.task==='reproduction'){const a=JSON.parse(fs.readFileSync('observed-runtime.json','utf8'));fs.writeFileSync('reproduction.txt',a.result.errorName+String.fromCharCode(10)+a.input);}
 if(s.task==='waiting'){fs.writeFileSync('resumed.txt',fs.readFileSync('external.txt','utf8'));}
 if(s.task==='stopped'){const a=JSON.parse(fs.readFileSync('input.json','utf8'));fs.writeFileSync('filtered.json',JSON.stringify(a.filter(x=>x%2)));}
}process.stdout.write(JSON.stringify({executed:true}));`
const VERIFY = String.raw`const fs=require('node:fs');const s=JSON.parse(fs.readFileSync(0,'utf8'));process.chdir(s.directory);let passed=false;let reason='';let count;
try{if(s.task==='summary'){const a=JSON.parse(fs.readFileSync('summary.json','utf8'));const r=fs.readFileSync('report.txt','utf8');const values=JSON.parse(fs.readFileSync('input.json','utf8')).values;const lists=r.match(/[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?(?:\s*,\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)+/gi)||[];passed=a.count===3&&a.total===15&&r.includes('经核实的汇总')&&lists.some(list=>JSON.stringify(list.split(',').map(Number))===JSON.stringify(values));}
if(s.task==='recovery'){const a=JSON.parse(fs.readFileSync('receipt.json','utf8'));const e=JSON.parse(fs.readFileSync('effects.json','utf8'));count=e.filter(x=>x==='fixture-operation').length;passed=a.count===1&&a.operationId==='fixture-operation'&&count===1;}
if(s.task==='reproduction'){const a=fs.readFileSync('reproduction.txt','utf8');const input=fs.readFileSync('invalid.json','utf8');const observed=JSON.parse(fs.readFileSync('observed-runtime.json','utf8'));let errorName;try{JSON.parse(input)}catch(e){errorName=e.name}passed=typeof errorName==='string'&&observed.parser==='Node.js JSON.parse'&&observed.input===input&&observed.result.state==='threw'&&observed.result.errorName===errorName&&a.includes(errorName)&&a.includes(input);if(!passed)reason='Reproduction must record the host-observed error name and original input.';}
if(s.task==='waiting'){passed=fs.readFileSync('resumed.txt','utf8')==='external-ready';}
}catch(e){reason=e.message}process.stdout.write(JSON.stringify({passed,reason,...count===undefined?{}:{sideEffectCount:count}}));`
const sha = (text: string | Uint8Array) => createHash('sha256').update(text).digest('hex')
const now = () => new Date().toISOString()
const fixtureById = new Map(replayFixtures.map(event => [event.id, event]))

/** Rotate mode order within each paired repeat while every mode receives the same fixed event set. */
export function pairedEvaluationSchedule(modes: EvaluationMode[], repeats = 1): { replicate: number; mode: EvaluationMode }[] {
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 20) throw new Error('Evaluation repeats must be an integer from 1 to 20')
  if (!modes.length || new Set(modes).size !== modes.length || modes.some(mode => !['router-first', 'structured-fast-path', 'subscription-fast-path', 'single-worker'].includes(mode))) {
    throw new Error('Choose distinct supported evaluation modes')
  }
  return Array.from({ length: repeats }, (_, index) => [...modes.slice(index % modes.length), ...modes.slice(0, index % modes.length)]
    .map(mode => ({ replicate: index + 1, mode }))).flat()
}

export async function runAutonomyEvaluation(options: AutonomyEvaluationOptions): Promise<AutonomyEvaluationResult> {
  const mode = options.mode ?? 'structured-fast-path', startedAt = now()
  const promptProfile = options.promptProfile ?? 'protocol', replicate = options.replicate ?? 1
  if (!['protocol', 'repository', 'personal'].includes(promptProfile)) throw new Error('Unsupported prompt profile')
  if (!Number.isInteger(replicate) || replicate < 1 || replicate > 20) throw new Error('Invalid evaluation replicate')
  if (!['router-first', 'structured-fast-path', 'subscription-fast-path', 'single-worker'].includes(mode)) throw new Error('Unsupported evaluation mode')
  const runId = options.runId ?? `${startedAt.replace(/[:.]/g, '-')}-${mode}`
  if (!/^[a-zA-Z0-9._-]{1,120}$/.test(runId)) throw new Error('Invalid evaluation run ID')
  const directory = resolve(options.directory), database = join(directory, 'state.sqlite')
  await mkdir(directory, { recursive: true })
  // A new run owns its own state. Reusing a directory with different records is refused by the ledger.
  let store = new Store(database), ledger = new EvaluationLedger(store, { runId })
  if (store.get('evaluation-run-owner')) { store.close(); throw new Error('Evaluation output directory already contains a run; choose a fresh directory.') }
  store.set('evaluation-run-owner', runId)
  const logical = new Map<FixtureTask, string>(), ticketTasks = new Map<string, FixtureTask>(), queued = new Map<string, string>()
  const requestTimes = new Map<string, number>(), resultTasks: AutonomyEvaluationResult['tasks'] = [], routes: AutonomyEvaluationResult['routes'] = []
  const failures: AutonomyEvaluationResult['failures'] = []
  const providerTraceOffset = options.provider?.traces?.().length ?? 0, traces: EvaluationCallTrace[] = []
  const settings = SettingsSchema.parse({ eval: { mode: 'auto' }, policy: { rules: [{ id: 'fixture', name: 'Fixture reproduction', enabled: true,
    instruction: 'Reproduce the specific malformed JSON defect in the isolated evaluation directory and record actual evidence silently.' }],
    sources: { evaluation: { allowed: [{ id: 'owner' }] }, qq: { allowed: [{ id: '12345' }] },
      ci: { allowed: [], admission: { fixture: { unlistedUnaddressed: 'inferred' } } } } },
    sources: { evaluation: { enabled: true, config: {} }, qq: { enabled: true, config: {} }, ci: { enabled: true, config: {} } } })
  store.saveSettings(settings)
  const routerPrompt: EvaluationRouterPrompt | undefined = promptProfile === 'protocol' ? undefined : (() => {
    const prompts = new Prompts(store, () => 1_000_000, () => undefined, () => false, () => false, () => promptProfile === 'personal')
    const text = prompts.compose(defaultPrompts(), 'orchestrator', undefined)
    return { profile: promptProfile, text, sha256: sha(text) }
  })()
  if (routerPrompt) await writeFile(join(directory, 'router-prompt.json'), JSON.stringify({ ...routerPrompt,
    composition: 'Production Prompts.compose defaults with isolated fixture policy, no private installation overrides or execution environment.',
    adaptation: 'The provider returns the evaluation JSON decision protocol instead of invoking DSH tools.' }, null, 2), { mode: 0o600 })
  const invoke = async <T>(task: EvaluationCallTrace['task'], input: unknown, run: () => Promise<T>): Promise<T> => {
    if (options.provider?.traces) return run()
    const started = performance.now(), trace: EvaluationCallTrace = { at: now(), task, transport: 'in-process', input,
      inputSha256: sha(JSON.stringify(input)), normalizations: [], state: 'running' }
    traces.push(trace)
    try {
      const output = await run(); trace.output = JSON.stringify(output); trace.outputSha256 = sha(trace.output)
      trace.normalized = output; trace.usage = (output as { usage?: EvaluationUsage }).usage; trace.state = 'valid'; return output
    } catch (error) { trace.state = 'failed'; trace.error = safeFailureMessage(error); throw error }
    finally { trace.durationMs = performance.now() - started }
  }
  const makeSources = () => {
    const sources = new SourceRegistry(() => store.settings())
    for (const source of ['evaluation', 'qq', 'ci']) sources.register({ kind: source, title: { zh: source, en: source },
      description: { zh: 'Isolated evaluation fixture', en: 'Isolated evaluation fixture' }, schema: z.object({}).strict(), fields: [], health: [],
      scope: () => ({ listened: true, observed: source !== 'evaluation', row: 'fixture' }),
      policy: { schema: SourcePolicySchema, fields: [], explicit: { zh: 'Fixture owner request', en: 'Fixture owner request' } } })
    return sources
  }
  const makeEngine = () => {
    const sources = makeSources()
    return new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources),
      assessor: { request: () => {} }, executor: { start: (ticket, assignment) => { queued.set(ticket.id, assignment.id) },
        deliver: (ticket, assignment) => { engine.inputsDelivered(ticket.id, assignment.id, [...ticket.undelivered]) }, stop: ticket => { queued.delete(ticket.id) } },
      outbox: { send: message => { store.receipts.add(message); store.receipts.settle(message, 'sent') },
        status: id => store.receipts.get(id)?.status, withdraw: () => {} },
      prepareTicket: ticket => ({ ...ticket, acceptance: { revision: 1, mode: 'enforce', createdAt: now(),
        criteria: [{ id: 'fixture-output', description: 'Output satisfies the original fixture request and corrections.', kind: 'artifact', sourceRefs: [`trigger/${ticket.origin.triggerId}`] }] } }) })
  }
  let engine = makeEngine()
  const originalTaskTrigger = (task: FixtureTask) => replayFixtures.find(event => event.task === task && !event.duplicateOf)
  const currentTaskOwner = (task: FixtureTask): string | undefined => {
    const original = originalTaskTrigger(task), request = original && engine.requestResponsibility(`evaluation-${original.id}`)
    const owners = request?.owners ?? []
    return owners.find(owner => owner.state === 'claimed' || owner.state === 'proposed')?.ticketId
      ?? owners.find(owner => owner.state === 'completed' || owner.state === 'cancelled')?.ticketId ?? logical.get(task)
  }
  const usage = (id: string, value?: EvaluationUsage, ticketId?: string) => {
    if (options.provider) ledger.record({ id: `usage:${id}`, kind: 'usage', ...ticketId ? { ticketId } : {},
      data: { tokens: value?.tokens ?? null, cost: value?.cost ?? null, provider: options.provider.name, model: options.provider.model ?? null } })
  }
  const triggerFor = (event: ReplayFixture): Trigger => {
    const original = event.duplicateOf ? fixtureById.get(event.duplicateOf)! : event
    const source = original.kind === 'observation' ? 'qq' : original.kind === 'ci' ? 'ci' : 'evaluation'
    const subscription = mode === 'subscription-fast-path' && ['followup', 'correction'].includes(original.kind)
    const text = original.text.replace(/\{\{ticket:([a-z]+)\}\}/g, (_match, task: FixtureTask) => currentTaskOwner(task) ?? `unresolved-${task}`)
    return { id: `evaluation-${original.id}`, source, actor: { source, id: source === 'ci' ? '' : source === 'qq' ? '12345' : 'owner' },
      human: source !== 'ci', ...source !== 'ci' && original.kind !== 'noise' && original.kind !== 'observation' ? { addressed: 'direct' as const } : {},
      ...source !== 'ci' && !subscription ? { routing: 'router' as const } : {},
      threads: [{ source: source === 'qq' ? 'qq' : 'evaluation', id: original.thread }], text, at: now(),
      channel: { source: source === 'qq' ? 'qq' : 'evaluation', thread: `${source === 'qq' ? 'qq' : 'evaluation'}:${original.thread}`, address: { fixture: original.thread } },
      meta: { ...original.control ? { action: original.control, ...original.target && currentTaskOwner(original.target) ? { targetTicketId: currentTaskOwner(original.target)! } : {} } : {},
        ...original.referenceTask && currentTaskOwner(original.referenceTask) ? { referencedTicketId: currentTaskOwner(original.referenceTask) } : {},
        ...source === 'qq' ? { observation: { groupId: '23456', windowId: original.thread } } : {} } }
  }
  const oracle = (event: ReplayFixture): EvaluationRoute => ({ kind: event.expected.kind === 'duplicate' ? 'ignore' : event.expected.kind,
    ...event.expected.target && currentTaskOwner(event.expected.target) ? { ticketId: currentTaskOwner(event.expected.target)! } : {}, title: event.task ?? event.text.slice(0, 80) })
  try {
    for (const event of replayFixtures) {
      const before = performance.now(), trigger = triggerFor(event), expectedTarget = event.expected.target && currentTaskOwner(event.expected.target)
      let path = 'router', actual = 'ignore', target: string | undefined
      try {
        const direct = (mode === 'structured-fast-path' || mode === 'subscription-fast-path') && !!event.control && !!expectedTarget
        if (direct) {
          target = expectedTarget
          if (event.control === 'supplement') { engine.direct(target!, trigger); actual = 'attach'; path = 'direct' }
          else {
            store.triggers.save(trigger); store.triggers.saveDisposition(trigger.id, { fanout: [], matched: [target!], routing: 'handled', at: now() })
            if (event.control === 'status') { engine.status(target!, trigger.id); actual = 'status'; path = 'snapshot' }
            else { engine.stopTicket(target!, 'Explicit fixture stop'); actual = 'stop'; path = 'stop' }
          }
        } else {
          const received = engine.receive(trigger)
          engine.evaluateDue()
          const disposition = store.triggers.disposition(trigger.id)
          if (received === 'duplicate') { actual = 'duplicate'; path = 'deduplicated' }
          else if (event.kind === 'noise') { actual = 'ignore'; path = 'filter' }
          else if ((disposition?.fanout.length ?? 0) > 0 && ['ci', 'followup', 'correction'].includes(event.kind)) {
            actual = 'attach'; target = disposition!.fanout[0]; path = 'subscription'
            if (engine.candidate(trigger.id)) engine.decide(trigger.id, { kind: 'ignore', reason: 'Already delivered to its subscribed fixture worker.' })
          } else {
            let decision = oracle(event)
            if (options.provider) {
              try {
                const input = { trigger, tickets: store.tickets.list().map(ticket => {
                  const origin = store.triggers.get(ticket.origin.triggerId)
                  return { id: ticket.id, title: ticket.title, ended: !liveTicket(ticket), sourceText: origin?.text ?? '',
                    ...(origin ? { source: origin.source, threads: origin.threads } : {}) }
                }), ...routerPrompt ? { routerPrompt } : {} }
                const response = await invoke('route', input, () => options.provider!.route(input))
                decision = response.decision; usage(`route:${event.id}`, response.usage)
              } catch (error) { usage(`route:${event.id}`, error instanceof EvaluationProviderError ? error.trace.usage : undefined); throw error }
            }
            actual = decision.kind; target = decision.ticketId
            if (decision.kind === 'accept') {
              const accepted = engine.decide(trigger.id, { kind: 'accept', title: decision.title ?? trigger.text.slice(0, 100), scope: trigger.text,
                reason: 'Isolated evaluation request', ...event.kind === 'observation' ? { rules: ['fixture'] } : {} })
              target = accepted.ticketId
              if (target && event.task) {
                logical.set(event.task, target); ticketTasks.set(target, event.task); requestTimes.set(target, Date.now())
                ledger.record({ id: `request:${event.id}`, kind: 'request', ticketId: target, triggerId: trigger.id })
              }
            } else if (decision.kind === 'attach') {
              // Even the expensive Router path retains an explicit control's target/cancellation semantics.
              if (event.control === 'supplement') {
                // The Router invokes the actual direct port as a separate, referenced control operation.
                engine.decide(trigger.id, { kind: 'ignore', reason: 'This structured request is executed by the directed control port.' })
                engine.direct(target!, { ...trigger, id: `${trigger.id}:direct-control`, meta: { ...trigger.meta, originalTriggerId: trigger.id } })
              } else engine.attach(target!, trigger.id)
            }
            else if (decision.kind === 'stop') engine.decide(trigger.id, { kind: 'stop', ticketId: target!, reason: 'Explicit fixture stop' })
            else if (decision.kind === 'status') { engine.status(target!, trigger.id); engine.reply({ purpose: 'status', ticketId: target!, triggerId: trigger.id, text: 'Saved fixture status' }) }
            else engine.decide(trigger.id, { kind: 'ignore', reason: 'Fixture event needs no new work' })
          }
        }
      } catch (error) { actual = 'error'; failures.push({ eventId: event.id, reason: safeFailureMessage(error) }) }
      const correct = actual === event.expected.kind && (!expectedTarget || target === expectedTarget)
      if (!correct) failures.push({ eventId: event.id, reason: `Expected ${event.expected.kind}${expectedTarget ? ` to ${expectedTarget}` : ''}; observed ${actual}${target ? ` to ${target}` : ''}.` })
      const row = { eventId: event.id, path, kind: actual, correct, ...target ? { ticketId: target } : {} }; routes.push(row)
      ledger.record({ id: `route:${event.id}`, kind: 'route', triggerId: trigger.id, ...target ? { ticketId: target } : {}, data: { ...row, durationMs: performance.now() - before } })
      if (event.kind === 'correction') ledger.record({ id: `human:${event.id}`, kind: 'intervention', ...target ? { ticketId: target } : {}, data: { kind: 'requirement-change', fixture: true } })
    }
    // The failed command persists its real side effect before the host loses and reopens its database handle.
    const recoveryId = logical.get('recovery')
    if (recoveryId && liveTicket(store.tickets.get(recoveryId)!)) {
      const taskDirectory = join(directory, 'tasks', 'recovery'); await mkdir(taskDirectory, { recursive: true })
      const assignment = latestAssignment(store.tickets.get(recoveryId)!)!
      engine.assignmentStarted(recoveryId, assignment.id)
      const recoveryStart = performance.now()
      try { await runCommand([process.execPath, '-e', PROGRAM], { input: JSON.stringify({ directory: taskDirectory, checkpoint: true }), env: evaluationEnvironment(), timeoutMs: 10000 }) }
      catch { /* Exit 23 is the intentional crash boundary, checked against the durable effect below. */ }
      const checkpoint = JSON.parse(await readFile(join(taskDirectory, 'effects.json'), 'utf8')) as string[]
      if (checkpoint.filter(id => id === 'fixture-operation').length !== 1) throw new Error('Crash checkpoint did not preserve one operation')
      store.close(); store = new Store(database); ledger = new EvaluationLedger(store, { runId }); queued.clear(); engine = makeEngine()
      engine.assignmentInterrupted(recoveryId, assignment.id)
      for (const ticket of store.tickets.list()) if (liveTicket(ticket) && latestAssignment(ticket)?.state === 'pending') queued.set(ticket.id, latestAssignment(ticket)!.id)
      ledger.record({ id: 'host-recovery', kind: 'recovery', ticketId: recoveryId, data: { durationMs: performance.now() - recoveryStart, checkpoint: true } })
    }
    const execute = async ([ticketId, assignmentId]: [string, string]) => {
      const ticket = store.tickets.get(ticketId), task = ticketTasks.get(ticketId)
      if (!ticket || !task || !liveTicket(ticket) || latestAssignment(ticket)?.id !== assignmentId) return
      const definition = taskFixtures[task], taskDirectory = join(directory, 'tasks', task)
      await mkdir(taskDirectory, { recursive: true })
      for (const file of definition.files) await writeFile(join(taskDirectory, file.name), file.content)
      engine.assignmentStarted(ticketId, assignmentId)
      const delivered = store.tickets.get(ticketId)!
      engine.inputsRead(ticketId, delivered.inputs.flatMap(input => input.kind === 'trigger' && input.deliveredTo === assignmentId ? [input.id] : []))
      try {
        if (task === 'waiting') {
          engine.report(ticketId, { state: 'waiting', summary: 'Waiting for the fixture external file.', waitingFor: { kind: 'external', subject: 'external.txt' },
            nextCheck: { key: 'fixture-external', at: new Date(Date.now() + 1).toISOString(), purpose: 'Read external.txt',
              successCondition: 'The external-ready file exists.', resumeInstruction: 'Read the file and continue the same task.' } }, assignmentId)
          engine.turnEnded(ticketId, assignmentId)
          await runCommand([process.execPath, '-e', PROGRAM], { input: JSON.stringify({ directory: taskDirectory, externalEvent: true }), env: evaluationEnvironment(), timeoutMs: 10000 })
          engine.evaluateDue(); engine.evaluateDue()
          if (store.tickets.get(ticketId)!.inputs.filter(input => input.kind === 'text' && !!input.followupId).length !== 1) {
            throw new Error('External wait did not resume exactly once on the existing task.')
          }
        }
        const currentTask = store.tickets.get(ticketId)!
        const requirements = [store.triggers.get(currentTask.origin.triggerId)?.text ?? '', ...currentTask.inputs.flatMap(input =>
          input.kind === 'trigger' ? [store.triggers.get(input.triggerId)?.text ?? ''] : [])]
        const correctedTitle = requirements.map(text => /标题使用“([^”]+)”/.exec(text)?.[1]).find(Boolean) ?? '数据汇总'
        const includeOriginal = requirements.some(text => text.includes('原始数据'))
        if (task === 'reproduction') await runCommand([process.execPath, '-e', PROGRAM], {
          input: JSON.stringify({ directory: taskDirectory, observeRuntime: true }), env: evaluationEnvironment(), timeoutMs: 10000 })
        if (options.provider?.executeTask) {
          const existingFiles = await Promise.all([...definition.files.map(file => file.name), ...task === 'recovery' ? ['effects.json'] : [],
            ...task === 'waiting' ? ['external.txt'] : [], ...task === 'reproduction' ? ['observed-runtime.json'] : []]
            .map(async name => ({ name, content: await readFile(join(taskDirectory, name), 'utf8') })))
          let response: Awaited<ReturnType<NonNullable<EvaluationProvider['executeTask']>>>
          const input = { ...definition, instruction: requirements.join('\n'), existingFiles }
          try { response = await invoke('execute_fixture', input, () => options.provider!.executeTask!(input)); usage(`task:${task}`, response.usage, ticketId) }
          catch (error) { usage(`task:${task}`, error instanceof EvaluationProviderError ? error.trace.usage : undefined, ticketId); throw error }
          const names = new Set<string>()
          for (const file of response.files) {
            if (!definition.outputNames.includes(file.name) || names.has(file.name)) throw new Error('Provider returned an unrequested or duplicate output name')
            names.add(file.name); await writeFile(join(taskDirectory, file.name), file.content)
          }
        }
        await runCommand([process.execPath, '-e', PROGRAM], { input: JSON.stringify({ directory: taskDirectory, task,
          providerGenerated: !!options.provider?.executeTask, title: correctedTitle, includeOriginal }), env: evaluationEnvironment(), timeoutMs: 10000 })
        const output = await runCommand([process.execPath, '-e', VERIFY], { input: JSON.stringify({ directory: taskDirectory, task }), env: evaluationEnvironment(), timeoutMs: 10000 })
        const checked = z.object({ passed: z.boolean(), reason: z.string(), sideEffectCount: z.number().int().nonnegative().optional() }).parse(JSON.parse(output.stdout))
        const files: AutonomyEvaluationResult['tasks'][number]['files'] = []
        for (const name of definition.outputNames) {
          try { const bytes = await readFile(join(taskDirectory, name)); files.push({ name, sha256: sha(bytes), bytes: bytes.length }) }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        }
        engine.report(ticketId, { state: 'ready', summary: `Fixture execution ended with ${files.length} saved expected outputs.`, evidence: files.map(file => ({ description: `${file.name} SHA-256 ${file.sha256}`, ref: join(taskDirectory, file.name) })) }, assignmentId)
        const current = store.tickets.get(ticketId)!
        engine.verify(ticketId, { reportKey: completionKey(current), state: checked.passed ? 'passed' : 'needs_changes', at: now(), attempt: 1,
          summary: checked.passed ? 'Independent subprocess verified fixture requirements.' : checked.reason || 'Fixture requirements failed.',
          checks: current.acceptance!.criteria.map(criterion => ({ criterionId: criterion.id, state: checked.passed ? 'passed' : 'needs_changes',
            summary: checked.reason || 'Read and checked actual output bytes against the fixture requirements.', evidenceRefs: files.map(file => join(taskDirectory, file.name)) })) })
        ledger.record({ id: `verification:${task}`, kind: 'verification', ticketId, data: { state: checked.passed ? 'passed' : 'needs_changes', prevented: !checked.passed } })
        const receipt = checked.passed ? engine.reply({ purpose: 'result', ticketId, text: `Verified fixture outputs: ${files.map(file => file.name).join(', ')}.` }) : undefined
        ledger.record({ id: `completion:${task}`, kind: 'completion', ticketId, data: { correct: checked.passed, published: receipt?.status === 'sent',
          receiptId: receipt?.id ?? null,
          durationMs: Date.now() - (requestTimes.get(ticketId) ?? Date.now()) } })
        if (checked.sideEffectCount !== undefined) ledger.record({ id: `side-effect:${task}`, kind: 'side_effect', ticketId, data: { count: checked.sideEffectCount } })
        if (!checked.passed) failures.push({ task, reason: checked.reason || 'Output failed independent checks.' })
        resultTasks.push({ task, ticketId, passed: checked.passed, files })
      } catch (error) { failures.push({ task, reason: safeFailureMessage(error) }) }
    }
    const jobs = [...queued], concurrency = mode === 'single-worker' ? 1 : 2
    for (let offset = 0; offset < jobs.length; offset += concurrency) await Promise.all(jobs.slice(offset, offset + concurrency).map(execute))
    for (const task of ['summary', 'recovery', 'reproduction', 'waiting'] as const) if (!resultTasks.some(row => row.task === task)) failures.push({ task, reason: 'Required fixture task did not produce a verified result.' })
    const stoppedId = currentTaskOwner('stopped')
    if (!stoppedId || store.tickets.get(stoppedId)?.ended?.outcome !== 'stopped') failures.push({ task: 'stopped', reason: 'Explicit stop did not end the fixture task.' })
    const unsettled = store.threads.active().filter(thread => thread.pending.length || thread.evaluating)
    if (unsettled.length) failures.push({ reason: `Replay left unsettled routing work: ${unsettled.map(thread => thread.key).join(', ')}.` })
    let stoppedOutput = false
    try { await access(join(directory, 'tasks', 'stopped', 'filtered.json')); stoppedOutput = true } catch { /* Absence is the expected physical cancellation outcome. */ }
    if (stoppedOutput) failures.push({ task: 'stopped', reason: 'The cancelled task left an unexpected output file.' })
    ledger.record({ id: 'stopped-side-effect', kind: 'side_effect', ...stoppedId ? { ticketId: stoppedId } : {}, data: { count: stoppedOutput ? 1 : 0, expectedCount: 0 } })
    const gitRevision = options.gitRevision ?? null, config = { mode, concurrency, provider: options.provider?.name ?? null, model: options.provider?.model ?? null,
      taskSet: AUTONOMY_TASK_SET_VERSION, buildHash: options.buildHash ?? null, promptProfile, promptHash: routerPrompt?.sha256 ?? null }
    const result: AutonomyEvaluationResult = { schema: 1, runId, startedAt, finishedAt: now(), taskSetVersion: AUTONOMY_TASK_SET_VERSION,
      gitRevision, mode, configHash: sha(JSON.stringify(config)), buildHash: options.buildHash ?? null, model: options.provider ? { provider: options.provider.name, model: options.provider.model ?? null } : null,
      routingPolicy: options.provider ? 'provider' : 'fixture-oracle', executionPolicy: options.provider?.executeTask ? 'provider-files' : 'fixture-programs',
      promptProfile, promptHash: routerPrompt?.sha256 ?? null, replicate,
      interpretation: ['Protocol replay uses the real Engine and SQLite. Fixture-oracle routing measures protocol behavior only.',
        'Subprocess tasks read and create actual files; fixture-program execution does not measure model coding ability.',
        'Provider routes receive original text and current ticket context with expected answers withheld.',
        'Repository/personal profiles compose the bundled production Router prompt and isolated fixture policy, then adapt decisions through JSON; complete DSH Session/tool behavior is measured separately.',
        'Exact provider inputs, outputs, schema failures, allowed null normalization and available usage are retained in provider-traces.json.',
        'Reproduction runs Node.js JSON.parse on the host before provider file generation; the provider organizes actual observed-runtime.json evidence.',
        'Wall-clock latency covers this local run; human adoption and unavailable provider usage remain unknown.',
        'Completion publication is verified against isolated local outbox receipts; no external user channel is contacted.',
        'Recovery timing covers a real failed command and SQLite/Engine reopen, with its persisted checkpoint inspected.',
        'Routing replay completes before any worker concurrency is applied. single-worker and router-first use the same routing path; differences between independent calls do not establish a concurrency effect.',
        'single-worker serializes execution; the other modes allow two fixture subprocesses and do not emulate a complete LLM Session.'],
      summary: ledger.summary(), failures, routes, tasks: resultTasks.sort((a, b) => a.task.localeCompare(b.task)),
      requestOutcomes: (['summary', 'stopped', 'recovery', 'reproduction', 'waiting'] as const).map(task => {
        const original = originalTaskTrigger(task)!, triggerId = `evaluation-${original.id}`, request = engine.requestResponsibility(triggerId)
        return { task, triggerId, state: request?.state ?? 'missing', ownerTicketIds: request?.owners.filter(owner => owner.state !== 'cancelled').map(owner => owner.ticketId) ?? [] }
      }),
      output: { database, result: join(directory, 'result.json'), events: join(directory, 'events.json'), traces: join(directory, 'provider-traces.json'),
        ...routerPrompt ? { prompt: join(directory, 'router-prompt.json') } : {} } }
    await writeFile(result.output.traces, JSON.stringify(options.provider?.traces ? options.provider.traces().slice(providerTraceOffset) : traces, null, 2), { mode: 0o600 })
    await writeFile(result.output.events, JSON.stringify(ledger.events(), null, 2)); await writeFile(result.output.result, JSON.stringify(result, null, 2))
    return result
  } finally { store.close() }
}
