import { afterEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { Store } from '../src/app/store.ts'
import { RemoteEnvironments, parseRemoteArtifactReference, remoteArtifactReference, type RemoteEnvironmentsHost, type RemoteIntent } from '../src/remote/client.ts'
import { record } from '../src/kv.ts'
import { startEnvironmentDaemon, type RunningEnvironmentDaemon } from '../src/remote/daemon.ts'
import { EnvironmentStore } from '../src/remote/store.ts'
import { EnvironmentFiles } from '../src/remote/files.ts'
import { environmentUrl, sha256 } from '../src/remote/protocol.ts'

const TOKEN = 'test-environment-credential-0123456789abcdef'
const cleanups: (() => Promise<unknown> | unknown)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const command = (script: string) => `node -e "eval(Buffer.from('${Buffer.from(script).toString('base64')}','base64').toString())"`
async function directory() { const path = await mkdtemp(join(tmpdir(), 'remote-environment-')); cleanups.push(() => rm(path, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })); return path }
async function fixture(options: { fetchImpl?: typeof fetch; port?: number } = {}) {
  const path = await directory(), root = join(path, 'work'), stateDir = join(path, 'daemon')
  const daemon = await startEnvironmentDaemon({ root, stateDir, token: TOKEN, port: options.port }); cleanups.push(() => daemon.close())
  const store = new Store(join(path, 'host.sqlite')); cleanups.push(() => store.close())
  const transitions: unknown[] = []
  const host: RemoteEnvironmentsHost = { store, credential: () => TOKEN, timeoutMs: 5000, fetchImpl: options.fetchImpl, onState: value => { transitions.push(value) } }
  const remote = new RemoteEnvironments(host); cleanups.push(() => remote.close())
  remote.register({ id: 'personal', label: 'Personal computer', url: daemon.url, credentialRef: 'host-only-ref' }); remote.bind('task', 'personal')
  return { path, root, stateDir, daemon, store, host, remote, transitions }
}
async function completed(remote: RemoteEnvironments, id: string, timeout = 10_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const result = await remote.status('task', id)
    if (!['running', 'accepted', 'queued', 'waiting_environment'].includes(result.state)) return result
    await new Promise(resolveDone => setTimeout(resolveDone, 50))
  }
  throw new Error('Remote test command did not finish')
}

it('executes on the bound device, recovers the same command after a lost start response and exposes no transport credential', async () => {
  let lose = true, starts = 0
  const f = await fixture({ fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
    const response = await fetch(url, init)
    if (String(url).endsWith('/commands/start')) { starts++; if (lose) { lose = false; await response.text(); throw new TypeError('response was lost after execution started') } }
    return response
  }) as typeof fetch })
  const request = { requestId: 'write-once', command: command('require("node:fs").appendFileSync("count.txt","once\\n");console.log("done")') }
  const first = await f.remote.start('personal', 'task', request)
  expect(first.state).toBe('waiting_environment')
  const reopened = new Store(join(f.path, 'host.sqlite')); cleanups.push(() => reopened.close())
  const restartedHost = new RemoteEnvironments({ ...f.host, store: reopened }); cleanups.push(() => restartedHost.close())
  const result = await completed(restartedHost, first.commandId)
  expect(result.state).toBe('completed')
  expect(result.remote?.stdout).toContain('done')
  const count = await restartedHost.readFile('task', 'personal', 'count.txt')
  expect(Buffer.from(count.base64, 'base64').toString()).toBe('once\n')
  expect((await restartedHost.start('personal', 'task', request)).state).toBe('completed')
  expect(starts).toBe(1)
  const conflict = await fetch(`${f.daemon.url}/v1/commands/start`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ticketId: 'task', commandId: first.commandId, command: 'different operation' }) })
  expect(conflict.status).toBe(409)
  expect(JSON.stringify([result, restartedHost.list()])).not.toContain(TOKEN)
  expect(restartedHost.list()[0]).not.toHaveProperty('credentialRef')
  expect(f.transitions).toContainEqual(expect.objectContaining({ commandId: first.commandId, commandState: 'completed' }))
  await expect(restartedHost.start('personal', 'task', { ...request, command: 'different command' })).rejects.toThrow('same command')
  await expect(restartedHost.start('personal', 'other-task', request)).rejects.toThrow('bound')
})

