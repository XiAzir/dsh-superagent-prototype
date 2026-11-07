import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/app/store.ts'
import { Engine, completionApproved, completionKey, requestIds, type EngineOptions, type Policy, type Ticket, type Trigger } from '../src/core/index.ts'

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })
function fixture(enforce = false) {
  const directory = mkdtempSync(join(tmpdir(), 'request-routing-')), database = join(directory, 'state.sqlite')
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
  let store = new Store(database), clock = 0, revoked = false
  cleanups.push(() => store.close())
  const start = vi.fn(), stop = vi.fn(), deliver = vi.fn()
  const policy: Policy = { version: 'request-routing-v1', paused: false, evalTimeoutMs: 60000,
    gate: trigger => trigger.actor.id === 'alice' ? { admissible: true, strength: 'explicit', basis: { via: 'addressed', addressed: 'direct' } }
      : { admissible: false, reason: 'not allowed' }, revalidate: () => !revoked, admitsInferred: () => false }
  const options = (): EngineOptions => ({ repo: store, policy: () => policy, scope: { scope: () => ({ listened: true, observed: false }) },
    assessor: { request: () => {} }, executor: { start, stop, deliver }, outbox: { send: () => {}, status: () => undefined, withdraw: () => {} },
    provisionalRouting: true, now: () => new Date(Date.UTC(2026, 10, 7) + clock++).toISOString(),
    prepareTicket: ticket => ({ ...ticket, acceptance: { revision: 1, mode: enforce ? 'enforce' : 'observe', createdAt: ticket.createdAt,
      criteria: [{ id: 'original-request', kind: 'content', description: ticket.mandate.scope, sourceRefs: [`trigger/${ticket.origin.triggerId}`] }] } }) })
  let engine = new Engine(options())
  const message = (id: string, text = id, thread = id): Trigger => ({ id, text, source: 'chat', actor: { source: 'chat', id: 'alice' },
    threads: [{ source: 'chat', id: thread }], addressed: 'direct', routing: 'router', human: true, at: new Date(Date.UTC(2026, 10, 7) + clock++).toISOString(),
    channel: { source: 'chat', thread: `chat:${thread}`, address: { thread } }, meta: {} })
  const receive = (trigger: Trigger) => { engine.receive(trigger); engine.evaluateDue() }
  const accept = (trigger: Trigger) => {
    receive(trigger)
    const decision = engine.decide(trigger.id, { kind: 'accept', title: trigger.text, scope: trigger.text, reason: 'Original human request' })
    const ticket = store.tickets.get(decision.ticketId!)!
    engine.assignmentStarted(ticket.id, ticket.assignments.at(-1)!.id)
    return store.tickets.get(ticket.id)!
  }
  return { get engine() { return engine }, get store() { return store }, message, receive, accept, stop, start, deliver, policy,
    ticket: (id: string) => store.tickets.get(id)!, revoke: () => { revoked = true },
    reopen: () => { store.close(); store = new Store(database); engine = new Engine(options()) } }
}

