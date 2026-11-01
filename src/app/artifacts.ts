/** Immutable, ticket-scoped artifact snapshots staged for later delivery. */
import { createHash, randomUUID } from 'node:crypto'
import { constants, createReadStream, createWriteStream } from 'node:fs'
import { chmod, lstat, mkdir, open, realpath, rename, rm, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { record } from '../kv.ts'
import type { Store } from './store.ts'

export interface TaskArtifact {
  id: string
  ticketId: string
  path: string
  name: string
  size: number
  sha256: string
  mediaType: string
  kind: 'file' | 'image' | 'video'
  createdAt: string
}

const MAX_BYTES = 50 * 1024 * 1024
const ARTIFACT_PREFIX = 'task-artifact:'
const TYPES: Record<string, string> = {
  '.avif': 'image/avif', '.bmp': 'image/bmp', '.gif': 'image/gif', '.heic': 'image/heic', '.heif': 'image/heif',
  '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.tif': 'image/tiff',
  '.tiff': 'image/tiff', '.webp': 'image/webp', '.m4v': 'video/x-m4v', '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime', '.mp4': 'video/mp4', '.mpeg': 'video/mpeg', '.mpg': 'video/mpeg',
  '.ogv': 'video/ogg', '.webm': 'video/webm', '.3gp': 'video/3gpp', '.aac': 'audio/aac', '.flac': 'audio/flac',
  '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.opus': 'audio/opus', '.wav': 'audio/wav',
  '.pdf': 'application/pdf', '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.csv': 'text/csv', '.json': 'application/json', '.md': 'text/markdown', '.txt': 'text/plain', '.zip': 'application/zip',
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const contained = (root: string, path: string): boolean => {
  const child = relative(root, path)
  return child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)
}
function safeName(value: string): string {
  const leaf = basename(value.replaceAll('\\', '/')).replace(/[\x00-\x1f<>:"|?*]/g, '_').replace(/[. ]+$/g, '').trim()
  const bounded = [...leaf].slice(0, 240).join('')
  return bounded && bounded !== '.' && bounded !== '..' ? bounded : 'artifact'
}
function inferredKind(mediaType: string): TaskArtifact['kind'] {
  return mediaType.startsWith('image/') ? 'image' : mediaType.startsWith('video/') ? 'video' : 'file'
}
function keyFor(id: string) { return record<TaskArtifact>(`${ARTIFACT_PREFIX}${id}`) }

/**
 * Copies explicitly selected files from a ticket worktree into a private, persistent spool.
 * The original worktree file may change or disappear after staging without changing the artifact.
 */
export class ArtifactRegistry {
  private readonly root: string
  private readonly stateRoot: string
  constructor(private readonly store: Pick<Store, 'get' | 'set'>, stateDir: string) {
    this.stateRoot = resolve(stateDir)
    this.root = resolve(this.stateRoot, 'artifacts')
  }

  /** Validate and snapshot one explicit regular file beneath its ticket work directory. */
  async stage(ticketId: string, workDirectory: string, path: string, name?: string,
    kind?: TaskArtifact['kind'], signal?: AbortSignal): Promise<TaskArtifact> {
    if (!ticketId.trim()) throw new Error('Artifact needs a ticket ID')
    if (!isAbsolute(path)) throw new Error('Artifact path must be absolute')
    if (signal?.aborted) throw signal.reason ?? new Error('Artifact staging aborted')

    const [workRoot, source] = await Promise.all([realpath(workDirectory), realpath(path)])
    if (signal?.aborted) throw signal.reason ?? new Error('Artifact staging aborted')
    if (!(await stat(workRoot)).isDirectory()) throw new Error('Ticket work directory must be a directory')
    if (!contained(workRoot, source)) throw new Error('Artifact path is outside its ticket work directory')
    const sourceInfo = await stat(source)
    if (!sourceInfo.isFile()) throw new Error('Artifact source must be a regular file')
    if (sourceInfo.size > MAX_BYTES) throw new Error(`Artifact exceeds the ${MAX_BYTES}-byte limit`)
    const displayName = safeName(name ?? basename(source))
    const mediaType = TYPES[extname(displayName).toLowerCase()] ?? 'application/octet-stream'
    const artifactKind = kind ?? inferredKind(mediaType)
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const root = await realpath(this.root)
    if (!contained(await realpath(this.stateRoot), root)) throw new Error('Artifact spool root escapes the state directory')
    await chmod(root, 0o700)
    const spoolDir = join(root, digest(ticketId))
    await mkdir(spoolDir, { recursive: true, mode: 0o700 })
    if (await realpath(spoolDir) !== spoolDir) throw new Error('Artifact ticket spool path is invalid')
    await chmod(spoolDir, 0o700)

    const temp = join(spoolDir, `.stage-${randomUUID()}.tmp`)
    const hash = createHash('sha256')
    let size = 0
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length
        if (size > MAX_BYTES) { callback(new Error(`Artifact exceeds the ${MAX_BYTES}-byte limit`)); return }
        hash.update(chunk)
        callback(null, chunk)
      },
    })
    let sourceHandle: Awaited<ReturnType<typeof open>> | undefined
    try {
      if (signal?.aborted) throw signal.reason ?? new Error('Artifact staging aborted')
      sourceHandle = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      const openedInfo = await sourceHandle.stat()
      if (!openedInfo.isFile() || openedInfo.dev !== sourceInfo.dev || openedInfo.ino !== sourceInfo.ino || openedInfo.size !== sourceInfo.size) {
        throw new Error('Artifact source changed while it was being opened')
      }
      await pipeline(sourceHandle.createReadStream({ autoClose: false, signal }), meter,
        createWriteStream(temp, { flags: 'wx', mode: 0o600 }), { signal })
      if (signal?.aborted) throw signal.reason ?? new Error('Artifact staging aborted')
      if (sourceInfo.size !== size) throw new Error('Artifact source changed while it was being staged')
      const sha256 = hash.digest('hex')
      const id = `artifact_${digest(`${ticketId}\0${sha256}\0${displayName}\0${artifactKind}`)}`
      const destination = join(spoolDir, id)
      const info = await stat(temp)
      if (info.size !== size) throw new Error('Artifact staging produced a size mismatch')

      // Rename publishes the fully flushed temp object atomically without exposing partial bytes.
      // If the deterministic destination already exists, verify that exact snapshot before reusing it.
      try { await rename(temp, destination) }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EACCES') throw error
        const existingInfo = await lstat(destination).catch(() => undefined)
        if (!existingInfo?.isFile() || existingInfo.size !== size) throw error
        const existingHash = createHash('sha256')
        let existingSize = 0
        for await (const chunk of createReadStream(destination)) { existingSize += chunk.length; existingHash.update(chunk) }
        if (existingSize !== size || existingHash.digest('hex') !== sha256) throw new Error('Artifact ID collision')
      }
      await rm(temp, { force: true })
      await chmod(destination, 0o600)
      const artifact: TaskArtifact = { id, ticketId, path: destination, name: displayName, size, sha256, mediaType,
        kind: artifactKind, createdAt: this.get(id, ticketId)?.createdAt ?? new Date().toISOString() }
      this.store.set(keyFor(id), artifact)
      return artifact
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {})
      throw error
    } finally {
      await sourceHandle?.close().catch(() => {})
    }
  }

  /** Return a persisted descriptor without reading the spool bytes. */
  get(id: string, ticketId?: string): TaskArtifact | undefined {
    const artifact = this.store.get(keyFor(id))
    return artifact && (!ticketId || artifact.ticketId === ticketId) ? artifact : undefined
  }

  /** Confirm a staged snapshot still has its registered size and digest before delivery. */
  async verify(id: string, ticketId?: string): Promise<TaskArtifact> {
    const artifact = this.get(id, ticketId)
    if (!artifact) throw new Error('Unknown artifact')
    const root = await realpath(this.root)
    if (!contained(await realpath(this.stateRoot), root)) throw new Error('Artifact spool root escapes the state directory')
    const expectedDir = join(root, digest(artifact.ticketId))
    const expectedPath = join(expectedDir, artifact.id)
    const actualPath = await realpath(artifact.path).catch(() => undefined)
    if (!actualPath || !contained(expectedDir, actualPath) || actualPath !== expectedPath) throw new Error('Artifact spool path is invalid')
    const info = await lstat(actualPath)
    if (!info.isFile() || info.size !== artifact.size) throw new Error('Artifact spool size changed')
    const hash = createHash('sha256')
    let size = 0
    for await (const chunk of createReadStream(actualPath)) { size += chunk.length; hash.update(chunk) }
    if (size !== artifact.size || hash.digest('hex') !== artifact.sha256) throw new Error('Artifact spool content changed')
    return artifact
  }
}
