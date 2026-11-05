/** SQLite-backed storage for structured personal assistant records. */
import type { DatabaseSync } from 'node:sqlite'
import { PersonalSchemas, PersonalSettingsSchema, type PersonalKind, type PersonalRecordMap, type PersonalSettings } from '../core/personal/model.ts'

export class PersonalConflict extends Error {
  constructor(message = 'Personal record revision conflict') { super(message); this.name = 'PersonalConflict' }
}

export interface PersonalListOptions { limit?: number; offset?: number; status?: string; ticketId?: string; dueBefore?: string }
export interface PersonalHistoryEntry {
  kind: PersonalKind | 'settings'; id: string; revision: number; changedAt: string; operation: 'save' | 'delete'; value: unknown | null; redacted?: boolean
}

const DEFAULT_SETTINGS: PersonalSettings = {
  enabled: false, timezone: 'Asia/Shanghai', ownerActors: ['web:owner'], quietStart: '22:00', quietEnd: '08:00', digestMinutes: 180, revision: 0,
}
const iso = (value: string): string => new Date(value).toISOString()
const page = (options: PersonalListOptions) => {
  const limit = options.limit ?? 50, offset = options.offset ?? 0
  if (!Number.isInteger(limit) || limit < 1 || limit > 200 || !Number.isInteger(offset) || offset < 0) throw new RangeError('Personal list pagination is out of range')
  return { limit, offset }
}

export class PersonalStore {
  constructor(private readonly db: DatabaseSync, private readonly atomic: <T>(work: () => T) => T) {}

  get<K extends PersonalKind>(kind: K, id: string): PersonalRecordMap[K] | undefined {
    this.checkKind(kind)
    const row = this.db.prepare('SELECT value FROM personal_record WHERE kind=? AND id=?').get(kind, id)
    return row ? this.parse(kind, JSON.parse(String(row.value))) : undefined
  }

  list<K extends PersonalKind>(kind: K, options: PersonalListOptions = {}): PersonalRecordMap[K][] {
    this.checkKind(kind)
    const { limit, offset } = page(options)
    const clauses = ['kind=?'], values: (string | number)[] = [kind]
    if (options.status !== undefined) { clauses.push("json_extract(value, '$.status')=?"); values.push(options.status) }
    if (options.ticketId !== undefined) {
      if (kind === 'commitment') { clauses.push("EXISTS (SELECT 1 FROM json_each(personal_record.value, '$.ticketIds') WHERE json_each.value=?)"); values.push(options.ticketId) }
      else if (kind === 'authorization' || kind === 'action' || kind === 'attention') { clauses.push("json_extract(value, '$.ticketId')=?"); values.push(options.ticketId) }
      else return []
    }
    if (options.dueBefore !== undefined) {
      const cutoff = iso(options.dueBefore)
      const dueField = kind === 'commitment' || kind === 'attention' ? '$.dueAt' : kind === 'authorization' ? '$.expiresAt' : '$.nextCheckAt'
      clauses.push(`json_extract(value, '${dueField}') IS NOT NULL AND json_extract(value, '${dueField}')<=?`)
      values.push(cutoff)
    }
    const rows = this.db.prepare(`SELECT value FROM personal_record WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC, id ASC LIMIT ? OFFSET ?`)
      .all(...values, limit, offset)
    return rows.map(row => this.parse(kind, JSON.parse(String(row.value))))
  }

