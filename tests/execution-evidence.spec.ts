import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { Ticket } from '../src/core/index.ts'
import { Store } from '../src/app/store.ts'
import { ExecutionEvidence } from '../src/app/execution-evidence.ts'

const clean: (() => void)[] = []
afterEach(() => { for (const done of clean.splice(0)) done() })
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'execution-proof-'))
  let store = new Store(join(directory, 'state.sqlite'))
  const at = (seconds: number) => new Date(Date.UTC(2026, 10, 7, 0, 0, seconds)).toISOString()
  const ticket: Ticket = { id: 'proof-task', title: 'Run the current tests', decisionId: 'd', channels: [],
    mandate: { policyVersion: 'p', scope: 'Run current tests', strength: 'explicit', actor: { source: 'web', id: 'owner' }, basis: { via: 'listed' } },
    assignments: [{ id: 'old-assignment', state: 'running', createdAt: at(0), startedAt: at(0) }],
    inputs: [], undelivered: [], createdAt: at(0), updatedAt: at(0), origin: { triggerId: 't', triggerIds: ['t'] } }
  store.tickets.save(ticket)
  const journal = new ExecutionEvidence(store)
  clean.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
  const event = (type: string, seconds: number, seq: number, data: unknown) => ({ type, time: Date.parse(at(seconds)), seq, data }) as SessionEvent
  const turn = (seconds: number, seq: number, id: number) => journal.capture(ticket.id, event('turn/start', seconds, seq, { turn: id }))
  const call = (seconds: number, seq: number, id: number, callId: string) => journal.capture(ticket.id, event('tool/call', seconds, seq,
    { turn: id, step: 0, callId, name: 'bash', arguments: '{"command":"npm test"}' }))
  const result = (seconds: number, seq: number, id: number, callId: string) => journal.capture(ticket.id, event('tool/result', seconds, seq,
    { turn: id, step: 0, message: { role: 'tool', toolCallId: callId, isError: false, content: [{ type: 'text', text: 'Tests passed.' }] } }))
  const reopen = () => { store.close(); store = new Store(join(directory, 'state.sqlite')); return new ExecutionEvidence(store) }
  return { store, journal, ticket, at, turn, call, result, reopen }
}

it('keeps old assignment results out of current acceptance proof, including late tool completions', () => {
  const h = fixture()
  h.turn(1, 1, 1); h.call(2, 2, 1, 'old-call'); h.result(3, 3, 1, 'old-call')
  expect(h.journal.read(h.ticket.id)).toHaveLength(1)
  const ticket = h.store.tickets.get(h.ticket.id)!
  ticket.assignments[0]!.state = 'ended'; ticket.assignments[0]!.endedAt = h.at(10)
  ticket.assignments.push({ id: 'new-assignment', state: 'running', createdAt: h.at(10), startedAt: h.at(10) })
  h.store.tickets.save(ticket)
  h.result(12, 4, 1, 'old-call')
  expect(h.journal.read(h.ticket.id)).toEqual([])
  h.turn(13, 5, 2); h.call(14, 6, 2, 'new-call'); h.result(15, 7, 2, 'new-call')
  expect(h.journal.read(h.ticket.id)).toHaveLength(1)
  expect(h.journal.read(h.ticket.id)[0]?.text).toContain('new-assignment')
  expect(h.journal.read(h.ticket.id)[0]?.text).toContain('npm test')
})

it('retains assignment provenance after SQLite is reopened', () => {
  const h = fixture()
  h.turn(1, 1, 1); h.call(2, 2, 1, 'call'); h.result(3, 3, 1, 'call')
  const before = h.journal.read(h.ticket.id), restored = h.reopen()
  expect(restored.read(h.ticket.id)).toEqual(before)
  restored.capture(h.ticket.id, { type: 'tool/result', time: Date.parse(h.at(3)), seq: 3,
    data: { turn: 1, step: 0, message: { role: 'tool', toolCallId: 'call', content: [{ type: 'text', text: 'Tests passed.' }] } } } as unknown as SessionEvent)
  expect(restored.read(h.ticket.id)).toHaveLength(1)
})
