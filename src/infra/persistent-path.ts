/** CNB-only guard for directories that must be covered by the runtime snapshot. */
import { lstatSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'

export const SNAPSHOT_ROOTS = ['dsh-home', 'state', 'work', 'home'] as const

export class PersistentPathError extends Error {
  constructor() { super('Directory must be inside a snapshotted data area (dsh-home, state, work, or home).') }
}

/** Resolve existing symlink ancestors while allowing the final directory and its parents to be created later. */
function canonicalProspective(path: string): string {
  let current = resolve(path)
  const missing: string[] = []
  for (;;) {
    let present = false
    try {
      lstatSync(current)
      present = true
      return resolve(realpathSync(current), ...missing.reverse())
    } catch (error) {
      if (present) throw new PersistentPathError()
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw new PersistentPathError()
      const parent = dirname(current)
      if (parent === current) throw new PersistentPathError()
      missing.push(basename(current))
      current = parent
    }
  }
}

function contained(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLocaleLowerCase('en-US') === right.toLocaleLowerCase('en-US') : left === right
}

function generatedPath(root: string, relativePath: string): boolean {
  const parts = relativePath.split(sep).filter(Boolean)
  const lower = parts.map(part => part.toLocaleLowerCase('en-US'))
  if (lower.includes('node_modules') || lower.includes('.pnpm-store')) return true
  if (root !== 'home') return false
  if (parts[0] === '.cache') return true
  return parts[0] === '.local' && parts[1] === 'share' && parts[2] === 'pnpm'
}

/**
 * Validate a persistent directory against CNB's archived data roots.
 * Without DSH_SUPERAGENT_DATA_ROOT this is a no-op for ordinary Linux and Windows installs.
 */
export function assertPersistentDataPath(path: string, roots: readonly string[] = SNAPSHOT_ROOTS): string {
  const dataRoot = process.env.DSH_SUPERAGENT_DATA_ROOT?.trim()
  if (!dataRoot) return path
  if (!isAbsolute(dataRoot) || !isAbsolute(path)) throw new PersistentPathError()
  try {
    const canonicalRoot = canonicalProspective(dataRoot)
    const canonicalTarget = canonicalProspective(path)
    if (samePath(canonicalRoot, canonicalTarget)) throw new PersistentPathError()
    // Check the caller's bucket before a different canonical bucket can match.
    // For example work -> DATA would otherwise let work/state match state first.
    for (const name of SNAPSHOT_ROOTS) {
      const declaredBucket = resolve(dataRoot, name)
      if (contained(declaredBucket, resolve(path)) && lstatSync(declaredBucket, { throwIfNoEntry: false })?.isSymbolicLink()) {
        throw new PersistentPathError()
      }
    }
    for (const name of roots) {
      if (!SNAPSHOT_ROOTS.includes(name as typeof SNAPSHOT_ROOTS[number])) continue
      const declaredBucket = resolve(canonicalRoot, name)
      try {
        if (lstatSync(declaredBucket).isSymbolicLink()) {
          if (contained(declaredBucket, resolve(path))) throw new PersistentPathError()
          continue
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
      }
      const bucket = canonicalProspective(declaredBucket)
      if (samePath(bucket, declaredBucket) && contained(canonicalRoot, bucket) && contained(bucket, canonicalTarget)) {
        if (generatedPath(name, relative(bucket, canonicalTarget))) throw new PersistentPathError()
        const existing = statSync(path, { throwIfNoEntry: false })
        if (existing && !existing.isDirectory()) throw new PersistentPathError()
        return path
      }
    }
  } catch (error) {
    if (error instanceof PersistentPathError) throw error
  }
  throw new PersistentPathError()
}
