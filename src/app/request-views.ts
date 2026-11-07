/** Bounded, read-only projections of original request responsibility and routing history. */
import { requestIds, requestResponsibility, type RequestResponsibility, type Ticket, type Trigger, type TriggerDisposition } from '../core/index.ts'
import type { Store } from './store.ts'

type RequestRecords = Pick<Store, 'triggers' | 'tickets' | 'decisions'>
export interface RequestView {
  request: RequestResponsibility
  source: { triggerId: string; source: string; at: string; preview: string; chars: number; read: string }
}

/** A Worker sees its own responsibility history; owner-facing views retain the complete transfer trail. */
export function requestView(records: RequestRecords, triggerId: string, workerTicketId?: string): RequestView | undefined {
  const trigger = records.triggers.get(triggerId), request = requestResponsibility(records, triggerId)
  if (!trigger || !request) return
  return { request: workerTicketId ? requestForWorker(request, workerTicketId) : request,
    source: { triggerId, source: trigger.source, at: trigger.at, preview: trigger.text.replace(/\s+/g, ' ').slice(0, 160),
      chars: trigger.text.length, read: `trigger/${triggerId}` } }
}

/** Preserve own handoff facts while keeping other tickets and their histories outside Worker resource scope. */
export function requestForWorker(request: RequestResponsibility, ticketId: string): RequestResponsibility {
  const { routing, ...visible } = request
  const active = request.owners.some(owner => owner.ticketId === ticketId && ['proposed', 'claimed'].includes(owner.state))
  return { ...visible, owners: request.owners.filter(owner => owner.ticketId === ticketId),
    history: request.history.filter(event => event.ticketId === ticketId).map(({ toTicketId: _target, ...event }) => event),
    ...active && routing ? { routing: { reason: routing.reason, evidenceRefs: [] } } : {} }
}

/** List stable requests touched by this ticket, including requirements handed to another owner. */
export function ticketRequestViews(records: RequestRecords, ticket: Ticket, offset = 0, limit = 20, worker = false) {
  const size = Math.max(1, Math.min(50, limit)), ids = requestIds(ticket).slice().reverse()
  const items = ids.flatMap(id => requestView(records, id, worker ? ticket.id : undefined) ?? [])
  return { items: items.slice(offset, offset + size), next_offset: items.length > offset + size ? offset + size : null }
}

/** Compact inline ownership metadata; full evidence/history is fetched only when the caller needs it. */
export function requestSummary(trigger: Trigger, disposition?: TriggerDisposition) {
  const request = disposition?.request
  return request ? { request_id: request.id, revision: request.revision, state: request.state,
    owners: request.owners.map(({ ticketId, state }) => ({ ticket_id: ticketId, state })), read: `trigger/${trigger.id}/request` } : undefined
}
