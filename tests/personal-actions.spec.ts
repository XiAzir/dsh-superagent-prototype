import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { ActionAuthorizationError, ActionConflict, PersonalActionsService } from '../src/app/personal-actions.ts'
import { Store } from '../src/app/store.ts'

let directory: string
let store: Store
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'personal-actions-')); store = new Store(join(directory, 'data.sqlite')) })
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
const at = '2026-11-05T12:00:00.000Z'
function ticket(id = 'ticket-1') {
  store.tickets.save({ id, title: id, decisionId: 'decision-1', channels: [], undelivered: [], createdAt: at, updatedAt: at,
    mandate: { strength: 'explicit', policyVersion: 'v1', basis: { via: 'listed' }, actor: { source: 'web', id: 'owner' }, scope: '' },
    origin: { triggerId: 'trigger-1', triggerIds: ['trigger-1'] }, assignments: [], inputs: [] })
}

it('binds idempotency, authorization, and adapter execution to the exact canonical request', async () => {
  ticket()
  let effectCount = 0
  const service = new PersonalActionsService({ store, now: () => new Date(at), adapters: {
    ticket_reply: { execute: () => { effectCount++; return { messageId: 'sent-1' } }, verify: () => ({ state: 'executed', result: { messageId: 'sent-1' } }) },
  } })
  const input = { idempotencyKey: 'idem-1', action: 'ticket_reply', target: 'thread-1', payload: { text: 'hello', meta: { b: 2, a: 1 } },
    scope: ['ticket:reply'], risk: 'L3' as const }
  const prepared = service.prepare('ticket-1', input)
  expect(service.prepare('ticket-1', { ...input, payload: { meta: { a: 1, b: 2 }, text: 'hello' } }).id).toBe(prepared.id)
  expect(() => service.prepare('ticket-1', { ...input, payload: { text: 'different' } })).toThrow(ActionConflict)
  const authorization = store.personal.get('authorization', prepared.authorizationId!)!
  const sibling = service.prepare('ticket-1', { ...input, idempotencyKey: 'idem-sibling', target: 'thread-2' })
  expect(sibling.authorizationId).not.toBe(prepared.authorizationId)
  expect(sibling.requestHash).not.toBe(prepared.requestHash)
  expect(() => service.grant(authorization.id, { expectedRevision: authorization.revision, requestHash: sibling.requestHash, grantedBy: 'owner' }))
    .toThrow(ActionAuthorizationError)
  service.grant(authorization.id, { expectedRevision: authorization.revision, requestHash: prepared.requestHash, grantedBy: 'owner' })
  expect(service.check(prepared.id).allowed).toBe(true)
  const executed = await service.execute(prepared.id)
  expect(executed.status).toBe('verified')
  expect(executed.result).toEqual({ messageId: 'sent-1' })
  expect(effectCount).toBe(1)
})

it('verifies an interrupted executing record before retrying and stops after revocation', async () => {
  ticket()
  let effectCount = 0, verified = false
  const service = new PersonalActionsService({ store, now: () => new Date(at), adapters: {
    ticket_reply: {
      execute: () => { effectCount++; verified = true; return { okay: true } },
      verify: () => verified ? { state: 'executed', result: { okay: true } } : { state: 'not_executed' },
    },
  } })
  const prepared = service.prepare('ticket-1', { idempotencyKey: 'idem-2', action: 'ticket_reply', target: 'thread-1', payload: { text: 'hi' }, scope: ['reply'], risk: 'L3' })
  const auth = store.personal.get('authorization', prepared.authorizationId!)!
  service.grant(auth.id, { expectedRevision: auth.revision, requestHash: prepared.requestHash, grantedBy: 'owner' })
  const current = store.personal.get('action', prepared.id)!
  store.personal.save('action', { ...current, status: 'executing', updatedAt: at }, current.revision)
  expect((await service.execute(prepared.id)).status).toBe('verified')
  expect(effectCount).toBe(1)

  const second = service.prepare('ticket-1', { idempotencyKey: 'idem-3', action: 'ticket_reply', target: 'thread-2', payload: { text: 'later' }, scope: ['reply'], risk: 'L3' })
  const secondAuth = store.personal.get('authorization', second.authorizationId!)!
  service.grant(secondAuth.id, { expectedRevision: secondAuth.revision, requestHash: second.requestHash, grantedBy: 'owner' })
  service.revoke(secondAuth.id, { expectedRevision: secondAuth.revision + 1, requestHash: second.requestHash })
  await expect(service.execute(second.id)).rejects.toThrow('authorization_revoked')
  expect(effectCount).toBe(1)
})

it('serializes concurrent execution and reconciles an uncertain result after service restart', async () => {
  ticket()
  let effects = 0, verifications = 0, complete = false
  const adapter = {
    execute: async () => { effects++; complete = true; return { messageId: 'reply-3' } },
    verify: () => {
      verifications++
      if (verifications === 1) return { state: 'unknown' as const, reason: 'remote read is temporarily unavailable' }
      return complete ? { state: 'executed' as const, result: { messageId: 'reply-3' } }
        : { state: 'unknown' as const, reason: 'remote read is temporarily unavailable' }
    },
  }
  const create = () => new PersonalActionsService({ store, now: () => new Date(at), adapters: { ticket_reply: adapter } })
  const firstService = create()
  const prepared = firstService.prepare('ticket-1', { idempotencyKey: 'idem-4', action: 'ticket_reply', target: 'thread-3', payload: { text: 'one' },
    scope: ['reply'], risk: 'L3' })
  const auth = store.personal.get('authorization', prepared.authorizationId!)!
  firstService.grant(auth.id, { expectedRevision: auth.revision, requestHash: prepared.requestHash, grantedBy: 'owner' })
  const [left, right] = await Promise.all([firstService.execute(prepared.id), firstService.execute(prepared.id)])
  expect(left.id).toBe(right.id)
  expect(left.status).toBe('uncertain')
  expect(effects).toBe(1)

  const restartedService = create()
  const recovered = await restartedService.execute(prepared.id)
  expect(recovered.status).toBe('verified')
  expect(recovered.result).toEqual({ messageId: 'reply-3' })
  expect(effects).toBe(1)
  expect(verifications).toBe(2)
})

