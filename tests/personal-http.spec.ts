import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { registerHttp, type HttpHost } from '../src/app/http.ts'
import { PersonalActionsService } from '../src/app/personal-actions.ts'
import { PersonalCoordinator } from '../src/app/personal-coordinator.ts'
import { Store } from '../src/app/store.ts'
import { SettingsSchema } from '../src/policy.ts'
import type { Ticket, Trigger } from '../src/core/index.ts'

type Handler = (req: unknown, res: unknown) => Promise<void>
type Headers = Record<string, string | undefined>
let directory: string, store: Store, owner: PersonalCoordinator, actions: PersonalActionsService
let handler: Handler

const at = '2026-11-05T09:00:00.000Z'
function trigger(id: string, actorId = 'alice'): Trigger {
  return { id, source: 'feishu', threads: [{ source: 'feishu', id: 'owner-room' }], actor: { source: 'feishu', id: actorId },
    human: true, addressed: 'direct', at, text: 'Owner request', meta: {} }
}
function ticket(id: string, triggerId: string, ended = false): Ticket {
  return { id, title: id, decisionId: `decision-${id}`, mandate: { strength: 'explicit', policyVersion: 'v1', basis: { via: 'listed' },
    actor: { source: 'feishu', id: 'alice' }, scope: 'personal' }, channels: [], assignments: [], inputs: [], undelivered: [],
    createdAt: at, updatedAt: at, origin: { triggerId, triggerIds: [triggerId] },
    ...(ended ? { ended: { at, by: 'executor' as const, outcome: 'closed' as const } } : {}) }
}
function addTicket(id = 'ticket-owner', actor = 'alice'): Ticket {
  const source = trigger(`trigger-${id}`, actor)
  store.triggers.save(source)
  const item = ticket(id, source.id)
  store.tickets.save(item)
  return item
}
function serve(): (method: string, path: string, body?: unknown, headers?: Headers) => Promise<{ status: number; body: Record<string, unknown> }> {
  const ctx = { webServer: { host: '127.0.0.1', port: 3082, register: (route: { handler: Handler }) => { handler = route.handler; return () => {} } } }
  const runtime = { ready: Promise.resolve(), store, personal: owner, personalRuntime: { actions, tick: () => {} },
    machine: { mode: 'personal', promptMaxChars: { get: () => 100_000 }, admissionContextMaxPages: { get: () => 10 }, admissionContextTimeoutMs: { get: () => 15_000 } },
    requestPass: () => {}, configured: () => true } as unknown as HttpHost
  registerHttp(ctx as never, runtime)
  return async (method, path, body, headers = {}) => {
    let status = 0, output = ''
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
    const requestHeaders = Object.fromEntries(Object.entries({ host: '127.0.0.1:3082', 'x-orchestrator-request': '1', ...headers })
      .filter(([, value]) => value !== undefined))
    const req = { method, url: `/orchestrator/api/${path}`, headers: requestHeaders, async *[Symbol.asyncIterator]() { yield* chunks } }
    await handler(req, { writeHead: (code: number) => { status = code }, end: (value?: string | Buffer | Uint8Array) => { if (value !== undefined) output = Buffer.from(value).toString('utf8') } })
    return { status, body: output ? JSON.parse(output) as Record<string, unknown> : {} }
  }
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'personal-http-'))
  store = new Store(join(directory, 'db.sqlite'))
  store.saveSettings(SettingsSchema.parse({ sources: { feishu: { enabled: true, config: {} } },
    policy: { sources: { feishu: { allowed: [{ id: 'alice' }] } } } }))
  store.personal.configure({ ...store.personal.settings(), enabled: true, ownerActors: ['feishu:alice'] }, 0)
  owner = new PersonalCoordinator({ store, personalMode: () => true })
  actions = new PersonalActionsService({ store, adapters: { ticket_reply: {
    execute: () => ({ sent: true }), verify: () => ({ state: 'not_executed' }),
  } } })
  serve()
})
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })

it('requires same-origin headers and returns CAS conflicts through the owner record route', async () => {
  const call = serve()
  expect(await call('PUT', 'personal/records/goal/launch', { revision: 0, value: { title: 'Launch' } }, { 'x-orchestrator-request': undefined }))
    .toMatchObject({ status: 403 })
  expect(await call('PUT', 'personal/records/goal/launch', { revision: 0, value: { title: 'Launch' } })).toMatchObject({ status: 200 })
  expect(await call('PUT', 'personal/records/goal/launch', { revision: 0, value: { title: 'Stale overwrite' } }))
    .toMatchObject({ status: 409, body: { error: '记录已更新，请刷新后保存。' } })
})

it('keeps authorizations and actions out of the generic owner-editable endpoint', async () => {
  const call = serve()
  for (const kind of ['authorization', 'action']) {
    expect(await call('PUT', `personal/records/${kind}/record-1`, { revision: 0, value: { status: 'granted' } }))
      .toMatchObject({ status: 400 })
  }
  expect(store.personal.list('authorization')).toEqual([])
  expect(store.personal.list('action')).toEqual([])
})

it('rejects writes while personal features are disabled', async () => {
  store.personal.configure({ ...store.personal.settings(), enabled: false }, 1)
  const call = serve()
  expect(await call('PUT', 'personal/records/goal/disabled', { revision: 0, value: { title: 'No write' } }))
    .toMatchObject({ status: 403 })
  expect(store.personal.get('goal', 'disabled')).toBeUndefined()
})

it('grants the exact prepared request only after checking its owner ticket', async () => {
  const item = addTicket()
  const action = actions.prepare(item.id, { idempotencyKey: 'reply-1', action: 'ticket_reply', target: 'feishu:owner-room',
    payload: { text: 'Approved response' }, scope: ['ticket_reply', 'feishu:owner-room'], risk: 'L1' })
  const auth = store.personal.get('authorization', action.authorizationId!)!
  const call = serve()
  const mismatch = await call('POST', `personal/authorizations/${auth.id}/grant`, { revision: auth.revision, requestHash: '0'.repeat(64) })
  expect(mismatch.status).toBe(403)
  expect(store.personal.get('authorization', auth.id)?.status).toBe('requested')

  const granted = await call('POST', `personal/authorizations/${auth.id}/grant`, { revision: auth.revision, requestHash: auth.requestHash })
  expect(granted.status).toBe(200)
  expect(granted.body.item).toMatchObject({ id: auth.id, status: 'granted', grantedBy: 'owner/panel' })
  expect(actions.check(action.id)).toMatchObject({ allowed: true })
})

it('rejects grant when the ticket belongs to a different actor', async () => {
  const foreign = addTicket('foreign-ticket', 'mallory')
  const action = actions.prepare(foreign.id, { idempotencyKey: 'foreign-reply', action: 'ticket_reply', target: 'feishu:owner-room',
    payload: { text: 'No' }, scope: ['ticket_reply'], risk: 'L1' })
  const auth = store.personal.get('authorization', action.authorizationId!)!
  const call = serve()
  expect(await call('POST', `personal/authorizations/${auth.id}/grant`, { revision: auth.revision, requestHash: auth.requestHash }))
    .toMatchObject({ status: 403 })
  expect(store.personal.get('authorization', auth.id)?.status).toBe('requested')
})

it('allows the owner panel to revoke authorization after its ticket has stopped', async () => {
  const item = addTicket()
  const action = actions.prepare(item.id, { idempotencyKey: 'stopped-ticket-action', action: 'ticket_reply', target: 'feishu:owner-room',
    payload: { text: 'Never sent' }, scope: ['ticket_reply'], risk: 'L1' })
  const auth = store.personal.get('authorization', action.authorizationId!)!
  store.tickets.save(ticket(item.id, item.origin.triggerId, true))
  const call = serve()
  expect(await call('POST', `personal/authorizations/${auth.id}/revoke`, { revision: auth.revision, requestHash: auth.requestHash }))
    .toMatchObject({ status: 200, body: { item: { id: auth.id, status: 'revoked' } } })
})
