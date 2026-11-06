import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Engine, key, type Trigger } from '../src/core/index.ts'
import { Store } from '../src/app/store.ts'
import { TaskRooms } from '../src/app/task-rooms.ts'
import { WebTasks, webSource } from '../src/app/web-tasks.ts'
import { WebAttachmentStore } from '../src/app/web-attachments.ts'
import { registerHttp, type HttpHost } from '../src/app/http.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { record } from '../src/kv.ts'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aPz0AAAAASUVORK5CYII='
let directory: string, store: Store, sources: SourceRegistry, engine: Engine, rooms: TaskRooms, images: WebAttachmentStore
let allowed: boolean, time: number
const pass = vi.fn()
const now = () => new Date(time++).toISOString()
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'collaboration-messages-'))
  store = new Store(join(directory, 'state.sqlite')); allowed = true; time = Date.now()
  store.saveSettings(SettingsSchema.parse({ sources: { web: { enabled: true, config: {} } },
    policy: { sources: { web: { allowed: [{ id: 'owner' }] } } } }))
  images = new WebAttachmentStore(store, directory, () => allowed)
  sources = new SourceRegistry(() => store.settings()); sources.register(webSource(store, () => true, undefined, images))
  engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources),
    assessor: { request: vi.fn() }, executor: { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() },
    outbox: { send: vi.fn(), status: () => undefined, withdraw: vi.fn() }, now })
  pass.mockClear()
  rooms = new TaskRooms({ store, engine, personal: () => true, configured: () => true, requestPass: pass, attachments: images })
})
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
function accept(id: string, room: string) {
  const trigger: Trigger = { id, source: 'web', routing: 'router', threads: [{ source: 'web', id: room }],
    actor: { source: 'web', id: 'owner' }, human: true, addressed: 'direct', at: now(), text: `Original ${id}`,
    channel: { source: 'web', thread: `web:${room}`, address: { room: `web:${room}` } }, meta: {} }
  engine.receive(trigger)
  const decision = engine.decide(id, { kind: 'accept', title: id, name: id, scope: 'requested scope', reason: 'explicit task' })
  const ticket = store.tickets.get(decision.ticketId!)!
  engine.assignmentStarted(ticket.id, ticket.assignments[0]!.id)
  return store.tickets.get(ticket.id)!
}
function serve() {
  let handle: (req: unknown, res: unknown) => Promise<void> = async () => {}
  const runtime = { store, sources, engine, machine: { mode: 'personal', stateDir: directory }, masterId: 'router-session',
    sessions: { conversationIds: () => ['known-session'], status: () => ({ failures: [] }) }, configured: () => true,
    requestPass: pass, health: {}, ready: Promise.resolve() }
  registerHttp({ webServer: { host: '127.0.0.1', port: 3082, register: (route: { handler: typeof handle }) => {
    handle = route.handler; return () => {}
  } } } as never, runtime as unknown as HttpHost)
  return async (method: string, path: string, body?: unknown, headers: Record<string, string | undefined> = {}) => {
    let status = 0, bytes = Buffer.alloc(0), responseHeaders: Record<string, string> = {}
    const req = { method, url: `/orchestrator/api/${path}`, headers: { host: '127.0.0.1:3082', 'x-orchestrator-request': '1', ...headers },
      async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)) } }
    await handle(req, { writeHead: (code: number, values: Record<string, string>) => { status = code; responseHeaders = values },
      end: (value: string | Buffer) => { bytes = Buffer.from(value) } })
    return { status, headers: responseHeaders, bytes,
      body: responseHeaders['content-type']?.startsWith('application/json') ? JSON.parse(bytes.toString()) as Record<string, unknown> : undefined }
  }
}

