import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
const { ensureProfilePatch, parseArgs, validateProfilePlugin, launchInstructions } = await import(new URL('../scripts/setup-linux.mjs', import.meta.url).href)

const temporaryDirectories: string[] = []

function temporaryDirectory() {
  const home = mkdtempSync(path.join(os.tmpdir(), 'dsh-linux-setup-'))
  const directory = path.join(home, 'profiles', 'superagent')
  mkdirSync(directory, { recursive: true })
  temporaryDirectories.push(home)
  return directory
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('Linux setup argument parsing', () => {
  it('prints the selected profile and port for a new profile and defers to preserved settings on reruns', () => {
    const options = parseArgs(['--profile', 'linux-personal', '--port', '13082'])
    expect(launchInstructions(options, true)).toContain('start --profile linux-personal --url http://127.0.0.1:13082')
    expect(launchInstructions(options, false)).not.toContain('http://127.0.0.1:13082')
    expect(launchInstructions(options, false)).toContain('existing profile keeps its configured port')
  })
  it('uses personal profile defaults and accepts an absolute persistent state directory', () => {
    const options = parseArgs(['--state-dir', '/srv/dsh/superagent/a: b# "quoted"'])
    expect(options.profile).toBe('superagent')
    expect(options.stateDir).toBe('/srv/dsh/superagent/a: b# "quoted"')
    expect(options.port).toBe(3082)
  })

  it('accepts a valid custom webserver port and rejects values outside the TCP port range', () => {
    expect(parseArgs(['--port', '13082']).port).toBe(13082)
    for (const port of ['0', '65536', '3.5', 'NaN']) expect(() => parseArgs(['--port', port])).toThrow(/integer from 1 through 65535/)
  })

  it('rejects unknown options, invalid profile names, and relative state directories', () => {
    expect(() => parseArgs(['--force'])).toThrow(/Unknown option/)
    expect(() => parseArgs(['--profile', '../other'])).toThrow(/profile name/)
    expect(() => parseArgs(['--state-dir', 'state'])).toThrow(/absolute path/)
    expect(() => parseArgs(['--state-dir', '/srv/state\0invalid'])).toThrow(/NUL byte/)
  })
})

describe('Linux profile patch creation', () => {
  it('writes Linux loopback settings and substitutes the selected state directory and port', () => {
    const directory = temporaryDirectory()
    const template = path.resolve('examples/profile.linux.cordis.patch.yml')
    const stateDir = '/srv/dsh/superagent/a: b# "quoted"'
    const result = ensureProfilePatch({ profileDir: directory, templatePath: template, stateDir, port: 13082 })
    const patch = readFileSync(result.patchPath, 'utf8')
    expect(result.created).toBe(true)
    expect(patch).toContain('mode: personal')
    expect(patch).toContain('host: 127.0.0.1')
    expect(patch).toContain('port: 13082')
    expect(patch).toContain(`stateDir: ${JSON.stringify(stateDir)}`)
  })

  it('replaces only DSH’s blank patch when bootstrapping a fresh Web profile', () => {
    const directory = temporaryDirectory()
    const patchPath = path.join(directory, 'cordis.patch.yml')
    writeFileSync(patchPath, '# DSH default user patch\n[]\n')
    const result = ensureProfilePatch({ profileDir: directory, stateDir: '/srv/state', createdFromTemplate: true })
    const patch = readFileSync(patchPath, 'utf8')
    expect(result.created).toBe(true)
    expect(patch).toContain('mode: personal')
    expect(patch).toContain('stateDir: "/srv/state"')
  })

  it('preserves an existing profile patch byte for byte', () => {
    const directory = temporaryDirectory()
    const patchPath = path.join(directory, 'cordis.patch.yml')
    mkdirSync(directory, { recursive: true })
    writeFileSync(patchPath, '- id: provider\n  config: { apiKey: keep-me }\n')
    const before = readFileSync(patchPath, 'utf8')
    const result = ensureProfilePatch({ profileDir: directory, stateDir: '/srv/ignored' })
    expect(result.created).toBe(false)
    expect(readFileSync(patchPath, 'utf8')).toBe(before)
  })

  it('preserves an existing profile port when a different port is requested', () => {
    const directory = temporaryDirectory()
    const patchPath = path.join(directory, 'cordis.patch.yml')
    writeFileSync(patchPath, '- id: webserver\n  config: { host: 127.0.0.1, port: 3082 }\n')
    const result = ensureProfilePatch({ profileDir: directory, stateDir: '/srv/state', port: 13082 })
    expect(result.created).toBe(false)
    expect(readFileSync(patchPath, 'utf8')).toContain('port: 3082')
  })
})

describe('profile plugin dependency', () => {
  it('accepts the local checkout link and reports other declared versions as conflicts', () => {
    const directory = temporaryDirectory()
    const repository = path.resolve('checkout')
    const packagePath = path.join(directory, 'package.json')
    writeFileSync(packagePath, JSON.stringify({ dependencies: { 'dsh-superagent': `link:${repository}` } }))
    expect(validateProfilePlugin(directory, repository)).toBe(true)
    writeFileSync(packagePath, JSON.stringify({ dependencies: { 'dsh-superagent': '1.2.3' } }))
    expect(() => validateProfilePlugin(directory, repository)).toThrow(/Review that dependency/)
  })
})
