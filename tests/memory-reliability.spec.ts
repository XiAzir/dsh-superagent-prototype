import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Memory, type MemoryCorrection, type MemoryMetadata, type MemorySaveArgs } from '../src/app/memory.ts'
import { Store } from '../src/app/store.ts'
import type { Ticket } from '../src/core/index.ts'
import { MEMORY_EVALUATION_AT, MEMORY_EVALUATION_FACTS, MEMORY_RECALL_CASES } from './fixtures/memory-evaluation.ts'

let directory: string, store: Store
const now = () => new Date(MEMORY_EVALUATION_AT)
const base = (overrides: Partial<MemorySaveArgs> = {}): MemorySaveArgs => ({ topic: 'preferred-timezone', title: '会议时区',
  summary: '会议使用上海时区。', content: '当前安排会议时使用 Asia/Shanghai。', expected_revision: 0,
  sources: [{ kind: 'trigger', ref: 'original-request', quote: '会议使用上海时区。' }], evidence: 'user', ...overrides })

function saveTrigger(id: string, text: string, source = 'web'): void {
  store.triggers.save({ id, source, threads: [{ source, id: `thread-${id}` }], actor: { source, id: 'owner' }, human: true,
    at: MEMORY_EVALUATION_AT, text, meta: {} })
}
function memory(): Memory {
  return new Memory(store, { now, tickets: store.tickets, resolveSource: source => {
    if (source.kind !== 'trigger' || !source.quote) return false
    return store.triggers.get(source.ref)?.text.includes(source.quote) ?? false
  } })
}
function ticket(id: string): Ticket {
  return { id, title: id, decisionId: `d-${id}`, mandate: { strength: 'explicit', policyVersion: 'v1', basis: { via: 'listed' },
    actor: { source: 'web', id: 'owner' }, scope: 'project' }, channels: [], assignments: [{ id: `a-${id}`, state: 'running', createdAt: MEMORY_EVALUATION_AT }],
    inputs: [], undelivered: [], createdAt: MEMORY_EVALUATION_AT, updatedAt: MEMORY_EVALUATION_AT,
    origin: { triggerId: 'original-request', triggerIds: ['original-request'] } }
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'memory-reliability-'))
  store = new Store(join(directory, 'orchestrator.sqlite'))
  saveTrigger('original-request', '会议使用上海时区。请保留这个明确约定。')
})
afterEach(() => { store?.close(); if (directory) rmSync(directory, { recursive: true, force: true }) })

describe('durable memory recall evaluation', () => {
  it('finds relevant Chinese facts across scopes and sources, including body-only information after reopening SQLite', () => {
    const first = memory()
    for (const fact of MEMORY_EVALUATION_FACTS) {
      const source = fact.sources[0]!
      if (typeof source === 'string') throw new Error('fixture evidence must be structured')
      saveTrigger(source.ref, source.quote!, fact.topic.includes('qq') ? 'qq' : 'web')
      first.save(fact)
    }
    store.close(); store = new Store(join(directory, 'orchestrator.sqlite'))
    const restarted = memory()
    for (const task of MEMORY_RECALL_CASES) {
      const result = restarted.read({ query: task.query, scopes: task.scopes, includeExpired: false }) as { items: MemoryMetadata[] }
      expect(result.items[0]?.topic, task.name).toBe(task.expected)
      for (const forbidden of task.forbidden) expect(result.items.map(item => item.topic), task.name).not.toContain(forbidden)
      const index = restarted.index({ query: task.query, scopes: task.scopes })
      expect(index, task.name).toContain(task.expected)
      expect(index.length).toBeLessThanOrEqual(3000)
    }
  })

  it('ranks relevant scope, importance, explicit support and confirmation freshness while keeping complete pages reachable', () => {
    const m = memory()
    m.save(base({ topic: 'a-global', importance: 90 }))
    m.save(base({ topic: 'z-scoped', importance: 20, scopes: ['project:a'] }))
    m.save(base({ topic: 'fresh', importance: 70, confirmed_at: '2027-02-06T00:00:00.000Z' }))
    m.save(base({ topic: 'old-confirmation', importance: 70, confirmed_at: '2026-11-01T00:00:00.000Z' }))
    const scoped = m.read({ query: '会议 时区', scopes: ['project:a'] }) as { items: MemoryMetadata[] }
    expect(scoped.items[0]?.topic).toBe('z-scoped')
    const global = m.read({ query: '会议 时区', scopes: ['global'] }) as { items: MemoryMetadata[] }
    expect(global.items.map(item => item.topic)).toEqual(['a-global', 'fresh', 'old-confirmation'])
    expect(m.read({ limit: 1, offset: 3 })).toMatchObject({ items: [expect.any(Object)], total: 4, next_offset: null })
    expect(() => m.read({ topic: 'z-scoped', scopes: ['project:b'] })).toThrow(/outside.*scope/)
  })

  it('combines project and source restrictions and lazily upgrades legacy body search without modifying its revision', () => {
    const m = memory()
    m.save(base({ topic: 'qq-specific', scopes: ['project:a', 'source:qq'] }))
    expect(m.read({ query: '会议 时区', scopes: ['project:a', 'source:web'] })).toMatchObject({ items: [] })
    expect(m.read({ query: '会议 时区', scopes: ['project:a', 'source:qq'] })).toMatchObject({ items: [expect.objectContaining({ topic: 'qq-specific' })] })
    const old = { topic: 'old-body', title: '旧资料', summary: '旧版本保存的采购资料。', revision: 1, status: 'active',
      updatedAt: '2026-11-01T00:00:00.000Z', sources: ['user:old'], content: '供应商报价需要核对交期。' }
    store.set('memory-version:old-body:1', old)
    const { content: _content, ...metadata } = old
    store.set('memory-topic:old-body', metadata)
    expect(m.read({ query: '供应商报价 交期' })).toMatchObject({ items: [expect.objectContaining({ topic: 'old-body', revision: 1 })] })
    expect(store.get('memory-search:old-body')).toBeDefined()
    expect(store.get('memory-topic:old-body')).toEqual(metadata)
  })
})

