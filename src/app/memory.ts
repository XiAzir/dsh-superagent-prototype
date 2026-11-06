/** Progressive, versioned memory with scoped retrieval, source evidence and durable correction delivery. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Store } from './store.ts'
import type { Tool } from './tools/tool.ts'
import { memoryEffective, memoryScopeMatch, memorySearchDocument, rankMemories } from './memory-retrieval.ts'
import { MemorySourceSchema, resolveMemorySources, type MemorySource, type MemorySourceInput, type MemorySourceResolver } from './memory-sources.ts'

export type { MemorySource, MemorySourceInput, MemorySourceResolver } from './memory-sources.ts'
export { parseMemorySource } from './memory-sources.ts'
const tool = <S extends z.ZodType>(definition: Tool<S>): Tool => definition as unknown as Tool

export type MemoryStatus = 'active' | 'archived' | 'candidate'
export type MemoryEvidence = 'user' | 'verified' | 'inferred' | 'legacy'
export interface MemoryReference { topic: string; revision: number }
export interface MemoryMetadata {
  topic: string; title: string; summary: string; revision: number; status: MemoryStatus; updatedAt: string; sources: string[]
  sourceRefs?: MemorySource[]
  scopes?: string[]
  aliases?: string[]
  importance?: number
  evidence?: MemoryEvidence
  confidence?: 'supported' | 'unresolved' | 'inferred' | 'legacy'
  confirmedAt?: string
  validFrom?: string
  validUntil?: string
  supersedes?: MemoryReference[]
  supersededBy?: MemoryReference
  conflicts?: MemoryReference[]
  correctionReason?: string
}
export interface MemoryVersion extends MemoryMetadata { content: string }
export type MemoryStore = Pick<Store, 'get' | 'set' | 'keys' | 'atomic'>
export interface MemorySearchDocument { heading: string; terms: string[] }
export interface MemoryContext { query?: string; scopes?: string[]; ticketId?: string }
export interface MemoryReadArgs extends MemoryContext {
  topic?: string; revision?: number; offset?: number; limit?: number
  /** A directory filter; omitting it preserves the historical all-status directory behavior. */
  status?: MemoryStatus
  includeExpired?: boolean
}
export interface MemorySaveArgs {
  topic: string; title: string; summary: string; content: string; expected_revision: number
  status?: MemoryStatus; sources: (string | MemorySourceInput)[]; scopes?: string[]; aliases?: string[]; importance?: number
  evidence?: MemoryEvidence; confirmed_at?: string; valid_from?: string | null; valid_until?: string | null
  supersedes?: MemoryReference[]; conflicts?: MemoryReference[]; correction_reason?: string
}
interface MemoryUsage { topic: string; revision: number; ticketId: string; at: string; retired?: boolean }
export interface MemoryCorrection {
  id: string; ticketId: string; topic: string; previousRevision: number; revision: number
  kind: 'corrected' | 'archived' | 'superseded' | 'conflict' | 'expired'
  summary: string; reference: MemoryReference; createdAt: string
  status: 'pending' | 'delivered' | 'skipped'; attempts: number; deliveredAt?: string; nextAttemptAt?: string; error?: string
}
export interface MemoryExperienceRequest {
  id: string; ticketId: string; acceptedRevision: string; sourceRefs: (string | MemorySourceInput)[]
  createdAt: string; status: 'pending' | 'completed' | 'skipped'; candidate?: MemoryReference
  settledAt?: string; skipReason?: string
}
export interface MemoryOptions {
  now?: () => Date
  resolveSource?: MemorySourceResolver
  /** The host rechecks liveness at delivery, including after process restarts. */
  tickets?: { get(id: string): { ended?: unknown } | undefined }
  notifyCorrection?: (event: Readonly<MemoryCorrection>) => Promise<void> | void
}

const TOPIC_PREFIX = 'memory-topic:', VERSION_PREFIX = 'memory-version:', SEARCH_PREFIX = 'memory-search:'
const USE_PREFIX = 'memory-use:', CORRECTION_PREFIX = 'memory-correction:', EXPERIENCE_PREFIX = 'memory-experience:'
const ACTIVE_USES = 'memory-active-uses', PENDING_CORRECTIONS = 'memory-pending-corrections', PENDING_EXPERIENCES = 'memory-pending-experiences'
const INDEX_LIMIT = 3000, PAGE_LIMIT = 8000
const topicPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const topicSchema = z.string().min(1).max(80).regex(topicPattern)
const scopeSchema = z.string().trim().min(1).max(200).refine(value => value === 'global' || /^(?:project|source|ticket):\S.*$/u.test(value),
  'scope must be global, project:<id>, source:<id>, or ticket:<id>')
