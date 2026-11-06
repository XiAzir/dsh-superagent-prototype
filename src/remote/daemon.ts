/** Authenticated endpoint-side command/file daemon. Model contexts and provider credentials stay on the host. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync, appendFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { EnvironmentFiles } from './files.ts'
import { EnvironmentStore, type StoredCommand } from './store.ts'
import { commandPayload, ENVIRONMENT_PROTOCOL, ENVIRONMENT_SCHEMA, ENVIRONMENT_VERSION, EnvironmentError,
  payloadHash, safeRemoteText, sha256, terminalCommand, validId, type CommandRequest, type EnvironmentHealth, type RemoteCommand } from './protocol.ts'

export interface EnvironmentDaemonOptions {
  root: string; stateDir: string; token: string; host?: string; port?: number; allowInsecureNetwork?: boolean
  maxFileBytes?: number; maxCommands?: number; shell?: 'pwsh' | 'bash'; executionEnv?: Record<string, string>
}
export interface RunningEnvironmentDaemon { server: Server; url: string; daemonId: string; close(): Promise<void> }
interface ActiveCommand { child: ChildProcess; settled: Promise<void>; stop(reason: 'cancelled' | 'timed_out'): Promise<void> }
const terminalError = (error: unknown, token: string) => safeRemoteText(error instanceof Error ? error.message : error, token, 1000)
const executionEnvironment = (extra?: Record<string, string>): NodeJS.ProcessEnv => {
  const allowed = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LANG', 'LC_ALL'])
  return { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => allowed.has(name.toUpperCase()))), ...extra }
}
function within(root: string, path: string): boolean { const part = relative(root, path); return !part || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`)) }

function stateLock(stateDir: string): () => void {
  const path = join(stateDir, 'daemon.lock')
  const create = () => { const descriptor = openSync(path, 'wx', 0o600); writeFileSync(descriptor, JSON.stringify({ pid: process.pid, instance: randomUUID() })); closeSync(descriptor) }
  try { create() } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    let pid: number
    try { pid = Number(JSON.parse(readFileSync(path, 'utf8')).pid); if (!Number.isInteger(pid) || pid < 1) throw new Error() }
    catch { throw new EnvironmentError('state_locked', 'Inspect the existing environment lock before starting', 409) }
    try { process.kill(pid, 0); throw new EnvironmentError('state_locked', 'An environment daemon already owns this state directory', 409) }
    catch (caught) {
      if ((caught as NodeJS.ErrnoException).code !== 'ESRCH') throw caught
      unlinkSync(path); create()
    }
  }
  return () => { try { if (Number(JSON.parse(readFileSync(path, 'utf8')).pid) === process.pid) unlinkSync(path) } catch {} }
}

async function terminateTree(child: ChildProcess): Promise<string | undefined> {
  if (!child.pid || child.exitCode !== null) return
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let detail = ''; killer.stderr.on('data', chunk => { detail += String(chunk).slice(0, 1000 - detail.length) })
    await new Promise<void>(resolveDone => { const timeout = setTimeout(resolveDone, 1000); killer.once('error', error => { detail = error.message; clearTimeout(timeout); resolveDone() }); killer.once('close', () => { clearTimeout(timeout); resolveDone() }) })
    try { child.kill('SIGKILL') } catch {}
    // A shell can launch a child between taskkill's tree enumeration and termination. Recheck the
    // original parent ID after it stops, so an inherited output pipe cannot keep that child alive.
    const cleanup = `$known = [System.Collections.Generic.HashSet[int]]::new(); [void]$known.Add(${child.pid}); for ($round = 0; $round -lt 3; $round++) { $rows = @(Get-CimInstance Win32_Process); do { $added = $false; foreach ($row in $rows) { if ($known.Contains([int]$row.ParentProcessId) -and $known.Add([int]$row.ProcessId)) { $added = $true } } } while ($added); foreach ($targetId in $known) { Stop-Process -Id $targetId -Force -ErrorAction SilentlyContinue }; Start-Sleep -Milliseconds 50 }`
    const sweeper = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(cleanup, 'utf16le').toString('base64')], { stdio: 'ignore', windowsHide: true })
    await new Promise<void>(resolveDone => { const deadline = setTimeout(() => { sweeper.kill(); resolveDone() }, 2000);
      sweeper.once('error', () => { clearTimeout(deadline); resolveDone() }); sweeper.once('close', () => { clearTimeout(deadline); resolveDone() }) })
    return detail || undefined
  } else {
    try { process.kill(-child.pid, 'SIGTERM') } catch { try { child.kill('SIGTERM') } catch {} }
    await new Promise(resolveDone => setTimeout(resolveDone, 100))
    try { process.kill(-child.pid, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch {} }
  }
}

/** A daemon incarnation owns live processes; earlier incarnations leave unknown records rather than replaying them. */
class CommandRunner {
  readonly active = new Map<string, ActiveCommand>()
  private options: EnvironmentDaemonOptions
  private files: EnvironmentFiles
  private store: EnvironmentStore
  private closed = false
  constructor(options: EnvironmentDaemonOptions, files: EnvironmentFiles, store: EnvironmentStore) { this.options = options; this.files = files; this.store = store }
  view(command: StoredCommand): RemoteCommand {
    const output = (path: string) => { try { const buffer = readFileSync(path); return safeRemoteText(buffer.subarray(Math.max(0, buffer.length - 64_000)).toString('utf8'), this.options.token) } catch { return '' } }
    const { payload: _payload, pid: _pid, stdoutPath, stderrPath, ...item } = command
    return { ...item, stdout: output(stdoutPath), stderr: output(stderrPath) }
  }
  get(id: string, ticketId: string): StoredCommand {
    const record = this.store.get(validId(id, 'commandId'))
    if (!record || record.ticketId !== validId(ticketId, 'ticketId')) throw new EnvironmentError('command_missing', 'Command was not found for this task', 404)
    return record
  }
  start(input: CommandRequest): RemoteCommand {
    if (this.closed) throw new EnvironmentError('closing', 'Environment daemon is closing; preserve the original command ID', 503)
    const payload = commandPayload(input), id = validId(input.commandId, 'commandId'), hash = payloadHash(payload)
    if (input.payloadHash !== undefined && input.payloadHash !== hash) throw new EnvironmentError('hash_mismatch', 'Command payload digest does not match')
    const previous = this.store.get(id)
    if (previous) {
      if (previous.ticketId !== payload.ticketId || previous.payloadHash !== hash) throw new EnvironmentError('id_conflict', 'This command ID already belongs to a different request', 409)
      return this.view(previous)
    }
    if (this.active.size >= (this.options.maxCommands ?? 4)) throw new EnvironmentError('capacity', 'Environment execution slots are full; retry this same command ID later', 429)
    const directory = this.files.path(payload.ticketId, payload.cwd ?? '.')
    if (!existsSync(directory)) throw new EnvironmentError('cwd_missing', 'The task working directory does not exist')
    const logs = join(this.options.stateDir, 'output'); mkdirSync(logs, { recursive: true, mode: 0o700 })
    const command: StoredCommand = { commandId: id, ticketId: payload.ticketId, payload, payloadHash: hash, directory,
      state: 'accepted', createdAt: new Date().toISOString(), stdoutPath: join(logs, `${sha256(id)}.stdout`), stderrPath: join(logs, `${sha256(id)}.stderr`) }
    // This durable record precedes spawn. Losing the HTTP response can never cause another spawn for the same ID.
    this.store.save(command)
    const shell = this.options.shell ?? (process.platform === 'win32' ? 'pwsh' : 'bash')
    const args = shell === 'pwsh' ? ['-NoProfile', '-NonInteractive', '-Command', payload.command] : ['--noprofile', '--norc', '-c', payload.command]
    let child: ChildProcess
    try { child = spawn(shell, args, { cwd: directory, env: executionEnvironment(this.options.executionEnv), windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] }) }
    catch (error) { command.state = 'failed'; command.reason = terminalError(error, this.options.token); command.endedAt = new Date().toISOString(); this.store.save(command); return this.view(command) }
    command.state = 'running'; command.pid = child.pid; command.startedAt = new Date().toISOString(); this.store.save(command)
    let requested: 'cancelled' | 'timed_out' | undefined, done = false, bytes = 0
    let resolveSettled: () => void = () => {}
    const settled = new Promise<void>(resolveDone => { resolveSettled = resolveDone })
    const finish = (code: number | null, error?: unknown) => {
      if (done || this.closed) return
      done = true; clearTimeout(timeout)
      command.state = requested ?? (error || code !== 0 ? 'failed' : 'completed'); command.exitCode = code
      command.endedAt = new Date().toISOString()
      if (error) command.reason = terminalError(error, this.options.token)
      if (requested) command.reason = requested === 'timed_out' ? 'The command reached its configured deadline' : 'The owner cancelled this command'
      this.store.save(command); this.active.delete(id); resolveSettled()
    }
    const collect = (path: string) => (chunk: Buffer) => {
      if (done || this.closed) return
      const room = Math.max(0, 2 * 1024 * 1024 - bytes)
      if (room) appendFileSync(path, chunk.subarray(0, room), { mode: 0o600 })
      bytes += chunk.length
      if (bytes > 2 * 1024 * 1024) command.truncated = true
    }
    child.stdout?.on('data', collect(command.stdoutPath)); child.stderr?.on('data', collect(command.stderrPath))
    child.once('error', error => finish(null, error)); child.once('close', code => finish(code))
    const stop = async (reason: 'cancelled' | 'timed_out') => {
      if (done) return
      requested = reason; const terminationDetail = await terminateTree(child)
      await Promise.race([settled, new Promise(resolveDone => setTimeout(resolveDone, 1500))])
      if (!done && !this.closed) {
        done = true; clearTimeout(timeout); command.state = 'unknown'; command.reason = `Process termination could not be confirmed; preserve this command ID and inspect the environment (pid ${child.pid}, exit ${child.exitCode}, signal ${child.signalCode})${terminationDetail ? ` (${terminalError(terminationDetail, this.options.token)})` : ''}`
        command.endedAt = new Date().toISOString(); this.store.save(command); this.active.delete(id); resolveSettled()
      }
    }
    const timeout = setTimeout(() => { void stop('timed_out') }, payload.timeoutMs); timeout.unref()
    this.active.set(id, { child, stop, settled })
    return this.view(command)
  }
  async cancel(id: string, ticketId: string): Promise<RemoteCommand> {
    const command = this.get(id, ticketId), active = this.active.get(id)
    if (active) await active.stop('cancelled')
    return this.view(this.get(id, ticketId))
  }
  async close(): Promise<void> {
    await Promise.allSettled([...this.active.values()].map(active => active.stop('cancelled')))
    this.closed = true
  }
}

