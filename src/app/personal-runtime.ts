/** Connect personal reminders and exact-request actions to the existing durable Outbox. */
import { z } from 'zod'
import { key, type ChannelRef, type OutboundMessage } from '../core/index.ts'
import type { Store } from './store.ts'
import type { Outbox } from './outbox.ts'
import type { PersonalCoordinator } from './personal-coordinator.ts'
import { PersonalAttentionService } from './personal-attention.ts'
import { PersonalActionsService, type ActionAdapter } from './personal-actions.ts'

export class PersonalRuntime {
  private readonly running = new Map<string, Promise<unknown>>()
  readonly attention: PersonalAttentionService
  readonly actions: PersonalActionsService
  constructor(private readonly host: { store: Store; coordinator: PersonalCoordinator; outbox: Outbox; paused(): boolean }) {
    this.attention = new PersonalAttentionService({ store: host.store })
    const payload = z.object({ text: z.string().trim().min(1).max(4000) }).strict()
    const adapter: ActionAdapter = {
      execute: action => {
        host.coordinator.ownerTicket(action.ticketId)
        if (host.paused()) throw new Error('任务处理已暂停。')
        const ticket = host.store.tickets.get(action.ticketId)!
        const channel = ticket.channels.find(item => `${item.source}:${item.thread}` === action.target)
        if (!channel) throw new Error('行动目标须是此工单已授权的渠道。')
        host.outbox.send({ id: `personal-action:${action.id}`, ticketId: ticket.id, kind: 'reply', channel, text: payload.parse(action.payload).text })
        return { receiptId: `personal-action:${action.id}` }
      },
      verify: action => {
        const receipt = host.store.receipts.get(`personal-action:${action.id}`)
        if (receipt?.status === 'sent') return { state: 'executed', result: { receiptId: receipt.id, channel: receipt.channel } }
        if (receipt?.status === 'dropped') return { state: 'unknown', reason: '投递已终止，请核实渠道记录。' }
        if (receipt) return { state: 'unknown', reason: '消息仍在持久投递队列中。' }
        return { state: 'not_executed' }
      },
    }
    this.actions = new PersonalActionsService({ store: host.store, adapters: { ticket_reply: adapter } })
  }
  private ownerChannel(ticketId: string, allowEnded = false): ChannelRef | undefined {
    try {
      const ticket = this.host.store.tickets.get(ticketId)
      if (!ticket || (ticket.ended && !allowEnded)) return
      return this.host.coordinator.ownerTrigger(ticket.origin.triggerId).channel
    } catch { return }
  }
  /** Runs immediately before sending, so a pending receipt never relies on an earlier pass's grant. */
  maySend(message: OutboundMessage): boolean {
    if (message.id.startsWith('personal-action:')) {
      if (!this.host.coordinator.enabled() || !message.ticketId) return false
      try {
        this.host.coordinator.ownerTicket(message.ticketId)
        const result = this.actions.check(message.id.slice('personal-action:'.length))
        const payload = result.action.payload as { text?: unknown }
        return result.allowed && result.action.target === `${message.channel.source}:${message.channel.thread}` && payload.text === message.text
      } catch { return false }
    }
    if (message.id.startsWith('personal-attention:')) {
      if (!this.host.coordinator.enabled()) return false
      return this.attention.collectDue().some(delivery => delivery.items.some(item => {
        if (!item.ticketId) return false
        const channel = this.ownerChannel(item.ticketId, !!item.commitmentId)
        return channel && message.id === `personal-attention:${key(delivery.deliveryId, JSON.stringify(channel))}`
      }))
    }
    return true
  }
  /** Synchronous state transitions share the Engine pass; effects send only after commit. */
  tick(): void {
    const { store, coordinator, outbox } = this.host
    for (const receipt of store.receipts.waiting()) if (receipt.id.startsWith('personal-action:')) {
      const action = store.personal.get('action', receipt.id.slice('personal-action:'.length))
      if (!coordinator.enabled() || (action && !this.actions.check(action.id).allowed)) outbox.withdraw(receipt.id)
    }
    if (!coordinator.enabled() || this.host.paused()) {
      for (const receipt of store.receipts.waiting()) if (receipt.id.startsWith('personal-attention:')) outbox.withdraw(receipt.id)
      return
    }
    coordinator.evaluateDue((item, id) => { this.attention.queue(item, id) })
    for (const action of coordinator.all('action')) {
      if (action.action !== 'ticket_reply' || action.status === 'verified') continue
      const receipt = store.receipts.get(`personal-action:${action.id}`)
      if (receipt?.status === 'sent') store.personal.save('action', { ...action, status: 'verified',
        result: { receiptId: receipt.id }, verifiedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, action.revision)
      else if (action.status === 'prepared' && this.actions.check(action.id).allowed && !this.running.has(action.id)) {
        const run = this.actions.execute(action.id).catch(() => { /* The action ledger retains failure or uncertainty for inspection. */ })
          .finally(() => { this.running.delete(action.id) })
        this.running.set(action.id, run)
      }
    }
    for (const item of coordinator.all('attention')) {
      if (item.status !== 'queued' || !item.ticketId) continue
      const ticket = store.tickets.get(item.ticketId)
      if (!ticket || ticket.ended) this.attention.resolve({ ticketId: item.ticketId })
    }
    const valid = new Set<string>()
    for (const delivery of this.attention.collectDue()) {
      const channels = new Map<string, { channel: ChannelRef; ticketId: string }>()
      for (const item of delivery.items) {
        if (!item.ticketId) continue
        const channel = this.ownerChannel(item.ticketId, !!item.commitmentId)
        if (channel) channels.set(JSON.stringify(channel), { channel, ticketId: item.ticketId })
      }
      if (!channels.size) continue // Available in the authenticated attention inbox until acknowledged.
      const receipts = [...channels.values()].map(({ channel, ticketId }) => ({
        id: `personal-attention:${key(delivery.deliveryId, JSON.stringify(channel))}`, channel, ticketId,
      }))
      store.atomic(() => {
        for (const message of receipts) {
          valid.add(message.id)
          outbox.send({ ...message, kind: 'notice', text: delivery.text })
        }
        if (receipts.every(message => outbox.status(message.id) === 'sent')) this.attention.markSent(delivery)
      })
    }
    for (const receipt of store.receipts.waiting()) {
      if (receipt.id.startsWith('personal-attention:') && !valid.has(receipt.id)) outbox.withdraw(receipt.id)
      if (receipt.id.startsWith('personal-action:')) {
        const action = store.personal.get('action', receipt.id.slice('personal-action:'.length))
        if (action && !this.actions.check(action.id).allowed) outbox.withdraw(receipt.id)
      }
    }
  }
  async drain(): Promise<void> { await Promise.allSettled(this.running.values()) }
}