it('trial-delivers a cross-thread request, requires an internal claim and subscribes only after confirmation', () => {
  const h = fixture(), owner = h.accept(h.message('original', 'Generate the report'))
  const follow = h.message('follow', 'Include the source values')
  delete follow.routing
  h.receive(follow); h.engine.attach(owner.id, follow.id, undefined, { reason: 'Same requested report', evidenceRefs: ['trigger/original'] })
  const proposed = h.engine.requestResponsibility(follow.id)!
  expect(proposed).toMatchObject({ id: follow.id, triggerId: follow.id, state: 'proposed', owners: [{ ticketId: owner.id, state: 'proposed' }] })
  expect(h.store.threads.get('chat:follow')?.subscriptions).not.toContain(owner.id)
  expect(h.ticket(owner.id).inputs).toEqual([expect.objectContaining({ triggerId: follow.id, provisional: true })])
  h.engine.inputsRead(owner.id, h.ticket(owner.id).inputs.map(item => item.id))
  expect(h.engine.requestResponsibility(follow.id)?.state).toBe('proposed')
  expect(() => h.engine.report(owner.id, { state: 'ready', summary: 'Report ready' }, owner.assignments.at(-1)!.id)).toThrow('Claim or return')
  const claimed = h.engine.claimRequest(owner.id, follow.id, 'The report request includes these source values.', owner.assignments.at(-1)!.id, proposed.revision)
  expect(claimed.state).toBe('active')
  expect(h.store.threads.get('chat:follow')?.subscriptions).toContain(owner.id)
  expect(h.engine.claimRequest(owner.id, follow.id, 'Replay after a lost reply', owner.assignments.at(-1)!.id, proposed.revision)).toEqual(claimed)
  expect(h.ticket(owner.id).inputs[0]).not.toHaveProperty('provisional')
  expect(() => h.engine.handback(owner.id, follow.id, 'Late rejection from the proposal version', owner.assignments.at(-1)!.id, proposed.revision)).toThrow('revision changed')
})

it('returns a wrong attachment without consuming its request and removes only its old acceptance responsibility', () => {
  const h = fixture(), report = h.accept(h.message('report', 'Generate summary.json')), correct = h.accept(h.message('filter', 'Generate filtered.json'))
  const supplement = h.message('sort', 'Sort the filtered array', 'filter')
  h.receive(supplement); h.engine.attach(report.id, supplement.id)
  const before = h.ticket(report.id), reviewKey = completionKey(before)
  expect(before.acceptance?.criteria.some(item => item.sourceRefs.includes('trigger/sort'))).toBe(true)
  expect(h.engine.handback(report.id, supplement.id, 'This changes filtered.json, which belongs to another task.', report.assignments.at(-1)!.id)).toBe(true)
  expect(h.engine.requestResponsibility(supplement.id)?.state).toBe('returned')
  expect(h.ticket(report.id).ended).toBeUndefined()
  expect(h.ticket(report.id).acceptance?.criteria.map(item => item.sourceRefs)).toEqual([['trigger/report']])
  expect(h.ticket(report.id).inputs.find(item => item.kind === 'trigger')!).toHaveProperty('requestReleased', true)
  expect(completionKey(h.ticket(report.id))).not.toBe(reviewKey)
  h.engine.attach(correct.id, supplement.id)
  expect(h.engine.requestResponsibility(supplement.id)).toMatchObject({ state: 'active', owners: expect.arrayContaining([{ ticketId: correct.id,
    state: 'claimed', assignmentId: correct.assignments.at(-1)!.id, at: expect.any(String) }]) })
  expect(requestIds(h.ticket(report.id))).toContain(supplement.id)
  expect(() => h.engine.attach(report.id, supplement.id)).toThrow()
})

it('hands back an initially misaccepted origin and creates a replacement while the empty old ticket cannot publish a result', () => {
  const h = fixture(), original = h.message('continuation', 'Continue work on filtered.json'), wrong = h.accept(original)
  const revision = h.engine.requestResponsibility(original.id)!.revision
  expect(h.engine.handback(wrong.id, original.id, 'This belongs to the earlier filter task.', wrong.assignments.at(-1)!.id, revision)).toBe(true)
  expect(h.ticket(wrong.id)).toMatchObject({ requestRedirect: { triggerId: original.id }, ended: { outcome: 'dropped', by: 'executor' } })
  expect(completionApproved(h.ticket(wrong.id))).toBe(false)
  expect(() => h.engine.reply({ purpose: 'result', ticketId: wrong.id, text: 'Old task complete' })).toThrow()
  h.reopen()
  expect(h.engine.handback(wrong.id, original.id, 'This belongs to the earlier filter task.', wrong.assignments.at(-1)!.id, revision)).toBe(true)
  h.engine.evaluateDue()
  const corrected = h.engine.decide(original.id, { kind: 'accept', title: 'Corrected filter continuation', scope: original.text, reason: 'Reassessed original request' })
  expect(corrected.ticketId).not.toBe(wrong.id)
  expect(h.engine.requestResponsibility(original.id)?.owners.some(owner => owner.ticketId === corrected.ticketId && owner.state === 'claimed')).toBe(true)
  expect(h.ticket(wrong.id).origin.triggerId).toBe(original.id)
  expect(h.store.threads.get('chat:continuation')?.subscriptions).not.toContain(wrong.id)
  const next = h.message('next', 'Another follow-up', 'continuation'); delete next.routing
  h.engine.receive(next)
  expect(h.ticket(wrong.id).ended?.outcome).toBe('dropped')
  expect(h.ticket(wrong.id).requests?.every(item => item.state === 'released')).toBe(true)
})

