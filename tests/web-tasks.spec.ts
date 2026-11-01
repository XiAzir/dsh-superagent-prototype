import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Engine, type OutboundMessage } from '../src/core/index.ts'
import { Store } from '../src/app/store.ts'
import { WebTaskError, WebTasks, webSource } from '../src/app/web-tasks.ts'
import { record } from '../src/kv.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { ArtifactRegistry } from '../src/app/artifacts.ts'

let directory: string
let store: Store
let sources: SourceRegistry
let engine: Engine
let tasks: WebTasks
let requestPass: ReturnType<typeof vi.fn<() => void>>
let artifacts: ArtifactRegistry

function enableWeb(allowed = true, enabled = true) {
  store.saveSettings(SettingsSchema.parse({
    sources: { web: { enabled, config: {} } },
    policy: { sources: { web: { allowed: allowed ? [{ id: 'owner', name: 'Owner' }] : [] } } },
  }))
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'web-tasks-'))
  store = new Store(join(directory, 'orchestrator.sqlite'))
  artifacts = new ArtifactRegistry(store, directory)
  enableWeb()
  sources = new SourceRegistry(() => store.settings())
  sources.register(webSource(store, () => true, artifacts))
  engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources),
    assessor: { request: vi.fn() }, executor: { start: async () => {}, deliver: async () => {}, stop: async () => {} },
    outbox: { send: () => {}, status: () => undefined, withdraw: () => {} } })
  requestPass = vi.fn(() => {})
  tasks = new WebTasks({ store, mode: () => 'personal', configured: () => true, health: () => ({}),
    receive: trigger => engine.receive(trigger), requestPass, artifacts })
})

afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })

const id = (value: string) => `request_${value}01`

it('shows a current model failure on the Web task and clears it when the session recovers', () => {
  let failure: { message: string; at: string } | undefined
  const service = new WebTasks({ store, mode: () => 'personal', configured: () => true, health: () => ({}),
    receive: trigger => engine.receive(trigger), requestPass, failure: () => failure })
  const task = service.create({ text: '生成个人报告', requestId: id('failure') })
  failure = { message: '模型服务返回 405', at: new Date(Date.parse(task.createdAt) + 1000).toISOString() }
  expect(service.get(task.id)).toMatchObject({ status: 'person', error: '模型服务返回 405' })
  failure = undefined
  expect(service.get(task.id)).toMatchObject({ status: 'queued' })
  expect(service.get(task.id).error).toBeUndefined()
  failure = { message: '旧任务的错误', at: new Date(Date.parse(task.createdAt) - 1000).toISOString() }
  expect(service.get(task.id).error).toBeUndefined()
})

it('creates a directly authorized personal conversation through the real Engine and stores trigger and thread together', () => {
  const task = tasks.create({ text: '修复设置页', requestId: id('create') })
  const message = task.messages[0]!
  const trigger = store.triggers.get(message.id)!
  const thread = store.threads.get(`web:${task.id}`)!

  expect(task).toMatchObject({ title: '修复设置页', status: 'queued' })
  expect(trigger).toMatchObject({ source: 'web', actor: { id: 'owner' }, human: true, addressed: 'direct', text: '修复设置页' })
  expect(store.triggers.disposition(message.id)).toBeDefined()
  expect(thread.pending).toContain(message.id)
  expect(store.get(record<{ messages: { role: string; text: string }[] }>(`web-task:${task.id}`)))
    .toMatchObject({ messages: [{ role: 'user', text: '修复设置页' }] })
  expect(requestPass).toHaveBeenCalledOnce()
})

it('deduplicates create retries, rejects an id reused for different text, and ignores forged actor fields', () => {
  const body = { text: '检查首页', requestId: id('retry') }
  const first = tasks.create(body)
  expect(tasks.create(body)).toEqual(first)
  expect(() => tasks.create({ ...body, text: '替换内容' })).toThrow(WebTaskError)
  expect(() => tasks.create({ ...body, requestId: id('forged'), actor: { source: 'github', id: 'admin' } })).toThrow()
  expect(store.read.threadTriggers(`web:${first.id}`)).toHaveLength(1)
  expect(requestPass).toHaveBeenCalledOnce()
})

