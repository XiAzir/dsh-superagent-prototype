import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { ArtifactRegistry } from '../src/app/artifacts.ts'

let root: string
let work: string
let outside: string
let spool: string
let values: Map<string, unknown>
const store = {
  get: <T>(key: string): T | undefined => values.get(key) as T | undefined,
  set: <T>(key: string, value: T) => { values.set(key, value) },
}
const registry = () => new ArtifactRegistry(store, spool)
const inside = (base: string, child: string) => {
  const basePath = realpathSync.native(base), childPath = realpathSync.native(child)
  const rel = relative(basePath, childPath)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'superagent-artifacts-'))
  work = join(root, 'work')
  outside = join(root, 'outside')
  spool = join(root, 'state')
  mkdirSync(work); mkdirSync(outside); mkdirSync(spool)
  values = new Map()
})

afterEach(() => {
  const tempRoot = realpathSync.native(tmpdir())
  const resolved = realpathSync.native(root)
  const rel = relative(tempRoot, resolved)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error(`Refusing to remove fixture outside temp directory: ${resolved}`)
  rmSync(resolved, { recursive: true, force: true })
})

it('persists a registered snapshot across registry instances without reading the spool in get', async () => {
  const source = join(work, 'result.txt')
  writeFileSync(source, 'reviewable result')
  const first = await registry().stage('ticket-a', work, source)
  const restored = registry().get(first.id, 'ticket-a')
  expect(restored).toEqual(first)
  expect(await registry().verify(first.id, 'ticket-a')).toEqual(first)
  expect(first).toMatchObject({ name: 'result.txt', size: 17, mediaType: 'text/plain', kind: 'file' })
})

it('isolates artifacts by ticket and rejects paths outside the work directory', async () => {
  const source = join(work, 'private.txt')
  const escaped = join(outside, 'private.txt')
  writeFileSync(source, 'ticket A')
  writeFileSync(escaped, 'outside')
  const artifact = await registry().stage('ticket-a', work, source)
  expect(registry().get(artifact.id, 'ticket-b')).toBeUndefined()
  await expect(registry().verify(artifact.id, 'ticket-b')).rejects.toThrow('Unknown artifact')
  await expect(registry().stage('ticket-a', work, escaped)).rejects.toThrow('outside its ticket work directory')
  await expect(registry().stage('ticket-a', work, 'relative.txt')).rejects.toThrow('must be absolute')
})

it('rejects a symlink that resolves outside the ticket work directory', async () => {
  const escaped = join(outside, 'secret.txt')
  writeFileSync(escaped, 'secret')
  symlinkSync(outside, join(work, 'external'), 'junction')
  await expect(registry().stage('ticket-a', work, join(work, 'external', 'secret.txt')))
    .rejects.toThrow('outside its ticket work directory')
})

it('keeps the staged snapshot after the original worktree file changes', async () => {
  const source = join(work, 'image.png')
  const original = Buffer.from('original image bytes')
  writeFileSync(source, original)
  const artifact = await registry().stage('ticket-a', work, source)
  writeFileSync(source, 'later worker edit')
  expect(await registry().verify(artifact.id)).toEqual(artifact)
  expect(await import('node:fs/promises').then(fs => fs.readFile(artifact.path))).toEqual(original)
})

it('detects a modified spool object before delivery', async () => {
  const source = join(work, 'send.bin')
  writeFileSync(source, 'trusted bytes')
  const artifact = await registry().stage('ticket-a', work, source)
  writeFileSync(artifact.path, 'tampered bytes')
  await expect(registry().verify(artifact.id)).rejects.toThrow('Artifact spool')
})

it('rejects an oversized source before reading it', async () => {
  const source = join(work, 'large.bin')
  writeFileSync(source, '')
  truncateSync(source, 50 * 1024 * 1024 + 1)
  await expect(registry().stage('ticket-a', work, source)).rejects.toThrow('exceeds the 52428800-byte limit')
})

it('honors cancellation before starting a stage', async () => {
  const source = join(work, 'cancel.txt')
  writeFileSync(source, 'not staged')
  const controller = new AbortController()
  controller.abort(new Error('cancelled by test'))
  await expect(registry().stage('ticket-a', work, source, undefined, undefined, controller.signal)).rejects.toThrow('cancelled by test')
  expect(values.size).toBe(0)
})

it('sanitizes display names and keeps the stored path within its ticket spool', async () => {
  const source = join(work, 'photo.png')
  writeFileSync(source, 'pixels')
  const artifact = await registry().stage('ticket-a', work, source, '../bad?.png', 'image')
  expect(artifact.name).toBe('bad_.png')
  expect(artifact.mediaType).toBe('image/png')
  expect(inside(join(spool, 'artifacts'), artifact.path)).toBe(true)
})
