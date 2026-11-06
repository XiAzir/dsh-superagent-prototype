/** Ticket-local file access with lexical and real-path checks, including parent symlinks/junctions. */
import { constants, lstatSync, mkdirSync, openSync, closeSync, readSync, fstatSync, realpathSync, renameSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { EnvironmentError, sha256, validId, type RemoteFile } from './protocol.ts'

const inside = (root: string, path: string) => { const item = relative(root, path); return item === '' || (!item.startsWith(`..${sep}`) && item !== '..' && !isAbsolute(item)) }
/** Reads and writes ticket-local endpoint files while enforcing path confinement and verifying byte digests. */
export class EnvironmentFiles {
  readonly root: string
  readonly maxBytes: number
  constructor(root: string, maxBytes = 50 * 1024 * 1024) {
    mkdirSync(root, { recursive: true, mode: 0o700 }); this.root = realpathSync(root); this.maxBytes = maxBytes
  }
  workspace(ticketId: string): string {
    validId(ticketId, 'ticketId')
    const directory = join(this.root, sha256(ticketId).slice(0, 32))
    if (existsSync(directory) && lstatSync(directory).isSymbolicLink()) throw new EnvironmentError('path_escape', 'Task workspace must be a real directory', 403)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    if (!inside(this.root, realpathSync(directory))) throw new EnvironmentError('path_escape', 'Task workspace left the authorized root', 403)
    return directory
  }
  path(ticketId: string, name: string, createParents = false): string {
    if (typeof name !== 'string' || name.length > 1024 || name.includes('\0') || isAbsolute(name) || /^[A-Za-z]:|^[/\\]{2}/.test(name)
      || name.includes(':') || name.split(/[/\\]/).includes('..')) throw new EnvironmentError('path_escape', 'Use a path inside this task workspace', 403)
    const workspace = this.workspace(ticketId), target = resolve(workspace, name || '.')
    if (!inside(workspace, target)) throw new EnvironmentError('path_escape', 'Path left the task workspace', 403)
    const parts = relative(workspace, target).split(sep).filter(Boolean)
    let cursor = workspace
    for (const part of parts) {
      cursor = join(cursor, part)
      if (existsSync(cursor)) {
        if (lstatSync(cursor).isSymbolicLink() || !inside(workspace, realpathSync(cursor))) throw new EnvironmentError('path_escape', 'Symbolic file paths require an ordinary task-local copy', 403)
      }
    }
    if (createParents) { mkdirSync(dirname(target), { recursive: true, mode: 0o700 }); this.path(ticketId, name) }
    return target
  }
  read(ticketId: string, name: string): RemoteFile {
    const path = this.path(ticketId, name), info = lstatSync(path)
    if (!info.isFile()) throw new EnvironmentError('not_file', 'Path must identify an ordinary file')
    if (info.size > this.maxBytes) throw new EnvironmentError('file_limit', 'File exceeds the transfer limit', 413)
    const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const chunks: Buffer[] = []; let total = 0
    try {
      const opened = fstatSync(descriptor)
      if (!opened.isFile() || opened.size > this.maxBytes || opened.nlink > 1) throw new EnvironmentError('file_limit', 'Transfer an ordinary task-local file within the size limit', 413)
      while (total <= this.maxBytes) {
        const buffer = Buffer.alloc(Math.min(64 * 1024, this.maxBytes + 1 - total)), count = readSync(descriptor, buffer)
        if (!count) break
        chunks.push(buffer.subarray(0, count)); total += count
      }
    } finally { closeSync(descriptor) }
    const bytes = Buffer.concat(chunks)
    this.path(ticketId, name)
    if (bytes.length > this.maxBytes) throw new EnvironmentError('file_limit', 'File grew beyond the transfer limit', 413)
    return { path: name, directory: this.workspace(ticketId), bytes: bytes.length, sha256: sha256(bytes), base64: bytes.toString('base64') }
  }
  write(ticketId: string, name: string, base64: string, expectedHash: string, overwrite = false): Omit<RemoteFile, 'base64'> & { reused: boolean } {
    if (typeof base64 !== 'string' || base64.length > Math.ceil(this.maxBytes / 3) * 4 + 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)
      || !/^[a-f0-9]{64}$/.test(expectedHash)) throw new EnvironmentError('invalid_file', 'File transfer requires bounded base64 bytes and a SHA-256 digest')
    const bytes = Buffer.from(base64, 'base64')
    if (bytes.toString('base64') !== base64) throw new EnvironmentError('invalid_file', 'File transfer requires canonical base64 bytes')
    if (bytes.length > this.maxBytes) throw new EnvironmentError('file_limit', 'File exceeds the transfer limit', 413)
    if (sha256(bytes) !== expectedHash) throw new EnvironmentError('hash_mismatch', 'Transferred file digest does not match')
    const path = this.path(ticketId, name, true)
    if (existsSync(path)) {
      const existing = this.read(ticketId, name)
      if (existing.sha256 === expectedHash) { const { base64: _bytes, ...metadata } = existing; return { ...metadata, reused: true } }
      if (!overwrite) throw new EnvironmentError('file_exists', 'An existing file has different content; explicit overwrite is required', 409)
    }
    const temporary = `${path}.${randomUUID()}.tmp`
    const descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
    try { writeFileSync(descriptor, bytes) } finally { closeSync(descriptor) }
    this.path(ticketId, name); renameSync(temporary, path); this.path(ticketId, name)
    return { path: name, directory: this.workspace(ticketId), bytes: bytes.length, sha256: expectedHash, reused: false }
  }
}
