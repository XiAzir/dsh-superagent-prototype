import { afterEach, expect, it } from 'vitest'
import type { Ticket, Trigger } from '../src/core/index.ts'
import { feishuChannel } from '../src/sources/feishu-trigger.ts'
import { PersonalAttentionService } from '../src/app/personal-attention.ts'
import { workerSessionId } from '../src/executor/dsh.ts'
import { startRuntime, MEMBER, type Host } from './fixtures/host.ts'

let host: Host | undefined
afterEach(async () => { if (host) await host.stop(); host = undefined })
const at = '2026-11-05T09:00:00.000Z'

function ownerTicket(id: string, groupWorkChannel = false): { trigger: Trigger; ticket: Ticket } {
  const trigger: Trigger = { id: `owner-trigger-${id}`, source: 'feishu', threads: [{ source: 'feishu', id: `oc_owner:${id}` }],
    actor: { source: 'feishu', id: MEMBER }, human: true, addressed: 'direct', at, text: '请帮我跟进',
    channel: feishuChannel('oc_owner', id, true), meta: { chatId: 'oc_owner', messageId: id, direct: true } }
  const workChannel = groupWorkChannel ? feishuChannel('oc_team', `group-${id}`) : trigger.channel!
  const ticket: Ticket = { id, title: `Owner ticket ${id}`, decisionId: `decision-${id}`, mandate: { strength: 'explicit', policyVersion: 'v1',
    basis: { via: 'listed', addressed: 'direct' }, actor: trigger.actor, scope: 'personal' }, channels: [workChannel], assignments: [], inputs: [], undelivered: [],
    createdAt: at, updatedAt: at, origin: { triggerId: trigger.id, triggerIds: [trigger.id] } }
  return { trigger, ticket }
}

async function setup(ticketId = 'owner-1', groupWorkChannel = false) {
  host = await startRuntime()
  host.runtime.machine.mode = 'personal'
  const { trigger, ticket } = ownerTicket(ticketId, groupWorkChannel)
  host.runtime.store.triggers.save(trigger)
  host.runtime.store.tickets.save(ticket)
  const current = host.runtime.store.personal.settings()
  host.runtime.store.personal.configure({ ...current, enabled: true, ownerActors: ['feishu:ou_alice'], timezone: 'UTC', quietStart: '00:00', quietEnd: '00:00' }, current.revision)
  return { host, trigger, ticket }
}

it('evaluates a due commitment once, delivers through Outbox to the private owner channel, then marks sent', async () => {
  const { host, ticket } = await setup('due-owner', true)
  const workerId = workerSessionId(ticket.id)
  await host.runtime.sessions.ensure(workerId, host.directory, ticket.title, 'worker')
  expect(host.tools.get(workerId)?.has('orchestrator_personal_action')).toBe(true)

  host.runtime.personal.write('commitment', { id: 'due-commitment', revision: 0, value: { title: 'Review the quote', dueAt: '2026-11-04T00:00:00Z',
    nextCheckAt: '2026-11-04T00:00:00Z', ticketIds: [ticket.id] } })
  host.runtime.personalRuntime.tick()
  const queued = host.runtime.store.personal.list('attention', { status: 'queued' })
  expect(queued).toHaveLength(1)
  const receipt = host.runtime.store.receipts.waiting().find(item => item.id.startsWith('personal-attention:'))!
  expect(receipt.channel.address.chatId).toBe('oc_owner')
  expect(receipt.channel).not.toEqual(ticket.channels[0])
  expect(receipt.channel.address.direct).toBe('true')
  await host.runtime.outbox.sent(receipt.id)
  expect(host.runtime.store.receipts.get(receipt.id)?.status).toBe('sent')

  host.runtime.personalRuntime.tick()
  expect(host.runtime.store.personal.get('attention', queued[0]!.id)?.status).toBe('sent')
  host.runtime.personalRuntime.tick()
  expect(host.runtime.store.personal.list('attention')).toHaveLength(1)
  expect(host.runtime.store.receipts.waiting().filter(item => item.id.startsWith('personal-attention:'))).toHaveLength(0)
})

