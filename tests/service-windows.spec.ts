/** Native Windows coverage for the service manager. Fixtures are Node sleepers with DSH-shaped command lines. */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'

let root: string
let fixtures: ChildProcess[] = []
let server: Server | undefined
let lifecycleProfile: string | undefined
let isolatedDshHome: string | undefined
const control = (profile: string) => join(root, '.artifacts', 'control', 'profiles', profile)
const profileFor = (name: string) => `${name}-${basename(root).replace(/[^A-Za-z0-9_.-]/g, '-')}`
const windowsOnly = process.platform === 'win32'

function sleeper(profile: string): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'dsh', '--profile', profile],
    { windowsHide: true, stdio: 'ignore' })
  fixtures.push(child)
  return child
}

function run(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn('python', [join(root, 'scripts', 'dsh-superagent'), ...args],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
        PATH: `${join(root, 'bin')};${process.env.PATH}`, DSH_HOME: isolatedDshHome ?? process.env.DSH_HOME,
        DSH_SUPERAGENT_PROFILE: '', DSH_SUPERAGENT_URL: '' } })
    let stdout = '', stderr = ''
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    child.on('close', code => resolve({ code: code ?? 1, stdout, stderr }))
  })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh windows service '))
  lifecycleProfile = undefined
  isolatedDshHome = undefined
  mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'bin'))
  // Test the checked out implementation against an isolated artifact directory and checkout root.
  const source = join(import.meta.dirname, '..', 'scripts')
  for (const name of ['dsh-superagent', 'dsh-superagent-windows.py', 'dsh-superagent-windows-bootstrap.mjs']) {
    writeFileSync(join(root, 'scripts', name), readFileSync(join(source, name)))
  }
})

afterEach(async () => {
  if (windowsOnly && lifecycleProfile && existsSync(join(control(lifecycleProfile), 'service.json')))
    await run('stop', '--profile', lifecycleProfile, '--stop-timeout', '2')
  server?.close(); server = undefined
  for (const child of fixtures) child.kill()
  await Promise.all(fixtures.map(child => new Promise<void>(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) resolve()
    else { child.once('close', () => resolve()); setTimeout(resolve, 2000) }
  })))
  fixtures = []
  rmSync(root, { recursive: true, force: true })
})

async function answering(state: unknown, readyWhen?: string): Promise<string> {
  server = createServer((_request, response) => {
    if (readyWhen && !existsSync(readyWhen)) { response.writeHead(503).end(); return }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(state))
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
}

async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve))
  const port = (probe.address() as AddressInfo).port
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()))
  return port
}

function fakeDsh(): void {
  // Local package-shaped fixture; only the service bootstrap process runs, with no Agent or account.
  const entry = join(root, 'bin', 'node_modules', '@deepseek-ai', 'dsh', 'lib')
  mkdirSync(entry, { recursive: true })
  const marker = JSON.stringify(join(root, 'bin', 'launched'))
  writeFileSync(join(entry, 'bin.js'), `import { writeFileSync, unlinkSync } from 'node:fs'
export async function runCli() {
  writeFileSync(${marker}, 'running')
  process.on('SIGTERM', () => { unlinkSync(${marker}); process.exit(0) })
  setInterval(() => {}, 1000)
}`)
  writeFileSync(join(root, 'bin', 'dsh.cmd'), '@echo off\r\nrem dsh command shim fixture\r\n')
}

it.skipIf(!windowsOnly)('discovers a real Windows process by exact profile and refuses ambiguous duplicates', async () => {
  const profile = profileFor('fixture-profile'), otherProfile = profileFor('another-profile')
  const one = sleeper(profile)
  const other = sleeper(otherProfile)
  await new Promise(resolve => setTimeout(resolve, 500))
  const url = `http://127.0.0.1:${await freePort()}`
  const result = await run('status', '--profile', profile, '--url', url)
  expect(result.code).toBe(1) // Fixture deliberately has no HTTP health endpoint.
  expect(JSON.parse(result.stdout).pids).toEqual([one.pid])
  expect(JSON.parse(result.stdout).pids).not.toContain(other.pid)
  const duplicate = sleeper(profile)
  await new Promise(resolve => setTimeout(resolve, 500))
  expect(await run('stop', '--profile', profile)).toMatchObject({
    code: 1, stderr: expect.stringContaining('Multiple dsh-superagent processes found'),
  })
  expect(existsSync(join(control(profile), 'manually-stopped'))).toBe(false)
  duplicate.kill()
}, 30_000)

it.skipIf(!windowsOnly)('keeps independent stop markers and refuses a PID record with a different creation identity', async () => {
  const one = profileFor('fixture-one'), two = profileFor('fixture-two'), identity = profileFor('fixture-identity')
  expect(await run('stop', '--profile', one)).toMatchObject({ code: 0 })
  expect(JSON.parse((await run('status', '--profile', one)).stdout).manually_stopped).toBe(true)
  expect(JSON.parse((await run('status', '--profile', two)).stdout).manually_stopped).toBe(false)
  const child = sleeper(identity)
  await new Promise(resolve => setTimeout(resolve, 500))
  mkdirSync(control(identity), { recursive: true })
  writeFileSync(join(control(identity), 'service.json'), JSON.stringify({ pid: child.pid, created: '20000101000000.000000+000', token: 'fixture-token' }))
  const stopped = await run('stop', '--profile', identity, '--stop-timeout', '1')
  expect(stopped).toMatchObject({ code: 1, stderr: expect.stringContaining('not managed by this service wrapper') })
  expect(child.exitCode).toBeNull()
}, 30_000)

