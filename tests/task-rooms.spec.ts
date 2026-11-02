import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Engine, key, type OutboundMessage, type Ticket, type Trigger } from '../src/core/index.ts'
import { TaskRooms } from '../src/app/task-rooms.ts'
import { ArtifactRegistry } from '../src/app/artifacts.ts'
import { Store } from '../src/app/store.ts'
import { webSource } from '../src/app/web-tasks.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

let directory: string
let path: string
let store: Store
let sources: SourceRegistry
let engine: Engine
let rooms: TaskRooms
let clockTick: number
let requestPass: ReturnType<typeof vi.fn<() => void>>
let inspectWorker: ReturnType<typeof vi.fn<(id: string) => Promise<readonly SessionEvent[]>>>
let artifacts: ArtifactRegistry
const actor = { source: 'web', id: 'owner' }
const base = Date.parse('2026-11-01T12:00:00.000Z')
const now = () => new Date(base + clockTick).toISOString()

function configure() {
  sources = new SourceRegistry(() => store.settings())
  sources.register(webSource(store, () => true, artifacts))
  requestPass = vi.fn()
  inspectWorker = vi.fn(async () => [])
  engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources),
    assessor: { request: vi.fn() }, executor: { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() },
    outbox: { send: vi.fn(), status: () => undefined, withdraw: vi.fn() }, now })
  rooms = new TaskRooms({ store, engine, personal: () => true, configured: () => true, requestPass, inspectWorker, artifacts })
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'task-rooms-'))
  path = join(directory, 'orchestrator.sqlite')
  store = new Store(path)
  artifacts = new ArtifactRegistry(store, directory)
  store.saveSettings(SettingsSchema.parse({ sources: { web: { enabled: true, config: {} } },
    policy: { sources: { web: { allowed: [{ id: 'owner', name: 'Owner' }] } } } }))
  clockTick = 0
  configure()
})

afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })

function seedTrigger(id: string, roomId: string, at = now(), source = 'web'): Trigger {
  const ref = { source, id: roomId }
  return { id, source: 'web', routing: 'router', threads: [ref], actor, human: true, addressed: 'direct', at,
    text: `Initial task ${id}`, channel: { source: 'web', thread: `${source}:${roomId}`, address: { room: `${source}:${roomId}` } },
    meta: { conversation: roomId } }
}

function accept(id: string, roomId: string, at = now(), source = 'web'): Ticket {
  const trigger = seedTrigger(id, roomId, at, source)
  expect(engine.receive(trigger)).toBe('stored')
  const decision = engine.decide(id, { kind: 'accept', title: `Worker ${id}`, scope: 'room project', reason: 'owner requested', name: `worker-${id}` })
  const ticket = store.tickets.get(decision.ticketId!)!
  engine.assignmentStarted(ticket.id, ticket.assignments[0]!.id)
  return store.tickets.get(ticket.id)!
}

const request = (requestId: string, text: string, recipient?: string) => ({ requestId, text, ...(recipient ? { recipient } : {}) })

