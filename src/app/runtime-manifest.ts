/** Runtime/build provenance, non-secret configuration fingerprints and read-only upgrade preflight. */
import { createHash, randomUUID } from 'node:crypto'
import { backup, DatabaseSync } from 'node:sqlite'
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { packagePath } from '../infra/paths.ts'
import { record } from '../kv.ts'
import type { Store } from './store.ts'
import { ENVIRONMENT_PROTOCOL } from '../remote/protocol.ts'

export const RUNTIME_MANIFEST_FORMAT = 1, RUNTIME_STATE_SCHEMA = 13, RUNTIME_OLDEST_SCHEMA = 10
const CURRENT = record<RuntimeManifest>('runtime-manifest-current'), GOOD = record<RuntimeManifest>('runtime-manifest-last-good')
const HISTORY = 'runtime-manifest-history:', DEFAULT_RUN = randomUUID()
const protocols = { environment: ENVIRONMENT_PROTOCOL, supervision: 1, verification: 1 }
type ManifestStore = Pick<Store, 'get' | 'set' | 'keys' | 'delete' | 'atomic'>
type ManifestReader = Pick<Store, 'get' | 'keys'>
export interface RuntimeBuild {
  id: string; kind: 'source' | 'compiled'; entry: string; fileCount: number; packageSha256: string
}
export interface RuntimeManifest {
  format: 1; id: string; revision: number; runId: string; recordedAt: string; updatedAt: string
  phase: 'starting' | 'ready' | 'failed'; readyAt?: string; previousGoodId?: string
  package: { name: string; version: string }
  schema: number; build: RuntimeBuild; protocols: typeof protocols
  runtime: { node: string; platform: string; architecture: string }
  config: { sha256: string; summary: Record<string, number | boolean | string> }
}
export interface RuntimeManifestInput {
  config: unknown; phase: RuntimeManifest['phase']; runId?: string; entryPath?: string; packageFile?: string; now?: Date
  /** Capture once per Runtime construction so later disk updates are not attributed to already-loaded code. */
  identity?: ReturnType<typeof runtimeBuildIdentity>
}
export interface RuntimePreflight {
  status: 'ready' | 'attention' | 'upgrade_required' | 'incompatible' | 'error'
  exitCode: 0 | 2 | 3; database: string; quickCheck?: string
  schema?: { found: number; supported: number; oldest: number; compatible: boolean; requiresUpgrade: boolean }
  expected?: { packageVersion: string; buildId: string; protocols: typeof protocols }
  manifest?: RuntimeManifest; lastGood?: RuntimeManifest; issues: string[]
  tasks: { total: number; open: number; active: number; held: number; unknownRemote: number }
}
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
const historyKey = (revision: number) => record<RuntimeManifest>(`${HISTORY}${String(revision).padStart(12, '0')}`)
const plain = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
function canonical(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'undefined') return null
  if (typeof value !== 'object' || seen.has(value)) throw new Error('Runtime configuration must be JSON serializable')
  seen.add(value)
  const result = Array.isArray(value) ? value.map(item => canonical(item, seen))
    : Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item, seen)]))
  seen.delete(value)
  return result
}
export function runtimeConfigHash(config: unknown): string { return hash(JSON.stringify(canonical(config))) }
function configSummary(config: unknown): Record<string, number | boolean | string> {
  const root = plain(config), settings = plain(root.settings ?? root), machine = plain(root.machine), sources = plain(settings.sources)
  const policy = plain(settings.policy), executor = plain(settings.executor), evaluation = plain(settings.eval)
  const summary: Record<string, number | boolean | string> = { sourceCount: Object.keys(sources).length,
    enabledSourceCount: Object.values(sources).filter(source => plain(source).enabled !== false).length,
    ruleCount: Array.isArray(policy.rules) ? policy.rules.length : 0 }
  if (typeof settings.paused === 'boolean') summary.paused = settings.paused
  if (Number.isInteger(executor.maxWorkers) && Number(executor.maxWorkers) >= 0) summary.maxWorkers = Number(executor.maxWorkers)
  if (['off', 'observe', 'auto'].includes(String(evaluation.mode))) summary.evalMode = String(evaluation.mode)
  if (['personal', 'repository'].includes(String(machine.mode ?? root.mode))) summary.mode = String(machine.mode ?? root.mode)
  return summary
}