describe('collaboration routing and history', () => {
  it('delivers repeated mentions once to each selected worker, stores one visible message, and rejects changed retries', () => {
    const first = accept('first', 'shared'), second = accept('second', 'shared')
    const body = { text: 'Please check this together', requestId: 'multi-mention-0001', router: false, mentions: [second.id, first.id, second.id] }
    const result = rooms.post('web:shared', body)
    expect(result.messages.filter(message => message.text === body.text)).toHaveLength(1)
    expect(result.messages.find(message => message.text === body.text)).toMatchObject({ router: false, recipients: [first.id, second.id].sort() })
    for (const ticket of [first, second]) expect(store.tickets.get(ticket.id)!.inputs.filter(input => input.kind === 'trigger')).toHaveLength(1)
    const passCount = pass.mock.calls.length
    rooms.post('web:shared', { ...body, mentions: [first.id, second.id] })
    expect(pass).toHaveBeenCalledTimes(passCount)
    expect(() => rooms.post('web:shared', { ...body, router: true })).toThrow('发送编号已经用于另一条消息')
    expect(() => rooms.post('web:shared', { text: 'No target', requestId: 'no-target-0001', router: false })).toThrow('请选择 @成员或开启 R')
  })
  it('keeps R plus mentions Router-only and carries exact member context, including completed members', () => {
    const first = accept('router-first', 'router-room'), second = accept('router-second', 'router-room')
    engine.report(second.id, { state: 'dropped', summary: 'Completed earlier' }, second.assignments[0]!.id)
    const body = { text: 'Coordinate next steps', requestId: 'router-mentions-0001', router: true, mentions: [first.id, second.id] }
    const before = [first, second].map(ticket => store.tickets.get(ticket.id)!.inputs.length)
    rooms.post('web:router-room', body)
    const triggerId = `room-message-${key('web:router-room', body.requestId)}`
    expect(store.triggers.disposition(triggerId)).toMatchObject({ routing: 'pending', fanout: [] })
    expect(store.triggers.get(triggerId)?.meta.mentionedWorkers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: first.id, title: first.title }), expect.objectContaining({ id: second.id, title: second.title }),
    ]))
    expect([first, second].map(ticket => store.tickets.get(ticket.id)!.inputs.length)).toEqual(before)
    expect(rooms.get('web:router-room', undefined, 20, first.id).messages.some(message => message.id === `trigger:${triggerId}`)).toBe(true)
  })
  it('filters worker history before pagination and includes its original request, dispatch and every report', () => {
    const first = accept('quiet-worker', 'busy-room'), second = accept('busy-worker', 'busy-room')
    engine.report(first.id, { state: 'progress', summary: 'Quiet checkpoint' }, first.assignments[0]!.id)
    for (let index = 0; index < 65; index++) engine.report(second.id, { state: 'progress', summary: `Busy checkpoint ${index}` }, second.assignments[0]!.id)
    const page = rooms.get('web:busy-room', undefined, 2, first.id)
    const older = rooms.get('web:busy-room', page.earlier!, 2, first.id)
    const messages = [...older.messages, ...page.messages]
    expect(messages.map(message => message.text)).toEqual(expect.arrayContaining(['Original quiet-worker', 'quiet-worker', 'Quiet checkpoint']))
    expect(messages.some(message => message.text.startsWith('Busy checkpoint'))).toBe(false)
    expect(messages.find(message => message.text === 'Quiet checkpoint')).toMatchObject({ reportState: 'progress' })
  })
  it('supports cross-room session mentions atomically and limits a normal conversation to its visible workers', async () => {
    const first = accept('cross-first', 'room-one'), second = accept('cross-second', 'room-two'), call = serve()
    const body = { text: 'Cross room direct', requestId: 'cross-session-0001', router: false, mentions: [first.id, second.id] }
    expect((await call('POST', 'sessions/router-session/collaboration', body)).status).toBe(200)
    for (const ticket of [first, second]) expect(store.tickets.get(ticket.id)!.inputs.filter(input => input.kind === 'trigger')).toHaveLength(1)
    const firstMessage = rooms.get('web:room-one').messages.find(message => message.text === body.text)!
    expect(rooms.get('web:room-two').messages.find(message => message.text === body.text)?.id).toBe(firstMessage.id)
    await call('POST', 'sessions/router-session/collaboration', body)
    for (const ticket of [first, second]) expect(store.tickets.get(ticket.id)!.inputs.filter(input => input.kind === 'trigger')).toHaveLength(1)
    expect((await call('POST', 'sessions/known-session/collaboration', { ...body, requestId: 'forbidden-scope-01' })).status).toBe(409)
    expect((await call('POST', 'sessions/unknown-session/collaboration', body)).status).toBe(404)
    const blue = { ...body, requestId: 'cross-router-0001', router: true }
    const before = [first, second].map(ticket => store.tickets.get(ticket.id)!.inputs.length)
    expect((await call('POST', 'sessions/router-session/collaboration', blue)).status).toBe(200)
    expect([first, second].map(ticket => store.tickets.get(ticket.id)!.inputs.length)).toEqual(before)
    const routerId = `room-message-${key('session:router-session', blue.requestId)}`
    expect(store.triggers.disposition(routerId)).toMatchObject({ routing: 'pending', fanout: [] })
    expect(rooms.get('web:room-one', undefined, 20, first.id).messages.some(message => message.id === `trigger:${routerId}`)).toBe(true)
    expect(store.triggers.get(routerId)?.threads).toEqual([{ source: 'dsh-session', id: 'router-session' }])
    const outsider = accept('cross-outsider', 'room-three')
    expect(() => engine.attach(outsider.id, routerId)).toThrow('names different worker tickets')
    engine.attach(first.id, routerId, 'Investigate the UI')
    expect(store.tickets.get(first.id)!.assignments.at(-1)?.state).toBe('running')
    engine.attach(second.id, routerId, 'Verify the tests')
    engine.attach(first.id, routerId, 'Investigate the UI')
    engine.attach(second.id, routerId, 'Verify the tests')
    expect(store.triggers.disposition(routerId)?.fanout.sort()).toEqual([first.id, second.id].sort())
    for (const ticket of [first, second]) expect(store.tickets.get(ticket.id)!.inputs.filter(input => input.kind === 'trigger' && input.triggerId === routerId)).toHaveLength(1)
    expect(store.threads.get('web:room-one')!.subscriptions).not.toContain(second.id)
    expect(store.threads.get('web:room-two')!.subscriptions).not.toContain(first.id)
  })
})

