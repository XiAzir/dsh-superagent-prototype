import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { Effects } from '../src/app/effects.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { Memory } from '../src/app/memory.ts'
import { MemoryExperienceService, type MemoryExperienceHost } from '../src/app/memory-experience.ts'
import { completionKey, type Ticket } from '../src/core/index.ts'
import { record } from '../src/kv.ts'
import type { VerificationRecord } from '../src/app/verification.ts'

const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })
const at = '2026-11-07T01:00:00.000Z'
type Model = MemoryExperienceHost['runModel']
function fixture(model: Model) {
  const directory = mkdtempSync(join(tmpdir(), 'memory-experience-')), path = join(directory, 'state.sqlite')
  let store!: Store, memory!: Memory, effects!: Effects, service!: MemoryExperienceService, controller!: AbortController
  let clock = Date.parse(at), paused = false
  function open(nextModel = model) {
    store = new Store(path); memory = new Memory(store, { now: () => new Date(clock), tickets: store.tickets })
    effects = new Effects(store, new HealthBoard(), () => clock); controller = new AbortController()
    service = new MemoryExperienceService({ store, memory, effects, runModel: nextModel, lifetime: controller.signal,
      paused: () => paused, now: () => clock, scopes: () => ['project:Atlas', 'source:web'] })
  }
  open()
  cleanup.push(async () => { controller.abort(); await effects.drain(); store.close(); rmSync(directory, { recursive: true, force: true }) })
  const ticket: Ticket = { id: 'task', title: '创建任务结果', decisionId: 'decision', channels: [],
    mandate: { strength: 'explicit', policyVersion: '1', basis: { via: 'listed' }, actor: { source: 'web', id: 'owner' }, scope: '项目 Atlas' },
    assignments: [{ id: 'assignment', state: 'running', createdAt: at, report: { state: 'ready', at, summary: '已完成时区校验。' } }],
    acceptance: { mode: 'enforce', revision: 1, createdAt: at, criteria: [{ id: 'goal', description: '安排会议前先校验时区', kind: 'content', sourceRefs: ['trigger/request'] }] },
    origin: { triggerId: 'request', triggerIds: ['request'] }, inputs: [], undelivered: [], createdAt: at, updatedAt: at }
  store.tickets.save(ticket)
  store.triggers.save({ id: 'request', source: 'web', threads: [{ source: 'web', id: 'conversation' }], actor: { source: 'web', id: 'owner' },
    human: true, at, text: '项目 Atlas 安排会议前先校验参与者时区。', meta: {} })
  const review: VerificationRecord = { id: 'review', ticketId: ticket.id, reportKey: completionKey(ticket), acceptanceRevision: 1,
    state: 'passed', at, startedAt: at, attempt: 1, summary: '实际结果确认了时区校验步骤。', checks: [
      { criterionId: 'goal', state: 'passed', summary: '执行结果符合要求', evidenceRefs: ['execution/timezone'] }], evidence: [
      { ref: 'execution/timezone', kind: 'execution', coverage: 'complete', text: 'Asia/Shanghai 与 Asia/Tokyo 已确认；会议邀请草稿采用各自时区。' },
      { ref: 'trigger/request', kind: 'source', coverage: 'complete', text: '项目 Atlas 安排会议前先校验参与者时区。' }] }
  function saveReview(value = review) {
    store.set(record<VerificationRecord>(`verification-review:${value.id}`), value)
    store.set(record<{ id: string }>(`verification-active:${value.ticketId}`), { id: value.id })
  }
  saveReview()
  return { get store() { return store }, get memory() { return memory }, get effects() { return effects }, get service() { return service },
    review, saveReview, clock: (ms: number) => { clock += ms }, pause: (value: boolean) => { paused = value },
    mutate: (change: (ticket: Ticket) => void) => { const latest = store.tickets.get(ticket.id)!; change(latest); store.tickets.save(latest) },
    async restart(nextModel = model) { controller.abort(); await effects.drain(); store.close(); open(nextModel) } }
}
const candidate: Model = async input => {
  const data = JSON.parse(input)
  return { text: JSON.stringify({ keep: true, title: 'Atlas 会议校验经验', summary: '邀请会议前校验各参与者时区。',
    content: '项目 Atlas 安排跨时区会议时，先确认参与者时区，再准备会议邀请草稿。单次已验收结果提供候选经验，后续仍需确认适用性。',
    evidenceRefs: [data.evidence[0].ref], aliases: ['跨时区会议'] }), model: { provider: 'stub', model: 'independent' } }
}

