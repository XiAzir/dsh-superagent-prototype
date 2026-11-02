/** SQLite persistence for domain aggregates, key-value state, settings history, and the channel outbox. */
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { key, threadKey, type ChannelRef, type Decision, type OutboundMessage, type ReplyStatus, type Repositories, type Thread, type ThreadFact,
  type ThreadFacts, type Ticket, type Trigger, type TriggerDisposition } from '../core/index.ts'
import { KV, type Family, type Key } from '../kv.ts'
import { SettingsSchema, type Settings, type SettingsOrigin, type SettingsSave } from '../policy.ts'
import { OLDEST_SCHEMA, SCHEMA_VERSION, migrateTo11, tooOld } from './migration.ts'
import { Versions } from './versions.ts'
import { storeReads } from './store-read.ts'
import { RoomJournal } from './room-journal.ts'

/** A Trigger's position on its thread timeline, ordered by timestamp and then `id` as tie-breaker. */
export interface TimelinePlace { at: string; id: string }
/** Why a message was dropped: its conversation can never receive it (`channelGone`), or its Source no longer listens to it (`channelIgnored`). */
export type DropReason = 'channelGone' | 'channelIgnored'
/** Outbound message receipt tracked in the outbox from the moment it is queued (`pending`, `sent`, or `dropped`); delivery attempt counts live on its `reply` effect. */
export interface Receipt extends OutboundMessage { status: ReplyStatus; dropped?: { at: string; reason: DropReason } }
/** A dropped outbound message receipt, with the timestamp and reason it was dropped. */
export type Dropped = Receipt & { dropped: { at: string; reason: DropReason } }
/** Saved settings snapshot with the policy version and ticket notifications it produced (`internal` saves have no origin). */
export interface SettingsVersion {
  revision: number; savedAt: string; source: SettingsOrigin | 'internal'; block?: SettingsSave
  policyVersion: string; policyChanged: boolean; notified: string[]; settings: Settings
}
/** Messages-free projection used to page the Web task list without loading conversation bodies. */
export interface WebTaskIndexRecord { id: string; title: string; createdAt: string; updatedAt: string; lastUserAt: string }
/**
 * Generated columns and partial indexes defining active working sets so passes scan only active rows.
 * Older databases missing a column get it added on open and populated by SQLite from stored JSON rows.
 */
const SETS: Record<string, Record<string, string>> = {
  ticket: {
    open: "INTEGER AS (CASE WHEN value -> '$.ended' IS NULL THEN 1 END)",
    // Only the latest assignment can be pending or running because the Engine closes one before adding the next.
    active: `INTEGER AS (CASE WHEN json_array_length(value, '$.undelivered') > 0
      OR value ->> '$.assignments[#-1].state' IN ('pending', 'running') THEN 1 END)`,
  },
  thread: {
    active: "INTEGER AS (CASE WHEN json_array_length(value, '$.pending') > 0 OR value -> '$.evaluating' IS NOT NULL THEN 1 END)",
    subscribed: "TEXT AS (CASE WHEN json_array_length(value, '$.subscriptions') > 0 THEN value ->> '$.ref.source' END)",
  },
  // Composite key (ticketId + thread) used to preserve per-conversation reply order.
  outbox: { dropped: "TEXT AS (value ->> '$.dropped.at')", pending: `TEXT AS (CASE WHEN value ->> '$.status' = 'pending'
    AND value ->> '$.ticketId' IS NOT NULL THEN (value ->> '$.ticketId') || ' ' || (value ->> '$.channel.thread') END)` },
}
export { SCHEMA_VERSION }
/**
 * SQLite backing store implementing domain `Repositories`, view read queries, versioned settings, outbox receipts, and key-value state.
 * The Runtime opens it after locking the state directory and automatically migrates supported older schemas on startup.
 * The Engine mutates domain aggregates inside `atomic` transactions while Sources, views, and the Outbox read state or update their own records.
 */
