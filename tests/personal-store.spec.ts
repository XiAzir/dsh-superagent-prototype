import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { PersonalConflict } from '../src/app/personal-store.ts'
import { Store } from '../src/app/store.ts'

let directory: string
let store: Store
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'personal-store-'))
  store = new Store(join(directory, 'data.sqlite'))
})
afterEach(() => {
  store.close()
  rmSync(directory, { recursive: true, force: true })
})

it('round-trips structured records and rejects stale revisions', () => {
  const now = '2026-11-05T12:00:00+08:00'
  const goal = store.personal.save('goal', {
    id: 'goal-1', revision: 0, createdAt: now, updatedAt: now, sourceRefs: ['trigger-1'], title: 'Prepare launch',
    priority: 70, successCriteria: ['Ship'], status: 'active',
  }, 0)

  expect(goal.revision).toBe(1)
  expect(goal.createdAt).toBe('2026-11-05T04:00:00.000Z')
  expect(store.personal.get('goal', goal.id)).toEqual(goal)
  expect(store.personal.list('goal', { status: 'active' })).toEqual([goal])

  const updated = store.personal.save('goal', { ...goal, revision: 1, updatedAt: '2026-11-05T12:01:00+08:00', priority: 80 }, 1)
  expect(updated.revision).toBe(2)
  expect(() => store.personal.save('goal', { ...goal, priority: 90 }, 1)).toThrow(PersonalConflict)
  expect(store.personal.history('goal', goal.id).map(entry => entry.revision)).toEqual([2, 1])

  store.personal.delete('goal', goal.id, 2)
  expect(store.personal.get('goal', goal.id)).toBeUndefined()
  expect(() => store.personal.save('goal', { ...updated, revision: 0 }, 0)).toThrow(PersonalConflict)
})