async function body(req: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let bytes = 0
  for await (const chunk of req) { bytes += chunk.length; if (bytes > maxBytes) throw new EnvironmentError('body_limit', 'Request body exceeds its limit', 413); chunks.push(Buffer.from(chunk)) }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> }
  catch { throw new EnvironmentError('invalid_json', 'Request requires a JSON object') }
}

export async function startEnvironmentDaemon(options: EnvironmentDaemonOptions): Promise<RunningEnvironmentDaemon> {
  if (typeof options.token !== 'string' || options.token.trim().length < 24 || /[\r\n\0]/.test(options.token)) throw new EnvironmentError('credential', 'Configure an environment token of at least 24 characters')
  if (options.maxCommands !== undefined && (!Number.isInteger(options.maxCommands) || options.maxCommands < 1 || options.maxCommands > 64)) throw new EnvironmentError('configuration', 'maxCommands must be an integer from 1 to 64')
  if (options.maxFileBytes !== undefined && (!Number.isInteger(options.maxFileBytes) || options.maxFileBytes < 1 || options.maxFileBytes > 100 * 1024 * 1024)) throw new EnvironmentError('configuration', 'maxFileBytes must be between 1 and 104857600')
  const host = options.host ?? '127.0.0.1'
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !options.allowInsecureNetwork) throw new EnvironmentError('transport', 'An explicit private-network option is required for a non-loopback HTTP listener')
  const files = new EnvironmentFiles(resolve(options.root), options.maxFileBytes)
  const stateDir = resolve(options.stateDir); mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  if (within(files.root, realpathSync(stateDir))) throw new EnvironmentError('state_location', 'Keep environment state outside task workspaces')
  options = { ...options, root: files.root, stateDir }
  const release = stateLock(stateDir)
  let store: EnvironmentStore
  try {
    store = new EnvironmentStore(join(stateDir, 'environment.sqlite'))
    const previousRoot = store.db.prepare('SELECT value FROM meta WHERE key=?').get('workspaceRoot')?.value
    if (previousRoot !== undefined && String(previousRoot) !== files.root) { store.close(); throw new EnvironmentError('state_root', 'This environment state belongs to another workspace root', 409) }
    store.db.prepare('INSERT OR IGNORE INTO meta(key,value) VALUES (?,?)').run('workspaceRoot', files.root)
    store.recover()
  } catch (error) { release(); throw error }
  const runner = new CommandRunner(options, files, store)
  let closing = false
  const authorized = (req: IncomingMessage) => {
    const actual = Buffer.from(req.headers.authorization ?? ''), expected = Buffer.from(`Bearer ${options.token}`)
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  }
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const reply = (status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)) }
    if (!authorized(req)) { reply(401, { error: 'unauthorized', message: 'Environment authentication is required' }); return }
    try {
      if (closing) throw new EnvironmentError('closing', 'Environment daemon is closing; preserve the original request', 503)
      const url = new URL(req.url ?? '/', 'http://environment.local'), path = url.pathname
      if (req.method === 'GET' && path === '/v1/health') {
        const health: EnvironmentHealth = { protocol: ENVIRONMENT_PROTOCOL, schema: ENVIRONMENT_SCHEMA, version: ENVIRONMENT_VERSION,
          daemonId: store.daemonId, platform: process.platform, node: process.versions.node, activeCommands: runner.active.size, maxFileBytes: files.maxBytes }
        reply(200, health); return
      }
      if (req.method === 'POST' && path === '/v1/workspaces') {
        const input = await body(req, 8192); reply(200, { directory: files.workspace(validId(input.ticketId, 'ticketId')) }); return
      }
      if (req.method === 'POST' && path === '/v1/commands/start') { reply(200, runner.start(await body(req, 128_000) as unknown as CommandRequest)); return }
      const command = /^\/v1\/commands\/([^/]+)(\/cancel)?$/.exec(path)
      if (command && req.method === 'GET' && !command[2]) { reply(200, runner.view(runner.get(decodeURIComponent(command[1]!), url.searchParams.get('ticketId') ?? ''))); return }
      if (command && req.method === 'POST' && command[2]) {
        const input = await body(req, 8192); reply(200, await runner.cancel(decodeURIComponent(command[1]!), String(input.ticketId ?? ''))); return
      }
      if (path === '/v1/files' && req.method === 'GET') { reply(200, files.read(url.searchParams.get('ticketId') ?? '', url.searchParams.get('path') ?? '')); return }
      if (path === '/v1/files' && req.method === 'POST') {
        const input = await body(req, Math.ceil(files.maxBytes / 3) * 4 + 8192)
        reply(200, files.write(validId(input.ticketId), String(input.path ?? ''), String(input.base64 ?? ''), String(input.sha256 ?? ''), input.overwrite === true)); return
      }
      throw new EnvironmentError('not_found', 'Environment route was not found', 404)
    } catch (error) {
      const failure = error as EnvironmentError
      reply(failure.status ?? ((error as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 500), { error: failure.code ?? 'environment_error', message: terminalError(error, options.token) })
    }
  })
  server.requestTimeout = 15_000; server.headersTimeout = 10_000; server.keepAliveTimeout = 1000
  try { await new Promise<void>((resolveDone, reject) => { server.once('error', reject); server.listen(options.port ?? 0, host, () => { server.removeListener('error', reject); resolveDone() }) }) }
  catch (error) { store.close(); release(); throw error }
  const port = (server.address() as { port: number }).port
  let closed = false
  return { server, url: `http://${host.includes(':') ? `[${host}]` : host}:${port}`, daemonId: store.daemonId,
    close: async () => {
      if (closed) return
      closed = true; closing = true
      const drained = new Promise<void>(resolveDone => server.close(() => resolveDone()))
      const deadline = setTimeout(() => { server.closeAllConnections() }, 3000)
      try { await runner.close(); server.closeIdleConnections(); await drained } finally { clearTimeout(deadline); store.close(); release() }
    } }
}