/** Fingerprints packaged code and behavior resources; profile directories are deliberately outside this allowlist. */
export function runtimeBuildIdentity(options: { entryPath?: string; packageFile?: string } = {}) {
  const packageFile = resolve(options.packageFile ?? packagePath('package.json')), root = dirname(packageFile)
  const packageBytes = readFileSync(packageFile), metadata = JSON.parse(packageBytes.toString('utf8')) as { name?: string; version?: string }
  if (typeof metadata.name !== 'string' || typeof metadata.version !== 'string' || !/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,79}$/.test(metadata.version)) throw new Error('Runtime package version is missing or invalid')
  const entryPath = resolve(options.entryPath ?? (existsSync(join(root, 'lib', 'index.js')) ? join(root, 'lib', 'index.js') : join(root, 'src', 'app', 'runtime.ts')))
  if (!existsSync(entryPath)) throw new Error('Runtime entry is missing; build the selected package before startup')
  const kind = ['.ts', '.tsx', '.mts'].includes(extname(entryPath)) ? 'source' as const : 'compiled' as const
  const directory = kind === 'source' && existsSync(join(root, 'src')) ? join(root, 'src') : dirname(entryPath)
  const files = new Map<string, string>()
  const walk = (path: string, base: string, namespace: string, accept: (name: string) => boolean) => {
    for (const item of readdirSync(path, { withFileTypes: true })) {
      if (item.isSymbolicLink()) continue
      const next = join(path, item.name)
      if (item.isDirectory() && item.name !== 'node_modules') walk(next, base, namespace, accept)
      else if (item.isFile() && accept(item.name)) files.set(`${namespace}/${relative(base, next).replaceAll('\\', '/')}`, next)
    }
  }
  walk(directory, directory, 'code', name => /\.(?:[cm]?js|[cm]?ts|tsx)$/.test(name) && !/\.d\.[cm]?ts$/.test(name))
  files.set(`code/${relative(directory, entryPath).replaceAll('\\', '/')}`, entryPath)
  for (const name of ['prompts', 'skills', 'locale']) {
    const path = join(root, name)
    if (existsSync(path) && lstatSync(path).isDirectory()) walk(path, root, 'resources', () => true)
  }
  const patch = join(root, 'cordis.patch.yml')
  if (existsSync(patch) && lstatSync(patch).isFile()) files.set('resources/cordis.patch.yml', patch)
  const aggregate = createHash('sha256').update(packageBytes).update(JSON.stringify({ schema: RUNTIME_STATE_SCHEMA, protocols }))
  for (const [name, path] of [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const bytes = readFileSync(path); aggregate.update(name).update('\0').update(String(bytes.length)).update('\0').update(bytes)
  }
  const build: RuntimeBuild = { id: aggregate.digest('hex'), kind, entry: relative(root, entryPath).replaceAll('\\', '/'), fileCount: files.size, packageSha256: hash(packageBytes) }
  return { package: { name: metadata.name, version: metadata.version }, build, protocols: { ...protocols } }
}

/** Record only a digest and allowlisted counts/enums from configuration; credentials never enter the manifest. */
export function recordRuntimeManifest(store: ManifestStore, input: RuntimeManifestInput): RuntimeManifest {
  if (store.get<number>('schema') !== RUNTIME_STATE_SCHEMA) throw new Error('Runtime manifest requires the current state schema')
  const identity = input.identity ?? runtimeBuildIdentity(input), config = { sha256: runtimeConfigHash(input.config), summary: configSummary(input.config) }
  const runId = input.runId ?? DEFAULT_RUN, at = (input.now ?? new Date()).toISOString()
  return store.atomic(() => {
    const previous = store.get(CURRENT), lastGood = store.get(GOOD)
    const same = previous?.runId === runId && previous.build.id === identity.build.id && previous.config.sha256 === config.sha256
      && previous.schema === RUNTIME_STATE_SCHEMA && previous.runtime.node === process.versions.node && previous.runtime.platform === process.platform && previous.runtime.architecture === process.arch
    const revision = same ? previous.revision : (previous?.revision ?? 0) + 1
    const previousGoodId = same ? previous.previousGoodId : lastGood?.id
    const manifest: RuntimeManifest = { format: RUNTIME_MANIFEST_FORMAT,
      id: same ? previous.id : hash(JSON.stringify([identity.build.id, config.sha256, runId, revision])), revision, runId,
      recordedAt: same ? previous.recordedAt : at, updatedAt: at, phase: input.phase,
      ...(input.phase === 'ready' ? { readyAt: same && previous.readyAt ? previous.readyAt : at } : {}),
      ...(previousGoodId ? { previousGoodId } : {}), ...identity, schema: RUNTIME_STATE_SCHEMA,
      runtime: { node: process.versions.node, platform: process.platform, architecture: process.arch }, config }
    store.set(CURRENT, manifest); store.set(historyKey(revision), manifest)
    if (input.phase === 'ready') store.set(GOOD, manifest)
    const protectedIds = new Set([manifest.id, manifest.previousGoodId, store.get(GOOD)?.id])
    const history = store.keys(HISTORY).sort().reverse()
    for (const key of history.slice(50)) if (!protectedIds.has(store.get<RuntimeManifest>(key)?.id)) store.delete(key)
    return manifest
  })
}

