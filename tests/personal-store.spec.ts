import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { PersonalConflict } from '../src/app/personal-store.ts'
import { SCHEMA_VERSION, Store } from '../src/app/store.ts'
import type { PersonalKind } from '../src/core/personal/model.ts'
import { KV } from '../src/kv.ts'

let directory: string
let store: Store
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'personal-store-'))
  store = new Store(join(directory, 'data.sqlite'))
})
afterEach(() => {
  try { store.close() } catch { /* A Store constructor that throws has already closed its handle. */ }
  rmSync(directory, { recursive: true, force: true })
})

const at = '2026-11-05T12:00:00+08:00'
const goal = (id = 'goal-1') => ({ id, revision: 0, createdAt: at, updatedAt: at, sourceRefs: ['trigger-1'], title: 'Prepare launch',
  priority: 70, successCriteria: ['Ship'], status: 'active' as const })

/** Downgrade the initialized base DB using the schema 10 legacy outbox and leftover inbox/task tables. */
function schema10WithTicket(path: string): void {
  const db = new DatabaseSync(path)
  db.exec(`DROP TABLE outbox;
    CREATE TABLE outbox (id TEXT PRIMARY KEY, value TEXT NOT NULL, sent INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE inbox (id TEXT PRIMARY KEY, value TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE task (id TEXT PRIMARY KEY, value TEXT NOT NULL);`)
  const put = (key: string, value: unknown) => db.prepare('INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value))
  put('schema', 10)
  put('settings', { executor: { maxWorkers: 2 } })
  const ticket = { id: 't1', title: 'Existing ticket', decisionId: 'd1', channels: [], state: 'open', summary: '',
    createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
    mandate: { strength: 'explicit', policyVersion: 'v1', basis: { source: 'feishu', scope: { chatId: 'oc_team' }, sender: 'alice', addressed: 'mention' },
      actor: { source: 'feishu', id: 'alice' }, scope: 'small' },
    inputs: [], undelivered: [], assignments: [], meta: { sourceTriggerId: 'trig-1', triggerIds: ['trig-1'] } }
  db.prepare('INSERT INTO ticket VALUES (?,?)').run(ticket.id, JSON.stringify(ticket))
  db.close()
}

it('round-trips structured records and rejects stale revisions', () => {
  const saved = store.personal.save('goal', goal(), 0)

  expect(saved.revision).toBe(1)
  expect(saved.createdAt).toBe('2026-11-05T04:00:00.000Z')
  expect(store.personal.get('goal', saved.id)).toEqual(saved)
  expect(store.personal.list('goal', { status: 'active' })).toEqual([saved])

  const updated = store.personal.save('goal', { ...saved, revision: 1, updatedAt: '2026-11-05T12:01:00+08:00', priority: 80 }, 1)
  expect(updated.revision).toBe(2)
  expect(() => store.personal.save('goal', { ...saved, priority: 90 }, 1)).toThrow(PersonalConflict)
  expect(store.personal.history('goal', saved.id).map(entry => entry.revision)).toEqual([2, 1])

  store.personal.delete('goal', saved.id, 2)
  expect(store.personal.get('goal', saved.id)).toBeUndefined()
  expect(() => store.personal.save('goal', { ...updated, revision: 0 }, 0)).toThrow(PersonalConflict)
})

it('reopens schema 11 data and preserves the personal record', () => {
  const path = join(directory, 'data.sqlite')
  const saved = store.personal.save('goal', goal('pre-v12'), 0)
  store.close()
  const db = new DatabaseSync(path)
  db.prepare('UPDATE kv SET value=? WHERE key=?').run(JSON.stringify(11), KV.store.schema)
  db.close()

  store = new Store(path)
  expect(store.get(KV.store.schema)).toBe(SCHEMA_VERSION)
  expect(store.personal.get('goal', saved.id)).toEqual(saved)
  expect(store.personal.history('goal', saved.id)).toMatchObject([{ revision: 1, value: saved }])
})

it('migrates the existing schema 10 ticket fixture and opens the personal store', () => {
  store.close()
  const path = join(directory, 'data.sqlite')
  schema10WithTicket(path)

  store = new Store(path)
  expect(store.get(KV.store.schema)).toBe(SCHEMA_VERSION)
  expect(store.tickets.get('t1')).toMatchObject({ title: 'Existing ticket', origin: { triggerId: 'trig-1', triggerIds: ['trig-1'] } })
  expect(store.personal.settings()).toMatchObject({ enabled: false, timezone: 'Asia/Shanghai', digestMinutes: 180 })
  expect(store.personal.save('goal', goal('post-migration'), 0).revision).toBe(1)
})

it('rolls back records and history together with the enclosing Store transaction', () => {
  expect(() => store.atomic(() => {
    store.personal.save('goal', goal('rollback'), 0)
    throw new Error('rollback')
  })).toThrow('rollback')
  expect(store.personal.get('goal', 'rollback')).toBeUndefined()
  expect(store.personal.history('goal', 'rollback')).toEqual([])
})

it('uses settings CAS, validates IANA zones, and returns independent owner lists', () => {
  const first = store.personal.settings()
  first.ownerActors.push('mutated')
  expect(store.personal.settings().ownerActors).toEqual(['web:owner'])

  const configured = store.personal.configure({ ...store.personal.settings(), enabled: true, timezone: 'America/New_York', ownerActors: ['feishu:alice'] }, 0)
  expect(configured).toMatchObject({ revision: 1, enabled: true, timezone: 'America/New_York', ownerActors: ['feishu:alice'] })
  expect(() => store.personal.configure({ ...configured, timezone: 'Mars/Olympus' }, 1)).toThrow()
  expect(() => store.personal.configure({ ...configured, revision: 0, enabled: false }, 0)).toThrow(PersonalConflict)
})

it('forgets fact contents from the full history while retaining a minimal tombstone', () => {
  const first = store.personal.save('fact', { id: 'fact-1', revision: 0, createdAt: at, updatedAt: at, sourceRefs: [],
    subject: 'owner', predicate: 'private-note', value: 'sensitive phrase one', confidence: 1, confirmation: 'user', status: 'active' }, 0)
  const second = store.personal.save('fact', { ...first, revision: 1, updatedAt: '2026-11-05T12:01:00+08:00', value: 'sensitive phrase two' }, 1)
  store.personal.delete('fact', second.id, second.revision)
  const history = store.personal.history('fact', second.id)
  expect(history).toHaveLength(3)
  expect(history.every(entry => entry.redacted === true)).toBe(true)
  expect(JSON.stringify(history)).not.toContain('sensitive phrase')
  expect(history[0]).toMatchObject({ operation: 'delete', value: { id: second.id } })
})

it('rejects prototype kind names, impossible timestamps, and out-of-range pages', () => {
  expect(() => store.personal.list('toString' as PersonalKind)).toThrow(TypeError)
  expect(() => store.personal.save('goal', { ...goal('bad-date'), createdAt: '2026-02-30T12:00:00Z' }, 0)).toThrow()
  expect(() => store.personal.list('goal', { limit: 201 })).toThrow(RangeError)
  expect(() => store.personal.list('goal', { offset: -1 })).toThrow(RangeError)
})
