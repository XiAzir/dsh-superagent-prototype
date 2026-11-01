import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Commands } from '../src/infra/commands.ts'
import { KV } from '../src/kv.ts'
import { Store } from '../src/app/store.ts'
import { ScheduleConflict, ScheduleConfigSchema, Schedules, type ScheduleConfig } from '../src/app/schedules.ts'

let directory: string
let store: Store
let scheduler: Schedules
let paused: boolean
let closing: boolean
let runner: ReturnType<typeof vi.fn<(signal: AbortSignal, program: string, args: string[], cwd: string, timeoutMs: number) => Promise<string>>>
const config = (extra: Partial<ScheduleConfig> = {}): ScheduleConfig => ({ name: 'Mail check', enabled: true,
  program: process.execPath, args: ['check'], cwd: process.cwd(), intervalSeconds: 60, timeoutSeconds: 120, ...extra })

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'superagent-schedules-'))
  store = new Store(join(directory, 'orchestrator.sqlite'))
  paused = false; closing = false
  runner = vi.fn(async () => '')
  const commands = { withSignal: (signal: AbortSignal) => ({ run: (program: string, args: string[], cwd: string, timeoutMs: number) =>
    runner(signal, program, args, cwd, timeoutMs) }) } as unknown as Pick<Commands, 'withSignal'>
  scheduler = new Schedules(store, commands, { paused: () => paused, closing: () => closing })
})
afterEach(async () => { await scheduler.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); vi.useRealTimers() })

it('validates a bounded strict absolute-path argv configuration and persists item revisions', () => {
  expect(() => ScheduleConfigSchema.parse({ ...config(), unknown: 'x' })).toThrow()
  expect(() => ScheduleConfigSchema.parse({ ...config(), program: 'python.exe' })).toThrow()
  expect(() => ScheduleConfigSchema.parse({ ...config(), intervalSeconds: 59 })).toThrow()
  expect(() => ScheduleConfigSchema.parse({ ...config(), timeoutSeconds: 301 })).toThrow()
  expect(() => ScheduleConfigSchema.parse({ ...config(), args: Array.from({ length: 33 }, () => 'x') })).toThrow()
  const created = scheduler.create(config())
  expect(created).toMatchObject({ revision: 1, config: { timeoutSeconds: 120 }, running: false })
  expect(scheduler.list()).toMatchObject({ revision: 1, items: [{ id: created.id, config: created.config }] })
  const updated = scheduler.update(created.id, created.revision, config({ enabled: false, name: 'Edited' }))
  expect(updated).toMatchObject({ revision: 2, config: { enabled: false, name: 'Edited' }, nextRunAt: null })
  expect(() => scheduler.update(created.id, created.revision, config())).toThrow(ScheduleConflict)
})

it('runs one overdue occurrence after restart and advances past missed intervals without catch-up', async () => {
  vi.useFakeTimers()
  const start = new Date('2026-11-01T10:00:00.000Z')
  vi.setSystemTime(start)
  const item = scheduler.create(config())
  store.atomic(() => {
    const state = store.get(KV.schedules.state)!
    state.items[0]!.nextRunAt = new Date(start.getTime() - 60 * 60_000).toISOString()
    store.set(KV.schedules.state, state)
  })
  await scheduler.stop()
  store.close()
  store = new Store(join(directory, 'orchestrator.sqlite'))
  const commands = { withSignal: (signal: AbortSignal) => ({ run: (program: string, args: string[], cwd: string, timeoutMs: number) =>
    runner(signal, program, args, cwd, timeoutMs) }) } as unknown as Pick<Commands, 'withSignal'>
  scheduler = new Schedules(store, commands, { paused: () => paused, closing: () => closing })
  scheduler.start()
  await vi.advanceTimersByTimeAsync(0)
  expect(runner).toHaveBeenCalledTimes(1)
  expect(scheduler.list().items[0]?.lastRun?.status).toBe('success')
  expect(scheduler.list().items[0]?.nextRunAt).toBe(new Date(start.getTime() + 60_000).toISOString())
  await vi.advanceTimersByTimeAsync(59_999)
  expect(runner).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(runner).toHaveBeenCalledTimes(2)
  expect(scheduler.list().items[0]?.id).toBe(item.id)
})