it('transfers a false accept to its canonical owner once across restart, preserves work references and settles the original ID', () => {
  const h = fixture(true), canonical = h.accept(h.message('main', 'Generate filtered.json', 'filter'))
  const input = h.message('sort', 'Use a sorted array', 'filter'), wrong = h.accept(input)
  h.engine.report(wrong.id, { state: 'progress', summary: 'Inspected the existing input and computed the sorted order.', artifacts: ['saved-investigation'] }, wrong.assignments.at(-1)!.id)
  const revision = h.engine.requestResponsibility(input.id)!.revision
  const transferred = h.engine.transferRequest(wrong.id, input.id, canonical.id, 'This is a continuation of filtered.json.', 'transfer-sort', wrong.assignments.at(-1)!.id, revision)
  expect(transferred.id).toBe(input.id)
  expect(h.ticket(wrong.id)).toMatchObject({ requestRedirect: { toTicketId: canonical.id }, ended: { outcome: 'dropped' } })
  expect(h.ticket(canonical.id).inputs.some(item => item.kind === 'trigger' && item.triggerId === input.id && item.note?.includes('saved-investigation'))).toBe(true)
  expect(h.ticket(wrong.id).assignments.at(-1)?.report?.summary).toContain('Inspected')
  h.reopen()
  expect(h.engine.transferRequest(wrong.id, input.id, canonical.id, 'This is a continuation of filtered.json.', 'transfer-sort', wrong.assignments.at(-1)!.id, revision)).toEqual(transferred)
  expect(() => h.engine.transferRequest(wrong.id, input.id, canonical.id, 'Different transfer', 'transfer-sort')).toThrow('different details')
  const ready = h.engine.report(canonical.id, { state: 'ready', summary: 'Generated filtered.json in sorted order.' }, canonical.assignments.at(-1)!.id)
  const reportKey = completionKey(ready)
  h.engine.verify(canonical.id, { reportKey, state: 'passed', at: new Date().toISOString(), attempt: 1, summary: 'Verified original and added requirements', checks: [] })
  expect(h.engine.requestResponsibility(input.id)?.state).toBe('completed')
  expect(h.engine.requestResponsibility('main')?.state).toBe('completed')
  expect(completionApproved(h.ticket(canonical.id))).toBe(true)
  expect(h.ticket(canonical.id).verification?.reportKey).toBe(completionKey(h.ticket(canonical.id)))
})

it('rejects stale ownership, old assignments, revoked authority and stopped transfer targets', () => {
  const h = fixture(), first = h.accept(h.message('first')), second = h.accept(h.message('second'))
  const trial = h.message('trial'); h.receive(trial); h.engine.attach(first.id, trial.id)
  const revision = h.engine.requestResponsibility(trial.id)!.revision
  expect(() => h.engine.claimRequest(first.id, trial.id, 'Matching target', 'old-assignment', revision)).toThrow()
  expect(() => h.engine.claimRequest(first.id, trial.id, 'Matching target', first.assignments.at(-1)!.id, revision - 1)).toThrow('revision changed')
  expect(() => h.engine.transferRequest(first.id, trial.id, second.id, 'Matching target', 'stale', first.assignments.at(-1)!.id, revision - 1)).toThrow('revision changed')
  h.engine.stopTicket(second.id)
  expect(() => h.engine.transferRequest(first.id, trial.id, second.id, 'Matching target', 'stopped')).toThrow('stopped or held')
  h.revoke()
  expect(() => h.engine.claimRequest(first.id, trial.id, 'Matching target', first.assignments.at(-1)!.id, revision)).toThrow()
  expect(() => h.engine.handback(first.id, trial.id, 'Unrelated', first.assignments.at(-1)!.id, revision)).toThrow()
  expect(h.engine.requestResponsibility(trial.id)?.state).toBe('proposed')
})

