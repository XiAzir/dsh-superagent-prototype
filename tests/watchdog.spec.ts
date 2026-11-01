import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { expect, it } from 'vitest'
import { registerHttp, type HttpHost } from '../src/app/http.ts'
import { baselineAssessment, watchdogSnapshot } from '../src/app/watchdog.ts'
import { assessorInput, loopbackUrl, runCommand, watchdogOnce } from '../scripts/dsh-superagent-watchdog.mjs'

const SCRIPT = resolve('scripts/dsh-superagent-watchdog.mjs')
const hostName = '127.0.0.1'

it('restricts the Watchdog target to a loopback HTTP origin', () => {
  expect(loopbackUrl('http://127.0.0.1:3082')).toBe('http://127.0.0.1:3082')
  expect(loopbackUrl('http://localhost:3082/')).toBe('http://localhost:3082')
  for (const url of ['https://127.0.0.1:3082', 'http://example.com', 'http://127.0.0.1:3082/path',
    'http://user:pass@127.0.0.1:3082', 'http://127.0.0.1:3082/?token=x']) expect(() => loopbackUrl(url)).toThrow()
})

it('redacts quoted credential fields and structured secret keys before assessor input', () => {
  const serialized = assessorInput({ schema: 1, observedAt: '', infrastructure: { configured: true, paused: false,
    health: { runtime: { state: 'ready', detail: '{"app_secret":"json-secret-value", "api_key": "key-secret-value"} token="quoted-token-value"' } } },
    executor: { activeWorkers: 0, maxWorkers: 1 }, tickets: [{ id: 't', token: 'structured-token-value', app_secret: 'structured-app-secret-value' }], candidates: [] })
  for (const secret of ['json-secret-value', 'key-secret-value', 'quoted-token-value', 'structured-token-value', 'structured-app-secret-value']) {
    expect(serialized).not.toContain(secret)
  }
  expect(serialized).toContain('[redacted]')
})

it('builds bounded snapshots that distinguish completion, human waits, stops and review candidates', () => {
  const at = '2026-10-31T00:00:00.000Z'
  const make = (id: string, report: string, ended?: { by: string; outcome: string }) => ({ id, title: `Ticket ${id}`, decisionId: 'd',
    mandate: { strength: 'explicit', policyVersion: 'v', basis: { via: 'addressed', addressed: 'mention' }, actor: { source: 'qq', id: 'x' }, scope: 's' },
    channels: [], assignments: [{ id: `a-${id}`, state: ended ? 'ended' : 'running', createdAt: at, startedAt: at,
      report: { state: report, summary: 'check current state', at } }], inputs: [], undelivered: [], createdAt: at, updatedAt: at,
    origin: { triggerId: 't', triggerIds: ['t'] }, ...(ended ? { ended: { at, ...ended } } : {}) })
  const tickets = [make('human', 'blocked'), make('done', 'ready', { by: 'executor', outcome: 'completed' }),
    make('stopped', 'dropped', { by: 'human', outcome: 'stopped' }), make('long', 'progress')]
  const snapshot = watchdogSnapshot({ store: { tickets: { list: () => tickets as never }, settings: () => ({ paused: false, executor: { maxWorkers: 3 } }) },
    health: { runtime: { state: 'ready', detail: 'token=secret-value ghp_abcdefghijklmnopqrstuvwxyz123456', at } }, executor: { activeCount: () => 1 }, machine: {}, configured: () => true },
  { now: new Date('2026-10-31T02:00:00Z'), candidateAfterMs: 60_000 })
  expect(snapshot.tickets.find(ticket => ticket.id === 'human')?.status).toBe('waiting_person')
  expect(snapshot.tickets.find(ticket => ticket.id === 'done')?.status).toBe('completed')
  expect(snapshot.tickets.find(ticket => ticket.id === 'stopped')?.status).toBe('stopped')
  expect(snapshot.candidates.map(item => item.ticketId)).toContain('long')
  expect(snapshot.candidates[0]?.reason).toContain('does not imply lack of progress')
  expect(JSON.stringify(snapshot)).not.toContain('credential')
  expect(JSON.stringify(snapshot)).not.toContain('secret-value')
  expect(JSON.stringify(snapshot)).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz123456')
})

it('classifies infrastructure errors while keeping human waits as waiting', () => {
  const empty = { schema: 1 as const, observedAt: '', infrastructure: { configured: true, paused: false,
    health: { runtime: { state: 'error', detail: 'database unavailable' } }, setup: [] }, executor: { activeWorkers: 0, maxWorkers: 2 }, tickets: [], candidates: [] }
  expect(baselineAssessment(empty).status).toBe('stalled')
  expect(baselineAssessment({ ...empty, infrastructure: { ...empty.infrastructure, health: {} }, tickets: [
    { id: 't', title: 'x', status: 'waiting_person', stage: 'person', repeatedErrors: 0, trace: [], inputCount: 0, undeliveredCount: 0 },
  ] }).status).toBe('waiting')
})