it('retains unresolved and inferred claims as candidates and requires an actual source quote for activation', () => {
  const m = memory()
  expect(m.save(base({ sources: [{ kind: 'trigger', ref: 'original-request', quote: '这段话从未出现过。' }] })))
    .toMatchObject({ status: 'candidate', confidence: 'unresolved' })
  expect(m.index()).not.toContain('preferred-timezone')
  expect(m.read({ status: 'candidate' })).toMatchObject({ items: [expect.objectContaining({ topic: 'preferred-timezone' })] })
  expect(() => m.save(base({ expected_revision: 1, status: 'active', sources: [{ kind: 'trigger', ref: 'missing', quote: '原始引文' }] }))).toThrow(/resolve.*evidence/)
  const confirmed = m.save(base({ expected_revision: 1 }))
  expect(confirmed).toMatchObject({ status: 'active', confidence: 'supported', sourceRefs: [{ kind: 'trigger', resolution: 'resolved' }] })
  expect(() => m.save(base({ expected_revision: 2, evidence: 'inferred' }))).toThrow(/separate candidate/)
  const conflict = m.save(base({ topic: 'timezone-guess', evidence: 'inferred', conflicts: [{ topic: 'preferred-timezone', revision: 2 }] }))
  expect(conflict).toMatchObject({ status: 'candidate', confidence: 'inferred', conflicts: [{ topic: 'preferred-timezone', revision: 2 }] })
  expect(m.read({ topic: 'preferred-timezone' })).toMatchObject({ revision: 2, status: 'active', effective: true })
})

it('retains legacy evidence with explicit low-trust metadata and normalizes validity timestamps', () => {
  const m = memory()
  const legacy = m.save(base({ topic: 'legacy-source', evidence: undefined, sources: ['user:2026-11-06'] }))
  expect(legacy).toMatchObject({ status: 'active', confidence: 'legacy', sourceRefs: [{ kind: 'legacy', resolution: 'legacy' }] })
  m.save(base({ valid_from: '2027-02-07T08:00:00+08:00', valid_until: '2027-02-07T08:30:00+08:00' }))
  expect(m.index()).not.toContain('preferred-timezone')
  expect(m.read({ topic: 'preferred-timezone' })).toMatchObject({ effective: false, validFrom: '2027-02-07T00:00:00.000Z' })
  m.save(base({ expected_revision: 1, valid_until: null }))
  expect(m.index()).toContain('preferred-timezone')
  expect(() => m.save(base({ expected_revision: 2, valid_from: '2027-02-08T00:00:00Z', valid_until: '2027-02-07T00:00:00Z' }))).toThrow(/valid_until/)
  expect(m.read({ topic: 'preferred-timezone' })).toMatchObject({ revision: 2 })
})

