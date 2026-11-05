import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { Engine, MemoryRepositories, runningAssignment } from '../src/core/index.ts'
import type { Assessor, Assignment, Candidate, Executor, OutboundMessage, Policy, Repositories, Trigger } from '../src/core/index.ts'

function setup(repo: Repositories = new MemoryRepositories()) {
  const candidates: Candidate[] = [], started: [any, Assignment][] = [], deliveries: string[] = []
  let now = '2026-09-23T00:00:00.000Z'
  let paused = false, mandateValid = true
  const policy: Policy = {
    version: 'v1', get paused() { return paused }, evalTimeoutMs: 60_000,
    gate: () => ({ admissible: true, strength: 'explicit', basis: { via: 'listed' } }),
    revalidate: () => mandateValid, admitsInferred: () => true,
  }
  const assessor: Assessor = { request: vi.fn(candidate => candidates.push(candidate)) }
  const executor: Executor = {
    start: vi.fn((ticket, assignment) => started.push([ticket, assignment])),
    deliver: vi.fn(ticket => deliveries.push(ticket.id)), stop: vi.fn(),
  }
  const outbox = { send: (_message: OutboundMessage) => {}, status: () => undefined, withdraw: (_id: string) => {} }
  const engine = new Engine({ repo, policy: () => policy, scope: { scope: () => ({ listened: true, observed: false }) }, assessor, executor,
    outbox, now: () => now })
  const trigger: Trigger = { id: 'trigger-1', source: 'chat', threads: [{ source: 'chat', id: 'thread-1' }],
    actor: { source: 'chat', id: 'alice' }, human: true, at: now, text: 'Do the work', meta: {} }
  engine.receive(trigger); engine.evaluateDue()
  const decision = engine.decide(trigger.id, { kind: 'accept', evalId: candidates[0]!.evalId, title: 'Work', scope: 'test', reason: 'requested' })
  const ticket = repo.tickets.get(decision.ticketId!)!
  const assignment = ticket.assignments[0]!
  engine.assignmentStarted(ticket.id, assignment.id)
  return { repo, engine, ticket, assignment, deliveries, setNow: (value: string) => { now = value },
    setPaused: (value: boolean) => { paused = value }, setMandateValid: (value: boolean) => { mandateValid = value },
    endTurn: () => engine.turnEnded(ticket.id, assignment.id), running: () => runningAssignment(repo.tickets.get(ticket.id)!) }
}

