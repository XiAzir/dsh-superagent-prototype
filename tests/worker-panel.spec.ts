import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Engine, type Ticket, type Trigger } from '../src/core/index.ts'
import { Store } from '../src/app/store.ts'
import { TaskRooms } from '../src/app/task-rooms.ts'
import { workerPanel } from '../src/app/worker-panel.ts'
import { webSource } from '../src/app/web-tasks.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { record } from '../src/kv.ts'

let directory: string
let store: Store
let engine: Engine
let rooms: TaskRooms
let sources: SourceRegistry
let tick: number
const masterId = 'router-session'
const now = () => new Date(Date.parse('2026-11-06T10:00:00.000Z') + tick++).toISOString()
const actor = { source: 'web', id: 'owner' }

function configure() {
  sources = new SourceRegistry(() => store.settings())
  sources.register(webSource(store, () => true))
  engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources),
    assessor: { request: vi.fn() }, executor: { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() },
    outbox: { send: vi.fn(), status: () => undefined, withdraw: vi.fn() }, now })
  rooms = new TaskRooms({ store, engine, personal: () => true, configured: () => true, requestPass: vi.fn() })
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'worker-panel-'))
  store = new Store(join(directory, 'state.sqlite'))
  store.saveSettings(SettingsSchema.parse({ sources: { web: { enabled: true, config: {} } },
    policy: { sources: { web: { allowed: [{ id: 'owner', name: 'Owner' }] } } } }))
  tick = 0
  configure()
})
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })

function accept(id: string, roomId: string): Ticket {
  const ref = { source: 'web', id: roomId }
  const trigger: Trigger = { id, source: 'web', routing: 'router', threads: [ref], actor, human: true,
    addressed: 'direct', at: now(), text: `Request ${id}`,
    channel: { source: 'web', thread: `web:${roomId}`, address: { room: roomId } }, meta: {} }
  expect(engine.receive(trigger)).toBe('stored')
  const decision = engine.decide(id, { kind: 'accept', title: `Worker ${id}`, scope: 'test', reason: 'requested', name: id })
  const ticket = store.tickets.get(decision.ticketId!)!
  engine.assignmentStarted(ticket.id, ticket.assignments[0]!.id)
  return store.tickets.get(ticket.id)!
}

const view = (sessionId: string) => workerPanel({ store, rooms, masterId,
  conversationIds: ['loaded-empty-conversation'] }, sessionId)

describe('worker panel projection', () => {
  it('returns bounded worker progress, completion, waiting and attention details with redaction', () => {
    const ticket = accept('report-ticket', 'report-room')
    engine.report(ticket.id, { state: 'waiting', summary: 'Waiting with token=private-value',
      completed: ['Build done'], pending: ['Run checks'], waitingFor: { kind: 'external', subject: 'CI result' },
      nextCheck: { key: 'ci-result', at: '2026-11-06T11:00:00.000Z', purpose: 'Check CI',
        successCondition: 'CI completed', resumeInstruction: 'Continue after CI completes' },
      question: 'Please approve this?' }, ticket.assignments[0]!.id)
    const panel = view('router-session')
    expect(panel).toMatchObject({ eligible: true, scope: 'router', pending: false })
    expect(panel.workers).toEqual([expect.objectContaining({ id: ticket.id, action: 'answer', completed: ['Build done'],
      pending: ['Run checks'], waitingFor: 'CI result', attention: 'Please approve this?', roomKey: 'web:report-room' })])
    expect(panel.workers[0]!.summary).toContain('[redacted]')
    expect(panel.workers[0]!.summary).not.toContain('private-value')
  })

  it('keeps conversations scoped, recognizes loaded empty conversations, aggregates Router rooms and hides unknown sessions', () => {
    const firstTicket = accept('first-room-worker', 'first-room')
    const secondTicket = accept('second-room-worker', 'second-room')
    store.set(record<{ sessionId: string; cwd: string }>('session-conversation:known-conversation'),
      { sessionId: 'known-conversation', cwd: 'C:\\project' })
    const threadKey = 'dsh-session:known-conversation'
    store.threads.save({ key: threadKey, ref: { source: 'dsh-session', id: 'known-conversation' }, createdAt: now(),
      subscriptions: [], correlated: [], pending: [], meta: {} })
    const first = view('known-conversation')
    expect(first).toMatchObject({ eligible: true, scope: 'conversation', workers: [],
      rooms: [{ key: 'dsh-session:known-conversation' }] })
    expect(view('loaded-empty-conversation')).toMatchObject({ eligible: true, scope: 'conversation', workers: [] })
    const router = view(masterId)
    expect(router.workers.map(worker => worker.id)).toEqual(expect.arrayContaining([firstTicket.id, secondTicket.id]))
    expect(router.rooms.map(room => room.key)).toEqual(expect.arrayContaining(['web:first-room', 'web:second-room']))
    expect(view('unknown-session')).toEqual({ sessionId: 'unknown-session', eligible: false, scope: null, pending: false,
      paused: false, workers: [], messages: [], rooms: [] })
  })

  it('deduplicates room dynamics by event id and returns chronological messages within the cap', () => {
    const ticket = accept('multi-room-worker', 'multi-room')
    engine.report(ticket.id, { state: 'progress', summary: 'Progress one' }, ticket.assignments[0]!.id)
    const trigger: Trigger = { id: 'shared-router-event', source: 'web', routing: 'router',
      threads: [{ source: 'web', id: 'multi-room' }, { source: 'web', id: 'second-room' }], actor, human: true,
      addressed: 'direct', at: now(), text: 'Shared update', channel: { source: 'web', thread: 'web:multi-room', address: { room: 'multi-room' } }, meta: {} }
    expect(engine.receive(trigger)).toBe('stored')
    const panel = view(masterId)
    expect(panel.messages.filter(item => item.id === 'trigger:shared-router-event')).toHaveLength(1)
    expect(panel.messages.map(item => item.at)).toEqual([...panel.messages.map(item => item.at)].sort())
    expect(panel.messages.length).toBeLessThanOrEqual(60)
  })
})