it('persists used revisions and forwards only the latest correction to live tickets across restarts', async () => {
  for (const id of ['live', 'stopping']) store.tickets.save(ticket(id))
  const first = memory(); first.save(base())
  first.read({ topic: 'preferred-timezone', ticketId: 'live' })
  first.index({ ticketId: 'stopping' })
  first.read({ topic: 'preferred-timezone', ticketId: 'live' })
  expect(first.corrections()).toEqual([])
  saveTrigger('correction-1', '会议改用东京时区。')
  first.save(base({ expected_revision: 1, content: 'Asia/Tokyo', summary: '会议改用东京时区。', sources: [{ kind: 'trigger', ref: 'correction-1', quote: '会议改用东京时区。' }] }))
  saveTrigger('correction-2', '会议统一使用 UTC。')
  first.save(base({ expected_revision: 2, content: 'UTC', summary: '会议统一使用 UTC。', sources: [{ kind: 'trigger', ref: 'correction-2', quote: '会议统一使用 UTC。' }] }))
  store.tickets.save({ ...store.tickets.get('stopping')!, ended: { at: MEMORY_EVALUATION_AT, by: 'human', outcome: 'stopped' } })
  store.close(); store = new Store(join(directory, 'orchestrator.sqlite'))
  const restarted = memory(), delivered: MemoryCorrection[] = []
  await restarted.flushCorrections(event => { delivered.push(event) })
  await restarted.flushCorrections(event => { delivered.push(event) })
  expect(delivered).toHaveLength(1)
  expect(delivered[0]).toMatchObject({ ticketId: 'live', previousRevision: 1, revision: 3, summary: '会议统一使用 UTC。' })
  expect(restarted.corrections('stopping').every(event => event.status === 'skipped')).toBe(true)
  expect(restarted.read({ topic: 'preferred-timezone', revision: 1 })).toMatchObject({ content: '当前安排会议时使用 Asia/Shanghai。', effective: false })
})

it('retries the same correction identity after delivery failure and keeps a corrected task subscription current', async () => {
  store.tickets.save(ticket('live'))
  const m = memory(); m.save(base()); m.read({ topic: 'preferred-timezone', ticketId: 'live' })
  m.save(base({ expected_revision: 1, correction_reason: '用户要求刷新确认时间。' }))
  const firstId = m.corrections()[0]!.id
  await m.flushCorrections(() => { throw new Error('temporary delivery failure') })
  expect(m.corrections()[0]).toMatchObject({ id: firstId, status: 'pending', attempts: 1 })
  store.close(); store = new Store(join(directory, 'orchestrator.sqlite'))
  const second = new Memory(store, { now: () => new Date(Date.parse(MEMORY_EVALUATION_AT) + 2000), tickets: store.tickets,
    resolveSource: source => !!source.quote && !!store.triggers.get(source.ref)?.text.includes(source.quote) }), seen = new Set<string>()
  await second.flushCorrections(event => { seen.add(event.id) })
  expect([...seen]).toEqual([firstId])
  expect(second.corrections()[0]).toMatchObject({ status: 'delivered', attempts: 2 })
  second.read({ topic: 'preferred-timezone', ticketId: 'live' })
  second.save(base({ expected_revision: 2 }))
  expect(second.corrections().at(-1)).toMatchObject({ previousRevision: 2, revision: 3 })
})

it('atomically supersedes another topic, retains its historical body, and rejects stale/conflicting replacements', async () => {
  store.tickets.save(ticket('live'))
  const m = memory(); m.save(base()); m.read({ topic: 'preferred-timezone', ticketId: 'live' })
  const replacement = m.save(base({ topic: 'meeting-timezone', supersedes: [{ topic: 'preferred-timezone', revision: 1 }] }))
  expect(replacement.supersedes).toEqual([{ topic: 'preferred-timezone', revision: 1 }])
  expect(m.read({ topic: 'preferred-timezone' })).toMatchObject({ status: 'archived', revision: 2, supersededBy: { topic: 'meeting-timezone', revision: 1 } })
  expect(m.read({ topic: 'preferred-timezone', revision: 1 })).toMatchObject({ content: '当前安排会议时使用 Asia/Shanghai。' })
  expect(store.get<Record<string, unknown>>('memory-topic:preferred-timezone')).not.toHaveProperty('content')
  expect(() => m.save(base({ topic: 'stale-replacement', supersedes: [{ topic: 'preferred-timezone', revision: 1 }] }))).toThrow(/reference conflict/)
  expect(store.get('memory-topic:stale-replacement')).toBeUndefined()
  expect(() => m.save(base({ topic: 'guessed-replacement', evidence: 'inferred', supersedes: [{ topic: 'preferred-timezone', revision: 2 }] }))).toThrow(/resolved evidence/)
  expect(() => m.save(base({ topic: 'future-replacement', valid_from: '2027-03-01T00:00:00.000Z',
    supersedes: [{ topic: 'meeting-timezone', revision: 1 }] }))).toThrow(/effective now/)
  expect(m.read({ topic: 'meeting-timezone' })).toMatchObject({ status: 'active', revision: 1 })
  const delivered: MemoryCorrection[] = []
  await m.flushCorrections(event => { delivered.push(event) })
  expect(delivered).toEqual([expect.objectContaining({ kind: 'superseded', topic: 'preferred-timezone', reference: { topic: 'meeting-timezone', revision: 1 } })])
})

