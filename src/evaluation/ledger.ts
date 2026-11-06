/** Persistent, replay-safe outcome measurements shared by runtime instrumentation and evaluation runs. */
import { record } from '../kv.ts'
import type { Store } from '../app/store.ts'

export type EvaluationEventKind = 'request' | 'route' | 'usage' | 'completion' | 'verification' | 'intervention' | 'adoption' | 'recovery' | 'side_effect'
export interface EvaluationEvent {
  id: string
  kind: EvaluationEventKind
  at?: string
  ticketId?: string
  triggerId?: string
  /** Metadata and scalar measurements only; caller retains raw requests and tool output in their original stores. */
  data?: Record<string, unknown>
}
export interface RecordedEvaluationEvent extends EvaluationEvent { at: string; runId: string }
export interface EvaluationDistribution { count: number; p50: number | null; p95: number | null }
export interface EvaluationSummary {
  runId: string
  events: number
  counts: Record<EvaluationEventKind, number>
  metrics: {
    routerDecisions: number; wrongRoutes: number | null; falseCompletions: number | null
    preventedFalseCompletions: number; duplicateSideEffects: number | null; unexpectedSideEffects: number | null
    humanInterventions: number | null; routingCorrections: number | null; adoptionRate: number | null
    tokens: number | null; cost: number | null
    completionLatencyMs: EvaluationDistribution; responseLatencyMs: EvaluationDistribution; recoveryLatencyMs: EvaluationDistribution
  }
  knownUsage: { tokens: number; cost: number; calls: number; unknownTokens: number; unknownCost: number }
  coverage: { routeJudgments: number; completionJudgments: number; sideEffectChecks: number; adoptionJudgments: number; interventionEvents: number }
}
const kinds: EvaluationEventKind[] = ['request', 'route', 'usage', 'completion', 'verification', 'intervention', 'adoption', 'recovery', 'side_effect']
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)])) : value
export function distribution(values: number[]): EvaluationDistribution {
  const sorted = values.filter(positive).sort((a, b) => a - b)
  const percentile = (p: number) => sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]! : null
  return { count: sorted.length, p50: percentile(0.5), p95: percentile(0.95) }
}

