/** Registered-artifact handoff uses actual SQLite, immutable spool bytes and task-scoped output files. */
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { Effects } from '../src/app/effects.ts'
import { ArtifactRegistry } from '../src/app/artifacts.ts'
import { RequestHandoffService, type RequestHandoffHost } from '../src/app/request-handoff.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { record } from '../src/kv.ts'
import type { Ticket } from '../src/core/index.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })
const at = '2026-11-07T07:00:00.000Z', bytes = Buffer.from([0, 1, 2, 253, 254, 255])
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'request-handoff-')), database = join(directory, 'state.sqlite')
  const sourceRoot = join(directory, 'source'), targetRoot = join(directory, 'target')
  await mkdir(sourceRoot); await mkdir(targetRoot)
  let store!: Store, effects!: Effects, artifacts!: ArtifactRegistry, service!: RequestHandoffService, lifetime!: AbortController
  let clock = Date.parse(at), authorized = true
  let importer: RequestHandoffHost['importArtifact']
  const note = vi.fn((ticketId: string, text: string, requestId: string) => {
    const id = record<{ ticketId: string; text: string }>(`handoff-note:${requestId}`), old = store.get(id)
    if (old && (old.ticketId !== ticketId || old.text !== text)) throw new Error('Conflicting note retry')
    if (!old) store.set(id, { ticketId, text })
  })
  function open() {
    store = new Store(database); effects = new Effects(store, new HealthBoard(), () => clock)
    artifacts = new ArtifactRegistry(store, directory); lifetime = new AbortController()
    service = new RequestHandoffService({ store, effects, artifacts, authorized: () => authorized,
      destination: ticket => ticket.execution?.directory, paused: () => false, lifetime: lifetime.signal,
      note, requestPass: () => {}, importArtifact: async (...args) => importer?.(...args) ?? { path: args[2] } })
  }
  open()
  cleanup.push(async () => { lifetime.abort(); await effects.drain(); store.close(); rmSync(directory, { recursive: true, force: true }) })
  const ticket = (id: string, root: string): Ticket => ({ id, title: `${id} task`, decisionId: `decision-${id}`, channels: [],
    mandate: { strength: 'explicit', policyVersion: '1', basis: { via: 'listed' }, actor: { source: 'web', id: 'owner' }, scope: 'Create result.bin' },
    assignments: [{ id: `${id}-assignment`, state: 'running', createdAt: at }],
    origin: { triggerId: 'original', triggerIds: ['original'] }, execution: { name: id, directory: root, assignment: 'Create result.bin.' }, inputs: [], undelivered: [], createdAt: at, updatedAt: at })
  const source = ticket('source', sourceRoot), target = ticket('target', targetRoot)
  await writeFile(join(sourceRoot, 'result.bin'), bytes)
  const artifact = await artifacts.stage(source.id, sourceRoot, join(sourceRoot, 'result.bin'), 'result.bin')
  source.assignments[0]!.report = { state: 'progress', at, summary: '实际二进制样本已生成，后续验证继续。', artifacts: [artifact.id] }
  source.ended = { at, by: 'executor', outcome: 'dropped' }
  store.tickets.save(source); store.tickets.save(target)
  store.triggers.save({ id: 'original', source: 'web', actor: { source: 'web', id: 'owner' }, human: true, at,
    threads: [{ source: 'web', id: 'conversation' }], text: '创建 result.bin 并核对其实际字节。', meta: {} })
  store.triggers.saveDisposition('original', { fanout: ['target'], at, request: { id: 'original', triggerId: 'original', revision: 3,
    state: 'proposed', owners: [{ ticketId: 'target', state: 'proposed', at }], history: [
      { revision: 2, at, kind: 'transferred', ticketId: 'source', toTicketId: 'target', requestId: 'correct-owner' },
      { revision: 3, at, kind: 'proposed', ticketId: 'target' }] } })
  const entry = () => service.get(store.keys('request-handoff:')[0]!.slice('request-handoff:'.length))!
  return { directory, sourceRoot, targetRoot, artifact, note,
    get store() { return store }, get artifacts() { return artifacts }, get effects() { return effects }, get service() { return service },
    get lifetime() { return lifetime }, entry, setAuthorized(value: boolean) { authorized = value },
    setImporter(value: RequestHandoffHost['importArtifact']) { importer = value },
    async restart() { lifetime.abort(); await effects.drain(); store.close(); clock += 2000; open() },
    async run() { service.submit('original'); effects.start(); await effects.idle('request-handoff') } }
}

it('copies exact registered bytes into the new owner and scopes the new deterministic artifact to that owner, once', async () => {
  const h = await fixture(); await writeFile(join(h.sourceRoot, 'unregistered-secret.txt'), 'keep source private')
  await h.run()
  const item = h.entry(), moved = item.items[0]!
  expect(item.state).toBe('completed')
  expect(moved.artifact).toMatchObject({ ticketId: 'target', size: bytes.length, sha256: h.artifact.sha256 })
  expect(moved.artifact!.id).not.toBe(h.artifact.id)
  expect(await readFile(moved.localPath!)).toEqual(bytes)
  expect(await readFile((await h.artifacts.verify(moved.artifact!.id, 'target')).path)).toEqual(bytes)
  await expect(h.artifacts.verify(moved.artifact!.id, 'source')).rejects.toThrow('Unknown artifact')
  expect(await readFile(h.artifact.path)).toEqual(bytes)
  expect(h.note).toHaveBeenCalledTimes(1)
  expect(h.note.mock.calls[0]![1]).toContain(moved.artifact!.id)
  expect(h.note.mock.calls[0]![1]).not.toContain('unregistered-secret')
  await h.restart(); await h.run()
  expect(h.entry().items[0]!.artifact!.id).toBe(moved.artifact!.id)
  expect(h.note).toHaveBeenCalledTimes(1)
})

