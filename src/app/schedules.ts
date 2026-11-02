/** Persisted, local argv schedules owned by the Runtime; command output is deliberately discarded. */
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { KV } from '../kv.ts'
import type { Commands } from '../infra/commands.ts'
import type { Store } from './store.ts'
import { assertPersistentDataPath } from '../infra/persistent-path.ts'

export const ScheduleConfigSchema = z.object({
  name: z.string().trim().min(1).max(100),
  enabled: z.boolean().default(true),
  program: z.string().min(1).max(4096).refine(isAbsolute, 'Program must be an absolute path').refine(value => !value.includes('\0')),
  args: z.array(z.string().max(2048).refine(value => !value.includes('\0'))).max(32).default([]),
  cwd: z.string().min(1).max(4096).refine(isAbsolute, 'Working directory must be an absolute path').refine(value => !value.includes('\0')),
  intervalSeconds: z.number().int().min(60).max(365 * 24 * 60 * 60),
  timeoutSeconds: z.number().int().min(1).max(300).default(120),
}).strict().superRefine((config, context) => {
  if (config.args.reduce((size, argument) => size + argument.length, 0) > 16_384) {
    context.addIssue({ code: 'custom', path: ['args'], message: 'Combined arguments exceed 16384 characters' })
  }
  try { assertPersistentDataPath(config.cwd) }
  catch (error) { context.addIssue({ code: 'custom', path: ['cwd'], message: error instanceof Error ? error.message : 'Directory is outside snapshotted data areas' }) }
})

export type ScheduleConfig = z.infer<typeof ScheduleConfigSchema>
export type ScheduleRunStatus = 'running' | 'success' | 'failed' | 'cancelled' | 'timedOut'
export interface ScheduleRun {
  status: ScheduleRunStatus
  startedAt: string
  finishedAt?: string
  exitCode?: number
  /** Fixed, non-sensitive summaries only. Command stdout and stderr never enter persisted state. */
  error?: string
}
export interface ScheduleRecord {
  id: string
  revision: number
  config: ScheduleConfig
  nextRunAt: string | null
  lastRun?: ScheduleRun
}
export interface ScheduleItem extends ScheduleRecord { running: boolean }
export interface ScheduleState { revision: number; items: ScheduleRecord[] }
export interface ScheduleList { revision: number; items: ScheduleItem[] }

/** An optimistic configuration revision conflict, exposed as HTTP 409 by the management panel. */
export class ScheduleConflict extends Error { constructor() { super('Schedule changed. Reload before saving.') } }
/** The requested scheduled command no longer exists. */
export class ScheduleNotFound extends Error { constructor() { super('Schedule not found') } }
/** Creating another scheduled command would exceed the bounded per-instance task list. */
export class ScheduleLimit extends Error { constructor() { super('The schedule limit has been reached') } }

interface ActiveRun { revision: number; token: string; controller: AbortController; promise: Promise<void> }
const emptyState = (): ScheduleState => ({ revision: 0, items: [] })
const copyConfig = (config: ScheduleConfig): ScheduleConfig => ({ ...config, args: [...config.args] })
const copyRun = (run: ScheduleRun | undefined): ScheduleRun | undefined => run && { ...run }

/** One global command lane: due occurrences are coalesced, and every child goes through Commands' cancellation/Windows tree handling. */
export class Schedules {
  private readonly runs = new Map<string, ActiveRun>()
  private readonly manual = new Map<string, number>()
  private active = false
  private stopping = false
  private timer?: ReturnType<typeof setTimeout>
  private stopPromise?: Promise<void>

  constructor(private readonly store: Pick<Store, 'atomic' | 'get' | 'set'>, private readonly commands: Pick<Commands, 'withSignal'>,
    private readonly options: { paused: () => boolean; closing: () => boolean; now?: () => Date; onError?: () => void } ) {}

  /** Start after Runtime setup. A persisted overdue job is considered once and advances beyond all missed intervals. */
  start(): void {
    if (this.active || this.stopping || this.options.closing()) return
    this.active = true
    try { this.recoverInterrupted(); this.safePump() }
    catch { this.reportError(); this.arm(5000) }
  }

  list(): ScheduleList {
    const state = this.readState()
    return { revision: state.revision, items: state.items.map(item => this.view(item)) }
  }

  create(input: unknown): ScheduleItem {
    const config = ScheduleConfigSchema.parse(input)
    const now = this.now()
    let created!: ScheduleRecord
    this.store.atomic(() => {
      const state = this.readState()
      if (state.items.length >= 64) throw new ScheduleLimit()
      created = { id: randomUUID(), revision: 1, config, nextRunAt: config.enabled ? this.iso(now.getTime() + config.intervalSeconds * 1000) : null }
      state.revision++
      state.items.push(created)
      this.writeState(state)
    })
    this.safePump()
    return this.view(created)
  }