/** Stores bounded measurements once and projects only metrics supported by explicit observations. */
export class EvaluationLedger {
  readonly runId: string
  constructor(private readonly store: Pick<Store, 'get' | 'set' | 'keys' | 'atomic'>,
    private readonly options: { runId?: string; now?: () => Date } = {}) {
    this.runId = options.runId ?? 'runtime'
    if (!/^[a-zA-Z0-9._-]{1,120}$/.test(this.runId)) throw new Error('Invalid evaluation run ID')
  }
  private prefix(): string { return `evaluation:${this.runId}:event:` }
  record(input: EvaluationEvent): RecordedEvaluationEvent {
    if (!input.id || input.id.length > 512 || !kinds.includes(input.kind)) throw new Error('Invalid evaluation event identity')
    const serialized = JSON.stringify(stable(input))
    if (serialized.length > 16000) throw new Error('Evaluation event metadata exceeds its bound')
    if (input.at !== undefined && !Number.isFinite(Date.parse(input.at))) throw new Error('Invalid evaluation event timestamp')
    return this.store.atomic(() => {
      const key = record<RecordedEvaluationEvent>(`${this.prefix()}${input.id}`), old = this.store.get(key)
      if (old) {
        const { runId: _runId, at: _at, ...content } = old
        if (JSON.stringify(stable({ ...content, ...input.at === undefined ? {} : { at: old.at } })) !== serialized) {
          throw new Error('Evaluation event ID was reused with different measurements')
        }
        return old
      }
      const event: RecordedEvaluationEvent = { ...input, at: input.at ?? (this.options.now?.() ?? new Date()).toISOString(), runId: this.runId }
      this.store.set(key, event)
      return event
    })
  }
  events(): RecordedEvaluationEvent[] {
    return this.store.keys(this.prefix()).map(key => this.store.get<RecordedEvaluationEvent>(key))
      .filter((value): value is RecordedEvaluationEvent => !!value).sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
  }
  summary(): EvaluationSummary {
    const events = this.events(), select = (kind: EvaluationEventKind) => events.filter(event => event.kind === kind)
    const counts = Object.fromEntries(kinds.map(kind => [kind, select(kind).length])) as Record<EvaluationEventKind, number>
    const routes = select('route'), routeJudgments = routes.filter(row => typeof row.data?.correct === 'boolean')
    const completions = select('completion'), completionJudgments = completions.filter(row => typeof row.data?.correct === 'boolean')
    const effects = select('side_effect'), effectChecks = effects.filter(row => positive(row.data?.count))
    const adoptions = select('adoption').filter(row => typeof row.data?.accepted === 'boolean')
    const usage = select('usage'), tokenCalls = usage.filter(row => positive(row.data?.tokens)), costCalls = usage.filter(row => positive(row.data?.cost))
    const knownUsage = { tokens: tokenCalls.reduce((sum, row) => sum + (row.data!.tokens as number), 0),
      cost: costCalls.reduce((sum, row) => sum + (row.data!.cost as number), 0), calls: usage.length,
      unknownTokens: usage.length - tokenCalls.length, unknownCost: usage.length - costCalls.length }
    const completionLatencies = completions.filter(row => !['stopped', 'closed', 'dropped'].includes(String(row.data?.outcome ?? ''))).flatMap(row => {
      if (positive(row.data?.durationMs)) return [row.data.durationMs]
      const request = select('request').find(item => row.ticketId && item.ticketId === row.ticketId || row.triggerId && item.triggerId === row.triggerId)
      return request ? [Date.parse(row.at) - Date.parse(request.at)] : []
    })
    return { runId: this.runId, events: events.length, counts, metrics: {
      routerDecisions: routes.filter(row => row.data?.path === 'router').length,
      wrongRoutes: routeJudgments.length ? routeJudgments.filter(row => row.data?.correct === false).length : null,
      falseCompletions: completionJudgments.length ? completionJudgments.filter(row => row.data?.correct === false && row.data?.published === true).length : null,
      preventedFalseCompletions: select('verification').filter(row => row.data?.state === 'needs_changes' && row.data?.prevented === true).length,
      duplicateSideEffects: effectChecks.length ? effectChecks.reduce((sum, row) => sum + Math.max(0, (row.data!.count as number) - 1), 0) : null,
      unexpectedSideEffects: effectChecks.length ? effectChecks.reduce((sum, row) => sum + Math.max(0, (row.data!.count as number)
        - (positive(row.data?.expectedCount) ? row.data.expectedCount : 1)), 0) : null,
      humanInterventions: select('intervention').length || null,
      routingCorrections: select('intervention').length ? select('intervention').filter(row => row.data?.kind === 'routing-correction').length : null,
      adoptionRate: adoptions.length ? adoptions.filter(row => row.data?.accepted === true).length / adoptions.length : null,
      tokens: usage.length && tokenCalls.length === usage.length ? knownUsage.tokens : null,
      cost: usage.length && costCalls.length === usage.length ? knownUsage.cost : null,
      completionLatencyMs: distribution(completionLatencies),
      responseLatencyMs: distribution(routes.flatMap(row => positive(row.data?.durationMs) ? [row.data.durationMs] : [])),
      recoveryLatencyMs: distribution(select('recovery').flatMap(row => positive(row.data?.durationMs) ? [row.data.durationMs] : [])),
    }, knownUsage, coverage: { routeJudgments: routeJudgments.length, completionJudgments: completionJudgments.length,
      sideEffectChecks: effectChecks.length, adoptionJudgments: adoptions.length, interventionEvents: select('intervention').length } }
  }
}