it('keeps one original-request operation across an owner transfer, host restart and changed payload attempts', async () => {
  let starts = 0, owner = 'task', claimed = true
  const source = 'source-request-transfer'
  const f = await fixture({ fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith('/commands/start')) starts++
    return fetch(url, init)
  }) as typeof fetch })
  f.host.requestScope = (ticketId, selected) => ticketId === owner && claimed && (!selected || selected === source) ? source : undefined
  f.host.mayAccessRequestCommand = (ticketId, requestTriggerId, originalTicketId) => ticketId === owner && requestTriggerId === source && originalTicketId === 'task'
  f.remote.bind('successor', 'personal'); f.remote.bind('unrelated', 'personal')
  const request = { requestId: 'append-once', command: command('require("node:fs").appendFileSync("transferred-count.txt","once\\n");console.log("saved")'), timeoutMs: 5000 }
  const started = await f.remote.start('personal', 'task', request), done = await completed(f.remote, started.commandId)
  expect(done).toMatchObject({ state: 'completed', requestTriggerId: source, ticketId: 'task' })
  const original = structuredClone(f.store.get<RemoteIntent>(`remote-command:${started.commandId}`)!)
  owner = 'successor'; claimed = false
  // Proposed successors can inspect preserved facts; executable operations require the separate claim resolver.
  expect(await f.remote.status('successor', started.commandId)).toMatchObject({ commandId: started.commandId, state: 'completed', ticketId: 'task' })
  await expect(f.remote.start('personal', 'successor', request)).rejects.toThrow('claim proposed')
  claimed = true
  const reopened = new Store(join(f.path, 'host.sqlite')); cleanups.push(() => reopened.close())
  const restarted = new RemoteEnvironments({ ...f.host, store: reopened }); cleanups.push(() => restarted.close())
  expect(await restarted.start('personal', 'successor', { ...request, requestTriggerId: source })).toMatchObject({
    commandId: started.commandId, state: 'completed', ticketId: 'task', requestTriggerId: source,
  })
  expect(restarted.commandResult('successor', started.commandId)?.commandId).toBe(started.commandId)
  expect(restarted.commands('successor')).toEqual([expect.objectContaining({ commandId: started.commandId, ticketId: 'task', requestTriggerId: source })])
  const environment = restarted.tools('successor').find(item => item.name === 'orchestrator_environment')!
  expect(await environment.execute(environment.schema.parse({}), new AbortController().signal)).toMatchObject({ commands: [{
    commandId: started.commandId, requestId: request.requestId, requestTriggerId: source, originalTicketId: 'task', state: 'completed',
  }] })
  expect(restarted.commands('task')).toEqual([])
  expect(restarted.commandResult('task', started.commandId)).toBeUndefined()
  await expect(restarted.status('unrelated', started.commandId)).rejects.toThrow('current original-request ownership')
  await expect(restarted.status('task', started.commandId)).rejects.toThrow('current original-request ownership')
  await expect(restarted.start('personal', 'task', request)).rejects.toThrow('claimed original')
  for (const changed of [{ command: 'different operation' }, { cwd: 'different-directory' }, { timeoutMs: 6000 }]) {
    await expect(restarted.start('personal', 'successor', { ...request, ...changed })).rejects.toThrow('same command, directory and timeout')
  }
  expect(starts).toBe(1)
  expect(reopened.get<RemoteIntent>(`remote-command:${started.commandId}`)).toStrictEqual(original)
  const endpoint = new EnvironmentStore(join(f.stateDir, 'environment.sqlite'))
  expect(endpoint.all()).toHaveLength(1)
  expect(endpoint.get(started.commandId)).toMatchObject({ ticketId: 'task', payloadHash: original.payloadHash })
  endpoint.close()
  const file = new EnvironmentFiles(f.root).read('task', 'transferred-count.txt')
  expect(Buffer.from(file.base64, 'base64').toString()).toBe('once\n')
}, 20000)

it('requires an explicit source request for multiple claimed requests and refuses a device change for an existing operation', async () => {
  const f = await fixture(), sources = ['first-source-request', 'second-source-request']
  f.host.requestScope = (ticketId, selected) => ticketId === 'task' && selected && sources.includes(selected) ? selected : undefined
  f.host.mayAccessRequestCommand = (ticketId, source, original) => ticketId === 'task' && sources.includes(source) && original === 'task'
  const request = { requestId: 'scoped-operation', command: command('console.log("selected")') }
  await expect(f.remote.start('personal', 'task', request)).rejects.toThrow('source_request_id')
  const tool = f.remote.tools('task').find(item => item.name === 'orchestrator_environment_start')!
  const result = await tool.execute(tool.schema.parse({ request_id: request.requestId, source_request_id: sources[0], command: request.command }), new AbortController().signal) as { commandId: string }
  expect((await completed(f.remote, result.commandId)).state).toBe('completed')
  f.remote.register({ id: 'another', label: 'Another reviewed device', url: f.daemon.url, credentialRef: 'host-only-ref' })
  f.remote.bind('task', 'another')
  await expect(f.remote.start('another', 'task', { ...request, requestTriggerId: sources[0] })).rejects.toThrow('another device')
  // Inspection retains the real device and payload rather than silently minting another side-effect identity.
  expect(await f.remote.status('task', result.commandId)).toMatchObject({ deviceId: 'personal', commandId: result.commandId, state: 'completed' })
  expect(f.remote.commands('task')).toHaveLength(1)
})

