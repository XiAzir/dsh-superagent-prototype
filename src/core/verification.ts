/** Completion evidence is bound to the exact request, acceptance revision and ready report. */
import { key } from './ids.ts'
import { latestAssignment, type Ticket } from './model.ts'

export interface AcceptanceCriterion {
  id: string
  description: string
  kind: 'content' | 'code' | 'artifact' | 'source' | 'external'
  sourceRefs: string[]
}
export interface AcceptancePlan {
  revision: number
  mode: 'observe' | 'enforce'
  createdAt: string
  criteria: AcceptanceCriterion[]
}
export interface VerificationCheck {
  criterionId: string
  state: 'passed' | 'needs_changes' | 'unknown'
  summary: string
  evidenceRefs: string[]
}
export interface CompletionVerification {
  reportKey: string
  state: 'pending' | 'running' | 'passed' | 'needs_changes' | 'unknown'
  at: string
  summary: string
  checks: VerificationCheck[]
  attempt: number
}

export function completionKey(ticket: Ticket): string {
  const assignment = latestAssignment(ticket)
  return key(ticket.id, String(ticket.acceptance?.revision ?? 0), JSON.stringify(ticket.acceptance?.criteria ?? []),
    assignment?.id ?? '', JSON.stringify(assignment?.report ?? null), completionInputRevision(ticket),
    ...ticket.requests ? [JSON.stringify(ticket.requests.map(item => ({ triggerId: item.triggerId,
      state: item.state === 'released' || item.state === 'proposed' ? item.state : 'active', toTicketId: item.toTicketId })))] : [])
}

export function completionInputRevision(ticket: Ticket): string {
  return key(JSON.stringify(ticket.inputs.filter(input => !(input.kind === 'trigger' && (input.context || input.requestReleased))
    && !(input.kind === 'text' && input.id.startsWith('status:'))).map(input => input.kind === 'trigger'
      ? { id: input.id, kind: input.kind, triggerId: input.triggerId, note: input.note, at: input.at }
      : input)))
}

export function completionReady(ticket: Ticket): boolean {
  if (ticket.requestRedirect || ticket.requests?.some(item => item.state === 'proposed')) return false
  const report = latestAssignment(ticket)?.report
  return report?.state === 'ready' && (!ticket.acceptance || report.inputRevision === completionInputRevision(ticket))
}

export function completionApproved(ticket: Ticket): boolean {
  if (ticket.requestRedirect || ticket.requests?.some(item => item.state === 'proposed')) return false
  return ticket.acceptance?.mode !== 'enforce'
    || currentVerification(ticket)?.state === 'passed'
}

export function currentVerification(ticket: Ticket): CompletionVerification | undefined {
  return completionReady(ticket) && ticket.verification?.reportKey === completionKey(ticket)
    ? ticket.verification : undefined
}
