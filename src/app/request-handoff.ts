/** Durable, request-bound reuse of registered artifacts across corrected task ownership. */
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, join, resolve } from 'node:path'
import { key, liveTicket, type Ticket, type Trigger } from '../core/index.ts'
import { record } from '../kv.ts'
import { Later, type Effects } from './effects.ts'
import type { ArtifactRegistry, TaskArtifact } from './artifacts.ts'
import type { Store } from './store.ts'
import { watchdogText } from './watchdog.ts'

const PREFIX = 'request-handoff:', MAX_BYTES = 50 * 1024 * 1024
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const entryKey = (id: string) => record<RequestHandoff>(`${PREFIX}${id}`)
interface HandoffItem { sourceId: string; artifact?: TaskArtifact; localPath?: string; imported?: { path: string; deviceId?: string }; error?: string }
export interface RequestHandoff {
  id: string; triggerId: string; fromTicketId: string; toTicketId: string; transferRevision: number; transferRequestId?: string
  state: 'queued' | 'running' | 'completed' | 'failed' | 'stale'; createdAt: string; completedAt?: string; attempts: number
  summary: string; items: HandoffItem[]; error?: string
}
export interface RequestHandoffHost {
  store: Pick<Store, 'get' | 'set' | 'keys' | 'atomic' | 'tickets' | 'triggers'>
  effects: Pick<Effects, 'enqueue' | 'handle' | 'pending'>
  artifacts: Pick<ArtifactRegistry, 'verify' | 'stage'>
  authorized(from: Ticket, to: Ticket, trigger: Trigger): boolean
  destination(to: Ticket): string | undefined
  importArtifact?(to: Ticket, artifact: TaskArtifact, localPath: string, relativePath: string, signal: AbortSignal): Promise<{ path: string; deviceId?: string }>
  note(ticketId: string, text: string, requestId: string): void
  requestPass(): void
  paused(): boolean
  lifetime: AbortSignal
}

