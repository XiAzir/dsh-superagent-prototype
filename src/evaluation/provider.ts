/** An optional configured provider CLI; no production session, source or credential store is read. */
import { z } from 'zod'
import { createHash } from 'node:crypto'
import type { Trigger } from '../core/index.ts'
import type { FixtureDefinition } from './fixtures.ts'
import { runCommand } from '../../scripts/dsh-superagent-watchdog.mjs'
import { safeFailureMessage } from '../app/session-failures.ts'

export interface EvaluationUsage { tokens?: number; cost?: number }
export interface EvaluationRoute { kind: 'accept' | 'attach' | 'ignore' | 'status' | 'stop'; ticketId?: string; title?: string }
export interface EvaluationRouterPrompt { profile: 'repository' | 'personal'; text: string; sha256: string }
export interface EvaluationRouteInput {
  trigger: Trigger
  tickets: { id: string; title: string; ended: boolean; sourceText: string; source?: string; threads?: Trigger['threads'] }[]
  routerPrompt?: EvaluationRouterPrompt
}
export interface EvaluationCallTrace {
  at: string; task: 'route' | 'execute_fixture'; transport: 'cli' | 'in-process'; input: unknown; inputSha256: string
  output?: string; outputSha256?: string; normalized?: unknown; normalizations: string[]
  state: 'running' | 'valid' | 'normalized' | 'invalid' | 'failed'; durationMs?: number; usage?: EvaluationUsage; error?: string
  provider?: { input: unknown; output: string; model?: string; finishReason?: string; usage?: unknown }
}
export interface EvaluationProvider {
  name: string
  model?: string
  route(input: EvaluationRouteInput): Promise<{ decision: EvaluationRoute; usage?: EvaluationUsage }>
  executeTask?(input: FixtureDefinition & { existingFiles: { name: string; content: string }[] }): Promise<{ files: { name: string; content: string }[]; usage?: EvaluationUsage }>
  /** Exact bounded protocol calls, including malformed responses; credentials stay in the external adapter. */
  traces?(): readonly EvaluationCallTrace[]
}
const usageSchema = z.object({ tokens: z.number().int().nonnegative().optional(), cost: z.number().nonnegative().optional() }).strict()
const routeSchema = z.object({ decision: z.object({ kind: z.enum(['accept', 'attach', 'ignore', 'status', 'stop']),
  ticketId: z.string().min(1).max(200).optional(), title: z.string().min(1).max(200).optional() }).strict(), usage: usageSchema.optional() }).strict()
const filesSchema = z.object({ files: z.array(z.object({ name: z.string().regex(/^[a-zA-Z0-9._-]{1,100}$/), content: z.string().max(100000) }).strict()).max(8),
  usage: usageSchema.optional() }).strict()
const providerTraceSchema = z.object({ input: z.unknown(), output: z.string().max(500_000), model: z.string().max(200).optional(),
  finishReason: z.string().max(200).optional(), usage: z.unknown().optional() }).strict()
const sha = (text: string) => createHash('sha256').update(text).digest('hex')

/** Retains the original protocol response and its valid usage when schema validation rejects the decision. */
export class EvaluationProviderError extends Error {
  constructor(message: string, readonly trace: EvaluationCallTrace) { super(message) }
}

/** Optional nulls are omitted only where the decision does not require their semantic value. */
export function parseEvaluationRoute(value: unknown): { response: z.infer<typeof routeSchema>; normalizations: string[] } {
  const normalizations: string[] = []
  const candidate = value && typeof value === 'object' && !Array.isArray(value) ? { ...value as Record<string, unknown> } : value
  if (candidate && typeof candidate === 'object' && 'decision' in candidate) {
    const raw = candidate.decision
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const decision = { ...raw as Record<string, unknown> }
      if (decision.ticketId === null && ['accept', 'ignore'].includes(String(decision.kind))) {
        delete decision.ticketId; normalizations.push('Omitted an unused null ticketId for accept/ignore.')
      }
      if (decision.title === null) { delete decision.title; normalizations.push('Omitted an optional null title.') }
      candidate.decision = decision
    }
  }
  const response = routeSchema.parse(candidate)
  if (['attach', 'status', 'stop'].includes(response.decision.kind) && !response.decision.ticketId) throw new Error('This decision requires a real ticketId')
  return { response, normalizations }
}
export function evaluationEnvironment(): NodeJS.ProcessEnv {
  const names = ['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'LANG', 'LC_ALL']
  return Object.fromEntries(names.flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]]]))
}
export function cliEvaluationProvider(argv: string[], options: { name: string; model?: string; timeoutMs?: number; executeTasks?: boolean }): EvaluationProvider {
  if (!argv.length || argv.some(value => typeof value !== 'string' || !value || value.length > 8192)) throw new Error('Provider argv must be a non-empty string array')
  const traces: EvaluationCallTrace[] = []
  const call = async <T>(request: { task: 'route' | 'execute_fixture'; guidance: string; context: unknown },
    validate: (value: unknown) => { response: T; normalizations: string[] }): Promise<T> => {
    const input = JSON.stringify(request), started = performance.now()
    const trace: EvaluationCallTrace = { at: new Date().toISOString(), task: request.task, transport: 'cli', input: request,
      inputSha256: sha(input), normalizations: [], state: 'running' }
    traces.push(trace)
    try {
      const result = await runCommand(argv, { input, timeoutMs: options.timeoutMs ?? 60_000, maxOutput: 1024 * 1024, env: evaluationEnvironment() })
      trace.output = result.stdout; trace.outputSha256 = sha(result.stdout)
      const decoded = JSON.parse(result.stdout) as Record<string, unknown>
      trace.usage = usageSchema.safeParse(decoded?.usage).data
      const protocol = { ...decoded }
      if (Object.hasOwn(protocol, 'evaluationTrace')) {
        if (JSON.stringify(protocol.evaluationTrace).length > 800_000) throw new Error('Provider model trace exceeded its bound')
        trace.provider = providerTraceSchema.parse(protocol.evaluationTrace)
        delete protocol.evaluationTrace
      }
      const parsed = validate(protocol)
      trace.normalized = parsed.response; trace.normalizations = parsed.normalizations
      trace.state = parsed.normalizations.length ? 'normalized' : 'valid'
      return parsed.response
    } catch (error) {
      trace.state = trace.output === undefined ? 'failed' : 'invalid'; trace.error = safeFailureMessage(error)
      throw new EvaluationProviderError(trace.error, trace)
    } finally { trace.durationMs = performance.now() - started }
  }
  return { name: options.name, ...options.model ? { model: options.model } : {},
    traces: () => traces,
    route: async context => call({ task: 'route', guidance: 'Apply context.routerPrompt.text when supplied, then adapt its routing decision to JSON {decision:{kind:accept|attach|ignore|status|stop,ticketId?,title?},usage?:{tokens?,cost?}}. Preserve all executable requests in mixed messages. Cite an existing task only when the original references, goal and requested output establish that relationship. A new unrelated request creates its own task. Ignore chatter. Omit unused optional fields. The scorer expectations are withheld.', context }, parseEvaluationRoute),
    ...options.executeTasks ? { executeTask: async (context: FixtureDefinition & { existingFiles: { name: string; content: string }[] }) =>
      call({ task: 'execute_fixture', guidance: 'Return JSON {files:[{name,content}],usage?:{tokens?,cost?}}. Produce only the requested output files using provided input and checkpoint files.', context },
        value => ({ response: filesSchema.parse(value), normalizations: [] })) } : {} }
}