export function runtimeManifestState(store: ManifestReader, options: { limit?: number } = {}) {
  const current = store.get(CURRENT), lastGood = store.get(GOOD)
  const history = store.keys(HISTORY).map(key => store.get<RuntimeManifest>(key)).filter((item): item is RuntimeManifest => !!item)
    .sort((a, b) => b.revision - a.revision)
  return { current, lastGood, previousGood: current?.previousGoodId ? history.find(item => item.id === current.previousGoodId) : undefined,
    history: history.slice(0, Math.max(1, Math.min(100, options.limit ?? 20))) }
}

/** Opens the source database read-only and never imports Store or executes migrations. */
export function inspectRuntimeState(options: { stateDir: string; databasePath?: string; entryPath?: string; packageFile?: string; expectedConfigHash?: string }): RuntimePreflight {
  const database = resolve(options.databasePath ?? join(options.stateDir, 'orchestrator.sqlite'))
  const result: RuntimePreflight = { status: 'ready', exitCode: 0, database, issues: [], tasks: { total: 0, open: 0, active: 0, held: 0, unknownRemote: 0 } }
  if (!existsSync(database)) return { ...result, status: 'attention', exitCode: 2, issues: ['state_database_missing'] }
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(database, { readOnly: true })
    result.quickCheck = String(Object.values(db.prepare('PRAGMA quick_check').get() ?? {})[0] ?? 'missing')
    if (result.quickCheck !== 'ok') return { ...result, status: 'error', exitCode: 3, issues: ['state_integrity_failed'] }
    const read = <T>(key: string): T | undefined => { const row = db!.prepare('SELECT value FROM kv WHERE key=?').get(key); return row ? JSON.parse(String(row.value)) as T : undefined }
    const found = read<number>('schema')
    if (!Number.isInteger(found)) return { ...result, status: 'error', exitCode: 3, issues: ['state_schema_missing'] }
    const compatible = found! >= RUNTIME_OLDEST_SCHEMA && found! <= RUNTIME_STATE_SCHEMA
    result.schema = { found: found!, supported: RUNTIME_STATE_SCHEMA, oldest: RUNTIME_OLDEST_SCHEMA, compatible, requiresUpgrade: compatible && found! < RUNTIME_STATE_SCHEMA }
    if (!compatible) return { ...result, status: 'incompatible', exitCode: 3, issues: ['state_schema_incompatible'] }
    const expected = runtimeBuildIdentity(options)
    result.expected = { packageVersion: expected.package.version, buildId: expected.build.id, protocols: expected.protocols }
    result.manifest = read<RuntimeManifest>(CURRENT); result.lastGood = read<RuntimeManifest>(GOOD)
    if (result.manifest) {
      if (result.manifest.format !== RUNTIME_MANIFEST_FORMAT || result.manifest.schema !== found) result.issues.push('manifest_schema_mismatch')
      if (result.manifest.package.version !== expected.package.version) result.issues.push('package_version_changed')
      if (result.manifest.build.id !== expected.build.id) result.issues.push('runtime_build_changed')
      if (JSON.stringify(result.manifest.protocols) !== JSON.stringify(expected.protocols)) result.issues.push('runtime_protocol_changed')
      if (options.expectedConfigHash && options.expectedConfigHash !== result.manifest.config.sha256) result.issues.push('runtime_config_changed')
      if (result.manifest.phase !== 'ready') result.issues.push(`last_runtime_${result.manifest.phase}`)
    } else result.issues.push('runtime_manifest_missing')
    const hasTickets = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ticket'").get()
    if (hasTickets) {
      const row = db.prepare(`SELECT COUNT(*) AS total,
        SUM(CASE WHEN json_extract(value,'$.ended') IS NULL THEN 1 ELSE 0 END) AS open,
        SUM(CASE WHEN json_extract(value,'$.ended') IS NULL AND json_extract(value,'$.hold') IS NULL AND json_extract(value,'$.assignments[#-1].state') IN ('pending','running') THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN json_extract(value,'$.ended') IS NULL AND json_extract(value,'$.hold') IS NOT NULL THEN 1 ELSE 0 END) AS held FROM ticket`).get()!
      for (const key of ['total', 'open', 'active', 'held'] as const) result.tasks[key] = Number(row[key] ?? 0)
    }
    result.tasks.unknownRemote = Number(db.prepare("SELECT COUNT(*) AS count FROM kv WHERE key LIKE 'remote-command:%' AND json_extract(value,'$.state')='unknown' AND json_extract(value,'$.ownerResolution') IS NULL").get()?.count ?? 0)
    if (result.schema.requiresUpgrade) { result.issues.push('state_upgrade_required'); result.status = 'upgrade_required'; result.exitCode = 2 }
    else if (result.issues.length) { result.status = 'attention'; result.exitCode = 2 }
    return result
  } catch { return { ...result, status: 'error', exitCode: 3, issues: [...result.issues, 'state_preflight_failed'] } }
  finally { db?.close() }
}

