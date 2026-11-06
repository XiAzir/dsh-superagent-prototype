/** Bounded, privacy-conscious state projection for an external Watchdog process. */
import { createHash } from 'node:crypto'
import { latestAssignment, latestReport, liveTicket, waitsForPerson, type Ticket, type Trigger } from '../core/index.ts'
import { ticketStage } from '../core/stage.ts'
import type { Health } from '../sources/host.ts'

export interface WatchdogHost {
  store: { tickets: { list(): Ticket[] }; triggers?: { get(id: string): Trigger | undefined }; settings(): { paused: boolean; executor: { maxWorkers: number } } }
  health: Readonly<Record<string, Health>>
  executor: { activeCount(): number }
  machine: { mode?: string }
  configured(): boolean
  setupProblem?: { code?: string; place?: string; detail?: string }
  feishuProblem?: { code?: string; place?: string; detail?: string }
  /** Optional evidence projection; include only actual tool outcomes and active background work, never reasoning. */
  executionEvidence?(ticket: Ticket): WatchdogExecutionEvidence[]
}

export type WatchdogStatus = 'healthy' | 'waiting' | 'stalled' | 'diverged' | 'unknown'
export interface WatchdogExecutionEvidence { id: string; at: string; kind: 'tool' | 'artifact' | 'background'; summary: string; state?: string; ref?: string }
export interface WatchdogFinding {
  ticketId?: string
  status: WatchdogStatus
  evidence: string[]
  recommendation: string
}
export interface WatchdogSnapshot {
  schema: 1
  snapshotHash?: string
  observedAt: string
  infrastructure: { configured: boolean; paused: boolean; health: Record<string, { state: string; detail: string; at?: string }>; setup: string[] }
  executor: { activeWorkers: number; maxWorkers: number }
  tickets: WatchdogTicket[]
  candidates: { ticketId: string; reason: string; lastActivityAt?: string }[]
  page?: { offset: number; limit: number; total: number; nextOffset: number }
}
export interface WatchdogTicket {
  id: string
  revision?: string
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
  goal?: { triggerId: string; text: string; scope: string }
  corrections?: { triggerId: string; at: string; text: string }[]
  evidence?: WatchdogExecutionEvidence[]
  waitingFor?: { kind: string; subject: string; expectedAt?: string }
}