  /** Creates at revision 1 from an input revision 0, then advances exactly one revision per successful CAS update. */
  save<K extends PersonalKind>(kind: K, input: PersonalRecordMap[K], expectedRevision: number): PersonalRecordMap[K] {
    this.checkKind(kind)
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) throw new RangeError('expectedRevision must be a non-negative integer')
    const record = this.parse(kind, input)
    if (record.id.length === 0) throw new TypeError('Personal record id is required')
    return this.atomic(() => {
      const row = this.db.prepare('SELECT revision FROM personal_record WHERE kind=? AND id=?').get(kind, record.id)
      if (!row) {
        if (expectedRevision !== 0 || record.revision !== 0) throw new PersonalConflict(`Cannot create ${kind}/${record.id} at revision ${record.revision}`)
        if (this.db.prepare('SELECT 1 FROM personal_history WHERE kind=? AND record_id=? LIMIT 1').get(kind, record.id)) {
          throw new PersonalConflict(`Deleted ${kind}/${record.id} IDs cannot be reused`)
        }
        const saved = { ...record, revision: 1 }
        const json = JSON.stringify(saved)
        const inserted = this.db.prepare('INSERT OR IGNORE INTO personal_record (kind,id,value,revision,updated_at) VALUES (?,?,?,?,?)')
          .run(kind, record.id, json, saved.revision, saved.updatedAt)
        if (!Number(inserted.changes)) throw new PersonalConflict(`Personal record ${kind}/${record.id} was created concurrently`)
        this.historyInsert(kind, record.id, saved.revision, saved.updatedAt, 'save', json)
        return saved as PersonalRecordMap[K]
      }
      const currentRevision = Number(row.revision)
      if (currentRevision !== expectedRevision || record.revision !== expectedRevision) throw new PersonalConflict(`Expected ${kind}/${record.id} revision ${expectedRevision}; found ${currentRevision}`)
      const saved = { ...record, revision: currentRevision + 1 }
      const json = JSON.stringify(saved)
      const result = this.db.prepare('UPDATE personal_record SET value=?,revision=?,updated_at=? WHERE kind=? AND id=? AND revision=?')
        .run(json, saved.revision, saved.updatedAt, kind, record.id, expectedRevision)
      if (!Number(result.changes)) throw new PersonalConflict()
      this.historyInsert(kind, record.id, saved.revision, saved.updatedAt, 'save', json)
      return saved as PersonalRecordMap[K]
    })
  }

  delete(kind: PersonalKind, id: string, expectedRevision: number): void {
    this.checkKind(kind)
    this.atomic(() => {
      const row = this.db.prepare('SELECT value,revision FROM personal_record WHERE kind=? AND id=?').get(kind, id)
      if (!row || Number(row.revision) !== expectedRevision) throw new PersonalConflict(`Expected ${kind}/${id} revision ${expectedRevision}`)
      const revision = Number(row.revision) + 1, changedAt = new Date().toISOString()
      this.db.prepare('DELETE FROM personal_record WHERE kind=? AND id=? AND revision=?').run(kind, id, expectedRevision)
      if (kind === 'fact') {
        this.db.prepare("UPDATE personal_history SET value=NULL, redacted=1 WHERE kind=? AND record_id=?").run(kind, id)
        this.historyInsert(kind, id, revision, changedAt, 'delete', JSON.stringify({ id, deletedAt: changedAt }), true)
      } else this.historyInsert(kind, id, revision, changedAt, 'delete', null)
    })
  }

  history(kind: PersonalKind | 'settings', id: string, limit = 50): PersonalHistoryEntry[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new RangeError('Personal history limit is out of range')
    return this.db.prepare('SELECT revision,changed_at,operation,value,redacted FROM personal_history WHERE kind=? AND record_id=? ORDER BY revision DESC LIMIT ?')
      .all(kind, id, limit).map(row => ({ kind, id, revision: Number(row.revision), changedAt: String(row.changed_at),
        operation: String(row.operation) as 'save' | 'delete', value: row.value == null ? null : JSON.parse(String(row.value)),
        ...(Number(row.redacted) ? { redacted: true } : {}) }))
  }

  settings(): PersonalSettings {
    const row = this.db.prepare('SELECT value,revision FROM personal_settings WHERE id=1').get()
    if (!row) return { ...DEFAULT_SETTINGS, ownerActors: [...DEFAULT_SETTINGS.ownerActors] }
    return PersonalSettingsSchema.parse({ ...JSON.parse(String(row.value)), revision: Number(row.revision) })
  }

  configure(input: PersonalSettings, expectedRevision: number): PersonalSettings {
    const settings = PersonalSettingsSchema.parse(input)
    return this.atomic(() => {
      const current = this.db.prepare('SELECT revision FROM personal_settings WHERE id=1').get()
      const revision = current ? Number(current.revision) : 0
      if (revision !== expectedRevision || settings.revision !== expectedRevision) throw new PersonalConflict(`Expected personal settings revision ${expectedRevision}; found ${revision}`)
      const saved = { ...settings, revision: revision + 1 }
      const json = JSON.stringify({ ...saved, revision: undefined })
      this.db.prepare('INSERT INTO personal_settings (id,value,revision,updated_at) VALUES (1,?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value,revision=excluded.revision,updated_at=excluded.updated_at')
        .run(json, saved.revision, new Date().toISOString())
      this.historyInsert('settings', 'global', saved.revision, new Date().toISOString(), 'save', JSON.stringify(saved))
      return saved
    })
  }

  private parse<K extends PersonalKind>(kind: K, input: unknown): PersonalRecordMap[K] {
    return PersonalSchemas[kind].parse(input) as PersonalRecordMap[K]
  }
  private checkKind(kind: string): asserts kind is PersonalKind {
    if (!Object.hasOwn(PersonalSchemas, kind)) throw new TypeError(`Unknown personal record kind: ${kind}`)
  }
  private historyInsert(kind: PersonalKind | 'settings', id: string, revision: number, at: string, operation: 'save' | 'delete', value: string | null, redacted = false): void {
    this.db.prepare('INSERT INTO personal_history (kind,record_id,revision,changed_at,operation,value,redacted) VALUES (?,?,?,?,?,?,?)')
      .run(kind, id, revision, at, operation, value, redacted ? 1 : 0)
  }
}