it('preserves legacy operation identity during an upgrade to original-request scoping instead of dispatching it twice', async () => {
  let starts = 0
  const f = await fixture({ fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith('/commands/start')) starts++
    return fetch(url, init)
  }) as typeof fetch })
  const request = { requestId: 'pre-upgrade-operation', command: command('require("node:fs").appendFileSync("legacy-count.txt","once\\n")') }
  const legacy = await f.remote.start('personal', 'task', request)
  await completed(f.remote, legacy.commandId)
  const source = 'upgraded-source-request'
  f.host.requestScope = (ticketId, selected) => ['task', 'successor'].includes(ticketId) && (!selected || selected === source) ? source : undefined
  f.host.mayAccessRequestCommand = (ticketId, selected, original) => ['task', 'successor'].includes(ticketId) && selected === source && original === 'task'
  f.remote.bind('successor', 'personal')
  await expect(f.remote.start('personal', 'task', request)).rejects.toThrow(legacy.commandId)
  await expect(f.remote.start('personal', 'successor', request)).rejects.toThrow('needs inspection')
  expect(await f.remote.status('task', legacy.commandId)).toMatchObject({ state: 'completed', commandId: legacy.commandId })
  expect(f.store.get<RemoteIntent>(`remote-command:${legacy.commandId}`)?.requestTriggerId).toBeUndefined()
  expect(starts).toBe(1)
  expect(Buffer.from(new EnvironmentFiles(f.root).read('task', 'legacy-count.txt').base64, 'base64').toString()).toBe('once\n')
})

it('preserves a transferred running operation when its former ticket ends and cancels it when the canonical owner stops', async () => {
  const f = await fixture(), source = 'running-transferred-request'
  let owner = 'task'
  f.host.requestScope = (ticketId, selected) => ticketId === owner && (!selected || selected === source) ? source : undefined
  f.host.mayAccessRequestCommand = (ticketId, selected) => ticketId === owner && selected === source
  f.remote.bind('successor', 'personal')
  const started = await f.remote.start('personal', 'task', { requestId: 'running-transfer', command: command('console.log("running");setTimeout(()=>{},30000)') })
  expect(started.state).toBe('running')
  owner = 'successor'
  await f.remote.cancelTicket('task', [])
  expect(await f.remote.status('successor', started.commandId)).toMatchObject({ state: 'running' })
  expect(f.store.get<RemoteIntent>(`remote-command:${started.commandId}`)?.cancelRequested).toBeUndefined()
  // The human-stop transaction has already made ownership terminal when the host lifecycle callback runs.
  owner = 'terminal-owner'
  expect(f.remote.commandResult('successor', started.commandId)).toBeUndefined()
  await f.remote.cancelTicket('successor', [source])
  expect(f.store.get<RemoteIntent>(`remote-command:${started.commandId}`)).toMatchObject({ ticketId: 'task', requestTriggerId: source,
    state: 'cancelled', cancelRequested: true })
  const backend = new EnvironmentStore(join(f.stateDir, 'environment.sqlite'))
  expect(backend.get(started.commandId)?.state).toBe('cancelled'); backend.close()
})

it('rechecks original-request claim immediately before dispatch when ownership changes during credential resolution', async () => {
  const f = await fixture(), source = 'ownership-race-request'
  let owner = 'task', credentials = 0, starts = 0
  f.host.requestScope = (ticketId, selected) => ticketId === owner && (!selected || selected === source) ? source : undefined
  f.host.mayAccessRequestCommand = (ticketId, selected) => ticketId === owner && selected === source
  f.host.credential = () => { if (++credentials === 3) owner = 'successor'; return TOKEN }
  f.host.fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => { if (String(url).endsWith('/commands/start')) starts++; return fetch(url, init) }) as typeof fetch
  const request = { requestId: 'raced-command', command: command('require("node:fs").writeFileSync("must-not-run.txt","x")') }
  expect(await f.remote.start('personal', 'task', request)).toMatchObject({ state: 'waiting_environment', error: expect.stringContaining('claimed original') })
  expect(starts).toBe(0)
  const backend = new EnvironmentStore(join(f.stateDir, 'environment.sqlite'))
  expect(backend.all()).toHaveLength(0); backend.close()
})

