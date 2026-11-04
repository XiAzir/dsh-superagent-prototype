/** Concurrency, retry, and validation tests for settings saves, pause toggling, and policy synchronization. */
import { afterEach, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { UserError } from '../src/core/index.ts'
import { Commands } from '../src/infra/commands.ts'
import { Setup } from '../src/app/setup.ts'
import { SettingsConflict } from '../src/app/settings.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host | undefined
afterEach(async () => { await h?.stop(); h = undefined })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(settle => { resolve = settle })
  return { promise, resolve }
}
const model = { provider: 'worker-provider', model: 'worker-model' }

it('applies a saved Router model to its existing Session and restores the default when cleared', async () => {
  h = await startRuntime()
  const { settings, store, masterId } = h.runtime
  const agent = h.ctx.agents.get(masterId as Agent['id'])!
  const append = vi.mocked(agent.session.append)
  const initialEvents = append.mock.calls.length
  const evalConfig = store.settings().eval
  const selected = { provider: 'router-provider', model: 'router-model', reasoningEffort: 'high' }
  await settings.save('eval', { ...evalConfig, model: selected }, store.blockRevision('eval'), 'panel')
  expect(store.settings().eval.model).toEqual(selected)
  expect(agent.model.current()).toEqual(selected)
  expect(append.mock.calls.slice(initialEvents)).toContainEqual(['model/selection', selected])

  await settings.save('eval', { ...store.settings().eval, model: null }, store.blockRevision('eval'), 'panel')
  expect(agent.model.current()).toEqual({ provider: 'host', model: 'default' })
  expect(append.mock.calls.at(-1)).toEqual(['model/selection', { provider: 'host', model: 'default' }])
  await h.runtime.sessions.ensure(masterId, h.directory, 'dsh-superagent orchestrator', 'orchestrator')
  expect(append.mock.calls.at(-1)).toEqual(['model/selection', { provider: 'host', model: 'default' }])
  expect(h.controller.modelCatalog).toHaveBeenCalled()
  expect(h.controller.selectModel).not.toHaveBeenCalled()
})

it('does not let a slow Session restore overwrite a newer saved Router model', async () => {
  h = await startRuntime()
  const { settings, store, masterId, sessions } = h.runtime
  const agent = h.ctx.agents.get(masterId as Agent['id'])!
  const append = vi.mocked(agent.session.append)
  const old = { provider: 'old-provider', model: 'old-model' }
  const next = { provider: 'new-provider', model: 'new-model' }
  await settings.save('eval', { ...store.settings().eval, model: old }, store.blockRevision('eval'), 'panel')
  const llm = (h.ctx as unknown as { llm: { resolveCallConfig: ReturnType<typeof vi.fn> } }).llm
  const delayed = deferred<unknown>()
  llm.resolveCallConfig.mockImplementationOnce(() => delayed.promise)
  const restoring = sessions.ensure(masterId, h.directory, 'dsh-superagent orchestrator', 'orchestrator')
  await vi.waitFor(() => expect(llm.resolveCallConfig).toHaveBeenCalledTimes(2))
  await settings.save('eval', { ...store.settings().eval, model: next }, store.blockRevision('eval'), 'panel')
  delayed.resolve(old)
  await restoring
  expect(store.settings().eval.model).toEqual(next)
  expect(agent.model.current()).toEqual(next)
  expect(append.mock.calls.at(-1)).toEqual(['model/selection', next])
})

it('updates an existing open Worker Session when its execution model changes', async () => {
  h = await startRuntime()
  const { sessionId } = await h.acceptedTicket(feishu('210', 'Fix the document'))
  const agent = h.ctx.agents.get(sessionId as Agent['id'])!
  const append = vi.mocked(agent.session.append)
  const before = append.mock.calls.length
  const { settings, store } = h.runtime
  expect(agent.status).toBe('running')
  await settings.save('executor', { ...store.settings().executor, model }, store.blockRevision('executor'), 'panel')
  expect(agent.model.current()).toEqual({ provider: 'host', model: 'default' })
  expect(append.mock.calls.slice(before)).not.toContainEqual(['model/selection', model])
  ;(agent as unknown as { status: 'idle' | 'running' }).status = 'idle'
  h.ctx.emit('agent/status', { agent, status: 'idle' } as never)
  expect(agent.model.current()).toEqual(model)
  expect(append.mock.calls.slice(before)).toContainEqual(['model/selection', model])
  expect(h.controller.selectModel).not.toHaveBeenCalled()
})