describe('task rooms', () => {
  it('keeps ordinary messages Router-only, delivers explicit messages to one worker, validates membership and idempotency', () => {
    const first = accept('room-origin', 'room-a')
    const sibling = engine.delegate(first.id, 'delegate-room-a', 'Check the tests', 'web:room-a', first.assignments[0]!.id)
    const outsider = accept('other-origin', 'room-b')
    const keyValue = 'web:room-a'

    const ordinary = rooms.post(keyValue, request('ordinary-message-01', 'Please coordinate this request.'))
    const ordinaryRow = ordinary.messages.find(message => message.id === `trigger:room-message-${key(keyValue, 'ordinary-message-01')}`)!
    expect(ordinaryRow).toMatchObject({ kind: 'user', audience: 'router' })
    const ordinaryId = ordinaryRow.id.slice('trigger:'.length)
    const ordinaryTrigger = store.triggers.get(ordinaryId)!
    expect(store.triggers.disposition(ordinaryId)).toMatchObject({ routing: 'pending', fanout: [] })
    expect(store.tickets.get(first.id)!.inputs.some(input => input.kind === 'trigger' && input.triggerId === ordinaryTrigger.id)).toBe(false)
    expect(store.tickets.get(sibling.id)!.inputs.some(input => input.kind === 'trigger' && input.triggerId === ordinaryTrigger.id)).toBe(false)

    const targetedBody = request('targeted-message-01', 'Review the API changes.', sibling.id)
    const targeted = rooms.post(keyValue, targetedBody)
    const targetedTriggerId = `room-message-${key(keyValue, 'targeted-message-01')}`
    const targetedEntryId = `trigger:${targetedTriggerId}`
    expect(targeted.messages.find(message => message.id === targetedEntryId)).toMatchObject({ kind: 'user', audience: 'worker', recipient: sibling.id })
    expect(store.triggers.disposition(targetedTriggerId)).toMatchObject({ directTicketId: sibling.id, fanout: [sibling.id] })
    expect(store.tickets.get(first.id)!.inputs.some(input => input.kind === 'trigger' && input.triggerId === targetedTriggerId)).toBe(false)
    const passCount = requestPass.mock.calls.length
    expect(rooms.post(keyValue, targetedBody).messages.find(message => message.id === targetedEntryId)?.recipient).toBe(sibling.id)
    expect(requestPass).toHaveBeenCalledTimes(passCount)
    expect(() => rooms.post(keyValue, request('targeted-message-01', 'Changed content.', sibling.id))).toThrow('发送编号已经用于另一条消息')
    expect(() => rooms.post(keyValue, request('targeted-message-01', 'Review the API changes.', first.id))).toThrow('发送编号已经用于另一条消息')
    expect(() => rooms.post(keyValue, request('outsider-message-01', 'Hello', outsider.id))).toThrow('该 Worker 已离开或结束工作')
    expect(store.tickets.get(outsider.id)!.inputs).toEqual([])
  })

  it('shows shared events and every progress report after Store reopen, with stable cursor ordering and redacted activity', async () => {
    const first = accept('history-origin', 'history-room')
    const second = engine.delegate(first.id, 'history-delegate', 'Inspect UI behavior', 'web:history-room', first.assignments[0]!.id)
    const threadKey = 'web:history-room'
    const collaboration = engine.collaborate(first.id, threadKey, 'Cross-worker finding.', 'shared-event-01', first.assignments[0]!.id)
    expect(rooms.get(threadKey).messages).toEqual(expect.arrayContaining([expect.objectContaining({ id: `trigger:${collaboration.id}`, kind: 'collaboration', audience: 'thread' })]))

    engine.report(first.id, { state: 'progress', summary: 'Progress checkpoint one' }, first.assignments[0]!.id)
    clockTick += 1_000
    engine.report(first.id, { state: 'progress', summary: 'Progress checkpoint two' }, first.assignments[0]!.id)
    const reports = store.rooms.page(threadKey, 100).filter(row => row.kind === 'report' && row.ticketId === first.id)
    expect(reports.map(row => row.text)).toEqual(['Progress checkpoint two', 'Progress checkpoint one'])

    const sameAt = '2026-11-01T12:00:09.000Z'
    for (const id of ['cursor-a', 'cursor-b', 'cursor-c']) store.triggers.save(seedTrigger(id, 'history-room', sameAt))
    const firstPage = rooms.get(threadKey, undefined, 2)
    const secondPage = rooms.get(threadKey, firstPage.earlier!, 2)
    const pageIds = [...secondPage.messages, ...firstPage.messages].map(message => message.id)
    expect(new Set(pageIds).size).toBe(pageIds.length)
    expect(pageIds.filter(id => id.startsWith('trigger:cursor-'))).toEqual(['trigger:cursor-a', 'trigger:cursor-b', 'trigger:cursor-c'])

    inspectWorker.mockResolvedValue([{ type: 'assistant/message', data: { message: { role: 'assistant', content: [
      { type: 'text', text: 'Read token=supersecret-value from config.' }, { type: 'reasoning', text: 'private internal reasoning' },
    ] } } } as unknown as SessionEvent])
    const activity = await rooms.activity(threadKey, first.id)
    expect(activity.items).toHaveLength(1)
    expect(activity.items[0]!.text).toContain('[redacted]')
    expect(activity.items[0]!.text).not.toContain('supersecret-value')
    expect(activity.items[0]!.text).not.toContain('private internal reasoning')
    await expect(rooms.activity(threadKey, 'non-member')).rejects.toMatchObject({ status: 404 })

    store.close()
    store = new Store(path)
    configure()
    const restored = rooms.get(threadKey, undefined, 100).messages
    expect(restored).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: `trigger:${collaboration.id}`, kind: 'collaboration' }),
      expect.objectContaining({ text: 'Progress checkpoint one', kind: 'report' }),
      expect.objectContaining({ text: 'Progress checkpoint two', kind: 'report' }),
    ]))
    const restoredReports = restored.filter(message => message.ticketId === first.id && message.kind === 'report')
    expect(restoredReports.map(message => message.text)).toContain('Progress checkpoint one')
    expect(restoredReports.map(message => message.text)).toContain('Progress checkpoint two')
    expect(store.tickets.get(second.id)).toBeDefined()
  })

  it('lists non-Web source threads and delivers Web room-channel replies to them', async () => {
    const worker = accept('qq-origin', 'team-1', now(), 'qq')
    const threadKey = 'qq:team-1'
    const listed = rooms.list().items
    expect(listed.map(room => room.key)).toContain(threadKey)
    expect(rooms.get(threadKey).workers.map(item => item.id)).toContain(worker.id)

    const posted = rooms.post(threadKey, request('qq-room-message-01', 'Please inspect this QQ group context.'))
    expect(posted.messages.at(-1)).toMatchObject({ kind: 'user', audience: 'router' })
    const channelMessage: OutboundMessage = { id: 'qq-room-reply', channel: { source: 'web', thread: threadKey, address: { room: threadKey } },
      text: 'Reviewed the shared group thread.', kind: 'reply', ticketId: worker.id }
    store.receipts.add(channelMessage)
    expect(await sources.kind('web')!.channel!.send({} as never, channelMessage)).toBe('sent')
    expect(sources.channelAllowed({ source: 'web', address: { room: threadKey } })).toBe(true)
    expect(store.rooms.page(threadKey, 100).some(row => row.kind === 'reply' && row.receiptId === channelMessage.id)).toBe(true)
    expect(rooms.get(threadKey).messages).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'router', text: channelMessage.text })]))
  })

  it('exposes only sent room receipts, verifies ticket-scoped snapshots, and refuses missing or cross-room artifacts', async () => {
    const worker = accept('artifact-origin', 'artifact-room')
    const roomKey = 'web:artifact-room'
    const work = join(directory, 'work', worker.id)
    mkdirSync(work, { recursive: true })
    const source = join(work, 'summary.txt')
    writeFileSync(source, 'durable room artifact bytes')
    const artifact = await artifacts.stage(worker.id, work, source, 'room-summary.txt')
    const otherWork = join(directory, 'work', 'other-ticket')
    mkdirSync(otherWork, { recursive: true })
    const otherSource = join(otherWork, 'other.txt')
    writeFileSync(otherSource, 'belongs to another ticket')
    const wrongTicketArtifact = await artifacts.stage('other-ticket', otherWork, otherSource, 'other.txt')
    const channel = sources.kind('web')!.channel!
    const message = (id: string, thread: string, artifactId: string, ticketId = worker.id): OutboundMessage => ({ id,
      channel: { source: 'web', thread, address: { room: thread } }, text: `Attachment ${id}`, kind: 'reply', ticketId, artifacts: [artifactId] })

    const pending = message('artifact-pending', roomKey, artifact.id)
    store.receipts.add(pending)
    expect(await channel.send({} as never, pending)).toBe('sent')
    expect(rooms.get(roomKey).messages.find(item => item.id === 'reply:artifact-pending')?.artifacts).toBeUndefined()
    await expect(rooms.artifact(roomKey, artifact.id)).rejects.toMatchObject({ status: 404 })
    store.receipts.settle(pending, 'sent')

    const sent = message('artifact-sent', roomKey, artifact.id)
    store.receipts.add(sent)
    expect(await channel.send({} as never, sent)).toBe('sent')
    store.receipts.settle(sent, 'sent')
    expect(rooms.get(roomKey).messages.find(item => item.id === 'reply:artifact-sent')?.artifacts).toEqual([
      { id: artifact.id, name: artifact.name, size: artifact.size },
    ])
    expect(store.rooms.members(roomKey)).toContain(worker.id)
    expect(store.receipts.get('artifact-sent')).toMatchObject({ status: 'sent', ticketId: worker.id, channel: { thread: roomKey }, artifacts: [artifact.id] })
    await expect(rooms.artifact(roomKey, artifact.id)).resolves.toMatchObject({ id: artifact.id, ticketId: worker.id, name: artifact.name })

    const wrongTicket = message('artifact-wrong-ticket', roomKey, wrongTicketArtifact.id)
    store.receipts.add(wrongTicket)
    await expect(channel.send({} as never, wrongTicket)).rejects.toThrow('Unknown artifact')
    store.receipts.settle(wrongTicket, 'sent')
    await expect(rooms.artifact(roomKey, wrongTicketArtifact.id)).rejects.toMatchObject({ status: 404 })

    const otherRoomKey = 'web:artifact-other-room'
    engine.receive(seedTrigger('artifact-other-room-origin', 'artifact-other-room'))
    const crossRoom = message('artifact-cross-room', otherRoomKey, artifact.id)
    store.receipts.add(crossRoom); store.receipts.settle(crossRoom, 'sent')
    await expect(rooms.artifact(otherRoomKey, artifact.id)).rejects.toMatchObject({ status: 404 })
    expect(artifacts.get(artifact.id, worker.id)).toBeDefined()

    const original = store.settings.bind(store)
    store.settings = () => SettingsSchema.parse({ ...original(), policy: { ...original().policy, sources: { web: { allowed: [] } } } })
    try { await expect(rooms.artifact(roomKey, artifact.id)).rejects.toMatchObject({ status: 409 }) }
    finally { store.settings = original }
  })
})
