#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_DIR = path.resolve(SCRIPT_DIR, '..')
const DEFAULT_DSH_HOME = path.join(REPO_DIR, '.artifacts', 'linux', 'dsh-home')
const DEFAULT_STATE_DIR = path.join(REPO_DIR, '.artifacts', 'linux', 'state')
const EXAMPLE_PATCH = path.join(REPO_DIR, 'examples', 'profile.linux.cordis.patch.yml')

export function usage() {
  return `Usage: node scripts/setup-linux.mjs [options]

Prepare the Linux personal-mode DSH profile and install this checkout.
Requires Linux, Node.js 24 LTS (24.9.0 or later), pnpm 11, and DSH 0.2.2-rc.1.

Options:
  --profile <name>       DSH profile name (default: superagent)
  --home <path>          Isolated DSH_HOME (default: ${DEFAULT_DSH_HOME})
  --state-dir <path>     Absolute Linux path for persistent state
                         (default: ${DEFAULT_STATE_DIR})
  --port <number>        Loopback webserver port (default: 3082)
  -h, --help             Show this help

The command builds with the repository's frozen pnpm lockfile. It creates a
Web-based profile only when its profile directory is absent. Existing profile
files and an existing cordis.patch.yml are preserved.
`
}

export function parseArgs(argv) {
  const result = { profile: 'superagent', home: DEFAULT_DSH_HOME, stateDir: DEFAULT_STATE_DIR, port: 3082, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') result.help = true
    else if (arg === '--profile' || arg === '--home' || arg === '--state-dir' || arg === '--port') {
      const value = argv[++i]
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value.\n\n${usage()}`)
      if (arg === '--profile') result.profile = value
      else if (arg === '--home') result.home = value
      else if (arg === '--state-dir') result.stateDir = value
      else result.port = Number(value)
    } else {
      throw new Error(`Unknown option: ${arg}\n\n${usage()}`)
    }
  }
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(result.profile)) {
    throw new Error('--profile must be a valid DSH profile name.')
  }
  if (!(path.posix.isAbsolute(result.stateDir) || path.isAbsolute(result.stateDir)) || result.stateDir.includes('\0')) {
    throw new Error('--state-dir must be an absolute path and cannot contain a NUL byte.')
  }
  if (!(path.posix.isAbsolute(result.home) || path.isAbsolute(result.home)) || result.home.includes('\0') || result.home.includes('\n') || result.home.includes('\r')) {
    throw new Error('--home must be an absolute path without line breaks.')
  }
  if (!Number.isSafeInteger(result.port) || result.port < 1 || result.port > 65535) {
    throw new Error('--port must be an integer from 1 through 65535.')
  }
  return result
}

function isEmptyPatch(patch) {
  return patch.split(/\r?\n/).filter(line => line.trim() && !line.trim().startsWith('#')).join('').trim() === '[]'
}

export function ensureProfilePatch({ profileDir, templatePath = EXAMPLE_PATCH, stateDir, port = 3082, createdFromTemplate = false }) {
  const patchPath = path.join(profileDir, 'cordis.patch.yml')
  if (existsSync(patchPath)) {
    const existing = readFileSync(patchPath, 'utf8')
    if (!createdFromTemplate || !isEmptyPatch(existing)) return { created: false, patchPath }
  }
  const template = readFileSync(templatePath, 'utf8')
  let portRows = 0, stateRows = 0
  const patch = template
    .replace(/^(    port: )\d+$/m, (_, prefix) => { portRows += 1; return `${prefix}${JSON.stringify(port)}` })
    .replace(/^(    stateDir: ).*$/m, (_, prefix) => { stateRows += 1; return `${prefix}${JSON.stringify(stateDir)}` })
  if (portRows !== 1 || stateRows !== 1) {
    throw new Error(`The Linux profile example must contain exactly one port and stateDir setting: ${templatePath}`)
  }
  writeFileSync(patchPath, patch, { flag: existsSync(patchPath) ? 'w' : 'wx', mode: 0o600 })
  chmodSync(patchPath, 0o600)
  return { created: true, patchPath }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: REPO_DIR,
    env: { ...process.env, ...(options.env || {}) },
    encoding: 'utf8',
    stdio: options.quiet ? 'pipe' : 'inherit',
    ...options.spawnOptions,
  })
  if (result.error) throw new Error(`Could not run ${command}: ${result.error.message}`)
  if (result.status !== 0) {
    const detail = options.quiet ? result.stderr?.trim() : ''
    throw new Error(`${command} ${args.join(' ')} exited with code ${result.status}${detail ? `: ${detail}` : '.'}`)
  }
  return result.stdout?.trim() ?? ''
}

export function supportsNodeVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!match) return false
  return Number(match[1]) === 24 && Number(match[2]) >= 9
}

function checkPrerequisites() {
  if (process.platform !== 'linux') {
    throw new Error(`This setup command requires Linux; detected ${process.platform}. Use docs/windows.md on Windows.`)
  }
  if (!supportsNodeVersion(process.versions.node)) {
    throw new Error(`Node.js 24 LTS >=24.9.0 is required; detected ${process.versions.node}.`)
  }
  const pnpmVersion = run('pnpm', ['--version'], { quiet: true })
  if (Number(pnpmVersion.split('.')[0]) !== 11) {
    throw new Error(`pnpm 11 is required by this repository; detected ${pnpmVersion}.`)
  }
  const dshVersion = run('dsh', ['--version'], { quiet: true })
  if (dshVersion !== '0.2.2-rc.1') {
    throw new Error(`DSH 0.2.2-rc.1 is required; detected ${dshVersion}.`)
  }
}

export function validateProfilePlugin(profileDir, repositoryDir = REPO_DIR) {
  const packagePath = path.join(profileDir, 'package.json')
  if (!existsSync(packagePath)) return false
  const manifest = JSON.parse(readFileSync(packagePath, 'utf8'))
  const dependency = ['dependencies', 'devDependencies', 'optionalDependencies']
    .map(section => manifest[section]?.['dsh-superagent'])
    .find(value => typeof value === 'string')
  if (dependency === undefined) return false
  if (dependency.startsWith('link:') && path.resolve(profileDir, dependency.slice('link:'.length)) === path.resolve(repositoryDir)) return true
  throw new Error(`Profile ${profileDir} already declares dsh-superagent as ${JSON.stringify(dependency)}. Review that dependency and point it to link:${repositoryDir} before rerunning setup.`)
}

function createPrivateDirectory(directory) {
  if (existsSync(directory)) return
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  chmodSync(directory, 0o700)
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`
}

export function launchInstructions(options, createdPatch) {
  const start = `\nPreparation complete. Start with:\n  export DSH_HOME=${shellQuote(options.home)}\n  dsh --profile ${options.profile} --no-open\n`
  if (!createdPatch) return start + 'Use the URL printed by DSH; the existing profile keeps its configured port.\n'
    + `For managed startup, pass that URL to scripts/dsh-superagent start --profile ${options.profile} --url.\n`
  const url = `http://127.0.0.1:${options.port}`
  return start + `For managed startup and health checks, run:\n  scripts/dsh-superagent start --profile ${options.profile} --url ${url}\n`
    + `Open ${url} and configure a model provider in the DSH profile.\n`
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  if (options.help) {
    process.stdout.write(usage())
    return 0
  }
  checkPrerequisites()

  run('pnpm', ['install', '--frozen-lockfile'])
  run('pnpm', ['build'])

  createPrivateDirectory(options.home)
  createPrivateDirectory(options.stateDir)
  const profileDir = path.join(options.home, 'profiles', options.profile)
  const dshEnv = { DSH_HOME: options.home }
  const profileWasPresent = existsSync(profileDir)
  if (!profileWasPresent) {
    run('dsh', [options.profile, '--from-default-profile', 'web', '--dump-config'], { quiet: true, env: dshEnv })
    if (!existsSync(profileDir)) throw new Error(`DSH did not create the expected profile directory: ${profileDir}`)
    process.stdout.write(`Created DSH profile '${options.profile}' from the Web template.\n`)
  } else {
    process.stdout.write(`Using existing DSH profile '${options.profile}'; its profile files are preserved.\n`)
  }

  const patch = ensureProfilePatch({ profileDir, stateDir: options.stateDir, port: options.port, createdFromTemplate: !profileWasPresent })
  process.stdout.write(patch.created
    ? `Created ${patch.patchPath} with stateDir ${options.stateDir}.\n`
    : `Preserved existing ${patch.patchPath}; verify its stateDir and webserver port (requested port: ${options.port}).\n`)

  if (validateProfilePlugin(profileDir)) {
    process.stdout.write('Profile already declares dsh-superagent; leaving its package manifest unchanged.\n')
  } else {
    run('dsh', ['plugin', '--profile', options.profile, 'add', `link:${REPO_DIR}`], { env: dshEnv })
  }

  process.stdout.write(launchInstructions(options, patch.created))
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.exitCode = await main()
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
}
