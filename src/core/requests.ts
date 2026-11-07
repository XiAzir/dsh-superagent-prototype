/** Durable human-request responsibility, independent of replaceable Worker/ticket routing. */
import type { EngineOptions } from './part.ts'
import type { Ticket, Trigger } from './model.ts'
import type { Repositories } from './ports.ts'
import { UserError } from './errors.ts'

export type RequestState = 'pending' | 'proposed' | 'active' | 'returned' | 'completed' | 'cancelled' | 'answered' | 'ignored'
export const MAX_REQUEST_REDIRECTS = 4
export interface RequestRoutingEvidence { reason: string; evidenceRefs: string[] }
export interface RequestOwner { ticketId: string; state: 'proposed' | 'claimed' | 'completed' | 'cancelled'; assignmentId?: string; at: string }
export interface RequestHistory {
  revision: number; at: string; kind: string; ticketId?: string; toTicketId?: string; reason?: string; requestId?: string
}
export interface RequestResponsibility {
  id: string; triggerId: string; revision: number; state: RequestState; owners: RequestOwner[]; history: RequestHistory[]
  routing?: RequestRoutingEvidence
}
export interface TicketRequestBinding {
  triggerId: string; revision: number; state: 'proposed' | 'active' | 'released' | 'completed' | 'cancelled'; at: string
  toTicketId?: string; reason?: string
}
export const requestRoutingEnabled = (options: Pick<EngineOptions, 'provisionalRouting'>): boolean =>
  typeof options.provisionalRouting === 'function' ? options.provisionalRouting() : options.provisionalRouting === true

/** Stable IDs of every original request a ticket has ever touched, including released requests. */
export const requestIds = (ticket: Ticket): string[] => [...new Set([...ticket.origin.triggerIds,
  ...ticket.inputs.flatMap(input => input.kind === 'trigger' && input.human ? [input.triggerId] : []),
  ...ticket.requests?.map(item => item.triggerId) ?? []])]

/** Effective participants exclude owners whose responsibility was returned or transferred. */
export function effectiveRequestOwners(request: Pick<RequestResponsibility, 'owners' | 'history'>): RequestOwner[] {
  return request.owners.filter(owner => {
    const event = request.history.findLast(item => item.ticketId === owner.ticketId
      && ['proposed', 'claimed', 'completed', 'cancelled', 'released', 'returned', 'transferred'].includes(item.kind))
    return !event || !['released', 'returned', 'transferred'].includes(event.kind)
  })
}
function aggregateRequestState(request: Pick<RequestResponsibility, 'owners' | 'history'>): RequestState {
  const owners = effectiveRequestOwners(request)
  return owners.some(owner => owner.state === 'claimed') ? 'active' : owners.some(owner => owner.state === 'proposed') ? 'proposed'
    : owners.some(owner => owner.state === 'cancelled') ? 'cancelled' : owners.some(owner => owner.state === 'completed') ? 'completed' : 'returned'
}

/** Reconstruct legacy responsibility read-only; new transitions persist the resulting first revision. */
export function requestResponsibility(repo: Pick<Repositories, 'triggers' | 'tickets' | 'decisions'>, triggerId: string): RequestResponsibility | undefined {
  const trigger = repo.triggers.get(triggerId)
  if (!trigger?.human || trigger.collaboration) return
  const disposition = repo.triggers.disposition(triggerId)
  if (disposition?.request) return disposition.request
  const returned = new Set(disposition?.handbacks?.map(item => item.ticketId))
  const owners: RequestOwner[] = repo.tickets.list().filter(ticket => !returned.has(ticket.id)
    && !ticket.requests?.some(item => item.triggerId === triggerId && item.state === 'released')
    && (ticket.origin.triggerIds.includes(triggerId) || ticket.inputs.some(input => input.kind === 'trigger'
      && input.triggerId === triggerId && input.human && !input.context && !input.requestReleased)))
    .map(ticket => ({ ticketId: ticket.id, state: ticket.ended ? ticket.ended.by === 'human' ? 'cancelled' : 'completed' : 'claimed',
      assignmentId: ticket.assignments.at(-1)?.id, at: ticket.updatedAt }))
  const active = owners.some(owner => owner.state === 'claimed' || owner.state === 'proposed')
  const decision = disposition?.decisionId && repo.decisions.get(disposition.decisionId)
  const state: RequestState = active ? 'active' : owners.some(owner => owner.state === 'cancelled') ? 'cancelled'
    : owners.some(owner => owner.state === 'completed') ? 'completed' : returned.size ? 'returned'
      : decision && decision.reason.some(item => item.code === 'statusRead') ? 'answered'
        : decision && decision.kind === 'ignore' ? 'ignored' : 'pending'
  return { id: triggerId, triggerId, revision: 0, state, owners, history: [] }
}

/** One request transition is written in the caller's transaction and announced with its revision. */
export function writeRequest(options: EngineOptions, triggerId: string, state: RequestState, owners: RequestOwner[],
  event: Omit<RequestHistory, 'revision' | 'at'>, routing?: RequestRoutingEvidence): RequestResponsibility | undefined {
  if (!requestRoutingEnabled(options)) return
  const previous = requestResponsibility(options.repo, triggerId)
  if (!previous) return
  const at = options.now?.() ?? new Date().toISOString(), revision = previous.revision + 1
  const next: RequestResponsibility = { ...previous, revision, state, owners,
    history: [...previous.history, { ...event, revision, at }], ...routing ? { routing } : {} }
  const disposition = options.repo.triggers.disposition(triggerId) ?? { fanout: [], at }
  options.repo.triggers.saveDisposition(triggerId, { ...disposition, request: next })
  options.emit?.({ type: 'request.changed', at, data: { triggerId, revision, state } })
  return next
}