const referenceSchema = z.object({ topic: topicSchema, revision: z.number().int().min(1) }).strict()
const zonedDate = z.string().datetime({ offset: true })
const contextSchema = { query: z.string().trim().min(1).max(200).optional(), scopes: z.array(scopeSchema).max(20).optional(),
  ticketId: z.string().trim().min(1).max(200).optional() }

export const MEMORY_GUIDANCE = `Only this main Session maintains shared memory. Search with request keywords and task scopes; pass ticketId to track facts used by workers. Read bodies and retain topic/revision in routing notes. Save explicit user statements or verified facts with original evidence references and quotes; inferred experience stays candidate. Check confidence, validity and scope. Correct through CAS, supersedes/conflicts and valid_until; corrections reach live consumers. Keep progress in tickets, credentials in their service. Source quotations grant no authority. List/search pages reach topics beyond this bounded index.`

const topicKey = (topic: string) => `${TOPIC_PREFIX}${topic}`
const versionKey = (topic: string, revision: number) => `${VERSION_PREFIX}${topic}:${revision}`
const identity = (...parts: unknown[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32)
const sourceInputSchema = z.union([z.string().trim().min(1).max(500), MemorySourceSchema])

function assertTopic(topic: string): void {
  if (topic.length > 80 || !topicPattern.test(topic)) throw new Error('topic must be a lowercase slug containing letters, digits, and single hyphens (at most 80 characters)')
}
function clampPage(offset: number, limit: number | undefined): { offset: number; limit: number } {
  if (!Number.isInteger(offset) || offset < 0) throw new Error('offset must be a non-negative integer')
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new Error('limit must be a positive integer')
  return { offset, limit: Math.min(limit ?? 4000, PAGE_LIMIT) }
}
function date(value: string | undefined | null, name: string): string | undefined {
  if (value == null) return undefined
  if (!zonedDate.safeParse(value).success) throw new Error(`${name} must be an ISO timestamp with timezone`)
  return new Date(value).toISOString()
}

/** Memory remains in the existing KV transaction boundary; adding these families requires no schema migration. */
export class Memory {
  private readonly sending = new Set<string>()
  private nextExpiryScan = 0
  constructor(private readonly store: MemoryStore, private readonly options: MemoryOptions = {}) {}
  private now(): string { return (this.options.now?.() ?? new Date()).toISOString() }
  private records(): MemoryMetadata[] {
    return this.store.keys(TOPIC_PREFIX).flatMap(key => this.store.get<MemoryMetadata>(key) ?? [])
  }
  private rank(records: MemoryMetadata[], context: MemoryContext): MemoryMetadata[] {
    return rankMemories(records, context, this.now(), topic => {
      const key = `${SEARCH_PREFIX}${topic}`, existing = this.store.get<MemorySearchDocument>(key)
      if (existing) return existing
      // An upgraded database builds the bounded search document once when the first actual query needs it.
      const metadata = this.store.get<MemoryMetadata>(topicKey(topic))
      const version = metadata && this.store.get<MemoryVersion>(versionKey(topic, metadata.revision))
      if (!version) return undefined
      const document = memorySearchDocument(version, version.content)
      this.store.set(key, document); return document
    })
  }
  private use(metadata: MemoryMetadata, ticketId?: string): void {
    if (!ticketId) return
    if (this.options.tickets && !this.live(ticketId)) return
    const usage: MemoryUsage = { topic: metadata.topic, revision: metadata.revision, ticketId, at: this.now() }
    this.store.atomic(() => {
      const key = `${USE_PREFIX}${identity(metadata.topic, ticketId)}`
      this.store.set(key, usage); this.addPending(ACTIVE_USES, key)
    })
  }
  private live(ticketId: string): boolean {
    const ticket = this.options.tickets?.get(ticketId)
    return !!ticket && !ticket.ended
  }
  private pending(key: string, prefix: string, eligible: (value: Record<string, unknown>) => boolean): string[] {
    const stored = this.store.get<string[]>(key)
    if (stored) return stored
    const ids = this.store.keys(prefix).filter(id => {
      const value = this.store.get<Record<string, unknown>>(id)
      return !!value && eligible(value)
    })
    this.store.set(key, ids); return ids
  }
  private addPending(key: string, id: string): void {
    const items = this.queueItems(key)
    if (!items.includes(id)) this.store.set(key, [...items, id])
  }
  private removePending(key: string, id: string): void {
    this.store.set(key, this.queueItems(key).filter(item => item !== id))
  }
  private queueItems(key: string): string[] {
    if (key === ACTIVE_USES) return this.pending(key, USE_PREFIX, value => !value.retired)
    return this.pending(key, key === PENDING_CORRECTIONS ? CORRECTION_PREFIX : EXPERIENCE_PREFIX, value => value.status === 'pending')
  }

  /** A request can select relevant scoped summaries while every omitted topic remains reachable by paged reads. */
  index(context: MemoryContext = {}): string {
    const active = this.records().filter(item => memoryEffective(item, this.now()))
    const records = this.rank(active, context)
    const lines = [`Long-term memory: ${active.length} active topics; ${records.length} relevant. Read bodies on demand; list/search with orchestrator_memory_read.`]
    for (const item of records.slice(0, 30)) {
      const row = `- ${item.topic} | ${item.title.replace(/\s+/gu, ' ').slice(0, 100)} | r${item.revision} ${item.status} ${item.confidence ?? 'legacy'}`
      const summary = `  ${item.summary.replace(/\s+/gu, ' ').slice(0, 180)}`
      const candidate = [...lines, row, summary].join('\n')
      if (candidate.length > INDEX_LIMIT) {
        const room = INDEX_LIMIT - lines.join('\n').length - row.length - 2
        if (room > 0) { lines.push(row, `  ${item.summary.slice(0, Math.max(0, room - 2))}`); this.use(item, context.ticketId) }
        break
      }
      lines.push(row, summary); this.use(item, context.ticketId)
    }
    return lines.join('\n').slice(0, INDEX_LIMIT)
  }

  /** Body reads retain history and expose temporal/evidence state so old records cannot silently masquerade as current. */
  read(args: MemoryReadArgs): unknown {
    const { offset, limit } = clampPage(args.offset ?? 0, args.limit)
    if (args.topic === undefined) {
      if (args.revision !== undefined) throw new Error('revision requires topic')
      let records = this.records()
      if (args.status) records = records.filter(item => item.status === args.status)
      if (args.includeExpired === false) records = records.filter(item => memoryEffective(item, this.now()))
      const all = this.rank(records, args)
      const page = all.slice(offset, offset + Math.min(args.limit ?? 20, 50))
      for (const item of page) if (memoryEffective(item, this.now())) this.use(item, args.ticketId)
      const items = page.map(({ sources: _sources, sourceRefs: _sourceRefs, ...metadata }) => ({ ...metadata, effective: memoryEffective(metadata as MemoryMetadata, this.now()) }))
      return { items, offset, next_offset: offset + items.length < all.length ? offset + items.length : null, total: all.length }
    }
    assertTopic(args.topic)
    const current = this.store.get<MemoryMetadata>(topicKey(args.topic))
    if (!current) throw new Error(`unknown memory topic: ${args.topic}`)
    if (memoryScopeMatch(current, args) < 0) throw new Error('memory topic is outside the requested task scope')
    const revision = args.revision ?? current.revision
    if (!Number.isInteger(revision) || revision < 1) throw new Error('revision must be a positive integer')
    const version = this.store.get<MemoryVersion>(versionKey(args.topic, revision))
    if (!version) throw new Error(`memory topic ${args.topic} has no revision ${revision}`)
    if (revision === current.revision && memoryEffective(current, this.now())) this.use(current, args.ticketId)
    const content = version.content.slice(offset, offset + limit)
    return { ...version, content, current_revision: current.revision, effective: revision === current.revision && memoryEffective(version, this.now()),
      offset, next_offset: offset + content.length < version.content.length ? offset + content.length : null, total: version.content.length }
  }

  /** Save immutable revisions, source confidence and replacement relations in one transaction. */
  save(args: MemorySaveArgs): MemoryMetadata {
    assertTopic(args.topic)
    if (args.title.trim().length < 1 || args.title.length > 100) throw new Error('title must contain 1 to 100 characters')
    if (args.summary.trim().length < 1 || args.summary.length > 180) throw new Error('summary must contain 1 to 180 characters')
    if (args.content.length > 24000) throw new Error('content must be at most 24000 characters')
    if (!Number.isInteger(args.expected_revision) || args.expected_revision < 0) throw new Error('expected_revision must be a non-negative integer')
    if (args.status !== undefined && !['active', 'archived', 'candidate'].includes(args.status)) throw new Error('status must be active, archived or candidate')
    const now = this.now(), resolved = resolveMemorySources(args.sources, now, this.options.resolveSource)
    const evidence = args.evidence ?? 'legacy'
    if (!['user', 'verified', 'inferred', 'legacy'].includes(evidence)) throw new Error('unknown memory evidence type')
    const confidence: MemoryMetadata['confidence'] = evidence === 'inferred' ? 'inferred' : evidence === 'legacy' ? 'legacy'
      : resolved.sourceRefs.some(source => source.resolution === 'resolved' && !!source.quote) ? 'supported' : 'unresolved'
    const scopes = args.scopes === undefined ? undefined : z.array(scopeSchema).min(1).max(20).parse(args.scopes)
    const aliases = args.aliases === undefined ? undefined : z.array(z.string().trim().min(1).max(100)).max(20).parse(args.aliases)
    if (args.importance !== undefined && (!Number.isInteger(args.importance) || args.importance < 0 || args.importance > 100)) throw new Error('importance must be an integer between 0 and 100')
    const confirmedAt = date(args.confirmed_at, 'confirmed_at')
    if (confirmedAt && confirmedAt > now) throw new Error('confirmed_at must not be in the future')
    const supersedes = z.array(referenceSchema).max(16).parse(args.supersedes ?? [])
    const conflicts = z.array(referenceSchema).max(16).parse(args.conflicts ?? [])
    if (args.correction_reason !== undefined && (!args.correction_reason.trim() || args.correction_reason.length > 1000)) throw new Error('correction_reason must contain 1 to 1000 characters')
    return this.store.atomic(() => {
      const current = this.store.get<MemoryMetadata>(topicKey(args.topic)), actual = current?.revision ?? 0
      if (actual !== args.expected_revision) throw new Error(`memory revision conflict for ${args.topic}: expected ${args.expected_revision}, current is ${actual}`)
      for (const ref of [...supersedes, ...conflicts]) {
        const target = this.store.get<MemoryMetadata>(topicKey(ref.topic))
        if (!target || target.revision !== ref.revision) throw new Error(`memory reference conflict for ${ref.topic}: expected current revision ${ref.revision}`)
        if (ref.topic === args.topic) throw new Error('same-topic corrections are recorded automatically; use supersedes/conflicts for other topics')
      }
      const validFrom = args.valid_from === undefined ? current?.validFrom : date(args.valid_from, 'valid_from')
      const validUntil = args.valid_until === undefined ? current?.validUntil : date(args.valid_until, 'valid_until')
      if (validFrom && validUntil && validFrom >= validUntil) throw new Error('valid_until must follow valid_from')
      const candidate = confidence === 'inferred' || confidence === 'unresolved'
      const status = args.status ?? (candidate ? 'candidate' : current?.status === 'candidate' ? 'active' : current?.status ?? 'active')
      if (status === 'active' && candidate) throw new Error('resolve user/verified evidence or confirm inferred evidence before activating memory')
      if (current?.status === 'active' && candidate && status !== 'archived') throw new Error('save uncertain corrections as a separate candidate with conflicts to preserve the active fact')
      if (supersedes.length && (status !== 'active' || confidence !== 'supported')) throw new Error('cross-topic replacements require active, resolved evidence')
      if (supersedes.some(ref => conflicts.some(other => other.topic === ref.topic))) throw new Error('a topic cannot be superseded and conflicted in the same revision')
      const metadata: MemoryMetadata = { topic: args.topic, title: args.title.trim(), summary: args.summary.trim(), revision: actual + 1, status,
        updatedAt: now, ...resolved, evidence, confidence, scopes: scopes ?? current?.scopes ?? ['global'], aliases: aliases ?? current?.aliases ?? [],
        importance: args.importance ?? current?.importance ?? 50,
        ...confidence === 'supported' ? { confirmedAt: confirmedAt ?? now } : {},
        ...validFrom ? { validFrom } : {}, ...validUntil ? { validUntil } : {},
        ...current || supersedes.length ? { supersedes: [...current ? [{ topic: current.topic, revision: current.revision }] : [], ...supersedes] } : {},
        ...conflicts.length ? { conflicts } : {}, ...args.correction_reason ? { correctionReason: args.correction_reason.trim() } : {} }
      if (supersedes.length && !memoryEffective(metadata, now)) throw new Error('a cross-topic replacement must be effective now; retain future changes as separate candidates')
      this.write(metadata, args.content)
      if (current) this.queueCorrections(current, metadata, status === 'archived' ? 'archived' : 'corrected')
      for (const ref of supersedes) {
        const old = this.store.get<MemoryVersion>(versionKey(ref.topic, ref.revision))!
        const replacement: MemoryMetadata = { ...old, revision: old.revision + 1, status: 'archived', updatedAt: now,
          supersededBy: { topic: metadata.topic, revision: metadata.revision } }
        this.write(replacement, old.content)
        this.queueCorrections(old, metadata, 'superseded')
      }
      for (const ref of conflicts) this.queueCorrections(this.store.get<MemoryMetadata>(topicKey(ref.topic))!, metadata, 'conflict')
      return metadata
    })
  }
  private write(metadata: MemoryMetadata, content: string): void {
    // Metadata never carries a version body's content even when archiving from a full historical object.
    const { content: _content, ...clean } = metadata as MemoryMetadata & { content?: string }
    this.store.set(versionKey(clean.topic, clean.revision), { ...clean, content })
    this.store.set(topicKey(clean.topic), clean)
    this.store.set(`${SEARCH_PREFIX}${clean.topic}`, memorySearchDocument(clean, content))
  }
  private queueCorrections(previous: MemoryMetadata, next: MemoryMetadata, kind: MemoryCorrection['kind']): void {
    for (const key of this.pending(ACTIVE_USES, USE_PREFIX, value => !value.retired)) {
      const usage = this.store.get<MemoryUsage>(key)
      if (!usage || usage.retired || usage.topic !== previous.topic || usage.revision > previous.revision) continue
      const id = `${CORRECTION_PREFIX}${identity(usage.ticketId, previous.topic, usage.revision, next.topic, next.revision, kind)}`
      if (this.store.get(id)) continue
      this.store.set<MemoryCorrection>(id, { id, ticketId: usage.ticketId, topic: previous.topic, previousRevision: usage.revision,
        revision: next.revision, kind, summary: next.summary, reference: { topic: next.topic, revision: next.revision },
        createdAt: this.now(), status: 'pending', attempts: 0 })
      this.addPending(PENDING_CORRECTIONS, id)
      if (kind === 'superseded' && previous.topic !== next.topic) {
        // Follow the replacement chain immediately, so a second correction arriving before delivery still reaches this task.
        this.store.set(key, { ...usage, retired: true })
        this.removePending(ACTIVE_USES, key)
        const nextKey = `${USE_PREFIX}${identity(next.topic, usage.ticketId)}`
        this.store.set<MemoryUsage>(nextKey,
          { topic: next.topic, revision: next.revision, ticketId: usage.ticketId, at: this.now() })
        this.addPending(ACTIVE_USES, nextKey)
      }
    }
  }

  /** The host uses event.id as the Engine input id; a crash after delivery safely retries that same id. */
  async flushCorrections(deliver = this.options.notifyCorrection): Promise<void> {
    if (!deliver || !this.options.tickets) return
    this.queueExpiredUses()
    for (const key of this.pending(PENDING_CORRECTIONS, CORRECTION_PREFIX, value => value.status === 'pending')) {
      const event = this.store.get<MemoryCorrection>(key)
      if (!event || event.status !== 'pending' || this.sending.has(event.id)) continue
      if (event.nextAttemptAt && event.nextAttemptAt > this.now()) continue
      if (!this.live(event.ticketId)) {
        this.store.atomic(() => { this.store.set(key, { ...event, status: 'skipped' }); this.removePending(PENDING_CORRECTIONS, key) }); continue
      }
      const current = this.store.get<MemoryMetadata>(topicKey(event.reference.topic))
      if (!current || current.revision !== event.reference.revision) {
        this.store.atomic(() => { this.store.set(key, { ...event, status: 'skipped' }); this.removePending(PENDING_CORRECTIONS, key) }); continue
      }
      this.sending.add(event.id)
      try {
        await deliver(event)
        this.store.atomic(() => {
          this.store.set(key, { ...event, status: 'delivered', deliveredAt: this.now(), attempts: event.attempts + 1, nextAttemptAt: undefined, error: undefined })
          this.removePending(PENDING_CORRECTIONS, key)
        })
      } catch (error) {
        const delay = Math.min(60_000, 1000 * 2 ** Math.min(6, event.attempts))
        this.store.set(key, { ...event, attempts: event.attempts + 1, nextAttemptAt: new Date(Date.parse(this.now()) + delay).toISOString(),
          error: String(error).slice(0, 500) })
      } finally { this.sending.delete(event.id) }
    }
  }
  private queueExpiredUses(): void {
    const now = this.now()
    if (Date.parse(now) < this.nextExpiryScan) return
    this.nextExpiryScan = Date.parse(now) + 60_000
    for (const key of this.pending(ACTIVE_USES, USE_PREFIX, value => !value.retired)) {
      const usage = this.store.get<MemoryUsage>(key)
      if (!usage || usage.retired) continue
      if (!this.live(usage.ticketId)) {
        this.store.atomic(() => { this.store.set(key, { ...usage, retired: true }); this.removePending(ACTIVE_USES, key) }); continue
      }
      const current = this.store.get<MemoryMetadata>(topicKey(usage.topic))
      if (!current || current.status !== 'active' || !current.validUntil || current.validUntil > now) continue
      const id = `${CORRECTION_PREFIX}${identity(usage.ticketId, current.topic, usage.revision, current.topic, current.revision, 'expired')}`
      if (this.store.get(id)) continue
      this.store.atomic(() => {
        this.store.set<MemoryCorrection>(id, { id, ticketId: usage.ticketId, topic: current.topic, previousRevision: usage.revision,
          revision: current.revision, kind: 'expired', summary: `Expired at ${current.validUntil}: ${current.summary}`,
          reference: { topic: current.topic, revision: current.revision }, createdAt: now, status: 'pending', attempts: 0 })
        this.addPending(PENDING_CORRECTIONS, id)
      })
    }
  }
  corrections(ticketId?: string): MemoryCorrection[] {
    return this.store.keys(CORRECTION_PREFIX).flatMap(key => this.store.get<MemoryCorrection>(key) ?? [])
      .filter(item => !ticketId || item.ticketId === ticketId).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  }

  /** Verification completion can enqueue extraction; generated experience remains an inferred candidate. */
  queueExperience(args: { ticketId: string; acceptedRevision: string; sources: (string | MemorySourceInput)[] }): MemoryExperienceRequest {
    if (!args.ticketId.trim() || !args.acceptedRevision.trim()) throw new Error('experience extraction needs a ticket and accepted revision')
    resolveMemorySources(args.sources, this.now(), this.options.resolveSource)
    const id = `${EXPERIENCE_PREFIX}${identity(args.ticketId, args.acceptedRevision)}`
    return this.store.atomic(() => {
      const existing = this.store.get<MemoryExperienceRequest>(id)
      if (existing) {
        if (JSON.stringify(existing.sourceRefs) !== JSON.stringify(args.sources)) throw new Error('accepted experience revision was reused with different sources')
        return existing
      }
      const request: MemoryExperienceRequest = { id, ticketId: args.ticketId, acceptedRevision: args.acceptedRevision,
        sourceRefs: args.sources, createdAt: this.now(), status: 'pending' }
      this.store.set(id, request); this.addPending(PENDING_EXPERIENCES, id); return request
    })
  }
  pendingExperiences(): MemoryExperienceRequest[] {
    return this.pending(PENDING_EXPERIENCES, EXPERIENCE_PREFIX, value => value.status === 'pending')
      .flatMap(key => this.store.get<MemoryExperienceRequest>(key) ?? []).filter(item => item.status === 'pending')
  }
  experience(id: string): MemoryExperienceRequest | undefined { return this.store.get<MemoryExperienceRequest>(id) }
  experienceFor(ticketId: string, acceptedRevision: string): MemoryExperienceRequest | undefined {
    return this.experience(`${EXPERIENCE_PREFIX}${identity(ticketId, acceptedRevision)}`)
  }
  /** A durable terminal result for tasks without reusable knowledge or whose accepted evidence expired. */
  skipExperience(id: string, reason: string): MemoryExperienceRequest {
    if (!reason.trim() || reason.length > 1000) throw new Error('experience skip reason must contain 1 to 1000 characters')
    return this.store.atomic(() => {
      const request = this.experience(id)
      if (!request) throw new Error('unknown memory experience request')
      if (request.status !== 'pending') return request
      const skipped: MemoryExperienceRequest = { ...request, status: 'skipped', settledAt: this.now(), skipReason: reason.trim() }
      this.store.set(id, skipped); this.removePending(PENDING_EXPERIENCES, id)
      return skipped
    })
  }
  completeExperience(id: string, candidate: Pick<MemorySaveArgs, 'topic' | 'title' | 'summary' | 'content' | 'scopes' | 'aliases'>,
    citedSources?: (string | MemorySourceInput)[]): MemoryMetadata {
    return this.store.atomic(() => {
      const request = this.store.get<MemoryExperienceRequest>(id)
      if (!request) throw new Error('unknown memory experience request')
      if (request.status === 'skipped') throw new Error('memory experience request has already been skipped')
      if (request.status === 'completed') {
        const { content: _content, ...metadata } = this.store.get<MemoryVersion>(versionKey(request.candidate!.topic, request.candidate!.revision))!
        return metadata
      }
      if (citedSources?.some(source => !request.sourceRefs.some(original => JSON.stringify(source) === JSON.stringify(original)))) {
        throw new Error('experience candidate source was absent from the accepted request')
      }
      const metadata = this.save({ ...candidate, expected_revision: 0, status: 'candidate', evidence: 'inferred', sources: citedSources ?? request.sourceRefs })
      this.store.set(id, { ...request, status: 'completed', settledAt: this.now(), candidate: { topic: metadata.topic, revision: metadata.revision } })
      this.removePending(PENDING_EXPERIENCES, id)
      return metadata
    })
  }

  /** Tools preserve existing names; context parameters explicitly identify the recipient task and applicable scopes. */
  tools(): Tool[] {
    return [
      tool({ name: 'orchestrator_memory_read',
        description: 'Search scoped memory; topic reads versioned body. ticketId tracks use for later corrections. Inspect confidence/effective before use.',
        schema: z.object({ topic: topicSchema.optional(), ...contextSchema, revision: z.number().int().min(1).optional(),
          status: z.enum(['active', 'archived', 'candidate']).optional(), includeExpired: z.boolean().optional(),
          offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(PAGE_LIMIT).optional()
            .describe('Body characters (default 4000, max 8000), or directory items (default 20, max 50).') }).strict(),
        execute: async args => this.read(args) }),
      tool({ name: 'orchestrator_memory_save',
        description: 'Save CAS memory with original sources. User/verified evidence needs resolved references for active status; inferred facts stay candidate. Record corrections and validity.',
        schema: z.object({ topic: topicSchema, title: z.string().trim().min(1).max(100), summary: z.string().trim().min(1).max(180),
          content: z.string().max(24000), expected_revision: z.number().int().min(0), status: z.enum(['active', 'archived', 'candidate']).optional(),
          sources: z.array(sourceInputSchema).min(1).max(16), scopes: z.array(scopeSchema).min(1).max(20).optional(),
          aliases: z.array(z.string().trim().min(1).max(100)).max(20).optional(), importance: z.number().int().min(0).max(100).optional(),
          evidence: z.enum(['user', 'verified', 'inferred', 'legacy']).optional(), confirmed_at: zonedDate.optional(),
          valid_from: zonedDate.nullable().optional(), valid_until: zonedDate.nullable().optional(),
          supersedes: z.array(referenceSchema).max(16).optional(), conflicts: z.array(referenceSchema).max(16).optional(),
          correction_reason: z.string().trim().min(1).max(1000).optional() }).strict(), execute: async args => this.save(args) }),
    ]
  }
}
