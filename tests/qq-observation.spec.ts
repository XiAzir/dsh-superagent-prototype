import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { Ticket } from '../src/core/index.ts'
import { Store } from '../src/app/store.ts'
import { QqObservationBudget, type ObservationLimits } from '../src/app/qq-observation.ts'

let directory: string, store: Store, budget: QqObservationBudget, enabled: boolean, now: Date
const limits: ObservationLimits = { maxActiveTasks: 1, maxCandidatesPerHour: 2, maxInputCharsPerHour: 1000,
  maxTaskMinutes: 10, maxModelCallsPerDay: 2, maxTokensPerDay: 1000 }
const make = () => new QqObservationBudget({ store, limits: () => limits, allowed: () => enabled }, () => now)
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'qq-observation-')); store = new Store(join(directory, 'state.sqlite'))
  now = new Date('2026-11-07T00:00:00.000Z'); enabled = true; budget = make()
})
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
function task(id: string): Ticket {
  const at = now.toISOString(), origin = `origin-${id}`
  store.triggers.save({ id: origin, source: 'qq', actor: { source: 'qq', id: '12345' }, human: true,
    threads: [{ source: 'qq', id: 'window' }], text: 'Observed defect', at, meta: { observation: { groupId: '23456', windowId: 'window' } } })
  const ticket: Ticket = { id, title: id, decisionId: `decision-${id}`, mandate: { actor: { source: 'qq', id: '12345' }, scope: 'Reproduce',
    strength: 'inferred', policyVersion: 'v1', basis: { via: 'listed' } }, channels: [], assignments: [{ id: `assignment-${id}`, state: 'pending', createdAt: at }],
    createdAt: at, updatedAt: at, inputs: [], undelivered: [], origin: { triggerId: origin, triggerIds: [origin] } }
  store.tickets.save(ticket)
  return ticket
}

it('reserves launch capacity across queued assignments, survives reopening and releases completed work', () => {
  const one = task('one'), two = task('two')
  expect(budget.launchGuard(one)).toEqual({ allowed: true })
  expect(budget.launchGuard(two)).toMatchObject({ allowed: false, reason: expect.stringContaining('concurrency') })
  store.close(); store = new Store(join(directory, 'state.sqlite')); budget = make()
  expect(budget.launchGuard(two).allowed).toBe(false)
  const finished = store.tickets.get(one.id)!
  finished.ended = { by: 'executor', at: now.toISOString(), outcome: 'completed' }; store.tickets.save(finished)
  expect(budget.launchGuard(two).allowed).toBe(true)
})

it('deduplicates actual usage, records unknown counters and resumes daily quotas the following UTC day', () => {
  const ticket = task('usage')
  budget.usage(ticket.id, { callId: 'call-one', tokens: 900, cost: 0.1 })
  budget.usage(ticket.id, { callId: 'call-one', tokens: 900, cost: 0.1 })
  expect(budget.summary('23456')).toMatchObject({ calls: 1, tokens: 900, unknown: false })
  budget.usage(ticket.id, { callId: 'call-two' })
  expect(budget.summary('23456')).toMatchObject({ calls: 2, tokens: 900, unknown: true })
  expect(budget.launchGuard(ticket)).toMatchObject({ allowed: false, retryAt: '2026-11-08T00:00:00.000Z' })
  expect(budget.records().items.filter(row => row.kind === 'usage')).toHaveLength(2)
  now = new Date('2026-11-08T00:00:01.000Z')
  expect(budget.launchGuard(ticket).allowed).toBe(true)
})

it('requests stable resource holds for exhausted running tasks, preserving the mandate and explicit work', () => {
  const ticket = task('long'), assignment = ticket.assignments[0]!
  assignment.state = 'running'; assignment.startedAt = now.toISOString(); store.tickets.save(ticket)
  now = new Date(now.getTime() + 11 * 60_000)
  const first = budget.tick()
  expect(first).toEqual([expect.objectContaining({ ticketId: ticket.id, kind: 'runtime' })])
  expect(budget.tick()).toEqual(first)
  expect(store.tickets.get(ticket.id)?.ended).toBeUndefined()
  expect(budget.records().items.filter(row => row.kind === 'hold')).toHaveLength(1)
  const explicit = task('explicit'); explicit.mandate.strength = 'explicit'; explicit.assignments[0]!.state = 'running';
  explicit.assignments[0]!.startedAt = '2026-11-06T00:00:00.000Z'; store.tickets.save(explicit)
  expect(budget.tick().map(item => item.ticketId)).toEqual([ticket.id])
  enabled = false
  expect(budget.tick()).toEqual([expect.objectContaining({ ticketId: ticket.id, kind: 'revoked' })])
})

it('keeps candidate reservations and silent discard decisions durable without storing message bodies', () => {
  expect(budget.admit('23456', 'event-one', 700).allowed).toBe(true)
  expect(budget.admit('23456', 'event-one', 700).allowed).toBe(true)
  expect(budget.admit('23456', 'event-two', 400)).toMatchObject({ allowed: false, reason: expect.stringContaining('input budget') })
  store.close(); store = new Store(join(directory, 'state.sqlite')); budget = make()
  expect(budget.admit('23456', 'event-two', 1).allowed).toBe(false)
  expect(budget.records().items).toHaveLength(2)
  now = new Date('2026-11-07T01:00:00.000Z')
  expect(budget.admit('23456', 'event-three', 400).allowed).toBe(true)
})

it('accounts a real batched assessment across observed groups once and applies an optional known-cost cap', () => {
  const one = task('assessment-one'), two = task('assessment-two')
  const origin = store.triggers.get(two.origin.triggerId)!
  origin.meta.observation = { groupId: '34567', windowId: 'another-window' }; store.triggers.save(origin)
  budget.assessmentUsage([one.origin.triggerId, two.origin.triggerId], { callId: 'router-call', tokens: 101, cost: 0.2 })
  budget.assessmentUsage([one.origin.triggerId, two.origin.triggerId], { callId: 'router-call', tokens: 101, cost: 0.2 })
  expect(budget.summary('23456')).toMatchObject({ tokens: 51, calls: 1, cost: 0.1 })
  expect(budget.summary('34567')).toMatchObject({ tokens: 50, calls: 1, cost: 0.1 })
  const capped = new QqObservationBudget({ store, allowed: () => true, limits: () => ({ ...limits, maxCostPerDay: 0.1 }) }, () => now)
  expect(capped.launchGuard(one)).toMatchObject({ allowed: false, reason: expect.stringContaining('model-cost') })
})