it('exposes a same-origin snapshot and a worker-status-only nudge route', async () => {
  let handler: ((req: unknown, res: unknown) => Promise<void>) | undefined
  const ticket = { id: 't1', ended: undefined }
  let requested = ''
  const fake = { ready: Promise.resolve(), store: { settings: () => ({ paused: false, executor: { maxWorkers: 2 } }),
    tickets: { list: () => [], get: (id: string) => id === 't1' ? ticket : undefined } }, health: {}, executor: { activeCount: () => 0 },
    machine: {}, configured: () => true, engine: { requestStatus: (id: string) => { requested = id; return id === 't1' } }, requestPass: () => {} }
  const ctx = { webServer: { host: hostName, port: 3082, register: ({ handler: value }: { handler: typeof handler }) => { handler = value; return () => {} } } }
  registerHttp(ctx as never, fake as unknown as HttpHost)
  const call = async (method: string, path: string, headers: Record<string, string> = {}) => {
    let status = 0, body = ''
    const req = { method, url: `/orchestrator/api/${path}`, headers: { host: '127.0.0.1:3082', 'x-orchestrator-request': '1', ...headers }, async *[Symbol.asyncIterator]() {} }
    await handler!(req, { writeHead: (value: number) => { status = value }, end: (value: string) => { body = value } })
    return { status, body: body ? JSON.parse(body) as Record<string, unknown> : {} }
  }
  expect((await call('GET', 'watchdog/snapshot')).body).toMatchObject({ schema: 1, infrastructure: { configured: true } })
  expect(await call('POST', 'watchdog/tickets/t1/request-status')).toMatchObject({ status: 200, body: { requested: true } })
  expect(requested).toBe('t1')
  expect(await call('POST', 'watchdog/tickets/t1/request-status', { origin: 'http://evil.example' })).toMatchObject({ status: 403 })
})

it('sends only snapshot review facts to a stub assessor and suppresses identical reports', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-watchdog-'))
  const server = await listen((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ schema: 1,
    observedAt: new Date().toISOString(), infrastructure: { configured: true, paused: false, health: {}, setup: [] },
    executor: { activeWorkers: 1, maxWorkers: 3 }, tickets: [{ id: 'w1', status: 'working', title: 'task', trace: [{ state: 'progress', summary: 'made progress' }] }],
    candidates: [{ ticketId: 'w1', reason: 'elapsed-time candidate' }] })) })
  try {
    const outputs: unknown[] = [], assessorInputs: string[] = []
    const options = { url: `http://${hostName}:${(server.address() as { port: number }).port}`, stateFile: join(directory, 'state.json'),
      assessorCommand: ['stub'], commandRunner: async (_command: string[], call: { input: string }) => {
        assessorInputs.push(call.input)
        return { stdout: JSON.stringify({ status: 'healthy', findings: [{ ticketId: 'w1', status: 'healthy', evidence: ['recent report says progress'],
          recommendation: 'Continue observing' }] }), stderr: '' }
      }, emit: async (value: unknown) => { outputs.push(value) } }
    const first = await watchdogOnce(options)
    const second = await watchdogOnce(options)
    expect(first.changed).toBe(true)
    expect(second.changed).toBe(false)
    expect(outputs).toHaveLength(1)
    expect(assessorInputs[0]).toContain('Elapsed time only selected review candidates')
    expect(assessorInputs[0]).not.toContain('source-message-body')
  } finally { await close(server); await rm(directory, { recursive: true, force: true }) }
})

