/** Host-observed tool results and usage; model prose never becomes execution proof. */
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { record } from '../kv.ts'
import type { Store } from './store.ts'
import type { VerificationEvidence } from './verification.ts'
import type { WatchdogExecutionEvidence } from './watchdog.ts'
import { watchdogText } from './watchdog.ts'

interface EvidenceRow extends VerificationEvidence { at: string; eventId: string; assignmentId?: string; turn?: number }
const journalKey = (ticketId: string) => record<EvidenceRow[]>(`execution-evidence:${ticketId}`)
const turnKey = (ticketId: string, turn: number) => record<{ assignmentId: string }>(`execution-evidence-turn:${ticketId}:${turn}`)
const callKey = (ticketId: string, callId: string) => record<{ assignmentId?: string; name: string; arguments: string }>(`execution-evidence-call:${ticketId}:${callId}`)

/** A bounded durable projection of actual tool outcomes, recoverable from the original Session log. */
export class ExecutionEvidence {
  constructor(private readonly store: Pick<Store, 'get' | 'set' | 'tickets'>) {}
  capture(ticketId: string, event: SessionEvent): void {
    const ticket = this.store.tickets.get(ticketId)
    if (!ticket || !Number.isFinite(event.time)) return
    const assignment = ticket?.assignments.findLast(item => Date.parse(item.startedAt ?? item.createdAt) <= event.time)
    if (event.type === 'turn/start') {
      if (assignment) this.store.set(turnKey(ticketId, event.data.turn), { assignmentId: assignment.id })
      return
    }
    if (event.type === 'tool/call') {
      this.store.set(callKey(ticketId, event.data.callId), { assignmentId: this.store.get(turnKey(ticketId, event.data.turn))?.assignmentId ?? assignment?.id,
        name: event.data.name, arguments: watchdogText(event.data.arguments, 2500) })
      return
    }
    if (event.type !== 'tool/result') return
    const call = this.store.get(callKey(ticketId, event.data.message.toolCallId))
    const body = JSON.stringify({ call, isError: event.data.message.isError,
      output: event.data.message.content.filter(block => block.type !== 'reasoning') })
    const eventId = String(event.seq), ref = `ticket/${ticketId}/event/${eventId}`
    const rows = this.store.get(journalKey(ticketId)) ?? []
    if (rows.some(item => item.eventId === eventId)) return
    const assignmentId = call?.assignmentId ?? this.store.get(turnKey(ticketId, event.data.turn))?.assignmentId ?? assignment?.id
    rows.push({ eventId, ref, kind: 'execution', at: new Date(event.time).toISOString(), assignmentId, turn: event.data.turn,
      text: watchdogText(body, 8000), coverage: body.length > 8000 ? 'partial' : 'complete' })
    this.store.set(journalKey(ticketId), rows.slice(-48))
  }
  read(ticketId: string): VerificationEvidence[] {
    const assignment = this.store.tickets.get(ticketId)?.assignments.at(-1)
    return (this.store.get(journalKey(ticketId)) ?? []).filter(item => item.assignmentId === assignment?.id && !!assignment)
      .slice(-16).map(({ eventId: _id, at, assignmentId, turn, ...item }) => ({ ...item,
        text: JSON.stringify({ at, assignmentId, turn, result: item.text }) }))
  }
  snapshot(ticketId: string): WatchdogExecutionEvidence[] {
    return (this.store.get(journalKey(ticketId)) ?? []).slice(-12).map(item => ({ id: item.ref,
      at: item.at, kind: 'tool', state: 'observed', ref: item.ref, summary: item.text.slice(0, 1000) }))
  }
}
