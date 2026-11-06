/** The Engine's messages to Channels, each by the rule that allows it. */
import { key } from './ids.ts'
import { UserError } from './errors.ts'
import { latestAssignment, latestReport, liveTicket, reached, ticketOutcome } from './model.ts'
import type { ChannelRef, Ticket, TicketOutcome, Trigger } from './model.ts'
import type { ReplyStatus } from './ports.ts'
import { EnginePart } from './part.ts'
import { ticketStage } from './stage.ts'
import { completionApproved, completionKey, currentVerification } from './verification.ts'

/**
 * A message for a Channel, by purpose: an Executor's acknowledgement of a person's request it works on, the answer to a
 * person's question once the worker reported it, the result of a ticket that is `ready`, `completed`, `merged`, or `dropped`,
 * or the ticket's current `question` for a person (`attention`). When `ticketId` is omitted, the ticket that `triggerId` reached is used.
 */
export type ReplyRequest =
  | { purpose: 'acknowledgement'; ticketId: string; triggerId: string; text: string }
  | { purpose: 'status'; ticketId: string; triggerId: string; text: string }
  | { purpose: 'answer' | 'result' | 'attention'; ticketId?: string; triggerId?: string; question?: string; text: string; artifacts?: string[] }
/** A queued message: its id, whether it went out, and whether an earlier request had queued it already. */
export interface Reply { id: string; status: ReplyStatus; reused: boolean; snapshot?: TicketStatusSnapshot }
type StoredReport = NonNullable<Ticket['assignments'][number]['report']>
interface SnapshotReport { state: StoredReport['state']; at: string; summary: string; chars: number; read: string }
/** Read-only facts available to the Router when it replies to a person's status question. */
export interface TicketStatusSnapshot {
  acceptance?: { mode: 'observe' | 'enforce'; revision: number }
  verification?: { state: string; summary: string; read: string }
  hold?: Ticket['hold']
  ticket_id: string
  title: string
  stage: ReturnType<typeof ticketStage>
  updated_at: string
  outcome?: TicketOutcome
  assignment?: {
    id: string
    state: Ticket['assignments'][number]['state']
    started_at?: string
    ended_at?: string
    ended_reason?: string
    idle_at?: string
    report?: SnapshotReport
  }
  latest_report?: SnapshotReport & { assignment_id: string }
  undelivered_inputs: number
  delivery_failure?: { at: string; error: string }
  attention?: { question: string }
}

/**
 * Replies writes the Engine's messages to Channels through the Outbox port: an acknowledgement, the answer to a person's
 * question, a ticket's result, and its question for a person, each only when its rule allows it, under a deterministic id
 * that keeps it from going out twice (idempotent). The Engine routes `reply` here; Tickets asks it for the acknowledgement
 * an accept carries, and Assignments asks it to withdraw a question a report replaced.
 */