it('reopens a false status/ignore idempotently with current source authority and preserves completed and cancelled requests', () => {
  const h = fixture(), task = h.accept(h.message('task'))
  const ignored = h.message('ignored', 'Generate another result'); h.receive(ignored); h.engine.decide(ignored.id, { kind: 'ignore', reason: 'Mistaken chatter' })
  const previous = h.engine.requestResponsibility(ignored.id)!
  expect(previous.state).toBe('ignored')
  const opened = h.engine.reopenRequest(ignored.id, 'The original sentence explicitly asks to generate another result.', 'review-1', previous.revision)
  expect(opened.state).toBe('pending')
  h.reopen()
  expect(h.engine.reopenRequest(ignored.id, 'The original sentence explicitly asks to generate another result.', 'review-1', previous.revision)).toEqual(opened)
  expect(() => h.engine.reopenRequest(ignored.id, 'Other reason', 'review-1')).toThrow('different details')
  const query = h.message('query', 'Show the status and create another file'); h.receive(query); h.engine.status(task.id, query.id)
  expect(h.engine.requestResponsibility(query.id)?.state).toBe('answered')
  h.engine.reopenRequest(query.id, 'The second clause asks for a new file.', 'mixed-review', h.engine.requestResponsibility(query.id)!.revision)
  expect(h.engine.requestResponsibility(query.id)?.state).toBe('pending')
  h.engine.stopTicket(task.id)
  expect(h.engine.requestResponsibility('task')?.state).toBe('cancelled')
  h.engine.status(task.id, 'task')
  h.engine.reply({ purpose: 'status', ticketId: task.id, triggerId: 'task', text: 'The task remains stopped.' })
  expect(h.engine.requestResponsibility('task')?.state).toBe('cancelled')
  expect(() => h.engine.reopenRequest('task', 'Try again', 'cancelled')).toThrow('completed or cancelled')
  const completed = h.accept(h.message('complete'))
  h.engine.report(completed.id, { state: 'ready', summary: 'Original request completed.' }, completed.assignments.at(-1)!.id)
  expect(h.engine.requestResponsibility('complete')?.state).toBe('completed')
  h.engine.status(completed.id, 'complete')
  h.engine.reply({ purpose: 'status', ticketId: completed.id, triggerId: 'complete', text: 'The task is complete.' })
  expect(h.engine.requestResponsibility('complete')?.state).toBe('completed')
  expect(() => h.engine.reopenRequest('complete', 'Try again', 'completed')).toThrow('completed or cancelled')
})

