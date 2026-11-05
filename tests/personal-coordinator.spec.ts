import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Store } from '../src/app/store.ts'
import { PersonalCoordinator } from '../src/app/personal-coordinator.ts'
let dir: string, store: Store, service: PersonalCoordinator
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'personal-coordinator-')); store = new Store(join(dir, 'db'))
  store.personal.configure({ ...store.personal.settings(), enabled: true }, 0)
  service = new PersonalCoordinator({ store, personalMode: () => true, now: () => new Date('2026-11-05T09:00:00Z') })
})
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
it('stores an owner goal and turns a due commitment into a repeat-safe reminder', () => {
  const goal = service.write('goal', { id: 'launch', revision: 0, value: { title: '完成交付' } })
  service.write('commitment', { id: 'quote', revision: 0, value: { title: '等报价', dueAt: '2026-11-05T16:00:00+08:00', goalIds: [goal.id] } })
  const reminders: unknown[] = []
  service.evaluateDue((item, id) => { reminders.push({ item, id }) })
  service.evaluateDue((item, id) => { reminders.push({ item, id }) })
  expect(reminders).toHaveLength(1)
  expect(store.personal.get('commitment', 'quote')).toMatchObject({ status: 'overdue', nextCheckAt: '2026-11-06T09:00:00.000Z' })
})
