/** Bounded, privacy-conscious state projection for an external Watchdog process. */
import { latestAssignment, latestReport, liveTicket, waitsForPerson, type Ticket } from '../core/index.ts'
import { ticketStage } from '../core/stage.ts'
import type { Health } from '../sources/host.ts'

export interface WatchdogHost {
  store: { tickets: { list(): Ticket[] }; settings(): { paused: boolean; executor: { maxWorkers: number } } }
  health: Readonly<Record<string, Health>>
  executor: { activeCount(): number }
  machine: { mode?: string }
  configured(): boolean
  setupProblem?: { code?: string; place?: string; detail?: string }
  feishuProblem?: { code?: string; place?: string; detail?: string }
}

export type WatchdogStatus = 'healthy' | 'waiting' | 'stalled' | 'diverged'
export interface WatchdogFinding {
  ticketId?: string
  status: WatchdogStatus
  evidence: string[]
  recommendation: string
}
export interface WatchdogSnapshot {
  schema: 1
  observedAt: string
  infrastructure: { configured: boolean; paused: boolean; health: Record<string, { state: string; detail: string; at?: string }>; setup: string[] }
  executor: { activeWorkers: number; maxWorkers: number }
  tickets: WatchdogTicket[]
  candidates: { ticketId: string; reason: string; lastActivityAt?: string }[]
  page?: { offset: number; limit: number; total: number; nextOffset: number }
}
export interface WatchdogTicket {
  id: string
  title: string
  status: 'working' | 'queued' | 'waiting' | 'waiting_person' | 'completed' | 'stopped'
  stage: string
  report?: { state: string; at: string; summary: string }
  attention?: string
  ended?: { at: string; by: string; outcome: string }
  latestAssignment?: { state: string; createdAt: string; startedAt?: string; endedAt?: string; idleAt?: string }
  lastActivityAt?: string
  repeatedErrors: number
  trace: { at: string; state: string; summary: string }[]
  inputCount: number
  undeliveredCount: number
}