export class Store implements Repositories {
  readonly db: DatabaseSync
  readonly rooms: RoomJournal
  /**
   * Opens or creates the SQLite database at `path`, migrating schema 10 to schema 11 in a single transaction.
   * @param report - Receives errors thrown by `afterCommit` callbacks without failing the committed transaction.
   * @throws When the database schema is older than `OLDEST_SCHEMA` (10), newer than `SCHEMA_VERSION` (11), or when migration fails; in every case the database file is left unchanged and the SQLite handle is closed so a later attempt in the same process can open it.
   */
  constructor(path: string, private readonly report: (error: unknown) => void = () => {}) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    this.read = storeReads(this.db)
    this.rooms = new RoomJournal(this.db)
    try {
      chmodSync(path, 0o600)
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
      const version = this.get(KV.store.schema)
      if (version !== undefined && version > SCHEMA_VERSION) throw new Error(`Unsupported orchestrator database version ${version}`)
      if (version !== undefined && version < OLDEST_SCHEMA) throw new Error(tooOld(version))
      const migrating = version !== undefined && version < SCHEMA_VERSION
      try {
        this.atomic(() => {
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS trigger (id TEXT PRIMARY KEY, value TEXT NOT NULL, at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS disposition (id TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS thread (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS ticket (id TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS decision (id TEXT PRIMARY KEY, thread TEXT NOT NULL, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS web_task_summary (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL, last_user_at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS web_task_ticket (web_task_id TEXT NOT NULL, ticket_id TEXT NOT NULL,
              PRIMARY KEY (web_task_id, ticket_id));
            CREATE TABLE IF NOT EXISTS trigger_thread (thread TEXT NOT NULL, id TEXT NOT NULL, at TEXT NOT NULL, human INTEGER NOT NULL,
              PRIMARY KEY (thread, id));
            CREATE TABLE IF NOT EXISTS effect (kind TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, seq INTEGER NOT NULL,
              generation INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '', due INTEGER NOT NULL,
              since TEXT NOT NULL, PRIMARY KEY (kind, key));
            CREATE INDEX IF NOT EXISTS trigger_at ON trigger(at);
            CREATE INDEX IF NOT EXISTS trigger_thread_at ON trigger_thread(thread, at);
            CREATE INDEX IF NOT EXISTS decision_thread ON decision(thread);
            CREATE INDEX IF NOT EXISTS effect_due ON effect(kind, due, seq);
            CREATE INDEX IF NOT EXISTS web_task_summary_updated ON web_task_summary(updated_at DESC, id ASC);
            CREATE INDEX IF NOT EXISTS web_task_ticket_ticket ON web_task_ticket(ticket_id, web_task_id);
          `)
          this.rooms.setup()
          this.addColumns()
          this.backfillWebTaskIndex()
          if (migrating) migrateTo11(this)
          this.rooms.backfill()
          if (version !== SCHEMA_VERSION) this.set(KV.store.schema, SCHEMA_VERSION)
        })
      } catch (error) {
        if (!migrating) throw error
        const reason = error instanceof Error ? error.message : String(error)
        throw new Error(`The orchestrator database is unchanged at schema ${version}: its migration to schema ${SCHEMA_VERSION} failed: ${reason}`, { cause: error })
      }
    } catch (error) {
      this.db.close()
      throw error
    }
  }
  /** Builds the persistent list projection once from older Web task KV records. */
  private backfillWebTaskIndex(): void {
    const marker = 'web-task-summary-index-v2-ready'
    if (this.get(marker as Key<boolean>)) return
    this.db.exec('DELETE FROM web_task_ticket')
    const insert = this.db.prepare(`INSERT INTO web_task_summary (id, title, created_at, updated_at, last_user_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title=excluded.title, created_at=excluded.created_at,
      updated_at=excluded.updated_at, last_user_at=excluded.last_user_at`)
    for (const row of this.db.prepare("SELECT key, value FROM kv WHERE key LIKE 'web-task:%'").iterate()) {
      try {
        const task = JSON.parse(String(row.value)) as { id: string; title: string; createdAt: string; updatedAt: string; messages?: { role: string; at: string }[] }
        const lastUserAt = [...(task.messages ?? [])].reverse().find(message => message.role === 'user')?.at ?? task.createdAt
        insert.run(task.id, task.title, task.createdAt, task.updatedAt, lastUserAt)
      } catch { /* Keep malformed legacy records available through their original KV key. */ }
    }
    const link = this.db.prepare('INSERT OR IGNORE INTO web_task_ticket (web_task_id, ticket_id) VALUES (?, ?)')
    for (const row of this.db.prepare("SELECT key, value FROM thread WHERE key LIKE 'web:%'").iterate()) {
      const taskId = String(row.key).slice('web:'.length)
      if (!this.db.prepare('SELECT 1 FROM web_task_summary WHERE id=?').get(taskId)) continue
      try {
        const thread = JSON.parse(String(row.value)) as Thread
        for (const ticketId of thread.subscriptions) link.run(taskId, ticketId)
      } catch { /* A malformed thread remains available in its original record. */ }
    }
    this.db.exec(`UPDATE web_task_summary AS s SET updated_at = MAX(s.updated_at,
      COALESCE((SELECT MAX(t.value ->> '$.updatedAt') FROM web_task_ticket x JOIN ticket t ON t.id=x.ticket_id WHERE x.web_task_id=s.id), s.updated_at),
      COALESCE((SELECT MAX(d.value ->> '$.at') FROM decision d WHERE d.thread='web:' || s.id), s.updated_at))`)
    this.set(marker as Key<boolean>, true)
  }
  /** Advances an indexed Web task's activity time from its currently subscribed tickets and recorded decisions. */
  private refreshWebTaskActivity(id: string): void {
    this.db.prepare(`UPDATE web_task_summary AS s SET updated_at = MAX(s.updated_at,
      COALESCE((SELECT MAX(t.value ->> '$.updatedAt') FROM web_task_ticket x JOIN ticket t ON t.id=x.ticket_id WHERE x.web_task_id=s.id), s.updated_at),
      COALESCE((SELECT MAX(d.value ->> '$.at') FROM decision d WHERE d.thread='web:' || s.id), s.updated_at)) WHERE s.id=?`).run(id)
  }
  /** Reconciles generated working-set columns and indexes when opening databases created by earlier versions. */
  private addColumns(): void {
    const columns = (table: string) => new Set(this.db.prepare('SELECT name FROM pragma_table_xinfo(?)').all(table).map(row => String(row.name)))
    for (const [table, definitions] of Object.entries(SETS)) {
      // Drop generated columns whose definition changed or that were removed, along with their index, before adding current ones.
      const sql = String(this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)?.sql ?? '')
      const generated = this.db.prepare('SELECT name FROM pragma_table_xinfo(?) WHERE hidden IN (2, 3)').all(table).map(row => String(row.name))
      for (const name of generated) {
        if (definitions[name] && sql.includes(`${name} ${definitions[name]}`)) continue
        this.db.exec(`DROP INDEX IF EXISTS ${table}_${name}; ALTER TABLE ${table} DROP COLUMN ${name}`)
      }
      const existing = columns(table)
      for (const [name, definition] of Object.entries(definitions)) {
        if (!existing.has(name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`)
        this.db.exec(`CREATE INDEX IF NOT EXISTS ${table}_${name} ON ${table}(${name}) WHERE ${name} IS NOT NULL`)
      }
    }
    if (!columns('effect').has('generation')) this.db.exec('ALTER TABLE effect ADD COLUMN generation INTEGER NOT NULL DEFAULT 0')
  }
  /** Closes the underlying SQLite database connection. */
  close(): void { this.db.close() }
  /** Parses JSON `value` columns returned by `sql`. */
  private values<T>(sql: string, ...parameters: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...parameters).map(row => JSON.parse(String(row.value)) as T)
  }
  /** Re-indexes which threads a Trigger belongs to, replacing any rows from an earlier save of the same Trigger. */
  private indexThreads(trigger: Trigger): void {
    this.db.prepare('DELETE FROM trigger_thread WHERE id=?').run(trigger.id)
    const insert = this.db.prepare('INSERT OR IGNORE INTO trigger_thread VALUES (?,?,?,?)')
    for (const ref of trigger.threads) insert.run(threadKey(ref), trigger.id, trigger.at, trigger.human ? 1 : 0)
  }
  private depth = 0
  /** Callbacks queued to run once the outermost transaction commits, indexed by savepoint level; rolling back a level discards its callbacks. */
  private readonly committed: (() => void)[][] = []
  /**
   * Executes `operation` in a savepoint transaction (nested inside the current transaction if any); a failure rolls back its changes.
   * Post-commit callbacks run only after the outermost transaction commits, and callback errors are reported without failing the committed transaction.
   */
  atomic<T>(operation: () => T): T {
    const level = this.depth++
    const name = `orchestrator_atomic_${level}`
    this.committed[level] = []
    this.db.exec(`SAVEPOINT ${name}`)
    let value: T
    try { value = operation(); this.db.exec(`RELEASE ${name}`) }
    catch (error) { this.db.exec(`ROLLBACK TO ${name}`); this.db.exec(`RELEASE ${name}`); throw error }
    finally { this.depth-- }
    const actions = this.committed.splice(level)[0]!
    if (level) this.committed[level - 1]!.push(...actions)
    else for (const action of actions) { try { action() } catch (error) { this.report(error) } }
    return value
  }
  /**
   * Schedules `action` to run once the outermost transaction commits, or immediately if outside a transaction;
   * callbacks queued inside a transaction that rolls back are discarded and never run.
   * Use `afterCommit` for immediate in-memory follow-ups to a committed write (such as refreshing health or cancelling an in-memory turn) that cannot wait for the effect queue and need not survive a restart; use `Effects` for durable side effects that must survive a crash.
   */
  afterCommit(action: () => void): void {
    if (this.depth) this.committed[this.depth - 1]!.push(action)
    else action()
  }
  /** Reads a typed KV record by its key in `KV`. */
  get<V>(name: Key<V>): V | undefined {
    const row = this.db.prepare('SELECT value FROM kv WHERE key=?').get(name)
    return row === undefined ? undefined : JSON.parse(String(row.value)) as V
  }
  /** Writes a typed KV record under `name`. */
  set<V>(name: Key<V>, value: V): void {
    this.db.prepare('INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(name, JSON.stringify(value))
  }
  /** Deletes the KV record at `name`. */
  delete(name: string): void { this.db.prepare('DELETE FROM kv WHERE key=?').run(name) }
  /** Returns all KV keys belonging to `family` or starting with `prefix`. */
  keys<V>(family: Family<V, never>): Key<V>[]
  keys(prefix: string): string[]
  keys(family: string | { prefix: string }): string[] {
    const prefix = typeof family === 'string' ? family : family.prefix
    const pattern = `${prefix.replace(/[\\%_]/g, match => `\\${match}`)}%`
    return this.db.prepare("SELECT key FROM kv WHERE key LIKE ? ESCAPE '\\'").all(pattern).map(row => String(row.key))
  }

  /** Persisted, messages-free Web task index; write paths maintain activity times so pages use the ordering index. */
  readonly webTasks = {
    save: (task: WebTaskIndexRecord): void => this.atomic(() => {
      this.db.prepare(`INSERT INTO web_task_summary (id, title, created_at, updated_at, last_user_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET title=excluded.title, created_at=excluded.created_at,
        updated_at=MAX(updated_at, excluded.updated_at), last_user_at=MAX(last_user_at, excluded.last_user_at)`)
        .run(task.id, task.title, task.createdAt, task.updatedAt, task.lastUserAt)
      this.refreshWebTaskActivity(task.id)
    }),
    page: (offset: number, limit: number): WebTaskIndexRecord[] => this.db.prepare(`SELECT id, title, created_at AS createdAt,
      updated_at AS updatedAt, last_user_at AS lastUserAt FROM web_task_summary
      ORDER BY updated_at DESC, id ASC LIMIT ? OFFSET ?`).all(limit, offset).map(row => ({
        id: String(row.id), title: String(row.title), createdAt: String(row.createdAt), updatedAt: String(row.updatedAt), lastUserAt: String(row.lastUserAt),
      })),
  }

  /** Versioned settings snapshots; the current settings are the snapshot of the latest revision. */
  private readonly settingsVersions = new Versions<SettingsVersion>(this, KV.settings.revision, KV.settings.version)
  /** Current validated settings. */
  settings(): Settings { return SettingsSchema.parse(this.settingsVersions.current()?.settings ?? {}) }
  /** Revision of one settings block; each configuration page saves against its own block for optimistic concurrency. */
  blockRevision(block: SettingsSave): number { return this.get(KV.settings.block(block)) ?? 0 }
  /** Saves settings as the next revision (making it current) and increments `record.block`'s revision counter when present. */
  saveSettings(value: unknown, record: Omit<SettingsVersion, 'revision' | 'savedAt' | 'settings'> = { source: 'internal', policyVersion: '', policyChanged: false, notified: [] }): Settings {
    const settings = SettingsSchema.parse(value)
    return this.atomic(() => {
      this.settingsVersions.save(revision => ({ ...record, revision, savedAt: new Date().toISOString(), settings }))
      if (record.block) this.set(KV.settings.block(record.block), this.blockRevision(record.block) + 1)
      return settings
    })
  }
  /** Saved settings revisions, newest first; revisions predating settings history are absent. */
  settingsHistory(limit = 20): SettingsVersion[] { return this.settingsVersions.list(limit) }

  readonly triggers = {
    get: (id: string): Trigger | undefined => { const row = this.db.prepare('SELECT value FROM trigger WHERE id=?').get(id); return row ? JSON.parse(String(row.value)) as Trigger : undefined },
    save: (trigger: Trigger): void => this.atomic(() => {
      this.db.prepare('INSERT INTO trigger VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value, at=excluded.at').run(trigger.id, JSON.stringify(trigger), trigger.at)
      this.indexThreads(trigger)
      this.rooms.trigger(trigger)
    }),
    disposition: (id: string): TriggerDisposition | undefined => { const row = this.db.prepare('SELECT value FROM disposition WHERE id=?').get(id); return row ? JSON.parse(String(row.value)) as TriggerDisposition : undefined },
    saveDisposition: (id: string, value: TriggerDisposition): void => { this.db.prepare('INSERT INTO disposition VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(id, JSON.stringify(value)) },
  }
  readonly threads = {
    get: (keyValue: string): Thread | undefined => { const row = this.db.prepare('SELECT value FROM thread WHERE key=?').get(keyValue); return row ? JSON.parse(String(row.value)) as Thread : undefined },
    save: (thread: Thread): void => this.atomic(() => {
      this.db.prepare('INSERT INTO thread VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(thread.key, JSON.stringify(thread))
      this.rooms.thread(thread)
      if (!thread.key.startsWith('web:')) return
      const taskId = thread.key.slice('web:'.length)
      if (!this.db.prepare('SELECT 1 FROM web_task_summary WHERE id=?').get(taskId)) return
      this.db.prepare('DELETE FROM web_task_ticket WHERE web_task_id=?').run(taskId)
      const link = this.db.prepare('INSERT OR IGNORE INTO web_task_ticket (web_task_id, ticket_id) VALUES (?, ?)')
      for (const ticketId of thread.subscriptions) link.run(taskId, ticketId)
      this.refreshWebTaskActivity(taskId)
    }),
    list: (): Thread[] => this.db.prepare('SELECT value FROM thread ORDER BY rowid').all().map(row => JSON.parse(String(row.value)) as Thread),
    active: (): Thread[] => this.values('SELECT value FROM thread WHERE active = 1 ORDER BY rowid'),
    /** Updates human-facing thread metadata (`label`, `url`, and `facts`, where `null` removes a fact by ID); no-op if the thread does not exist. */
    describe: (keyValue: string, patch: { label?: string; url?: string; facts?: Record<string, ThreadFact | null> }): void => {
      const thread = this.threads.get(keyValue)
      if (!thread) return
      const facts: ThreadFacts = { ...(thread.meta.facts as ThreadFacts | undefined) }
      for (const [id, fact] of Object.entries(patch.facts ?? {})) { if (fact) facts[id] = fact; else delete facts[id] }
      const meta = { ...thread.meta, ...(patch.label === undefined ? {} : { label: patch.label }), ...(patch.url === undefined ? {} : { url: patch.url }), facts }
      if (JSON.stringify(meta) !== JSON.stringify(thread.meta)) this.threads.save({ ...thread, meta })
    },
    /** Atomically sets or removes (`undefined`) source-specific metadata keys on a thread after re-reading it; no-op if the thread does not exist. */
    patchMeta: (keyValue: string, patch: Record<string, unknown>): void => this.atomic(() => {
      const thread = this.threads.get(keyValue)
      if (!thread) return
      const meta = { ...thread.meta }
      for (const [name, value] of Object.entries(patch)) { if (value === undefined) delete meta[name]; else meta[name] = value }
      if (JSON.stringify(meta) !== JSON.stringify(thread.meta)) this.threads.save({ ...thread, meta })
    }),
  }
  readonly tickets = {
    get: (id: string): Ticket | undefined => { const row = this.db.prepare('SELECT value FROM ticket WHERE id=?').get(id); return row ? JSON.parse(String(row.value)) as Ticket : undefined },
    save: (ticket: Ticket): void => this.atomic(() => {
      const previous = this.tickets.get(ticket.id)
      this.db.prepare('INSERT INTO ticket VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(ticket.id, JSON.stringify(ticket))
      this.rooms.ticket(ticket, previous)
      this.db.prepare(`UPDATE web_task_summary SET updated_at=MAX(updated_at, ?)
        WHERE id IN (SELECT web_task_id FROM web_task_ticket WHERE ticket_id=?)`).run(ticket.updatedAt, ticket.id)
    }),
    /** Newest first. */
    list: (): Ticket[] => this.values('SELECT value FROM ticket ORDER BY rowid DESC'),
    /** Newest first. */
    open: (): Ticket[] => this.values('SELECT value FROM ticket WHERE open = 1 ORDER BY rowid DESC'),
    /** Newest first. */
    active: (): Ticket[] => this.values('SELECT value FROM ticket WHERE active = 1 ORDER BY rowid DESC'),
  }
  readonly decisions = {
    get: (id: string): Decision | undefined => { const row = this.db.prepare('SELECT value FROM decision WHERE id=?').get(id); return row ? JSON.parse(String(row.value)) as Decision : undefined },
    save: (decision: Decision): void => this.atomic(() => {
      this.db.prepare('INSERT INTO decision VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value, thread=excluded.thread').run(decision.id, decision.threadKey, JSON.stringify(decision))
      if (decision.threadKey.startsWith('web:')) this.db.prepare('UPDATE web_task_summary SET updated_at=MAX(updated_at, ?) WHERE id=?')
        .run(decision.at, decision.threadKey.slice('web:'.length))
    }),
    byThread: (threadKeyValue: string): Decision[] => this.db.prepare('SELECT value FROM decision WHERE thread=? ORDER BY rowid').all(threadKeyValue).map(row => JSON.parse(String(row.value)) as Decision),
  }
  /** Read-only queries for management views, orchestrator tools, and source polling (see `storeReads`). */
  readonly read: ReturnType<typeof storeReads>

  /** Delivery status of a queued message; receipts are retained permanently so message IDs are idempotent. */
  replyStatus(id: string): ReplyStatus | undefined { return this.receipts.get(id)?.status }
  /** Outbox message receipts for channel delivery; only `Outbox` writes to `receipts`. */
  readonly receipts = {
    get: (id: string): Receipt | undefined => this.values<Receipt>('SELECT value FROM outbox WHERE id = ?', id)[0],
    /** Pending message receipts, oldest first. */
    waiting: (): Receipt[] => this.values("SELECT value FROM outbox WHERE value ->> '$.status' = 'pending' ORDER BY rowid"),
    /** True if an earlier message for the same ticket, conversation and delivery lane is pending below the failure threshold. */
    behind: (id: string, failures: number): boolean => !!this.db.prepare(`SELECT 1 FROM outbox earlier
      JOIN outbox message ON message.id = ? LEFT JOIN effect ON effect.kind = 'reply' AND effect.key = earlier.id
      WHERE earlier.pending = message.pending AND earlier.rowid < message.rowid
        AND COALESCE(earlier.value ->> '$.delivery', 'normal') = COALESCE(message.value ->> '$.delivery', 'normal')
        AND IFNULL(effect.attempts, 0) < ? LIMIT 1`).get(id, failures),
    /**
     * Records a new pending message receipt; an already-recorded message ID keeps its original receipt.
     * @returns Whether the message ID was newly recorded.
     */
    add: (message: OutboundMessage): boolean => {
      const receipt: Receipt = { ...message, status: 'pending' }
      return this.atomic(() => {
        const added = Number(this.db.prepare('INSERT OR IGNORE INTO outbox (id, value) VALUES (?, ?)').run(message.id, JSON.stringify(receipt)).changes) > 0
        if (added) this.rooms.reply(message)
        return added
      })
    },
    /**
     * Marks a pending receipt as sent or dropped (with drop reason and timestamp), recreating the receipt if the message
     * was withdrawn while being sent so its ID cannot be queued again.
     */
    settle: (message: OutboundMessage, outcome: 'sent' | DropReason): void => {
      const settled = outcome === 'sent' ? { status: 'sent' } : { status: 'dropped', dropped: { at: new Date().toISOString(), reason: outcome } }
      const { id, channel, text, kind, ticketId } = message
      const updated = this.db.prepare("UPDATE outbox SET value = json_patch(value, ?) WHERE id = ? AND value ->> '$.status' = 'pending'")
        .run(JSON.stringify(settled), id)
      if (!Number(updated.changes)) this.db.prepare('INSERT OR IGNORE INTO outbox (id, value) VALUES (?, ?)')
        .run(id, JSON.stringify({ id, channel, text, kind, ...ticketId ? { ticketId } : {}, ...settled }))
    },
    /**
     * Withdraws a pending message that has not yet been sent.
     * @returns Whether a pending message with `id` was waiting and removed.
     */
    withdraw: (id: string): boolean =>
      Number(this.db.prepare("DELETE FROM outbox WHERE id = ? AND value ->> '$.status' = 'pending'").run(id).changes) > 0,
  }
}
export { key, threadKey }
export type { ChannelRef }
