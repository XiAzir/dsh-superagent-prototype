#!/usr/bin/env node
/** Independent, loopback-only Watchdog for dsh-superagent. It reads by default; recovery and nudges require explicit flags. */
import { spawn } from 'node:child_process'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MANAGER = resolve(ROOT, 'scripts', 'dsh-superagent')
const WATCHDOG_STATE = profile => resolve(ROOT, '.artifacts', 'control', 'profiles', profile, 'watchdog.json')
const STOP_MARKER = profile => resolve(ROOT, '.artifacts', 'control', 'profiles', profile, 'manually-stopped')
const MAX_OUTPUT = 128 * 1024
const STATUS = new Set(['healthy', 'waiting', 'stalled', 'diverged'])

export function loopbackUrl(input) {
  let url
  try { url = new URL(input) } catch { throw new Error('Watchdog URL must be an absolute HTTP loopback URL') }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password
    || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('Watchdog URL must target only an HTTP loopback host without credentials, path, query or fragment')
  }
  return url.origin
}

function validateAssessment(value) {
  if (!value || typeof value !== 'object' || !STATUS.has(value.status) || !Array.isArray(value.findings)) {
    throw new Error('Assessor must return JSON with status and findings')
  }
  const findings = value.findings.slice(0, 100).map(item => {
    if (!item || typeof item !== 'object' || !STATUS.has(item.status) || !Array.isArray(item.evidence)
      || typeof item.recommendation !== 'string') throw new Error('Assessor returned an invalid finding')
    return { ...(typeof item.ticketId === 'string' ? { ticketId: item.ticketId.slice(0, 200) } : {}), status: item.status,
      evidence: item.evidence.slice(0, 8).filter(entry => typeof entry === 'string').map(entry => redactText(entry).slice(0, 500)),
      recommendation: redactText(item.recommendation).slice(0, 500) }
  })
  const nudgeTicketIds = Array.isArray(value.nudgeTicketIds) ? [...new Set(value.nudgeTicketIds.filter(id => typeof id === 'string').slice(0, 10))] : []
  const semanticReview = value.semanticReview === 'configured' ? 'configured' : 'not_configured'
  return { status: value.status, findings, nudgeTicketIds, semanticReview }
}
function redactText(value) {
  return value.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[redacted]')
    .replace(/\b((?:gh[pousr]_|github_pat_|xox[baprs]-|sk-)[A-Za-z0-9_-]{12,})\b/g, '[redacted]')
    .replace(/\b(token|secret|password|passwd|authorization|api[_-]?key)(\s*[:=]\s*)([^\s,;]+)/gi, '$1$2[redacted]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[redacted]@')
}

export function assessorInput(snapshot) {
  return JSON.stringify({ task: 'Review this bounded Superagent operations snapshot.',
    guidance: 'Return JSON only: {status: healthy|waiting|stalled|diverged, findings:[{ticketId?,status,evidence:string[],recommendation}], nudgeTicketIds?:string[]}. Judge substantive progress from report and execution-trace evidence. Elapsed time only selected review candidates; it is never proof of no progress. A completed ticket, explicit human stop, waiting-person state, paused system, queued work, or active/background execution may be legitimate. Never infer intent from absent evidence. Recommend only a request-status nudge for a live worker whose latest report is waiting. Do not recommend killing work, changing prompts, widening scope, or sending external messages.',
    snapshot: redactSnapshot(snapshot) })
}
function redactSnapshot(value) {
  if (typeof value === 'string') return redactText(value)
  if (Array.isArray(value)) return value.map(redactSnapshot)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactSnapshot(item)]))
  return value
}