describe('owner Web image inputs', () => {
  const upload = () => images.upload({ name: 'screenshot.png', mediaType: 'image/png', data: PNG, requestId: 'image-upload-0001' })
  it('persists an immutable upload, deduplicates retries, verifies format and rechecks owner authorization', () => {
    const image = upload()
    expect(upload()).toEqual(image)
    expect(images.bytes(image.id).bytes.toString('base64')).toBe(PNG)
    expect(() => images.upload({ name: 'bad.png', mediaType: 'image/png', data: Buffer.from('not an image').toString('base64'), requestId: 'invalid-image-01' })).toThrow('请选择 10 MB')
    expect(() => images.upload({ name: 'changed.png', mediaType: 'image/png', data: PNG, requestId: 'image-upload-0001' })).toThrow('图片上传编号')
    allowed = false
    expect(() => images.bytes(image.id)).toThrow('授权')
    expect(() => upload()).toThrow('授权')
  })
  it('keeps pure image tasks and followups grounded in durable model-readable attachment references', async () => {
    const image = upload()
    const tasks = new WebTasks({ store, mode: () => 'personal', configured: () => true, health: () => ({}),
      receive: trigger => engine.receive(trigger), requestPass: pass, attachments: images })
    const body = { text: '', requestId: 'pure-image-task-01', attachmentIds: [image.id] }
    const task = tasks.create(body), trigger = store.triggers.get(task.messages[0]!.id)!
    expect(task).toMatchObject({ title: '图片任务', messages: [expect.objectContaining({ text: '', attachments: [image] })] })
    expect(trigger.attachments).toEqual([expect.objectContaining({ id: image.id, read: `attachment/${trigger.id}/${image.id}` })])
    expect(tasks.create(body).id).toBe(task.id)
    expect(() => tasks.create({ ...body, attachmentIds: [] })).toThrow()
    const saveImage = vi.fn(async () => ({ attachmentId: 'model-visible-image' }))
    const agent = { ctx: { get: () => ({ imageLimits: { maxImageBytes: 1024, maxMessageImageBytes: 2048 }, saveImage }) } }
    const visual = await images.read(trigger, image.id, agent as never, new AbortController().signal)
    expect(visual).toMatchObject({ understanding: { status: 'visual_input_ready' }, images: [{ attachmentId: 'model-visible-image' }] })
    expect(saveImage).toHaveBeenCalledOnce()
    await expect(images.read({ ...trigger, attachments: [] }, image.id, agent as never, new AbortController().signal)).rejects.toMatchObject({ status: 404 })
    expect(tasks.followup(task.id, { text: '', requestId: 'pure-image-followup', attachmentIds: [image.id] }).messages).toHaveLength(2)
  })
  it('serves image upload/preview only under same-origin and current owner authorization', async () => {
    const call = serve(), body = { name: 'screen.png', mediaType: 'image/png', data: PNG, requestId: 'http-upload-0001' }
    expect((await call('POST', 'web/attachments', body, { 'x-orchestrator-request': undefined })).status).toBe(403)
    const uploaded = await call('POST', 'web/attachments', body), id = String(uploaded.body!.id)
    expect(uploaded.status).toBe(200)
    const preview = await call('GET', `web/attachments/${id}`)
    expect(preview.status).toBe(200); expect(preview.headers['content-type']).toBe('image/png'); expect(preview.bytes.toString('base64')).toBe(PNG)
    const settings = store.settings(); settings.policy.sources.web!.allowed = []; store.saveSettings(settings)
    expect((await call('GET', `web/attachments/${id}`)).status).toBe(409)
  })
  it('attaches a pure-image collaboration message and rejects changed-image retries', () => {
    const worker = accept('image-member', 'image-room'), image = upload()
    const body = { text: '', requestId: 'image-room-message', router: false, mentions: [worker.id], attachmentIds: [image.id] }
    const result = rooms.post('web:image-room', body)
    expect(result.messages.find(message => message.kind === 'user' && message.text === '')?.attachments).toEqual([image])
    const next = images.upload({ name: 'another.png', mediaType: 'image/png', data: PNG, requestId: 'another-image-01' })
    expect(() => rooms.post('web:image-room', { ...body, attachmentIds: [next.id] })).toThrow('发送编号已经用于另一条消息')
    const stored = store.get(record<{ id: string; sha256: string }>(`web-image:${image.id}`))!
    writeFileSync(join(directory, 'web-images', `${stored.id}.${stored.sha256}`), 'changed')
    expect(() => images.bytes(image.id)).toThrow('图片文件校验失败')
  })
})
