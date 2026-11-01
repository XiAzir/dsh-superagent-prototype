import { once } from 'node:events'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import type { OutboundMessage, Trigger } from '../src/core/index.ts'
import { QqBridge, QqConfigSchema } from '../src/app/qq-source.ts'
import { SettingsSchema } from '../src/policy.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

const owner = '12345', selfId = '98765', groupId = '23456', otherGroup = '34567'
let host: Host | undefined
let server: WebSocketServer | undefined
let bridge: QqBridge | undefined
let unregister: (() => void) | undefined
let authHeaders: (string | undefined)[] = []
let sent: { action: string; text: string; params: Record<string, unknown> }[] = []
let confirmed: { action: string; text: string; params: Record<string, unknown> }[] = []
let failSendNumber: number | undefined
let sendCount = 0
let rpcHandlers: Record<string, (params: Record<string, unknown>) => unknown> = {}

afterEach(async () => {
  await bridge?.stop(); bridge = undefined
  unregister?.(); unregister = undefined
  await host?.stop(); host = undefined
  if (server) {
    for (const socket of server.clients) socket.terminate()
    await new Promise<void>(resolve => server!.close(() => resolve()))
    server = undefined
  }
  authHeaders = []; sent = []; confirmed = []; failSendNumber = undefined; sendCount = 0
  rpcHandlers = {}
})

async function startQq(options: Record<string, unknown> = {}) {
  host = await startRuntime()
  server = new WebSocketServer({ port: 0 })
  server.on('connection', (socket, request) => {
    authHeaders.push(request.headers.authorization)
    socket.on('message', raw => {
      const packet = JSON.parse(raw.toString()) as { action: string; params?: Record<string, unknown>; echo: string }
      if (packet.action === 'get_login_info') {
        socket.send(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: Number(selfId) }, echo: packet.echo }))
      } else if (rpcHandlers[packet.action]) {
        Promise.resolve(rpcHandlers[packet.action]!(packet.params ?? {})).then(data => {
          socket.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo: packet.echo }))
        })
      } else if (packet.action === 'send_private_msg' || packet.action === 'send_group_msg') {
        sendCount++
        const params = packet.params ?? {}
        const segments = Array.isArray(params.message) ? params.message as { type?: string; data?: { text?: string } }[] : []
        const text = segments.filter(segment => segment.type === 'text').map(segment => segment.data?.text ?? '').join('')
        const item = { action: packet.action, text, params }
        sent.push(item)
        if (sendCount === failSendNumber) socket.send(JSON.stringify({ status: 'failed', retcode: 1200, data: {}, echo: packet.echo }))
        else { confirmed.push(item); socket.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 7000 + sendCount }, echo: packet.echo })) }
      }
    })
  })
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected OneBot test server address')
  const url = `ws://127.0.0.1:${address.port}`
  const store = host.runtime.store
  const settings = store.settings()
  settings.sources.qq = { enabled: true, config: QqConfigSchema.parse({ connection: 'forward', url,
    privateMessages: true, groups: [{ id: groupId, name: 'Integration test' }], replyChunkSize: 200, ...options }) }
  settings.policy.sources.qq = { allowed: [{ id: owner, name: 'Owner' }], admission: {} }
  store.saveSettings(SettingsSchema.parse(settings))
  token = 'integration-token'
  bridge = new QqBridge({ store, stateDir: host.runtime.machine.stateDir, artifacts: host.runtime.artifacts,
    configured: () => true, receive: trigger => host!.runtime.receive(trigger),
    report: () => {}, resolveToken: async () => token, writeToken: async (_name, value) => { token = value } })
  unregister = host.runtime.sources.register(bridge.kind)
  token = 'integration-token'
  await bridge.start()
  await waitFor(async () => (await bridge!.status()).state === 'connected')
  return { runtime: host.runtime, store, bridge, url }
}

let token = 'integration-token'

function event(messageId: number, type: 'private' | 'group', userId: string, content: unknown, extra: Record<string, unknown> = {}) {
  return { post_type: 'message', message_type: type, self_id: Number(selfId), user_id: Number(userId),
    ...(type === 'group' ? { group_id: Number(groupId) } : {}), message_id: messageId, time: 1_800_000_000 + messageId,
    message: content, sender: { nickname: userId === owner ? 'Owner' : 'Other' }, ...extra }
}

async function push(value: unknown): Promise<void> {
  const socket = [...server!.clients][0]
  if (!socket) throw new Error('NapCat did not connect')
  socket.send(JSON.stringify(value))
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const expires = Date.now() + 3000
  while (Date.now() < expires) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for QQ integration state')
}

const qqTriggers = (runtime: Host['runtime']) => runtime.store.read.recentTriggers(0, 100).filter(trigger => trigger.source === 'qq')
  .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
const outbound = (id: string, channel: NonNullable<Trigger['channel']>, text: string): OutboundMessage => ({ id, channel, text, kind: 'reply' })