it('queues while offline, retains cancellation across host restart, and cancels before a deferred start', async () => {
  const f = await fixture(), port = Number(new URL(f.daemon.url).port)
  await f.daemon.close()
  const request = { requestId: 'offline-write', command: command('require("node:fs").writeFileSync("must-not-exist.txt","x")') }
  const queued = await f.remote.start('personal', 'task', request)
  expect(queued.state).toBe('waiting_environment')
  const cancelled = await f.remote.cancel('task', queued.commandId)
  expect(cancelled).toMatchObject({ state: 'waiting_environment', cancelRequested: true })
  const daemon = await startEnvironmentDaemon({ root: f.root, stateDir: f.stateDir, token: TOKEN, port }); cleanups.push(() => daemon.close())
  const restarted = new RemoteEnvironments(f.host); cleanups.push(() => restarted.close())
  expect(await restarted.status('task', queued.commandId)).toMatchObject({ state: 'cancelled', cancelRequested: true })
  const backend = new EnvironmentStore(join(f.stateDir, 'environment.sqlite'))
  expect(backend.get(queued.commandId)).toBeUndefined(); backend.close()
  await expect(restarted.readFile('task', 'personal', 'must-not-exist.txt')).rejects.toThrow()
})

it('resumes an unsent offline intent on reconnect and supports durable asynchronous cancellation', async () => {
  const f = await fixture(), port = Number(new URL(f.daemon.url).port)
  await f.daemon.close()
  const queued = await f.remote.start('personal', 'task', { requestId: 'resume', command: command('console.log("reconnected")') })
  const daemon = await startEnvironmentDaemon({ root: f.root, stateDir: f.stateDir, token: TOKEN, port }); cleanups.push(() => daemon.close())
  const result = await completed(f.remote, queued.commandId)
  expect(result).toMatchObject({ state: 'completed', remote: { stdout: 'reconnected\n' } })
  const long = await f.remote.start('personal', 'task', { requestId: 'cancel-running', command: command('setTimeout(()=>{},30000)') })
  expect(long.state).toBe('running')
  const cancellation = await f.remote.cancel('task', long.commandId)
  expect(cancellation.state, JSON.stringify(cancellation)).toBe('cancelled')
  expect((await f.remote.status('task', long.commandId)).state).toBe('cancelled')
})

it('transfers actual binary bytes and verifies hashes, explicit overwrite, path roots and symlink escape', async () => {
  const f = await fixture(), bytes = Buffer.from([0, 1, 2, 250, 255, 0, 13, 10])
  expect(await f.remote.writeFile('task', 'personal', 'out/result.bin', bytes)).toMatchObject({ sha256: sha256(bytes), bytes: bytes.length })
  expect(await f.remote.writeFile('task', 'personal', 'out/result.bin', bytes)).toMatchObject({ reused: true })
  await expect(f.remote.writeFile('task', 'personal', 'out/result.bin', Buffer.from('changed'))).rejects.toThrow('overwrite')
  const destination = join(f.path, 'download', 'result.bin')
  expect(await f.remote.downloadArtifact('task', 'personal', 'out/result.bin', destination)).toMatchObject({ path: destination, sha256: sha256(bytes) })
  expect(await readFile(destination)).toEqual(bytes)
  expect(parseRemoteArtifactReference(remoteArtifactReference('personal', 'out/中文 文件.bin'))).toEqual({ deviceId: 'personal', path: 'out/中文 文件.bin' })
  for (const path of ['../secret', '/etc/passwd', 'C:\\Windows\\win.ini', 'out/../../secret', 'out/x:secret']) {
    await expect(f.remote.writeFile('task', 'personal', path, bytes)).rejects.toThrow('workspace')
  }
  const files = new EnvironmentFiles(f.root), outside = join(f.path, 'outside'); await mkdir(outside)
  await writeFile(join(outside, 'private.txt'), 'outside')
  symlinkSync(outside, join(files.workspace('task'), 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  await expect(f.remote.readFile('task', 'personal', 'escape/private.txt')).rejects.toThrow('Symbolic')
  const badHash = await fetch(`${f.daemon.url}/v1/files`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ticketId: 'task', path: 'out/bad.bin', base64: bytes.toString('base64'), sha256: '0'.repeat(64) }) })
  expect(badHash.status).toBe(400)
})

