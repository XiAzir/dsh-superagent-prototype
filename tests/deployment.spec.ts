import { execFile } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Config, executable, machineOf, resolveDeployment, resolveFeishuBot, workerProbe, type Machine, type Probe } from '../src/deployment.ts'
import { commandInvocation } from '../src/infra/platform.ts'
import { workerBin } from '../src/infra/environment.ts'
import { gitEnv } from './fixtures/git.ts'

const exec = promisify(execFile)
let dir: string
let path: string
const program = (file: string, body = ''): string => {
  if (process.platform === 'win32') {
    const cmd = `${file}.cmd`
    const script = `${file}.ps1`
    let contents = 'param([Parameter(ValueFromRemainingArguments=$true)][string[]]$ArgList)\r\n'
    if (body.startsWith('__GH__')) {
      const { login, push } = JSON.parse(body.slice(6)) as { login: string; push: boolean }
      contents += `$joined = $ArgList -join ' '\r\nswitch -Exact ($joined) { 'api user' { '{"login":"${login}","id":7}'; exit 0 } 'api repos/acme/widgets --jq {name: .full_name, push: .permissions.push}' { '{"name":"acme/widgets","push":${push}}'; exit 0 } 'api repos/acme/gadgets --jq {name: .full_name, push: .permissions.push}' { '{"name":"acme/widgets","push":${push}}'; exit 0 } default { exit 1 } }\r\n`
    } else if (body.startsWith('__LARK__')) {
      const data = JSON.parse(body.slice(8)) as { status: object; mode: string; bot: object }
      contents += `$joined = $ArgList -join ' '\r\nswitch -Exact ($joined) { 'auth status' { '${JSON.stringify(data.status)}'; exit 0 } 'config strict-mode' { 'strict-mode: ${data.mode} (source: profile)'; exit 0 } 'api GET /open-apis/bot/v3/info --as bot --format ndjson' { '${JSON.stringify(data.bot)}'; exit 0 } default { exit 1 } }\r\n`
    } else if (body.includes('HTTP 404')) contents += `if (($ArgList -join ' ') -eq 'api user') { '{"login":"Agent-Bot","id":7}'; exit 0 }; [Console]::Error.WriteLine('HTTP 404'); exit 1\r\n`
    else if (body.includes('not configured')) contents += "[Console]::Error.WriteLine('not configured'); exit 1\r\n"
    else if (body.includes("echo '{}'")) contents += "'{}'; exit 0\r\n"
    else if (body.includes('exit 1')) contents += 'exit 1\r\n'
    else contents += 'exit 0\r\n'
    writeFileSync(script, contents); writeFileSync(cmd, '@echo off\r\nexit /b 0\r\n'); return cmd
  }
  writeFileSync(file, `#!/bin/sh\n${body}\n`); chmodSync(file, 0o755); return file
}
/** Fake gh CLI signed in as `login` with configurable push access to acme/widgets (including its former name acme/gadgets). */
const gh = (file: string, login: string, push = true): string => program(file, process.platform === 'win32' ? `__GH__${JSON.stringify({ login, push })}` : `case "$*" in\n  "api user") echo '{"login":"${login}","id":7}' ;;\n  "api repos/acme/"*" --jq {name: .full_name, push: .permissions.push}") echo '{"name":"acme/widgets","push":${push}}' ;;\n  *) exit 1 ;;\nesac`)
/** Fake lark-cli script body returning canned auth, strict-mode, and bot info responses. */
const lark = (status: object, mode = 'bot', bot: object = { bot: { open_id: 'ou_bot', app_name: 'Widgets Bot' }, code: 0 }): string =>
  process.platform === 'win32' ? `__LARK__${JSON.stringify({ status, mode, bot })}` : `case "$*" in\n  "auth status") echo '${JSON.stringify(status)}' ;;\n  "config strict-mode") echo 'strict-mode: ${mode} (source: profile)' ;;\n  "api GET /open-apis/bot/v3/info --as bot --format ndjson") echo '${JSON.stringify(bot)}' ;;\nesac`
