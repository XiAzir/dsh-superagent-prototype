/** Application composition root and lifecycle manager for dsh-superagent. */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { readSessionEvents, readLatestTurnEvents } from '../infra/session-history.ts'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-subprocess'
import { mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { join, basename } from 'node:path'
import { lockSync } from 'proper-lockfile'
import { Engine, completionApproved, completionKey, key, reasonText, requestIds, requestResponsibility, type EngineForSettings, type ReceiveResult, type Ticket, type Trigger } from '../core/index.ts'
import { allowedSender, settingsPolicy } from '../policy.ts'
import { SourceRegistry } from '../sources/registry.ts'
import { Commands } from '../infra/commands.ts'
import type { Deployment, Machine } from '../deployment.ts'
import { environmentOf, ticketEnvironment, type Variable } from './execution-environment.ts'
import type { SetupProblem } from '../setup.ts'
import { DshExecutor, sourceTrigger, triggerMessage, workerSessionId, ticketOfSession } from '../executor/dsh.ts'
import { ticketCard } from './cards.ts'
import { MasterAssessor } from './assessment.ts'
import { KV, record } from '../kv.ts'
import { Store } from './store.ts'
import { evalsHealth } from './views/overview.ts'
import { TextCache } from './cache.ts'
import { Effects, Later } from './effects.ts'
import { Prompts } from './prompts.ts'
import { registerHttp, type HttpHost } from './http.ts'
import type { LinkTarget } from './views/records.ts'
import { candidateCard, repliedTo, sourceLink, type LinkHost } from './links.ts'
import { eventNotice, followupNotice } from './notices.ts'
import { pullEndNotices } from '../sources/github-pull.ts'
import { HealthBoard } from '../infra/health.ts'
import { Outbox } from './outbox.ts'
import { Passes } from './passes.ts'
import { Setup } from './setup.ts'
import { feishuSettings } from '../sources/feishu.ts'
import { health, type Health, type SourceContext, type SourceHost } from '../sources/host.ts'
import { Sessions } from './sessions.ts'
import { Settings } from './settings.ts'
import { sourceContextOf, type SourceContextDeps } from './source-context.ts'
import type { ResourceHost } from './resources.ts'
import type { QqBridge } from './qq-source.ts'
import { mainTools, type MainToolsHost } from './tools/main.ts'
import { executorTools, type ExecutorToolsHost } from './tools/executor.ts'
import { ArtifactRegistry } from './artifacts.ts'
import { Schedules } from './schedules.ts'
import { PersonalCoordinator } from './personal-coordinator.ts'
import { personalTools } from './tools/personal.ts'
import { PersonalRuntime } from './personal-runtime.ts'
import { SessionConversations } from './session-conversations.ts'
import { Memory } from './memory.ts'
import { WorkerProgress } from './worker-progress.ts'
import { ExecutionEvidence } from './execution-evidence.ts'
import { VerificationService } from './verification.ts'
import { SupervisionService, dshSupervisionModel } from './supervision.ts'
import { watchdogSnapshot, type WatchdogExecutionEvidence } from './watchdog.ts'
import { EvaluationLedger, type EvaluationEvent } from '../evaluation/ledger.ts'
import { RemoteEnvironments, type RemoteTransition } from '../remote/client.ts'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { MemoryExperienceService } from './memory-experience.ts'
import { recordRuntimeManifest, runtimeBuildIdentity, runtimeManifestState } from './runtime-manifest.ts'
import { RequestReviewService } from './request-review.ts'
import { RequestHandoffService } from './request-handoff.ts'

// Source plugins interact with dsh-superagent exclusively through the `SourceHost` service interface.
declare module '@deepseek-ai/cordis' { interface Context { orchestrator: SourceHost } }
const now = (): string => new Date().toISOString()
const LOADED_RUNTIME_IDENTITY = runtimeBuildIdentity({ entryPath: fileURLToPath(import.meta.url) })

/**
 * Composition root of dsh-superagent that connects `Store`, `Setup`, `Engine`, `SourceRegistry`, `Effects`, `Outbox`, `Passes`, `Sessions`, `Settings`, `Prompts`, `DshExecutor`, and `MasterAssessor`.
 * Exposes the `SourceHost` service on the Cordis context for source plugins and coordinates startup, setup checks, HTTP route registration, and graceful shutdown.
 * Locks the state directory before opening SQLite so concurrent processes cannot corrupt or double-migrate state.
 */
export class Runtime extends Service implements SourceHost {
  qq?: QqBridge
  readonly store: Store
  readonly artifacts: ArtifactRegistry
  readonly setup: Setup
  readonly prompts: Prompts
  readonly effects: Effects
  readonly sources: SourceRegistry
  readonly commands: Commands
  readonly sessions: Sessions
  readonly settings: Settings
  readonly executor: DshExecutor
  readonly assessor: MasterAssessor
  readonly outbox: Outbox
  readonly schedules: Schedules
  readonly personal: PersonalCoordinator
  readonly personalRuntime: PersonalRuntime
  readonly workerProgress: WorkerProgress
  readonly memory: Memory
  readonly evidence: ExecutionEvidence
  readonly verification: VerificationService
  readonly supervision: SupervisionService
  readonly evaluation: EvaluationLedger
  readonly remote: RemoteEnvironments
  readonly experience: MemoryExperienceService
  readonly requestReview: RequestReviewService
  readonly requestHandoff: RequestHandoffService
  readonly engine: Engine
  readonly passes: Passes
  readonly ready: Promise<void>
  private readonly board = new HealthBoard()
  private readonly runtimeHealth = this.board.claim('runtime', { state: 'starting', detail: '' })
  readonly masterId: string
  private readonly sourceLinks = new TextCache(200_000)
  private readonly stopped = new AbortController()
  private readonly disposers: (() => void)[] = []
  private releaseLock?: () => Promise<void>
  private closingFlag = false
  private stopping?: Promise<void>
  private readonly sourceDeps: SourceContextDeps
  private readonly toolHost: MainToolsHost & ExecutorToolsHost
  /** Non-zero while a main-Session tool is executing an Engine command, suppressing self-triggered domain event notices. */
  private quiet = 0
  private readonly manifestRunId = randomUUID()
  private manifestPhase: 'starting' | 'ready' | 'failed' = 'starting'
  private manifestConfig?: string
  constructor(ctx: Context, readonly machine: Machine, restart: () => void) {
    super(ctx, 'orchestrator')
    const runtime = this
    // Lock the state directory before opening the database so another process cannot migrate or write concurrently.
    mkdirSync(machine.stateDir, { recursive: true, mode: 0o700 })
    const compromised = (error: Error) => { this.runtimeHealth.set({ state: 'error', detail: error.message }); this.stopped.abort() }
    const release = lockSync(machine.stateDir, { stale: 30_000, onCompromised: compromised })
    this.releaseLock = async () => { release() }
    let opened: Store | undefined
    try {
      const report = (error: unknown) => { ctx.logger.warn('dsh-superagent: %s', String(error)) }
      const store = opened = this.store = new Store(join(machine.stateDir, 'orchestrator.sqlite'), report)
      const initial = store.settings()
      let sessionDefaultsChanged = false
      if (!initial.sources['dsh-session']) { initial.sources['dsh-session'] = { enabled: true, config: {} }; sessionDefaultsChanged = true }
      if (!initial.policy.sources['dsh-session']) { initial.policy.sources['dsh-session'] = { allowed: [{ id: 'owner', name: '我' }], admission: {} }; sessionDefaultsChanged = true }
      if (sessionDefaultsChanged) store.saveSettings(initial)
      this.personal = new PersonalCoordinator({ store, personalMode: () => (machine.mode ?? 'repository') === 'personal' })
      this.artifacts = new ArtifactRegistry(store, machine.stateDir)
      if ((machine.mode ?? 'repository') === 'personal') {
        const initial = store.settings()
        let changed = false
        if (!initial.sources.web) { initial.sources.web = { enabled: true, config: {} }; changed = true }
        if (!initial.policy.sources.web) { initial.policy.sources.web = { allowed: [{ id: 'owner', name: '我' }], admission: {} }; changed = true }
        if (changed) store.saveSettings(initial)
      }
      const setup = this.setup = new Setup({ context: ctx, machine, lifetime: this.lifetime, restart })
      const deployed = () => setup.configured()
        ? environmentOf({ deployment: setup.deployment, sources: this.sources, settings: store.settings() }) : undefined
      const feishu = () => setup.configured() && !!setup.deployment.feishu
      const github = () => setup.configured() && !!setup.deployment.github
      const personal = () => (machine.mode ?? 'repository') === 'personal'
      const prompts = this.prompts = new Prompts(store, () => machine.promptMaxChars.get(), deployed, feishu, github, personal)
      const masterId = this.masterId = store.get(KV.runtime.masterId) ?? `orchestrator-${key(machine.stateDir)}`
      store.set(KV.runtime.masterId, masterId)
      const commands = this.commands = new Commands(() => setup.deployment, setup.commandEnvironment, this.lifetime)
      this.schedules = new Schedules(store, commands, { paused: () => this.paused(), closing: () => this.closing(),
        onError: () => ctx.logger.warn('dsh-superagent: local schedule storage unavailable; retrying') })
      const board = this.board
      const effects = this.effects = new Effects(store, board)
      const sources = this.sources = new SourceRegistry(() => store.settings(), board, kind => {
        // Sync source member lists once startup completes when a source plugin loads dynamically.
        if (kind.policy?.sync && (machine.mode ?? 'repository') !== 'personal') void this.ready?.then(() => this.settings.syncable().includes(kind.kind) ? this.settings.sync(kind.kind) : undefined)
          .catch(() => { /* sync() records its failure in health. */ })
        void this.ready?.then(() => {
          if (this.closing()) return
          for (const ticket of store.tickets.open()) {
            const assignment = ticket.assignments.at(-1)
            if (ticket.mandate.actor.source === kind.kind && !ticket.hold && assignment?.state === 'pending') this.executor.start(ticket, assignment)
          }
          this.passes.request()
        }).catch(error => ctx.logger.warn('Source registration recovery: %s', String(error)))
        return () => {}
      })
      const links: LinkHost = { store, links: this.sourceLinks, commands, sources, lifetime: this.lifetime }
      const link = (trigger: Trigger, signal?: AbortSignal) => sourceLink(links, trigger, signal)
      const environment = (ticket: Ticket) => this.ticketEnvironment(ticket)
      const resources: ResourceHost = { store, pages: new TextCache(4_000_000), prompts, commands, masterId, context: ctx,
        artifacts: this.artifacts, attachmentReferences: trigger => sources.attachmentReferences(trigger),
        readAttachment: async (trigger, id, sessionId, signal) => {
          const result = await sources.readAttachment(trigger, id, ctx.agents.get(sessionId as SessionId), signal)
          const ticketId = ticketOfSession(sessionId), deviceId = ticketId && this.remote?.binding(ticketId)
          if (ticketId && deviceId && result && typeof result === 'object' && 'path' in result && typeof result.path === 'string') {
            const path = `inputs/${key(trigger.id, id)}/${basename(result.path)}`
            const saved = await this.remote.importFile(ticketId, deviceId, result.path, path, true)
            return { ...result, path: saved.path, remote_device: deviceId, remote_directory: saved.directory }
          }
          return result
        },
        promptVersion: id => this.sessions.promptVersion(id), mayRead: (id, revision) => this.sessions.mayRead(id, revision),
        feishuPageSize: () => feishuSettings(sources).readPageSize, sourceLink: link }
      const memory = this.memory = new Memory(store, { tickets: store.tickets,
        resolveSource: source => {
          const id = source.ref.replace(/^(?:trigger|ticket)[:/]/, '')
          const trigger = source.kind === 'trigger' ? store.triggers.get(id) : undefined
          const ticket = source.kind === 'ticket' ? store.tickets.get(id) : undefined
          const human = ticket ? [...ticket.origin.triggerIds, ...ticket.inputs.flatMap(input => input.kind === 'trigger' && input.human ? [input.triggerId] : [])]
            .flatMap(triggerId => { const value = store.triggers.get(triggerId); return value?.human ? [value.text] : [] }).join('\n') : trigger?.text
          return !!human && !!source.quote && human.includes(source.quote)
        },
        notifyCorrection: event => { store.atomic(() => {
          const ticket = store.tickets.get(event.ticketId)
          if (!ticket || ticket.ended) return
          this.engine.note(event.ticketId, `Shared memory ${event.topic} was ${event.kind}; previous revision ${event.previousRevision}, current revision ${event.revision}.\n${event.summary}\nRead the updated context before relying on the old fact.`, event.id)
        }); this.passes.request() } })
      const evidence = this.evidence = new ExecutionEvidence(store)
      const evaluation = this.evaluation = new EvaluationLedger(store, { runId: 'runtime' })
      const measure = (event: EvaluationEvent) => { try { evaluation.record(event) } catch (error) { ctx.logger.warn('Evaluation measurement: %s', String(error)) } }
      const remote = this.remote = new RemoteEnvironments({ store,
        credential: async ref => {
          const value = (await ctx.get('credentials')?.resolve(credentialRef(ref)))?.value ?? process.env[ref]
          if (!value) throw new Error('Execution environment credential is unavailable')
          return value
        },
        requestScope: (ticketId, requestedTriggerId) => {
          const ticket = store.tickets.get(ticketId)
          if (!ticket || ticket.ended || !settingsPolicy(store.settings(), sources).revalidate(ticket.mandate)) return
          const released = new Set(ticket.requests?.filter(item => item.state === 'released').map(item => item.triggerId))
          const claimed = requestIds(ticket).filter(id => !released.has(id))
            .filter(id => requestResponsibility(store, id)?.owners.some(owner => owner.ticketId === ticketId && owner.state === 'claimed'))
          return requestedTriggerId ? claimed.includes(requestedTriggerId) ? requestedTriggerId : undefined : claimed.length === 1 ? claimed[0] : undefined
        },
        mayAccessRequestCommand: (ticketId, triggerId, originalTicketId) => {
          const ticket = store.tickets.get(ticketId), original = store.tickets.get(originalTicketId), trigger = store.triggers.get(triggerId)
          const responsibility = requestResponsibility(store, triggerId), currentPolicy = settingsPolicy(store.settings(), sources)
          if (!ticket || !original || !trigger || ticket.ended?.by === 'human' || !currentPolicy.revalidate(ticket.mandate)
            || !responsibility?.owners.some(owner => owner.ticketId === ticketId && ['proposed', 'claimed', 'completed'].includes(owner.state))
            || !responsibility.owners.some(owner => owner.ticketId === originalTicketId)) return false
          const thread = store.threads.get(`${trigger.threads[0]!.source}:${trigger.threads[0]!.id}`)
          return !!thread && sources.scope(trigger).listened && currentPolicy.gate(trigger, thread, [ticket]).admissible
        },
        mayExecute: ticketId => {
          const ticket = store.tickets.get(ticketId)
          return !!ticket && !ticket.ended && !this.paused() && (!ticket.hold || ticket.hold.kind === 'environment')
            && !this.remote?.commands(ticketId).some(command => command.effectiveState === 'unknown')
            && settingsPolicy(store.settings(), sources).revalidate(ticket.mandate)
        },
        onState: transition => {
          if (this.closing()) return
          store.set(record<RemoteTransition>(`remote-transition:${transition.ticketId}:${transition.commandId}`), transition)
          this.passes.request()
        } })
      const conversations = new SessionConversations({ masterId, stateDir: machine.stateDir, store, artifacts: this.artifacts,
        configured: () => setup.configured(), receive: trigger => this.receive(trigger),
        attachmentPath: block => block.type === 'image' ? ctx.get('attachments')?.imageHostPath(block.attachment)
          : ctx.get('attachments')?.fileHostPath(block.attachment),
        prompt: (id, requestId, text) => this.sessions.prompt(id, requestId, text, 'queue') })
      this.disposers.push(sources.register(conversations.kind))
      const sessions = this.sessions = new Sessions({ context: ctx, store, prompts, effects, conversations, memory, health: board.claim('models'), masterId,
        mayExecute: ticket => settingsPolicy(store.settings(), sources).revalidate(ticket.mandate),
        memoryContext: () => {
          const triggers = store.threads.active().flatMap(thread => thread.evaluating?.triggerIds ?? thread.pending).slice(-4)
            .flatMap(id => store.triggers.get(id) ?? [])
          return { query: triggers.map(trigger => trigger.text).join(' ').slice(0, 200) || undefined,
            scopes: ['global', ...new Set(triggers.map(trigger => `source:${trigger.source}`))] }
        },
        remoteBinding: ticketId => remote.binding(ticketId), remoteTools: ticketId => remote.tools(ticketId),
        lifetime: this.lifetime,
        closing: () => this.closing(), environment,
        tools: (agent, ticket) => [...(ticket ? executorTools(this.toolHost, ticket) : [...mainTools(this.toolHost, agent), ...memory.tools()]),
          ...personalTools(this.personal, ticket?.id, this.personalRuntime)] })
      const policyChanged: EngineForSettings['policyChanged'] = (from, to, effects) => { this.engine.policyChanged(from, to, effects) }
      this.settings = new Settings({ store, sources, engine: { policyChanged }, health: board, context: ctx, lifetime: this.lifetime, sessions,
        sourceHost: this, setup, requestPass: () => { this.passes.request() } })
      this.executor = new DshExecutor({ context: ctx, get engine() { return runtime.engine }, store, effects, health: board.claim('worker'), machine,
        lifetime: this.lifetime, sessions, closing: () => this.closing(), paused: () => this.paused(), environment, sourceLink: link,
        repliedTo: trigger => repliedTo({ store, sources }, trigger),
        mayExecute: ticket => settingsPolicy(store.settings(), sources).revalidate(ticket.mandate),
        launchGuard: ticket => this.qq?.observations.launchGuard(ticket) ?? { allowed: true } })
      this.workerProgress = new WorkerProgress({ store, paused: () => this.paused(), closing: () => this.closing(),
        remind: reminder => this.executor.progressReminder(reminder),
        cancel: (ticketId, requestIds) => { this.executor.cancelProgressReminders(ticketId, requestIds) },
        onError: error => { if (!this.closing()) ctx.logger.warn('dsh-superagent progress reminder: %s', String(error)) } })
      this.assessor = new MasterAssessor({ get engine() { return runtime.engine }, commands, get deployment() { return setup.deployment }, effects,
        settings: () => store.settings(), paused: () => this.paused(), threadContext: trigger => sources.threadContext(trigger),
        deliver: (id, text) => sessions.prompt(masterId, id, text, 'steer'), candidateCard: candidate => candidateCard(links, candidate) })
      const outbox = this.outbox = new Outbox({ store, effects, sources, commands, paused: () => this.paused(),
        allowMessage: message => {
          if (message.purpose === 'result' && message.ticketId && store.tickets.get(message.ticketId)?.requestRedirect) return false
          if (message.completionKey) {
            const ticket = message.ticketId && store.tickets.get(message.ticketId)
            if (!ticket || ticket.ended?.by === 'human' || !completionApproved(ticket) || completionKey(ticket) !== message.completionKey) return false
          }
          return this.personalRuntime?.maySend(message) ?? !message.id.startsWith('personal-')
        } })
      this.personalRuntime = new PersonalRuntime({ store, coordinator: this.personal, outbox, paused: () => this.paused() })
      const { assessor, executor } = this
      const policy = () => settingsPolicy(store.settings(), sources)
      const engine = this.engine = new Engine({ repo: store, scope: sources, policy, assessor, executor,
        provisionalRouting: true,
        followupsEnabled: () => !personal() || this.personal.enabled(),
        outbox, prepareTicket: (ticket, outcome) => this.verification.prepare(executor.prepare(ticket, outcome)), emit: event => {
          if (event.type === 'request.changed') { this.requestReview?.submit(event.data.triggerId); this.requestHandoff?.submit(event.data.triggerId) }
          if (event.type === 'trigger.received') {
            const trigger = store.triggers.get(event.data.triggerId), disposition = store.triggers.disposition(event.data.triggerId)
            if (trigger?.human) measure({ id: `request:${trigger.id}`, kind: 'request', triggerId: trigger.id, at: trigger.at,
              data: { source: trigger.source, observation: !!trigger.meta.observation } })
            if (disposition?.fanout.length) measure({ id: `route:${event.data.triggerId}`, kind: 'route', triggerId: event.data.triggerId,
              at: event.at, data: { path: disposition.directTicketId ? 'direct' : 'subscription' } })
          } else if (event.type === 'decision.recorded') {
            const decision = store.decisions.get(event.data.decisionId)
            if (decision) measure({ id: `decision:${decision.id}`, kind: 'route', at: decision.at,
              ...decision.ticketId ? { ticketId: decision.ticketId } : {}, data: { path: 'router', decision: decision.kind } })
          } else if (event.type === 'ticket.ended') {
            const ticket = store.tickets.get(event.data.ticketId)
            if (ticket) measure({ id: `completion:${ticket.id}:${event.at}`, kind: 'completion', ticketId: ticket.id, at: event.at,
              data: { outcome: ticket.ended?.outcome, durationMs: Math.max(0, Date.parse(event.at) - Date.parse(ticket.createdAt)) } })
          }
          if (event.type === 'ticket.created') {
            const ticket = store.tickets.get(event.data.ticketId)!, source = store.triggers.get(ticket.origin.triggerId)
            const index = memory.index({ ticketId: ticket.id, query: source?.text.slice(0, 200),
              scopes: ['global', `source:${source?.source ?? ticket.mandate.actor.source}`, `ticket:${ticket.id}`,
                ...setup.configured() && setup.deployment.repository ? [`project:${setup.deployment.repository}`] : []] })
            if (index.includes('\n- ')) engine.note(ticket.id, `Relevant durable memory (context only; source requests govern):\n${index}`, `memory-initial:${ticket.id}`)
          }
          // Notify the main Session only about domain events it did not initiate itself.
          const notice = this.quiet ? undefined : eventNotice(event, id => store.tickets.get(id))
          if (notice) sessions.notify(...notice)
          // A person's message that reached an open ticket is the ticket's; the main Session hears of it in the same transaction,
          // and of one for an ended ticket once it resumes, unless it routed the message there itself.
          const followed = !this.quiet && (event.type === 'trigger.received' || event.type === 'ticket.resumed' || event.type === 'trigger.followup')
          const followup = followed ? followupNotice(store, sources, event.data.triggerId) : undefined
          if (followup) sessions.relay(followup.id, followup.text)
          // Notify the ticket's conversations whenever it ends via a pull request.
          const ended = event.type === 'ticket.ended' ? store.tickets.get(event.data.ticketId) : undefined
          if (ended) {
            const released = new Set(ended.requests?.filter(item => item.state === 'released').map(item => item.triggerId))
            void remote.cancelTicket(ended.id, requestIds(ended).filter(id => !released.has(id)))
              .catch(error => ctx.logger.warn('Remote cancellation remains queued: %s', String(error)))
            this.personalRuntime.attention.resolve({ ticketId: ended.id })
            for (const receipt of store.receipts.waiting()) if (receipt.ticketId === ended.id
              && (receipt.id.startsWith('personal-action:') || receipt.id.startsWith('personal-attention:'))) outbox.withdraw(receipt.id)
          }
          if (ended && setup.configured() && setup.deployment.repository) {
            const request = store.triggers.get(ended.origin.triggerId)?.text ?? ''
            for (const message of pullEndNotices(ended, request, setup.deployment.repository)) outbox.send(message)
          }
        } })
      // Update the `evals` health entry on every pass if an evaluation failed as unavailable within the last hour.
      const evals = board.claim('evals', { state: 'ready', detail: 'No unavailable Eval in the last hour' })
      const callReviewModel = dshSupervisionModel(ctx, () => store.settings().eval.model ?? store.settings().executor.model
        ?? ctx.agents.get(masterId as SessionId)?.model?.current?.() ?? undefined)
      let auxiliarySequence = 0
      const reviewModel: typeof callReviewModel = async (input, signal) => {
        const id = `aux-usage:${Date.now()}:${++auxiliarySequence}`
        try {
          const result = await callReviewModel(input, signal), usage = result.usage
          measure({ id, kind: 'usage', data: { tokens: usage ? usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) : null, cost: null, auxiliary: true } })
          return result
        } catch (error) { measure({ id, kind: 'usage', data: { tokens: null, cost: null, auxiliary: true } }); throw error }
      }
      this.requestReview = new RequestReviewService({ store, effects, engine, runModel: reviewModel,
        paused: () => this.paused(), lifetime: this.lifetime, requestPass: () => this.passes.request(),
        authorized: trigger => {
          if (this.paused() || !sources.kind(trigger.source)) return false
          const thread = store.threads.get(`${trigger.threads[0]!.source}:${trigger.threads[0]!.id}`)
          if (!thread) return false
          const gate = policy().gate(trigger, thread, thread.subscriptions.flatMap(id => store.tickets.get(id) ?? []))
          return sources.scope(trigger).listened && gate.admissible && gate.strength === 'explicit'
        },
        recovered: review => measure({ id: `routing-recovery:${review.id}`, kind: 'recovery', triggerId: review.triggerId,
          data: { kind: 'routing', durationMs: Math.max(0, Date.now() - Date.parse(review.createdAt)), requestRevision: review.requestRevision } }) })
      this.requestHandoff = new RequestHandoffService({ store, effects, artifacts: this.artifacts,
        authorized: (from, to, trigger) => {
          if (from.ended?.by === 'human' || to.ended || !policy().revalidate(from.mandate) || !policy().revalidate(to.mandate)) return false
          const thread = store.threads.get(`${trigger.threads[0]!.source}:${trigger.threads[0]!.id}`)
          return !!thread && sources.scope(trigger).listened && policy().gate(trigger, thread, [to]).admissible
        },
        destination: ticket => ticket.execution?.directory,
        importArtifact: async (ticket, _artifact, localPath, relativePath, signal) => {
          signal.throwIfAborted()
          const deviceId = remote.binding(ticket.id)
          if (!deviceId) return { path: localPath }
          if (remote.commands(ticket.id).some(command => command.effectiveState === 'unknown')) throw new Later('Resolve inherited unknown commands before importing handoff files')
          const saved = await remote.importFile(ticket.id, deviceId, localPath, relativePath, true).catch(error => {
            if (error && typeof error === 'object' && 'status' in error && error.status === 503) throw new Later('Waiting for the handoff execution device')
            throw error
          })
          signal.throwIfAborted(); return { path: saved.path, deviceId }
        },
        note: (ticketId, text, requestId) => { engine.note(ticketId, text, requestId) },
        paused: () => this.paused(), lifetime: this.lifetime, requestPass: () => this.passes.request() })
      this.experience = new MemoryExperienceService({ store, memory, effects, runModel: reviewModel,
        paused: () => this.paused(), lifetime: this.lifetime,
        scopes: ticket => [`source:${store.triggers.get(ticket.origin.triggerId)?.source ?? ticket.mandate.actor.source}`,
          ...setup.configured() && setup.deployment.repository ? [`project:${setup.deployment.repository}`] : []] })
      this.verification = new VerificationService({ store, effects, engine, artifacts: this.artifacts,
        recorded: review => {
          const mode = store.tickets.get(review.ticketId)?.acceptance?.mode
          measure({ id: `verification:${review.id}`, kind: 'verification', ticketId: review.ticketId, at: review.at,
            data: { state: review.state, mode, prevented: !review.superseded && mode === 'enforce' && review.state === 'needs_changes' } })
          try { this.experience.submit(review) } catch (error) { ctx.logger.warn('Memory experience extraction deferred: %s', String(error)) }
        },
        runModel: (input, signal) => reviewModel(input, signal ?? this.lifetime),
        executionEvidence: async (ticket, signal) => {
          const events = await readLatestTurnEvents(ctx, workerSessionId(ticket.id) as SessionId, signal)
          for (const event of events) evidence.capture(ticket.id, event)
          const assignment = ticket.assignments.at(-1), started = Date.parse(assignment?.startedAt ?? assignment?.createdAt ?? '')
          const commands = remote.commands(ticket.id).filter(command => Date.parse(command.createdAt) >= started
            || Date.parse(command.remote?.endedAt ?? '') >= started)
          return [...evidence.read(ticket.id), ...commands.map(command => ({ ref: `remote-command/${command.commandId}`,
            kind: 'execution' as const, text: JSON.stringify(command), coverage: command.effectiveState === 'completed' || command.effectiveState === 'failed' ? 'complete' as const : 'unavailable' as const }))]
        }, relay: (id, text) => sessions.relay(id, text), requestPass: () => this.passes.request(),
        paused: () => this.paused(), lifetime: this.lifetime })
      this.supervision = new SupervisionService({ store, runModel: reviewModel, paused: () => this.paused(),
        snapshot: async options => {
          const base = watchdogSnapshot(this.httpHost(), options)
          if (options.includeEvidence) for (const item of base.tickets) {
            const events = await readLatestTurnEvents(ctx, workerSessionId(item.id) as SessionId, this.lifetime)
            for (const event of events) evidence.capture(item.id, event)
          }
          return watchdogSnapshot({ ...this.httpHost(), executionEvidence: ticket => this.watchdogEvidence(ticket) }, options)
        },
        mayAdvise: ticket => !ticket.hold && !this.remote.commands(ticket.id).some(command => command.effectiveState === 'unknown')
          && !this.watchdogEvidence(ticket).some(item => item.kind === 'background' && item.state === 'running'),
        currentExecutionEvidence: ticket => this.watchdogEvidence(ticket),
        advise: (ticketId, text, requestId) => {
          const ticket = store.tickets.get(ticketId)
          if (!ticket || ticket.ended || ticket.hold || !policy().revalidate(ticket.mandate)) return false
          engine.note(ticketId, text, requestId); this.passes.request(); return true
        },
        hold: (ticketId, reason) => {
          const ticket = store.tickets.get(ticketId)
          if (!ticket || ticket.ended || ticket.hold || !policy().revalidate(ticket.mandate)
            || this.remote.commands(ticketId).some(command => command.effectiveState === 'unknown')) return false
          engine.holdTicket(ticketId, { kind: 'operator', at: now(), reason })
          this.passes.request(); return true
        } })
      this.disposers.push(ctx.on('session/event', (session, event) => {
        const ticketId = ticketOfSession(session.id)
        if (this.closing()) return
        if (ticketId) evidence.capture(ticketId, event)
        if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
          if (event.seq === undefined || !Number.isFinite(event.time)) return
          const usage = event.type === 'assistant/message' ? event.data.usage : undefined, callId = `${session.id}:${event.seq}`
          const tokens = usage ? usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) : undefined
          measure({ id: `usage:${callId}`, kind: 'usage', at: new Date(event.time).toISOString(),
            ...ticketId ? { ticketId } : {}, data: { tokens: tokens ?? null, cost: null } })
          if (ticketId) this.qq?.observations.usage(ticketId, { callId, ...tokens !== undefined ? { tokens } : {} })
          else if (session.id === masterId) this.qq?.observations.assessmentUsage(store.threads.active().flatMap(thread => thread.evaluating?.triggerIds ?? []),
            { callId, ...tokens !== undefined ? { tokens } : {} })
          this.passes.request()
        }
      }))
      const evaluateDue = () => {
        this.recordManifest()
        for (const ticket of store.tickets.open()) if (!ticket.hold && sources.kind(ticket.mandate.actor.source) && !policy().revalidate(ticket.mandate)) {
          engine.holdTicket(ticket.id, { kind: 'operator', at: now(), reason: 'Task authority changed; restore the source/requester/rule authorization before resuming.' })
        }
        for (const ticket of store.tickets.open()) if (!ticket.hold && remote.commands(ticket.id).some(command => command.effectiveState === 'unknown')) {
          engine.holdTicket(ticket.id, { kind: 'environment', at: now(), reason: 'An original-request command has an unknown outcome; inspect its preserved result before resuming.' })
        }
        engine.evaluateDue(); this.personalRuntime.tick(); this.workerProgress.tick(); this.verification.tick(); this.requestReview.tick()
        void remote.tick().catch(error => ctx.logger.warn('Remote environment reconciliation: %s', String(error)))
        this.applyRemoteTransitions()
        void memory.flushCorrections().catch(error => ctx.logger.warn('Memory correction delivery: %s', String(error)))
        for (const hold of this.qq?.observations.tick() ?? []) engine.holdTicket(hold.ticketId, { kind: 'budget', reason: hold.reason, at: now() })
        evals.set(evalsHealth(store))
      }
      const passes = this.passes = new Passes({ engine: { receive: trigger => engine.receive(trigger), evaluateDue }, effects,
        health: this.runtimeHealth, lifetime: this.lifetime, configured: () => setup.configured(), closing: () => this.closing() })
      this.sourceDeps = { store, engine, outbox, commands, sources, get ready() { return runtime.ready },
        get deployment() { return setup.deployment }, configured: () => setup.configured(),
        get setupProblem() { return setup.problem }, get feishuProblem() { return setup.feishuProblem }, receive: trigger => passes.receive(trigger) }
      this.toolHost = { context: ctx, engine, store, prompts, sessions, settings: this.settings, assessor, resources, verification: this.verification,
        remote,
        get github() { return runtime.context({ kind: 'github', health: ['github'] }) },
        requestPass: () => { passes.request() }, sendReplies: receiptId => outbox.sent(receiptId),
        quietly: run => { this.quiet++; try { return run() } finally { this.quiet-- } } }
      this.recordManifest('starting')
      this.ready = this.initialize().catch(error => { if (!this.closing()) this.recordManifest('failed'); throw error })
    } catch (error) {
      // Release the database and state lock if initialization fails so an in-process restart can reacquire them.
      try { opened?.close() } finally { release() }
      throw error
    }
  }
  get health(): Readonly<Record<string, Health>> { return this.board.all }
  private recordManifest(phase = this.manifestPhase): void {
    const config = { mode: this.machine.mode ?? 'repository', settings: this.store.settings(), promptRevision: this.store.get(KV.prompts.revision) ?? 0,
      verification: this.verification?.config(), supervision: this.supervision?.config(), routingReview: this.requestReview?.config(),
      environments: this.remote?.list().map(({ id, label, url }) => ({ id, label, url })) ?? [] }
    const serialized = JSON.stringify(config)
    if (this.manifestConfig === serialized && this.manifestPhase === phase) return
    recordRuntimeManifest(this.store, { runId: this.manifestRunId, identity: LOADED_RUNTIME_IDENTITY, config, phase })
    this.manifestConfig = serialized; this.manifestPhase = phase
  }
  private watchdogEvidence(ticket: Ticket): WatchdogExecutionEvidence[] {
    const jobs = this.ctx.get('jobs') as { list(owner: string): { id: string; status: string; label?: string }[] } | undefined
    const background = jobs?.list(workerSessionId(ticket.id)).filter(job => job.status === 'running' || job.status === 'stopping') ?? []
    const at = ticket.assignments.at(-1)?.startedAt ?? ticket.createdAt
    return [...this.evidence.snapshot(ticket.id), ...background.map(job => ({ id: `job/${job.id}`, kind: 'background' as const,
      state: 'running', at, summary: job.label ?? `Background job ${job.id} is ${job.status}.` })),
      ...this.remote.commands(ticket.id).filter(command => ['queued', 'waiting_environment', 'accepted', 'running'].includes(command.effectiveState))
        .map(command => ({ id: `remote-command/${command.commandId}`, kind: 'background' as const, state: 'running', at: command.createdAt,
          summary: `Remote command ${command.commandId} is ${command.effectiveState}.` }))]
  }
  /** Consume durable remote state changes only when the task may act; notes and receipts commit together. */
  private applyRemoteTransitions(): void {
    if (this.paused() || this.closing()) return
    for (const name of this.store.keys('remote-transition:')) this.store.atomic(() => {
      const transition = this.store.get(record<RemoteTransition>(name))
      if (!transition) return
      const ticket = this.store.tickets.get(transition.ticketId)
      if (!ticket || ticket.ended) { this.store.delete(name); return }
      if (!settingsPolicy(this.store.settings(), this.sources).revalidate(ticket.mandate)) return
      if (transition.state === 'waiting_environment' || transition.state === 'unknown') {
        this.engine.holdTicket(ticket.id, { kind: 'environment', at: now(),
          reason: transition.state === 'unknown' ? `Remote command ${transition.commandId} has an unknown outcome; owner verification is required.`
            : `Execution environment ${transition.deviceId} is offline; waiting to reconnect.` })
      } else {
        if (ticket.hold && ticket.hold.kind !== 'environment') return
        if (ticket.hold?.kind === 'environment') {
          this.engine.releaseTicket(ticket.id)
          try { this.evaluation.record({ id: `recovery:${transition.commandId}:${ticket.hold.at}`, kind: 'recovery', ticketId: ticket.id,
            data: { durationMs: Math.max(0, Date.now() - Date.parse(ticket.hold.at)) } }) } catch (error) { this.ctx.logger.warn('Recovery measurement: %s', String(error)) }
        }
        if (transition.commandState && ['completed', 'failed', 'cancelled', 'timed_out'].includes(transition.commandState)) {
          this.engine.note(ticket.id, `Remote command completion event: ${JSON.stringify(this.remote.commandResult(ticket.id, transition.commandId))}. Continue the original task using this observed result; preserve its command_id on retries.`,
            `remote-result:${transition.commandId}:${transition.commandState}`)
        }
      }
      this.store.delete(name)
    })
  }
  /** Aborted when dsh-superagent stops or loses its state directory lock, cancelling running reads and subprocesses. */
  get lifetime(): AbortSignal { return this.stopped.signal }
  context(kind: { kind: string; health: readonly string[] }): SourceContext { return sourceContextOf(this.sourceDeps, kind) }
  /** Resolved deployment; throws while waiting for setup (`!configured()`). */
  get deployment(): Deployment { return this.setup.deployment }
  configured(): boolean { return this.setup.configured() }
  get setupProblem(): SetupProblem | undefined { return this.setup.problem }
  /** Why the Feishu bot is unavailable even though the Feishu Source configures a CLI. */
  get feishuProblem(): SetupProblem | undefined { return this.setup.feishuProblem }
  links(): LinkTarget {
    const resolved = this.setup.configured() ? this.setup.deployment : undefined
    const links = resolved ? { ...(resolved.repository ? { repository: resolved.repository } : {}), ...(resolved.feishu ? { feishu: resolved.feishu } : {}) } : {}
    return channel => this.sources.link(channel, links)
  }
  ticketEnvironment(ticket: Ticket): Variable[] {
    const trigger = sourceTrigger(this, ticket)
    const { setup: { deployment }, sources } = this
    return ticketEnvironment({ deployment, sources, settings: this.store.settings(), ticket, ...trigger ? { trigger } : {} })
  }
  checkSetup(): void { this.setup.check() }
  receive(trigger: Trigger): ReceiveResult { return this.passes.receive(trigger) }
  idle(): Promise<void> { return this.passes.idle() }
  pump(): Promise<void> { return this.passes.pump() }
  sendReplies(): Promise<void> { return this.outbox.sent() }
  private closing(): boolean { return this.closingFlag }
  /** Hold evaluation, dispatch, and outbound delivery while paused or awaiting setup; sources still record incoming triggers. */
  private paused(): boolean { return !this.setup.configured() || this.store.settings().paused }
  private async initialize(): Promise<void> {
    // Register management HTTP routes before setup completes so operators can fix setup problems in the UI.
    this.disposers.push(registerHttp(this.ctx, this.httpHost()))
    if (!await this.setup.run(this.store.settings())) {
      this.runtimeHealth.set({ ...health('paused', 'setupPending'), at: now() })
      return
    }
    await this.sessions.install()
    this.executor.install()
    try { await this.sessions.ensure(this.masterId, this.machine.stateDir, 'dsh-superagent orchestrator', 'orchestrator') }
    catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.runtimeHealth.set({ state: 'error', detail: `Main Session failed to start: ${detail}`, at: now() })
      throw error
    }
    if ((this.machine.mode ?? 'repository') !== 'personal') {
      for (const id of this.settings.syncable()) await this.settings.sync(id).catch(() => { /* sync() records its failure in health. */ })
    }
    // If stop() was called while awaiting setup, session creation, or policy sync, do not start background loops.
    if (this.closing()) return
    this.executor.resume()
    this.passes.start()
    this.effects.start()
    this.runtimeHealth.set({ state: 'ready', detail: 'Orchestrator is ready', at: now() })
    this.recordManifest('ready')
    this.schedules.start()
  }
  private httpHost(): HttpHost {
    const runtime = this
    const { store, sources, prompts, sessions, settings, engine, executor, health, machine, masterId, ready, sourceLinks, setup, passes, schedules } = this
    return { store, sources, prompts, sessions, settings, engine, executor, health, machine, masterId, ready, sourceLinks, artifacts: this.artifacts, schedules,
      personal: this.personal,
      personalRuntime: this.personalRuntime,
      verification: this.verification, supervision: this.supervision, requestReview: this.requestReview,
      evaluation: this.evaluation,
      remote: this.remote,
      runtimeManifest: () => runtimeManifestState(store),
      get qq() { return runtime.qq },
      get deployment() { return setup.deployment },
      get setupProblem() { return setup.problem }, get feishuProblem() { return setup.feishuProblem },
      configured: () => setup.configured(), links: () => runtime.links(), ticketEnvironment: ticket => runtime.ticketEnvironment(ticket),
      inspectWorker: (ticketId, signal) => readSessionEvents(this.ctx, workerSessionId(ticketId) as SessionId, signal),
      checkSetup: () => { setup.check() }, requestPass: () => { passes.request() }, models: () => this.ctx.sessionController.modelCatalog() }
  }
  /** Idempotent stop; concurrent or repeated calls share the same shutdown promise. */
  stop(): Promise<void> { return this.stopping ??= this.shutdown() }
  private async shutdown(): Promise<void> {
    this.closingFlag = true; const schedules = this.schedules.stop(); const passes = this.passes.stop(); this.stopped.abort()
    const remote = this.remote.close()
    try {
      this.assessor.stop()
      const ids = [this.masterId, ...this.sessions.conversationIds(), ...this.store.tickets.list().map(ticket => workerSessionId(ticket.id))]
      const agents = ids.map(id => this.ctx.agents.get(id as SessionId)).filter((agent): agent is Agent => agent !== undefined)
      for (const agent of agents) agent.cancel({ kind: 'user' }, { keepInbox: true })
      await Promise.allSettled([remote, schedules, passes, this.personalRuntime.drain(), this.workerProgress.drain(), this.effects.drain(), ...agents.map(agent => agent.whenIdle())])
      // The workers' jobs and subagents stop too: their ends would start worker turns without the tool limits released below.
      await this.executor.shutdown()
      this.executor.dispose()
      this.sessions.dispose()
      for (const dispose of this.disposers.reverse()) dispose()
      await this.ctx.sessionPersistence.flush()
    } finally {
      // Close the database before releasing the directory lock so another process cannot open the database mid-write; a compromised lock may already be released.
      this.setup.restore()
      try { this.store.close() } finally {
        const unreleased = (error: unknown) => { this.ctx.logger.warn('dsh-superagent could not release its state directory lock: %s',
          String(error)) }
        await this.releaseLock?.().catch(unreleased)
      }
    }
  }
}