it('rejects expired grants, hash-tampered requests, and tickets stopped after preparation', async () => {
  ticket()
  let now = new Date(at), executions = 0
  const service = new PersonalActionsService({ store, now: () => now, adapters: {
    ticket_reply: { execute: () => { executions++; return { sent: true } }, verify: () => ({ state: 'not_executed' }) },
  } })
  const expired = service.prepare('ticket-1', { idempotencyKey: 'expired', action: 'ticket_reply', target: 'thread', payload: { text: 'x' },
    scope: ['reply'], risk: 'L3', expiresAt: '2026-11-05T12:00:01.000Z' })
  const expiredAuth = store.personal.get('authorization', expired.authorizationId!)!
  service.grant(expiredAuth.id, { expectedRevision: expiredAuth.revision, requestHash: expired.requestHash, grantedBy: 'owner' })
  now = new Date('2026-11-05T12:00:02.000Z')
  expect(service.check(expired.id)).toMatchObject({ allowed: false, reason: 'authorization_expired' })
  await expect(service.execute(expired.id)).rejects.toThrow('authorization_expired')

  now = new Date(at)
  const tampered = service.prepare('ticket-1', { idempotencyKey: 'tampered', action: 'ticket_reply', target: 'thread', payload: { text: 'original' },
    scope: ['reply'], risk: 'L3' })
  const auth = store.personal.get('authorization', tampered.authorizationId!)!
  service.grant(auth.id, { expectedRevision: auth.revision, requestHash: tampered.requestHash, grantedBy: 'owner' })
  const current = store.personal.get('action', tampered.id)!
  store.personal.save('action', { ...current, payload: { text: 'changed' }, updatedAt: at }, current.revision)
  expect(service.check(tampered.id)).toMatchObject({ allowed: false, reason: 'action_request_tampered' })
  await expect(service.execute(tampered.id)).rejects.toThrow('action_request_tampered')

  const stopped = service.prepare('ticket-1', { idempotencyKey: 'stopped', action: 'ticket_reply', target: 'thread', payload: {}, scope: ['reply'], risk: 'L3' })
  const stoppedAuth = store.personal.get('authorization', stopped.authorizationId!)!
  service.grant(stoppedAuth.id, { expectedRevision: stoppedAuth.revision, requestHash: stopped.requestHash, grantedBy: 'owner' })
  store.tickets.save({ ...store.tickets.get('ticket-1')!, ended: { at, by: 'executor', reason: 'done', outcome: 'completed' } })
  await expect(service.execute(stopped.id)).rejects.toThrow('ticket_stopped')
  expect(executions).toBe(0)
})

it('keeps uncertain when recovery verification throws and retries only after a clear not-executed result', async () => {
  ticket()
  let verifyMode: 'throw' | 'not_executed' | 'executed' = 'throw', effects = 0
  const adapter = {
    execute: () => { effects++; return { sent: true } },
    verify: () => {
      if (verifyMode === 'throw') throw new Error('temporary read failure')
      if (verifyMode === 'not_executed') return { state: 'not_executed' as const }
      return { state: 'executed' as const, result: { sent: true } }
    },
  }
  const service = new PersonalActionsService({ store, now: () => new Date(at), adapters: { ticket_reply: adapter } })
  const prepared = service.prepare('ticket-1', { idempotencyKey: 'recover', action: 'ticket_reply', target: 'thread', payload: { text: 'hi' }, scope: ['reply'], risk: 'L3' })
  const auth = store.personal.get('authorization', prepared.authorizationId!)!
  service.grant(auth.id, { expectedRevision: auth.revision, requestHash: prepared.requestHash, grantedBy: 'owner' })
  const row = store.personal.get('action', prepared.id)!
  store.personal.save('action', { ...row, status: 'executing', updatedAt: at }, row.revision)

  expect((await service.execute(prepared.id)).status).toBe('uncertain')
  expect(effects).toBe(0)
  verifyMode = 'not_executed'
  expect((await service.execute(prepared.id)).status).toBe('failed')
  expect(effects).toBe(0)
  expect((await service.execute(prepared.id)).status).toBe('failed')
  expect(effects).toBe(1)
  verifyMode = 'executed'
  expect((await service.execute(prepared.id)).status).toBe('verified')
  expect(effects).toBe(1)
})

it('rejects prototype adapter names and refuses preparation for stopped tickets', () => {
  ticket()
  const service = new PersonalActionsService({ store, adapters: {}, now: () => new Date(at) })
  expect(() => service.prepare('ticket-1', { idempotencyKey: 'proto', action: 'toString', target: 'x', payload: {}, scope: ['x'], risk: 'L3' }))
    .toThrow(ActionConflict)
  store.tickets.save({ ...store.tickets.get('ticket-1')!, ended: { at, by: 'executor', reason: 'done', outcome: 'completed' } })
  expect(() => service.prepare('ticket-1', { idempotencyKey: 'ended', action: 'reply', target: 'x', payload: {}, scope: ['x'], risk: 'L3' }))
    .toThrow('missing or stopped')
})