it('queues verification-triggered experience durably and stores extraction output only as an inferred candidate', () => {
  const m = memory()
  const request = m.queueExperience({ ticketId: 'completed-task', acceptedRevision: 'assignment-1:ready:1', sources: base().sources })
  expect(m.queueExperience({ ticketId: 'completed-task', acceptedRevision: 'assignment-1:ready:1', sources: base().sources }).id).toBe(request.id)
  expect(() => m.queueExperience({ ticketId: 'completed-task', acceptedRevision: 'assignment-1:ready:1', sources: ['user:other'] })).toThrow(/different sources/)
  store.close(); store = new Store(join(directory, 'orchestrator.sqlite'))
  const restarted = memory()
  expect(restarted.pendingExperiences()).toEqual([expect.objectContaining({ id: request.id })])
  const candidate = restarted.completeExperience(request.id, { topic: 'meeting-experience', title: '会议处理经验', summary: '考虑时区后再发送会议草稿。', content: '先核对参会者时区。' })
  expect(candidate).toMatchObject({ status: 'candidate', evidence: 'inferred', confidence: 'inferred' })
  expect(restarted.pendingExperiences()).toEqual([])
  expect(restarted.index()).not.toContain('meeting-experience')
  expect(restarted.completeExperience(request.id, { topic: 'ignored-retry', title: 'ignored', summary: 'ignored', content: 'ignored' })).toMatchObject({ topic: 'meeting-experience', revision: 1 })
})

it('follows cross-topic replacement chains when another correction arrives before the first notification is delivered', async () => {
  store.tickets.save(ticket('live'))
  const m = memory(); m.save(base()); m.read({ topic: 'preferred-timezone', ticketId: 'live' })
  m.save(base({ topic: 'timezone-replacement', supersedes: [{ topic: 'preferred-timezone', revision: 1 }] }))
  m.save(base({ topic: 'timezone-replacement', expected_revision: 1, summary: '最新会议时区约定。' }))
  store.close(); store = new Store(join(directory, 'orchestrator.sqlite'))
  const delivered: MemoryCorrection[] = []
  await memory().flushCorrections(event => { delivered.push(event) })
  expect(delivered).toEqual([expect.objectContaining({ topic: 'timezone-replacement', previousRevision: 1, revision: 2 })])
  expect(memory().corrections().filter(event => event.status === 'skipped')).toHaveLength(1)
})

it('notifies a live consumer once when a fact expires during its task', async () => {
  store.tickets.save(ticket('live'))
  let at = new Date(MEMORY_EVALUATION_AT)
  const m = new Memory(store, { now: () => at, tickets: store.tickets,
    resolveSource: source => !!source.quote && !!store.triggers.get(source.ref)?.text.includes(source.quote) })
  m.save(base({ valid_until: '2027-02-08T00:00:00.000Z' }))
  m.read({ topic: 'preferred-timezone', ticketId: 'live' })
  at = new Date('2027-02-09T00:00:00.000Z')
  const delivered: MemoryCorrection[] = []
  await m.flushCorrections(event => { delivered.push(event) })
  await m.flushCorrections(event => { delivered.push(event) })
  expect(delivered).toEqual([expect.objectContaining({ kind: 'expired', revision: 1, ticketId: 'live' })])
  expect(m.index()).not.toContain('preferred-timezone')
})

it('replays a correction after a real process crash between Engine commit and memory acknowledgement without duplicate inputs', () => {
  const script = fileURLToPath(new URL('./fixtures/memory-restart-child.ts', import.meta.url))
  const path = join(directory, 'child.sqlite')
  const run = (operation: string) => JSON.parse(execFileSync(process.execPath, ['--experimental-transform-types', script, operation, path],
    { encoding: 'utf8', timeout: 15_000, windowsHide: true, env: { ...process.env, NODE_NO_WARNINGS: '1' } })) as
      { corrections: MemoryCorrection[]; inputs: { id: string; text: string }[]; memory: { revision: number; content: string } }
  run('setup'); run('correct')
  let exitStatus: number | null = null
  try { run('deliver-crash') } catch (error) { exitStatus = (error as { status: number | null }).status }
  expect(exitStatus).toBe(17)
  const afterCrash = run('inspect')
  expect(afterCrash.inputs).toHaveLength(1)
  expect(afterCrash.corrections[0]?.status).toBe('pending')
  const replay = run('deliver')
  expect(replay.inputs).toHaveLength(1)
  expect(replay.inputs[0]?.id).toBe(afterCrash.inputs[0]?.id)
  expect(replay.corrections[0]?.status).toBe('delivered')
  expect(run('deliver').inputs).toHaveLength(1)
  expect(replay.memory).toMatchObject({ revision: 2, content: 'Asia/Tokyo' })
})
