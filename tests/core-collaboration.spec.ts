import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Engine, MemoryRepositories, key } from '../src/core/index.ts'
import type { Assignment, EngineOptions, Policy, Ticket, Trigger } from '../src/core/index.ts'
import { Store } from '../src/app/store.ts'

const at = '2026-11-02T00:00:00.000Z'
const ref = { source: 'chat', id: 'room' }
const threadKey = 'chat:room'
const mandate = { strength: 'explicit' as const, policyVersion: 'v1', basis: { via: 'listed' as const }, actor: { source: 'chat', id: 'alice' }, scope: 'project' }
function makeHarness({ paused = false, valid = true, prepareTicket }: { paused?: boolean; valid?: boolean; prepareTicket?: EngineOptions['prepareTicket'] } = {}) {
  const repo = new MemoryRepositories()
  const assessor = { request: vi.fn(), release: vi.fn() }
  const executor = { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() }
  let policyValid = valid
  const policy: Policy = { version: 'v1', paused, evalTimeoutMs: 60_000, gate: () => ({ admissible: true, strength: 'explicit', basis: { via: 'listed' } }),
    revalidate: () => policyValid, admitsInferred: () => true }
  const outbox = { send: vi.fn(), status: () => undefined, withdraw: vi.fn() }
  const options: EngineOptions = { repo, policy: () => policy, scope: { scope: () => ({ listened: true, observed: false }) }, assessor, executor, outbox,
    ...(prepareTicket ? { prepareTicket } : {}) }
  let nowAt = at
  options.now = () => nowAt
  const engine = new Engine(options)
  const origin: Trigger = { id: 'origin', source: 'chat', threads: [ref], actor: mandate.actor, human: true, at, text: 'start', meta: {} }
  repo.triggers.save(origin)
  repo.threads.save({ key: threadKey, ref, createdAt: at, subscriptions: [], correlated: [], pending: [], meta: {} })
  const ticket = (id: string, state: Assignment['state'] = 'running'): Ticket => ({ id, title: id, decisionId: `d-${id}`, mandate, channels: [], assignments: [{ id: `a-${id}`, state, createdAt: at, ...(state === 'running' ? { startedAt: at } : {}) }], inputs: [], undelivered: [], createdAt: at, updatedAt: at, origin: { triggerId: 'origin', triggerIds: ['origin'] } })
  return { repo, engine, executor, assessor, policy, ticket, setValid: (value: boolean) => { policyValid = value }, setNow: (value: string) => { nowAt = value } }
}

