import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertPersistentDataPath, PersistentPathError } from '../src/infra/persistent-path.ts'

let base: string
let root: string

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'superagent-persistent-path-'))
  root = join(base, 'data')
  mkdirSync(join(root, 'state'), { recursive: true })
  mkdirSync(join(root, 'work'), { recursive: true })
  mkdirSync(join(root, 'dsh-home'), { recursive: true })
  mkdirSync(join(root, 'home'), { recursive: true })
  vi.stubEnv('DSH_SUPERAGENT_DATA_ROOT', root)
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(base, { recursive: true, force: true })
})

it('accepts archived roots and future descendants, including a nested state work directory', () => {
  expect(assertPersistentDataPath(join(root, 'state'))).toBe(join(root, 'state'))
  expect(assertPersistentDataPath(join(root, 'state', 'work', 'ticket'))).toBe(join(root, 'state', 'work', 'ticket'))
  expect(assertPersistentDataPath(join(root, 'work', 'future', 'ticket'))).toBe(join(root, 'work', 'future', 'ticket'))
  expect(assertPersistentDataPath(join(root, 'home', 'settings'))).toBe(join(root, 'home', 'settings'))
})

it('rejects the snapshot root, adjacent prefixes, traversal and paths outside archived roots', () => {
  expect(() => assertPersistentDataPath(root)).toThrow(PersistentPathError)
  expect(() => assertPersistentDataPath(`${root}-backup/work`)).toThrow(PersistentPathError)
  expect(() => assertPersistentDataPath(join(root, 'work', '..', 'secrets'))).toThrow(PersistentPathError)
  expect(() => assertPersistentDataPath(join(root, 'other'))).toThrow(PersistentPathError)
  expect(() => assertPersistentDataPath('relative/work')).toThrow(PersistentPathError)
})

it('rejects an existing symlink ancestor that resolves outside an archived root', () => {
  const outside = join(base, 'outside')
  mkdirSync(outside)
  try { symlinkSync(outside, join(root, 'work', 'escape'), process.platform === 'win32' ? 'junction' : 'dir') }
  catch { return }
  expect(() => assertPersistentDataPath(join(root, 'work', 'escape', 'future'))).toThrow(PersistentPathError)
})

it('rejects directories omitted from the snapshot archive', () => {
  for (const path of [
    join(root, 'home', '.cache'),
    join(root, 'home', '.cache', 'browser-profile'),
    join(root, 'home', '.local', 'share', 'pnpm'),
    join(root, 'home', '.local', 'share', 'pnpm', 'store'),
    join(root, 'work', 'node_modules'),
    join(root, 'work', 'project', 'node_modules', '.pnpm-store'),
    join(root, 'state', '.pnpm-store', 'generated'),
  ]) expect(() => assertPersistentDataPath(path)).toThrow(PersistentPathError)
  expect(assertPersistentDataPath(join(root, 'home', '.config', 'tool'))).toBe(join(root, 'home', '.config', 'tool'))
})

it('rejects snapshot bucket symlinks even when they resolve elsewhere under DATA', () => {
  const other = join(root, 'other')
  mkdirSync(other)
  const bucket = join(root, 'work')
  rmSync(bucket, { recursive: true, force: true })
  try { symlinkSync(other, bucket, process.platform === 'win32' ? 'junction' : 'dir') }
  catch { return }
  expect(() => assertPersistentDataPath(join(bucket, 'future'))).toThrow(PersistentPathError)

  rmSync(bucket, { recursive: true, force: true })
  symlinkSync(root, bucket, process.platform === 'win32' ? 'junction' : 'dir')
  expect(() => assertPersistentDataPath(join(bucket, 'state'))).toThrow(PersistentPathError)
})

it('preserves existing path behavior when the CNB data root is unset', () => {
  vi.stubEnv('DSH_SUPERAGENT_DATA_ROOT', '')
  expect(assertPersistentDataPath('relative/work')).toBe('relative/work')
  expect(assertPersistentDataPath(join(base, '..', 'outside'))).toBe(join(base, '..', 'outside'))
})