it.each(['stop-first', 'complete-first'] as const)('aggregates mixed collaboration outcomes consistently in %s order', order => {
  const h = fixture(), first = h.accept(h.message('a')), second = h.accept(h.message('b'))
  const coordinated: Trigger = { ...h.message('coordinated'), source: 'web', actor: { source: 'web', id: 'owner' },
    meta: { router: true, mentions: [first.id, second.id] } }
  h.policy.gate = () => ({ admissible: true, strength: 'explicit', basis: { via: 'addressed', addressed: 'direct' } })
  h.receive(coordinated); h.engine.attach(first.id, coordinated.id); h.engine.attach(second.id, coordinated.id)
  const finish = () => h.engine.report(second.id, { state: 'ready', summary: 'Completed this participant scope.' }, second.assignments.at(-1)!.id)
  if (order === 'stop-first') { h.engine.stopTicket(first.id); finish() }
  else { finish(); h.engine.stopTicket(first.id) }
  const request = h.engine.requestResponsibility(coordinated.id)!
  expect(request.state).toBe('cancelled')
  expect(request.owners.map(owner => owner.state).sort()).toEqual(['cancelled', 'completed'])
  expect(request.history.filter(event => ['completed', 'cancelled'].includes(event.kind)).map(event => event.kind).sort()).toEqual(['cancelled', 'completed'])
  expect(() => h.engine.reopenRequest(coordinated.id, 'Try again', 'reopen')).toThrow('completed or cancelled')
  const disposition = h.store.triggers.disposition(coordinated.id)!
  h.store.triggers.saveDisposition(coordinated.id, { ...disposition, request: { ...request, state: 'answered' } })
  expect(() => h.engine.reopenRequest(coordinated.id, 'Repair stale legacy disposition', 'stale-reopen')).toThrow('completed or cancelled')
})

it('keeps deliberately coordinated requests owned by all explicitly mentioned Workers', () => {
  const h = fixture(), first = h.accept(h.message('a')), second = h.accept(h.message('b'))
  const coordinated: Trigger = { ...h.message('coordinated'), source: 'web', actor: { source: 'web', id: 'owner' },
    meta: { router: true, mentions: [first.id, second.id] } }
  h.policy.gate = () => ({ admissible: true, strength: 'explicit', basis: { via: 'addressed', addressed: 'direct' } })
  h.receive(coordinated); h.engine.attach(first.id, coordinated.id); h.engine.attach(second.id, coordinated.id)
  expect(h.engine.requestResponsibility(coordinated.id)?.owners.filter(owner => owner.state === 'claimed').map(owner => owner.ticketId).sort()).toEqual([first.id, second.id].sort())
  expect(h.engine.handback(first.id, coordinated.id, 'The second Worker owns the remaining part.', first.assignments.at(-1)!.id)).toBe(false)
  expect(h.engine.requestResponsibility(coordinated.id)?.state).toBe('active')
})

it('keeps a human-cancelled unread trial request terminal rather than requeueing it as new work', () => {
  const h = fixture(), owner = h.accept(h.message('owner'))
  const pending = h.message('unread'); h.receive(pending); h.engine.attach(owner.id, pending.id)
  h.engine.stopTicket(owner.id)
  expect(h.engine.requestResponsibility(pending.id)?.state).toBe('cancelled')
  h.engine.evaluateDue()
  expect(h.store.threads.get('chat:unread')?.pending).toEqual([])
  expect(() => h.engine.decide(pending.id, { kind: 'accept', title: 'Accidental retry', scope: pending.text, reason: 'Queued again' })).toThrow('explicitly cancelled')
})

it('bounds repeated recovery across newly created tickets without resetting the original responsibility history', () => {
  const h = fixture(), original = h.message('ambiguous', 'Continue the earlier work')
  let owner = h.accept(original)
  const initialOwner = owner.id, initialAssignment = owner.assignments.at(-1)!.id
  for (let attempt = 0; attempt < 4; attempt++) {
    expect(h.engine.handback(owner.id, original.id, `Recheck scope ${attempt}`, owner.assignments.at(-1)!.id)).toBe(true)
    h.engine.evaluateDue()
    const decision = h.engine.decide(original.id, { kind: 'accept', title: `Owner ${attempt + 1}`, scope: original.text, reason: 'Reassess the original request' })
    owner = h.ticket(decision.ticketId!)
    h.engine.assignmentStarted(owner.id, owner.assignments.at(-1)!.id)
  }
  const before = structuredClone(h.engine.requestResponsibility(original.id))
  h.reopen()
  expect(() => h.engine.handback(owner.id, original.id, 'Attempt a fifth reroute', owner.assignments.at(-1)!.id)).toThrow('automatic transfer limit')
  expect(h.engine.requestResponsibility(original.id)).toEqual(before)
  expect(h.ticket(owner.id).ended).toBeUndefined()
  expect(h.engine.handback(initialOwner, original.id, 'Recheck scope 0', initialAssignment)).toBe(true)
})

