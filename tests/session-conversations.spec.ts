import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { freezeMessage, MessageId, type UserMessage } from '@deepseek-ai/dsh-llm'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Engine, type OutboundMessage, type Trigger } from '../src/core/index.ts'
import { ArtifactRegistry } from '../src/app/artifacts.ts'
import { SessionConversations } from '../src/app/session-conversations.ts'
import { Store } from '../src/app/store.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { SourceRegistry } from '../src/sources/registry.ts'

let directory: string
let workspace: string
let store: Store
let artifacts: ArtifactRegistry
let sources: SourceRegistry
let engine: Engine
let outbound: ReturnType<typeof vi.fn<(message: OutboundMessage) => void>>
let prompt: ReturnType<typeof vi.fn<(sessionId: string, requestId: string, text: string) => Promise<void>>>
let bridge: SessionConversations

function configure(allowed = true, enabled = true) {
  store.saveSettings(SettingsSchema.parse({
    sources: { 'dsh-session': { enabled, config: {} } },
    policy: { sources: { 'dsh-session': { allowed: allowed ? [{ id: 'owner', name: 'Owner' }] : [] } } },
  }))
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'session-conversations-'))
  workspace = join(directory, 'workspace')
  mkdirSync(workspace)
  store = new Store(join(directory, 'orchestrator.sqlite'))
  artifacts = new ArtifactRegistry(store, directory)
  configure()
  sources = new SourceRegistry(() => store.settings())
  bridge = new SessionConversations({ stateDir: workspace, masterId: 'router-main', store, configured: () => true,
    receive: trigger => engine.receive(trigger), prompt: async (sessionId, requestId, text) => prompt(sessionId, requestId, text), artifacts })
  sources.register(bridge.kind)
  engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources),
    assessor: { request: vi.fn() }, executor: { start: async () => {}, deliver: async () => {}, stop: async () => {} },
    outbox: { send: message => outbound(message), status: () => undefined, withdraw: () => {} } })
  outbound = vi.fn((_message: OutboundMessage) => {})
  prompt = vi.fn(async () => {})
})

it('answers concurrent questions in each asking Session and a cross-session status follows its current trigger', () => {
  const firstAgent = agent('conversation-first')
  const secondAgent = agent('conversation-second')
  bridge.receive(firstAgent, userMessage('question-first', '检查主任务状态'))
  bridge.receive(secondAgent, userMessage('question-second', '这个任务到哪了'))
  const first = store.read.threadTriggers('dsh-session:conversation-first')[0]!
  const second = store.read.threadTriggers('dsh-session:conversation-second')[0]!

  engine.reply({ purpose: 'answer', triggerId: first.id, text: '第一会话的回答。' })
  engine.reply({ purpose: 'answer', triggerId: second.id, text: '第二会话的回答。' })
  expect(outbound.mock.calls.slice(0, 2).map(([message]) => message.channel.address.sessionId))
    .toEqual(['conversation-first', 'conversation-second'])

  const accepted = engine.decide(first.id, { kind: 'accept', title: '原会话中的任务', scope: '检查主任务',
    reason: { code: 'explicitRouted' }, name: 'cross-session', acknowledgement: '开始检查主任务。' })
  const ticketId = accepted.ticketId!
  engine.reply({ purpose: 'status', ticketId, triggerId: second.id, text: '任务正在执行中。' })
  expect(outbound.mock.calls.at(-1)?.[0]).toMatchObject({ channel: { address: { sessionId: 'conversation-second' } }, text: '任务正在执行中。' })
  expect(accepted.ticketId).toBe(ticketId)
})

it('does not queue a second self-message when the Router answers in its own conversation', async () => {
  const router = agent('router-main')
  bridge.receive(router, userMessage('router-question', '怎么样了？'))
  const trigger = store.read.threadTriggers('dsh-session:router-main')[0]!
  engine.reply({ purpose: 'answer', triggerId: trigger.id, text: '任务目前正在执行。' })
  expect(outbound).toHaveBeenCalledWith(expect.objectContaining({ channel: trigger.channel, text: '任务目前正在执行。' }))
  expect(prompt).not.toHaveBeenCalled()
})

afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })

function agent(id: string, cwd = workspace, extra: Record<string, unknown> = {}) {
  const session = { header: { id, cwd, ...extra }, snapshotEvents: () => [] as never[] }
  return { id, session, inbox: { nextTurn: [], nextStep: [] } } as unknown as Agent
}

function userMessage(id: string, text: string, kind = 'user'): UserMessage {
  return freezeMessage({ id: MessageId(id), role: 'user', source: { kind }, content: [{ type: 'text', text }] } as UserMessage)
}

it('matches only the exact canonical workspace, rejects worker and subagent sessions, and permits ordinary forks', () => {
  expect(bridge.matches(agent('plain'))).toBe(true)
  expect(bridge.matches(agent('worker-ticket'))).toBe(false)
  expect(bridge.matches(agent('child', workspace, { origin: 'subagent' }))).toBe(false)
  // A historical ordinary fork may keep parentSession metadata and remains an eligible top-level conversation.
  expect(bridge.matches(agent('fork', workspace, { parentSession: 'old-parent' }))).toBe(true)
  expect(bridge.matches(agent('elsewhere', join(directory, 'other')))).toBe(false)

  const alias = join(directory, 'workspace-link')
  try {
    symlinkSync(workspace, alias, 'junction')
    expect(bridge.matches(agent('linked', alias))).toBe(true)
  } catch { /* Windows may deny junction creation in a restricted test runner. */ }
})

it('turns the same real human message into one router-first trigger and ignores internal messages', () => {
  const target = agent('conversation-1')
  const human = userMessage('human-message-1', '修复设置页')
  bridge.receive(target, human)
  bridge.receive(target, human)
  bridge.receive(target, userMessage('internal-message-1', '[Superagent delivery]\n已开始处理', 'dsh-superagent'))

  const triggers = store.read.threadTriggers('dsh-session:conversation-1')
  expect(triggers).toHaveLength(1)
  expect(triggers[0]).toMatchObject({ id: expect.stringContaining('session-message-'), source: 'dsh-session', routing: 'router',
    threads: [{ source: 'dsh-session', id: 'conversation-1' }], actor: { source: 'dsh-session', id: 'owner' }, human: true,
    addressed: 'direct', text: '修复设置页', channel: { source: 'dsh-session', address: { sessionId: 'conversation-1' } },
    meta: { sessionId: 'conversation-1', messageId: 'human-message-1', cwd: workspace } })
  expect(store.triggers.disposition(triggers[0]!.id)).toMatchObject({ routing: 'pending', fanout: [] })
})

it('lets Engine record a closed source or revoked owner as filtered without dispatching it', () => {
  const target = agent('conversation-policy')
  configure(true, false)
  bridge.receive(target, userMessage('disabled-source', '请帮我处理'))
  const disabled = store.read.threadTriggers('dsh-session:conversation-policy')[0]!
  expect(store.triggers.disposition(disabled.id)?.filtered).toBeDefined()

  configure(false, true)
  bridge.receive(target, userMessage('revoked-owner', '再处理一项'))
  const revoked = store.read.threadTriggers('dsh-session:conversation-policy')[0]!
  expect(store.read.threadTriggers('dsh-session:conversation-policy')).toHaveLength(2)
  expect(store.triggers.disposition(revoked.id)?.filtered).toBeDefined()
  expect(store.threads.get('dsh-session:conversation-policy')?.pending ?? []).toEqual([])
})