it('resumes persisted staging after an interrupted remote import and returns the usable remote path', async () => {
  const h = await fixture(), imported = vi.fn<RequestHandoffHost['importArtifact'] & {}>(async (_ticket, _artifact, path, relative) => {
    expect(await readFile(path)).toEqual(bytes)
    if (imported.mock.calls.length === 1) { h.lifetime.abort(); throw new Error('Device connection closed after local staging') }
    return { path: `/remote/task/${relative}`, deviceId: 'laptop' }
  })
  h.setImporter(imported); await h.run()
  const stagedId = h.entry().items[0]!.artifact!.id
  expect(h.entry()).toMatchObject({ state: 'queued', items: [{ artifact: { ticketId: 'target' } }] })
  expect(h.note).not.toHaveBeenCalled()
  await h.restart()
  h.store.db.prepare('DELETE FROM effect WHERE kind=?').run('request-handoff')
  await h.restart(); h.effects.start(); await h.effects.idle('request-handoff')
  expect(h.entry()).toMatchObject({ state: 'completed', items: [{ artifact: { id: stagedId }, imported: { deviceId: 'laptop' } }] })
  expect(imported).toHaveBeenCalledTimes(2)
  expect(h.note.mock.calls[0]![1]).toContain('/remote/task/request-handoffs/')
})

it.each(['stopped', 'transferred-again', 'revoked'] as const)('leaves a %s receiving task untouched', async change => {
  const h = await fixture(); h.service.submit('original')
  if (change === 'stopped') { const target = h.store.tickets.get('target')!; target.ended = { at, by: 'human', outcome: 'stopped' }; h.store.tickets.save(target) }
  if (change === 'transferred-again') { const disposition = h.store.triggers.disposition('original')!; disposition.request!.owners = [{ ticketId: 'other', state: 'claimed', at }]; h.store.triggers.saveDisposition('original', disposition) }
  if (change === 'revoked') h.setAuthorized(false)
  h.effects.start(); await h.effects.idle('request-handoff')
  expect(h.entry().state).toBe('stale'); expect(h.note).not.toHaveBeenCalled()
  expect(h.store.keys('task-artifact:')).toHaveLength(1)
})

it('records a corrupted registered snapshot as a failed handoff with a concrete note', async () => {
  const h = await fixture(); await writeFile(h.artifact.path, Buffer.from('corrupted'))
  await h.run()
  expect(h.entry()).toMatchObject({ state: 'failed', error: expect.stringContaining('changed') })
  expect(h.note.mock.calls[0]![1]).toContain('no successful handoff is claimed')
  expect(h.store.keys('task-artifact:')).toHaveLength(1)
})

it('retains a held destination as pending work and resumes from SQLite after the hold is released', async () => {
  const h = await fixture(), target = h.store.tickets.get('target')!
  target.hold = { kind: 'environment', at, reason: 'Waiting for the laptop.' }; h.store.tickets.save(target)
  await h.run()
  expect(h.entry()).toMatchObject({ state: 'queued', attempts: 0 })
  expect(h.note).not.toHaveBeenCalled()
  delete target.hold; h.store.tickets.save(target)
  await h.restart(); h.effects.start(); await h.effects.idle('request-handoff')
  expect(h.entry().state).toBe('completed')
})

it('refuses a source report with more than eight registered artifacts before creating target copies', async () => {
  const h = await fixture(), source = h.store.tickets.get('source')!, ids: string[] = []
  for (let index = 0; index < 9; index++) ids.push((await h.artifacts.stage('source', h.sourceRoot,
    join(h.sourceRoot, 'result.bin'), `registered-${index}.bin`)).id)
  source.assignments[0]!.report!.artifacts = ids; h.store.tickets.save(source)
  await h.run()
  expect(h.entry()).toMatchObject({ state: 'failed', error: expect.stringContaining('eight-artifact') })
  expect(await readdir(h.targetRoot)).toEqual([])
})

it('enforces the aggregate 50 MiB bound using actual registered file sizes', async () => {
  const h = await fixture(), source = h.store.tickets.get('source')!, ids: string[] = []
  await writeFile(join(h.sourceRoot, 'large.bin'), Buffer.alloc(26 * 1024 * 1024))
  for (const name of ['large-a.bin', 'large-b.bin']) ids.push((await h.artifacts.stage('source', h.sourceRoot,
    join(h.sourceRoot, 'large.bin'), name)).id)
  source.assignments[0]!.report!.artifacts = ids; h.store.tickets.save(source)
  await h.run()
  expect(h.entry()).toMatchObject({ state: 'failed', error: expect.stringContaining('50 MiB') })
  expect(await readdir(h.targetRoot)).toEqual([])
}, 20_000)

it('rejects a junction at the receiving handoff directory and preserves the outside directory', async () => {
  const h = await fixture(), outside = join(h.directory, 'outside'); await mkdir(outside)
  await symlink(outside, join(h.targetRoot, 'request-handoffs'), process.platform === 'win32' ? 'junction' : 'dir')
  await h.run()
  expect(h.entry()).toMatchObject({ state: 'failed', error: expect.stringContaining('escaped') })
  expect(await readdir(outside)).toEqual([])
  expect(h.store.keys('task-artifact:')).toHaveLength(1)
})