it('keeps explicit direct delivery confirmed while acknowledgement can claim an ordinary trial internally', () => {
  const h = fixture(), owner = h.accept(h.message('explicit-owner'))
  const direct = h.message('explicit-supplement', 'Use the attached data')
  h.engine.direct(owner.id, direct)
  expect(h.engine.requestResponsibility(direct.id)?.state).toBe('active')
  expect(h.store.threads.get('chat:explicit-supplement')?.subscriptions).toContain(owner.id)
  const trial = h.message('ordinary-trial', 'Add the source values')
  h.receive(trial); h.engine.attach(owner.id, trial.id)
  expect(h.engine.requestResponsibility(trial.id)?.state).toBe('proposed')
  h.engine.reply({ purpose: 'acknowledgement', ticketId: owner.id, triggerId: trial.id, text: 'I will add the source values.' })
  expect(h.engine.requestResponsibility(trial.id)?.state).toBe('active')
  expect(h.store.threads.get('chat:ordinary-trial')?.subscriptions).toContain(owner.id)
})

it('rechecks observed-source auto authority at claim and transfer even when both task mandates remain valid', () => {
  const h = fixture(), first = h.accept(h.message('observing-owner')), second = h.accept(h.message('other-owner'))
  h.policy.observedRouting = true
  const observation: Trigger = { ...h.message('observed'), source: 'qq', meta: { observation: { groupId: 'allowed-group' } } }
  h.receive(observation); h.engine.attach(first.id, observation.id)
  h.policy.observedRouting = false
  expect(() => h.engine.claimRequest(first.id, observation.id, 'Related context', first.assignments.at(-1)!.id)).toThrow('auto-mode authority')
  expect(() => h.engine.transferRequest(first.id, observation.id, second.id, 'Related context', 'observed-transfer', first.assignments.at(-1)!.id)).toThrow('auto-mode authority')
  expect(() => h.engine.reply({ purpose: 'acknowledgement', ticketId: first.id, triggerId: observation.id, text: 'Taken up.' }))
    .toThrow('authority changed before internal confirmation')
  expect(h.engine.requestResponsibility(observation.id)?.state).toBe('proposed')
})

it.each(['paused', 'revoked'] as const)('keeps trial acknowledgements unclaimed when processing becomes %s', change => {
  const h = fixture(), owner = h.accept(h.message('owner')), input = h.message('trial')
  h.receive(input); h.engine.attach(owner.id, input.id)
  if (change === 'paused') h.policy.paused = true; else h.revoke()
  expect(() => h.engine.reply({ purpose: 'acknowledgement', ticketId: owner.id, triggerId: input.id, text: 'Taken up.' }))
    .toThrow('authority changed before internal confirmation')
  expect(h.engine.requestResponsibility(input.id)?.state).toBe('proposed')
  expect(h.store.threads.get('chat:trial')?.subscriptions).not.toContain(owner.id)
})

it('reconstructs legacy ownership only from original and executable inputs while context stays observational', () => {
  const h = fixture(), owner = h.accept(h.message('legacy-owner')), context = h.message('legacy-context')
  h.store.triggers.save(context)
  const ticket = h.ticket(owner.id)
  delete ticket.requests
  ticket.inputs.push({ id: 'legacy-context-input', kind: 'trigger', triggerId: context.id, human: true, context: true, at: context.at })
  h.store.tickets.save(ticket)
  const disposition = h.store.triggers.disposition('legacy-owner')!
  delete disposition.request; h.store.triggers.saveDisposition('legacy-owner', disposition)
  expect(h.engine.requestResponsibility('legacy-owner')?.owners.map(item => item.ticketId)).toEqual([owner.id])
  expect(h.engine.requestResponsibility(context.id)?.owners).toEqual([])
})