it('sends a durable source reply only to its recorded original session with an idempotent request key', async () => {
  const original = agent('conversation-origin')
  const other = agent('conversation-other')
  bridge.receive(original, userMessage('origin-message', '生成报告'))
  bridge.receive(other, userMessage('other-message', '另一项'))
  const send = bridge.kind.channel!.send
  const message = { id: 'reply-1', kind: 'reply', ticketId: 'ticket-1', channel: {
    source: 'dsh-session', thread: 'dsh-session:conversation-origin', address: { sessionId: 'conversation-origin' } }, text: '报告已完成' } as OutboundMessage

  expect(bridge.kind.channel!.allowed!(message.channel.address, {})).toBe(true)
  expect(await send({} as never, message)).toBe('sent')
  expect(await send({} as never, message)).toBe('sent')
  expect(prompt).toHaveBeenCalledTimes(2)
  expect(prompt).toHaveBeenNthCalledWith(1, 'conversation-origin', 'session-reply:reply-1', expect.stringContaining('报告已完成'))
  expect(prompt.mock.calls.every(([sessionId]) => sessionId !== 'conversation-other')).toBe(true)
  configure(true, false)
  expect(await send({} as never, message)).toBe('gone')
})

it('status reconciles the current human history and pending inbox, then reports only this session thread', async () => {
  const target = agent('conversation-status')
  const ownMessage = userMessage('status-human', '检查构建')
  const events = [{ type: 'user/message', data: ownMessage }]
  const pending = userMessage('status-pending', '再检查一次')
  ;(target.session as unknown as { snapshotEvents: () => unknown[] }).snapshotEvents = () => events as never
  ;(target as unknown as { inbox: { nextTurn: UserMessage[]; nextStep: UserMessage[] } }).inbox = { nextTurn: [pending], nextStep: [] }
  bridge.receive(agent('other-status'), userMessage('other-human', '外部任务'))

  const tool = bridge.tools(target).find(item => item.name === 'orchestrator_session_status')!
  const status = await tool.execute({}, new AbortController().signal) as { session_id: string; queued: boolean; tickets: unknown[] }
  expect(status).toMatchObject({ session_id: 'conversation-status', queued: true })
  expect(store.read.threadTriggers('dsh-session:conversation-status')).toHaveLength(2)
  expect(store.read.threadTriggers('dsh-session:other-status')).toHaveLength(1)
  expect(status.tickets).toEqual([])
})

it('retains pure image/file input as authorized source attachments for workers', async () => {
  const target = agent('conversation-media')
  const image = { attachmentId: AttachmentId('a'.repeat(64)), name: 'screen.png', mediaType: 'image/png' as const, bytes: 20, width: 4, height: 5 }
  const file = { attachmentId: AttachmentId('b'.repeat(64)), name: 'notes.txt', bytes: 12 }
  bridge.receive(target, freezeMessage({ id: MessageId('media-input'), role: 'user', source: { kind: 'user' },
    content: [{ type: 'image', attachment: image }, { type: 'file', attachment: file }] }))
  const trigger = store.read.threadTriggers('dsh-session:conversation-media')[0]!
  expect(trigger.attachments).toHaveLength(2)
  const adapter = bridge.kind.attachments!
  expect(adapter.references(trigger)[0]).toMatchObject({ id: image.attachmentId, type: 'image', status: 'available' })
  expect(await adapter.read(trigger, image.attachmentId, undefined, new AbortController().signal)).toMatchObject({ image })
  expect(await adapter.read(trigger, file.attachmentId, undefined, new AbortController().signal)).toMatchObject({ type: 'file', name: 'notes.txt', size: 12 })
  await expect(adapter.read(trigger, 'unknown-file', undefined, new AbortController().signal)).rejects.toThrow('from this conversation')
})

it('pages thread context without omitting or repeating messages after the first thirty', async () => {
  const target = agent('conversation-pages')
  for (let i = 0; i < 35; i++) bridge.receive(target, userMessage(`page-message-${i}`, `message ${i}`))
  const trigger = store.read.threadTriggers('dsh-session:conversation-pages')[0]!
  const read = bridge.kind.threadContext!.read
  const first = await read({} as never, trigger, 'thread', undefined, {})
  expect(first.messages).toHaveLength(30)
  expect(first.next).toBeTruthy()
  const second = await read({} as never, trigger, 'thread', first.next, {})
  expect(second.messages).toHaveLength(5)
  expect(second.next).toBeUndefined()
  expect(new Set([...first.messages, ...second.messages].map(message => message.id)).size).toBe(35)
})