describe('core collaboration', () => {
  it('direct stores and delivers only to the selected ticket, without Router evaluation, and deduplicates retries', () => {
    const h = makeHarness()
    const selected = h.ticket('selected'), sibling = h.ticket('sibling')
    h.repo.tickets.save(selected); h.repo.tickets.save(sibling)
    h.repo.threads.save({ ...h.repo.threads.get(threadKey)!, subscriptions: [selected.id, sibling.id] })
    const trigger: Trigger = { id: 'direct-1', source: 'chat', threads: [ref], actor: mandate.actor, human: true, addressed: 'mention', at, text: '@worker please fix', meta: {} }
    const result = h.engine.direct(selected.id, trigger)
    expect(result.inputs).toEqual([expect.objectContaining({ kind: 'trigger', triggerId: trigger.id })])
    expect(h.repo.triggers.disposition(trigger.id)).toMatchObject({ directTicketId: selected.id, fanout: [selected.id] })
    expect(h.repo.tickets.get(sibling.id)?.inputs).toEqual([])
    expect(h.assessor.request).not.toHaveBeenCalled()
    expect(h.engine.direct(selected.id, trigger).id).toBe(selected.id)
    expect(() => h.engine.direct(selected.id, { ...trigger, text: 'Different content under the same id' })).toThrow('different disposition')
  })

  it('lets the selected worker hand an out-of-scope direct message back to Router', () => {
    const h = makeHarness()
    const selected = h.ticket('selected')
    h.repo.tickets.save(selected)
    const trigger: Trigger = { id: 'direct-out-of-scope', source: 'chat', threads: [ref], actor: mandate.actor, human: true,
      addressed: 'mention', routing: 'router', at, text: '@worker this is unrelated', meta: {} }
    h.engine.direct(selected.id, trigger)
    expect(h.assessor.request).not.toHaveBeenCalled()
    expect(h.engine.handback(selected.id, trigger.id, 'Outside this ticket')).toBe(true)
    expect(h.repo.triggers.disposition(trigger.id)?.handbacks).toEqual([expect.objectContaining({ ticketId: selected.id, reason: 'Outside this ticket' })])
    expect(h.repo.threads.get(threadKey)?.pending).toContain(trigger.id)
  })

  it('checks source scope and policy gate before persisting direct delivery', () => {
    const h = makeHarness()
    const ticket = h.ticket('selected')
    h.repo.tickets.save(ticket)
    h.policy.gate = () => ({ admissible: false, reason: 'sender is outside the source gate' })
    const trigger: Trigger = { id: 'direct-gate-refused', source: 'chat', threads: [ref], actor: mandate.actor, human: true,
      addressed: 'mention', at, text: 'please help', meta: {} }
    expect(() => h.engine.direct(ticket.id, trigger)).toThrow('sender is outside the source gate')
    expect(h.repo.triggers.get(trigger.id)).toBeUndefined()
    expect(h.repo.tickets.get(ticket.id)?.inputs).toEqual([])
  })

  it('collaborates through a persisted internal Trigger and delivers a context note only to other active subscribers', () => {
    const h = makeHarness()
    const sender = h.ticket('sender'), recipient = h.ticket('recipient'), other = h.ticket('other')
    h.repo.tickets.save(sender); h.repo.tickets.save(recipient); h.repo.tickets.save(other)
    h.repo.threads.save({ ...h.repo.threads.get(threadKey)!, subscriptions: [sender.id, recipient.id] })
    const result = h.engine.collaborate(sender.id, threadKey, 'Found the failing test', 'req-1', 'a-sender')
    expect(result).toMatchObject({ text: 'Found the failing test', fromTicketId: sender.id, recipients: [recipient.id] })
    const message = h.repo.triggers.get(result.id)!
    expect(message).toMatchObject({ human: false, actor: { source: 'worker', id: sender.id }, collaboration: { ticketId: sender.id, requestId: 'req-1', assignmentId: 'a-sender' } })
    expect(h.repo.tickets.get(sender.id)?.inputs).toEqual([])
    expect(h.repo.tickets.get(recipient.id)?.inputs).toEqual([expect.objectContaining({ kind: 'note', collaborationTriggerId: result.id })])
    expect(h.repo.tickets.get(other.id)?.inputs).toEqual([])
    expect(h.engine.collaborate(sender.id, threadKey, 'Found the failing test', 'req-1', 'a-sender')).toEqual(result)
    expect(() => h.engine.collaborate(sender.id, threadKey, 'Different text', 'req-1', 'a-sender')).toThrow()
    h.engine.stopTicket(sender.id)
    expect(h.engine.collaborate(sender.id, threadKey, 'Found the failing test', 'req-1', 'a-sender')).toEqual(result)
    const secondSender = h.ticket('second-sender')
    h.repo.tickets.save(secondSender)
    h.repo.threads.save({ ...h.repo.threads.get(threadKey)!, subscriptions: [sender.id, recipient.id, secondSender.id] })
    const second = h.engine.collaborate(secondSender.id, threadKey, 'A separate observation', 'req-1', 'a-second-sender')
    expect(second.id).not.toBe(result.id)
    expect(second.fromTicketId).toBe(secondSender.id)
  })

  it('rejects stale assignments, paused work, non-subscribed senders, and revoked mandates', () => {
    const h = makeHarness()
    const sender = h.ticket('sender'), recipient = h.ticket('recipient')
    h.repo.tickets.save(sender); h.repo.tickets.save(recipient)
    h.repo.threads.save({ ...h.repo.threads.get(threadKey)!, subscriptions: [sender.id, recipient.id] })
    expect(() => h.engine.collaborate(sender.id, threadKey, 'x', 'stale', 'old')).toThrow('newer assignment')
    expect(() => h.engine.collaborate(sender.id, 'chat:elsewhere', 'x', 'unsubscribed', 'a-sender')).toThrow()
    h.policy.paused = true
    expect(() => h.engine.collaborate(sender.id, threadKey, 'x', 'paused', 'a-sender')).toThrow()
    h.policy.paused = false
    h.setValid(false)
    expect(() => h.engine.collaborate(sender.id, threadKey, 'x', 'revoked', 'a-sender')).toThrow('mandate')
  })

  it('limits each thread to 30 new collaboration messages per 60-second window and resets after expiry', () => {
    const h = makeHarness()
    const sender = h.ticket('sender'), secondSender = h.ticket('second-sender'), recipient = h.ticket('recipient')
    h.repo.tickets.save(sender); h.repo.tickets.save(secondSender); h.repo.tickets.save(recipient)
    h.repo.threads.save({ ...h.repo.threads.get(threadKey)!, subscriptions: [sender.id, secondSender.id, recipient.id] })
    const first = h.engine.collaborate(sender.id, threadKey, 'fact 0', 'rate-0', 'a-sender')
    expect(h.engine.collaborate(sender.id, threadKey, 'fact 0', 'rate-0', 'a-sender')).toEqual(first)
    expect(h.repo.threads.get(threadKey)?.collaborationWindow).toEqual({ at, count: 1 })
    for (let index = 1; index < 30; index++) {
      const author = index % 2 ? sender : secondSender
      h.engine.collaborate(author.id, threadKey, `fact ${index}`, `rate-${index}`, author.assignments[0]!.id)
    }
    const previousInputs = h.repo.tickets.get(recipient.id)!.inputs.length
    const overflowId = key('collaboration-trigger', threadKey, secondSender.id, 'rate-overflow')
    expect(() => h.engine.collaborate(secondSender.id, threadKey, 'too many', 'rate-overflow', secondSender.assignments[0]!.id)).toThrow('Combine messages')
    expect(h.repo.triggers.get(overflowId)).toBeUndefined()
    expect(h.repo.tickets.get(recipient.id)!.inputs).toHaveLength(previousInputs)
    expect(h.repo.threads.get(threadKey)?.collaborationWindow).toEqual({ at, count: 30 })
    const nextWindow = new Date(Date.parse(at) + 60_000).toISOString()
    h.setNow(nextWindow)
    h.engine.collaborate(secondSender.id, threadKey, 'new period', 'rate-next-window', secondSender.assignments[0]!.id)
    expect(h.repo.threads.get(threadKey)?.collaborationWindow).toEqual({ at: nextWindow, count: 1 })
  })

  it('delegates an independent sibling under the inherited scope, supports pending parent assignments, and is idempotent', () => {
    const prepareTicket = vi.fn((ticket: Ticket, outcome: Parameters<NonNullable<EngineOptions['prepareTicket']>>[1]) => {
      expect(outcome.name).toMatch(/^room-worker-[a-f0-9]{8}$/)
      return ticket
    })
    const h = makeHarness({ prepareTicket })
    const parent = h.ticket('parent', 'pending')
    h.repo.tickets.save(parent)
    h.repo.threads.save({ ...h.repo.threads.get(threadKey)!, subscriptions: [parent.id] })
    const child = h.engine.delegate(parent.id, 'delegate-1', 'Investigate failing tests', threadKey, 'a-parent')
    expect(child).toMatchObject({ title: 'Investigate failing tests', delegation: { parentTicketId: parent.id, requestId: 'delegate-1' }, mandate: { scope: 'project' } })
    expect(child.id).not.toBe(parent.id)
    expect(h.repo.threads.get(threadKey)?.subscriptions).toContain(child.id)
    expect(h.repo.tickets.get(child.id)?.inputs[0]).toMatchObject({ kind: 'note', text: 'Delegated task: Investigate failing tests' })
    expect(h.engine.delegate(parent.id, 'delegate-1', 'Investigate failing tests', threadKey, 'a-parent').id).toBe(child.id)
    expect(h.executor.start).toHaveBeenCalledTimes(1)
    expect(prepareTicket).toHaveBeenCalledOnce()
    expect(h.repo.decisions.get(key('decision', 'delegate', parent.id, 'delegate-1'))).toMatchObject({ ticketId: child.id, mandate: parent.mandate })
    expect(() => h.engine.delegate(parent.id, 'delegate-1', 'Different title', threadKey, 'a-parent')).toThrow()
    h.engine.stopTicket(parent.id)
    expect(h.engine.delegate(parent.id, 'delegate-1', 'Investigate failing tests', threadKey, 'stale-assignment').id).toBe(child.id)
  })

  it('holds collaboration notes for a worker waiting on a person and refuses direct delivery to stopped or revoked work', () => {
    const h = makeHarness()
    const sender = h.ticket('sender'), recipient = h.ticket('recipient')
    recipient.assignments[0]!.report = { state: 'blocked', summary: 'waiting for input', at }
    h.repo.tickets.save(sender); h.repo.tickets.save(recipient)
    h.repo.threads.save({ ...h.repo.threads.get(threadKey)!, subscriptions: [sender.id, recipient.id] })
    const result = h.engine.collaborate(sender.id, threadKey, 'context', 'waiting', 'a-sender')
    const input = h.repo.tickets.get(recipient.id)!.inputs[0]!
    expect(input).toMatchObject({ kind: 'note', collaborationTriggerId: result.id })
    expect(h.repo.tickets.get(recipient.id)!.undelivered).not.toContain(input.id)
    const stopped = h.ticket('stopped')
    stopped.ended = { at, by: 'human', outcome: 'stopped' }
    h.repo.tickets.save(stopped)
    expect(() => h.engine.direct(stopped.id, { id: 'direct-stopped', source: 'chat', threads: [ref], actor: mandate.actor, human: true,
      addressed: 'mention', at, text: 'do this', meta: {} })).toThrow('stopped')
    h.setValid(false)
    expect(() => h.engine.direct(sender.id, { id: 'direct-revoked', source: 'chat', threads: [ref], actor: mandate.actor, human: true,
      addressed: 'mention', at, text: 'do this', meta: {} })).toThrow('mandate')
  })

  it('keeps collaboration message and delivery idempotency across Store reopen', () => {
    const directory = mkdtempSync(join(tmpdir(), 'core-collaboration-'))
    const path = join(directory, 'state.sqlite')
    const requestId = 'durable-request'
    const messageId = key('collaboration-trigger', threadKey, 'durable-sender', requestId)
    let nowAt = at
    const build = (repo: Store) => {
      const policy: Policy = { version: 'v1', paused: false, evalTimeoutMs: 60_000, gate: () => ({ admissible: true, strength: 'explicit', basis: { via: 'listed' } }),
        revalidate: () => true, admitsInferred: () => true }
      const options: EngineOptions = { repo, policy: () => policy, scope: { scope: () => ({ listened: true, observed: false }) },
        assessor: { request: vi.fn() }, executor: { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() },
        outbox: { send: vi.fn(), status: () => undefined, withdraw: vi.fn() }, now: () => nowAt }
      return new Engine(options)
    }
    try {
      const first = new Store(path)
      first.triggers.save({ id: 'origin', source: 'chat', threads: [ref], actor: mandate.actor, human: true, at, text: 'start', meta: {} })
      first.threads.save({ key: threadKey, ref, createdAt: at, subscriptions: ['durable-sender', 'durable-recipient'], correlated: [], pending: [], meta: {} })
      for (const id of ['durable-sender', 'durable-recipient']) first.tickets.save({ id, title: id, decisionId: `d-${id}`, mandate, channels: [],
        assignments: [{ id: `a-${id}`, state: 'running', createdAt: at, startedAt: at }], inputs: [], undelivered: [], createdAt: at, updatedAt: at,
        origin: { triggerId: 'origin', triggerIds: ['origin'] } })
      const initial = build(first).collaborate('durable-sender', threadKey, 'persisted fact', requestId, 'a-durable-sender')
      expect(initial.id).toBe(messageId)
      for (let index = 1; index < 30; index++) {
        build(first).collaborate('durable-sender', threadKey, `fact ${index}`, `durable-${index}`, 'a-durable-sender')
      }
      expect(first.threads.get(threadKey)?.collaborationWindow).toEqual({ at, count: 30 })
      first.close()
      const second = new Store(path)
      const duplicate = build(second).collaborate('durable-sender', threadKey, 'persisted fact', requestId, 'a-durable-sender')
      expect(duplicate).toEqual(initial)
      expect(second.threads.get(threadKey)?.collaborationWindow).toEqual({ at, count: 30 })
      const overflowId = key('collaboration-trigger', threadKey, 'durable-sender', 'durable-overflow')
      expect(() => build(second).collaborate('durable-sender', threadKey, 'too many', 'durable-overflow', 'a-durable-sender')).toThrow('Combine messages')
      expect(second.triggers.get(overflowId)).toBeUndefined()
      expect(second.triggers.get(messageId)?.collaboration).toMatchObject({ ticketId: 'durable-sender', requestId })
      expect(second.tickets.get('durable-recipient')?.inputs).toHaveLength(30)
      expect(second.tickets.get('durable-recipient')?.inputs[0]).toEqual(expect.objectContaining({ collaborationTriggerId: messageId }))
      expect(second.read.threadTriggers(threadKey).map(item => item.id)).toContain(messageId)
      second.close()
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
})