export async function runCommand(command, { input = '', timeoutMs = 30_000, maxOutput = MAX_OUTPUT, signal, env } = {}) {
  if (!Array.isArray(command) || command.length < 1 || command.some(part => typeof part !== 'string' || part.length > 8192)) {
    throw new Error('Command must be a non-empty argv array')
  }
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command[0], command.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: env ?? process.env })
    const out = [], err = []; let bytes = 0, settled = false, stopError
    const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', aborted);
      error ? reject(error) : resolvePromise(result) }
    const terminate = error => { if (settled || stopError) return; stopError = error; child.kill(); if (child.pid === undefined) finish(error) }
    const aborted = () => terminate(new Error('Command was aborted'))
    const collect = target => chunk => { bytes += chunk.length; if (bytes > maxOutput) { terminate(new Error('Command output exceeded its limit')); return }
      target.push(chunk) }
    child.stdout.on('data', collect(out)); child.stderr.on('data', collect(err))
    child.once('error', error => { if (!child.pid) finish(error); else stopError ??= error })
    child.once('close', code => stopError ? finish(stopError)
      : code === 0 ? finish(undefined, { stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') })
        : finish(new Error(`Command exited with ${code}: ${Buffer.concat(err).toString('utf8').slice(0, 2000)}`)))
    const timer = setTimeout(() => terminate(new Error(`Command timed out after ${timeoutMs} ms`)), timeoutMs)
    if (signal?.aborted) { aborted(); return }
    signal?.addEventListener('abort', aborted, { once: true })
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}

async function getSnapshot(url, timeoutMs, fetchImpl, signal) {
  const response = await fetchImpl(`${url}/orchestrator/api/watchdog/snapshot`, { headers: { 'x-orchestrator-request': '1' },
    signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]) })
  if (!response.ok) throw new Error(`Snapshot request failed with HTTP ${response.status}`)
  const value = await response.json()
  if (!value || value.schema !== 1 || !value.infrastructure || !Array.isArray(value.tickets)) throw new Error('Snapshot response has an unsupported schema')
  return value
}

function fallback(snapshot) {
  const errors = Object.entries(snapshot.infrastructure.health ?? {}).filter(([, health]) => health.state === 'error')
  if (errors.length) return validateAssessment({ status: 'stalled', findings: errors.map(([name, health]) => ({ status: 'stalled',
    evidence: [`${name}: ${String(health.detail ?? '').slice(0, 500)}`], recommendation: 'Inspect this component and its recent logs.' })) })
  if (!snapshot.infrastructure.configured || snapshot.infrastructure.paused || snapshot.infrastructure.setup?.length) return validateAssessment({
    status: 'waiting', findings: [{ status: 'waiting', evidence: [...!snapshot.infrastructure.configured ? ['Setup is incomplete.'] : [],
      ...snapshot.infrastructure.paused ? ['Processing is paused.'] : [], ...(snapshot.infrastructure.setup ?? [])],
    recommendation: 'Wait for an operator to complete setup or resume processing.' }] })
  const waiting = snapshot.tickets.filter(ticket => ['waiting_person', 'stopped'].includes(ticket.status))
  if (waiting.length) return validateAssessment({ status: 'waiting', findings: waiting.slice(0, 100).map(ticket => ({ ticketId: ticket.id, status: 'waiting',
    evidence: [ticket.status === 'stopped' ? 'Person stopped this ticket.' : `Ticket waits for a person (${ticket.stage}).`],
    recommendation: 'Wait for the person and preserve the ticket state.' })) })
  return validateAssessment({ status: 'healthy', findings: [] })
}

async function assess(snapshot, command, timeoutMs, commandRunner, signal) {
  if (!command) return fallback(snapshot)
  const result = await commandRunner(command, { input: assessorInput(snapshot), timeoutMs, maxOutput: 64 * 1024, signal, env: assessorEnvironment() })
  return { ...validateAssessment(JSON.parse(result.stdout)), semanticReview: 'configured' }
}

function assessorEnvironment() {
  const allowed = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LANG', 'LC_ALL', 'DSH_HOME'])
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => {
    const key = name.toUpperCase()
    return allowed.has(key) || key.startsWith('DSH_SUPERAGENT_WATCHDOG_ASSESSOR_')
  }))
}

function fingerprint(snapshot, assessment) {
  const health = Object.fromEntries(Object.entries(snapshot.infrastructure?.health ?? {}).map(([name, item]) => [name,
    { state: item.state, ...(item.state === 'error' ? { detail: item.detail } : {}) }]))
  const infrastructure = snapshot.infrastructure ? { configured: snapshot.infrastructure.configured, paused: snapshot.infrastructure.paused,
    setup: snapshot.infrastructure.setup, health } : snapshot.infrastructure
  const tickets = (snapshot.tickets ?? []).filter(ticket => ['waiting_person', 'stopped', 'completed', 'waiting'].includes(ticket.status)
    || ticket.repeatedErrors > 0).map(ticket => ({ id: ticket.id, status: ticket.status, stage: ticket.stage,
    ...(ticket.status === 'waiting_person' || ticket.status === 'stopped' || ticket.status === 'completed' || ticket.repeatedErrors > 0
      ? { report: ticket.report && { state: ticket.report.state, summary: ticket.report.summary }, attention: ticket.attention,
        ended: ticket.ended, repeatedErrors: ticket.repeatedErrors, deliveryError: ticket.deliveryError } : { reportState: ticket.report?.state }) }))
  const findings = assessment.findings?.some(item => item.status !== 'healthy') || assessment.status !== 'healthy' ? assessment.findings : []
  const stable = { infrastructure, capacityFull: (snapshot.executor?.maxWorkers ?? 0) > 0
      && snapshot.executor.activeWorkers >= snapshot.executor.maxWorkers,
    tickets, status: assessment.status, semanticReview: assessment.semanticReview, findings }
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex')
}