/** Keep a ticket projection for completion checks that deliberately have no repository dependency. */
export function bindRequest(options: EngineOptions, ticket: Ticket, trigger: Trigger, proposed: boolean,
  routing?: RequestRoutingEvidence): RequestResponsibility | undefined {
  if (!requestRoutingEnabled(options) || !trigger.human || trigger.collaboration) return
  const previous = requestResponsibility(options.repo, trigger.id)!
  const prior = previous.owners.find(item => item.ticketId === ticket.id)
  const ownerState = proposed ? 'proposed' : 'claimed', assignmentId = ticket.assignments.at(-1)?.id
  if (prior?.state === ownerState && ticket.requests?.some(item => item.triggerId === trigger.id && item.state !== 'released')
    && (!routing || JSON.stringify(routing) === JSON.stringify(previous.routing))) return previous
  const at = options.now?.() ?? new Date().toISOString()
  const owners = [...previous.owners.filter(item => item.ticketId !== ticket.id),
    { ticketId: ticket.id, state: ownerState as RequestOwner['state'], assignmentId, at }]
  const next = writeRequest(options, trigger.id, owners.some(item => item.state === 'claimed') ? 'active' : 'proposed', owners,
    { kind: proposed ? 'proposed' : 'claimed', ticketId: ticket.id }, routing)!
  ticket.requests = [...ticket.requests?.filter(item => item.triggerId !== trigger.id) ?? [],
    { triggerId: trigger.id, revision: next.revision, state: proposed ? 'proposed' : 'active', at }]
  delete ticket.requestRedirect
  return next
}

/** Release only this ticket's work/acceptance responsibility while retaining original bytes and routing history. */
export function releaseRequest(options: EngineOptions, ticket: Ticket, triggerId: string, reason: string, toTicketId?: string,
  requestId?: string): RequestResponsibility | undefined {
  const previous = requestResponsibility(options.repo, triggerId)
  if (!requestRoutingEnabled(options) || !previous) return
  const at = options.now?.() ?? new Date().toISOString()
  const owners = previous.owners.map(owner => owner.ticketId === ticket.id ? { ...owner, state: 'cancelled' as const, at } : owner)
  const stillOwned = owners.some(item => item.state === 'claimed' || item.state === 'proposed')
  const redirects = previous.history.filter(item => item.kind === 'transferred' || item.kind === 'returned').length
  if ((toTicketId || !stillOwned) && redirects >= MAX_REQUEST_REDIRECTS) throw new UserError('notAdmissible', {
    reason: `The original request reached its ${MAX_REQUEST_REDIRECTS} automatic transfer limit; inspect its context or ask one concrete clarification. Current ownership and work are preserved.` })
  const event = { kind: toTicketId ? 'transferred' : stillOwned ? 'released' : 'returned', ticketId: ticket.id, reason,
    ...toTicketId ? { toTicketId } : {}, ...requestId ? { requestId } : {} }
  const state = aggregateRequestState({ owners, history: [...previous.history, { ...event, revision: previous.revision + 1, at }] })
  const next = writeRequest(options, triggerId, state, owners, event)!
  ticket.requests = [...ticket.requests?.filter(item => item.triggerId !== triggerId) ?? [],
    { triggerId, revision: next.revision, state: 'released', at, reason, ...toTicketId ? { toTicketId } : {} }]
  for (const input of ticket.inputs) if (input.kind === 'trigger' && input.triggerId === triggerId) {
    input.requestReleased = true
    ticket.undelivered = ticket.undelivered.filter(id => id !== input.id)
  }
  if (ticket.acceptance) ticket.acceptance = { ...ticket.acceptance, revision: ticket.acceptance.revision + 1,
    criteria: ticket.acceptance.criteria.flatMap(item => {
      const sourceRefs = item.sourceRefs.filter(ref => ref !== `trigger/${triggerId}`)
      return sourceRefs.length ? [{ ...item, sourceRefs }] : []
    }) }
  delete ticket.verification
  ticket.updatedAt = at
  return next
}

/** Mark current owners terminal without letting an ended historical ticket settle a transferred request. */
export function settleTicketRequests(options: EngineOptions, ticket: Ticket): void {
  if (!requestRoutingEnabled(options) || !ticket.ended) return
  for (const binding of ticket.requests ?? []) {
    if (!['active', 'proposed'].includes(binding.state)) continue
    const previous = requestResponsibility(options.repo, binding.triggerId)
    if (!previous) continue
    const cancelled = ticket.ended.by === 'human', at = ticket.ended.at
    const completed = ['completed', 'merged'].includes(ticket.ended.outcome)
    const ownerState = cancelled || !completed ? 'cancelled' : 'completed'
    const owners = previous.owners.map(owner => owner.ticketId === ticket.id ? { ...owner, state: ownerState as RequestOwner['state'], at } : owner)
    const event = { kind: cancelled ? 'cancelled' : completed ? 'completed' : 'returned', ticketId: ticket.id, reason: ticket.ended.reason }
    const state = aggregateRequestState({ owners, history: [...previous.history, { ...event, revision: previous.revision + 1, at }] })
    const next = writeRequest(options, binding.triggerId, state, owners, event)
    binding.state = cancelled || !completed ? 'cancelled' : 'completed'; binding.at = at; binding.revision = next?.revision ?? binding.revision
  }
}
