import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { agentEvents, installModelSelection, type Agent, type ModelSelection, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { bindRoleModel, resolveRoleModel } from '../src/app/role-models.ts'

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())); vi.restoreAllMocks() })

async function fixture() {
  const ctx = new Context(); contexts.push(ctx); await ctx.plugin(SystemPrompt)
  const resolve = vi.fn(async value => value)
  ctx.reflect.provide('llm', { resolveCallConfig: resolve })
  const session = Session.create(SessionId('role-model'))
  let status: 'idle' | 'running' = 'idle'
  const agent = { ctx, session, get status() { return status } } as Agent
  const host: ModelSelectionRef = { get current() { return session.requestHeader()?.config ?? { provider: 'host', model: 'default', reasoningEffort: ReasoningEffortId('high') } }, assembled: undefined }
  installModelSelection(ctx, host)
  const request = () => agentEvents(ctx, agent).waterfall('agent/request', { turn: 1, step: 1, signal: new AbortController().signal }, async () => ({ provider: 'seed', model: 'seed' }))
  const record = (selection: ModelSelection) => session.append('request/header', { header: { config: selection }, reason: 'initial' })
  return { ctx, agent, session, host, resolve, request, record,
    setStatus: (next: 'idle' | 'running') => { status = next; ctx.emit('agent/status', { agent, status: next } as never) } }
}

it('uses a role model on a new Session without changing the host default', async () => {
  const { ctx, agent, session, host, request, record } = await fixture()
  const binding = bindRoleModel(ctx, agent)
  binding.select(await resolveRoleModel(ctx, { provider: 'worker-provider', model: 'worker-model' }))
  expect((await ctx.systemPrompt.assemble()).variables).toMatchObject({ provider: 'worker-provider', model: 'worker-model' })
  const selected = await request()
  expect(selected).toEqual({ provider: 'worker-provider', model: 'worker-model' })
  expect(session.snapshotEvents().some(event => event.type === 'model/selection')).toBe(true)
  expect(host.current).toMatchObject({ provider: 'host', model: 'default' })
  record(selected)
  await ctx.systemPrompt.assemble()
  expect(await request()).toEqual(selected)
  binding.dispose()
})

it('applies a saved Router model to the next turn while the current turn finishes on its prior model', async () => {
  const { ctx, agent, session, request, setStatus } = await fixture()
  const binding = bindRoleModel(ctx, agent)
  binding.select({ provider: 'old', model: 'old-model' })
  setStatus('running')
  await ctx.systemPrompt.assemble()
  binding.select({ provider: 'new', model: 'new-model', reasoningEffort: ReasoningEffortId('max') })
  expect(await request()).toMatchObject({ provider: 'old', model: 'old-model' })
  await ctx.systemPrompt.assemble()
  expect(await request()).toMatchObject({ provider: 'old', model: 'old-model' })
  ctx.emit('session/event', session, { type: 'turn/end' } as never)
  await ctx.systemPrompt.assemble()
  expect(await request()).toEqual({ provider: 'new', model: 'new-model', reasoningEffort: ReasoningEffortId('max') })
  binding.dispose()
})

it('reconciles a resumed Session with the saved role model and avoids duplicate selections', async () => {
  const { ctx, agent, session, request, record, setStatus } = await fixture()
  record({ provider: 'old', model: 'old-model' })
  const binding = bindRoleModel(ctx, agent)
  binding.select({ provider: 'new', model: 'new-model' })
  expect(session.snapshotEvents().filter(event => event.type === 'model/selection')).toHaveLength(1)
  binding.select({ provider: 'new', model: 'new-model' })
  expect(session.snapshotEvents().filter(event => event.type === 'model/selection')).toHaveLength(1)
  await ctx.systemPrompt.assemble()
  expect(await request()).toMatchObject({ provider: 'new', model: 'new-model' })
  setStatus('running')
  binding.select({ provider: 'later', model: 'later-model' })
  setStatus('idle')
  await ctx.systemPrompt.assemble()
  expect(await request()).toMatchObject({ provider: 'later', model: 'later-model' })
  binding.dispose()
})

it('keeps model-switch notices aligned with the managed route', async () => {
  const { ctx, agent, host, record } = await fixture()
  record({ provider: 'old', model: 'first' })
  const binding = bindRoleModel(ctx, agent)
  binding.select({ provider: 'managed', model: 'second' })
  Object.defineProperty(host, 'current', { value: { provider: 'manual', model: 'third' }, configurable: true })
  await ctx.systemPrompt.assemble()
  const input = { source: { kind: 'test' } } as never
  const result = await agentEvents(ctx, agent).waterfall('agent/pre-step',
    { messages: [], turn: 1, step: 1, signal: new AbortController().signal },
    async () => ({ kind: 'enter' as const, messages: [input] }))
  expect(result.kind).toBe('enter')
  if (result.kind === 'enter') {
    const notices = result.messages.filter(message => message.source.kind === 'model-selection')
    expect(notices).toHaveLength(1)
    expect(notices[0]!.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('managed/second') })
  }
  binding.dispose()
})

it('inherits the host when unset and rejects unavailable models before recording a selection', async () => {
  const { ctx, agent, session, resolve, request } = await fixture()
  const binding = bindRoleModel(ctx, agent)
  await ctx.systemPrompt.assemble()
  expect(await request()).toMatchObject({ provider: 'host', model: 'default' })
  resolve.mockRejectedValueOnce(new Error('unknown provider'))
  await expect(resolveRoleModel(ctx, { provider: 'unknown', model: 'x' })).rejects.toThrow('unknown provider')
  expect(session.snapshotEvents().some(event => event.type === 'model/selection')).toBe(false)
  binding.dispose()
})