/** Copies verified bytes to the new owner's own task scope, retaining source snapshots and stable receipts. */
export class RequestHandoffService {
  constructor(private readonly host: RequestHandoffHost) {
    host.effects.handle('request-handoff', async ({ handoffId }) => { await this.run(handoffId) },
      { limit: () => host.paused() || host.lifetime.aborted ? 0 : 1, quiet: true, retry: [1000, 60_000] })
    for (const name of host.store.keys(PREFIX)) {
      const item = host.store.get<RequestHandoff>(name)
      if (item && ['queued', 'running'].includes(item.state) && !host.effects.pending('request-handoff', item.id)) {
        host.effects.enqueue('request-handoff', item.id, { handoffId: item.id })
      }
    }
  }
  get(id: string): RequestHandoff | undefined { return this.host.store.get(entryKey(id)) }
  submit(triggerId: string): void {
    const request = this.host.store.triggers.disposition(triggerId)?.request
    for (const event of request?.history ?? []) {
      if (event.kind !== 'transferred' || !event.ticketId || !event.toTicketId) continue
      const id = key('request-handoff', triggerId, String(event.revision), event.ticketId, event.toTicketId)
      if (this.get(id)) continue
      const source = this.host.store.tickets.get(event.ticketId), report = source?.assignments.at(-1)?.report
      const ids = [...new Set(report?.artifacts ?? [])]
      const item: RequestHandoff = { id, triggerId, fromTicketId: event.ticketId, toTicketId: event.toTicketId,
        transferRevision: event.revision, transferRequestId: event.requestId, state: 'queued', attempts: 0, createdAt: event.at,
        summary: watchdogText(report?.summary ?? 'No prior result report.', 1200), items: ids.slice(0, 8).map(sourceId => ({ sourceId })),
        ...ids.length > 8 ? { error: 'The source report exceeds the eight-artifact handoff limit.' } : {} }
      this.host.store.set(entryKey(id), item)
      this.host.effects.enqueue('request-handoff', id, { handoffId: id })
    }
  }
  private current(item: RequestHandoff) {
    const from = this.host.store.tickets.get(item.fromTicketId), to = this.host.store.tickets.get(item.toTicketId)
    const trigger = this.host.store.triggers.get(item.triggerId), request = this.host.store.triggers.disposition(item.triggerId)?.request
    return from && to && trigger && liveTicket(to)
      && request?.owners.some(owner => owner.ticketId === to.id && ['proposed', 'claimed'].includes(owner.state))
      && request.history.some(event => event.kind === 'transferred' && event.revision === item.transferRevision
        && event.ticketId === from.id && event.toTicketId === to.id && event.requestId === item.transferRequestId)
      && this.host.authorized(from, to, trigger) ? { from, to, trigger } : undefined
  }
  private persist(item: RequestHandoff): void { this.host.store.set(entryKey(item.id), item) }
  private finish(item: RequestHandoff, state: RequestHandoff['state'], error?: string): void {
    item.state = state; item.completedAt = new Date().toISOString(); if (error) item.error = watchdogText(error, 700)
    this.persist(item)
  }
  private async file(rootDirectory: string, item: RequestHandoff, artifact: TaskArtifact, index: number): Promise<string> {
    const root = await realpath(rootDirectory), parent = join(root, 'request-handoffs'), directory = join(parent, item.id)
    for (const path of [parent, directory]) {
      await mkdir(path).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error })
      const info = await lstat(path)
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) throw new Error('Handoff destination escaped its task directory')
    }
    const name = basename(artifact.name.replaceAll('\\', '/')).replace(/[^\p{L}\p{N}._-]/gu, '_').slice(0, 120) || 'artifact'
    const destination = join(directory, `${index}-${artifact.sha256.slice(0, 16)}-${name}`)
    const source = await open(artifact.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    let bytes: Buffer
    try {
      const info = await source.stat()
      if (!info.isFile() || info.size !== artifact.size || info.size > MAX_BYTES) throw new Error('Source artifact changed before handoff')
      bytes = await source.readFile()
    } finally { await source.close() }
    if (bytes.length !== artifact.size || sha(bytes) !== artifact.sha256) throw new Error('Source artifact digest changed during handoff')
    if (!this.current(item)) throw new Error('Request ownership changed during handoff')
    let target: Awaited<ReturnType<typeof open>> | undefined
    try {
      target = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
      await target.writeFile(bytes); await target.sync()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const info = await lstat(destination)
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Handoff destination is not a regular file')
      const existing = await open(destination, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      try { const saved = await existing.readFile(); if (saved.length !== artifact.size || sha(saved) !== artifact.sha256) throw new Error('Existing handoff bytes conflict') }
      finally { await existing.close() }
    } finally { await target?.close() }
    if (await realpath(directory) !== directory || await realpath(destination) !== destination) throw new Error('Handoff destination changed')
    return destination
  }
  private async run(id: string): Promise<void> {
    const item = this.get(id)
    if (!item || !['queued', 'running'].includes(item.state)) return
    let current = this.current(item)
    if (!current) { this.finish(item, 'stale', 'Request ownership, state or authorization changed.'); return }
    if (current.to.hold || this.host.paused()) throw new Later('Waiting for the receiving task to resume')
    const directory = this.host.destination(current.to)
    if (!directory) throw new Later('Waiting for the receiving task workspace')
    try { await realpath(resolve(directory)) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Later('Waiting for the receiving task workspace'); throw error }
    item.state = 'running'; item.attempts++; this.persist(item)
    const signal = AbortSignal.any([this.host.lifetime, AbortSignal.timeout(60_000)])
    try {
      if (item.error) throw new Error(item.error)
      const sources = await Promise.all(item.items.map(part => this.host.artifacts.verify(part.sourceId, item.fromTicketId)))
      if (sources.reduce((sum, source) => sum + source.size, 0) > MAX_BYTES) throw new Error('Registered handoff artifacts exceed 50 MiB')
      for (const [index, part] of item.items.entries()) {
        signal.throwIfAborted(); current = this.current(item)
        if (!current) { this.finish(item, 'stale', 'Request owner changed while copying artifacts.'); return }
        if (current.to.hold || this.host.paused()) throw new Later('Waiting for the receiving task to resume')
        if (!part.artifact) {
          const source = sources[index]!, path = await this.file(directory, item, source, index)
          if (!this.current(item)) { this.finish(item, 'stale'); return }
          const staged = await this.host.artifacts.stage(current.to.id, directory, path, source.name, source.kind, signal)
          if (staged.sha256 !== source.sha256 || staged.size !== source.size) throw new Error('Receiving artifact digest mismatch')
          part.artifact = staged; part.localPath = path; delete part.error; this.persist(item)
        } else await this.host.artifacts.verify(part.artifact.id, current.to.id)
        if (this.host.importArtifact && !part.imported) {
          current = this.current(item); if (!current) { this.finish(item, 'stale'); return }
          part.imported = await this.host.importArtifact(current.to, part.artifact, part.localPath!, `request-handoffs/${id}/${index}-${part.artifact.name}`, signal)
          this.persist(item)
        }
      }
      if (!this.current(item)) { this.finish(item, 'stale'); return }
      if (this.host.paused() || this.host.store.tickets.get(item.toTicketId)?.hold) throw new Later('Waiting for the receiving task to resume')
      this.host.store.atomic(() => {
        if (!this.current(item)) { this.finish(item, 'stale'); return }
        const files = item.items.map(part => ({ artifactId: part.artifact!.id, sha256: part.artifact!.sha256,
          path: part.imported?.path ?? part.localPath, ...part.imported?.deviceId ? { deviceId: part.imported.deviceId } : {} }))
        this.host.note(item.toTicketId, `Original request ${item.triggerId}: transferred context is available; ${files.length} registered artifacts copied into this task.\nPrior report (context; verify): ${item.summary}\n${JSON.stringify(files)}`, `request-handoff:${id}`)
        this.finish(item, 'completed'); this.host.requestPass()
      })
    } catch (error) {
      if (error instanceof Later || this.host.lifetime.aborted) { item.state = 'queued'; this.persist(item); throw new Later('Handoff interrupted; resume from saved receipts') }
      if (!this.current(item)) { this.finish(item, 'stale'); return }
      const message = watchdogText(String(error), 700)
      this.host.store.atomic(() => {
        this.host.note(item.toTicketId, `Original request ${item.triggerId}: artifact reuse needs inspection; no successful handoff is claimed. ${message}`, `request-handoff-failed:${id}`)
        this.finish(item, 'failed', message); this.host.requestPass()
      })
    }
  }
}