it.skipIf(!windowsOnly)('starts, gracefully stops and restarts an isolated fixture service', async () => {
  lifecycleProfile = profileFor('fixture-lifecycle')
  fakeDsh()
  const url = await answering({ health: { runtime: { state: 'ready', detail: '' } }, setup: { problem: null, feishuProblem: null } },
    join(root, 'bin', 'launched'))
  const profile = lifecycleProfile
  const started = await run('start', '--profile', profile, '--url', url, '--timeout', '20')
  const logs = existsSync(join(root, '.artifacts')) ? readdirSync(join(root, '.artifacts')).filter(name => name.endsWith('.log')) : []
  const log = logs[0] ? readFileSync(join(root, '.artifacts', logs[0]), 'utf8') : ''
  expect(started.code, `${started.stderr}\n${started.stdout}\n${log}`).toBe(0)
  const first = JSON.parse((await run('status', '--profile', profile, '--url', url)).stdout).pids as number[]
  expect(first).toHaveLength(1)
  const identity = readFileSync(join(control(profile), 'service.json'), 'utf8')
  const stopped = await run('stop', '--profile', profile, '--stop-timeout', '10')
  expect(stopped.code, `${stopped.stderr}\n${identity}`).toBe(0)
  expect(stopped.stdout).toContain('dsh-superagent stopped')
  expect((await run('status', '--profile', profile, '--url', url)).code).toBe(1)
  const restarted = await run('restart', '--profile', profile, '--url', url, '--timeout', '20', '--stop-timeout', '10')
  expect(restarted.code, `${restarted.stderr}\n${restarted.stdout}`).toBe(0)
  const second = JSON.parse((await run('status', '--profile', profile, '--url', url)).stdout).pids as number[]
  expect(second).toHaveLength(1)
  expect(second[0]).not.toBe(first[0])
  expect(await run('stop', '--profile', profile, '--stop-timeout', '10')).toMatchObject({ code: 0 })
}, 90_000)

it.skipIf(!windowsOnly)('returns setup pending code 3 and protects each profile operation lock', async () => {
  const pendingProfile = profileFor('fixture-pending'), lockedProfile = profileFor('fixture-locked')
  const pending = { health: { runtime: { state: 'paused', detail: '' } },
    setup: { problem: { code: 'repositoryUnset', detail: 'Repository is unset.' } } }
  const url = await answering(pending)
  const child = sleeper(pendingProfile)
  const result = await run('status', '--profile', pendingProfile, '--url', url)
  expect(result.code).toBe(3)
  expect(JSON.parse(result.stdout).setup.detail).toBe('Repository is unset.')
  child.kill()
  const directory = control(lockedProfile)
  mkdirSync(directory, { recursive: true })
  const lockPath = join(directory, 'operation.lock')
  const marker = join(root, 'lock-held')
  const holder = spawn('python', ['-c', `import msvcrt, pathlib, time
f = open(${JSON.stringify(lockPath)}, 'a+b')
f.seek(0)
if f.read(1) == b'': f.seek(0); f.write(b'0'); f.flush()
f.seek(0); msvcrt.locking(f.fileno(), msvcrt.LK_LOCK, 1)
pathlib.Path(${JSON.stringify(marker)}).touch()
time.sleep(20)`], { windowsHide: true, stdio: 'ignore' })
  fixtures.push(holder)
  const deadline = Date.now() + 5000
  while (!existsSync(marker) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
  expect(existsSync(marker)).toBe(true)
  expect(await run('status', '--profile', lockedProfile)).toMatchObject({ code: 1,
    stderr: expect.stringContaining('Another dsh-superagent control operation is in progress') })
}, 30_000)

const realDshAvailable = process.platform === 'win32' && spawnSync('where.exe', ['dsh.cmd'], { stdio: 'ignore' }).status === 0
it.skipIf(!realDshAvailable)('gracefully stops the installed DSH runtime from a disposable profile with no credentials', async () => {
  lifecycleProfile = profileFor('fixture-real-dsh')
  isolatedDshHome = join(root, 'isolated-dsh-home')
  const shim = spawnSync('where.exe', ['dsh.cmd'], { encoding: 'utf8' }).stdout.split(/\r?\n/)[0] ?? ''
  expect(shim).not.toBe('')
  const entry = join(dirname(shim), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const profile = lifecycleProfile
  const create = spawn(process.execPath, [entry, '--profile', profile, '--from-default-profile', 'web', '--dump-config'],
    { windowsHide: true, stdio: 'ignore', env: { ...process.env, DSH_HOME: isolatedDshHome } })
  const createCode = await new Promise<number>(resolve => create.on('close', code => resolve(code ?? 1)))
  expect(createCode).toBe(0)
  const port = await freePort()
  writeFileSync(join(isolatedDshHome, 'profiles', profile, 'cordis.patch.yml'),
    `- id: webserver\n  config:\n    host: 127.0.0.1\n    port: ${port}\n`)
  const url = `http://127.0.0.1:${port}`
  const started = await run('start', '--profile', profile, '--url', url, '--timeout', '30')
  const status = await run('status', '--profile', profile, '--url', `http://127.0.0.1:${port}`)
  expect(started.code, started.stderr).toBe(1) // The plain web template has no orchestrator health API.
  expect((await fetch(url)).status).toBe(401) // The authenticated DSH root is listening and enforces its browser token.
  expect(JSON.parse(status.stdout).pids).toHaveLength(1)
  const stopped = await run('stop', '--profile', profile, '--stop-timeout', '30')
  expect(stopped.code, stopped.stderr).toBe(0)
  expect(JSON.parse((await run('status', '--profile', profile, '--url', `http://127.0.0.1:${port}`)).stdout).pids).toEqual([])
}, 90_000)