const minimal = (overrides: Record<string, unknown> = {}) => ({ stateDir: join(dir, 'state'), ...overrides })
const machine = (overrides: Partial<Machine> = {}): Machine => ({ ...machineOf(Config(minimal())), ...overrides })
/** Runs commands like worker shells do, but locally: the stand-ins first on PATH, then the system's git. */
const probe: Probe = async (argv, overrides = {}) => {
  const invocation = commandInvocation(argv[0]!, argv.slice(1))
  return (await exec(invocation.file, invocation.args, { env: { ...process.env, PATH: [path, process.env.PATH].filter(Boolean).join(delimiter), HOME: dir, ...overrides } })).stdout
}
const setupError = (place: string, code: string, values: Record<string, unknown> = {}) => expect.objectContaining({ place, code, values: expect.objectContaining(values) })

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'deployment-'))
  mkdirSync(join(dir, 'bin')); mkdirSync(join(dir, 'state', 'worker-bin'), { recursive: true }); mkdirSync(join(dir, 'widgets', 'src'), { recursive: true })
  path = [join(dir, 'state-link', 'worker-bin'), `${join(dir, 'state', 'worker-bin')}${process.platform === 'win32' ? '\\' : '/'}`, join(dir, 'bin'), process.platform === 'win32' ? 'C:\\Windows\\System32' : '/usr/bin', '/bin', process.env.PATH ?? ''].join(delimiter)
  gh(join(dir, 'bin', 'gh'), 'Agent-Bot')
  program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', brand: 'lark', identities: { bot: { status: 'ready' } } }))
  // Stale worker shims with the same binary name must be skipped regardless of PATH normalization or symlinks.
  program(join(dir, 'state', 'worker-bin', 'gh'))
  symlinkSync(join(dir, 'state'), join(dir, 'state-link'), process.platform === 'win32' ? 'junction' : 'dir')
  await exec('git', ['init', '-q', join(dir, 'widgets')], { env: gitEnv() })
  await exec('git', ['-C', join(dir, 'widgets'), 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git'], { env: gitEnv() })
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

// Setup spawns CLI subprocesses that can take several seconds when tests run in parallel.
vi.setConfig({ testTimeout: 30_000 })

describe('configuration schema', () => {
  it('requires only the state directory and reads the editable fields through references', () => {
    expect(() => Config({})).toThrow('stateDir')
    const read = machineOf(Config({ stateDir: join(dir, 'state') }))
    // Limits are volatile references that the loader updates in place and callers read when used.
    expect({ ...read, promptMaxChars: read.promptMaxChars.get(), admissionContextMaxPages: read.admissionContextMaxPages.get(),
      admissionContextTimeoutMs: read.admissionContextTimeoutMs.get() })
      .toEqual({ stateDir: join(dir, 'state'), mode: 'repository', promptMaxChars: 100000, admissionContextMaxPages: 10, admissionContextTimeoutMs: 15000 })
    expect(() => Config(minimal({ stateDir: 'relative/dir' }))).toThrow()
    expect(() => Config(minimal({ stateDir: '~/dir' }))).toThrow()
    expect(() => Config({ stateDir: 'C:\\absolute\\state' })).not.toThrow()
    expect(() => Config({ stateDir: '\\\\server\\share\\state' })).not.toThrow()
    expect(() => Config({ stateDir: 'C:drive-relative' })).toThrow()
    expect(() => Config({ stateDir: '\\root-relative' })).toThrow()
  })
  it('names keys the configuration does not define, and where the values of older keys live now', () => {
    const raw = minimal({ repository: 'acme/widgets', repositoryPath: '/srv/widgets', blockedCommands: [], author: { name: 'Alice' }, extra: 1 })
    expect(() => machineOf(Config(raw))).toThrow('keys it does not use: repository (now on the GitHub Source), repositoryPath (now in the prepare command of the Execution settings), blockedCommands (now in the Execution settings), author (now prompt text), extra;')
  })
  it('resolves personal mode without probing GitHub or Feishu', async () => {
    const personal = machine({ mode: 'personal' })
    const deployment = await resolveDeployment(personal, { repository: 'acme/widgets', cli: 'missing' }, async () => { throw new Error('unexpected CLI probe') }, path)
    expect(deployment).toEqual(personal)
    expect(deployment).not.toHaveProperty('repository')
    expect(deployment).not.toHaveProperty('github')
  })
})

describe('setup', () => {
  it('sets startup probe environment directly and removes worker-bin without invoking an env program', async () => {
    const previousPath = process.env.PATH
    vi.stubEnv('PATH', [workerBin(machine().stateDir), process.env.PATH].filter(Boolean).join(delimiter))
    let call: { argv: readonly string[]; env?: Record<string, string> } | undefined
    const subprocess = { spawn: (input: { argv: readonly string[]; env?: Record<string, string> }) => {
      call = input
      return { done: Promise.resolve({ exitCode: 0 }), collected: { stdout: { readFrom: () => ({ text: 'probe-ok' }) } } }
    } } as unknown as import('@deepseek-ai/dsh-subprocess').SubprocessRuntime
    try {
      const result = await workerProbe(subprocess, machine().stateDir, dir, new AbortController().signal)
        ([join(dir, 'bin', 'probe.ps1'), 'api', 'user'], { LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1' })
      expect(result).toBe('probe-ok')
      expect(call?.argv).not.toContain('env')
      expect(call?.argv.slice(-3)).toEqual([join(dir, 'bin', 'probe.ps1'), 'api', 'user'])
      expect(call?.env?.PATH?.toLocaleLowerCase()).not.toContain(workerBin(machine().stateDir).toLocaleLowerCase())
      expect(call?.env?.LARKSUITE_CLI_NO_UPDATE_NOTIFIER).toBe('1')
      expect(Object.keys(call?.env ?? {}).sort()).toEqual(['LARKSUITE_CLI_NO_UPDATE_NOTIFIER', 'PATH'])
    } finally { vi.stubEnv('PATH', previousPath ?? '') }
  })
  it('reads the repository from the GitHub Source and the accounts from their CLIs, skipping the worker shims', async () => {
    const deployment = await resolveDeployment(machine(), { repository: 'acme/widgets', cli: 'gh' }, probe, path)
    const resolvedGh = `${join(dir, 'bin', 'gh')}${process.platform === 'win32' ? '.ps1' : ''}`
    expect(deployment).toMatchObject({ repository: 'acme/widgets', github: { cli: resolvedGh, login: 'Agent-Bot', noreply: '7+Agent-Bot@users.noreply.github.com' } })
    expect(deployment.github).toEqual({ cli: resolvedGh, login: 'Agent-Bot', noreply: '7+Agent-Bot@users.noreply.github.com' })
    expect(deployment).not.toHaveProperty('feishu')
    // A renamed repository is still resolved by its old name; notifications carry GitHub's current full_name.
    expect((await resolveDeployment(machine(), { repository: 'acme/gadgets', cli: 'gh' }, probe, path)).repository).toBe('acme/widgets')
  })
  it('names what setup needs and where it is set', async () => {
    const needs = (place: string, code: string, values: Record<string, unknown>, github: unknown) =>
      expect(resolveDeployment(machine(), github, probe, path)).rejects.toEqual(setupError(place, code, values))
    const repository = 'acme/widgets'
    await needs('github', 'repositoryUnset', {}, { cli: 'gh' })
    await needs('github', 'agentCliUnset', {}, { repository })
    await needs('github', 'agentCliMissing', { output: `${join(dir, 'missing')} is not an executable file` }, { repository, cli: join(dir, 'missing') })
    await needs('github', 'agentCliMissing', { output: 'bin/gh must be a command name or an absolute path' }, { repository, cli: 'bin/gh' })
    await needs('github', 'agentCliSignedOut', {}, { repository, cli: program(join(dir, 'bin', 'gh-broken'), 'exit 1') })
    await needs('github', 'repositoryReadOnly', { account: 'Agent-Bot', repository: 'acme/widgets' }, { repository, cli: gh(join(dir, 'bin', 'gh-reader'), 'Agent-Bot', false) })
    // Signed in, but the account cannot read the repository, or the CLI names no account.
    const unreadable = program(join(dir, 'bin', 'gh-outsider'),
      `case "$*" in\n  "api user") echo '{"login":"Agent-Bot","id":7}' ;;\n  *) echo 'HTTP 404' >&2; exit 1 ;;\nesac`)
    const output = expect.stringContaining('HTTP 404') as unknown
    await needs('github', 'repositoryUnreadable', { account: 'Agent-Bot', repository: 'acme/widgets', output }, { repository, cli: unreadable })
    await needs('github', 'agentCliNoAccount', {}, { repository, cli: program(join(dir, 'bin', 'gh-anonymous'), `echo '{}'`) })
    expect(() => executable('nothing-here', join(dir, 'bin'))).toThrow('nothing-here is not an executable file on PATH')
    if (process.platform === 'win32') {
      expect(executable('gh', path, workerBin(machine().stateDir))).toBe(`${join(dir, 'bin', 'gh')}.ps1`)
      writeFileSync(join(dir, 'bin', 'unsafe.cmd'), '@echo off\r\nexit /b 0\r\n')
      expect(() => executable('unsafe', path)).toThrow('unsafe is not an executable file on PATH')
    }
  })
  it('reads the Feishu bot from a bot-only lark-cli, or finds none when the Feishu Source names no CLI', async () => {
    expect(await resolveFeishuBot(machine(), {}, probe, path)).toBeUndefined()
    expect(await resolveFeishuBot(machine(), { cli: 'lark-cli' }, probe, path)).toEqual({ cli: `${join(dir, 'bin', 'lark-cli')}${process.platform === 'win32' ? '.ps1' : ''}`, appId: 'cli_bot', brand: 'lark', botId: 'ou_bot', name: 'Widgets Bot' })
    const refuses = async (code: string, values: Record<string, unknown> = {}) => expect(resolveFeishuBot(machine(), { cli: 'lark-cli' }, probe, path)).rejects.toEqual(setupError('feishu', code, values))
    program(join(dir, 'bin', 'lark-cli'), lark({ identities: { bot: { status: 'ready' } } }))
    await refuses('feishuNoApp')
    program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', identities: { bot: { status: 'missing' } } }))
    await refuses('feishuBotNotReady', { app: 'cli_bot', status: 'missing' })
    program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', identities: { bot: { status: 'ready' } } }, 'off'))
    await refuses('feishuUserIdentity', { mode: 'off' })
    program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', identities: { bot: { status: 'ready' } } }, 'bot', { code: 0, data: {} }))
    await refuses('feishuNoBot')
    program(join(dir, 'bin', 'lark-cli'), 'echo "not configured" >&2; exit 1')
    await refuses('feishuCliFailed', { output: expect.stringContaining('not configured') })
  })
})