it('keeps a single command lane, times out with a generic summary, and continues periodic runs after failures', async () => {
  vi.useFakeTimers()
  const start = new Date('2026-11-01T10:00:00.000Z')
  vi.setSystemTime(start)
  runner.mockImplementationOnce(signal => new Promise((_resolve, reject) => signal.addEventListener('abort',
    () => reject(Object.assign(new Error('private stderr'), { exitCode: 124 })), { once: true })))
    .mockRejectedValueOnce(Object.assign(new Error('private stderr'), { exitCode: 7 })).mockResolvedValue('secret output')
  const item = scheduler.create(config({ timeoutSeconds: 2 }))
  scheduler.start()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(runner).toHaveBeenCalledTimes(1)
  expect(scheduler.runNow(item.id).status).toBe('running')
  await vi.advanceTimersByTimeAsync(2_000)
  expect(scheduler.list().items[0]?.lastRun?.status).toBe('timedOut')
  expect(JSON.stringify(scheduler.list())).not.toContain('private stderr')
  expect(JSON.stringify(scheduler.list())).not.toContain('secret output')
  await vi.advanceTimersByTimeAsync(58_000)
  expect(runner).toHaveBeenCalledTimes(2)
  expect(scheduler.list().items[0]?.lastRun?.status).toBe('failed')
  expect(scheduler.list().items[0]?.lastRun).toMatchObject({ exitCode: 7, error: 'Execution failed' })
  await vi.advanceTimersByTimeAsync(60_000)
  expect(runner).toHaveBeenCalledTimes(3)
  expect(scheduler.list().items[0]?.lastRun?.status).toBe('success')
})

it('serializes simultaneously due jobs across the shared command lane', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-01T10:00:00.000Z'))
  let finish!: (output: string) => void
  runner.mockImplementationOnce(() => new Promise(resolve => { finish = resolve })).mockResolvedValue('')
  scheduler.create(config({ name: 'First' }))
  scheduler.create(config({ name: 'Second' }))
  scheduler.start()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(runner).toHaveBeenCalledTimes(1)
  finish('')
  await Promise.resolve(); await Promise.resolve()
  expect(runner).toHaveBeenCalledTimes(2)
})

it('cancels an edited execution without letting its old result overwrite the new revision', async () => {
  let finish!: (output: string) => void
  runner.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const item = scheduler.create(config({ enabled: false }))
  scheduler.start()
  expect(scheduler.runNow(item.id).status).toBe('running')
  const updated = scheduler.update(item.id, item.revision, config({ enabled: false, name: 'New config' }))
  expect(updated).toMatchObject({ revision: 2, lastRun: { status: 'cancelled', error: 'Cancelled after schedule change' } })
  finish('old secret output')
  await Promise.resolve(); await Promise.resolve()
  expect(scheduler.list().items[0]?.running).toBe(false)
  expect(scheduler.list().items[0]).toMatchObject({ revision: 2, config: { name: 'New config' },
    lastRun: { status: 'cancelled', error: 'Cancelled after schedule change' } })
  expect(JSON.stringify(scheduler.list())).not.toContain('old secret output')
})

it('removes a job before cancelling its run and stop drains subprocesses', async () => {
  let finish!: (output: string) => void
  runner.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const item = scheduler.create(config({ enabled: false }))
  scheduler.start(); scheduler.runNow(item.id)
  const removal = scheduler.remove(item.id, item.revision)
  expect(scheduler.list().items).toEqual([])
  finish('late output')
  await expect(removal).resolves.toEqual({ removed: true })
  expect(scheduler.list().items).toEqual([])

  const next = scheduler.create(config({ enabled: false }))
  runner.mockImplementationOnce(signal => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })))
  scheduler.runNow(next.id)
  await scheduler.stop()
  expect(scheduler.list().items[0]?.lastRun?.status).toBe('cancelled')
})

it('does not start new commands while paused and queues explicit runs until unpaused', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-01T10:00:00.000Z'))
  paused = true
  const item = scheduler.create(config({ enabled: false }))
  scheduler.start()
  expect(scheduler.runNow(item.id).status).toBe('queued')
  expect(runner).not.toHaveBeenCalled()
  paused = false
  await vi.advanceTimersByTimeAsync(1000)
  expect(runner).toHaveBeenCalledOnce()
})
