/** Controlled routing faults exercise recovery through the real Engine, SQLite and subprocess effects. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Engine, completionKey, latestAssignment, liveTicket, type Policy, type RequestResponsibility, type Trigger } from '../core/index.ts'
import { Store } from '../app/store.ts'
import { runCommand } from '../../scripts/dsh-superagent-watchdog.mjs'
import { evaluationEnvironment } from './provider.ts'
import { safeFailureMessage } from '../app/session-failures.ts'

export type RoutingRecoveryFault = 'false-attach' | 'false-accept' | 'false-status' | 'false-ignore'
export const ROUTING_RECOVERY_FAULTS: readonly RoutingRecoveryFault[] = ['false-attach', 'false-accept', 'false-status', 'false-ignore']
export interface RoutingRecoveryScenario {
  fault: RoutingRecoveryFault; passed: boolean; failures: string[]; originalRequestId: string
  before: RequestResponsibility; recovered: RequestResponsibility; final: RequestResponsibility
  wrongTicketId: string | null; canonicalTicketId: string; stoppedTicketId: string | null
  requestCoverage: { expected: number; completed: number; cancelled: number; orphaned: number }
  recoveryMs: number; additionalRouterDecisions: number; correctiveActions: number
  additionalModelCalls: number; additionalTokens: number | null; humanInterventions: number
  effects: { operations: string[]; duplicate: number; unexpected: number; reusedPriorCheckpoint: boolean }
  files: { requestId: string; path: string; sha256: string }[]; database: string
}
export interface RoutingRecoveryEvaluation {
  schema: 1; taskSetVersion: 'routing-recovery-v1'; startedAt: string; finishedAt: string
  interpretation: string[]; passed: boolean; scenarios: RoutingRecoveryScenario[]; output: string
}
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const PROGRAM = String.raw`const fs=require('node:fs');const s=JSON.parse(fs.readFileSync(0,'utf8'));process.chdir(s.directory);
const log=fs.existsSync('effects.json')?JSON.parse(fs.readFileSync('effects.json','utf8')):[];
if(!log.includes(s.requestId)){log.push(s.requestId);fs.writeFileSync('effects.json',JSON.stringify(log));fs.writeFileSync(s.file,JSON.stringify({requestId:s.requestId,originalText:s.text,completed:true}));}
process.stdout.write(JSON.stringify({operationId:s.requestId,prior:log.filter(x=>x===s.requestId).length}));`

async function scenario(directory: string, fault: RoutingRecoveryFault, stopAfterRecovery: boolean): Promise<RoutingRecoveryScenario> {
  await mkdir(directory, { recursive: true })
  const database = join(directory, 'state.sqlite'), workspace = join(directory, 'work')
  await mkdir(workspace, { recursive: true })
  let store = new Store(database), engine: Engine
  if (store.get('routing-recovery-run-owner')) { store.close(); throw new Error('Recovery directory already contains a run; choose a fresh directory.') }
  store.set('routing-recovery-run-owner', fault)
  const queued = new Map<string, string>(), failures: string[] = [], files: RoutingRecoveryScenario['files'] = []
  const policy: Policy = { version: 'routing-recovery-evaluation', paused: false, evalTimeoutMs: 60_000, revalidate: () => true,
    admitsInferred: () => true, gate: () => ({ admissible: true, strength: 'explicit', basis: { via: 'listed' } }) }
  const makeEngine = () => new Engine({ repo: store, provisionalRouting: true, policy: () => policy,
    scope: { scope: () => ({ listened: true, observed: false }) }, assessor: { request() {} },
    executor: { start: (ticket, assignment) => { queued.set(ticket.id, assignment.id) },
      deliver: (ticket, assignment) => engine.inputsDelivered(ticket.id, assignment.id, [...ticket.undelivered]), stop: ticket => { queued.delete(ticket.id) } },
    outbox: { send: message => { store.receipts.add(message); store.receipts.settle(message, 'sent') }, status: id => store.receipts.get(id)?.status, withdraw() {} },
    prepareTicket: ticket => ({ ...ticket, acceptance: { mode: 'enforce', revision: 1, createdAt: new Date().toISOString(),
      criteria: [{ id: 'original', kind: 'content', description: 'Complete the original request from its actual saved bytes.', sourceRefs: [`trigger/${ticket.origin.triggerId}`] }] } }) })
  engine = makeEngine()
  const trigger = (id: string, thread: string, text: string): Trigger => ({ id, source: 'evaluation', human: true,
    addressed: 'direct', routing: 'router', actor: { source: 'evaluation', id: 'owner' }, threads: [{ source: 'evaluation', id: thread }],
    text, at: new Date().toISOString(), meta: {}, channel: { source: 'evaluation', thread: `evaluation:${thread}`, address: { fixture: thread } } })
  const receive = (value: Trigger) => { engine.receive(value); engine.evaluateDue() }
  const begin = (ticketId: string) => {
    const ticket = store.tickets.get(ticketId)!, assignment = latestAssignment(ticket)!
    if (assignment.state === 'pending') engine.assignmentStarted(ticketId, assignment.id)
    const current = store.tickets.get(ticketId)!
    if (current.undelivered.length) engine.inputsDelivered(ticketId, assignment.id, [...current.undelivered])
    engine.inputsRead(ticketId, current.inputs.filter(input => input.kind === 'trigger').map(input => input.id))
    return assignment.id
  }
  const accept = (value: Trigger) => {
    const decision = engine.decide(value.id, { kind: 'accept', title: value.text.slice(0, 100), scope: value.text, reason: 'Original public fixture request' })
    const id = decision.ticketId!; begin(id); return id
  }
  const work = async (requestId: string) => {
    const value = store.triggers.get(requestId)!, file = `${sha(requestId).slice(0, 16)}.json`
    await runCommand([process.execPath, '-e', PROGRAM], { input: JSON.stringify({ directory: workspace, requestId, text: value.text, file }),
      timeoutMs: 10000, env: evaluationEnvironment() })
    const path = join(workspace, file), bytes = await readFile(path), observed = JSON.parse(bytes.toString())
    if (observed.requestId !== requestId || observed.originalText !== value.text || observed.completed !== true) throw new Error('Actual output does not cover its original request')
    if (!files.some(item => item.requestId === requestId)) files.push({ requestId, path, sha256: sha(bytes) })
  }
  const first = trigger(`${fault}:initial`, 'initial', '生成 baseline.json，保留这项任务的独立目标。')
  receive(first); const firstTicketId = accept(first)
  const request = trigger(`${fault}:request`, 'new-request', fault === 'false-accept'
    ? `继续工单 ${firstTicketId}：补充生成 detail.json，并保留该工单已有成果。`
    : '新建独立任务，生成 result.json，正文必须保留这条原始要求。')
  receive(request)
  let wrongTicketId: string | null = null, canonicalTicketId = firstTicketId, stoppedTicketId: string | null = null
  let additionalRouterDecisions = 0, correctiveActions = 0, reusedPriorCheckpoint = false
  try {
    if (fault === 'false-attach') { wrongTicketId = firstTicketId; engine.attach(firstTicketId, request.id, 'Injected incorrect semantic attachment') }
    if (fault === 'false-accept') {
      wrongTicketId = accept(request)
      // Save a real completed checkpoint before correcting ownership; the successor must reuse its stable request ID.
      await work(request.id)
      engine.report(wrongTicketId, { state: 'progress', summary: `Actual request checkpoint is already saved: ${files.find(item => item.requestId === request.id)!.path}` }, latestAssignment(store.tickets.get(wrongTicketId)!)!.id)
    }
    if (fault === 'false-status') {
      engine.status(firstTicketId, request.id)
      engine.reply({ purpose: 'status', ticketId: firstTicketId, triggerId: request.id, text: 'Saved status for the injected wrong task.' })
    }
    if (fault === 'false-ignore') engine.decide(request.id, { kind: 'ignore', reason: 'Injected missed action request' })
    const before = structuredClone(engine.requestResponsibility(request.id)!)
    const started = performance.now()
    // Reopen the actual database before recovery to exercise durable responsibility instead of process-local mapping.
    store.close(); store = new Store(database); queued.clear(); engine = makeEngine()
    if (fault === 'false-attach') {
      const assignment = begin(firstTicketId), current = engine.requestResponsibility(request.id)!
      if (store.threads.get('evaluation:new-request')!.subscriptions.includes(firstTicketId)) throw new Error('Trial routing polluted the thread subscription')
      engine.handback(firstTicketId, request.id, 'The requested result.json belongs to an independent goal.', assignment, current.revision)
      correctiveActions++; engine.evaluateDue(); canonicalTicketId = accept(request); additionalRouterDecisions++
    } else if (fault === 'false-accept') {
      const assignment = begin(wrongTicketId!), current = engine.requestResponsibility(request.id)!
      const reason = `The original request explicitly names existing ticket ${firstTicketId}; continue its saved work.`
      engine.transferRequest(wrongTicketId!, request.id, firstTicketId, reason, 'recover-transfer', assignment, current.revision)
      // Replay the exact correction after a lost reply; it must remain one responsibility transfer.
      engine.transferRequest(wrongTicketId!, request.id, firstTicketId, reason, 'recover-transfer', assignment, current.revision)
      correctiveActions++; canonicalTicketId = firstTicketId; reusedPriorCheckpoint = true
    } else {
      const current = engine.requestResponsibility(request.id)!, reason = 'Original action quote: 新建独立任务，生成 result.json'
      engine.reopenRequest(request.id, reason, 'recover-action', current.revision)
      engine.reopenRequest(request.id, reason, 'recover-action', current.revision)
      correctiveActions++; engine.evaluateDue(); canonicalTicketId = accept(request); additionalRouterDecisions++
    }
    const current = engine.requestResponsibility(request.id)!, owner = current.owners.find(item => item.ticketId === canonicalTicketId && item.state === 'proposed')
    if (owner) { engine.claimRequest(canonicalTicketId, request.id, 'Original source, referenced goal and output belong here.', begin(canonicalTicketId), current.revision); correctiveActions++ }
    const recovered = structuredClone(engine.requestResponsibility(request.id)!), recoveryMs = performance.now() - started
    if (stopAfterRecovery) {
      const target = recovered.owners.find(owner => owner.state === 'claimed')?.ticketId
      if (!target) throw new Error('Recovered original request has no canonical owner for stop')
      stoppedTicketId = target; engine.stopTicket(target, `Stop the canonical owner of original request ${request.id}`)
    }
    // A stop affects only its recovered owner; unrelated original work continues to its own completion.
    for (const ticket of store.tickets.open()) {
      if (!liveTicket(ticket)) continue
      const assignment = begin(ticket.id)
      const responsibilities = [first.id, request.id].map(id => engine.requestResponsibility(id)!)
        .filter(item => item.owners.some(owner => owner.ticketId === ticket.id && owner.state === 'claimed'))
      for (const item of responsibilities) await work(item.id)
      const currentTicket = store.tickets.get(ticket.id)!
      if (!responsibilities.length) continue
      const report = engine.report(ticket.id, { state: 'ready', summary: 'Actual files cover all active original requests.',
        evidence: responsibilities.map(item => ({ description: 'Independent output check passed.', ref: files.find(file => file.requestId === item.id)!.path })) }, assignment)
      engine.verify(ticket.id, { reportKey: completionKey(report), state: 'passed', at: new Date().toISOString(), summary: 'Read and checked every original-request output.', attempt: 1,
        checks: currentTicket.acceptance!.criteria.map(item => ({ criterionId: item.id, state: 'passed', summary: 'Compared actual bytes with the original source request.',
          evidenceRefs: files.filter(file => responsibilities.some(request => request.id === file.requestId)).map(file => file.path) })) })
    }
    const states = [first.id, request.id].map(id => engine.requestResponsibility(id)!)
    const requestCoverage = { expected: states.length, completed: states.filter(item => item.state === 'completed').length,
      cancelled: states.filter(item => item.state === 'cancelled').length, orphaned: states.filter(item => !['completed', 'cancelled'].includes(item.state)).length }
    if (requestCoverage.orphaned) failures.push('Original requests remain without a terminal outcome.')
    const operations: string[] = await readFile(join(workspace, 'effects.json'), 'utf8').then(text => JSON.parse(text) as string[]).catch(() => [] as string[])
    const duplicate = operations.reduce((sum, id, index) => sum + (operations.indexOf(id) === index ? 0 : 1), 0)
    const unexpected = operations.filter(id => ![first.id, request.id].includes(id)).length
    if (duplicate || unexpected) failures.push('Actual subprocess effects were duplicated or exceeded the original request set.')
    if (!stopAfterRecovery && operations.length !== states.length) failures.push('Expected original-request effects are missing.')
    const final = structuredClone(engine.requestResponsibility(request.id)!)
    if (stopAfterRecovery && (stoppedTicketId !== canonicalTicketId || final.state !== 'cancelled')) failures.push('Stop failed to follow the original request to its recovered owner.')
    if (!stopAfterRecovery && final.state !== 'completed') failures.push('Recovered request did not complete.')
    store.close(); store = new Store(database)
    const persisted = makeEngine().requestResponsibility(request.id)
    if (JSON.stringify(persisted) !== JSON.stringify(final)) failures.push('Final responsibility changed after SQLite reopen.')
    return { fault, passed: failures.length === 0, failures, originalRequestId: request.id, before, recovered, final,
      wrongTicketId, canonicalTicketId, stoppedTicketId, requestCoverage, recoveryMs, additionalRouterDecisions, correctiveActions,
      additionalModelCalls: 0, additionalTokens: null, humanInterventions: 0,
      effects: { operations, duplicate, unexpected, reusedPriorCheckpoint }, files, database }
  } finally { store.close() }
}

/** Exercise injected mistakes with deterministic Worker/reviewer decisions and independently checked physical outputs. */
export async function runRoutingRecoveryEvaluation(options: { directory: string; faults?: readonly RoutingRecoveryFault[]; stopAfterRecovery?: boolean }): Promise<RoutingRecoveryEvaluation> {
  const directory = resolve(options.directory), output = join(directory, 'recovery.json'), startedAt = new Date().toISOString()
  const faults = options.faults ?? ROUTING_RECOVERY_FAULTS
  if (!faults.length || new Set(faults).size !== faults.length || faults.some(fault => !ROUTING_RECOVERY_FAULTS.includes(fault))) throw new Error('Choose distinct supported routing faults')
  await mkdir(directory, { recursive: true })
  const scenarios: RoutingRecoveryScenario[] = []
  for (const fault of faults) {
    try { scenarios.push(await scenario(join(directory, fault), fault, options.stopAfterRecovery ?? false)) }
    catch (error) { await writeFile(join(directory, `${fault}-failure.json`), JSON.stringify({ fault, error: safeFailureMessage(error) }, null, 2)); throw error }
  }
  const result: RoutingRecoveryEvaluation = { schema: 1, taskSetVersion: 'routing-recovery-v1', startedAt, finishedAt: new Date().toISOString(),
    interpretation: ['Fault decisions are deliberately injected, while real Engine/SQLite preserve original request identity through recovery.',
      'Fixture Workers detect scope/reference mismatches; status/ignore recovery calls Engine.reopenRequest after a deterministic source-grounded reviewer finding. Runtime model-review behavior has separate integration coverage.',
      'No model is called in this fault suite. Additional model calls are zero and additional token/cost measurements remain unknown.',
      'Real Node subprocesses retain a checkpoint keyed by original request ID. Transfer reuses that actual checkpoint; arbitrary external APIs require their corresponding idempotency/receipt adapters.'],
    passed: scenarios.every(item => item.passed), scenarios, output }
  await writeFile(output, JSON.stringify(result, null, 2))
  return result
}
