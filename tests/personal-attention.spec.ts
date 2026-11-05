import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { AttentionConflict, PersonalAttentionService } from '../src/app/personal-attention.ts'
import { Store } from '../src/app/store.ts'

let directory: string
let store: Store
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'personal-attention-')); store = new Store(join(directory, 'data.sqlite')) })
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })

it('holds ordinary attention in quiet hours, sends P0 immediately, and respects the P2 digest interval', () => {
  store.personal.configure({ ...store.personal.settings(), enabled: true, timezone: 'Asia/Shanghai', quietStart: '22:00', quietEnd: '08:00', digestMinutes: 180 }, 0)
  const now = new Date('2026-11-05T23:00:00+08:00')
  const service = new PersonalAttentionService({ store, now: () => now })
  service.queue({ title: 'Quiet reminder', summary: 'wait', priority: 'P1', digestKey: 'quiet' }, 'q1')
  service.queue({ title: 'Urgent', summary: 'now', priority: 'P0', digestKey: 'urgent' }, 'q0')
  service.queue({ title: 'Digest', summary: 'later', priority: 'P2', digestKey: 'digest', notBefore: '2026-11-06T09:00:00+08:00' }, 'q2')

  expect(service.collectDue().map(item => item.priority)).toEqual(['P0'])
  const urgent = service.collectDue()[0]!
  expect(service.markSent(urgent)[0]?.status).toBe('sent')
  const afterQuiet = service.collectDue({ at: new Date('2026-11-06T08:00:00+08:00') })
  expect(afterQuiet.map(item => item.priority)).toEqual(['P1'])
  service.markSent(afterQuiet[0]!, new Date('2026-11-06T08:00:00+08:00'))
  const digest = service.collectDue({ at: new Date('2026-11-06T09:00:00+08:00') })
  expect(digest.map(item => item.priority)).toEqual(['P2'])
})

it('keeps a delivery pending until the sink confirms sent and rejects stale snapshots after a state change', async () => {
  store.personal.configure({ ...store.personal.settings(), enabled: true }, 0)
  let now = new Date('2026-11-05T12:00:00Z')
  const service = new PersonalAttentionService({ store, now: () => now })
  service.queue({ title: 'One', summary: 'first', priority: 'P1', digestKey: 'same' }, 'one')
  const old = service.collectDue()[0]!
  service.queue({ title: 'Two', summary: 'second', priority: 'P1', digestKey: 'same' }, 'two')
  service.acknowledge(old.items[0]!.id)
  expect(() => service.markSent(old)).toThrow('Stale delivery snapshot')
  expect((await service.dispatch(() => 'pending')).pending).toHaveLength(1)
  expect(store.personal.list('attention', { status: 'queued' })).toHaveLength(1)
  now = new Date('2026-11-05T12:01:00Z')
  expect((await service.dispatch(() => 'sent')).sent).toHaveLength(1)
  expect(store.personal.list('attention', { status: 'sent' })).toHaveLength(1)
})

it('treats dueAt as a deadline, lets P0 bypass notBefore, and filters stopped or missing tickets', () => {
  store.personal.configure({ ...store.personal.settings(), enabled: true, timezone: 'UTC', quietStart: '22:00', quietEnd: '08:00' }, 0)
  const now = new Date('2026-11-05T12:00:00Z')
  const service = new PersonalAttentionService({ store, now: () => now })
  service.queue({ title: 'Early deadline notice', summary: 'send now', priority: 'P1', digestKey: 'deadline', dueAt: '2026-11-05T13:00:00Z' }, 'deadline')
  service.queue({ title: 'Urgent', summary: 'send now', priority: 'P0', digestKey: 'urgent', notBefore: '2026-11-06T00:00:00Z' }, 'urgent')
  service.queue({ title: 'Stopped task', summary: 'ignore', priority: 'P0', digestKey: 'stopped', ticketId: 'gone' }, 'stopped')
  expect(service.collectDue().map(delivery => delivery.digestKey).sort()).toEqual(['deadline', 'urgent'])
})

it('handles cross-midnight quiet hours over a daylight-saving transition and rejects changed idempotency content', () => {
  store.personal.configure({ ...store.personal.settings(), enabled: true, timezone: 'America/New_York', quietStart: '22:00', quietEnd: '07:00' }, 0)
  const service = new PersonalAttentionService({ store, now: () => new Date('2026-03-08T06:30:00Z') })
  const request = { title: 'DST', summary: 'reminder', priority: 'P1' as const, digestKey: 'dst' }
  service.queue(request, 'same-request')
  expect(() => service.queue({ ...request, summary: 'changed' }, 'same-request')).toThrow(AttentionConflict)
  expect(service.collectDue({ at: new Date('2026-03-08T06:30:00Z') })).toEqual([])
  expect(service.collectDue({ at: new Date('2026-03-08T11:00:00Z') })).toHaveLength(1)
})

it('pages beyond 200 queued attention records and keeps markSent all-or-nothing for a stale batch', () => {
  store.personal.configure({ ...store.personal.settings(), enabled: true }, 0)
  const service = new PersonalAttentionService({ store, now: () => new Date('2026-11-05T12:00:00Z') })
  for (let i = 0; i < 205; i++) service.queue({ title: `Item ${i}`, summary: 'body', priority: 'P1', digestKey: 'many' }, `many-${i}`)
  const deliveries = service.collectDue()
  expect(deliveries).toHaveLength(11)
  expect(deliveries.reduce((count, delivery) => count + delivery.items.length, 0)).toBe(205)
  const batch = deliveries[0]!
  service.acknowledge(batch.items[0]!.id)
  expect(() => service.markSent(batch)).toThrow('Stale delivery snapshot')
  expect(batch.items.slice(1).every(item => store.personal.get('attention', item.id)?.status === 'queued')).toBe(true)
})
