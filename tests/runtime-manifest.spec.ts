import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { Store, SCHEMA_VERSION } from '../src/app/store.ts'
import { packagePath } from '../src/infra/paths.ts'
import { exportSqliteSnapshot, inspectRuntimeState, recordRuntimeManifest, runtimeBuildIdentity, runtimeConfigHash, runtimeManifestState, RUNTIME_STATE_SCHEMA } from '../src/app/runtime-manifest.ts'

const directories: string[] = [], stores: Store[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
function fixture() {
  const path = mkdtempSync(join(tmpdir(), 'runtime-manifest-')); directories.push(path)
  const stateDir = join(path, 'state'), database = join(stateDir, 'orchestrator.sqlite'), store = new Store(database); stores.push(store)
  const entryPath = join(path, 'build', 'index.js'); mkdirSync(dirname(entryPath), { recursive: true }); writeFileSync(entryPath, 'export const runtime = 1\n')
  const packageFile = join(path, 'package.json'); writeFileSync(packageFile, JSON.stringify({ name: 'dsh-superagent', version: '1.2.3-test.1' }))
  return { path, stateDir, database, store, entryPath, packageFile }
}
const configuration = { machine: { mode: 'personal' }, settings: { paused: false, sources: { qq: { enabled: true, config: { token: 'private-token-original', url: 'https://private.example.invalid' } } },
  eval: { mode: 'observe' }, executor: { maxWorkers: 3 }, policy: { rules: [{ id: 'copy' }] } } }

it('records actual package/runtime versions and configuration digests with no credential text', () => {
  const f = fixture(), actual = JSON.parse(readFileSync(packagePath('package.json'), 'utf8'))
  const manifest = recordRuntimeManifest(f.store, { config: configuration, phase: 'ready', runId: 'run-1', entryPath: f.entryPath })
  expect(manifest.package.version).toBe(actual.version)
  expect(manifest.schema).toBe(SCHEMA_VERSION); expect(RUNTIME_STATE_SCHEMA).toBe(SCHEMA_VERSION)
  expect(manifest.runtime).toEqual({ node: process.versions.node, platform: process.platform, architecture: process.arch })
  expect(manifest.config.summary).toMatchObject({ mode: 'personal', sourceCount: 1, enabledSourceCount: 1, ruleCount: 1, maxWorkers: 3, paused: false })
  expect(manifest.config.sha256).toMatch(/^[a-f0-9]{64}$/)
  const serialized = JSON.stringify(runtimeManifestState(f.store))
  expect(serialized).not.toContain('private-token-original'); expect(serialized).not.toContain('private.example.invalid')
  expect(serialized).not.toContain('credentialRef')
  expect(runtimeConfigHash({ b: 2, a: 1 })).toBe(runtimeConfigHash({ a: 1, b: 2 }))
  expect(runtimeConfigHash({ token: 'changed' })).not.toBe(runtimeConfigHash({ token: 'original' }))
})

it('tracks startup/config/build revisions while preserving the previous usable version through failure', () => {
  const f = fixture(), common = { config: configuration, runId: 'run-1', entryPath: f.entryPath, packageFile: f.packageFile }
  const first = recordRuntimeManifest(f.store, { ...common, phase: 'starting' })
  expect(runtimeManifestState(f.store).lastGood).toBeUndefined()
  const ready = recordRuntimeManifest(f.store, { ...common, phase: 'ready' })
  expect(ready.id).toBe(first.id); expect(ready.revision).toBe(1)
  const changed = recordRuntimeManifest(f.store, { ...common, config: { ...configuration, extra: true }, phase: 'failed' })
  expect(changed.revision).toBe(2); expect(changed.previousGoodId).toBe(ready.id)
  expect(runtimeManifestState(f.store)).toMatchObject({ current: { id: changed.id, phase: 'failed' }, lastGood: { id: ready.id, phase: 'ready' }, previousGood: { id: ready.id } })
  const restarted = recordRuntimeManifest(f.store, { ...common, runId: 'run-2', phase: 'ready' })
  expect(restarted.revision).toBe(3); expect(restarted.previousGoodId).toBe(ready.id)
  writeFileSync(join(dirname(f.entryPath), 'chunk.js'), 'export const dependency = 2\n')
  const rebuilt = recordRuntimeManifest(f.store, { ...common, runId: 'run-2', phase: 'starting' })
  expect(rebuilt.build.id).not.toBe(restarted.build.id)
  expect(runtimeManifestState(f.store).lastGood?.id).toBe(restarted.id)
})

it('fingerprints imported source bytes and split compiled chunks', () => {
  const f = fixture(), source = join(f.path, 'src', 'app', 'runtime.ts'), dependency = join(f.path, 'src', 'other.ts')
  mkdirSync(dirname(source), { recursive: true }); writeFileSync(source, 'export const main = 1\n'); writeFileSync(dependency, 'export const other = 1\n')
  const before = runtimeBuildIdentity({ packageFile: f.packageFile, entryPath: source })
  writeFileSync(dependency, 'export const other = 2\n')
  const after = runtimeBuildIdentity({ packageFile: f.packageFile, entryPath: source })
  expect(after.build.id).not.toBe(before.build.id); expect(after.build.kind).toBe('source'); expect(after.build.fileCount).toBe(2)
})

it.each(['source', 'compiled'] as const)('fingerprints packaged behavior resources deterministically in a %s layout', kind => {
  const first = fixture(), second = fixture()
  const assets = [
    ['prompts/shared.md', 'Follow the task criteria.'],
    ['prompts/personal/worker.md', 'Preserve the original request.'],
    ['skills/example/SKILL.md', 'Read the actual file.'],
    ['locale/zh-CN.json', '{"ready":"就绪"}'],
    ['cordis.patch.yml', '- insert: []'],
  ] as const
  const options = (f: ReturnType<typeof fixture>) => {
    const entryPath = kind === 'source' ? join(f.path, 'src', 'app', 'runtime.ts') : f.entryPath
    if (kind === 'source') { mkdirSync(dirname(entryPath), { recursive: true }); writeFileSync(entryPath, 'export const runtime = 1\n') }
    return { entryPath, packageFile: f.packageFile }
  }
  const firstOptions = options(first), secondOptions = options(second)
  const writeAsset = (f: ReturnType<typeof fixture>, name: string, bytes: string) => {
    const path = join(f.path, name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes)
  }
  for (const [name, bytes] of assets) writeAsset(first, name, bytes)
  for (const [name, bytes] of [...assets].reverse()) writeAsset(second, name, bytes)
  const original = runtimeBuildIdentity(firstOptions)
  expect(original.build.kind).toBe(kind); expect(original.build.fileCount).toBe(6)
  expect(runtimeBuildIdentity(secondOptions).build.id).toBe(original.build.id)
  for (const [name, bytes] of assets) {
    writeAsset(first, name, `${bytes}\nchanged`)
    expect(runtimeBuildIdentity(firstOptions).build.id, name).not.toBe(original.build.id)
    writeAsset(first, name, bytes)
  }
  writeAsset(first, 'skills/example/references/extra.txt', 'Additional behavior guidance.')
  expect(runtimeBuildIdentity(firstOptions).build.id).not.toBe(original.build.id)
  rmSync(join(first.path, 'skills/example/references'), { recursive: true })
  expect(runtimeBuildIdentity(firstOptions).build.id).toBe(original.build.id)
  rmSync(join(first.path, 'cordis.patch.yml'))
  expect(runtimeBuildIdentity(firstOptions).build.id).not.toBe(original.build.id)
  writeAsset(first, 'cordis.patch.yml', assets.at(-1)![1])
  for (const name of ['.env', 'profile/cordis.patch.yml', 'state/credentials.json', 'README.md']) writeAsset(first, name, 'private-profile-token')
  expect(runtimeBuildIdentity(firstOptions).build.id).toBe(original.build.id)
  expect(JSON.stringify(runtimeBuildIdentity(firstOptions))).not.toContain('private-profile-token')
})

it('can pin loaded build identity during configuration updates and retains referenced last-good history', () => {
  const f = fixture(), identity = runtimeBuildIdentity({ packageFile: f.packageFile, entryPath: f.entryPath })
  const ready = recordRuntimeManifest(f.store, { config: { revision: 0 }, phase: 'ready', runId: 'loaded-code', identity })
  writeFileSync(f.entryPath, 'export const runtime = "candidate on disk"\n')
  for (let revision = 1; revision <= 60; revision++) recordRuntimeManifest(f.store, { config: { revision }, phase: 'starting', runId: 'loaded-code', identity })
  const state = runtimeManifestState(f.store, { limit: 100 })
  expect(state.current?.build.id).toBe(identity.build.id)
  expect(state.lastGood?.id).toBe(ready.id)
  expect(state.previousGood?.id).toBe(ready.id)
  expect(state.history.length).toBeLessThanOrEqual(52)
  expect(state.history.some(item => item.id === ready.id)).toBe(true)
  const restarted = recordRuntimeManifest(f.store, { config: { revision: 60 }, phase: 'starting', runId: 'new-runtime', packageFile: f.packageFile, entryPath: f.entryPath })
  expect(restarted.build.id).not.toBe(identity.build.id)
})

it('preflights read-only with schema/manifest checks and accurate active/held counts', () => {
  const f = fixture(), input = { config: configuration, phase: 'ready' as const, runId: 'run', entryPath: f.entryPath, packageFile: f.packageFile }
  recordRuntimeManifest(f.store, input)
  const insert = f.store.db.prepare('INSERT INTO ticket(id,value) VALUES (?,?)')
  for (const [id, value] of [ ['active', { assignments: [{ state: 'running' }] }], ['queued', { assignments: [{ state: 'pending' }] }],
    ['held', { hold: { kind: 'environment' }, assignments: [{ state: 'ended' }] }], ['idle', { assignments: [{ state: 'ended' }] }], ['done', { ended: { outcome: 'completed' }, assignments: [] }] ] as const)
    insert.run(id, JSON.stringify({ id, ...value }))
  f.store.set('remote-command:unknown', { state: 'unknown' }); f.store.set('remote-command:resolved', { state: 'unknown', ownerResolution: { outcome: 'completed' } })
  const before = readFileSync(f.database)
  expect(inspectRuntimeState({ ...f, expectedConfigHash: runtimeConfigHash(configuration) })).toMatchObject({ status: 'ready', exitCode: 0, quickCheck: 'ok',
    tasks: { total: 5, open: 4, active: 2, held: 1, unknownRemote: 1 }, schema: { found: 13, compatible: true, requiresUpgrade: false } })
  expect(readFileSync(f.database)).toEqual(before)
  expect(f.store.get('schema')).toBe(13)
  expect(inspectRuntimeState({ ...f, expectedConfigHash: 'different' }).issues).toContain('runtime_config_changed')
  writeFileSync(f.entryPath, 'export const runtime = 9\n')
  expect(inspectRuntimeState(f)).toMatchObject({ status: 'attention', exitCode: 2, issues: ['runtime_build_changed'] })
})

it('keeps schema 12 intact during inspection, upgrades additively to 13 and rejects future/unsupported schemas', () => {
  const f = fixture(); f.store.set('schema', 12); f.store.set('preserved-state', { value: 'keep' })
  expect(inspectRuntimeState(f)).toMatchObject({ status: 'upgrade_required', exitCode: 2, schema: { found: 12, supported: 13 } })
  expect(f.store.get('schema')).toBe(12)
  f.store.close(); stores.splice(stores.indexOf(f.store), 1)
  const upgraded = new Store(f.database); stores.push(upgraded)
  expect(upgraded.get('schema')).toBe(13); expect(upgraded.get('preserved-state')).toEqual({ value: 'keep' })
  upgraded.set('schema', 14)
  expect(inspectRuntimeState(f)).toMatchObject({ status: 'incompatible', exitCode: 3, schema: { found: 14, compatible: false } })
  expect(() => new Store(f.database)).toThrow('Unsupported')
  upgraded.set('schema', 9)
  expect(inspectRuntimeState(f)).toMatchObject({ status: 'incompatible', exitCode: 3 })
})

it('exports a real read-only SQLite snapshot with explicit external Session/artifact coverage', async () => {
  const f = fixture(), destination = join(f.path, 'backup', 'orchestrator.sqlite')
  f.store.set('preserved-outbox', { receipt: 'sent' }); f.store.set('session-location', '/external/dsh/session')
  const exported = await exportSqliteSnapshot({ databasePath: f.database, destination })
  expect(exported).toMatchObject({ kind: 'sqlite-only', destination })
  expect(exported.bytes).toBeGreaterThan(0); expect(exported.sha256).toMatch(/^[a-f0-9]{64}$/)
  expect(exported.separate).toContain('DSH Session persistence'); expect(exported.separate).toContain('artifact bytes')
  const restored = new DatabaseSync(destination, { readOnly: true })
  try { expect(JSON.parse(String(restored.prepare('SELECT value FROM kv WHERE key=?').get('preserved-outbox')?.value))).toEqual({ receipt: 'sent' }) }
  finally { restored.close() }
  expect(f.store.get('preserved-outbox')).toEqual({ receipt: 'sent' })
  await expect(exportSqliteSnapshot({ databasePath: f.database, destination })).rejects.toThrow()
  await expect(exportSqliteSnapshot({ databasePath: f.database, destination: f.database })).rejects.toThrow('fresh')
})

it('runs the preflight and SQLite-only export as an independent CLI with useful exit codes', async () => {
  const f = fixture(), destination = join(f.path, 'cli-snapshot.sqlite')
  recordRuntimeManifest(f.store, { config: configuration, phase: 'ready', runId: 'cli', entryPath: f.entryPath })
  const run = async (extra: string[] = []) => {
    const child = spawn(process.execPath, [resolve('scripts/superagent-preflight.mjs'), '--state-dir', f.stateDir, '--entry', f.entryPath, ...extra], { windowsHide: true })
    let output = ''; child.stdout.on('data', chunk => { output += String(chunk) })
    const [code] = await once(child, 'close'); return { code, value: JSON.parse(output) }
  }
  const healthy = await run(['--export-sqlite', destination])
  expect(healthy.code).toBe(0); expect(healthy.value).toMatchObject({ status: 'ready', snapshot: { kind: 'sqlite-only', destination } })
  f.store.set('schema', 14)
  expect(await run()).toMatchObject({ code: 3, value: { status: 'incompatible' } })
}, 15_000)
