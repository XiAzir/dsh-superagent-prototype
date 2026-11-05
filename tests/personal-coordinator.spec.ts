import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Store } from '../src/app/store.ts'
import { PersonalCoordinator } from '../src/app/personal-coordinator.ts'
import { SettingsSchema } from '../src/policy.ts'
import type { Ticket, Trigger } from '../src/core/index.ts'
let dir: string, store: Store, service: PersonalCoordinator
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'personal-coordinator-')); store = new Store(join(dir, 'db'))
  store.personal.configure({ ...store.personal.settings(), enabled: true }, 0)
  service = new PersonalCoordinator({ store, personalMode: () => true, now: () => new Date('2026-11-05T09:00:00Z') })
})
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
const timestamp = '2026-11-05T09:00:00.000Z'
function ownerTrigger(id: string, actor = 'alice', addressed: Trigger['addressed'] = 'direct'): Trigger {
  return { id, source: 'feishu', threads: [{ source: 'feishu', id: 'oc_owner:om_1' }], actor: { source: 'feishu', id: actor },
    human: true, addressed, at: timestamp, text: 'owner request', meta: {} }
}
function ownerTicket(id: string, triggerId: string, ended = false): Ticket {
  return { id, title: id, decisionId: `decision-${id}`, mandate: { strength: 'explicit', policyVersion: 'v1', basis: { via: 'listed' },
    actor: { source: 'feishu', id: 'alice' }, scope: 'personal' }, channels: [], assignments: [], inputs: [], undelivered: [],
    createdAt: timestamp, updatedAt: timestamp, origin: { triggerId, triggerIds: [triggerId] },
    ...(ended ? { ended: { at: timestamp, by: 'executor' as const, outcome: 'closed' as const } } : {}) }
}
function configureOwner(actorIds = ['alice']): void {
  const settings = SettingsSchema.parse({
    sources: { feishu: { enabled: true, config: {} } },
    policy: { sources: { feishu: { allowed: actorIds.map(id => ({ id })) } } },
  })
  store.saveSettings(settings)
  const current = store.personal.settings()
  store.personal.configure({ ...current, enabled: true, ownerActors: ['feishu:alice'] }, current.revision)
}
function addOwnerTicket(id = 'ticket-owner', trigger = ownerTrigger('trigger-owner')): Ticket {
  store.triggers.save(trigger)
  const ticket = ownerTicket(id, trigger.id)
  store.tickets.save(ticket)
  return ticket
}
it('stores an owner goal and turns a due commitment into a repeat-safe reminder', () => {
  const goal = service.write('goal', { id: 'launch', revision: 0, value: { title: '完成交付' } })
  service.write('commitment', { id: 'quote', revision: 0, value: { title: '等报价', dueAt: '2026-11-05T16:00:00+08:00', goalIds: [goal.id] } })
  const reminders: unknown[] = []
  service.evaluateDue((item, id) => { reminders.push({ item, id }) })
  service.evaluateDue((item, id) => { reminders.push({ item, id }) })
  expect(reminders).toHaveLength(1)
  expect(store.personal.get('commitment', 'quote')).toMatchObject({ status: 'overdue', nextCheckAt: '2026-11-06T09:00:00.000Z' })
})

it('allows only a listed owner direct message as the model-tool source', () => {
  configureOwner()
  const direct = ownerTrigger('direct')
  store.triggers.save(direct)
  expect(service.ownerTrigger(direct.id)).toEqual(direct)

  const stranger = ownerTrigger('stranger', 'mallory')
  const group = { ...ownerTrigger('group'), addressed: 'mention' as const }
  store.triggers.save(stranger); store.triggers.save(group)
  expect(() => service.ownerTrigger(stranger.id)).toThrow(/未获个人状态访问授权/)
  expect(() => service.ownerTrigger(group.id)).toThrow(/未获个人状态访问授权/)
})

