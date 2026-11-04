import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { agentEvents, installModelSelection, type Agent, type ModelSelection } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { bindRoleModel, resolveRoleModel } from '../src/app/role-models.ts'
import { fixtureModel } from './fixtures/session.ts'

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())); vi.restoreAllMocks() })

async function fixture() {
  const ctx = new Context(); contexts.push(ctx); await ctx.plugin(SystemPrompt)
  const resolve = vi.fn(async value => value)
  ctx.reflect.provide('llm', { resolveCallConfig: resolve })
  const session = Session.create(SessionId('role-model'))
  let status: 'idle' | 'running' = 'idle'
  const options = { provider: 'host', model: 'default', reasoningEffort: ReasoningEffortId('high') }
  const model = fixtureModel(session)
  const agent = { ctx, session, model, options, get status() { return status } } as unknown as Agent
  // The Session Controller installs DSH's switch notice during Agent setup.
  installModelSelection(ctx)
  const record = (selection: ModelSelection) => session.append('request/header', { header: { config: selection }, reason: 'initial' })
  return { ctx, agent, session, resolve, record,
    setStatus: (next: 'idle' | 'running') => { status = next; ctx.emit('agent/status', { agent, status: next } as never) } }
}

it('uses a role model on a new Session without changing the host default', async () => {
  const { ctx, agent, session, record } = await fixture()
  const binding = bindRoleModel(ctx, agent)
  binding.select(await resolveRoleModel(ctx, { provider: 'worker-provider', model: 'worker-model' }))
  expect(agent.model.current()).toEqual({ provider: 'worker-provider', model: 'worker-model' })
  expect((await ctx.systemPrompt.assemble()).variables).toMatchObject({ provider: 'worker-provider', model: 'worker-model' })
  expect(agent.options).toMatchObject({ provider: 'host', model: 'default' })
  expect(session.snapshotEvents().some(event => event.type === 'model/selection')).toBe(true)
  record({ provider: 'worker-provider', model: 'worker-model' })
  await ctx.systemPrompt.assemble()
  expect(agent.model.current()).toEqual({ provider: 'worker-provider', model: 'worker-model' })
  binding.dispose()
})

it('keeps prompt model variables aligned with the model captured for the step', async () => {
  const { ctx, agent } = await fixture()
  const binding = bindRoleModel(ctx, agent)
  binding.select({ provider: 'live-provider', model: 'live-model' })
  const assembly = await ctx.systemPrompt.assemble({ modelSelection: { provider: 'step-provider', model: 'step-model' } })
  expect(agent.model.current()).toEqual({ provider: 'live-provider', model: 'live-model' })
  expect(assembly.variables).toMatchObject({ provider: 'step-provider', model: 'step-model' })
  binding.dispose()
})

it('applies a saved Router model to the next turn while the current turn finishes on its prior model', async () => {
  const { ctx, agent, session, setStatus } = await fixture()
  const binding = bindRoleModel(ctx, agent)
  binding.select({ provider: 'old', model: 'old-model' })
  setStatus('running')
  binding.select({ provider: 'new', model: 'new-model', reasoningEffort: ReasoningEffortId('max') })
  expect(agent.model.current()).toEqual({ provider: 'old', model: 'old-model' })
  expect(session.snapshotEvents().filter(event => event.type === 'model/selection')).toHaveLength(1)
  setStatus('idle')
  expect(agent.model.current()).toEqual({ provider: 'new', model: 'new-model', reasoningEffort: ReasoningEffortId('max') })
  expect(session.snapshotEvents().filter(event => event.type === 'model/selection')).toHaveLength(2)
  binding.dispose()
})

it('reconciles a resumed Session with the saved role model and avoids duplicate selections', async () => {
  const { ctx, agent, session, record, setStatus } = await fixture()
  record({ provider: 'old', model: 'old-model' })
  const binding = bindRoleModel(ctx, agent)
  binding.select({ provider: 'new', model: 'new-model' })
  expect(session.snapshotEvents().filter(event => event.type === 'model/selection')).toHaveLength(1)
  binding.select({ provider: 'new', model: 'new-model' })
  expect(session.snapshotEvents().filter(event => event.type === 'model/selection')).toHaveLength(1)
  expect(agent.model.current()).toEqual({ provider: 'new', model: 'new-model' })
  setStatus('running')
  binding.select({ provider: 'later', model: 'later-model' })
  setStatus('idle')
  expect(agent.model.current()).toEqual({ provider: 'later', model: 'later-model' })
  binding.dispose()
})

it('keeps model-switch notices aligned with the managed route', async () => {
  const { ctx, agent, record } = await fixture()
  record({ provider: 'old', model: 'first' })
  const binding = bindRoleModel(ctx, agent)
  binding.select({ provider: 'managed', model: 'second' })
  const input = { source: { kind: 'test' } } as never
  const result = await agentEvents(ctx, agent).waterfall('agent/pre-step',
    { messages: [], turn: 1, step: 1, signal: new AbortController().signal, modelSelection: agent.model.current()! },
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
  const { ctx, agent, session, resolve } = await fixture()
  const binding = bindRoleModel(ctx, agent)
  await ctx.systemPrompt.assemble()
  expect(agent.model.current()).toMatchObject({ provider: 'host', model: 'default' })
  resolve.mockRejectedValueOnce(new Error('unknown provider'))
  await expect(resolveRoleModel(ctx, { provider: 'unknown', model: 'x' })).rejects.toThrow('unknown provider')
  expect(session.snapshotEvents().some(event => event.type === 'model/selection')).toBe(false)
  binding.dispose()
})
