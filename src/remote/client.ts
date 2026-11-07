/** Host-side device registry, durable command intents and reconnect/cancel reconciliation. */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Store } from '../app/store.ts'
import type { Tool } from '../app/tools/tool.ts'
import { record } from '../kv.ts'
import { remoteTools } from './tools.ts'
import { commandPayload, ENVIRONMENT_PROTOCOL, ENVIRONMENT_SCHEMA, EnvironmentError, environmentUrl, payloadHash, safeRemoteText,
  sha256, terminalCommand, validId, type CommandPayload, type CommandState, type EnvironmentHealth, type RemoteCommand, type RemoteFile } from './protocol.ts'

export interface RemoteDeviceConfig { id: string; label: string; url: string; credentialRef: string; allowInsecureHttp?: boolean }
interface Device extends RemoteDeviceConfig { status: 'unprobed' | 'online' | 'offline' | 'identity_changed'; daemonId?: string; lastSeenAt?: string; error?: string; health?: EnvironmentHealth }
export interface RemoteIntent {
  commandId: string; deviceId: string; ticketId: string; requestId: string; payload: CommandPayload; payloadHash: string
  /** Original human request identity survives a transfer; ticketId and daemon payload keep their first execution owner. */
  requestTriggerId?: string
  state: 'queued' | 'waiting_environment' | CommandState; createdAt: string; updatedAt: string
  sent?: boolean; daemonId?: string; cancelRequested?: boolean; remote?: RemoteCommand; error?: string
  ownerResolution?: { outcome: 'completed' | 'failed' | 'cancelled'; evidence: string; at: string }
  resolutionHistory?: { outcome: 'completed' | 'failed' | 'cancelled'; evidence: string; at: string }[]
}
export interface RemoteTransition { ticketId: string; deviceId: string; commandId: string; state: 'waiting_environment' | 'ready' | 'unknown'; commandState?: RemoteIntent['state'] }
export interface RemoteEnvironmentsHost {
  store: Pick<Store, 'get' | 'set' | 'keys' | 'atomic'>
  credential(ref: string): Promise<string> | string
  fetchImpl?: typeof fetch
  timeoutMs?: number
  onState?(transition: RemoteTransition): void
  /** Rechecked before new executable work; permits held-but-authorized reconnects and refuses withdrawn mandates. */
  mayExecute?(ticketId: string): boolean
  /** Resolve an executable claimed original request; an ambiguous/missing scope refuses new operations. */
  requestScope?(ticketId: string, requestedTriggerId?: string): string | undefined
  /** Current source authority may permit a proposed/claimed successor to inspect preserved command history. */
  mayAccessRequestCommand?(ticketId: string, requestTriggerId: string, originalTicketId: string): boolean
  now?(): number
}
export interface RemoteOperationResult {
  deviceId: string; ticketId: string; commandId: string; state: RemoteIntent['state']; remote?: RemoteCommand; error?: string
  requestTriggerId?: string
  directory?: string; cancelRequested?: boolean
  updatedAt?: string; ownerResolution?: RemoteIntent['ownerResolution']
}
const DEVICE = 'remote-device:', INTENT = 'remote-command:', BINDING = 'remote-binding:', WAIT = 'remote-wait:'
const deviceKey = (id: string) => record<Device>(`${DEVICE}${id}`)
const intentKey = (id: string) => record<RemoteIntent>(`${INTENT}${id}`)
const bindingKey = (id: string) => record<{ deviceId: string; at: string }>(`${BINDING}${id}`)
const waitKey = (id: string) => record<RemoteTransition & { at: string }>(`${WAIT}${id}`)
const unsettled = (intent: RemoteIntent) => !intent.ownerResolution && ['queued', 'waiting_environment', 'accepted', 'running', 'unknown'].includes(intent.state)

