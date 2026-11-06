import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Assignment, Ticket } from '../src/core/index.ts'
import { Store } from '../src/app/store.ts'
import { WorkerProgress, type ProgressReminder } from '../src/app/worker-progress.ts'
import { DshExecutor, type ExecutorHost } from '../src/executor/dsh.ts'
import { record } from '../src/kv.ts'

const MINUTE = 60_000
let directory: string, store: Store, clock: number, paused: boolean, closing: boolean
let tickets: Ticket[]
const assignment = (): Assignment => ({ id: 'assignment-1', state: 'running', createdAt: new Date(clock).toISOString(), startedAt: new Date(clock).toISOString() })
const ticket = (): Ticket => ({ id: 'ticket-1', title: 'Inspect service', createdAt: new Date(clock).toISOString(), updatedAt: new Date(clock).toISOString(),
  assignments: [assignment()], inputs: [], undelivered: [] } as unknown as Ticket)
const saved = () => store.get(record<{ anchor: string; dueAt: number; sequence: number; previousRequestId?: string }>('worker-progress:ticket-1'))
const coordinator = (remind = vi.fn(async (_reminder: ProgressReminder) => true), random = () => .5, cancel = vi.fn()) => {
  const progress = new WorkerProgress({ store: { tickets: { open: () => tickets.filter(value => !value.ended), get: (id: string) => tickets.find(value => value.id === id) },
    get: store.get.bind(store), set: store.set.bind(store), delete: store.delete.bind(store), keys: store.keys.bind(store) } as never,
  paused: () => paused, closing: () => closing, remind, cancel }, () => clock, random)
  return { progress, remind, cancel }
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'worker-progress-'))
  store = new Store(join(directory, 'state.sqlite'))
  clock = Date.parse('2026-11-07T00:00:00.000Z'); paused = false; closing = false; tickets = [ticket()]
})
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })

describe('periodic Worker summaries', () => {
  it('jitter spans 5-15 minutes and advances only after delivery', async () => {
    const random = vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(1)
    const { progress, remind } = coordinator(undefined, random)
    progress.tick(); expect(saved()?.dueAt).toBe(clock + 5 * MINUTE)
    clock += 5 * MINUTE - 1; progress.tick(); expect(remind).not.toHaveBeenCalled()
    clock++; progress.tick(); await progress.drain()
    expect(remind).toHaveBeenCalledTimes(1)
    expect(saved()).toMatchObject({ dueAt: clock + 15 * MINUTE, sequence: 1 })
  })
  it('resets from the actual stage report timestamp while ignoring unrelated updates', () => {
    const { progress } = coordinator()
    progress.tick(); const firstDue = saved()?.dueAt
    clock += 2 * MINUTE; tickets[0]!.updatedAt = new Date(clock).toISOString(); progress.tick()
    expect(saved()?.dueAt).toBe(firstDue)
    tickets[0]!.assignments[0]!.report = { state: 'progress', summary: 'Completed inventory; validating findings next.', at: new Date(clock).toISOString() }
    clock += MINUTE; progress.tick()
    expect(saved()?.dueAt).toBe(clock + 9 * MINUTE)
  })
  it('retains the deadline and stable delivery identity across coordinator restarts and retry failures', async () => {
    const first = coordinator(); first.progress.tick(); const dueAt = saved()!.dueAt
    clock += 4 * MINUTE
    store.close(); store = new Store(join(directory, 'state.sqlite'))
    const failed = vi.fn(async (_reminder: ProgressReminder): Promise<boolean> => { throw new Error('temporary flush failure') })
    const second = coordinator(failed); second.progress.tick(); expect(saved()?.dueAt).toBe(dueAt)
    clock = dueAt; second.progress.tick(); await second.progress.drain()
    expect(saved()?.sequence).toBe(0)
    const third = coordinator(); third.progress.tick(); await third.progress.drain()
    expect(third.remind.mock.calls[0]![0].requestId).toBe(failed.mock.calls[0]![0].requestId)
  })
  it('keeps the deadline while host recovery briefly queues a replacement assignment', () => {
    const { progress } = coordinator(); progress.tick(); const original = saved()
    tickets[0]!.assignments[0]!.state = 'ended'
    tickets[0]!.assignments.push({ id: 'recovery-assignment', state: 'pending', createdAt: new Date(clock).toISOString() })
    progress.tick(); expect(saved()).toEqual(original)
    clock += 2 * MINUTE; tickets[0]!.assignments[1]!.state = 'running'
    tickets[0]!.assignments[1]!.startedAt = new Date(clock).toISOString()
    progress.tick(); expect(saved()).toEqual(original)
  })
  it('coalesces concurrent passes and holds when an earlier reminder remains unread', async () => {
    const accepted = Promise.withResolvers<boolean>(), remind = vi.fn((_request: ProgressReminder) => accepted.promise)
    const { progress } = coordinator(remind)
    progress.tick(); clock = saved()!.dueAt
    progress.tick(); progress.tick(); await Promise.resolve(); expect(remind).toHaveBeenCalledTimes(1)
    accepted.resolve(false); await progress.drain()
    expect(saved()?.sequence).toBe(0)
    progress.tick(); await progress.drain(); expect(remind).toHaveBeenCalledTimes(2)
    expect(remind.mock.calls[1]![0].requestId).toBe(remind.mock.calls[0]![0].requestId)
  })
  it('leaves a new stage report clock intact when it arrives during asynchronous delivery', async () => {
    const pending = Promise.withResolvers<boolean>()
    const { progress } = coordinator(vi.fn((_request: ProgressReminder) => pending.promise))
    progress.tick(); clock = saved()!.dueAt; progress.tick(); await Promise.resolve()
    tickets[0]!.assignments[0]!.report = { state: 'progress', summary: 'Verification started.', at: new Date(clock).toISOString() }
    progress.tick(); const newer = saved()
    pending.resolve(true); await progress.drain(); expect(saved()).toEqual(newer)
  })
  it('preserves suspended deadlines, and stops reminders for ended work or human decisions', async () => {
    const { progress, remind } = coordinator(); progress.tick(); const firstDue = saved()!.dueAt
    paused = true; clock += 20 * MINUTE; progress.tick(); await progress.drain(); expect(remind).not.toHaveBeenCalled()
    expect(saved()?.dueAt).toBe(firstDue)
    paused = false; tickets[0]!.attention = { id: 'question', question: 'Confirm deployment?' }
    progress.tick(); expect(saved()).toBeUndefined()
    delete tickets[0]!.attention
    tickets[0]!.assignments[0]!.report = { state: 'waiting', summary: 'Waiting for approval.', at: new Date(clock).toISOString(), waitingFor: { kind: 'human', subject: 'Approval' } }
    progress.tick(); expect(saved()).toBeUndefined()
    tickets[0]!.assignments[0]!.report = { state: 'progress', summary: 'Continuing.', at: new Date(clock).toISOString() }
    progress.tick(); expect(saved()).toBeDefined()
    tickets[0]!.ended = { at: new Date(clock).toISOString(), by: 'person', outcome: 'completed' } as never
    progress.tick(); expect(saved()).toBeUndefined()
  })
  it('summarizes external waits on schedule while closure leaves the persisted deadline untouched', async () => {
    tickets[0]!.assignments[0]!.report = { state: 'waiting', summary: 'Waiting for remote job.', at: new Date(clock).toISOString(), waitingFor: { kind: 'external', subject: 'Remote job' } }
    const { progress, remind } = coordinator(); progress.tick(); clock = saved()!.dueAt
    closing = true; progress.tick(); expect(remind).not.toHaveBeenCalled()
    closing = false; progress.tick(); await progress.drain(); expect(remind).toHaveBeenCalledTimes(1)
  })
  it('withdraws unread reminders after a real stage report and a human decision', async () => {
    const { progress, remind, cancel } = coordinator()
    progress.tick(); clock = saved()!.dueAt; progress.tick(); await progress.drain()
    const requestId = remind.mock.calls[0]![0].requestId
    tickets[0]!.assignments[0]!.report = { state: 'progress', summary: 'Finished inspection.', at: new Date(clock).toISOString() }
    progress.tick(); expect(cancel).toHaveBeenCalledWith('ticket-1', expect.arrayContaining([requestId]))
    const next = saved()!
    tickets[0]!.attention = { id: 'question', question: 'Choose the next action?' }
    progress.tick(); expect(cancel).toHaveBeenLastCalledWith('ticket-1', [`progress:ticket-1:${next.anchor}:${next.sequence}`])
  })
})