const redact = (value: string): string => value
  .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[redacted]')
  .replace(/\b((?:gh[pousr]_|github_pat_|xox[baprs]-|sk-)[A-Za-z0-9_-]{12,})\b/g, '[redacted]')
  .replace(/(["']?(?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|app[_-]?secret|client[_-]?secret|private[_-]?key|password|passwd|authorization|api[_-]?key)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}\]]+)/gi, '$1"[redacted]"')
  .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[redacted]@')
const compact = (value: string, max = 600): string => redact(value).replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, max)
const safeHealth = (health: Readonly<Record<string, Health>>) => Object.fromEntries(Object.entries(health).map(([name, value]) => [name,
  { state: compact(String(value.state), 40), detail: compact(String(value.detail), 500), ...(value.at ? { at: value.at } : {}) }]))

function ticketProjection(ticket: Ticket): WatchdogTicket {
  const stage = ticketStage(ticket)
  const latest = latestAssignment(ticket)
  const report = latestReport(ticket)
  const status: WatchdogTicket['status'] = ticket.ended
    ? ticket.ended.by === 'human' && ticket.ended.outcome === 'stopped' ? 'stopped' : 'completed'
    : ticket.attention || ticket.delivery || waitsForPerson(ticket) || stage.stage === 'person'
      ? 'waiting_person'
      : stage.stage === 'working' && stage.action === 'queued' ? 'queued'
      : stage.stage === 'idle' ? 'waiting'
      : 'working'
  const activity = [report?.at, latest?.idleAt, ...ticket.inputs.map(input => input.at), latest?.startedAt, latest?.createdAt]
    .filter((value): value is string => !!value).sort().at(-1)
  const failures = ticket.assignments.filter(item => item.report?.state === 'failed' || item.report?.state === 'blocked').length
    + (ticket.delivery ? 1 : 0)
  return {
    id: ticket.id, title: compact(ticket.title, 160), status, stage: stage.stage,
    ...(report ? { report: { state: report.state, at: report.at, summary: compact(report.summary, 600) } } : {}),
    ...(ticket.attention ? { attention: compact(ticket.attention.question, 300) } : {}),
    ...(ticket.ended ? { ended: { at: ticket.ended.at, by: ticket.ended.by, outcome: ticket.ended.outcome } } : {}),
    ...(latest ? { latestAssignment: { state: latest.state, createdAt: latest.createdAt, ...(latest.startedAt ? { startedAt: latest.startedAt } : {}),
      ...(latest.endedAt ? { endedAt: latest.endedAt } : {}), ...(latest.idleAt ? { idleAt: latest.idleAt } : {}) } } : {}),
    ...(activity ? { lastActivityAt: activity } : {}), repeatedErrors: failures,
    trace: ticket.assignments.slice(-5).map(item => ({ at: item.report?.at ?? item.endedAt ?? item.startedAt ?? item.createdAt,
      state: item.report?.state ?? item.state, summary: compact(item.report?.summary ?? item.endedReason ?? '', 240) })),
    inputCount: ticket.inputs.length, undeliveredCount: ticket.undelivered.length,
  }
}

/**
 * Build a read-only snapshot with task content bounded and no source-message bodies, execution environment values, or credentials.
 * Elapsed time only selects review candidates; it never labels a ticket stalled.
 */
export function watchdogSnapshot(host: WatchdogHost, options: { now?: Date; candidateAfterMs?: number; maxTickets?: number; offset?: number } = {}): WatchdogSnapshot {
  const now = options.now ?? new Date()
  const maxTickets = Math.min(200, Math.max(1, options.maxTickets ?? 100))
  const all = host.store.tickets.list()
  const byActivity = (a: Ticket, b: Ticket) => b.updatedAt.localeCompare(a.updatedAt)
  const active = all.filter(liveTicket).sort(byActivity)
  const recentEnded = all.filter(ticket => !liveTicket(ticket) && Date.parse(ticket.ended?.at ?? '') >= now.getTime() - 86_400_000).sort(byActivity)
  const eligible = [...active, ...recentEnded]
  const offset = eligible.length ? Math.min(eligible.length - 1, Math.max(0, Math.floor(options.offset ?? 0))) : 0
  const selected = eligible.slice(offset, offset + maxTickets)
  const tickets = selected.map(ticketProjection)
  const threshold = Math.max(60_000, options.candidateAfterMs ?? 30 * 60_000)
  const candidates = tickets.flatMap(ticket => {
    if (ticket.status !== 'working' && ticket.status !== 'waiting') return []
    const last = ticket.lastActivityAt ? Date.parse(ticket.lastActivityAt) : NaN
    if (!Number.isFinite(last) || now.getTime() - last < threshold) return []
    return [{ ticketId: ticket.id, reason: 'Elapsed-time review candidate; elapsed time alone does not imply lack of progress.', lastActivityAt: ticket.lastActivityAt }]
  })
  const settings = host.store.settings()
  const setup = [host.setupProblem, host.feishuProblem].filter(Boolean).map(problem => compact(`${problem!.place ?? ''} ${problem!.code ?? ''} ${problem!.detail ?? ''}`, 300))
  return { schema: 1, observedAt: now.toISOString(), infrastructure: { configured: host.configured(), paused: settings.paused,
    health: safeHealth(host.health), setup }, executor: { activeWorkers: host.executor.activeCount(), maxWorkers: settings.executor.maxWorkers }, tickets, candidates,
  page: { offset, limit: maxTickets, total: eligible.length, nextOffset: offset + tickets.length >= eligible.length ? 0 : offset + tickets.length } }
}

/** Baseline classification when no model assessor command is configured. */
export function baselineAssessment(snapshot: WatchdogSnapshot): { status: WatchdogStatus; findings: WatchdogFinding[]; semanticReview: 'configured' | 'not_configured' } {
  const infra = Object.entries(snapshot.infrastructure.health).filter(([, health]) => health.state === 'error')
  if (infra.length) return { status: 'stalled', semanticReview: 'not_configured', findings: infra.map(([name, health]) => ({ status: 'stalled',
    evidence: [`${name}: ${health.detail}`], recommendation: 'Inspect the reported component and its recent logs; recover only after an operator enables recovery.' })) }
  if (!snapshot.infrastructure.configured || snapshot.infrastructure.paused || snapshot.infrastructure.setup.length) return {
    status: 'waiting', semanticReview: 'not_configured', findings: [{ status: 'waiting',
      evidence: [...!snapshot.infrastructure.configured ? ['Setup is incomplete.'] : [], ...snapshot.infrastructure.paused ? ['Processing is paused.'] : [],
        ...snapshot.infrastructure.setup], recommendation: 'Wait for an operator to complete setup or resume processing.' }] }
  const human = snapshot.tickets.filter(ticket => ticket.status === 'waiting_person' || ticket.status === 'stopped')
  if (human.length) return { status: 'waiting', semanticReview: 'not_configured', findings: human.map(ticket => ({ ticketId: ticket.id, status: 'waiting',
    evidence: [ticket.status === 'stopped' ? 'A person explicitly stopped this ticket.' : `Ticket is waiting for a person (${ticket.stage}).`],
    recommendation: 'Wait for the person; preserve the current ticket state.' })) }
  return { status: 'healthy', semanticReview: 'not_configured', findings: [] }
}