/** Registers execution devices and persists task-bound command intents through disconnects, cancellation and owner resolution. */
export class RemoteEnvironments {
  private host: RemoteEnvironmentsHost
  private operations = new Map<string, Promise<RemoteOperationResult>>()
  private controller = new AbortController()
  private lastTick = 0
  private ticking?: Promise<RemoteTransition[]>
  constructor(host: RemoteEnvironmentsHost) { this.host = host }
  private now() { return this.host.now?.() ?? Date.now() }
  private at() { return new Date(this.now()).toISOString() }
  private records(): RemoteIntent[] { return this.host.store.keys(INTENT).map(key => this.host.store.get<RemoteIntent>(key)).filter((item): item is RemoteIntent => !!item) }
  private mayAccess(ticketId: string, intent: RemoteIntent): boolean {
    if (!intent.requestTriggerId) return intent.ticketId === ticketId
    try {
      if (this.host.mayAccessRequestCommand) return this.host.mayAccessRequestCommand(ticketId, intent.requestTriggerId, intent.ticketId)
      if (this.host.requestScope) return this.host.requestScope(ticketId, intent.requestTriggerId) === intent.requestTriggerId
      return intent.ticketId === ticketId
    } catch { return false }
  }
  private requestScope(ticketId: string, requestedTriggerId?: string): string | undefined {
    if (!this.host.requestScope) {
      if (requestedTriggerId !== undefined) throw new EnvironmentError('request_scope', 'Original-request command scope requires the host responsibility resolver', 403)
      return
    }
    if (requestedTriggerId !== undefined) validId(requestedTriggerId, 'source_request_id')
    const scope = this.host.requestScope(ticketId, requestedTriggerId)
    if (!scope || requestedTriggerId !== undefined && scope !== requestedTriggerId)
      throw new EnvironmentError('request_held', 'Choose a claimed original source_request_id for this operation; claim proposed work before execution', 403)
    return validId(scope, 'source_request_id')
  }
  private assertCommandAccess(ticketId: string, intent: RemoteIntent | undefined): asserts intent is RemoteIntent {
    if (!intent || !this.mayAccess(ticketId, intent)) throw new EnvironmentError('command_missing', 'Command was not found for this task or its current original-request ownership', 404)
    // An authorized successor may inspect an operation on its original device after selecting another environment.
    this.assertBinding(ticketId, intent.requestTriggerId ? undefined : intent.deviceId)
  }
  private device(id: string): Device {
    const device = this.host.store.get(deviceKey(id))
    if (!device) throw new EnvironmentError('device_missing', 'Choose a registered execution environment', 404)
    return device
  }
  register(input: RemoteDeviceConfig): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(input.id) || !input.label.trim() || input.label.length > 100
      || !input.credentialRef || input.credentialRef.length > 500) throw new EnvironmentError('device_config', 'Invalid execution environment registration')
    const url = environmentUrl(input.url, input.allowInsecureHttp), previous = this.host.store.get(deviceKey(input.id))
    if (previous && previous.url !== url && this.records().some(item => item.deviceId === input.id && unsettled(item)))
      throw new EnvironmentError('device_busy', 'Resolve existing commands before changing the environment address', 409)
    this.host.store.set(deviceKey(input.id), { ...previous, ...input, url, status: previous?.url === url ? previous.status : 'unprobed' })
  }
  list() {
    return this.host.store.keys(DEVICE).map(key => this.host.store.get<Device>(key)).filter((item): item is Device => !!item)
      .map(({ credentialRef: _credential, allowInsecureHttp: _insecure, ...device }) => device)
  }
  binding(ticketId: string): string | undefined { return this.host.store.get(bindingKey(validId(ticketId, 'ticketId')))?.deviceId }
  commands(ticketId: string): (Omit<RemoteIntent, 'payload'> & { effectiveState: RemoteIntent['state'] })[] {
    return this.records().filter(intent => this.mayAccess(ticketId, intent)).map(({ payload: _payload, ...intent }) => ({ ...intent, effectiveState: intent.ownerResolution?.outcome ?? intent.state }))
  }
  /** The local owner panel retains raw and inherited history after task stop or transfer; Worker tools use commands(). */
  ownerCommands(ticketId: string, requestTriggerIds: readonly string[] = []): ReturnType<RemoteEnvironments['commands']> {
    const related = new Set(requestTriggerIds)
    return this.records().filter(intent => intent.ticketId === ticketId || !!intent.requestTriggerId && related.has(intent.requestTriggerId))
      .map(({ payload: _payload, ...intent }) => ({ ...intent, effectiveState: intent.ownerResolution?.outcome ?? intent.state }))
  }
  hasUnsettled(ticketId: string): boolean { return this.records().some(intent => this.mayAccess(ticketId, intent) && unsettled(intent)) }
  assertExecuting(ticketId: string): void {
    if (this.records().some(intent => this.mayAccess(ticketId, intent) && intent.state === 'unknown' && !intent.ownerResolution))
      throw new EnvironmentError('unknown_pending', 'Inspect and owner-resolve the unknown operation before starting new work for this task', 409)
    if (this.host.mayExecute?.(ticketId) === false) throw new EnvironmentError('task_held', 'The current task authority is holding executable work', 403)
  }
  /** Owner-only host operation; it records an observed outcome and never replays or rewrites daemon history. */
  resolveUnknown(ticketId: string, commandId: string, input: { outcome: 'completed' | 'failed' | 'cancelled'; evidence: string; expectedUpdatedAt?: string },
    ownerRequestIds?: readonly string[]): RemoteOperationResult {
    return this.host.store.atomic(() => {
      const intent = this.host.store.get(intentKey(commandId))
      if (ownerRequestIds === undefined) this.assertCommandAccess(ticketId, intent)
      else if (!intent || intent.ticketId !== ticketId && (!intent.requestTriggerId || !ownerRequestIds.includes(intent.requestTriggerId)))
        throw new EnvironmentError('command_missing', 'Command was not found in the owner task history', 404)
      if (intent.state !== 'unknown') throw new EnvironmentError('resolution_state', 'Only an unknown operation needs owner resolution', 409)
      if (!['completed', 'failed', 'cancelled'].includes(input.outcome) || !input.evidence.trim() || input.evidence.length > 2000)
        throw new EnvironmentError('resolution_evidence', 'Owner resolution requires a concrete outcome and observed evidence')
      const evidence = safeRemoteText(input.evidence, undefined, 2000)
      if (intent.ownerResolution?.outcome === input.outcome && intent.ownerResolution.evidence === evidence) return this.result(intent)
      if (input.expectedUpdatedAt !== undefined && input.expectedUpdatedAt !== intent.updatedAt) throw new EnvironmentError('resolution_conflict', 'The command changed after the owner inspected it; reload its state', 409)
      const resolution = { outcome: input.outcome, evidence, at: this.at() }
      const updated = { ...intent, ownerResolution: resolution, resolutionHistory: [...intent.resolutionHistory ?? [], resolution].slice(-20), updatedAt: this.at() }
      this.host.store.set(intentKey(commandId), updated)
      this.notify({ ticketId, deviceId: intent.deviceId, commandId, state: 'ready', commandState: input.outcome })
      return this.result(updated)
    })
  }
  bind(ticketId: string, deviceId: string): void {
    validId(ticketId, 'ticketId'); this.device(deviceId)
    const previous = this.binding(ticketId)
    if (previous && previous !== deviceId && this.records().some(item => item.ticketId === ticketId && unsettled(item)))
      throw new EnvironmentError('task_busy', 'Resolve active or unknown commands before changing this task environment', 409)
    this.host.store.set(bindingKey(ticketId), { deviceId, at: this.at() })
  }
  assertBinding(ticketId: string, deviceId?: string): string {
    const bound = this.binding(ticketId)
    if (!bound || deviceId && deviceId !== bound) throw new EnvironmentError('task_binding', 'Use the execution environment bound to this task', 403)
    return bound
  }
  private async call<T>(device: Device, path: string, options: { method?: string; body?: unknown; maxBytes?: number; executableTicketId?: string; executableRequestTriggerId?: string } = {}): Promise<T> {
    this.controller.signal.throwIfAborted()
    const token = await this.host.credential(device.credentialRef)
    if (!token || token.length < 24) throw new EnvironmentError('credential', 'The host credential reference has no usable environment token', 401)
    try {
      if (options.executableTicketId) this.assertExecuting(options.executableTicketId)
      if (options.executableTicketId && options.executableRequestTriggerId) this.requestScope(options.executableTicketId, options.executableRequestTriggerId)
      const response = await (this.host.fetchImpl ?? fetch)(`${device.url}${path}`, { method: options.method ?? 'GET',
        headers: { authorization: `Bearer ${token}`, ...(options.body ? { 'content-type': 'application/json' } : {}) },
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
        signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(this.host.timeoutMs ?? 5000)]) })
      const chunks: Buffer[] = []; let size = 0
      if (response.body) for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        size += chunk.byteLength
        if (size > (options.maxBytes ?? 256_000)) throw new EnvironmentError('response_limit', 'Environment response exceeded its limit', 413)
        chunks.push(Buffer.from(chunk))
      }
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      if (!response.ok) throw new EnvironmentError(String(value.error ?? 'environment_error'), safeRemoteText(value.message ?? `Environment HTTP ${response.status}`, token, 1000), response.status)
      return value as T
    } catch (error) {
      if (error instanceof EnvironmentError) throw error
      throw new EnvironmentError('environment_offline', safeRemoteText(error instanceof Error ? error.message : error, token, 1000), 503)
    }
  }
  async probe(id: string): Promise<ReturnType<RemoteEnvironments['list']>[number]> {
    const device = this.device(id)
    try {
      const health = await this.call<EnvironmentHealth>(device, '/v1/health')
      if (health.protocol !== ENVIRONMENT_PROTOCOL || health.schema !== ENVIRONMENT_SCHEMA || typeof health.daemonId !== 'string')
        throw new EnvironmentError('protocol', 'Environment protocol or state schema requires operator review', 409)
      if (device.daemonId && device.daemonId !== health.daemonId) throw new EnvironmentError('identity_changed', 'Environment identity changed; inspect preserved commands before approving this device', 409)
      this.host.store.set(deviceKey(id), { ...device, status: 'online', daemonId: health.daemonId, lastSeenAt: this.at(), health, error: undefined })
    } catch (error) {
      this.host.store.set(deviceKey(id), { ...device, status: error instanceof EnvironmentError && error.code === 'identity_changed' ? 'identity_changed' : 'offline', error: safeRemoteText(error instanceof Error ? error.message : error, undefined, 1000) })
      throw error
    }
    return this.list().find(device => device.id === id)!
  }
  private notify(transition: RemoteTransition): void {
    const transitionKey = record<RemoteTransition>(`remote-transition:${transition.ticketId}:${transition.commandId}`)
    const previous = this.host.store.get(transitionKey)
    this.host.store.set(transitionKey, transition)
    this.host.store.set(waitKey(transition.ticketId), { ...transition, at: this.at() })
    if (previous?.state !== transition.state || previous.deviceId !== transition.deviceId || previous.commandState !== transition.commandState) {
      try { this.host.onState?.(transition) } catch { /* Host event delivery can retry from the durable command record. */ }
    }
  }
  commandResult(ticketId: string, commandId: string): RemoteOperationResult | undefined {
    const intent = this.host.store.get(intentKey(commandId))
    return intent && this.mayAccess(ticketId, intent) ? this.result(intent) : undefined
  }
  private result(intent: RemoteIntent): RemoteOperationResult {
    return { deviceId: intent.deviceId, ticketId: intent.ticketId, commandId: intent.commandId, state: intent.ownerResolution?.outcome ?? intent.state, updatedAt: intent.updatedAt,
      ...intent.requestTriggerId ? { requestTriggerId: intent.requestTriggerId } : {},
      ...(intent.remote ? { remote: intent.remote, directory: intent.remote.directory } : {}), ...(intent.error ? { error: intent.error } : {}),
      ...(intent.cancelRequested ? { cancelRequested: true } : {}), ...(intent.ownerResolution ? { ownerResolution: intent.ownerResolution } : {}) }
  }
  async start(deviceId: string, ticketId: string, request: { requestId: string; requestTriggerId?: string; command: string; cwd?: string; timeoutMs?: number }): Promise<RemoteOperationResult> {
    this.assertBinding(ticketId, deviceId); validId(request.requestId, 'requestId')
    const requestTriggerId = this.requestScope(ticketId, request.requestTriggerId)
    const payload = commandPayload({ ticketId, command: request.command, cwd: request.cwd, timeoutMs: request.timeoutMs })
    const identity = requestTriggerId ? [deviceId, 'request', requestTriggerId, request.requestId] : [deviceId, ticketId, request.requestId]
    const id = sha256(JSON.stringify(identity)), hash = payloadHash(payload), previous = this.host.store.get(intentKey(id))
    if (requestTriggerId && !previous) {
      const legacy = this.records().find(intent => !intent.requestTriggerId && intent.requestId === request.requestId
        && (intent.ticketId === ticketId || this.host.mayAccessRequestCommand?.(ticketId, requestTriggerId, intent.ticketId) === true))
      if (legacy) throw new EnvironmentError('legacy_operation_scope', `Preserved task-scoped operation ${legacy.commandId} needs inspection before adopting an original-request operation ID; query that command and keep its saved outcome`, 409)
    }
    if (requestTriggerId && this.records().some(intent => intent.requestTriggerId === requestTriggerId && intent.requestId === request.requestId && intent.deviceId !== deviceId))
      throw new EnvironmentError('request_device_conflict', 'This original-request operation already belongs to another device; inspect its preserved command before choosing a new operation ID', 409)
    if (previous && (!this.mayAccess(ticketId, previous) || previous.requestTriggerId !== requestTriggerId))
      throw new EnvironmentError('request_owner', 'The original request no longer belongs to this task', 403)
    const comparableHash = previous?.requestTriggerId ? payloadHash({ ...payload, ticketId: previous.payload.ticketId }) : hash
    if (previous && previous.payloadHash !== comparableHash) throw new EnvironmentError('id_conflict', 'Reuse a request ID only for the same command, directory and timeout', 409)
    // A stable retry remains a query even while an owner-held/unknown operation blocks new executable work.
    if (previous && (previous.state === 'unknown' || previous.ownerResolution)) return this.result(previous)
    if (previous && previous.ticketId !== ticketId) {
      const result = await this.reconcile(id, true, ticketId)
      this.assertCommandAccess(ticketId, this.host.store.get(intentKey(id)))
      return result
    }
    if (previous && ['completed', 'failed', 'cancelled', 'timed_out'].includes(previous.state)) return this.result(previous)
    this.assertExecuting(ticketId)
    if (!previous) this.host.store.set(intentKey(id), { commandId: id, deviceId, ticketId, requestId: request.requestId, payload, payloadHash: hash,
      ...requestTriggerId ? { requestTriggerId } : {},
      state: 'queued', createdAt: this.at(), updatedAt: this.at() })
    return this.reconcile(id)
  }
  async status(ticketId: string, commandId: string): Promise<RemoteOperationResult> {
    const intent = this.host.store.get(intentKey(validId(commandId, 'commandId')))
    this.assertCommandAccess(ticketId, intent)
    const result = await this.reconcile(commandId, intent.ticketId !== ticketId, ticketId)
    this.assertCommandAccess(ticketId, this.host.store.get(intentKey(commandId)))
    return result
  }
  async cancel(ticketId: string, commandId: string): Promise<RemoteOperationResult> {
    const intent = this.host.store.get(intentKey(validId(commandId, 'commandId')))
    this.assertCommandAccess(ticketId, intent)
    if (intent.requestTriggerId) this.requestScope(ticketId, intent.requestTriggerId)
    this.host.store.set(intentKey(commandId), { ...intent, cancelRequested: true, updatedAt: this.at() })
    const active = this.operations.get(commandId); if (active) await active
    return this.reconcile(commandId, intent.ticketId !== ticketId, ticketId)
  }
  /** Host lifecycle cancellation follows explicit current request ownership even after owners become terminal. */
  async cancelTicket(ticketId: string, ownedRequestIds?: readonly string[]): Promise<void> {
    const owned = ownedRequestIds === undefined ? undefined : new Set(ownedRequestIds)
    const commands = this.records().filter(item => unsettled(item) && (item.requestTriggerId && owned
      ? owned.has(item.requestTriggerId) : item.ticketId === ticketId))
    for (const item of commands) this.host.store.set(intentKey(item.commandId), { ...item, cancelRequested: true, updatedAt: this.at() })
    const wait = this.host.store.get(waitKey(ticketId))
    if (wait) this.host.store.set(waitKey(ticketId), { ...wait, state: 'unknown', at: this.at() })
    await Promise.allSettled(commands.map(command => this.reconcile(command.commandId)))
  }
  private reconcile(id: string, queryOnly = false, viewerTicketId?: string): Promise<RemoteOperationResult> {
    const operationKey = queryOnly ? `${id}:query` : id
    const pending = this.operations.get(operationKey); if (pending) return pending
    const work = this.reconcileOne(id, queryOnly).then(result => {
      if (viewerTicketId && viewerTicketId !== result.ticketId && this.mayAccess(viewerTicketId, this.host.store.get(intentKey(id))!)) this.notify({ ticketId: viewerTicketId, deviceId: result.deviceId, commandId: id,
        state: result.state === 'unknown' ? 'unknown' : result.state === 'waiting_environment' ? 'waiting_environment' : 'ready', commandState: result.state })
      return result
    }).finally(() => { this.operations.delete(operationKey) }); this.operations.set(operationKey, work); return work
  }
  private async reconcileOne(id: string, queryOnly = false): Promise<RemoteOperationResult> {
    let intent = this.host.store.get(intentKey(id))!
    if (intent.ownerResolution) return this.result(intent)
    if (terminalCommand(intent.state as CommandState) && !['queued', 'waiting_environment', 'unknown'].includes(intent.state)) return this.result(intent)
    const device = this.device(intent.deviceId)
    try {
      await this.probe(device.id)
      const currentDevice = this.device(device.id)
      if (intent.daemonId && intent.daemonId !== currentDevice.daemonId) throw new EnvironmentError('identity_changed', 'Command belongs to an earlier environment identity', 409)
      let remote: RemoteCommand | undefined
      try { remote = await this.call<RemoteCommand>(device, `/v1/commands/${encodeURIComponent(id)}?ticketId=${encodeURIComponent(intent.ticketId)}`) }
      catch (error) { if (!(error instanceof EnvironmentError && error.status === 404)) throw error }
      intent = this.host.store.get(intentKey(id))!
      if (!remote && intent.sent && intent.state === 'unknown') return this.result(intent)
      if (!remote && intent.cancelRequested) {
        intent = { ...intent, state: 'cancelled', updatedAt: this.at(), error: undefined }; this.host.store.set(intentKey(id), intent)
        this.notify({ ticketId: intent.ticketId, deviceId: intent.deviceId, commandId: id, state: 'ready' }); return this.result(intent)
      }
      if (!remote && queryOnly) {
        if (intent.sent) {
          intent = { ...intent, state: 'unknown', updatedAt: this.at(), error: 'Preserved operation is absent on its original device; inspect its outcome before continuing.' }
          this.host.store.set(intentKey(id), intent)
        }
        return this.result(intent)
      }
      if (!remote) {
        this.assertExecuting(intent.ticketId)
        if (intent.requestTriggerId) this.requestScope(intent.ticketId, intent.requestTriggerId)
        // Persist transmission identity before dispatch. A lost response is resolved by GET of this same command ID.
        intent = { ...intent, sent: true, daemonId: currentDevice.daemonId, updatedAt: this.at() }; this.host.store.set(intentKey(id), intent)
        remote = await this.call<RemoteCommand>(device, '/v1/commands/start', { method: 'POST', body: { ...intent.payload, commandId: id, payloadHash: intent.payloadHash },
          executableTicketId: intent.ticketId, executableRequestTriggerId: intent.requestTriggerId })
      }
      if (remote.commandId !== id || remote.ticketId !== intent.ticketId || remote.payloadHash !== intent.payloadHash)
        throw new EnvironmentError('protocol', 'Environment command identity does not match this request', 409)
      intent = this.host.store.get(intentKey(id))!
      if (intent.cancelRequested && !terminalCommand(remote.state)) remote = await this.call<RemoteCommand>(device, `/v1/commands/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: { ticketId: intent.ticketId } })
      intent = { ...intent, remote, state: remote.state, daemonId: currentDevice.daemonId, updatedAt: this.at(), error: undefined }
      this.host.store.set(intentKey(id), intent)
      this.notify({ ticketId: intent.ticketId, deviceId: intent.deviceId, commandId: id, state: remote.state === 'unknown' ? 'unknown' : 'ready', commandState: remote.state })
      return this.result(intent)
    } catch (error) {
      intent = this.host.store.get(intentKey(id))!
      const unknown = error instanceof EnvironmentError && ['identity_changed', 'protocol', 'id_conflict'].includes(error.code)
      const permanent = error instanceof EnvironmentError && !unknown && !['task_held', 'request_held', 'credential'].includes(error.code) && [400, 403, 404, 413].includes(error.status)
      intent = { ...intent, state: unknown ? 'unknown' : permanent ? 'failed' : 'waiting_environment', updatedAt: this.at(), error: safeRemoteText(error instanceof Error ? error.message : error, undefined, 1000) }
      this.host.store.set(intentKey(id), intent)
      this.notify({ ticketId: intent.ticketId, deviceId: intent.deviceId, commandId: id, state: unknown ? 'unknown' : permanent ? 'ready' : 'waiting_environment', commandState: intent.state })
      return this.result(intent)
    }
  }
  tick(): Promise<RemoteTransition[]> {
    if (this.ticking) return this.ticking
    if (this.controller.signal.aborted || this.now() - this.lastTick < 5000) return Promise.resolve([])
    this.lastTick = this.now()
    this.ticking = this.tickOnce().finally(() => { this.ticking = undefined })
    return this.ticking
  }
  private async tickOnce(): Promise<RemoteTransition[]> {
    const transitions: RemoteTransition[] = []
    for (const intent of this.records().filter(item => ['queued', 'waiting_environment', 'accepted', 'running'].includes(item.state)).slice(0, 50)) {
      const result = await this.reconcile(intent.commandId)
      transitions.push({ ticketId: result.ticketId, deviceId: result.deviceId, commandId: result.commandId,
        state: result.state === 'waiting_environment' ? 'waiting_environment' : result.state === 'unknown' ? 'unknown' : 'ready', commandState: result.state })
    }
    const commands = new Set(transitions.map(item => item.ticketId))
    for (const key of this.host.store.keys(WAIT)) {
      const wait = this.host.store.get<RemoteTransition & { at: string }>(key)
      if (!wait || wait.state !== 'waiting_environment' || commands.has(wait.ticketId)) continue
      try { await this.probe(wait.deviceId); const ready: RemoteTransition = { ...wait, state: 'ready' }; this.notify(ready); transitions.push(ready) } catch {}
    }
    return transitions
  }
  async workspace(ticketId: string): Promise<{ deviceId: string; directory: string }> {
    const deviceId = this.assertBinding(ticketId), device = this.device(deviceId)
    try { await this.probe(deviceId); return { deviceId, ...await this.call<{ directory: string }>(device, '/v1/workspaces', { method: 'POST', body: { ticketId } }) } }
    catch (error) { this.notify({ ticketId, deviceId, commandId: 'workspace', state: 'waiting_environment' }); throw error }
  }
  async readFile(ticketId: string, deviceId: string, path: string): Promise<RemoteFile> {
    this.assertBinding(ticketId, deviceId)
    try {
      await this.probe(deviceId)
      const file = await this.call<RemoteFile>(this.device(deviceId), `/v1/files?${new URLSearchParams({ ticketId, path })}`, { maxBytes: 72 * 1024 * 1024 })
      const bytes = Buffer.from(file.base64, 'base64')
      if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) throw new EnvironmentError('hash_mismatch', 'Downloaded environment file failed its digest check', 409)
      return file
    } catch (error) {
      if (error instanceof EnvironmentError && error.status === 503) this.notify({ ticketId, deviceId, commandId: 'file', state: 'waiting_environment' })
      throw error
    }
  }
  async writeFile(ticketId: string, deviceId: string, path: string, bytes: Buffer, overwrite = false) {
    this.assertBinding(ticketId, deviceId); this.assertExecuting(ticketId)
    try {
      await this.probe(deviceId)
      const file = await this.call<Omit<RemoteFile, 'base64'>>(this.device(deviceId), '/v1/files', { method: 'POST',
        body: { ticketId, path, base64: bytes.toString('base64'), sha256: sha256(bytes), overwrite }, executableTicketId: ticketId })
      if (file.bytes !== bytes.length || file.sha256 !== sha256(bytes)) throw new EnvironmentError('hash_mismatch', 'Environment file receipt failed its digest check', 409)
      return file
    } catch (error) {
      if (error instanceof EnvironmentError && error.status === 503) this.notify({ ticketId, deviceId, commandId: 'file', state: 'waiting_environment' })
      throw error
    }
  }
  async importFile(ticketId: string, deviceId: string, localPath: string, remotePath: string, overwrite = false) {
    return this.writeFile(ticketId, deviceId, remotePath, await readFile(localPath), overwrite)
  }
  async toolText(ticketId: string, text: string): Promise<string> {
    const device = this.device(this.assertBinding(ticketId)), token = await this.host.credential(device.credentialRef)
    return safeRemoteText(text, token, 72 * 1024 * 1024)
  }
  async downloadArtifact(ticketId: string, deviceId: string, remotePath: string, destination: string): Promise<{ path: string; sha256: string; bytes: number }> {
    const file = await this.readFile(ticketId, deviceId, remotePath)
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
    const temporary = `${destination}.${randomUUID()}.tmp`
    await writeFile(temporary, Buffer.from(file.base64, 'base64'), { mode: 0o600, flag: 'wx' }); await rename(temporary, destination)
    return { path: destination, sha256: file.sha256, bytes: file.bytes }
  }
  tools(ticketId: string): Tool[] { return remoteTools(this, ticketId) }
  async close(): Promise<void> {
    this.controller.abort()
    await Promise.allSettled([...this.operations.values(), ...(this.ticking ? [this.ticking] : [])])
  }
}

export function remoteArtifactReference(deviceId: string, path: string): string { return `remote://${deviceId}/${path.split(/[/\\]/).map(encodeURIComponent).join('/')}` }
export function parseRemoteArtifactReference(value: string): { deviceId: string; path: string } | undefined {
  const match = /^remote:\/\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\/(.+)$/.exec(value)
  if (!match) return undefined
  try { return { deviceId: match[1]!, path: match[2]!.split('/').map(decodeURIComponent).join('/') } } catch { throw new EnvironmentError('artifact_reference', 'Invalid remote artifact reference') }
}