it('prepares an exact worker reply, grants only through the owner HTTP route, and reconciles a lost response after delivery', async () => {
  const { host, ticket } = await setup('reply-owner')
  const workerId = workerSessionId(ticket.id)
  const worker = await host.runtime.sessions.ensure(workerId, host.directory, ticket.title, 'worker')
  const tool = host.tools.get(workerId)?.get('orchestrator_personal_action')
  expect(tool).toBeDefined()
  const prepared = await tool!.execute({ operation: 'prepare', request_id: 'reply-1', target: `feishu:${ticket.channels[0]!.thread}`, text: '报价已经确认。' },
    { signal: new AbortController().signal }) as { action: { id: string; authorizationId: string; requestHash: string; revision: number } }
  const action = prepared.action
  expect(worker.id).toBe(workerId)
  expect(host.runtime.store.personal.get('authorization', action.authorizationId)?.status).toBe('requested')
  expect((await host.api('POST', `personal/authorizations/${action.authorizationId}/grant`, { revision: 1, requestHash: action.requestHash })).status).toBe(200)

  // The caller drops the first response. Repeating execute after delivery must replay the same durable result.
  await host.api('POST', `personal/actions/${action.id}/execute`)
  const receiptId = `personal-action:${action.id}`
  const firstReceipt = host.runtime.store.receipts.get(receiptId)!
  expect(firstReceipt.status).toBe('sent')
  await host.api('POST', `personal/actions/${action.id}/execute`)
  expect(host.runtime.store.receipts.get(receiptId)?.id).toBe(firstReceipt.id)
  host.runtime.personalRuntime.tick()
  expect(host.runtime.store.personal.get('action', action.id)).toMatchObject({ status: 'verified', result: { receiptId } })
})

it('rejects an expired queued action at Outbox send time before the next personal runtime tick', async () => {
  const { host, ticket } = await setup('expired-action')
  const action = host.runtime.personalRuntime.actions.prepare(ticket.id, { idempotencyKey: 'expires-during-outage', action: 'ticket_reply',
    target: `feishu:${ticket.channels[0]!.thread}`, payload: { text: 'This expired reply must not go out.' }, scope: ['ticket:reply'], risk: 'L3' })
  const requested = host.runtime.store.personal.get('authorization', action.authorizationId!)!
  const granted = host.runtime.personalRuntime.actions.grant(requested.id, { expectedRevision: requested.revision,
    requestHash: action.requestHash, grantedBy: 'owner' })
  const expired = host.runtime.store.personal.save('authorization', { ...granted, expiresAt: '2026-11-04T00:00:00.000Z', updatedAt: at }, granted.revision)

  const request = await host.api('GET', `personal/authorizations/${expired.id}/request`)
  expect(request.status).toBe(200)
  expect(request.body.action).toMatchObject({ id: action.id, payload: { text: 'This expired reply must not go out.' }, requestHash: action.requestHash })

  const receiptId = `personal-action:${action.id}`
  host.runtime.outbox.send({ id: receiptId, ticketId: ticket.id, kind: 'reply', channel: ticket.channels[0]!, text: 'This expired reply must not go out.' })
  await host.runtime.outbox.sent(receiptId)
  expect(host.runtime.store.receipts.get(receiptId)?.status).not.toBe('sent')
  expect(host.runtime.store.personal.get('authorization', expired.id)?.status).toBe('granted')
})

it('keeps an open commitment reminder linked to an ended ticket and sends it to the original private owner channel', async () => {
  const { host, ticket } = await setup('ended-ticket-reminder', true)
  const commitment = host.runtime.personal.write('commitment', { id: 'still-open-after-stop', revision: 0,
    value: { title: 'Confirm the pending quote', dueAt: '2026-11-04T00:00:00Z', nextCheckAt: '2026-11-04T00:00:00Z', ticketIds: [ticket.id] } })
  host.runtime.store.tickets.save({ ...ticket, ended: { at, by: 'human', outcome: 'stopped' } })

  host.runtime.personalRuntime.tick()
  const attention = host.runtime.store.personal.list('attention').find(item => item.commitmentId === commitment.id)
  expect(attention).toBeDefined()
  expect(attention?.status).not.toBe('resolved')
  const receipt = host.runtime.store.receipts.waiting().find(item => item.id.startsWith('personal-attention:'))
  expect(receipt).toBeDefined()
  expect(receipt?.channel.address.chatId).toBe('oc_owner')
  expect(receipt?.channel.address.direct).toBe('true')
})