describe('ticket follow-ups', () => {
  it('replays an identical report once, delivers the due check, and cancels later checks on stop', () => {
    const h = setup()
    const check = { key: 'verify-build', at: '2026-09-23T00:00:05+00:00', purpose: 'Check CI',
      successCondition: 'CI is green', resumeInstruction: 'Read the latest CI result and report.' }
    h.engine.report(h.ticket.id, { state: 'waiting', summary: 'Waiting on CI', waitingFor: { subject: 'verify-build', kind: 'external' }, nextCheck: check }, h.assignment.id)
    h.engine.report(h.ticket.id, { state: 'waiting', summary: 'Still waiting on CI', waitingFor: { subject: 'verify-build', kind: 'external' }, nextCheck: check }, h.assignment.id)
    expect(h.repo.tickets.get(h.ticket.id)?.followups).toHaveLength(1)
    expect(h.running()?.report).toMatchObject({ state: 'waiting', summary: 'Still waiting on CI', waitingFor: { kind: 'external' }, nextCheck: check })

    h.endTurn(); h.setNow('2026-09-23T00:00:06.000Z'); h.engine.evaluateDue()
    const due = h.repo.tickets.get(h.ticket.id)!
    expect(due.followups?.[0]).toMatchObject({ status: 'delivered', revision: 1 })
    expect(due.inputs).toContainEqual(expect.objectContaining({ kind: 'text', followupId: due.followups?.[0]?.id }))
    expect(h.deliveries).toContain(h.ticket.id)
    h.engine.evaluateDue()
    expect(h.repo.tickets.get(h.ticket.id)?.inputs.filter(input => input.kind === 'text' && input.followupId)).toHaveLength(1)

    const stopped = setup()
    stopped.engine.report(stopped.ticket.id, { state: 'progress', summary: 'Still working', nextCheck: { ...check, at: '2026-09-23T00:01:00Z' } }, stopped.assignment.id)
    stopped.engine.stopTicket(stopped.ticket.id)
    expect(stopped.repo.tickets.get(stopped.ticket.id)?.followups?.[0]?.status).toBe('cancelled')
    stopped.setNow('2026-09-23T00:02:00Z'); stopped.engine.evaluateDue()
    expect(stopped.repo.tickets.get(stopped.ticket.id)?.inputs.some(input => input.kind === 'text' && input.followupId)).toBe(false)
  })

  it('keeps due follow-ups during pause and hands them off when processing resumes', () => {
    const h = setup()
    h.engine.report(h.ticket.id, { state: 'progress', summary: 'Waiting for the scheduled check', nextCheck: {
      key: 'pause-check', at: '2026-09-23T00:00:01Z', purpose: 'Check status', successCondition: 'Ready', resumeInstruction: 'Continue.' } }, h.assignment.id)
    h.endTurn(); h.setNow('2026-09-23T00:00:02Z'); h.setPaused(true); h.engine.evaluateDue()
    expect(h.repo.tickets.get(h.ticket.id)?.followups?.[0]?.status).toBe('scheduled')
    expect(h.repo.tickets.get(h.ticket.id)?.inputs.some(input => input.kind === 'text' && input.followupId)).toBe(false)
    h.setPaused(false); h.engine.evaluateDue()
    expect(h.repo.tickets.get(h.ticket.id)?.followups?.[0]?.status).toBe('delivered')
    expect(h.deliveries).toContain(h.ticket.id)
  })

  it('persists scheduled follow-ups and stable inputs across a SQLite close and reopen', () => {
    const directory = mkdtempSync(join(tmpdir(), 'personal-followups-'))
    const path = join(directory, 'orchestrator.sqlite')
    let first: Store | undefined, reopened: Store | undefined
    try {
      first = new Store(path)
      const h = setup(first)
      h.engine.report(h.ticket.id, { state: 'progress', summary: 'Check later', nextCheck: {
        key: 'persist', at: '2026-09-23T00:00:01Z', purpose: 'Check the result', successCondition: 'Done', resumeInstruction: 'Resume.' } }, h.assignment.id)
      h.endTurn(); h.setNow('2026-09-23T00:00:02Z'); h.engine.evaluateDue()
      const before = first.tickets.get(h.ticket.id)!
      first.close(); first = undefined
      reopened = new Store(path)
      expect(reopened.tickets.get(h.ticket.id)).toMatchObject({
        followups: before.followups,
        inputs: before.inputs.filter(input => input.kind === 'text' && input.followupId),
      })
    } finally {
      first?.close(); reopened?.close(); rmSync(directory, { recursive: true, force: true })
    }
  })

  it('waits for the original Session turn to end before delivering a due check', () => {
    const h = setup()
    h.engine.report(h.ticket.id, { state: 'progress', summary: 'A turn is still active', nextCheck: {
      key: 'idle-only', at: '2026-09-23T00:00:01Z', purpose: 'Check', successCondition: 'Ready', resumeInstruction: 'Resume.' } }, h.assignment.id)
    h.setNow('2026-09-23T00:00:02Z'); h.engine.evaluateDue()
    expect(h.repo.tickets.get(h.ticket.id)?.followups?.[0]?.status).toBe('scheduled')
    expect(h.repo.tickets.get(h.ticket.id)?.inputs.some(input => input.kind === 'text' && input.followupId)).toBe(false)
    h.endTurn(); h.engine.evaluateDue()
    expect(h.repo.tickets.get(h.ticket.id)?.followups?.[0]?.status).toBe('delivered')
  })

  it('requires a scheduled check for external waiting', () => {
    const h = setup()
    expect(() => h.engine.report(h.ticket.id, { state: 'waiting', summary: 'Waiting on CI',
      waitingFor: { subject: 'ci', kind: 'external' } }, h.assignment.id)).toThrow(/external event needs a next_check/)
    expect(h.repo.tickets.get(h.ticket.id)?.followups).toBeUndefined()
  })

  it('validates Engine datetime inputs and caps scheduled checks at 100', () => {
    const h = setup()
    for (const at of ['2026-02-30T00:00:00Z', '2026-09-23T00:00:00']) {
      expect(() => h.engine.report(h.ticket.id, { state: 'progress', summary: 'Invalid check', nextCheck: {
        key: `invalid-${at}`, at, purpose: 'Check', successCondition: 'Ready', resumeInstruction: 'Resume.' } }, h.assignment.id))
        .toThrow(/valid ISO datetime with a timezone offset/)
    }
    for (let index = 0; index < 100; index++) h.engine.report(h.ticket.id, { state: 'progress', summary: 'Scheduled', nextCheck: {
      key: `check-${index}`, at: '2026-09-23T00:00:10Z', purpose: 'Check', successCondition: 'Ready', resumeInstruction: 'Resume.' } }, h.assignment.id)
    expect(h.repo.tickets.get(h.ticket.id)?.followups?.filter(item => item.status === 'scheduled')).toHaveLength(100)
    expect(() => h.engine.report(h.ticket.id, { state: 'progress', summary: 'One too many', nextCheck: {
      key: 'check-overflow', at: '2026-09-23T00:00:10Z', purpose: 'Check', successCondition: 'Ready', resumeInstruction: 'Resume.' } }, h.assignment.id))
      .toThrow(/at most 100 scheduled follow-up checks/)
  })

  it('rejects reports from a replaced assignment', () => {
    const h = setup()
    expect(() => h.engine.report(h.ticket.id, { state: 'progress', summary: 'Late report', nextCheck: {
      key: 'stale', at: '2026-09-23T00:00:01Z', purpose: 'Check', successCondition: 'Ready', resumeInstruction: 'Resume.' } }, 'old-assignment'))
      .toThrow(/newer assignment owns this ticket/)
    expect(h.repo.tickets.get(h.ticket.id)?.followups).toBeUndefined()
  })

  it('rejects a late report after a person stopped the ticket', () => {
    const h = setup()
    h.engine.stopTicket(h.ticket.id)
    expect(() => h.engine.report(h.ticket.id, { state: 'progress', summary: 'Late', nextCheck: {
      key: 'late', at: '2026-09-23T00:00:01Z', purpose: 'Check', successCondition: 'Ready', resumeInstruction: 'Resume.' } }, h.assignment.id))
      .toThrow(/Ticket has ended/)
    expect(h.repo.tickets.get(h.ticket.id)?.followups).toBeUndefined()
  })

  it('cancels pending follow-ups when the ticket mandate is revoked', () => {
    const h = setup()
    h.engine.report(h.ticket.id, { state: 'progress', summary: 'Scheduled', nextCheck: {
      key: 'revoked', at: '2026-09-23T00:00:01Z', purpose: 'Check', successCondition: 'Ready', resumeInstruction: 'Resume.' } }, h.assignment.id)
    h.setMandateValid(false); h.setNow('2026-09-23T00:00:02Z'); h.engine.evaluateDue()
    expect(h.repo.tickets.get(h.ticket.id)?.followups?.[0]?.status).toBe('cancelled')
    expect(h.repo.tickets.get(h.ticket.id)?.inputs.some(input => input.kind === 'text' && input.followupId)).toBe(false)
  })
})