it('recovers a lost file-write receipt by content digest without duplicate names or explicit overwrite', async () => {
  let lose = true, writes = 0
  const f = await fixture({ fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
    const response = await fetch(url, init)
    if (String(url).endsWith('/v1/files') && init?.method === 'POST') {
      writes++
      if (lose) { lose = false; await response.text(); throw new TypeError('file receipt lost after the atomic rename') }
    }
    return response
  }) as typeof fetch })
  const bytes = Buffer.from('Complete result bytes\n')
  await expect(f.remote.writeFile('task', 'personal', 'results/report.txt', bytes)).rejects.toThrow('receipt lost')
  const restarted = new RemoteEnvironments(f.host); cleanups.push(() => restarted.close())
  expect(await restarted.writeFile('task', 'personal', 'results/report.txt', bytes)).toMatchObject({ sha256: sha256(bytes), reused: true })
  await expect(restarted.writeFile('task', 'personal', 'results/report.txt', Buffer.from('different bytes'))).rejects.toThrow('overwrite')
  expect(writes).toBe(3)
  const workspace = await restarted.workspace('task')
  expect(await readdir(join(workspace.directory, 'results'))).toEqual(['report.txt'])
  expect(Buffer.from((await restarted.readFile('task', 'personal', 'results/report.txt')).base64, 'base64')).toEqual(bytes)
})

it('rechecks unknown-operation protection immediately before dispatching file bytes', async () => {
  const f = await fixture(), started = await f.remote.start('personal', 'task', { requestId: 'prior-operation', command: command('console.log("observed")') })
  await completed(f.remote, started.commandId)
  const key = record<RemoteIntent>(`remote-command:${started.commandId}`), original = f.store.get(key)!
  let credentials = 0
  f.host.credential = () => {
    if (++credentials === 2) f.store.set(key, { ...original, state: 'unknown', ownerResolution: undefined })
    return TOKEN
  }
  await expect(f.remote.writeFile('task', 'personal', 'must-not-dispatch.txt', Buffer.from('x'))).rejects.toThrow('owner-resolve')
  f.host.credential = () => TOKEN
  await expect(f.remote.readFile('task', 'personal', 'must-not-dispatch.txt')).rejects.toThrow()
  expect((await f.remote.status('task', started.commandId)).state).toBe('completed')
})

it('authenticates every route, checks protocol transport and keeps daemon tokens outside execution environment', async () => {
  const f = await fixture()
  expect((await fetch(`${f.daemon.url}/v1/health`)).status).toBe(401)
  expect(() => environmentUrl('http://192.168.1.2:8080')).toThrow('HTTPS')
  expect(environmentUrl('http://192.168.1.2:8080', true)).toBe('http://192.168.1.2:8080')
  expect(() => environmentUrl('https://user:secret@example.com')).toThrow()
  const result = await f.remote.start('personal', 'task', { requestId: 'redact', command: command(`console.log(${JSON.stringify(TOKEN)})`) })
  const done = await completed(f.remote, result.commandId)
  expect(done.remote?.stdout).toContain('[redacted]')
  expect(JSON.stringify(done)).not.toContain(TOKEN)
})

it('refuses a changed daemon identity, preserves its unknown operation and permits owner-confirmed rebinding', async () => {
  const f = await fixture(), port = Number(new URL(f.daemon.url).port)
  await f.remote.probe('personal'); await f.daemon.close()
  const replacement = await startEnvironmentDaemon({ root: f.root, stateDir: join(f.path, 'replacement'), token: TOKEN, port }); cleanups.push(() => replacement.close())
  const request = await f.remote.start('personal', 'task', { requestId: 'identity-change', command: command('console.log("must not dispatch")') })
  expect(request.state).toBe('unknown')
  expect(f.remote.list()[0]?.status).toBe('identity_changed')
  const backend = new EnvironmentStore(join(f.path, 'replacement', 'environment.sqlite')); expect(backend.all()).toHaveLength(0); backend.close()
  f.remote.register({ id: 'replacement', label: 'Reviewed replacement', url: replacement.url, credentialRef: 'ref' })
  expect(() => f.remote.bind('task', 'replacement')).toThrow('unknown')
  f.remote.resolveUnknown('task', request.commandId, { outcome: 'failed', evidence: 'Replacement daemon has no command record; original device was retired', expectedUpdatedAt: request.updatedAt })
  expect(f.remote.hasUnsettled('task')).toBe(false)
  f.remote.bind('task', 'replacement'); expect(f.remote.binding('task')).toBe('replacement')
})