  update(id: string, expectedRevision: number, input: unknown): ScheduleItem {
    const config = ScheduleConfigSchema.parse(input)
    const now = this.now()
    let updated!: ScheduleRecord
    this.store.atomic(() => {
      const state = this.readState(), index = state.items.findIndex(item => item.id === id)
      if (index < 0) throw new ScheduleNotFound()
      const current = state.items[index]!
      if (current.revision !== expectedRevision) throw new ScheduleConflict()
      const running = this.runs.get(id)
      const lastRun = running?.revision === current.revision
        ? { status: 'cancelled' as const, startedAt: this.runningStart(current), finishedAt: this.iso(now.getTime()), error: 'Cancelled after schedule change' }
        : current.lastRun
      updated = { ...current, revision: current.revision + 1, config, nextRunAt: config.enabled ? this.iso(now.getTime() + config.intervalSeconds * 1000) : null,
        ...(lastRun ? { lastRun } : {}) }
      if (!lastRun) delete updated.lastRun
      state.revision++
      state.items[index] = updated
      this.writeState(state)
    })
    this.manual.delete(id)
    this.runs.get(id)?.controller.abort()
    this.safePump()
    return this.view(updated)
  }

  async remove(id: string, expectedRevision: number): Promise<{ removed: true }> {
    this.store.atomic(() => {
      const state = this.readState(), index = state.items.findIndex(item => item.id === id)
      if (index < 0) throw new ScheduleNotFound()
      if (state.items[index]!.revision !== expectedRevision) throw new ScheduleConflict()
      state.items.splice(index, 1)
      state.revision++
      this.writeState(state)
    })
    this.manual.delete(id)
    const run = this.runs.get(id)
    run?.controller.abort()
    if (run) await run.promise
    return { removed: true }
  }

  /** Queue one immediate occurrence; enabled=false does not prevent a person from running it once. */
  runNow(id: string): { status: 'queued' | 'running'; item: ScheduleItem } {
    const item = this.readState().items.find(candidate => candidate.id === id)
    if (!item) throw new ScheduleNotFound()
    const run = this.runs.get(id)
    if (run?.revision === item.revision) return { status: 'running', item: this.view(item) }
    if (!this.manual.has(id)) this.manual.set(id, item.revision)
    this.safePump()
    const current = this.readState().items.find(candidate => candidate.id === id)
    if (!current) throw new ScheduleNotFound()
    return { status: this.runs.get(id)?.revision === current.revision ? 'running' : 'queued', item: this.view(current) }
  }