it('adds follow-up messages to the same thread and keeps every message aligned with an Engine trigger', () => {
  const task = tasks.create({ text: '先查看登录页', requestId: id('first') })
  const updated = tasks.followup(task.id, { text: '顺便检查移动端', requestId: id('next') })

  expect(updated.messages.map(message => message.text)).toEqual(['先查看登录页', '顺便检查移动端'])
  expect(store.threads.get(`web:${task.id}`)?.pending).toEqual(updated.messages.map(message => message.id))
  for (const message of updated.messages) expect(store.triggers.get(message.id)?.threads).toEqual([{ source: 'web', id: task.id }])
  expect(requestPass).toHaveBeenCalledTimes(2)
})

it('routes a Web status follow-up through Router and reads a completed Ticket without changing worker state', () => {
  const task = tasks.create({ text: '完成个人报告', requestId: id('router-start') })
  const accepted = engine.decide(task.messages[0]!.id, { kind: 'accept', title: '个人报告', scope: 'small', reason: 'explicit request' })
  const ticketId = accepted.ticketId!
  const assignment = store.tickets.get(ticketId)!.assignments[0]!
  engine.assignmentStarted(ticketId, assignment.id)
  engine.report(ticketId, { state: 'ready', summary: '报告已完成。' })
  const before = store.tickets.get(ticketId)!
  const threadBefore = store.threads.get(`web:${task.id}`)!

  const followed = tasks.followup(task.id, { text: '现在进度到哪了？', requestId: id('router-status') })
  const trigger = store.triggers.get(followed.messages.at(-1)!.id)!
  expect(trigger.routing).toBe('router')
  expect(store.triggers.disposition(trigger.id)).toMatchObject({ routing: 'pending', matched: [ticketId], fanout: [] })
  expect(engine.status(ticketId, trigger.id)).toMatchObject({ ticket_id: ticketId, stage: { stage: 'ended' }, outcome: 'completed' })

  const reply = engine.reply({ purpose: 'status', ticketId, triggerId: trigger.id, text: '任务已完成。' })
  expect(reply).toMatchObject({ status: 'pending', snapshot: { ticket_id: ticketId, outcome: 'completed' } })
  expect(store.tickets.get(ticketId)).toEqual(before)
  expect(store.threads.get(`web:${task.id}`)?.subscriptions).toEqual(threadBefore.subscriptions)
  expect(store.tickets.get(ticketId)?.inputs).toEqual(before.inputs)
  expect(store.tickets.get(ticketId)?.ended).toEqual(before.ended)
})

it('persists assistant replies once through the Web channel even when delivery is retried', async () => {
  const task = tasks.create({ text: '整理文档', requestId: id('reply') })
  const web = sources.kind('web')!
  const message: OutboundMessage = { id: 'assistant-reply-1', channel: { source: 'web', thread: `web:${task.id}`,
    address: { conversation: task.id } }, text: '我开始整理。', kind: 'reply', ticketId: 'ticket-1' }

  expect(await web.channel!.send({} as never, message)).toBe('sent')
  expect(await web.channel!.send({} as never, message)).toBe('sent')
  expect(sources.channelAllowed({ source: 'web', address: { conversation: task.id } })).toBe(true)
  expect(tasks.get(task.id).messages.filter(item => item.id === message.id)).toEqual([
    expect.objectContaining({ role: 'assistant', text: '我开始整理。' }),
  ])
})

