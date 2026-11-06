/** A real process boundary for durable correction replay, including a crash after Engine input commit. */
import { Store } from '../../src/app/store.ts'
import { Memory } from '../../src/app/memory.ts'
import { Engine, type Ticket } from '../../src/core/index.ts'

const [operation, path] = process.argv.slice(2)
if (!path) throw new Error('memory restart fixture needs an operation and database path')
const at = '2026-11-07T01:00:00.000Z'
const store = new Store(path)
const memory = new Memory(store, { now: () => new Date(at), tickets: store.tickets, resolveSource: source => source.kind === 'trigger'
  && !!source.quote && !!store.triggers.get(source.ref)?.text.includes(source.quote) })
const trigger = (id: string, text: string) => store.triggers.save({ id, source: 'web', threads: [{ source: 'web', id: 'meeting' }],
  actor: { source: 'web', id: 'owner' }, human: true, text, at, meta: {} })
const engine = new Engine({ repo: store, now: () => at,
  scope: { scope: () => ({ listened: true, observed: false }) },
  policy: () => ({ version: '1', paused: false, evalTimeoutMs: 1000, gate: () => ({ admissible: true, strength: 'explicit', basis: { via: 'listed' } }),
    revalidate: () => true, admitsInferred: () => true }),
  assessor: { request() {} }, executor: { start() {}, deliver() {}, stop() {} },
  outbox: { send() {}, status() { return undefined }, withdraw() {} },
})

if (operation === 'setup') {
  const ticket: Ticket = { id: 'live-task', title: '安排会议', decisionId: 'decision', mandate: { strength: 'explicit', policyVersion: '1',
    basis: { via: 'listed' }, actor: { source: 'web', id: 'owner' }, scope: '安排会议' }, channels: [],
    assignments: [{ id: 'assignment', state: 'running', createdAt: at }], inputs: [], undelivered: [], createdAt: at, updatedAt: at,
    origin: { triggerId: 'timezone-1', triggerIds: ['timezone-1'] } }
  store.tickets.save(ticket); trigger('timezone-1', '会议使用上海时区。')
  memory.save({ topic: 'meeting-timezone', title: '会议时区', summary: '会议使用上海时区。', content: 'Asia/Shanghai', expected_revision: 0,
    evidence: 'user', sources: [{ kind: 'trigger', ref: 'timezone-1', quote: '会议使用上海时区。' }] })
  memory.read({ topic: 'meeting-timezone', ticketId: ticket.id })
} else if (operation === 'correct') {
  trigger('timezone-2', '会议改用东京时区。')
  memory.save({ topic: 'meeting-timezone', title: '会议时区', summary: '会议改用东京时区。', content: 'Asia/Tokyo', expected_revision: 1,
    evidence: 'user', sources: [{ kind: 'trigger', ref: 'timezone-2', quote: '会议改用东京时区。' }] })
} else if (operation === 'deliver' || operation === 'deliver-crash') {
  await memory.flushCorrections(event => {
    engine.note(event.ticketId, `Memory correction ${event.topic} r${event.previousRevision} -> r${event.revision}: ${event.summary}`, event.id)
    if (operation === 'deliver-crash') process.exit(17)
  })
} else if (operation !== 'inspect') throw new Error('unknown memory restart operation')

const result = { corrections: memory.corrections(), inputs: store.tickets.get('live-task')?.inputs,
  memory: memory.read({ topic: 'meeting-timezone' }) }
store.close()
process.stdout.write(JSON.stringify(result))
