import { expect, it } from 'vitest'
import { Memory, type MemoryStore } from '../src/app/memory.ts'
import type { Family, Key } from '../src/kv.ts'

class MemoryKV implements MemoryStore {
  readonly values = new Map<string, unknown>()
  get<T>(key: string): T | undefined { return this.values.get(key) as T | undefined }
  set<T>(key: string, value: T): void { this.values.set(key, structuredClone(value)) }
  keys<V>(family: Family<V, never>): Key<V>[]
  keys(prefix: string): string[]
  keys(family: string | Family<unknown, never>): string[] {
    const prefix = typeof family === 'string' ? family : family.prefix
    return [...this.values.keys()].filter(key => key.startsWith(prefix))
  }
  atomic<T>(work: () => T): T { return work() }
}

const data = (overrides: Partial<Parameters<Memory['save']>[0]> = {}) => ({
  topic: 'response-style', title: 'Response style', summary: 'Use concise, direct answers.',
  content: 'Prefer short paragraphs and concrete wording.', expected_revision: 0,
  sources: ['user:2026-11-06'], ...overrides,
})

it('reuses persisted topics in a new Memory instance and keeps the index progressive and bounded', () => {
  const store = new MemoryKV()
  const first = new Memory(store)
  first.save(data())
  const second = new Memory(store)
  expect(second.index()).toContain('response-style')
  expect(second.index()).not.toContain('Prefer short paragraphs')
  expect(second.index().length).toBeLessThanOrEqual(3000)

  for (let i = 0; i < 45; i++) second.save(data({ topic: `topic-${i}`, title: 'x'.repeat(100), summary: 'y'.repeat(180),
    expected_revision: 0, content: 'secret-body'.repeat(10) }))
  expect(second.index().length).toBeLessThanOrEqual(3000)
  expect(second.index().split('\n').filter(line => line.startsWith('- ')).length).toBeLessThanOrEqual(30)
  expect(second.index()).not.toContain('secret-body')
})

it('uses CAS revisions, retains old bodies, and reports conflicts clearly', () => {
  const store = new MemoryKV()
  const memory = new Memory(store)
  const one = memory.save(data())
  expect(one.revision).toBe(1)
  expect(() => memory.save(data({ expected_revision: 0, content: 'stale write' }))).toThrow(/revision conflict.*expected 0, current is 1/)
  const two = memory.save(data({ expected_revision: 1, content: 'Corrected durable preference.', sources: ['trigger:abc123'] }))
  expect(two.revision).toBe(2)
  expect(memory.read({ topic: 'response-style', revision: 1, limit: 100 })).toMatchObject({ revision: 1, content: 'Prefer short paragraphs and concrete wording.' })
  expect(memory.read({ topic: 'response-style', limit: 100 })).toMatchObject({ revision: 2, content: 'Corrected durable preference.', sources: ['trigger:abc123'] })
})

it('archives and restores as new revisions while archived topics stay readable', () => {
  const store = new MemoryKV()
  const memory = new Memory(store)
  memory.save(data())
  const archived = memory.save(data({ expected_revision: 1, status: 'archived' }))
  expect(archived).toMatchObject({ revision: 2, status: 'archived' })
  expect(memory.index()).not.toContain('response-style')
  expect(memory.read({ topic: 'response-style' })).toMatchObject({ revision: 2, status: 'archived' })
  const restored = memory.save(data({ expected_revision: 2, status: 'active' }))
  expect(restored).toMatchObject({ revision: 3, status: 'active' })
  expect(memory.index()).toContain('response-style')
})

it('pages directories and topic content and validates tool input bounds', async () => {
  const memory = new Memory(new MemoryKV())
  for (let i = 0; i < 3; i++) memory.save(data({ topic: `topic-${i}`, content: '0123456789', expected_revision: 0 }))
  expect(memory.read({ offset: 0, limit: 2 })).toMatchObject({ items: [{ topic: 'topic-0' }, { topic: 'topic-1' }], next_offset: 2, total: 3 })
  expect(memory.read({ topic: 'topic-0', offset: 3, limit: 4 })).toMatchObject({ content: '3456', offset: 3, next_offset: 7, total: 10 })
  const [read, save] = memory.tools()
  await expect(read!.schema.parseAsync({ topic: '../secret' })).rejects.toThrow()
  await expect(save!.schema.parseAsync({ ...data(), title: 'x'.repeat(101) })).rejects.toThrow()
  await expect(save!.schema.parseAsync({ ...data(), content: 'x'.repeat(24001) })).rejects.toThrow()
  await expect(save!.schema.parseAsync({ ...data(), sources: [] })).rejects.toThrow()
  expect(() => memory.save(data({ topic: 'Uppercase' }))).toThrow(/lowercase slug/)
})

it('keeps directory pages compact even with many topics and lengthy source evidence', () => {
  const memory = new Memory(new MemoryKV())
  for (let i = 0; i < 65; i++) memory.save(data({ topic: `topic-${i}`, sources: ['x'.repeat(500)], content: 'body' }))
  const page = memory.read({}) as { items: Record<string, unknown>[]; next_offset: number }
  expect(page.items).toHaveLength(20)
  expect(page.next_offset).toBe(20)
  expect(page.items[0]).not.toHaveProperty('sources')
  expect((memory.read({ limit: 8000 }) as { items: unknown[] }).items).toHaveLength(50)
  expect(memory.read({ query: 'topic-64' })).toMatchObject({ items: [{ topic: 'topic-64' }], total: 1 })
})