it('withdraws pending attention and action messages when a ticket stops, authorization is revoked, or the feature is disabled', async () => {
  const { host, ticket } = await setup('cancel-owner')
  const action = host.runtime.personalRuntime.actions.prepare(ticket.id, { idempotencyKey: 'cancel-action', action: 'ticket_reply',
    target: `feishu:${ticket.channels[0]!.thread}`, payload: { text: 'cancel me' }, scope: ['ticket:reply'], risk: 'L3' })
  const authorization = host.runtime.store.personal.get('authorization', action.authorizationId!)!
  host.runtime.personalRuntime.actions.grant(authorization.id, { expectedRevision: authorization.revision, requestHash: action.requestHash, grantedBy: 'owner' })
  host.runtime.personalRuntime.actions.revoke(authorization.id, { expectedRevision: authorization.revision + 1, requestHash: action.requestHash })
  const actionReceiptId = `personal-action:${action.id}`
  host.runtime.store.receipts.add({ id: actionReceiptId, ticketId: ticket.id, kind: 'reply', channel: ticket.channels[0]!, text: 'cancel me' })

  const attention = host.runtime.personalRuntime.attention.queue({ title: 'Due notice', summary: 'cancel me', priority: 'P0', digestKey: 'stop', ticketId: ticket.id }, 'cancel-attention')
  const noticeReceiptId = 'personal-attention:cancel-notice'
  host.runtime.store.receipts.add({ id: noticeReceiptId, ticketId: ticket.id, kind: 'notice', channel: ticket.channels[0]!, text: 'cancel me' })
  host.runtime.store.tickets.save({ ...ticket, ended: { at, by: 'executor', reason: 'completed', outcome: 'completed' } })
  host.runtime.personalRuntime.tick()
  expect(host.runtime.store.receipts.get(actionReceiptId)?.status).toBe('dropped')
  expect(host.runtime.store.receipts.get(noticeReceiptId)?.status).toBe('dropped')
  expect(host.runtime.store.personal.get('attention', attention.id)?.status).toBe('resolved')

  const stillPending = host.runtime.personalRuntime.attention.queue({ title: 'Disable notice', summary: 'cancel me', priority: 'P0', digestKey: 'disabled' }, 'disabled-attention')
  host.runtime.store.receipts.add({ id: 'personal-attention:disabled-notice', kind: 'notice', channel: ticket.channels[0]!, text: 'cancel me' })
  host.runtime.store.personal.configure({ ...host.runtime.store.personal.settings(), enabled: false }, host.runtime.store.personal.settings().revision)
  host.runtime.personalRuntime.tick()
  expect(host.runtime.personalRuntime.attention.collectDue()).toEqual([])
  expect(host.runtime.store.personal.get('attention', stillPending.id)?.status).toBe('queued')
  expect(host.runtime.store.receipts.get('personal-attention:disabled-notice')?.status).toBe('dropped')
})

it('keeps request side effects in durable state when a response is lost and marks delivery snapshots using canonical IDs', async () => {
  const { host } = await setup('snapshot-owner')
  let now = new Date(at)
  const service = new PersonalAttentionService({ store: host.runtime.store, now: () => now })
  const one = service.queue({ title: 'Older', summary: 'one', priority: 'P1', digestKey: 'batch' }, 'snapshot-one')
  now = new Date('2026-11-05T10:00:00.000Z')
  const two = service.queue({ title: 'Newer', summary: 'two', priority: 'P1', digestKey: 'batch' }, 'snapshot-two')
  const sorted = [one, two].sort((a, b) => a.id.localeCompare(b.id))
  const first = sorted[0]!, second = sorted[1]!
  host.runtime.store.personal.save('attention', { ...first, createdAt: '2026-11-05T11:00:00.000Z' }, first.revision)
  host.runtime.store.personal.save('attention', { ...second, createdAt: '2026-11-05T08:00:00.000Z' }, second.revision)
  const delivery = service.collectDue()[0]!
  expect(delivery.items[0]?.id).toBe(second.id)
  expect(service.markSent(delivery).map(item => item.status)).toEqual(['sent', 'sent'])
})