async function readState(path) {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch { return {} }
}
async function saveState(path, state) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
  await (await import('node:fs/promises')).rename(temporary, path)
}
async function exists(path) { try { await access(path); return true } catch { return false } }

function managerCommand(options) {
  if (options.managerCommand) return options.managerCommand
  const manager = options.manager ?? MANAGER
  return process.platform === 'win32'
    ? [process.env.PYTHON || 'python', manager, '--profile', options.profile, '--url', options.url, '--respect-stop', 'restart']
    : [manager, '--profile', options.profile, '--url', options.url, '--respect-stop', 'restart']
}

async function recoverIfAllowed(options, state, commandRunner, emit) {
  if (!options.recover) return { attempted: false }
  const manualStop = options.stopMarker ? await exists(options.stopMarker) : await exists(STOP_MARKER(options.profile))
  if (manualStop) return { attempted: false, skipped: 'manual-stop' }
  const now = options.now()
  const timeValue = value => typeof value === 'number' ? value : Date.parse(value)
  let recovery = state.recovery ?? { attempts: 0, windowStartedAt: now, nextAt: 0 }
  const windowStartedAt = timeValue(recovery.windowStartedAt)
  if (!Number.isFinite(windowStartedAt) || now - windowStartedAt > options.recoveryWindowMs) recovery = { attempts: 0, windowStartedAt: now, nextAt: 0 }
  if (recovery.attempts >= options.maxRecoveries) return { attempted: false, skipped: 'maximum-attempts' }
  const nextAt = timeValue(recovery.nextAt)
  if (Number.isFinite(nextAt) && nextAt > now) return { attempted: false, skipped: 'backoff', nextAt: new Date(nextAt).toISOString() }
  recovery.attempts++
  const delay = Math.min(options.recoveryMaxDelayMs, options.recoveryBaseDelayMs * 2 ** (recovery.attempts - 1))
  recovery.nextAt = now + delay
  state.recovery = recovery
  await emit({ event: 'recovery_started', profile: options.profile, attempt: recovery.attempts, nextAttemptAt: recovery.nextAt })
  try {
    const result = await commandRunner(managerCommand(options), { timeoutMs: options.managerTimeoutMs, maxOutput: 32 * 1024, signal: options.signal })
    recovery.lastResult = 'ok'; recovery.lastAt = new Date(now).toISOString()
    return { attempted: true, result: 'ok', output: result.stdout.slice(0, 2000), attempt: recovery.attempts }
  } catch (error) {
    recovery.lastResult = 'failed'; recovery.lastError = String(error).slice(0, 1000); recovery.lastAt = new Date(now).toISOString()
    return { attempted: true, result: 'failed', error: recovery.lastError, attempt: recovery.attempts }
  }
}