describe('Executor progress reminder delivery', () => {
  function executor(maxWorkers = 1) {
    const agent = { status: 'running', inbox: { nextTurn: [] as { id: string }[], nextStep: [] as { id: string }[], remove: vi.fn() } }
    const prompt = vi.fn(async (_id: string, _request: string, _text: string, _mode: string, authorize?: () => void) => { authorize?.() })
    const host = { context: { agents: { get: () => agent } }, store: { tickets: { open: () => tickets, get: (id: string) => tickets.find(value => value.id === id) }, settings: () => ({ executor: { maxWorkers } }) },
      effects: { handle: vi.fn() }, sessions: { prompt, promptedId: (id: string) => `prompt:${id}` }, paused: () => paused, closing: () => closing } as unknown as ExecutorHost
    return { executor: new DshExecutor(host), prompt, agent }
  }
  it('delivers a concise status-only steer and retains external-wait schedules', async () => {
    const { executor: worker, prompt } = executor()
    const { progress, remind } = coordinator(vi.fn(request => worker.progressReminder(request)))
    progress.tick(); clock = saved()!.dueAt; progress.tick(); await progress.drain()
    expect(remind).toHaveBeenCalledTimes(1)
    expect(prompt).toHaveBeenCalledWith('worker-ticket-1', expect.stringContaining('progress:ticket-1:'), expect.stringContaining('preserve existing next_check schedules unchanged'), 'steer', expect.any(Function))
    expect(prompt.mock.calls[0]![2]).toContain('status-only')
  })
  it('leaves one pending reminder during long tools and rechecks state before actual delivery', async () => {
    const { executor: worker, prompt, agent } = executor()
    const { progress } = coordinator(vi.fn(request => worker.progressReminder(request)))
    progress.tick(); clock = saved()!.dueAt; progress.tick(); await progress.drain()
    agent.inbox.nextStep.push({ id: `prompt:${saved()!.previousRequestId}` })
    clock = saved()!.dueAt; progress.tick(); await progress.drain(); expect(prompt).toHaveBeenCalledTimes(1)
    agent.inbox.nextStep = []
    prompt.mockImplementationOnce(async (_id, _request, _text, _mode, authorize) => { paused = true; authorize?.() })
    progress.tick(); await progress.drain()
    expect(saved()?.sequence).toBe(1)
  })
  it('holds an idle summary wake when normal worker capacity is full', async () => {
    const { executor: worker, prompt, agent } = executor(0)
    agent.status = 'idle'
    const { progress } = coordinator(vi.fn(request => worker.progressReminder(request)))
    progress.tick(); clock = saved()!.dueAt; progress.tick(); await progress.drain()
    expect(prompt).not.toHaveBeenCalled()
    expect(saved()?.sequence).toBe(0)
  })
  it('withdraws only the named reminder identities from the Worker inbox', () => {
    const { executor: worker, agent } = executor()
    worker.cancelProgressReminders('ticket-1', ['old-reminder', 'inflight-reminder'])
    expect(agent.inbox.remove.mock.calls).toEqual([['prompt:old-reminder'], ['prompt:inflight-reminder']])
  })
})
