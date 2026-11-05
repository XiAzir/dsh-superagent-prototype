import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Store } from '../src/app/store.ts'
import { personalCrashChild, type CrashChild } from './fixtures/personal-crash.ts'

let directory: string | undefined
let child: CrashChild | undefined
afterEach(async () => {
  child?.kill()
  if (child) await child.stopped
  child = undefined
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = undefined
})

it('preserves committed personal history and ticket followups across an abrupt process death, then accepts the same-id CAS update', async () => {
  directory = mkdtempSync(join(tmpdir(), 'personal-crash-committed-'))
  const database = join(directory, 'store.sqlite')
  const initialized = new Store(database)
  initialized.close()

  child = personalCrashChild(database, 'committed')
  await child.ready
  child.kill()
  await child.stopped
  child = undefined

  const reopened = new Store(database)
  try {
    const fact = reopened.personal.get('fact', 'crash-fact')!
    expect(fact).toMatchObject({ revision: 1, value: 'Asia/Shanghai', confirmation: 'user', status: 'active' })
    expect(reopened.personal.history('fact', fact.id)).toMatchObject([{ revision: 1, operation: 'save', value: { id: fact.id } }])
    expect(reopened.tickets.get('crash-ticket')?.followups).toMatchObject([{ id: 'followup-1', status: 'scheduled', key: 'review' }])

    const updated = reopened.personal.save('fact', { ...fact, value: 'Asia/Tokyo', updatedAt: '2026-11-05T10:00:00.000Z' }, fact.revision)
    expect(updated).toMatchObject({ id: fact.id, revision: 2, value: 'Asia/Tokyo' })
    expect(reopened.personal.history('fact', fact.id).map(item => item.revision)).toEqual([2, 1])
  } finally { reopened.close() }
})

it('rolls back an uncommitted personal record and history after the writer process is killed', async () => {
  directory = mkdtempSync(join(tmpdir(), 'personal-crash-uncommitted-'))
  const database = join(directory, 'store.sqlite')
  const initialized = new Store(database)
  initialized.close()

  child = personalCrashChild(database, 'uncommitted')
  await child.ready
  child.kill()
  await child.stopped
  child = undefined

  const reopened = new Store(database)
  try {
    expect(reopened.personal.get('fact', 'crash-fact')).toBeUndefined()
    expect(reopened.personal.history('fact', 'crash-fact')).toEqual([])
  } finally { reopened.close() }
})