it('provides task-bound file tools, redacts credential bytes from model text and detects corrupted download receipts', async () => {
  const f = await fixture(), tools = f.remote.tools('task'), signal = new AbortController().signal
  const write = tools.find(tool => tool.name === 'orchestrator_environment_write')!
  await write.execute(write.schema.parse({ path: 'example.txt', text: `${TOKEN}\nActual task content` }), signal)
  const read = tools.find(tool => tool.name === 'orchestrator_environment_read')!
  const result = await read.execute(read.schema.parse({ path: 'example.txt' }), signal)
  expect(JSON.stringify(result)).toContain('Actual task content')
  expect(JSON.stringify(result)).not.toContain(TOKEN)
  const other = f.remote.tools('other-task')[0]!
  expect(await other.execute(other.schema.parse({}), signal)).toMatchObject({ state: 'failed', error: 'task_binding' })
  const realFetch = fetch
  f.host.fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const response = await realFetch(url, init)
    if (String(url).includes('/v1/files?')) { const value = await response.json(); return new Response(JSON.stringify({ ...value, base64: Buffer.from('corrupted').toString('base64') }), { status: 200 }) }
    return response
  }) as typeof fetch
  await expect(f.remote.readFile('task', 'personal', 'example.txt')).rejects.toThrow('digest')
})

it('checks compatible runtime/state metadata and creates a consistent independent-process SQLite backup', async () => {
  const f = await fixture(), result = await f.remote.start('personal', 'task', { requestId: 'backup-result', command: command('console.log("persisted")') })
  await completed(f.remote, result.commandId)
  const tokenFile = join(f.path, 'token.txt'), backup = join(f.path, 'backup', 'environment.sqlite'); await writeFile(tokenFile, TOKEN)
  const child = spawn(process.execPath, [resolve('scripts/superagent-environment.mjs'), '--root', f.root, '--state', f.stateDir,
    '--token-file', tokenFile, '--check', '--backup', backup], { windowsHide: true })
  let output = ''; child.stdout.on('data', chunk => { output += String(chunk) })
  const [code] = await once(child, 'close')
  expect(code).toBe(0)
  expect(JSON.parse(output)).toMatchObject({ protocol: 1, schema: 1, daemonId: f.daemon.daemonId, database: 'ok', backup })
  const restored = new EnvironmentStore(backup); expect(restored.get(result.commandId)?.state).toBe('completed'); restored.close()
  const source = new EnvironmentStore(join(f.stateDir, 'environment.sqlite')); source.db.prepare('UPDATE meta SET value=? WHERE key=?').run('999', 'schema'); source.close()
  expect(() => new EnvironmentStore(join(f.stateDir, 'environment.sqlite'))).toThrow('incompatible')
}, 15_000)

async function launch(path: string, port = 0) {
  const tokenFile = join(path, 'token.txt'); await writeFile(tokenFile, TOKEN, { mode: 0o600 })
  const child = spawn(process.execPath, [resolve('scripts/superagent-environment.mjs'), '--root', join(path, 'work'), '--state', join(path, 'daemon'),
    '--token-file', tokenFile, '--port', String(port)], { windowsHide: true })
  let text = '', errors = ''
  child.stderr.on('data', chunk => { errors += String(chunk) })
  const info = await new Promise<{ url: string; daemonId: string }>((resolveDone, reject) => {
    const timer = setTimeout(() => reject(new Error(`Environment CLI did not start: ${errors}`)), 8000)
    child.once('error', error => { clearTimeout(timer); reject(error) }); child.once('exit', code => { if (!text.includes('\n')) { clearTimeout(timer); reject(new Error(`Environment CLI exited ${code}: ${errors}`)) } })
    child.stdout.on('data', chunk => { text += String(chunk); if (text.includes('\n')) { clearTimeout(timer); resolveDone(JSON.parse(text.split('\n')[0]!)) } })
  })
  return { child, ...info }
}
async function stop(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM') {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill(signal); await once(child, 'close')
}