/** Consistent SQLite-only export from a read-only connection; sessions, artifacts and workspaces are separate. */
export async function exportSqliteSnapshot(options: { databasePath: string; destination: string }) {
  const source = resolve(options.databasePath), destination = resolve(options.destination)
  if (source === destination) throw new Error('Choose a fresh snapshot path outside the source database')
  if (!existsSync(source)) throw new Error('Source state database is missing')
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
  const reservation = openSync(destination, 'wx', 0o600); closeSync(reservation)
  const db = new DatabaseSync(source, { readOnly: true })
  try {
    if (String(Object.values(db.prepare('PRAGMA quick_check').get() ?? {})[0]) !== 'ok') throw new Error('Source state database integrity check failed')
    const pages = await backup(db, destination)
    chmodSync(destination, 0o600)
    const exported = new DatabaseSync(destination, { readOnly: true })
    try { if (String(Object.values(exported.prepare('PRAGMA quick_check').get() ?? {})[0]) !== 'ok') throw new Error('Exported state database integrity check failed') }
    finally { exported.close() }
    return { kind: 'sqlite-only' as const, source, destination, pages, bytes: statSync(destination).size, sha256: hash(readFileSync(destination)),
      includes: ['orchestrator.sqlite tables, KV, event/outbox state'], separate: ['DSH Session persistence', 'artifact bytes', 'execution workspaces', 'credentials/profile configuration'] }
  } finally { db.close() }
}

export async function runPreflightCli(argv = process.argv.slice(2)): Promise<void> {
  const options: Record<string, string> = {}
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!
    if (!['--state-dir', '--database', '--entry', '--expected-config-hash', '--export-sqlite'].includes(flag)) throw new Error('Unknown preflight option')
    const value = argv[++index]; if (value === undefined) throw new Error(`${flag} requires a value`); options[flag] = value
  }
  if (!options['--state-dir']) throw new Error('--state-dir is required')
  const inspection = inspectRuntimeState({ stateDir: options['--state-dir'], databasePath: options['--database'], entryPath: options['--entry'], expectedConfigHash: options['--expected-config-hash'] })
  const snapshot = options['--export-sqlite'] && inspection.quickCheck === 'ok'
    ? await exportSqliteSnapshot({ databasePath: inspection.database, destination: options['--export-sqlite'] }) : undefined
  process.stdout.write(JSON.stringify({ ...inspection, ...(snapshot ? { snapshot } : {}) }) + '\n')
  process.exitCode = inspection.exitCode
}
