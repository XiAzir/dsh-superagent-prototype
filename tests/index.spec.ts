import { expect, it, onTestFinished, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Config, type Machine } from '../src/deployment.ts'
import { apply } from '../src/index.ts'
import { protectStateDirectory } from '../src/infra/private-directory.ts'

vi.mock('../src/infra/private-directory.ts', () => ({ protectStateDirectory: vi.fn() }))

// Stub Runtime to capture the resolved Machine settings and restart callback.
const runtimes = vi.hoisted(() => [] as { machine: Machine; restart: () => void }[])
vi.mock('../src/app/runtime.ts', () => ({ Runtime: class {
  ready = Promise.resolve()
  sources = { register: vi.fn(() => vi.fn()) }
  constructor(_ctx: unknown, readonly machine: Machine, readonly restart: () => void) { runtimes.push(this) }
  configured() { return true }
  async stop() {}
} }))
vi.mock('../src/app/qq-source.ts', () => ({ QqBridge: class {
  kind = { kind: 'qq' }
  constructor(_host: unknown) {}
  async start() {}
  async stop() {}
}, QqSourceError: class extends Error {} }))
/** Simulate the Cordis loader updating a volatile configuration reference in place. */
const commit = (reference: unknown, value: unknown) => { (reference as Record<symbol, (value: unknown) => void>)[Symbol.for('cosmokit.volatile.write')]!(value) }

function context() {
  const handlers = new Map<string, (paths: readonly (readonly string[])[]) => void>()
  const disposers: (() => void)[] = []
  const configure = vi.fn(() => () => {})
  const describe = vi.fn(() => [])
  const ctx = {
    on: vi.fn((name: string, handler: (paths: readonly (readonly string[])[]) => void) => { handlers.set(name, handler) }),
    inject: vi.fn((_services: string[], callback: (child: unknown) => void) => { callback({ effect: (effect: () => unknown) => effect(), settings: { configure } }) }),
    effect: vi.fn((effect: () => (() => void) | undefined) => { const dispose = effect(); if (dispose) disposers.push(dispose) }),
    fiber: { restart: vi.fn(async () => {}) },
    get: vi.fn((name: string) => name === 'settings' ? { describe } : undefined),
    logger: { info: vi.fn(), error: vi.fn() },
  }
  return { ctx, handlers, configure, describe, disposers }
}

it('reads a limit DSH commits a new value of without a restart, and asks DSH to generate no settings page', async () => {
  const { ctx, handlers, configure } = context()
  const config = Config({ stateDir: '/srv/state', promptMaxChars: 5000 })
  await apply(ctx as never, config)
  expect(protectStateDirectory).toHaveBeenCalledWith('/srv/state')
  expect(configure).toHaveBeenCalledExactlyOnceWith({ auto: false }, ctx.fiber)
  const { machine } = runtimes.at(-1)!
  expect(machine.promptMaxChars.get()).toBe(5000)
  commit(config.promptMaxChars, 8000)
  expect(machine.promptMaxChars.get()).toBe(8000)
  handlers.get('loader/volatile-update')!([['promptMaxChars']])
  expect(ctx.fiber.restart).not.toHaveBeenCalled()
})

it('defers a saved mode change until the next turn, then restarts once with its committed value', async () => {
  vi.useFakeTimers()
  onTestFinished(() => { vi.useRealTimers() })
  const { ctx, handlers, describe } = context()
  const config = Config({ stateDir: '/srv/state', mode: 'personal' })
  await apply(ctx as never, config)
  const { machine } = runtimes.at(-1)!
  commit(config.mode, 'repository')
  const updated = handlers.get('loader/volatile-update')!
  updated([['mode'], ['promptMaxChars']])
  updated([['mode']])
  expect(machine.mode).toBe('personal')
  expect(ctx.fiber.restart).not.toHaveBeenCalled()
  await vi.runAllTimersAsync()
  expect(ctx.fiber.restart).toHaveBeenCalledTimes(1)
  expect(describe).toHaveBeenCalledTimes(1)
})

it('cancels a mode restart when the saved mode returns to its running value or the plugin is disposed', async () => {
  vi.useFakeTimers()
  onTestFinished(() => { vi.useRealTimers() })
  const { ctx, handlers, disposers } = context()
  const config = Config({ stateDir: '/srv/state', mode: 'personal' })
  await apply(ctx as never, config)
  const updated = handlers.get('loader/volatile-update')!
  commit(config.mode, 'repository'); updated([['mode']])
  commit(config.mode, 'personal'); updated([['mode']])
  await vi.runAllTimersAsync()
  expect(ctx.fiber.restart).not.toHaveBeenCalled()
  commit(config.mode, 'repository'); updated([['mode']])
  disposers.forEach(dispose => dispose())
  await vi.runAllTimersAsync()
  expect(ctx.fiber.restart).not.toHaveBeenCalled()
})

it('asks DSH to read its settings entry again once a restart it started finished', async () => {
  const { ctx, describe } = context()
  let finish = () => {}
  ctx.fiber.restart.mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))
  await apply(ctx as never, Config({ stateDir: '/srv/state' }))
  // Saving a Source account change restarts dsh-superagent, which re-runs setup and refreshes the settings descriptor.
  runtimes.at(-1)!.restart()
  await Promise.resolve()
  expect(describe).not.toHaveBeenCalled()
  finish()
  await vi.waitFor(() => { expect(describe).toHaveBeenCalledTimes(1) })
})

it('refuses keys of the previous configuration before registering anything', async () => {
  const { ctx } = context()
  await expect(apply(ctx as never, Config({ stateDir: '/srv/state', github: { cli: 'gh' } } as never))).rejects.toThrow('github (now on the GitHub Source)')
  expect(ctx.on).not.toHaveBeenCalled()
  expect(ctx.inject).not.toHaveBeenCalled()
})

it('guards the plugin state directory against non-snapshotted CNB paths', async () => {
  const base = mkdtempSync(join(tmpdir(), 'superagent-plugin-state-'))
  const data = join(base, 'data')
  mkdirSync(join(data, 'state'), { recursive: true })
  vi.stubEnv('DSH_SUPERAGENT_DATA_ROOT', data)
  try {
    const { ctx } = context()
    await expect(apply(ctx as never, Config({ stateDir: join(data, 'elsewhere') }))).rejects.toThrow('snapshotted data area')
    expect(protectStateDirectory).not.toHaveBeenCalledWith(join(data, 'elsewhere'))
    await apply(ctx as never, Config({ stateDir: join(data, 'state') }))
    expect(protectStateDirectory).toHaveBeenCalledWith(join(data, 'state'))
  } finally {
    vi.unstubAllEnvs()
    rmSync(base, { recursive: true, force: true })
  }
})