it('uses numeric recovery-window timestamps and resets the attempt limit after the window', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-watchdog-window-'))
  try {
    let now = 1_800_000_000_000, recoveries = 0
    const options = { url: 'http://127.0.0.1:3082', profile: 'test', stateFile: join(directory, 'state.json'), recover: true,
      stopMarker: join(directory, 'absent-marker'), recoveryWindowMs: 100, recoveryBaseDelayMs: 1, recoveryMaxDelayMs: 1, maxRecoveries: 2,
      now: () => now, fetchImpl: async () => { throw new Error('service unavailable') }, commandRunner: async () => { recoveries++; return { stdout: '', stderr: '' } }, emit: async () => {} }
    const first = await watchdogOnce(options)
    now += 50
    const second = await watchdogOnce(options)
    now += 150
    const third = await watchdogOnce(options)
    expect([(first.report.recovery as { attempt: number }).attempt, (second.report.recovery as { attempt: number }).attempt,
      (third.report.recovery as { attempt: number }).attempt]).toEqual([1, 2, 1])
    expect(recoveries).toBe(3)
    const saved = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'))
    expect(typeof saved.recovery.windowStartedAt).toBe('number')
    expect(typeof saved.recovery.nextAt).toBe('number')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('does not recover the host for an assessor failure or a Source component error', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-watchdog-no-recover-'))
  const value = { schema: 1, observedAt: '2026-10-31T00:00:00Z', infrastructure: { configured: true, paused: false,
    health: { source: { state: 'error', detail: 'poll failed' } }, setup: [] }, executor: { activeWorkers: 0, maxWorkers: 2 }, tickets: [], candidates: [] }
  try {
    let managerCalls = 0
    const common = { url: 'http://127.0.0.1:3082', stateFile: join(directory, 'state.json'), recover: true,
      stopMarker: join(directory, 'absent-marker'), fetchImpl: async () => ({ ok: true, json: async () => value }),
      commandRunner: async () => { managerCalls++; throw new Error('assessor unavailable') }, emit: async () => {} }
    const assessor = await watchdogOnce({ ...common, assessorCommand: ['stub'] })
    expect(assessor.report.errorKind).toBe('assessor')
    expect(assessor.report.semanticReview).toBe('configured')
    const sourceError = await watchdogOnce({ ...common, stateFile: join(directory, 'source.json') })
    expect(sourceError.report.status).toBe('stalled')
    expect(sourceError.report.recovery).toBeUndefined()
    // The one runner call was the assessor itself; no second call was made for a host restart.
    expect(managerCalls).toBe(1)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('recovers a runtime failure only when configured and unpaused', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-watchdog-runtime-recovery-'))
  try {
    let calls = 0
    const make = (name: string, paused: boolean, setup: string[]) => ({ url: 'http://127.0.0.1:3082', stateFile: join(directory, `${name}.json`),
      recover: true, stopMarker: join(directory, 'absent-marker'), now: () => 1_800_000_000_000,
      fetchImpl: async () => ({ ok: true, json: async () => ({ schema: 1, observedAt: '', infrastructure: { configured: true, paused, setup,
        health: { runtime: { state: 'error', detail: 'failed' } } }, executor: { activeWorkers: 0, maxWorkers: 2 }, tickets: [], candidates: [] }) }),
      commandRunner: async () => { calls++; return { stdout: '', stderr: '' } }, emit: async () => {} })
    const live = await watchdogOnce(make('live', false, []))
    const paused = await watchdogOnce(make('paused', true, []))
    const pending = await watchdogOnce(make('pending', false, ['setup required']))
    expect(live.report.recovery).toMatchObject({ attempted: true })
    expect(paused.report.recovery).toBeUndefined()
    expect(pending.report.recovery).toBeUndefined()
    expect(calls).toBe(1)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('filters and cools down nudges to live workers explicitly waiting for status', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-watchdog-nudge-'))
  try {
    const value = { schema: 1, observedAt: '2026-10-31T00:00:00Z', infrastructure: { configured: true, paused: false, health: {}, setup: [] },
      executor: { activeWorkers: 1, maxWorkers: 2 }, tickets: [
        { id: 'waiting', status: 'waiting', report: { state: 'waiting' }, latestAssignment: { state: 'running' } },
        { id: 'busy', status: 'working', report: { state: 'progress' }, latestAssignment: { state: 'running' } },
      ], candidates: [] }
    let posts = 0
    const fetchImpl = async (_url: string, init?: { method?: string }) => init?.method === 'POST'
      ? (posts++, { ok: true, json: async () => ({ requested: true }) })
      : ({ ok: true, json: async () => value })
    const options = { url: 'http://127.0.0.1:3082', stateFile: join(directory, 'state.json'), nudge: true, now: () => 1_800_000_000_000,
      nudgeCooldownMs: 60_000, assessorCommand: ['stub'], fetchImpl,
      commandRunner: async () => ({ stdout: JSON.stringify({ status: 'healthy', findings: [], nudgeTicketIds: ['busy', 'waiting', 'waiting', 'missing'] }), stderr: '' }), emit: async () => {} }
    await watchdogOnce(options)
    await watchdogOnce(options)
    expect(posts).toBe(1)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('does not report changing healthy work summaries but reports completion and human-wait transitions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-watchdog-fingerprint-'))
  try {
    const ticket: { id: string; status: string; stage: string; report?: { state: string; summary: string }; repeatedErrors: number;
      ended?: { at: string; outcome: string }; attention?: string } = { id: 't1', status: 'working', stage: 'working',
      report: { state: 'progress', summary: 'Step one' }, repeatedErrors: 0 }
    const value = { schema: 1, observedAt: '2026-10-31T00:00:00Z', infrastructure: { configured: true, paused: false,
      health: { runtime: { state: 'ready', detail: 'ready', at: 'first' } }, setup: [] }, executor: { activeWorkers: 1, maxWorkers: 2 },
      tickets: [ticket], candidates: [] }
    const outputs: unknown[] = []
    const options = { url: 'http://127.0.0.1:3082', stateFile: join(directory, 'state.json'), fetchImpl: async () => ({ ok: true, json: async () => value }),
      commandRunner: async () => ({ stdout: JSON.stringify({ status: 'healthy', findings: [] }), stderr: '' }), assessorCommand: ['stub'],
      emit: async (report: unknown) => { outputs.push(report) } }
    await watchdogOnce(options)
    ticket.report!.summary = 'Step two'
    value.infrastructure.health.runtime.at = 'second'
    await watchdogOnce(options)
    expect(outputs).toHaveLength(1)
    ticket.status = 'completed'
    ticket.ended = { at: '2026-10-31T00:01:00Z', outcome: 'completed' }
    await watchdogOnce(options)
    expect(outputs).toHaveLength(2)
    ticket.status = 'waiting_person'
    ticket.attention = 'Need owner decision'
    await watchdogOnce(options)
    expect(outputs).toHaveLength(3)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('waits for a timed-out child process to close before rejecting', async () => {
  const started = Date.now()
  await expect(runCommand([process.execPath, '-e', 'setTimeout(()=>{},10000)'], { timeoutMs: 100 })).rejects.toThrow('timed out')
  expect(Date.now() - started).toBeLessThan(2000)
})

it('terminates real descendant processes on timeout and output overflow within a hard bound', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-watchdog-tree-'))
  const source = 'const{spawn}=require("node:child_process");const fs=require("node:fs");const p=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore",windowsHide:true});fs.writeFileSync(process.argv[1],JSON.stringify({parent:process.pid,child:p.pid}));if(process.argv[2]==="output")process.stdout.write("123456789");setInterval(()=>{},1000)'
  const trees: { parent: number; child: number }[] = []
  try {
    for (const mode of ['timeout', 'output']) {
      const pidFile = join(directory, `${mode}.json`), started = Date.now()
      await expect(runCommand([process.execPath, '-e', source, pidFile, mode], { timeoutMs: mode === 'timeout' ? 150 : 5000, maxOutput: 4 }))
        .rejects.toThrow(mode === 'timeout' ? 'timed out' : 'output exceeded')
      const tree = JSON.parse(await readFile(pidFile, 'utf8')) as { parent: number; child: number }
      trees.push(tree)
      expect(Date.now() - started).toBeLessThan(2000)
      const deadline = Date.now() + 1500
      while (Date.now() < deadline) {
        try { process.kill(tree.child, 0); await new Promise(resolvePromise => setTimeout(resolvePromise, 50)) }
        catch { break }
      }
      expect(() => process.kill(tree.child, 0)).toThrow()
    }
  } finally {
    for (const tree of trees) {
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/PID', String(tree.parent), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
        await Promise.race([once(killer, 'close'), new Promise(resolvePromise => setTimeout(resolvePromise, 1000))])
        try { process.kill(tree.child) } catch {}
      } else {
        try { process.kill(-tree.parent, 'SIGKILL') } catch {}
        try { process.kill(tree.child, 'SIGKILL') } catch {}
      }
    }
    await rm(directory, { recursive: true, force: true })
  }
})

it('runs the assessor command as a separate process with the bounded snapshot on stdin', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-watchdog-assessor-'))
  const server = await listen((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ schema: 1,
    observedAt: '2026-10-31T00:00:00Z', infrastructure: { configured: true, paused: false, health: {}, setup: [] },
    executor: { activeWorkers: 1, maxWorkers: 2 }, tickets: [{ id: 'w1', status: 'working', trace: [{ state: 'progress', summary: 'changed files' }] }], candidates: [] })) })
  try {
    const assessor = 'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>{const x=JSON.parse(s);console.log(JSON.stringify({status:"diverged",findings:[{ticketId:"w1",status:"diverged",evidence:[x.snapshot.tickets[0].trace[0].summary,process.env.WDOG_SECRET||"filtered"],recommendation:"Review scope"}]}))})'
    const result = await child([process.execPath, SCRIPT, '--once', '--url', `http://${hostName}:${(server.address() as { port: number }).port}`,
      '--state-file', join(directory, 'state.json'), '--assessor-command', JSON.stringify([process.execPath, '-e', assessor])], { WDOG_SECRET: 'must-not-reach-assessor' })
    expect(result.code).toBe(3)
    expect(result.stdout).toContain('changed files')
    expect(result.stdout).toContain('diverged')
    expect(result.stdout).toContain('filtered')
    expect(result.stdout).not.toContain('must-not-reach-assessor')
  } finally { await close(server); await rm(directory, { recursive: true, force: true }) }
})

it('cancels an in-flight loopback request when the external process receives SIGTERM', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-watchdog-signal-'))
  const requested = deferred()
  const server = await listen((_req, _res) => { requested.resolve() })
  const process = spawn(globalThis.process.execPath, [SCRIPT, '--url', `http://${hostName}:${(server.address() as { port: number }).port}`,
    '--interval-ms', '1000', '--timeout-ms', '10000', '--state-file', join(directory, 'state.json')], { windowsHide: true })
  const stdout: Buffer[] = []; process.stdout.on('data', chunk => stdout.push(chunk))
  try {
    await requested.promise
    const started = Date.now()
    process.kill('SIGTERM')
    const [code, signal] = await once(process, 'close') as [number | null, NodeJS.Signals | null]
    expect(code === 0 || signal === 'SIGTERM').toBe(true)
    expect(Date.now() - started).toBeLessThan(1500)
    expect(Buffer.concat(stdout).toString()).toBe('')
  } finally { if (process.exitCode === null) process.kill(); await close(server); await rm(directory, { recursive: true, force: true }) }
})

it('runs as an independent process, times out a stalled endpoint, suppresses repeats, respects manual stop and bounds recovery attempts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-watchdog-process-'))
  const callsFile = join(directory, 'manager-calls.txt'), stateFile = join(directory, 'state.json'), stopMarker = join(directory, 'manually-stopped')
  const server = await listen((_req, _res) => {})
  const url = `http://${hostName}:${(server.address() as { port: number }).port}`
  const command = [process.execPath, '-e', 'require("node:fs").appendFileSync(process.env.WDOG_CALLS, "call\\n")']
  const run = (extra: string[] = []) => child([process.execPath, SCRIPT, '--once', '--timeout-ms', '150', '--url', url, '--state-file', stateFile,
    '--manager-command', JSON.stringify(command), '--recover', '--stop-marker', stopMarker, '--recovery-base-delay-ms', '1',
    '--recovery-max-delay-ms', '1', '--max-recoveries', '2', ...extra], { WDOG_CALLS: callsFile })
  try {
    const first = await run()
    expect(first.code).toBe(3)
    expect(first.stdout).toContain('recovery_started')
    expect((await readFile(callsFile, 'utf8')).trim().split(/\r?\n/)).toHaveLength(1)
    const second = await run()
    expect(second.stdout).toContain('recovery_started')
    const exhausted = await run()
    expect(exhausted.stdout).toContain('maximum-attempts')
    const repeat = await run()
    expect(repeat.stdout).toBe('')
    expect((await readFile(callsFile, 'utf8')).trim().split(/\r?\n/)).toHaveLength(2)
    await writeFile(stopMarker, 'operator stopped')
    const stopped = await run(['--state-file', join(directory, 'manual-state.json')])
    expect(stopped.stdout).toContain('manual-stop')
    expect((await readFile(callsFile, 'utf8')).trim().split(/\r?\n/)).toHaveLength(2)
  } finally { await close(server); await rm(directory, { recursive: true, force: true }) }
})

function listen(handler: (req: unknown, res: import('node:http').ServerResponse) => void): Promise<Server> {
  const server = createServer(handler)
  server.listen(0, hostName)
  return once(server, 'listening').then(() => server)
}
function deferred() {
  let resolvePromise!: () => void
  const promise = new Promise<void>(resolve => { resolvePromise = resolve })
  return { promise, resolve: resolvePromise }
}
function close(server: Server): Promise<void> { return new Promise((resolvePromise, reject) => server.close(error => error ? reject(error) : resolvePromise())) }
function child(command: string[], env: Record<string, string>) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolvePromise, reject) => {
    const process = spawn(command[0]!, command.slice(1), { env: { ...globalThis.process.env, ...env }, windowsHide: true })
    const stdout: Buffer[] = [], stderr: Buffer[] = []
    process.stdout.on('data', chunk => stdout.push(chunk)); process.stderr.on('data', chunk => stderr.push(chunk))
    process.once('error', reject); process.once('close', code => resolvePromise({ code, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() }))
  })
}