it('verifies, persists and serves only delivered Web artifacts under the current owner authorization', async () => {
  const task = tasks.create({ text: '整理报告', requestId: id('artifact') })
  const other = tasks.create({ text: '另一段对话', requestId: id('other') })
  const work = join(directory, 'work', 'ticket-1')
  mkdirSync(work, { recursive: true })
  const source = join(work, 'report.txt')
  writeFileSync(source, 'original snapshot bytes')
  const artifact = await artifacts.stage('ticket-1', work, source, '交付报告.txt', 'file')
  writeFileSync(source, 'edited after staging')
  const message: OutboundMessage = { id: 'assistant-artifact-1', channel: { source: 'web', thread: `web:${task.id}`,
    address: { conversation: task.id } }, text: '报告已完成。', kind: 'reply', ticketId: 'ticket-1', artifacts: [artifact.id] }
  const web = sources.kind('web')!

  expect(await web.channel!.send({} as never, message)).toBe('sent')
  expect(await web.channel!.send({} as never, message)).toBe('sent')
  expect(tasks.get(task.id).messages.filter(item => item.id === message.id)).toEqual([
    expect.objectContaining({ role: 'assistant', text: '报告已完成。', artifacts: [{ id: artifact.id, ticketId: 'ticket-1', name: '交付报告.txt', size: artifact.size, kind: 'file' }] }),
  ])
  await expect(tasks.artifact(task.id, artifact.id)).resolves.toMatchObject({ id: artifact.id, path: artifact.path })
  expect(readFileSync(artifact.path, 'utf8')).toBe('original snapshot bytes')
  await expect(tasks.artifact(other.id, artifact.id)).rejects.toMatchObject({ status: 404 })
  await expect(tasks.artifact(task.id, 'artifact_not-delivered')).rejects.toMatchObject({ status: 404 })

  enableWeb(true, false)
  expect(sources.channelAllowed({ source: 'web', address: { conversation: task.id } })).toBe(false)
  await expect(tasks.artifact(task.id, artifact.id)).rejects.toMatchObject({ status: 409 })
  enableWeb(false, true)
  expect(sources.channelAllowed({ source: 'web', address: { conversation: task.id } })).toBe(false)
  await expect(tasks.artifact(task.id, artifact.id)).rejects.toMatchObject({ status: 409 })
})

it('drops a Web artifact delivery when owner authorization is revoked during snapshot verification', async () => {
  const task = tasks.create({ text: '生成草稿', requestId: id('artifact-race') })
  const work = join(directory, 'work', 'ticket-race')
  mkdirSync(work, { recursive: true })
  const source = join(work, 'draft.txt')
  writeFileSync(source, 'draft')
  const artifact = await artifacts.stage('ticket-race', work, source)
  const verify = artifacts.verify.bind(artifacts)
  artifacts.verify = async (artifactId, ticketId) => {
    const checked = await verify(artifactId, ticketId)
    enableWeb(false, true)
    return checked
  }
  const message: OutboundMessage = { id: 'assistant-artifact-race', channel: { source: 'web', thread: `web:${task.id}`,
    address: { conversation: task.id } }, text: '生成完成', kind: 'reply', ticketId: 'ticket-race', artifacts: [artifact.id] }

  await expect(sources.kind('web')!.channel!.send({} as never, message)).resolves.toBe('gone')
  expect(tasks.get(task.id).messages.some(item => item.id === message.id)).toBe(false)
})

it('rejects creation after the Web source is disabled or owner authorization is revoked', () => {
  enableWeb(true, false)
  expect(() => tasks.create({ text: 'task', requestId: id('off') })).toThrow(/来源已关闭/)
  enableWeb(false, true)
  expect(() => tasks.create({ text: 'task', requestId: id('owner') })).toThrow(/个人账号授权已关闭/)
})

it('retains conversations after reopening the persistent Store and paginates by updated time', () => {
  const first = tasks.create({ text: '任务甲', requestId: id('pagea') })
  const second = tasks.create({ text: '任务乙', requestId: id('pageb') })
  store.close()
  store = new Store(join(directory, 'orchestrator.sqlite'))
  tasks = new WebTasks({ store, mode: () => 'personal', configured: () => true, health: () => ({}),
    receive: trigger => engine.receive(trigger), requestPass })

  expect(tasks.get(first.id).messages[0]?.text).toBe('任务甲')
  expect(tasks.get(second.id).messages[0]?.text).toBe('任务乙')
  expect(tasks.list(0, 1)).toMatchObject({ items: [{ id: second.id }], next_offset: 1 })
  expect(tasks.list(1, 1)).toMatchObject({ items: [{ id: first.id }], next_offset: null })
})

it('reports paused tasks as queued work while the executor is paused', () => {
  const task = tasks.create({ text: '等候继续', requestId: id('paused') })
  store.saveSettings(SettingsSchema.parse({ ...store.settings(), paused: true }))
  expect(tasks.get(task.id).status).toBe('paused')
  expect(store.threads.get(`web:${task.id}`)?.pending).toContain(task.messages[0]?.id)
})
