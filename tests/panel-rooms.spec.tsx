// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { act } from 'react'
import { zh } from '../src/client/locales.ts'
import { usePanel, mount, click, type, field, at, text, find, all } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()

it('opens Rooms by default in personal mode and shows Router, multiple Workers, audiences, and lazy details', async () => {
  server.setup.machine.mode = 'personal'
  await mount()
  expect(document.querySelector('[role="tab"][aria-selected="true"]')?.id).toBe('dt-tab-rooms')
  expect(text()).toContain('改进任务面板')
  await click('改进任务面板')
  expect(text()).toContain('前端 Worker')
  expect(text()).toContain('测试 Worker')
  expect(text()).toContain('发给 Router')
  expect(text()).toContain('线程协作消息')
  expect(text()).toContain('下载 任务群验收结果.zip')
  expect(text()).not.toContain('PASS 3 tests')
  expect(server.requests.some(request => request.path.includes('workers/worker-alpha-1234/activity'))).toBe(false)

  await click(zh['room.showActivity'])
  expect(server.requests.some(request => request.path === 'rooms/web%3Ademo/workers/worker-alpha-1234/activity?offset=0&limit=50'
    || request.path === 'rooms/web:demo/workers/worker-alpha-1234/activity?offset=0&limit=50')).toBe(true)
  expect(text()).not.toContain('PASS 3 tests')
  await click(zh['room.showDetails'])
  expect(text()).toContain('PASS 3 tests')
  await click(zh['room.showDetails'])
  await click(zh['room.showDetails'])
  expect(text()).toContain('仅处理面板样式与交互。')
  expect(all('[data-message-id]')).toHaveLength(5)
})

it('labels a new message for Router by default and sends a selected Worker message only to that Worker', async () => {
  at({ page: 'rooms', id: 'web:demo' })
  server.setup.machine.mode = 'personal'
  await mount()
  const input = field<HTMLTextAreaElement>(zh['room.message'])
  await type(input, '继续从 Router 开始')
  await click(zh['room.send'])
  const first = server.requests.filter(request => request.path === 'rooms/web%3Ademo/messages' || request.path === 'rooms/web:demo/messages').at(-1)!
  expect(first.method).toBe('POST')
  expect(first.body).toMatchObject({ text: '继续从 Router 开始' })
  expect(first.body).not.toHaveProperty('recipient')

  const recipient = field<HTMLSelectElement>(zh['room.recipient'])
  await type(recipient, 'worker-beta-5678')
  await type(input, '只发给测试 Worker')
  await click(zh['room.send'])
  const second = server.requests.filter(request => request.path.endsWith('/messages')).at(-1)!
  expect(second.body).toMatchObject({ text: '只发给测试 Worker', recipient: 'worker-beta-5678' })
  expect((second.body as { requestId: string }).requestId).not.toBe((first.body as { requestId: string }).requestId)
  expect(input.value).toBe('')
  const optionValues = [...recipient.options].map(option => option.value)
  expect(optionValues).not.toContain('worker-stopped')
})

it('keeps an idempotency key across failed retry, while canceling the draft resets it', async () => {
  at({ page: 'rooms', id: 'web:demo' })
  server.setup.machine.mode = 'personal'
  await mount()
  server.roomMessageError = '暂时无法送达'
  await type(field<HTMLTextAreaElement>(zh['room.message']), '稳定重试内容')
  await click(zh['room.send'])
  const first = server.requests.filter(request => request.path.endsWith('/messages')).at(-1)!
  expect(text()).toContain('暂时无法送达')
  delete server.roomMessageError
  await click(zh.retry)
  const requests = server.requests.filter(request => request.path.endsWith('/messages'))
  expect(requests).toHaveLength(2)
  expect(requests[1]!.body).toEqual(first.body)

  server.roomMessageError = '再试一次'
  await type(field<HTMLTextAreaElement>(zh['room.message']), '待取消的草稿')
  await click(zh['room.send'])
  const failed = server.requests.filter(request => request.path.endsWith('/messages')).at(-1)!
  await click(zh.cancel)
  await type(field<HTMLTextAreaElement>(zh['room.message']), '取消后新内容')
  delete server.roomMessageError
  await click(zh['room.send'])
  const afterCancel = server.requests.filter(request => request.path.endsWith('/messages')).at(-1)!
  expect(afterCancel.body).not.toEqual(failed.body)
})

it('supports a deep-linked room route', async () => {
  expect(() => at({ page: 'rooms', id: 'web:demo' })).not.toThrow()
  server.setup.machine.mode = 'personal'
  await mount()
  expect(document.querySelector('[data-message-id="room-m1"]')).not.toBeNull()
  await click(zh['room.openTaskConversation'])
  expect(server.requests.some(request => request.path === 'web/tasks/demo')).toBe(true)
})