/** One bounded inspection cycle. Network and command execution are injectable for deterministic tests. */
export async function watchdogOnce(options) {
  const merged = { profile: 'superagent', url: 'http://127.0.0.1:3082', timeoutMs: 5000, stateFile: WATCHDOG_STATE(options.profile ?? 'superagent'),
    candidateAfterMs: 30 * 60_000, nudgeCooldownMs: 30 * 60_000, recover: false, nudge: false, maxRecoveries: 3, recoveryWindowMs: 6 * 60 * 60_000,
    recoveryBaseDelayMs: 10 * 60_000, recoveryMaxDelayMs: 2 * 60 * 60_000, managerTimeoutMs: 60_000,
    now: () => Date.now(), fetchImpl: globalThis.fetch, commandRunner: runCommand, emit: async value => process.stdout.write(JSON.stringify(value) + '\n'), ...options }
  merged.url = loopbackUrl(merged.url)
  const state = await readState(merged.stateFile)
  let snapshot, assessment, error, errorKind
  try {
    snapshot = await getSnapshot(merged.url, merged.timeoutMs, merged.fetchImpl, merged.signal)
  } catch (caught) {
    if (merged.signal?.aborted) return { report: { status: 'waiting', cancelled: true }, changed: false, exitCode: 0 }
    error = String(caught instanceof Error ? caught.message : caught)
    errorKind = 'snapshot'
  }
  if (snapshot) try {
    assessment = await assess(snapshot, merged.assessorCommand, merged.timeoutMs, merged.commandRunner, merged.signal)
  } catch (caught) {
    if (merged.signal?.aborted) return { report: { status: 'waiting', cancelled: true }, changed: false, exitCode: 0 }
    error = String(caught instanceof Error ? caught.message : caught)
    errorKind = 'assessor'
  }
  if (error) assessment = { status: 'stalled', semanticReview: merged.assessorCommand ? 'configured' : 'not_configured',
    findings: [{ status: 'stalled', evidence: [error], recommendation: errorKind === 'assessor' ? 'Repair the assessor command or model service; do not restart the Superagent host for an assessor failure.'
      : 'Check the local service health and logs.' }], nudgeTicketIds: [] }
  let recovery = { attempted: false }
  const infrastructure = snapshot?.infrastructure
  const runtimeError = infrastructure?.health?.runtime?.state === 'error'
  const infrastructureFailure = errorKind === 'snapshot' || (!!infrastructure?.configured && !infrastructure.paused && !infrastructure.setup?.length && runtimeError)
  if (infrastructureFailure && merged.recover) recovery = await recoverIfAllowed(merged, state, merged.commandRunner, merged.emit)
  const nudgeResults = []
  const eligibleIds = new Set((snapshot?.tickets ?? []).filter(ticket => ticket.status === 'waiting' && ticket.report?.state === 'waiting'
    && ticket.latestAssignment?.state === 'running').map(ticket => ticket.id))
  const sentNudges = state.nudges ?? (state.nudges = {})
  if (merged.nudge && snapshot && !error) for (const ticketId of [...new Set(assessment.nudgeTicketIds)].filter(id => eligibleIds.has(id))) {
    const prior = typeof sentNudges[ticketId] === 'number' ? sentNudges[ticketId] : Date.parse(sentNudges[ticketId] ?? '')
    if (Number.isFinite(prior) && merged.now() - prior < merged.nudgeCooldownMs) continue
    try {
      const response = await merged.fetchImpl(`${merged.url}/orchestrator/api/watchdog/tickets/${encodeURIComponent(ticketId)}/request-status`, {
        method: 'POST', headers: { 'x-orchestrator-request': '1', 'content-type': 'application/json' }, body: '{}',
        signal: AbortSignal.any([AbortSignal.timeout(merged.timeoutMs), ...(merged.signal ? [merged.signal] : [])]) })
      const result = response.ok ? await response.json() : { requested: false, error: `HTTP ${response.status}` }
      nudgeResults.push({ ticketId, ...result })
      if (result.requested === true) sentNudges[ticketId] = merged.now()
    } catch (caught) { nudgeResults.push({ ticketId, requested: false, error: String(caught).slice(0, 500) }) }
  }
  const key = fingerprint(snapshot ?? { infrastructure: { error }, tickets: [], candidates: [] }, assessment)
  const failureFingerprint = error ? `${errorKind}:${key}` : undefined
  const recoveredFrom = state.failureFingerprint && !error ? state.failureFingerprint : undefined
  const recoveryNotice = recovery.skipped ? String(recovery.skipped) : recovery.attempted ? `attempt:${recovery.attempt}` : undefined
  const changed = state.fingerprint !== key || (!!error && state.failureFingerprint !== failureFingerprint) || !!recoveredFrom || recovery.attempted
    || (!!recoveryNotice && state.lastRecoveryNotice !== recoveryNotice)
    || nudgeResults.some(result => result.requested === true)
  state.fingerprint = key
  state.failureFingerprint = failureFingerprint
  state.failureKind = errorKind
  state.lastRecoveryNotice = recoveryNotice
  state.lastSeenAt = new Date(merged.now()).toISOString()
  await saveState(merged.stateFile, state)
  const report = { profile: merged.profile, status: assessment.status, ...(error ? { error, errorKind } : {}), ...(recoveredFrom ? { recovered: true } : {}),
    ...(snapshot ? { observedAt: snapshot.observedAt, infrastructure: snapshot.infrastructure, executor: snapshot.executor,
      ticketCount: snapshot.tickets.length, candidateCount: snapshot.candidates.length } : {}), findings: assessment.findings,
    ...(assessment.semanticReview ? { semanticReview: assessment.semanticReview } : {}), ...(recovery.attempted || recovery.skipped ? { recovery } : {}),
    ...(nudgeResults.length ? { nudges: nudgeResults } : {}) }
  if (changed) await merged.emit(report)
  return { report, changed, exitCode: assessment.status === 'healthy' ? 0 : assessment.status === 'waiting' ? 2 : 3 }
}