describe('QQ source with a real OneBot WebSocket and Runtime', () => {
  it('exposes a source file as a durable authorized read reference and delivers an immutable task artifact through the Outbox', async () => {
    const { runtime, bridge: qq, store } = await startQq()
    const original = join(runtime.machine.stateDir, 'napcat-source.xlsx')
    await writeFile(original, 'original sheet bytes')
    let fetches = 0, uploads = 0
    rpcHandlers.get_file = params => {
      expect(params).toEqual({ file: 'source-file-id' }); fetches++
      return { file: original, file_name: '8月排休表.xlsx', file_size: 20 }
    }
    rpcHandlers.upload_private_file = async params => {
      expect(params.user_id).toBe(owner)
      expect(params.name).toBe('10月排休表.xlsx')
      expect(await readFile(String(params.file), 'utf8')).toBe('October sheet bytes')
      uploads++
      return { file_id: 'uploaded-file-id' }
    }
    await push(event(80, 'private', owner, [{ type: 'file', data: { file: '8月排休表.xlsx', file_id: 'source-file-id', file_size: 20 } }]))
    await waitFor(() => qqTriggers(runtime).length === 1)
    const trigger = qqTriggers(runtime)[0]!
    expect(trigger.attachments?.[0]).toMatchObject({ name: '8月排休表.xlsx', type: 'file', status: 'pending' })
    const accepted = await host!.route({ kind: 'accept', trigger_id: trigger.id, title: 'October sheet', worktree_name: 'october-sheet', acknowledgement: '收到，制作十月排休表。' })
    await runtime.idle()
    const ticketId = (accepted.ticket as { ticket_id: string }).ticket_id
    const workerId = `worker-${ticketId}`
    const attachment = trigger.attachments![0]!
    const downloaded = await host!.runTool(workerId, 'orchestrator_read', { resource: attachment.read })
    expect(downloaded.status).toBe('downloaded')
    expect(await readFile(String(downloaded.path), 'utf8')).toBe('original sheet bytes')
    await host!.runTool(workerId, 'orchestrator_read', { resource: attachment.read })
    expect(fetches).toBe(1)
    expect(host!.deliveries.mock.calls.some(([item]) => item.sessionId === workerId && item.text.includes(attachment.read))).toBe(true)
    const ticket = store.tickets.get(ticketId)!
    await mkdir(ticket.execution!.directory, { recursive: true })
    const output = join(ticket.execution!.directory, '10月排休表.xlsx')
    await writeFile(output, 'October sheet bytes')
    const reported = await host!.runTool(workerId, 'orchestrator_report', { state: 'ready', summary: '十月表格已校验。', artifacts: [{ path: output, name: '10月排休表.xlsx' }] })
    expect(reported.artifacts).toHaveLength(1)
    await writeFile(output, 'changed after reporting')
    await host!.runTool(runtime.masterId, 'orchestrator_reply', { purpose: 'result', ticket_id: ticketId, text: '十月排休表已完成，请查收。' })
    expect(uploads).toBe(1)
    expect(sent.at(-1)?.text).toBe('十月排休表已完成，请查收。')
    const receipt = store.db.prepare('SELECT value FROM outbox WHERE json_extract(value, \'$.ticketId\')=? AND json_extract(value, \'$.kind\')=\'reply\'').get(ticketId) as { value: string }
    await qq.kind.channel!.send({} as never, JSON.parse(receipt.value))
    expect(uploads).toBe(1)
    const revoked = store.settings(); revoked.policy.sources.qq!.allowed = []; store.saveSettings(revoked)
    await expect(qq.kind.attachments!.read(trigger, attachment.id, undefined, new AbortController().signal)).rejects.toThrow('authorized')
  })
  it('keeps QQ connection and receiving settings under the management panel authority', async () => {
    const { runtime } = await startQq()
    const revision = runtime.store.blockRevision('source:qq')
    const source = runtime.store.settings().sources.qq!
    await expect(runtime.settings.save('source:qq', { ...source, config: { ...source.config, url: 'ws://127.0.0.1:19999' } }, revision, 'tool'))
      .rejects.toThrow()
    expect(runtime.store.settings().sources.qq!.config.url).toBe(source.config.url)
    await expect(runtime.settings.save('source:qq', { ...source, enabled: false }, revision, 'panel')).resolves.toMatchObject({ saved: true })
  })
  it('admits owner private and group mentions, rejects unauthorized chats and idle chatter, routes a ticket, and replies in the original thread', async () => {
    const { runtime, store, bridge: qq } = await startQq()
    await push(event(10, 'private', '55555', [{ type: 'text', data: { text: 'unauthorized' } }]))
    await push(event(11, 'group', owner, [{ type: 'text', data: { text: 'not allowed group' } }], { group_id: Number(otherGroup) }))
    await push(event(12, 'group', owner, [{ type: 'text', data: { text: '闲聊' } }]))
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(qqTriggers(runtime)).toHaveLength(0)
    expect(host!.deliveries).not.toHaveBeenCalled()

    const privateEvent = event(20, 'private', owner, [{ type: 'text', data: { text: '请检查登录回归' } }])
    await push(privateEvent)
    await waitFor(() => qqTriggers(runtime).length === 1)
    await push(privateEvent)
    const groupEvent = event(21, 'group', owner, [{ type: 'at', data: { qq: selfId } }, { type: 'text', data: { text: '请修复群聊回归' } }])
    await push(groupEvent)
    await waitFor(() => qqTriggers(runtime).length === 2)
    expect(qqTriggers(runtime).map(trigger => trigger.text)).toEqual(['请检查登录回归', '请修复群聊回归'])
    expect(qqTriggers(runtime)[0]?.channel?.address.recipient_id).toBe(owner)
    expect(qqTriggers(runtime)[1]?.channel?.address.recipient_id).toBe(groupId)

    const trigger = qqTriggers(runtime)[1]!
    const result = await host!.route({ kind: 'accept', trigger_id: trigger.id, title: 'QQ integration ticket', worktree_name: 'qq-integration', acknowledgement: '收到，开始处理。' })
    await runtime.idle()
    await runtime.sendReplies()
    expect(result.ticket).toBeDefined()
    expect(sent.at(-1)).toMatchObject({ action: 'send_group_msg', text: '收到，开始处理。' })
    expect(sent.at(-1)?.params.group_id).toBe(groupId)

    const botReplyId = 7000 + sendCount
    await push(event(22, 'group', owner, [{ type: 'reply', data: { id: String(botReplyId) } }, { type: 'text', data: { text: '补充复现步骤' } }]))
    await waitFor(() => qqTriggers(runtime).length === 3)
    expect(qqTriggers(runtime)[2]?.meta.threadId).toBe(trigger.meta.threadId)
    expect(store.triggers.get(trigger.id)).toBeDefined()
  })

  it('sends confirmed chunks once across a failed retry and refuses delivery after source or owner access is revoked', async () => {
    const { runtime, bridge: qq } = await startQq()
    const trigger = event(30, 'group', owner, [{ type: 'at', data: { qq: selfId } }, { type: 'text', data: { text: '任务' } }])
    await push(trigger)
    await waitFor(() => qqTriggers(runtime).length === 1)
    const received = qqTriggers(runtime)[0]!
    const message = outbound('chunked-message', received.channel!, '甲'.repeat(450))
    failSendNumber = 2
    await expect(qq.kind.channel!.send({} as never, message)).rejects.toThrow('retcode 1200')
    failSendNumber = undefined
    await expect(qq.kind.channel!.send({} as never, message)).resolves.toBe('sent')
    expect(confirmed.map(item => item.text)).toEqual(['甲'.repeat(200), '甲'.repeat(200), '甲'.repeat(50)])
    const attemptedCount = sent.length

    const saved = runtime.store.settings()
    saved.policy.sources.qq!.allowed = []
    runtime.store.saveSettings(saved)
    await expect(qq.kind.channel!.send({} as never, outbound('revoked-owner', received.channel!, '拒绝'))).resolves.toBe('gone')
    const reopened = runtime.store.settings()
    reopened.policy.sources.qq!.allowed = [{ id: owner }]
    reopened.sources.qq!.enabled = false
    runtime.store.saveSettings(reopened)
    await expect(qq.kind.channel!.send({} as never, outbound('closed-source', received.channel!, '拒绝'))).resolves.toBe('gone')
    expect(sent).toHaveLength(attemptedCount)
  })

  it('keeps sender-window follow-ups together, handles /new without a candidate, and restarts safely after token replacement', async () => {
    const { runtime, bridge: qq } = await startQq({ groupFollowups: 'sender-window', sessionMinutes: 30 })
    await push(event(40, 'group', owner, [{ type: 'at', data: { qq: selfId } }, { type: 'text', data: { text: '先开一个任务' } }]))
    await waitFor(() => qqTriggers(runtime).length === 1)
    await push(event(41, 'group', owner, [{ type: 'text', data: { text: '窗口内补充' } }]))
    await waitFor(() => qqTriggers(runtime).length === 2)
    expect(qqTriggers(runtime)[1]?.meta.threadId).toBe(qqTriggers(runtime)[0]?.meta.threadId)
    await push(event(42, 'group', owner, [{ type: 'at', data: { qq: selfId } }, { type: 'text', data: { text: '/new' } }]))
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(qqTriggers(runtime)).toHaveLength(2)
    await push(event(43, 'group', owner, [{ type: 'text', data: { text: '新任务内容' } }]))
    await waitFor(() => qqTriggers(runtime).length === 3)
    expect(qqTriggers(runtime)[2]?.meta.threadId).not.toBe(qqTriggers(runtime)[1]?.meta.threadId)

    const before = await qq.status()
    expect(JSON.stringify(before)).not.toContain('integration-token')
    expect(before.tokenConfigured).toBe(true)
    await qq.setToken('replacement-token')
    await waitFor(async () => authHeaders.length >= 2 && (await qq.status()).state === 'connected')
    const after = await qq.status()
    expect(authHeaders).toEqual(['Bearer integration-token', 'Bearer replacement-token'])
    expect(JSON.stringify(after)).not.toContain('replacement-token')
    expect(JSON.stringify(after)).not.toContain('integration-token')
  })
})