it('limits worker context to linked owner data and excludes candidate, expired, and revoked facts', () => {
  configureOwner()
  const ticket = addOwnerTicket()
  const goal = service.write('goal', { id: 'linked-goal', revision: 0, value: { title: 'Owner goal' } })
  service.write('commitment', { id: 'linked-commitment', revision: 0, value: { title: 'Ticket work', dueAt: '2026-11-06T00:00:00Z',
    ticketIds: [ticket.id], goalIds: [goal.id] } })
  const fact = (id: string, status: 'active' | 'candidate' | 'revoked', fields: Record<string, unknown> = {}) => service.write('fact', {
    id, revision: 0, value: { subject: 'owner', predicate: id, value: `value-${id}`, scope: `ticket:${ticket.id}`, status, ...fields },
  })
  fact('confirmed', 'active')
  fact('candidate', 'candidate')
  fact('revoked', 'revoked')
  fact('expired', 'active', { validUntil: '2026-11-05T08:59:00Z' })
  const context = service.context(ticket.id)
  expect(context.commitments.map(item => item.id)).toEqual(['linked-commitment'])
  expect(context.goals.map(item => item.id)).toEqual(['linked-goal'])
  expect(context.facts.map(item => item.id)).toEqual(['confirmed'])
})

it('supersedes only a fact with matching subject, predicate, and scope', () => {
  const old = service.write('fact', { id: 'old-fact', revision: 0, value: { subject: 'owner', predicate: 'timezone', scope: 'global', value: 'UTC' } })
  const next = service.write('fact', { id: 'new-fact', revision: 0, value: { subject: old.subject, predicate: old.predicate, scope: old.scope,
    value: 'Asia/Tokyo', supersedes: old.id } })
  expect(next).toMatchObject({ status: 'active', confirmation: 'user' })
  expect(store.personal.get('fact', old.id)).toMatchObject({ status: 'superseded', revision: 2 })
  expect(() => service.write('fact', { id: 'bad-fact', revision: 0, value: { subject: 'other', predicate: old.predicate, scope: old.scope,
    value: 'Europe/Paris', supersedes: old.id } })).toThrow(/替代记录须属于同一主体/)
})

it('validates commitment goal links and required deadlines, and rolls back queued reminders with the transaction', () => {
  const goal = service.write('goal', { id: 'goal-for-link', revision: 0, value: { title: 'Goal' } })
  expect(() => service.write('commitment', { id: 'no-deadline', revision: 0, value: { title: 'Open commitment' } }))
    .toThrow(/开放事项请填写截止/)
  expect(() => service.write('commitment', { id: 'bad-goal', revision: 0, value: { title: 'Broken link', dueAt: '2026-11-06T00:00:00Z', goalIds: ['missing'] } }))
    .toThrow(/关联目标不存在/)
  service.write('commitment', { id: 'due-for-rollback', revision: 0, value: { title: 'Due', dueAt: '2026-11-05T08:00:00Z', goalIds: [goal.id] } })
  const before = store.personal.get('commitment', 'due-for-rollback')!
  expect(() => service.evaluateDue(() => { throw new Error('queue failed') })).toThrow('queue failed')
  expect(store.personal.get('commitment', before.id)).toEqual(before)
  expect(store.personal.list('attention')).toEqual([])
})

it('normalizes time conflict proposals and compares intervals in UTC', () => {
  service.write('constraint', { id: 'meeting-window', revision: 0, value: { title: 'Unavailable', kind: 'time', severity: 'hard',
    startAt: '2026-11-05T10:00:00+08:00', endAt: '2026-11-05T11:00:00+08:00', scope: 'global' } })
  expect(service.conflicts({ startAt: '2026-11-05T02:30:00Z', endAt: '2026-11-05T03:30:00Z' })).toMatchObject([
    { id: 'meeting-window', severity: 'hard' },
  ])
  expect(service.conflicts({ startAt: '2026-11-05T03:00:00Z', endAt: '2026-11-05T04:00:00Z' })).toEqual([])
})
