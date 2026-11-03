import { execFile, spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SENSITIVE_ENV_PATTERN, type SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { GIT_LOCATION, agentVariables, credentialHelper, runAsWorker, verifyDirectory, withoutDirectory, workerBin, workerGitConfig, writeEnvironment }
  from '../src/infra/environment.ts'
import { CliError } from '../src/infra/commands.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { gitEnv } from './fixtures/git.ts'
import { commandInvocation } from '../src/infra/platform.ts'

// Git and shell subprocesses can exceed the 5s default timeout when the test suite runs in parallel.
vi.setConfig({ testTimeout: 30_000 })
const exec = promisify(execFile)
const itPosix = process.platform === 'win32' ? it.skip : it
const itWindows = process.platform === 'win32' ? it : it.skip
let dir: string
const program = (path: string, body: string): string => { writeFileSync(path, `#!/bin/sh\n${body}\n`); chmodSync(path, 0o755); return path }
/** Worker shell environment after DSH strips credential-shaped variables. */
const workerEnv = (env: Record<string, string | undefined>): Record<string, string> =>
  Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined && !SENSITIVE_ENV_PATTERN.test(entry[0])))
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'environment-')); mkdirSync(join(dir, 'real')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('worker shims', () => {
  itPosix('keeps the isolated Git environment usable without creating GitHub credentials or accounts', async () => {
    const deployment = testDeployment({ stateDir: dir, mode: 'personal', repository: undefined, github: undefined, feishu: undefined })
    await writeEnvironment(deployment, [])
    expect(readFileSync(workerGitConfig(dir), 'utf8')).not.toContain('credential "https://github.com"')
    await expect(exec(join(workerBin(dir), 'gh'), ['api', 'user'])).rejects.toMatchObject({
      code: 1, stderr: 'gh is unavailable: this installation has no GitHub Source.\n',
    })
  })
  itPosix('run a wrapper that calls `gh` by name without reaching the shim again, and keep the caller\'s other PATH entries', async () => {
    program(join(dir, 'real', 'gh'), 'echo "{\\"login\\":\\"agent-bot\\",\\"config\\":\\"$GH_CONFIG_DIR\\",\\"path\\":\\"$PATH\\"}"')
    const wrapper = program(join(dir, 'gh-agent'), `GH_CONFIG_DIR=${dir}/agent-config exec gh "$@"`)
    await writeEnvironment(testDeployment({ stateDir: dir, github: { ...testDeployment().github!, cli: wrapper }, feishu: undefined }), [])
    const bin = workerBin(dir)
    const path = [bin, join(dir, 'venv'), join(dir, 'real'), '/usr/bin', '/bin'].join(':')
    const { stdout } = await exec('gh', ['api', 'user'], { env: { PATH: path }, timeout: 10_000 })
    expect(JSON.parse(stdout)).toEqual({ login: 'agent-bot', config: `${dir}/agent-config`, path: [join(dir, 'venv'), join(dir, 'real'), '/usr/bin', '/bin'].join(':') })
  })
  itPosix('make `lark-cli` fail without a Feishu bot and each blocked command fail with the agent\'s login', async () => {
    await writeEnvironment(testDeployment({ stateDir: dir, feishu: undefined }), ['personal-gh'])
    const bin = workerBin(dir)
    await expect(exec(join(bin, 'lark-cli'), ['im', '+chat-list'])).rejects.toMatchObject({ code: 1, stderr: 'lark-cli is unavailable: this installation has no Feishu bot.\n' })
    await expect(exec(join(bin, 'personal-gh'), [])).rejects.toMatchObject({ code: 1, stderr: 'personal-gh is blocked in this installation; use gh, which acts as agent-bot.\n' })
  })
  itPosix('keep `gh` and `lark-cli` working, and shim no `git`, when the blocked commands name the commands workers need', async () => {
    const gh = program(join(dir, 'gh-agent'), 'echo gh "$@"'), lark = program(join(dir, 'lark-bot'), 'echo lark "$@"')
    const base = testDeployment()
    await writeEnvironment(testDeployment({ stateDir: dir, github: { ...base.github!, cli: gh }, feishu: { ...base.feishu!, cli: lark } }), ['gh', 'git', 'lark-cli'])
    const bin = workerBin(dir)
    expect([(await exec(join(bin, 'gh'), ['api', 'user'])).stdout, (await exec(join(bin, 'lark-cli'), ['im'])).stdout]).toEqual(['gh api user\n', 'lark im\n'])
    expect(readdirSync(bin)).not.toContain('git')
  })
  itPosix('blocks GitHub credential export/account changes and Lark auth/config before the configured CLI runs', async () => {
    const marker = join(dir, 'called')
    const gh = program(join(dir, 'gh-agent'), `printf '%s\\n' "$*"; printf '%s\\n' "$*" >> '${marker}'`)
    const lark = program(join(dir, 'lark-bot'), `printf '%s\\n' "$*"; printf '%s\\n' "$*" >> '${marker}'`)
    const base = testDeployment()
    await writeEnvironment(testDeployment({ stateDir: dir, github: { ...base.github!, cli: gh }, feishu: { ...base.feishu!, cli: lark } }), [])
    const bin = workerBin(dir)
    const denied = [
      ['gh', ['auth', 'token']], ['gh', ['auth', 'git-credential', 'get']],
      ['gh', ['auth', 'status', '--show-token']], ['gh', ['auth', 'status', '-t']],
      ['gh', ['auth', 'login', '--with-token', 'credential-fixture-must-not-echo']],
      ...['login', 'logout', 'switch', 'refresh', 'setup-git'].map(action => ['gh', ['auth', action]] as [string, string[]]),
      ['lark-cli', ['auth', 'status']], ['lark-cli', ['auth', 'login']], ['lark-cli', ['config', 'strict-mode', 'user', '--global']],
    ] as [string, string[]][]
    for (const [command, args] of denied) {
      await expect(exec(join(bin, command), args)).rejects.toMatchObject({ code: 1 })
      expect(existsSync(marker)).toBe(false)
    }
    const refusal = await exec(join(bin, 'gh'), ['auth', 'login', '--with-token', 'credential-fixture-must-not-echo']).catch((error: unknown) => error as { stderr?: string })
    expect(refusal.stderr).not.toContain('credential-fixture-must-not-echo')
    await expect(exec(join(bin, 'gh'), ['--hostname', 'github.com', 'auth', 'status'])).resolves.toMatchObject({ stdout: '--hostname github.com auth status\n' })
    await expect(exec(join(bin, 'gh'), ['pr', 'list'])).resolves.toMatchObject({ stdout: 'pr list\n' })
    await expect(exec(join(bin, 'gh'), ['api', 'user'])).resolves.toMatchObject({ stdout: 'api user\n' })
    await expect(exec(join(bin, 'lark-cli'), ['api', 'GET', '/open-apis/bot/v3/info'])).resolves.toMatchObject({ stdout: 'api GET /open-apis/bot/v3/info\n' })
    expect(readFileSync(marker, 'utf8').trim().split('\n')).toEqual([
      '--hostname github.com auth status', 'pr list', 'api user', 'api GET /open-apis/bot/v3/info',
    ])
  })
  itPosix('replace only what dsh-superagent wrote and refuse anything else in its places', async () => {
    await writeEnvironment(testDeployment({ stateDir: dir }), ['old-cli'])
    await writeEnvironment(testDeployment({ stateDir: dir }), [])
    expect(readdirSync(workerBin(dir)).sort()).toEqual(['gh', 'lark-cli'])
    // A file that merely contains the marker on a later line, a symlink to a shim, and a foreign gitconfig are all rejected.
    writeFileSync(join(workerBin(dir), 'notes'), `notes\nmore\n${readFileSync(join(workerBin(dir), 'gh'), 'utf8').split('\n')[1]}\n`)
    await expect(writeEnvironment(testDeployment({ stateDir: dir }), [])).rejects.toThrow(`${join(workerBin(dir), 'notes')} was not written by dsh-superagent`)
    rmSync(join(workerBin(dir), 'notes'))
    symlinkSync(join(workerBin(dir), 'gh'), join(workerBin(dir), 'link'))
    await expect(writeEnvironment(testDeployment({ stateDir: dir }), [])).rejects.toThrow('link was not written by dsh-superagent')
    rmSync(join(workerBin(dir), 'link'))
    writeFileSync(workerGitConfig(dir), '[user]\n\tname = someone\n')
    await expect(writeEnvironment(testDeployment({ stateDir: dir }), [])).rejects.toThrow(`${workerGitConfig(dir)} was not written by dsh-superagent`)
    expect(readFileSync(workerGitConfig(dir), 'utf8')).toBe('[user]\n\tname = someone\n')
  })
  itPosix('replaces the files it wrote under the project\'s earlier names', async () => {
    await writeEnvironment(testDeployment({ stateDir: dir }), ['old-cli', 'older-cli'])
    const legacy = (file: string, name: string) => writeFileSync(file, readFileSync(file, 'utf8').replace('Written by dsh-superagent', `Written by ${name}`))
    legacy(join(workerBin(dir), 'old-cli'), 'dsh-tag'); legacy(join(workerBin(dir), 'older-cli'), 'dsh-freelancer'); legacy(workerGitConfig(dir), 'dsh-go')
    await writeEnvironment(testDeployment({ stateDir: dir }), [])
    expect(readdirSync(workerBin(dir)).sort()).toEqual(['gh', 'lark-cli'])
    expect(readFileSync(workerGitConfig(dir), 'utf8')).toContain('Written by dsh-superagent')
  })
})

describe('Windows worker wrappers', () => {
  itWindows('preserves literal argv through the PowerShell wrapper and removes the shim directory from PATH', async () => {
    const target = join(dir, 'agent cli.ps1')
    writeFileSync(target, 'param([Parameter(ValueFromRemainingArguments=$true)][string[]]$ArgList)\r\nConvertTo-Json -InputObject ([string[]]$ArgList) -Compress\r\n')
    const cmdTarget = target.replace(/\.ps1$/i, '.cmd')
    writeFileSync(cmdTarget, '@echo off\r\nREM paired entry\r\n')
    await writeEnvironment(testDeployment({ stateDir: dir, github: { ...testDeployment().github!, cli: cmdTarget }, feishu: undefined }), [])
    const bin = workerBin(dir)
    const args = ['space here', 'quote"inside', 'semi;colon', 'percent%value', 'bang!value', 'amp&pipe|paren()', 'caret^value', '<less>', '>greater>']
    const invocation = commandInvocation(join(bin, 'gh.cmd'), args)
    const { stdout } = await exec(invocation.file, invocation.args, { env: { ...process.env, PATH: [bin, process.env.PATH].join(';') }, timeout: 10_000 })
    expect(JSON.parse(stdout)).toEqual(args)
    expect(readFileSync(join(bin, 'gh.ps1'), 'utf8')).toContain(Buffer.from(target, 'utf16le').toString('base64'))
  })
  itWindows('rejects credential/account commands before the configured CLI and preserves allowed argv', async () => {
    const marker = join(dir, 'called.jsonl')
    const target = join(dir, 'agent gh.ps1')
    const cmd = target.replace(/\.ps1$/i, '.cmd')
    const markerLiteral = marker.replaceAll("'", "''")
    writeFileSync(target, `param([Parameter(ValueFromRemainingArguments=$true)][string[]]$ArgList)\r\n[IO.File]::AppendAllText('${markerLiteral}', (ConvertTo-Json -InputObject ([string[]]$ArgList) -Compress) + [Environment]::NewLine)\r\n`)
    writeFileSync(cmd, '@echo off\r\nREM paired entry\r\n')
    const base = testDeployment()
    await writeEnvironment(testDeployment({ stateDir: dir, github: { ...base.github!, cli: cmd }, feishu: undefined }), [])
    const bin = workerBin(dir)
    for (const args of [['auth', 'token'], ['auth', 'status', '--show-token'], ['auth', 'status', '-t'], ['auth', 'switch']]) {
      const invocation = commandInvocation(join(bin, 'gh.cmd'), args)
      await expect(exec(invocation.file, invocation.args)).rejects.toMatchObject({ code: 1 })
      expect(existsSync(marker)).toBe(false)
    }
    const args = ['api', 'repos/acme/repo/issues', '--jq', '.title == "a b"', 'semi;colon', 'amp&pipe|paren()']
    const invocation = commandInvocation(join(bin, 'gh.cmd'), args)
    await exec(invocation.file, invocation.args)
    expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual(args)
  })
  itWindows('writes paired owned shims and refuses foreign files without weakening marker checks', async () => {
    await writeEnvironment(testDeployment({ stateDir: dir }), ['GH.CMD', 'Git.EXE', 'LARK-CLI.PS1', 'personal-cli.cmd', 'PERSONAL-CLI'])
    expect(readdirSync(workerBin(dir)).sort()).toEqual(['gh.cmd', 'gh.ps1', 'lark-cli.cmd', 'lark-cli.ps1', 'personal-cli.cmd', 'personal-cli.ps1'])
    const cmd = readFileSync(join(workerBin(dir), 'gh.cmd'), 'utf8')
    expect(cmd).toContain('Written by dsh-superagent')
    writeFileSync(join(workerBin(dir), 'foreign.cmd'), `@echo off\r\nREM foreign wrapper\r\n${cmd.split('\r\n')[1]}\r\n`)
    await expect(writeEnvironment(testDeployment({ stateDir: dir }), [])).rejects.toThrow('foreign.cmd was not written by dsh-superagent')
  })
  itWindows('rejects an unpaired cmd entry before hostile-looking argv can enter a shell', async () => {
    const capture = join(dir, 'capture.js')
    const cmd = join(dir, 'capture.cmd')
    writeFileSync(capture, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))')
    writeFileSync(cmd, '@echo off\r\nnode "%~dp0capture.js" %*\r\n')
    const args = ['a"&echo injected>pwned.txt&"', '%PATH%', '!bang!', 'a\nline', '']
    expect(() => commandInvocation(cmd, args)).toThrow('a paired PowerShell .ps1 wrapper is required')
    expect(existsSync(join(dir, 'pwned.txt'))).toBe(false)
  })
  itWindows('runs Git credential lookup through the account PowerShell CLI with operator tokens removed', async () => {
    const cliPs1 = join(dir, 'agent gh.ps1')
    const cli = cliPs1.replace(/\.ps1$/i, '.cmd')
    writeFileSync(cliPs1, 'param([Parameter(ValueFromRemainingArguments=$true)][string[]]$ArgList)\r\nif (($ArgList -join \' \') -ne \'auth git-credential get\') { exit 2 }; $null = [Console]::In.ReadToEnd(); \'username=agent-bot\'; \'password=fake-token\'; exit 0\r\n')
    writeFileSync(cli, '@echo off\r\nREM paired entry\r\n')
    await writeEnvironment(testDeployment({ stateDir: dir, github: { ...testDeployment().github!, cli }, feishu: undefined }), [])
    const env = workerEnv({ ...process.env, ...agentVariables(dir), GIT_CONFIG_GLOBAL: workerGitConfig(dir), GIT_CONFIG_NOSYSTEM: '1', GH_TOKEN: 'operator-token', GITHUB_TOKEN: 'operator-token' })
    const child = spawn('git', ['credential', 'fill'], { cwd: dir, env })
    const output = { stdout: '', stderr: '' }
    child.stdout.on('data', value => { output.stdout += String(value) })
    child.stderr.on('data', value => { output.stderr += String(value) })
    child.stdin.end('protocol=https\nhost=github.com\n\n')
    const code = await new Promise<number | null>(resolve => child.on('close', resolve))
    expect({ code, ...output }).toEqual({ code: 0, stdout: 'protocol=https\nhost=github.com\nusername=agent-bot\npassword=fake-token\n', stderr: '' })
    expect(env).not.toHaveProperty('GH_TOKEN')
    expect(env).not.toHaveProperty('GITHUB_TOKEN')
  })
})