const sleep = (ms, signal) => new Promise(resolvePromise => {
  if (signal.aborted) return resolvePromise()
  const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolvePromise() }
  const timer = setTimeout(done, ms); signal.addEventListener('abort', done, { once: true })
})

function parseArgs(argv) {
  const options = { url: process.env.DSH_SUPERAGENT_URL || 'http://127.0.0.1:3082', profile: process.env.DSH_SUPERAGENT_PROFILE || 'superagent',
    timeoutMs: 5000, intervalMs: 5 * 60_000, once: false, recover: false, nudge: false, candidateAfterMs: 30 * 60_000 }
  const valueFlags = new Map([['--url', 'url'], ['--profile', 'profile'], ['--timeout-ms', 'timeoutMs'], ['--interval-ms', 'intervalMs'],
    ['--candidate-after-ms', 'candidateAfterMs'], ['--assessor-command', 'assessorCommand'], ['--manager-command', 'managerCommand'],
    ['--manager', 'manager'], ['--state-file', 'stateFile'], ['--stop-marker', 'stopMarker'], ['--max-recoveries', 'maxRecoveries'],
    ['--recovery-window-ms', 'recoveryWindowMs'], ['--recovery-base-delay-ms', 'recoveryBaseDelayMs'], ['--recovery-max-delay-ms', 'recoveryMaxDelayMs']])
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--once') options.once = true
    else if (flag === '--recover') options.recover = true
    else if (flag === '--nudge') options.nudge = true
    else if (valueFlags.has(flag)) {
      const value = argv[++i]
      if (value === undefined) throw new Error(`${flag} needs a value`)
      const key = valueFlags.get(flag)
      options[key] = ['assessorCommand', 'managerCommand'].includes(key) ? JSON.parse(value)
        : ['timeoutMs', 'intervalMs', 'candidateAfterMs', 'maxRecoveries', 'recoveryWindowMs', 'recoveryBaseDelayMs', 'recoveryMaxDelayMs'].includes(key) ? Number(value) : value
    } else throw new Error(`Unknown option: ${flag}`)
  }
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(options.profile)) throw new Error('Invalid profile name')
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 100 || options.timeoutMs > 120_000) throw new Error('--timeout-ms must be between 100 and 120000')
  if (!Number.isFinite(options.intervalMs) || options.intervalMs < 1000) throw new Error('--interval-ms must be at least 1000')
  if (options.maxRecoveries !== undefined && (!Number.isInteger(options.maxRecoveries) || options.maxRecoveries < 1 || options.maxRecoveries > 10)) {
    throw new Error('--max-recoveries must be an integer from 1 to 10')
  }
  for (const key of ['recoveryWindowMs', 'recoveryBaseDelayMs', 'recoveryMaxDelayMs']) if (options[key] !== undefined
    && (!Number.isFinite(options[key]) || options[key] < 1)) throw new Error(`--${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)} must be positive`)
  options.url = loopbackUrl(options.url)
  options.stateFile ??= WATCHDOG_STATE(options.profile)
  return options
}

async function main() {
  const options = parseArgs(process.argv.slice(2)), abort = new AbortController()
  const stop = () => abort.abort()
  process.on('SIGINT', stop); process.on('SIGTERM', stop)
  let lastCode = 0
  do {
    try { lastCode = (await watchdogOnce({ ...options, now: Date.now, signal: abort.signal })).exitCode }
    catch (error) { if (!abort.signal.aborted) process.stderr.write(`${String(error)}\n`); lastCode = abort.signal.aborted ? 0 : 3 }
    if (options.once || abort.signal.aborted) break
    await sleep(options.intervalMs, abort.signal)
  } while (!abort.signal.aborted)
  if (options.once) process.exitCode = lastCode
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`${String(error)}\n`); process.exitCode = 3 })
}