const redact = (value: string): string => value
  .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[private key redacted]')
  .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[redacted]')
  .replace(/\b((?:gh[pousr]_|github_pat_|xox[baprs]-|sk-)[A-Za-z0-9_-]{12,})\b/g, '[redacted]')
  .replace(/(["']?(?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|app[_-]?secret|client[_-]?secret|private[_-]?key|password|passwd|authorization|api[_-]?key)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}\]]+)/gi, '$1"[redacted]"')
  .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[redacted]@')
export const watchdogText = (value: string, max = 600): string => redact(value).replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, max)
const compact = watchdogText
const safeHealth = (health: Readonly<Record<string, Health>>) => Object.fromEntries(Object.entries(health).map(([name, value]) => [name,
  { state: compact(String(value.state), 40), detail: compact(String(value.detail), 500), ...(value.at ? { at: value.at } : {}) }]))

/** Stable operation version; a model recommendation is valid only for this exact mandate, report and input set. */
export function watchdogTicketRevision(ticket: Ticket): string {
  return createHash('sha256').update(JSON.stringify({ id: ticket.id, mandate: ticket.mandate, updatedAt: ticket.updatedAt,
    ended: ticket.ended, attention: ticket.attention, delivery: ticket.delivery,
    assignment: latestAssignment(ticket), inputs: ticket.inputs.map(input => ({ id: input.id, at: input.at })),
    undelivered: ticket.undelivered })).digest('hex')
}

/** Observation timestamps and baseline health classifications do not change semantic content identity. */
export function watchdogSnapshotHash(snapshot: WatchdogSnapshot): string {
  const { observedAt: _at, snapshotHash: _hash, ...content } = snapshot
  return createHash('sha256').update(JSON.stringify(content)).digest('hex')
}

function ticketProjection(ticket: Ticket, host: WatchdogHost, includeEvidence: boolean): WatchdogTicket {
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
    id: ticket.id, revision: watchdogTicketRevision(ticket), title: compact(ticket.title, 160), status, stage: stage.stage,
    ...(report ? { report: { state: report.state, at: report.at, summary: compact(report.summary, 600) } } : {}),
    ...(ticket.attention ? { attention: compact(ticket.attention.question, 300) } : {}),
    ...(ticket.ended ? { ended: { at: ticket.ended.at, by: ticket.ended.by, outcome: ticket.ended.outcome } } : {}),
    ...(latest ? { latestAssignment: { state: latest.state, createdAt: latest.createdAt, ...(latest.startedAt ? { startedAt: latest.startedAt } : {}),
      ...(latest.endedAt ? { endedAt: latest.endedAt } : {}), ...(latest.idleAt ? { idleAt: latest.idleAt } : {}) } } : {}),
    ...(activity ? { lastActivityAt: activity } : {}), repeatedErrors: failures,
    trace: ticket.assignments.slice(-5).map(item => ({ at: item.report?.at ?? item.endedAt ?? item.startedAt ?? item.createdAt,
      state: item.report?.state ?? item.state, summary: compact(item.report?.summary ?? item.endedReason ?? '', 240) })),
    inputCount: ticket.inputs.length, undeliveredCount: ticket.undelivered.length,
    ...(includeEvidence ? {
      goal: { triggerId: ticket.origin.triggerId, text: compact(host.store.triggers?.get(ticket.origin.triggerId)?.text ?? '', 1600),
        scope: compact(ticket.mandate.scope, 800) },
      corrections: ticket.inputs.filter(input => input.kind === 'trigger' && input.human && input.triggerId !== ticket.origin.triggerId).slice(-5)
        .flatMap(input => { const trigger = input.kind === 'trigger' && host.store.triggers?.get(input.triggerId)
          return trigger ? [{ triggerId: trigger.id, at: trigger.at, text: compact(trigger.text, 800) }] : [] }),
      evidence: (host.executionEvidence?.(ticket) ?? []).slice(-12).map(item => ({ id: compact(item.id, 200), at: item.at, kind: item.kind,
        summary: compact(item.summary, 800), ...(item.state ? { state: compact(item.state, 80) } : {}), ...(item.ref ? { ref: compact(item.ref, 300) } : {}) })),
      ...(report?.waitingFor ? { waitingFor: { ...report.waitingFor, subject: compact(report.waitingFor.subject, 300) } } : {}),
    } : {}),
  }
}

/**
 * Build a read-only snapshot with task content bounded and no source-message bodies, execution environment values, or credentials.
 * Elapsed time only selects review candidates; it never labels a ticket stalled.
 */
export function watchdogSnapshot(host: WatchdogHost, options: { now?: Date; candidateAfterMs?: number; maxTickets?: number; offset?: number; includeEvidence?: boolean } = {}): WatchdogSnapshot {
  const now = options.now ?? new Date()
  const maxTickets = Math.min(200, Math.max(1, options.maxTickets ?? 100))
  const all = host.store.tickets.list()
  const stableActiveOrder = (a: Ticket, b: Ticket) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
  const recentEndOrder = (a: Ticket, b: Ticket) => (Date.parse(b.ended?.at ?? '') - Date.parse(a.ended?.at ?? '')) || a.id.localeCompare(b.id)
  const active = all.filter(liveTicket).sort(stableActiveOrder)
  const recentEnded = all.filter(ticket => !liveTicket(ticket) && Date.parse(ticket.ended?.at ?? '') >= now.getTime() - 86_400_000).sort(recentEndOrder)
  const eligible = [...active, ...recentEnded]
  const offset = eligible.length ? Math.min(eligible.length - 1, Math.max(0, Math.floor(options.offset ?? 0))) : 0
  const selected = eligible.slice(offset, offset + maxTickets)
  const tickets = selected.map(ticket => ticketProjection(ticket, host, options.includeEvidence === true))
  const threshold = Math.max(60_000, options.candidateAfterMs ?? 30 * 60_000)
  const candidates = tickets.flatMap(ticket => {
    if (ticket.status !== 'working' && ticket.status !== 'waiting') return []
    const last = ticket.lastActivityAt ? Date.parse(ticket.lastActivityAt) : NaN
    if (!Number.isFinite(last) || now.getTime() - last < threshold) return []
    return [{ ticketId: ticket.id, reason: 'Elapsed-time review candidate; elapsed time alone does not imply lack of progress.', lastActivityAt: ticket.lastActivityAt }]
  })
  const settings = host.store.settings()
  const setup = [host.setupProblem, host.feishuProblem].filter(Boolean).map(problem => compact(`${problem!.place ?? ''} ${problem!.code ?? ''} ${problem!.detail ?? ''}`, 300))
  const snapshot: WatchdogSnapshot = { schema: 1, observedAt: now.toISOString(), infrastructure: { configured: host.configured(), paused: settings.paused,
    health: safeHealth(host.health), setup }, executor: { activeWorkers: host.executor.activeCount(), maxWorkers: settings.executor.maxWorkers }, tickets, candidates,
  page: { offset, limit: maxTickets, total: eligible.length, nextOffset: offset + tickets.length >= eligible.length ? 0 : offset + tickets.length } }
  snapshot.snapshotHash = watchdogSnapshotHash(snapshot)
  return snapshot
}

/** Baseline classification when no model assessor command is configured. */
export function baselineAssessment(snapshot: WatchdogSnapshot): { status: WatchdogStatus; findings: WatchdogFinding[]; semanticReview: 'configured' | 'not_configured'; semanticStatus?: 'unreviewed' } {
  const infra = Object.entries(snapshot.infrastructure.health).filter(([, health]) => health.state === 'error')
  if (infra.length) return { status: 'stalled', semanticReview: 'not_configured', semanticStatus: 'unreviewed', findings: infra.map(([name, health]) => ({ status: 'stalled',
    evidence: [`${name}: ${health.detail}`], recommendation: 'Inspect the reported component and its recent logs; recover only after an operator enables recovery.' })) }
  if (!snapshot.infrastructure.configured || snapshot.infrastructure.paused || snapshot.infrastructure.setup.length) return {
    status: 'waiting', semanticReview: 'not_configured', semanticStatus: 'unreviewed', findings: [{ status: 'waiting',
      evidence: [...!snapshot.infrastructure.configured ? ['Setup is incomplete.'] : [], ...snapshot.infrastructure.paused ? ['Processing is paused.'] : [],
        ...snapshot.infrastructure.setup], recommendation: 'Wait for an operator to complete setup or resume processing.' }] }
  const human = snapshot.tickets.filter(ticket => ticket.status === 'waiting_person' || ticket.status === 'stopped')
  if (human.length) return { status: 'waiting', semanticReview: 'not_configured', semanticStatus: 'unreviewed', findings: human.map(ticket => ({ ticketId: ticket.id, status: 'waiting',
    evidence: [ticket.status === 'stopped' ? 'A person explicitly stopped this ticket.' : `Ticket is waiting for a person (${ticket.stage}).`],
    recommendation: 'Wait for the person; preserve the current ticket state.' })) }
  return { status: 'healthy', semanticReview: 'not_configured', semanticStatus: 'unreviewed', findings: [] }
}

