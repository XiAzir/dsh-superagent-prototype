/** Shared base class and configuration for Engine domain parts. */
import { UserError } from './errors.ts'
import { followupOwners, reached, threadKey } from './model.ts'
import type { Thread, ThreadRef, Ticket, Trigger } from './model.ts'
import type { Assessor, AssessmentOutcome, DomainEvent, DomainEvents, Executor, Outbox, Policy, Repositories, SourceScope } from './ports.ts'
import { bindRequest, releaseRequest, requestRoutingEnabled } from './requests.ts'

export interface EngineOptions {
  repo: Repositories
  policy: () => Policy
  /** Decides whether a Source listens to a trigger; one it does not listen to is stored with a `filtered` disposition. */
  scope: SourceScope
  assessor: Assessor
  executor: Executor
  outbox: Outbox
  prepareTicket?: (ticket: Ticket, outcome: Extract<AssessmentOutcome, { kind: 'accept' }>) => Ticket
  now?: () => string
  /** Optional deployment switch; a disabled scheduler retains checks for a later explicit re-enable. */
  followupsEnabled?: () => boolean
  /** Trial-deliver Router attachments across new threads before a Worker confirms their ownership. */
  provisionalRouting?: boolean | (() => boolean)
  emit?: (event: DomainEvent) => void
}

/**
 * Base class for Intake, Evals, Tickets, Assignments, and Replies providing shared access to repositories, policy, clock, and event emission.
 * Each subclass mutates its own domain aggregates and delegates cross-aggregate changes to sibling parts within the transaction opened by Engine.
 */
export abstract class EnginePart {
  protected readonly repo: Repositories
  constructor(protected readonly options: EngineOptions) { this.repo = options.repo }
  protected now(): string { return this.options.now?.() ?? new Date().toISOString() }
  protected policy(): Policy { return this.options.policy() }
  /** The tickets whose worker decides a person's follow-up: see `followupOwners`. */
  protected owners(trigger: Trigger): string[] { return followupOwners(trigger, this.repo) }
  /** Refuse a main-Session routing of a follow-up a ticket's worker still decides. */
  protected leftToWorkers(trigger: Trigger): void {
    const owners = this.owners(trigger)
    if (owners.length) throw new UserError('workerDecides', { tickets: owners.join(', ') })
  }
  /**
   * Record that a ticket's worker hands back a Trigger that reached the ticket, with why, and queue it for Eval when the
   * ticket decided it and no other ticket still does. One the ticket did not decide, such as a bot's, one a person sent to
   * Eval or one on a Thread it follows for context, went to Eval without it.
   * @returns whether it was queued.
   */
  protected handBack(ticketId: string, trigger: Trigger, reason: string): boolean {
    const decided = this.owners(trigger).includes(ticketId)
    const disposition = this.repo.triggers.disposition(trigger.id) ?? { fanout: [], at: this.now() }
    const handbacks = [...disposition.handbacks ?? [], { ticketId, reason, at: this.now() }]
    this.repo.triggers.saveDisposition(trigger.id, { ...disposition, handbacks })
    if (requestRoutingEnabled(this.options)) {
      const ticket = this.require(ticketId)
      releaseRequest(this.options, ticket, trigger.id, reason)
      this.repo.tickets.save(ticket)
    }
    return decided && !this.owners(trigger).length && this.queueForEval(trigger)
  }
  /** Record that a ticket's worker took a person's message up as within the ticket, by acknowledging or answering it. */
  protected takeUp(ticketId: string, triggerId: string): void {
    if (requestRoutingEnabled(this.options)) {
      const ticket = this.require(ticketId), trigger = this.repo.triggers.get(triggerId)
      if (trigger && ticket.requests?.some(item => item.triggerId === triggerId && item.state === 'proposed')) {
        const policy = this.policy(), thread = this.thread(trigger.threads[0]!)
        if (ticket.ended || ticket.hold || policy.paused || !policy.revalidate(ticket.mandate)
          || !this.options.scope.scope(trigger).listened || !policy.gate(trigger, thread, [ticket]).admissible
          || trigger.source === 'qq' && !!trigger.meta.observation && !policy.observedRouting)
          throw new UserError('notAdmissible', { reason: 'Original request authority changed before internal confirmation' })
        bindRequest(this.options, ticket, trigger, false)
        for (const input of ticket.inputs) if (input.kind === 'trigger' && input.triggerId === triggerId) delete input.provisional
        for (const ref of trigger.threads) {
          const thread = this.thread(ref)
          if (!thread.subscriptions.includes(ticket.id)) {
            thread.subscriptions.push(ticket.id); this.repo.threads.save(thread)
            this.emit('thread.subscribed', { threadKey: thread.key, ticketId })
          }
        }
        this.repo.tickets.save(ticket)
      }
    }
    const disposition = this.repo.triggers.disposition(triggerId)
    if (disposition && !disposition.acked?.includes(ticketId)) {
      this.repo.triggers.saveDisposition(triggerId, { ...disposition, acked: [...disposition.acked ?? [], ticketId] })
    }
  }
  /** Queue a Trigger on its primary Thread for the next Eval, unless it waits there already or an Eval holds it. */
  protected queueForEval(trigger: Trigger): boolean {
    const primary = this.thread(trigger.threads[0]!)
    if (primary.pending.includes(trigger.id) || primary.evaluating?.triggerIds.includes(trigger.id)) return false
    primary.pending.push(trigger.id)
    this.repo.threads.save(primary)
    return true
  }
  protected emit<K extends keyof DomainEvents>(type: K, data: DomainEvents[K]): void {
    this.options.emit?.({ type, at: this.now(), data } as DomainEvent)
  }
  protected require(ticketId: string): Ticket { const ticket = this.repo.tickets.get(ticketId); if (!ticket) throw new UserError('unknownTicket'); return ticket }
  /** Returns the stored Thread or an unsaved empty Thread aggregate. */
  protected thread(ref: ThreadRef): Thread {
    const k = threadKey(ref)
    return this.repo.threads.get(k) ?? { key: k, ref: { source: ref.source, id: ref.id }, createdAt: this.now(), subscriptions: [], correlated: [], pending: [], meta: {} }
  }
  protected ticketsOnThread(thread: Thread): Ticket[] {
    return thread.subscriptions.flatMap(id => { const ticket = this.repo.tickets.get(id); return ticket ? [ticket] : [] })
  }
  protected source(ticket: Ticket): Trigger | undefined { return this.repo.triggers.get(ticket.origin.triggerId) }
  protected reaches(ticket: Ticket, trigger: Trigger, context = true): boolean {
    return reached(ticket, trigger, k => this.repo.threads.get(k), context)
  }
}