it('inherits an unknown original-request result after a daemon crash and blocks new successor effects until owner resolution', async () => {
  const path = await directory(), first = await launch(path), source = 'crashed-original-request'
  cleanups.push(() => stop(first.child, 'SIGKILL'))
  const store = new Store(join(path, 'host.sqlite')); cleanups.push(() => store.close())
  let owner = 'original', starts = 0
  const host: RemoteEnvironmentsHost = { store, credential: () => TOKEN, timeoutMs: 3000,
    requestScope: (ticketId, selected) => ticketId === owner && (!selected || selected === source) ? source : undefined,
    mayAccessRequestCommand: (ticketId, requestTriggerId, original) => ticketId === owner && requestTriggerId === source && ['original', 'successor'].includes(original),
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/commands/start')) starts++
      return fetch(url, init)
    }) as typeof fetch }
  const remote = new RemoteEnvironments(host); cleanups.push(() => remote.close())
  remote.register({ id: 'personal', label: 'Device', url: first.url, credentialRef: 'ref' })
  remote.bind('original', 'personal'); remote.bind('successor', 'personal')
  const request = { requestId: 'crash-write-once', command: command('require("node:fs").appendFileSync("request-count.txt","once\\n");setTimeout(()=>{},4000)') }
  const started = await remote.start('personal', 'original', request)
  const originalFiles = new EnvironmentFiles(join(path, 'work')), deadline = Date.now() + 8000
  let observed = ''
  while (Date.now() < deadline) {
    try { observed = Buffer.from(originalFiles.read('original', 'request-count.txt').base64, 'base64').toString(); if (observed) break } catch {}
    await new Promise(resolveDone => setTimeout(resolveDone, 40))
  }
  expect(observed).toBe('once\n')
  await stop(first.child, 'SIGKILL')
  const revived = await launch(path, Number(new URL(first.url).port)); cleanups.push(() => stop(revived.child))
  owner = 'successor'
  const reopened = new Store(join(path, 'host.sqlite')); cleanups.push(() => reopened.close())
  const successor = new RemoteEnvironments({ ...host, store: reopened }); cleanups.push(() => successor.close())
  let preserved = await successor.status('successor', started.commandId)
  const reconnectDeadline = Date.now() + 10000
  while (preserved.state === 'waiting_environment' && Date.now() < reconnectDeadline) {
    await new Promise(resolveDone => setTimeout(resolveDone, 40)); preserved = await successor.status('successor', started.commandId)
  }
  expect(preserved).toMatchObject({ state: 'unknown', commandId: started.commandId, ticketId: 'original', requestTriggerId: source })
  expect(await successor.start('personal', 'successor', request)).toMatchObject({ state: 'unknown', commandId: started.commandId })
  expect(successor.commands('successor')).toEqual([expect.objectContaining({ effectiveState: 'unknown', commandId: started.commandId })])
  expect(successor.hasUnsettled('successor')).toBe(true)
  await expect(successor.start('personal', 'successor', { requestId: 'new-operation', command: command('console.log("should wait")') })).rejects.toThrow('owner-resolve')
  await expect(successor.writeFile('successor', 'personal', 'must-wait.txt', Buffer.from('new effect'))).rejects.toThrow('owner-resolve')
  expect(starts).toBe(1)
  const observedNow = Buffer.from(originalFiles.read('original', 'request-count.txt').base64, 'base64').toString()
  expect(observedNow).toBe('once\n')
  successor.resolveUnknown('successor', started.commandId, { outcome: 'completed', evidence: 'Original request-count.txt contains exactly one saved write.', expectedUpdatedAt: preserved.updatedAt })
  expect(successor.commandResult('successor', started.commandId)).toMatchObject({ state: 'completed', remote: { state: 'unknown' } })
  expect(reopened.get<RemoteIntent>(`remote-command:${started.commandId}`)).toMatchObject({ ticketId: 'original', state: 'unknown', requestTriggerId: source })
  const next = await successor.start('personal', 'successor', { requestId: 'after-inspection', command: command('console.log("continued")') })
  let done = await successor.status('successor', next.commandId)
  const finishDeadline = Date.now() + 10000
  while (['accepted', 'running'].includes(done.state) && Date.now() < finishDeadline) {
    await new Promise(resolveDone => setTimeout(resolveDone, 40)); done = await successor.status('successor', next.commandId)
  }
  expect(done.state).toBe('completed')
  expect(starts).toBe(2)
  expect(Buffer.from(originalFiles.read('original', 'request-count.txt').base64, 'base64').toString()).toBe('once\n')
}, 30000)