it('refreshes the room list without discarding the existing paged rooms', async () => {
  server.setup.machine.mode = 'personal'
  await mount()
  server.rooms.items.unshift({ ...server.rooms.items[0]!, key: 'qq:group-9', title: 'QQ 来源的新任务', source: 'qq',
    workers: [], updatedAt: new Date().toISOString() })
  const before = server.requests.filter(request => request.path.startsWith('rooms?')).length
  await new Promise<void>((resolve, reject) => {
    const stop = setTimeout(() => reject(new Error('room list did not poll')), 5200)
    const poll = setInterval(() => {
      if (document.body.textContent?.includes('QQ 来源的新任务') && server.requests.filter(request => request.path.startsWith('rooms?')).length > before) {
        clearInterval(poll); clearTimeout(stop); resolve()
      }
    }, 40)
  })
  expect(text()).toContain('改进任务面板')
  expect(text()).toContain('QQ 来源的新任务')
})

it('keeps an older page visible when polling adds newer messages', async () => {
  const room = server.rooms.views['web:demo']!
  room.messages = Array.from({ length: 52 }, (_, index) => ({ id: `history-${index}`, at: new Date(Date.UTC(2026, 10, 1, 0, index)).toISOString(),
    kind: 'collaboration' as const, actor: { role: 'worker' as const, name: '前端 Worker' }, text: `历史消息 ${index}`, audience: 'thread' as const }))
  room.updatedAt = room.messages.at(-1)!.at
  at({ page: 'rooms', id: room.key })
  server.setup.machine.mode = 'personal'
  await mount()
  expect(all('[data-message-id]')).toHaveLength(50)
  await click(zh.loadEarlier)
  expect(document.querySelector('[data-message-id="history-0"]')).not.toBeNull()
  expect(all('[data-message-id]')).toHaveLength(2)
  const beforePoll = server.requests.filter(request => request.path.startsWith('rooms/web:demo?')).length
  await act(async () => { room.messages.push({ id: 'history-latest', at: new Date().toISOString(), kind: 'collaboration',
    actor: { role: 'worker', name: '测试 Worker' }, text: '轮询新消息', audience: 'thread' }) })
  await new Promise<void>((resolve, reject) => {
    const stop = setTimeout(() => reject(new Error('room poll did not refresh')), 5200)
    const poll = setInterval(() => {
      if (server.requests.filter(request => request.path.startsWith('rooms/web:demo?')).length > beforePoll) { clearInterval(poll); clearTimeout(stop); resolve() }
    }, 40)
  })
  expect(document.querySelector('[data-message-id="history-0"]')).not.toBeNull()
  expect(document.querySelector('[data-message-id="history-latest"]')).toBeNull()
  await click(zh['room.loadNewer'])
  await click(zh['room.loadNewer'])
  expect(document.querySelector('[data-message-id="history-latest"]')).not.toBeNull()
  await click(zh.loadEarlier)
  expect(document.querySelector('[data-message-id="history-0"]')).not.toBeNull()
  expect(all('[data-message-id]').length).toBeLessThanOrEqual(50)
})

it('flags a selected Worker that stops during the room and disables that stale target', async () => {
  at({ page: 'rooms', id: 'web:demo' })
  server.setup.machine.mode = 'personal'
  await mount()
  const recipient = field<HTMLSelectElement>(zh['room.recipient'])
  await type(recipient, 'worker-beta-5678')
  server.rooms.views['web:demo']!.workers.find(worker => worker.id === 'worker-beta-5678')!.active = false
  await new Promise<void>((resolve, reject) => {
    const stop = setTimeout(() => reject(new Error('room poll did not update worker state')), 5200)
    const poll = setInterval(() => {
      if (text().includes(zh['room.workerUnavailable'].replace('{id}', 'worker-b'))) { clearInterval(poll); clearTimeout(stop); resolve() }
    }, 40)
  })
  await type(field<HTMLTextAreaElement>(zh['room.message']), '目标状态发生变化')
  expect(all('p.dt-error').some(element => element.textContent?.includes('worker-b'))).toBe(true)
  expect(document.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true)
})

it('keeps the message draft while the Executor is paused and blocks submit', async () => {
  at({ page: 'rooms', id: 'web:demo' })
  server.setup.machine.mode = 'personal'
  server.rooms.views['web:demo']!.paused = true
  await mount()
  await type(field<HTMLTextAreaElement>(zh['room.message']), '暂停期间保留的草稿')
  const before = server.requests.filter(request => request.path.endsWith('/messages')).length
  await click(zh['room.send'])
  expect(field<HTMLTextAreaElement>(zh['room.message']).value).toBe('暂停期间保留的草稿')
  expect(server.requests.filter(request => request.path.endsWith('/messages'))).toHaveLength(before)
  expect(document.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true)
  expect(text()).toContain(zh['room.paused'])
})