it('atomically queues an accepted report and resumes its SQLite effect after reopening, with one inferred candidate', async () => {
  const model = vi.fn(candidate), h = fixture(model)
  const request = h.service.submit(h.review)!
  expect(h.effects.pending('memory-experience', request.id)).toBe(true)
  expect(h.memory.pendingExperiences()).toHaveLength(1)
  await h.restart()
  h.effects.start(); await h.effects.idle('memory-experience')
  expect(model).toHaveBeenCalledTimes(1)
  const completed = h.memory.experience(request.id)!
  expect(completed).toMatchObject({ status: 'completed', acceptedRevision: h.review.reportKey })
  const saved = h.memory.read({ topic: completed.candidate!.topic }) as Record<string, unknown>
  expect(saved).toMatchObject({ status: 'candidate', evidence: 'inferred', confidence: 'inferred', scopes: ['project:Atlas', 'source:web'] })
  expect(saved.content).toContain(h.review.reportKey)
  expect(saved.sourceRefs).toEqual([expect.objectContaining({ kind: 'ticket', ref: 'task', locator: expect.stringContaining(h.review.id) }),
    expect.objectContaining({ kind: 'document', ref: 'execution/timezone' })])
  expect(h.memory.index()).not.toContain(completed.candidate!.topic)
  expect(h.service.submit(h.review)?.id).toBe(request.id)
  const repeated = { ...h.review, id: 'second-review', attempt: 2 }
  h.saveReview(repeated); expect(h.service.submit(repeated)?.id).toBe(request.id)
  await h.restart(); h.effects.start(); await h.effects.idle('memory-experience')
  expect(model).toHaveBeenCalledTimes(1)
  expect(h.memory.pendingExperiences()).toHaveLength(0)
})

it('repairs a missing effect from the durable pending extraction index after SQLite restart', async () => {
  const model = vi.fn(candidate), h = fixture(model), request = h.service.add(h.review)!
  h.store.db.prepare('DELETE FROM effect WHERE kind = ?').run('memory-experience')
  await h.restart()
  expect(h.effects.pending('memory-experience', request.id)).toBe(true)
  h.effects.start(); await h.effects.idle('memory-experience')
  expect(model).toHaveBeenCalledTimes(1)
  expect(h.memory.experience(request.id)?.status).toBe('completed')
})

it('retains one pending request when the exact report passes a repeated acceptance review before dispatch', async () => {
  const model = vi.fn(candidate), h = fixture(model), request = h.service.submit(h.review)!
  const repeated = { ...h.review, id: 'second-review', attempt: 2 }
  h.saveReview(repeated)
  expect(h.service.submit(repeated)?.id).toBe(request.id)
  h.effects.start(); await h.effects.idle('memory-experience')
  expect(model).toHaveBeenCalledTimes(1)
  expect(h.memory.experience(request.id)?.status).toBe('completed')
  expect(h.service.get(request.id)?.reviewId).toBe(h.review.id)
})

it('waits for an in-progress repeat review of the same report without spending a model attempt', async () => {
  const model = vi.fn(candidate), h = fixture(model), request = h.service.submit(h.review)!
  h.store.set(record<{ id: string }>('verification-active:task'), { id: 'second-review' })
  h.effects.start(); await h.effects.idle('memory-experience')
  expect(model).not.toHaveBeenCalled()
  expect(h.service.get(request.id)).toMatchObject({ state: 'queued', attempts: 0 })
  h.saveReview({ ...h.review, id: 'second-review', attempt: 2 }); h.clock(2000)
  await h.effects.idle('memory-experience')
  expect(h.memory.experience(request.id)?.status).toBe('completed')
  expect(model).toHaveBeenCalledTimes(1)
})

it('persists bounded failures across restarts and leaves the worker and active facts untouched', async () => {
  const model = vi.fn<Model>(async () => { throw new Error('temporary model outage') }), h = fixture(model)
  h.memory.save({ topic: 'active-fact', title: '既有事实', summary: '保留既有事实。', content: 'original', expected_revision: 0, sources: ['user:original'] })
  const before = h.store.tickets.get('task'), request = h.service.submit(h.review)!
  h.effects.start(); await h.effects.idle('memory-experience')
  expect(h.service.get(request.id)).toMatchObject({ state: 'queued', attempts: 1, error: 'temporary model outage' })
  await h.restart(); h.clock(2000); h.effects.start(); await h.effects.idle('memory-experience')
  expect(h.service.get(request.id)?.attempts).toBe(2)
  h.clock(4000); h.effects.kick(); await h.effects.idle('memory-experience')
  expect(model).toHaveBeenCalledTimes(3)
  expect(h.service.get(request.id)).toMatchObject({ state: 'failed', attempts: 3 })
  expect(h.memory.experience(request.id)?.status).toBe('skipped')
  expect(h.effects.pending('memory-experience', request.id)).toBe(false)
  expect(h.memory.pendingExperiences()).toHaveLength(0)
  expect(h.store.tickets.get('task')).toEqual(before)
  expect(h.memory.read({ topic: 'active-fact' })).toMatchObject({ revision: 1, content: 'original' })
})