it('starts a real daemon process and preserves unknown operations across a crash without replaying side effects', async () => {
  const path = await directory(), first = await launch(path)
  cleanups.push(() => stop(first.child, 'SIGKILL'))
  const store = new Store(join(path, 'host.sqlite')); cleanups.push(() => store.close())
  let loseReconnectProbe = false
  const startIds: string[] = []
  const remote = new RemoteEnvironments({ store, credential: () => TOKEN, timeoutMs: 2000,
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      if (loseReconnectProbe && String(url).endsWith('/v1/health')) {
        loseReconnectProbe = false; throw new TypeError('connection to the crashed daemon was lost')
      }
      if (String(url).endsWith('/commands/start')) startIds.push(JSON.parse(String(init?.body)).commandId)
      return fetch(url, init)
    }) as typeof fetch }); cleanups.push(() => remote.close())
  remote.register({ id: 'personal', label: 'Device', url: first.url, credentialRef: 'ref' }); remote.bind('task', 'personal')
  const request = { requestId: 'crash', command: command('require("node:fs").appendFileSync("count.txt","once\\n");setTimeout(()=>{},4000)') }
  const started = await remote.start('personal', 'task', request)
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) { try { if ((await remote.readFile('task', 'personal', 'count.txt')).bytes) break } catch {} await new Promise(resolveDone => setTimeout(resolveDone, 50)) }
  await stop(first.child, 'SIGKILL')
  const second = await launch(path, Number(new URL(first.url).port)); cleanups.push(() => stop(second.child))
  expect(second.daemonId).toBe(first.daemonId)
  // A new listener can be ready while the host still loses a pooled connection to the crashed process.
  loseReconnectProbe = true
  expect(await remote.status('task', started.commandId)).toMatchObject({ state: 'waiting_environment', commandId: started.commandId })
  expect(await completed(remote, started.commandId)).toMatchObject({ state: 'unknown', commandId: started.commandId })
  expect(await remote.start('personal', 'task', request)).toMatchObject({ state: 'unknown' })
  await expect(remote.start('personal', 'task', { ...request, requestId: 'fresh-id-cannot-bypass' })).rejects.toThrow('owner-resolve')
  await expect(remote.writeFile('task', 'personal', 'must-not-dispatch.txt', Buffer.from('new work'))).rejects.toThrow('owner-resolve')
  const lookupWhileHeld = new RemoteEnvironments({ store, credential: () => TOKEN, mayExecute: () => false }); cleanups.push(() => lookupWhileHeld.close())
  expect((await lookupWhileHeld.start('personal', 'task', request)).state).toBe('unknown')
  expect((await lookupWhileHeld.status('task', started.commandId)).state).toBe('unknown')
  expect((await remote.cancel('task', started.commandId)).state).toBe('unknown')
  expect(Buffer.from((await remote.readFile('task', 'personal', 'count.txt')).base64, 'base64').toString()).toBe('once\n')
  expect(startIds).toEqual([started.commandId])
  expect(remote.hasUnsettled('task')).toBe(true)
  const inspected = remote.commands('task')[0]!
  expect(() => remote.resolveUnknown('task', started.commandId, { outcome: 'completed', evidence: 'The file contains exactly one recorded write', expectedUpdatedAt: 'old' })).toThrow('changed')
  expect(remote.resolveUnknown('task', started.commandId, { outcome: 'completed', evidence: 'The file contains exactly one recorded write', expectedUpdatedAt: inspected.updatedAt }))
    .toMatchObject({ state: 'completed', remote: { state: 'unknown' }, ownerResolution: { outcome: 'completed' } })
  expect(remote.hasUnsettled('task')).toBe(false)
  expect((await remote.start('personal', 'task', request)).state).toBe('completed')
  expect(remote.commands('task')[0]).toMatchObject({ state: 'unknown', effectiveState: 'completed' })
  const next = await remote.start('personal', 'task', { requestId: 'after-owner-confirmation', command: command('console.log("continued")') })
  expect((await completed(remote, next.commandId)).state).toBe('completed')
  remote.register({ id: 'reviewed-device', label: 'Reviewed device', url: second.url, credentialRef: 'ref' })
  remote.bind('task', 'reviewed-device'); expect(remote.binding('task')).toBe('reviewed-device')
  expect(() => remote.bind('task', 'personal-unknown')).toThrow()
  const backend = new EnvironmentStore(join(path, 'daemon', 'environment.sqlite')), oldPid = backend.get(started.commandId)?.pid; backend.close()
  if (oldPid) {
    if (process.platform === 'win32') { const killer = spawn('taskkill', ['/PID', String(oldPid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); await once(killer, 'close') }
    else { try { process.kill(-oldPid, 'SIGKILL') } catch {} }
  }
}, 20_000)