describe('agent git configuration', () => {
  it('ignores the operator\'s global and system git configuration, also after DSH drops credential-shaped variables', async () => {
    const home = join(dir, 'home'); mkdirSync(home)
    // Operator configuration that rewrites HTTPS to SSH, enables commit signing, and sets a credential helper.
    writeFileSync(join(home, '.gitconfig'), '[url "git@github.com:"]\n\tinsteadOf = https://github.com/\n[commit]\n\tgpgsign = true\n[credential]\n\thelper = osxkeychain\n')
    const deployment = testDeployment({ stateDir: dir, github: { ...testDeployment().github!, cli: '/opt/agent tools/gh' } })
    await writeEnvironment(deployment, [])
    // Operator identity variables and git's fallback from the OS username must not apply to worker commits.
    const env = workerEnv({ PATH: process.env.PATH, HOME: home, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.abbrev', GIT_CONFIG_VALUE_0: '12', GIT_AUTHOR_NAME: 'Operator', GIT_COMMITTER_EMAIL: 'operator@example.com', ...agentVariables(dir) })
    const git = async (...args: string[]): Promise<string> => (await exec('git', args, { cwd: dir, env })).stdout.trim()
    await git('init', '-q', 'repo')
    await exec('git', ['-C', 'repo', 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git'], { cwd: dir, env })
    expect(await git('-C', 'repo', 'remote', 'get-url', '--push', 'origin')).toBe('https://github.com/acme/widgets.git')
    const origin = process.platform === 'win32' ? `file:"${workerGitConfig(dir).replaceAll('\\', '\\\\')}"` : `file:${workerGitConfig(dir)}`
    expect(await git('config', '--show-origin', '--get-all', 'credential.https://github.com.helper')).toBe(`${origin}\t${credentialHelper('/opt/agent tools/gh')}`)
    expect(await git('config', '--get-all', 'credential.helper')).toBe('')
    await expect(git('config', 'commit.gpgsign')).rejects.toThrow()
    await expect(git('config', 'core.abbrev')).rejects.toThrow()
    expect(env).not.toHaveProperty('GIT_AUTHOR_NAME')
    expect(env).not.toHaveProperty('GIT_COMMITTER_EMAIL')
    await expect(git('-C', 'repo', 'commit', '--allow-empty', '-q', '-m', 'without identity')).rejects.toMatchObject({ stderr: expect.stringContaining('no email was given') })
    await git('-C', 'repo', '-c', 'user.name=Alice', '-c', 'user.email=alice@example.com', 'commit', '--allow-empty', '-q', '-m', 'with identity')
    expect(await git('-C', 'repo', 'log', '-1', '--format=%an <%ae> / %cn <%ce>')).toBe('Alice <alice@example.com> / Alice <alice@example.com>')
  })
})

itPosix('fails instead of asking the operator\'s askpass helpers when the agent\'s credential helper has no answer', async () => {
  const log = join(dir, 'asked')
  const askpass = program(join(dir, 'askpass'), `echo asked >> ${log}; echo operator-secret`)
  const agent = program(join(dir, 'real', 'gh'), 'exit 0')
  const deployment = testDeployment({ stateDir: dir, github: { ...testDeployment().github!, cli: agent } })
  await writeEnvironment(deployment, [])
  const env = workerEnv({ PATH: process.env.PATH, HOME: dir, GIT_ASKPASS: askpass, SSH_ASKPASS: askpass, ...agentVariables(dir) })
  await exec('git', ['init', '-q', 'repo'], { cwd: dir, env })
  await exec('git', ['-C', 'repo', 'config', 'core.askPass', askpass], { cwd: dir, env })
  const fill = exec('git', ['-C', 'repo', 'credential', 'fill'], { cwd: dir, env, timeout: 10_000 })
  fill.child.stdin?.end('protocol=https\nhost=github.com\n\n')
  await expect(fill).rejects.toMatchObject({ stderr: expect.stringContaining('terminal prompts disabled') })
  expect(() => readFileSync(log, 'utf8')).toThrow()
})

it('removes every spelling of a directory from PATH and keeps the other entries', () => {
  mkdirSync(join(dir, 'state', 'worker-bin'), { recursive: true })
  symlinkSync(join(dir, 'state'), join(dir, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
  const bin = join(dir, 'state', 'worker-bin')
  const separator = process.platform === 'win32' ? ';' : ':'
  const binPath = process.platform === 'win32' ? bin.toUpperCase() : bin
  const path = [`${binPath}${process.platform === 'win32' ? '\\' : '/'}`, join(dir, 'link', 'worker-bin'), process.platform === 'win32' ? 'C:\\Windows\\System32' : '/usr/bin', 'node_modules/.bin'].join(separator)
  expect(withoutDirectory(path, bin)).toBe([process.platform === 'win32' ? 'C:\\Windows\\System32' : '/usr/bin', 'node_modules/.bin'].join(separator))
})

/** Minimal SubprocessRuntime backed by child_process.spawn with an isolated global git config. */
const subprocess = (config: string): SubprocessRuntime => ({
  spawn: ({ argv, cwd }: { argv: readonly string[]; cwd: string }) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd, env: gitEnv({ GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1' }) })
    const output = { stdout: '', stderr: '' }
    child.stdout.on('data', chunk => { output.stdout += String(chunk) })
    child.stderr.on('data', chunk => { output.stderr += String(chunk) })
    const reader = (name: 'stdout' | 'stderr') => ({ readFrom: () => ({ text: output[name], nextOffset: 0, lossy: false }) })
    const done = new Promise(resolve => child.on('close', code => resolve({ exitCode: code, signal: null })))
    return { done, collected: { stdout: reader('stdout'), stderr: reader('stderr') } }
  },
}) as unknown as SubprocessRuntime
describe('ticket directory check', () => {
  const signal = new AbortController().signal
  const env = () => gitEnv({ GIT_CONFIG_GLOBAL: join(dir, 'global'), GIT_CONFIG_NOSYSTEM: '1' })
  const git = (...args: string[]) => exec('git', args, { cwd: dir, env: env() })
  const check = (directory: string) => verifyDirectory(join(dir, directory), subprocess(join(dir, 'global')), signal)
  beforeEach(() => { writeFileSync(join(dir, 'global'), '[credential]\n\thelper = global-helper\n') })
  it('passes a directory whose repository adds no credentials, and one outside any repository', async () => {
    await git('init', '-q', 'repo')
    await expect(check('repo')).resolves.toBeUndefined()
    // When no config key matches at all, git config --get-regexp exits with status 1.
    writeFileSync(join(dir, 'global'), '')
    await expect(check('real')).resolves.toBeUndefined()
  })
  it('names the credential settings of the repository\'s own configuration', async () => {
    await git('init', '-q', 'repo')
    await git('-C', 'repo', 'config', 'http.https://github.com/.extraheader', 'AUTHORIZATION: basic x')
    await expect(check('repo')).rejects.toThrow('sets http.https://github.com/.extraheader')
  })
  it('fails when git cannot read the repository\'s configuration, instead of passing it', async () => {
    await git('init', '-q', 'repo')
    writeFileSync(join(dir, 'repo', '.git', 'config'), '[core\n')
    await expect(check('repo')).rejects.toThrow(/bad config/)
  })
  itPosix('reports a failed command\'s exit status', async () => {
    const failing = ['sh', '-c', 'echo nope >&2; exit 3']
    const error = await runAsWorker(subprocess(join(dir, 'global')), failing, dir, signal).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CliError)
    expect(error).toMatchObject({ message: 'nope', exitCode: 3 })
  })
})

describe('the repository the host\'s environment names', () => {
  it('is left alone by the tests\' git and named in no worker\'s environment, as when they run inside `git rebase --exec`', async () => {
    // A scratch repository stands for the one under test, which `git rebase --exec` names in GIT_DIR and GIT_WORK_TREE.
    await exec('git', ['init', '-q', 'scratch'], { cwd: dir, env: gitEnv() })
    const config = () => readFileSync(join(dir, 'scratch', '.git', 'config'), 'utf8')
    const before = config()
    vi.stubEnv('GIT_DIR', join(dir, 'scratch', '.git')); vi.stubEnv('GIT_WORK_TREE', join(dir, 'scratch'))
    // The operator's limit on git's search for a repository names none, and stays.
    vi.stubEnv('GIT_CEILING_DIRECTORIES', dir)
    try {
      // What the tests do: a repository of their own, checked as a ticket directory.
      await exec('git', ['init', '-q', 'repo'], { cwd: dir, env: gitEnv({ GIT_CONFIG_GLOBAL: join(dir, 'global'), GIT_CONFIG_NOSYSTEM: '1' }) })
      writeFileSync(join(dir, 'global'), '')
      await expect(verifyDirectory(join(dir, 'repo'), subprocess(join(dir, 'global')), new AbortController().signal)).resolves.toBeUndefined()
      expect(readdirSync(join(dir, 'repo'))).toContain('.git')
      expect(config()).toBe(before)
      // The worker environment, which workers' shells and the host's own commands get, names no repository.
      const env = workerEnv({ ...process.env, ...agentVariables(dir) })
      for (const name of GIT_LOCATION) expect(env, name).not.toHaveProperty(name)
      expect(env.GIT_CEILING_DIRECTORIES).toBe(dir)
    } finally { vi.unstubAllEnvs() }
  })
})
