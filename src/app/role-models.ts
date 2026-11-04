/** Resolve role models and apply them to managed Sessions without changing DSH's global default. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { RoleModel } from '../policy.ts'

/** Resolve a configured route through the live provider; catalog membership is not a restriction. */
export async function resolveRoleModel(ctx: Context, model: RoleModel): Promise<ModelSelection> {
  const value = await ctx.llm.resolveCallConfig({ provider: model.provider, model: model.model,
    ...(model.reasoningEffort ? { reasoningEffort: ReasoningEffortId(model.reasoningEffort) } : {}) })
  return { provider: value.provider, model: value.model, ...(value.reasoningEffort ? { reasoningEffort: value.reasoningEffort } : {}) }
}

export interface RoleModelBinding {
  select(selection: ModelSelection): void
  dispose(): void
}

/** Keep a role selection pending until the Agent finishes its current turn. */
export function bindRoleModel(ctx: Context, agent: Agent): RoleModelBinding {
  let pending: ModelSelection | undefined
  const disposers = [
    agent.ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      const result = await next()
      const selected = context.modelSelection ?? agent.model.current()
      return selected ? { ...result, variables: { ...result.variables, provider: selected.provider, model: selected.model } } : result
    }, { prepend: true }),
    ctx.on('agent/status', ({ agent: changed, status }) => {
      if (changed !== agent || status !== 'idle' || !pending) return
      const selection = pending
      pending = undefined
      agent.model.select(selection)
    }),
  ]
  return {
    select(selection) {
      if (agent.status !== 'idle') { pending = selection; return }
      pending = undefined
      agent.model.select(selection)
    },
    dispose() { for (const dispose of disposers) dispose() },
  }
}