export class Replies extends EnginePart {
  /**
   * Queue a message for the Channel its purpose names: an acknowledgement or an answer goes where that person's message was
   * written, attention where the message that raised the question was (or to the ticket's starting conversation), and a
   * result to the conversation where the ticket started (`result` is allowed only for a ticket in `ready`, `completed`,
   * `merged`, or `dropped`). Each message is queued at most once (idempotent). An acknowledgement, even one already queued,
   * records that the ticket's worker took the message up.
   * @throws UserError when the ticket or trigger is unknown or the purpose's rule refuses it, such as a result of a ticket
   * that is not ready, completed, merged, or dropped.
   */
  reply(request: ReplyRequest): Reply {
    return request.purpose === 'acknowledgement' ? this.acknowledge(request)
      : request.purpose === 'status' ? this.status(request) : this.answer(request)
  }
  /**
   * Queue the acknowledgement an accept carries where the message that started the ticket was written, if it has a Channel
   * and a person wrote it.
   */
  acknowledgeAccepted(ticketId: string, trigger: Trigger, text: string): void {
    if (trigger.channel && trigger.human) this.options.outbox.send({ id: key('ack', trigger.id), channel: trigger.channel, text, kind: 'acknowledgement', ticketId })
  }
  /** Withdraw a ticket's question for a person from the outbox, unless it went out already. */
  withdrawAttention(attentionId: string): void { this.options.outbox.withdraw(key('attention-reply', attentionId)) }
  private acknowledge(request: Extract<ReplyRequest, { purpose: 'acknowledgement' }>): Reply {
    const ticket = this.require(request.ticketId)
    if (!liveTicket(ticket)) throw new UserError('ackEnded')
    const trigger = this.repo.triggers.get(request.triggerId)
    if (!trigger) throw new UserError('unknownTrigger')
    // Context-only threads are read-only and cannot receive acknowledgements.
    if (!this.reaches(ticket, trigger, false)) throw new UserError('notReached')
    if (!trigger.channel) throw new UserError('ackNoChannel')
    const id = key('ack', trigger.id)
    const existing = this.options.outbox.status(id)
    if (!existing && !trigger.human) throw new UserError('ackNotPerson')
    // Preserve the automatic or first queued acknowledgement.
    if (!existing) this.options.outbox.send({ id, channel: trigger.channel, text: request.text, kind: 'acknowledgement', ticketId: ticket.id })
    this.takeUp(ticket.id, trigger.id)
    return { id, status: this.options.outbox.status(id) ?? 'pending', reused: existing !== undefined }
  }
  private answer(request: Exclude<ReplyRequest, { purpose: 'acknowledgement' | 'status' }>): Reply {
    const trigger = request.triggerId ? this.repo.triggers.get(request.triggerId) : undefined
    if (request.triggerId && !trigger) throw new UserError('unknownTrigger')
    const assigned = trigger ? this.owners(trigger) : []
    const candidates = trigger && !request.ticketId ? this.repo.tickets.list() : []
    // Router-first messages may share a subscribed thread before any worker receives them.
    const ticket = request.ticketId ? this.require(request.ticketId)
      : trigger && request.purpose === 'answer'
        ? candidates.find(item => item.answers?.includes(trigger.id))
          ?? candidates.find(item => item.origin.triggerId === trigger.id || assigned.includes(item.id))
        : trigger ? candidates.find(item => this.reaches(item, trigger)) : undefined
    if (request.purpose === 'result') {
      const outcome = ticket && ticketOutcome(ticket)
      const reported = !!ticket && liveTicket(ticket) && latestAssignment(ticket)?.report?.state === 'ready'
      const ready = outcome === 'merged' || outcome === 'completed' || outcome === 'dropped' || reported
      if (!ticket || !ready || !completionApproved(ticket)) throw new UserError('notReady')
    }
    const attention = request.purpose === 'attention' ? ticket?.attention : undefined
    // Attention replies must match the ticket's currently open question text.
    if (request.purpose === 'attention' && (!attention || attention.question !== request.question)) throw new UserError('notAttention')
    if (request.purpose === 'answer' && !trigger?.human) throw new UserError('notQuestion')
    const reported = (ticket && latestReport(ticket)?.artifacts) ?? []
    const artifacts = request.artifacts ?? (request.purpose === 'result' ? reported : [])
    if (artifacts.length && (request.purpose !== 'result' || !ticket || artifacts.some(id => !reported.includes(id)))) {
      throw new Error('Choose only artifacts in this ticket\'s ready report for a result reply')
    }
    const proof = request.purpose === 'result' && ticket?.acceptance?.mode === 'enforce' ? completionKey(ticket) : undefined
    const proofId = proof ? [proof] : []
    const id = attention ? key('attention-reply', attention.id) : artifacts.length
      ? key('reply', trigger?.id ?? ticket?.id ?? '', request.text, ...artifacts, ...proofId)
      : key('reply', trigger?.id ?? ticket?.id ?? '', request.text, ...proofId)
    const existing = this.options.outbox.status(id)
    const ready = !ticket || !trigger || ticket.answers?.includes(trigger.id)
    if (request.purpose === 'answer' && !ready && !existing) throw new UserError('noAnswer')
    const asker = attention?.triggerId ? this.repo.triggers.get(attention.triggerId) : undefined
    const channel = request.purpose === 'answer' ? trigger!.channel : asker?.channel ?? (ticket ? this.sourceChannel(ticket) : undefined)
    if (!channel) throw new UserError('noChannel')
    this.options.outbox.send({ id, channel, text: request.text, kind: 'reply', ...ticket ? { ticketId: ticket.id } : {},
      ...ticket?.acceptance ? { purpose: request.purpose as 'answer' | 'result' | 'attention' } : {}, ...proof ? { completionKey: proof } : {},
      ...artifacts.length ? { artifacts } : {} })
    if (request.purpose === 'answer' && ticket && trigger && ticket.answers?.includes(trigger.id)) {
      ticket.answers = ticket.answers.filter(item => item !== trigger.id)
      this.repo.tickets.save(ticket)
    }
    return { id, status: this.options.outbox.status(id) ?? 'pending', reused: existing !== undefined }
  }
  /** Read a saved status for a reached ticket, or the requester's own ticket selected by the Router. No Input or subscription is created. */
  statusSnapshot(ticketId: string, triggerId: string): TicketStatusSnapshot {
    const ticket = this.require(ticketId)
    const trigger = this.repo.triggers.get(triggerId)
    if (!trigger) throw new UserError('unknownTrigger')
    const disposition = this.repo.triggers.disposition(trigger.id)
    const onThread = (disposition?.fanout.includes(ticket.id) || disposition?.matched?.includes(ticket.id)) && !disposition.context?.includes(ticket.id)
      && reached(ticket, trigger, key => this.repo.threads.get(key), false)
    const ownTicket = trigger.routing === 'router' && ticket.mandate.actor.source === trigger.actor.source
      && ticket.mandate.actor.id === trigger.actor.id && !disposition?.context?.includes(ticket.id)
    if (!trigger.human || !trigger.channel || disposition?.filtered || (!onThread && !ownTicket)
      || !this.options.scope.scope(trigger).listened) {
      throw new UserError('notReached')
    }
    const thread = this.thread(trigger.threads[0]!)
    const gate = this.policy().gate(trigger, thread, this.ticketsOnThread(thread))
    if (!gate.admissible) throw new UserError('notAdmissible', { reason: gate.reason })
    const assignment = latestAssignment(ticket)
    const report = assignment?.report
    const reportAssignment = ticket.assignments.findLast(item => item.report)
    const latest = reportAssignment?.report
    const brief = (value: StoredReport, assignmentId: string): SnapshotReport => ({ state: value.state, at: value.at,
      summary: value.summary.slice(0, 600), chars: value.summary.length, read: `ticket/${ticket.id}/report/${assignmentId}` })
    return {
      ticket_id: ticket.id,
      title: ticket.title,
      stage: ticketStage(ticket),
      updated_at: ticket.updatedAt,
      ...ticket.acceptance ? { acceptance: { mode: ticket.acceptance.mode, revision: ticket.acceptance.revision } } : {},
      ...currentVerification(ticket) ? { verification: { state: currentVerification(ticket)!.state,
        summary: currentVerification(ticket)!.summary.slice(0, 600), read: `ticket/${ticket.id}/verification` } } : {},
      ...ticket.hold ? { hold: ticket.hold } : {},
      ...(ticket.ended ? { outcome: ticket.ended.outcome } : {}),
      ...(assignment ? { assignment: { id: assignment.id, state: assignment.state,
        ...(assignment.startedAt ? { started_at: assignment.startedAt } : {}),
        ...(assignment.endedAt ? { ended_at: assignment.endedAt } : {}),
        ...(assignment.endedReason ? { ended_reason: assignment.endedReason } : {}),
        ...(assignment.idleAt ? { idle_at: assignment.idleAt } : {}),
        ...(report ? { report: brief(report, assignment.id) } : {}) } } : {}),
      ...(latest && reportAssignment ? { latest_report: { assignment_id: reportAssignment.id, ...brief(latest, reportAssignment.id) } } : {}),
      undelivered_inputs: ticket.undelivered.length,
      ...(ticket.delivery ? { delivery_failure: { at: ticket.delivery.at, error: ticket.delivery.error } } : {}),
      ...(ticket.attention ? { attention: { question: ticket.attention.question } } : {}),
    }
  }
  /** Queue the requested status using saved evidence, without touching the worker's lifecycle. */
  private status(request: Extract<ReplyRequest, { purpose: 'status' }>): Reply {
    const snapshot = this.statusSnapshot(request.ticketId, request.triggerId)
    const trigger = this.repo.triggers.get(request.triggerId)!
    const id = key('status-reply', trigger.id, request.ticketId)
    const existing = this.options.outbox.status(id)
    this.options.outbox.send({ id, channel: trigger.channel!, text: request.text, kind: 'reply', ticketId: request.ticketId, delivery: 'interactive' })
    return { id, status: this.options.outbox.status(id) ?? 'pending', reused: existing !== undefined, snapshot }
  }
  /** The conversation a ticket started in: its origin Trigger's Channel, else its first Channel. */
  private sourceChannel(ticket: Ticket): ChannelRef | undefined { return this.source(ticket)?.channel ?? ticket.channels[0] }
}
