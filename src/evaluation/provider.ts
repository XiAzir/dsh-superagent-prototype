/** An optional configured provider CLI; no production session, source or credential store is read. */
import { z } from 'zod'
import type { Trigger } from '../core/index.ts'
import type { FixtureDefinition } from './fixtures.ts'
import { runCommand } from '../../scripts/dsh-superagent-watchdog.mjs'

export interface EvaluationUsage { tokens?: number; cost?: number }
export interface EvaluationRoute { kind: 'accept' | 'attach' | 'ignore' | 'status' | 'stop'; ticketId?: string; title?: string }
export interface EvaluationProvider {
  name: string
  model?: string
  route(input: { trigger: Trigger; tickets: { id: string; title: string; ended: boolean; sourceText: string; source?: string; threads?: Trigger['threads'] }[] }): Promise<{ decision: EvaluationRoute; usage?: EvaluationUsage }>
  executeTask?(input: FixtureDefinition & { existingFiles: { name: string; content: string }[] }): Promise<{ files: { name: string; content: string }[]; usage?: EvaluationUsage }>
}
const usageSchema = z.object({ tokens: z.number().int().nonnegative().optional(), cost: z.number().nonnegative().optional() }).strict()
const routeSchema = z.object({ decision: z.object({ kind: z.enum(['accept', 'attach', 'ignore', 'status', 'stop']),
  ticketId: z.string().min(1).max(200).optional(), title: z.string().min(1).max(200).optional() }).strict(), usage: usageSchema.optional() }).strict()
const filesSchema = z.object({ files: z.array(z.object({ name: z.string().regex(/^[a-zA-Z0-9._-]{1,100}$/), content: z.string().max(100000) }).strict()).max(8),
  usage: usageSchema.optional() }).strict()
export function evaluationEnvironment(): NodeJS.ProcessEnv {
  const names = ['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'LANG', 'LC_ALL']
  return Object.fromEntries(names.flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]]]))
}
export function cliEvaluationProvider(argv: string[], options: { name: string; model?: string; timeoutMs?: number; executeTasks?: boolean }): EvaluationProvider {
  if (!argv.length || argv.some(value => typeof value !== 'string' || !value || value.length > 8192)) throw new Error('Provider argv must be a non-empty string array')
  const call = async (request: unknown) => {
    const result = await runCommand(argv, { input: JSON.stringify(request), timeoutMs: options.timeoutMs ?? 60_000,
      maxOutput: 1024 * 1024, env: evaluationEnvironment() })
    return JSON.parse(result.stdout)
  }
  return { name: options.name, ...options.model ? { model: options.model } : {},
    route: async context => routeSchema.parse(await call({ task: 'route', guidance: 'Return JSON {decision:{kind:accept|attach|ignore|status|stop,ticketId?,title?},usage?:{tokens?,cost?}}. Route only the original request. Reuse an existing ticket when the request continues it. Ignore chatter. The scorer expectations are withheld.', context })),
    ...options.executeTasks ? { executeTask: async (context: FixtureDefinition & { existingFiles: { name: string; content: string }[] }) =>
      filesSchema.parse(await call({ task: 'execute_fixture', guidance: 'Return JSON {files:[{name,content}],usage?:{tokens?,cost?}}. Produce only the requested output files using provided input and checkpoint files.', context })) } : {} }
}