it('allows keep=false to finish quietly, durably and idempotently', async () => {
  const model = vi.fn<Model>(async () => ({ text: '{"keep":false,"reason":"任务只有临时状态"}' })), h = fixture(model)
  const request = h.service.submit(h.review)!
  h.effects.start(); await h.effects.idle('memory-experience')
  expect(h.memory.experience(request.id)).toMatchObject({ status: 'skipped', skipReason: '任务只有临时状态' })
  expect(h.memory.pendingExperiences()).toHaveLength(0)
  expect(h.memory.read({ status: 'candidate' })).toMatchObject({ total: 0 })
  expect(() => h.memory.completeExperience(request.id, { topic: 'late-output', title: 'late', summary: 'late', content: 'late' })).toThrow(/skipped/)
  await h.restart(); h.effects.start(); h.service.submit(h.review); await h.effects.idle('memory-experience')
  expect(model).toHaveBeenCalledTimes(1)
})

it.each(['human-stop', 'report', 'acceptance', 'correction', 'review'] as const)('discards %s changed before dispatch', async change => {
  const model = vi.fn(candidate), h = fixture(model), request = h.service.submit(h.review)!
  if (change === 'review') h.saveReview({ ...h.review, id: 'new-review', state: 'unknown' })
  else h.mutate(ticket => {
    if (change === 'human-stop') ticket.ended = { at, by: 'human', outcome: 'stopped' }
    if (change === 'report') ticket.assignments[0]!.report!.summary = 'new result'
    if (change === 'acceptance') ticket.acceptance!.revision++
    if (change === 'correction') ticket.inputs.push({ id: 'correction', kind: 'note', at, text: '新增更正：请先检查当前情况。' })
  })
  const before = h.store.tickets.get('task')
  h.effects.start(); await h.effects.idle('memory-experience')
  expect(model).not.toHaveBeenCalled()
  expect(h.memory.experience(request.id)?.status).toBe('skipped')
  expect(h.memory.pendingExperiences()).toHaveLength(0)
  expect(h.store.tickets.get('task')).toEqual(before)
})

it.each(['human-stop', 'report', 'correction'] as const)('rechecks %s while an independent model is running', async change => {
  let resolve: (value: Awaited<ReturnType<Model>>) => void = () => {}
  const model = vi.fn<Model>(() => new Promise(done => { resolve = done })), h = fixture(model)
  const request = h.service.submit(h.review)!
  h.effects.start(); h.effects.kick()
  await vi.waitFor(() => { expect(model).toHaveBeenCalledTimes(1) })
  h.mutate(ticket => {
    if (change === 'human-stop') ticket.ended = { at, by: 'human', outcome: 'stopped' }
    if (change === 'report') ticket.assignments[0]!.report!.at = '2026-11-07T02:00:00.000Z'
    if (change === 'correction') ticket.inputs.push({ id: 'correction', kind: 'trigger', triggerId: 'fix', at, human: true })
  })
  resolve(await candidate(model.mock.calls[0]![0], new AbortController().signal))
  await h.effects.idle('memory-experience')
  expect(h.memory.experience(request.id)?.status).toBe('skipped')
  expect(h.memory.read({ status: 'candidate' })).toMatchObject({ total: 0 })
})

it('permits the normal accepted task completion while extraction runs and respects a pause before dispatch', async () => {
  const model = vi.fn(candidate), h = fixture(model)
  h.pause(true); const request = h.service.submit(h.review)!
  h.effects.start(); await h.effects.idle('memory-experience'); expect(model).not.toHaveBeenCalled()
  h.mutate(ticket => { ticket.ended = { at, by: 'executor', outcome: 'completed' }; ticket.assignments[0]!.state = 'ended' })
  h.pause(false); await h.effects.idle('memory-experience')
  expect(h.memory.experience(request.id)?.status).toBe('completed')
})

it('rejects invented evidence and unaccepted or superseded verification records', async () => {
  const model = vi.fn<Model>(async input => {
    const output = JSON.parse((await candidate(input, new AbortController().signal)).text)
    output.evidenceRefs = ['execution/invented']; return { text: JSON.stringify(output) }
  }), h = fixture(model)
  expect(h.service.submit({ ...h.review, state: 'unknown' })).toBeUndefined()
  expect(h.service.submit({ ...h.review, superseded: true })).toBeUndefined()
  expect(h.service.submit({ ...h.review, acceptanceRevision: 2 })).toBeUndefined()
  const request = h.service.submit(h.review)!
  h.effects.start(); await h.effects.idle('memory-experience')
  expect(h.service.get(request.id)).toMatchObject({ state: 'queued', error: 'Experience cited unavailable evidence' })
  expect(h.memory.read({ status: 'candidate' })).toMatchObject({ total: 0 })
})