  /** Stop scheduling, abort subprocess trees and wait for every Commands invocation to settle before Store.close(). */
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    this.stopping = true
    this.active = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.manual.clear()
    const runs = [...this.runs.values()]
    for (const run of runs) run.controller.abort()
    this.stopPromise = Promise.allSettled(runs.map(run => run.promise)).then(() => {})
    return this.stopPromise
  }

  private pump(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    if (!this.active || this.stopping || this.options.closing()) return
    if (this.options.paused()) { this.arm(1000); return }
    if (this.runs.size) { this.arm(1000); return }

    const state = this.readState()
    for (const [id, revision] of this.manual) {
      const item = state.items.find(candidate => candidate.id === id)
      this.manual.delete(id)
      if (item?.revision === revision) { this.launch(item, true); return }
    }

    const now = this.now().getTime()
    const due = state.items.filter(item => item.config.enabled && item.nextRunAt && Date.parse(item.nextRunAt) <= now)
      .sort((left, right) => Date.parse(left.nextRunAt!) - Date.parse(right.nextRunAt!))[0]
    if (due) {
      const advanced = this.advanceOccurrence(due, now)
      this.replaceRecord(advanced)
      this.launch(advanced)
      return
    }
    const nextAt = state.items.filter(item => item.config.enabled && item.nextRunAt)
      .reduce((nearest, item) => Math.min(nearest, Date.parse(item.nextRunAt!)), Infinity)
    this.arm(Number.isFinite(nextAt) ? Math.max(100, Math.min(60_000, nextAt - now)) : 60_000)
  }

  private launch(item: ScheduleRecord, manual = false): void {
    let current = this.readState().items.find(candidate => candidate.id === item.id)
    if (!current || current.revision !== item.revision || this.stopping || this.options.closing() || this.options.paused()) {
      if (!this.options.paused()) this.safePump()
      return
    }
    if (manual) {
      const advanced = this.advanceOccurrence(current, this.now().getTime())
      if (advanced !== current) { this.replaceRecord(advanced); current = advanced }
    }
    const startedAt = this.iso(this.now().getTime()), controller = new AbortController(), token = randomUUID()
    const run: ActiveRun = { revision: current.revision, token, controller, promise: Promise.resolve() }
    this.runs.set(current.id, run)
    let timedOut = false
    const timeout = setTimeout(() => { timedOut = true; controller.abort() }, current.config.timeoutSeconds * 1000)
    timeout.unref?.()
    run.promise = (async () => {
      let result: ScheduleRun | undefined
      try {
        assertPersistentDataPath(current!.config.cwd)
        this.writeLastRun(current!.id, current!.revision, { status: 'running', startedAt })
        try {
          await this.commands.withSignal(controller.signal).run(current!.config.program, [...current!.config.args], current!.config.cwd,
            current!.config.timeoutSeconds * 1000)
          result = { status: 'success', startedAt, finishedAt: this.iso(this.now().getTime()), exitCode: 0 }
        } catch (error) {
          const exitCode = error && typeof error === 'object' && 'exitCode' in error && typeof error.exitCode === 'number' ? error.exitCode : undefined
          result = timedOut
            ? { status: 'timedOut', startedAt, finishedAt: this.iso(this.now().getTime()), error: 'Timed out' }
            : controller.signal.aborted
              ? { status: 'cancelled', startedAt, finishedAt: this.iso(this.now().getTime()), error: 'Cancelled' }
              : { status: 'failed', startedAt, finishedAt: this.iso(this.now().getTime()), ...(exitCode !== undefined ? { exitCode } : {}), error: 'Execution failed' }
        }
      } catch (error) {
        result = { status: 'failed', startedAt, finishedAt: this.iso(this.now().getTime()), error: 'Execution state unavailable' }
      } finally {
        clearTimeout(timeout)
        try {
          if (result) this.writeLastRun(current!.id, current!.revision, result)
          this.skipMissed(current!.id, current!.revision)
        } catch { /* A storage fault must not strand the scheduler's command lane. */ }
        if (this.runs.get(current!.id)?.token === token) this.runs.delete(current!.id)
        this.safePump()
      }
    })()
  }

  private arm(ms: number): void {
    if (this.timer || !this.active || this.stopping) return
    this.timer = setTimeout(() => { this.timer = undefined; this.safePump() }, ms)
    this.timer.unref?.()
  }

  private safePump(): void {
    try { this.pump() }
    catch {
      this.reportError()
      this.arm(5000)
    }
  }

  private reportError(): void { try { this.options.onError?.() } catch { /* A diagnostic callback cannot strand scheduling. */ } }

  private recoverInterrupted(): void {
    this.store.atomic(() => {
      const state = this.readState(), finishedAt = this.iso(this.now().getTime())
      let changed = false
      for (const item of state.items) if (item.lastRun?.status === 'running') {
        item.lastRun = { status: 'cancelled', startedAt: item.lastRun.startedAt, finishedAt, error: 'Interrupted by Runtime restart' }
        changed = true
      }
      if (changed) this.writeState(state)
    })
  }

  private runningStart(item: ScheduleRecord): string { return this.runs.get(item.id)?.revision === item.revision ? item.lastRun?.startedAt ?? this.iso(this.now().getTime()) : this.iso(this.now().getTime()) }
  private writeLastRun(id: string, revision: number, lastRun: ScheduleRun): void {
    this.store.atomic(() => {
      const state = this.readState(), item = state.items.find(candidate => candidate.id === id && candidate.revision === revision)
      if (!item) return
      item.lastRun = lastRun
      this.writeState(state)
    })
  }
  private replaceRecord(updated: ScheduleRecord): void {
    this.store.atomic(() => {
      const state = this.readState(), index = state.items.findIndex(item => item.id === updated.id && item.revision === updated.revision)
      if (index >= 0) { state.items[index] = updated; this.writeState(state) }
    })
  }
  private skipMissed(id: string, revision: number): void {
    const now = this.now().getTime()
    this.store.atomic(() => {
      const state = this.readState(), item = state.items.find(candidate => candidate.id === id && candidate.revision === revision)
      if (!item?.config.enabled || !item.nextRunAt || Date.parse(item.nextRunAt) > now) return
      item.nextRunAt = this.advanceOccurrence(item, now).nextRunAt
      this.writeState(state)
    })
  }
  private advanceOccurrence(item: ScheduleRecord, now: number): ScheduleRecord {
    if (!item.config.enabled || !item.nextRunAt || Date.parse(item.nextRunAt) > now) return item
    const interval = item.config.intervalSeconds * 1000
    const due = Date.parse(item.nextRunAt)
    const next = due + (Math.floor((now - due) / interval) + 1) * interval
    return { ...item, nextRunAt: this.iso(next) }
  }
  private readState(): ScheduleState { return this.store.get(KV.schedules.state) ?? emptyState() }
  private writeState(state: ScheduleState): void { this.store.set(KV.schedules.state, state) }
  private view(item: ScheduleRecord): ScheduleItem {
    return { ...item, config: copyConfig(item.config), ...(copyRun(item.lastRun) ? { lastRun: copyRun(item.lastRun) } : {}),
      running: this.runs.get(item.id)?.revision === item.revision }
  }
  private now(): Date { return this.options.now?.() ?? new Date() }
  private iso(time: number): string { return new Date(time).toISOString() }
}