/** CLI self-check/backup modes share the same protocol and schema checks as the daemon. */
export async function runEnvironmentCli(argv = process.argv.slice(2)): Promise<void> {
  const values: Record<string, string> = {}, flags = new Set<string>()
  for (let i = 0; i < argv.length; i++) {
    const option = argv[i]!
    if (['--allow-insecure-network', '--check'].includes(option)) flags.add(option)
    else if (['--root', '--state', '--token-file', '--host', '--port', '--shell', '--backup'].includes(option)) {
      const value = argv[++i]; if (value === undefined) throw new EnvironmentError('arguments', `${option} requires a value`); values[option] = value
    } else throw new EnvironmentError('arguments', `Unknown environment option: ${option}`)
  }
  if (!values['--root'] || !values['--state'] || !values['--token-file']) throw new EnvironmentError('arguments', 'Configure --root, --state and --token-file')
  const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number)
  if (nodeMajor! < 24 || nodeMajor === 24 && nodeMinor! < 9) throw new EnvironmentError('runtime_version', 'Environment daemon requires Node 24.9 or later')
  const tokenPath = resolve(values['--token-file']), rootPath = resolve(values['--root'])
  if (within(rootPath, tokenPath)) throw new EnvironmentError('credential_location', 'Keep the daemon token outside task workspaces')
  const token = readFileSync(tokenPath, 'utf8').trim(), stateDir = resolve(values['--state'])
  if (token.length < 24) throw new EnvironmentError('credential', 'Configure an environment token of at least 24 characters')
  if (flags.has('--check') || values['--backup']) {
    const store = new EnvironmentStore(join(stateDir, 'environment.sqlite'))
    try {
      const root = new EnvironmentFiles(rootPath).root, savedRoot = store.db.prepare('SELECT value FROM meta WHERE key=?').get('workspaceRoot')?.value
      if (within(root, stateDir)) throw new EnvironmentError('state_location', 'Keep environment state outside task workspaces')
      if (values['--backup'] && within(root, resolve(values['--backup']))) throw new EnvironmentError('backup_location', 'Keep state backups outside task workspaces')
      if (savedRoot !== undefined && savedRoot !== root) throw new EnvironmentError('state_root', 'This environment state belongs to another workspace root', 409)
      const check = store.db.prepare('PRAGMA quick_check').get()
      if (Object.values(check ?? {})[0] !== 'ok') throw new EnvironmentError('state_integrity', 'Environment database integrity check failed')
      if (values['--backup']) store.backup(resolve(values['--backup']))
      process.stdout.write(JSON.stringify({ protocol: ENVIRONMENT_PROTOCOL, schema: ENVIRONMENT_SCHEMA, version: ENVIRONMENT_VERSION,
        daemonId: store.daemonId, node: process.versions.node, database: 'ok', ...(values['--backup'] ? { backup: resolve(values['--backup']) } : {}) }) + '\n')
    } finally { store.close() }
    return
  }
  const port = values['--port'] === undefined ? 0 : Number(values['--port'])
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new EnvironmentError('arguments', 'Port must be between 0 and 65535')
  const shell = values['--shell']; if (shell && shell !== 'pwsh' && shell !== 'bash') throw new EnvironmentError('arguments', 'Shell must be pwsh or bash')
  const daemon = await startEnvironmentDaemon({ root: resolve(values['--root']), stateDir, token, host: values['--host'], port,
    allowInsecureNetwork: flags.has('--allow-insecure-network'), ...(shell ? { shell: shell as 'pwsh' | 'bash' } : {}) })
  process.stdout.write(JSON.stringify({ event: 'environment_started', url: daemon.url, daemonId: daemon.daemonId, protocol: ENVIRONMENT_PROTOCOL, version: ENVIRONMENT_VERSION }) + '\n')
  const stop = () => { void daemon.close().then(() => { process.exitCode = 0 }).catch(() => { process.exitCode = 1 }) }
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
}