it('refuses a save of a block that another save changed during its model or account check, and saves nothing of it', async () => {
  h = await startRuntime()
  const { settings, store } = h.runtime
  const llm = (h.ctx as unknown as { llm: { resolveCallConfig: ReturnType<typeof vi.fn> } }).llm
  const check = deferred<unknown>()
  llm.resolveCallConfig.mockImplementationOnce(() => check.promise)
  const executor = store.settings().executor
  const revision = store.blockRevision('executor')
  const slow = settings.save('executor', { ...executor, model, maxWorkers: 5 }, revision, 'panel')
  await settings.save('executor', { ...executor, maxWorkers: 2 }, revision, 'panel')
  check.resolve(model)
  await expect(slow).rejects.toThrow(SettingsConflict)
  expect(store.settings().executor).toMatchObject({ maxWorkers: 2, model: executor.model })
  // An account check that a save of the same Source outruns is refused the same way.
  const accounts = deferred<void>()
  vi.spyOn(Setup.prototype, 'checkAccounts').mockImplementationOnce(() => accounts.promise)
  const github = settings.block('source:github')
  const value = github.value as { enabled: boolean; config: Record<string, unknown> }
  const moved = settings.save('source:github', { ...value, config: { ...value.config, cli: '/opt/bin/gh-other' } }, github.revision,
    'panel')
  await settings.save('source:github', { ...value, config: { ...value.config, pollSeconds: 90 } }, github.revision, 'panel')
  accounts.resolve()
  await expect(moved).rejects.toThrow(SettingsConflict)
  expect(store.settings().sources.github!.config).toMatchObject({ cli: value.config.cli, pollSeconds: 90 })
})

it('refuses a Policy sync that a Policy save outran, reports it on sync:feishu, and keeps the save', async () => {
  h = await startRuntime()
  const { settings, store } = h.runtime
  const members = deferred<unknown>()
  vi.mocked(Commands.prototype.lark).mockImplementationOnce(() => members.promise as never)
  const syncing = settings.sync('feishu')
  const policy = store.settings().policy
  const rules = [{ id: 'docs', name: 'Docs', enabled: true, instruction: 'Fix docs' }]
  await settings.save('policy', { ...policy, rules }, store.blockRevision('policy'), 'panel')
  members.resolve({ users: [{ member_id: 'ou_alice', name: 'Alice' }, { member_id: 'ou_new', name: 'New' }], has_more: false })
  await expect(syncing).rejects.toThrow(SettingsConflict)
  expect(h.runtime.health['sync:feishu']).toMatchObject({ state: 'error',
    detail: expect.stringContaining('Policy changed during synchronization') })
  expect(store.settings().policy).toMatchObject({ rules, sources: { feishu: { allowed: [{ id: 'ou_alice', name: 'Alice' }] } } })
})

it('syncs a Policy part again after a failed sync, a minute later and then after a wait that doubles, until it succeeds', async () => {
  h = await startRuntime()
  const { settings } = h.runtime
  // The syncs the Runtime runs as it starts finish first.
  await vi.waitFor(() => expect(h!.runtime.health['sync:feishu']).toMatchObject({ state: 'ready' }))
  await h.runtime.idle()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const lark = vi.mocked(Commands.prototype.lark)
    lark.mockRejectedValueOnce(new Error('network down')).mockRejectedValueOnce(new Error('network down'))
    await expect(settings.sync('feishu')).rejects.toThrow('network down')
    expect(h.runtime.health['sync:feishu']).toMatchObject({ state: 'error', detail: expect.stringContaining('network down') })
    const calls = () => lark.mock.calls.filter(([args]) => args.includes('+chat-members-list')).length
    const before = calls()
    await vi.advanceTimersByTimeAsync(60_000)
    // The first retry fails too, so the next waits two minutes.
    expect(calls()).toBe(before + 1)
    lark.mockResolvedValueOnce({ users: [{ member_id: 'ou_alice', name: 'Alice' }], has_more: false })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls()).toBe(before + 1)
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.waitFor(() => expect(h!.runtime.health['sync:feishu']).toMatchObject({ state: 'ready' }))
    expect(calls()).toBe(before + 2)
    // A success ends the retries.
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(calls()).toBe(before + 2)
  } finally { vi.useRealTimers() }
})
it('records nothing for a pause that changes nothing, refuses a sync while setup waits, and names an unknown block', async () => {
  h = await startRuntime()
  const { settings, store } = h.runtime
  const revision = store.blockRevision('pause')
  const inject = h.agents.get(h.runtime.masterId)!.inject
  inject.mockClear()
  expect(await settings.pause(false, 'panel')).toEqual({ paused: false })
  await h.runtime.idle()
  expect([store.blockRevision('pause'), inject.mock.calls.length, h.runtime.effects.pending('notice')]).toEqual([revision, 0, false])
  vi.spyOn(Setup.prototype, 'configured').mockReturnValue(false)
  await expect(settings.sync('feishu')).rejects.toThrow(new UserError('nothingToSync', { source: 'feishu' }))
  vi.mocked(Setup.prototype.configured).mockRestore()
  expect(() => settings.block('source:x')).toThrow(new UserError('unknownBlock', { block: 'source:x' }))
})
