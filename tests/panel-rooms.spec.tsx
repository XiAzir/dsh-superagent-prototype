// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { act } from 'react'
import { zh } from '../src/client/locales.ts'
import { usePanel, mount, click, type, field, at, text, find, all, settle } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()

const taskRow = (title: string) => {
  const row = all('.sa-task-row').find(item => item.querySelector('.sa-task-row-title')?.textContent === title)
  if (!row) throw new Error(`No task row titled ${title}`)
  return row
}
const detailsTab = (name: string) => find(name, '.sa-detail-tabs [role="tab"]')

async function mentionWorker(name = '测试 Worker') {
  await type(field<HTMLTextAreaElement>(zh['room.message']), '@' + name)
  await click(all('[role="option"]')[0]!)
  const router = find('交给调度助手')
  if (router.getAttribute('aria-pressed') === 'true') await click(router)
}

it('starts on the workbench, uses four primary pages, and separates task conversation from collaboration and execution', async () => {
  server.setup.machine.mode = 'personal'
  await mount()
  expect(document.querySelector('.sa-shell-tabs [role="tab"][aria-selected="true"]')?.id).toBe('dt-tab-overview')
  expect(all('.sa-shell-tabs [role="tab"]').map(item => item.textContent)).toEqual(['工作台', '任务', '个人助理', '设置'])
  await click(document.getElementById('dt-tab-rooms')!)
  expect(taskRow('前端 Worker').querySelector('.sa-task-row-summary')?.textContent).toBe('正在更新页面')
  await click(taskRow('前端 Worker'))
  expect(document.querySelector('.sa-task-title h2')?.textContent).toBe('前端 Worker')
  expect(detailsTab('对话').getAttribute('aria-selected')).toBe('true')
  expect(all('[data-message-id]').map(item => item.dataset.messageId)).toEqual(['room-m1', 'room-m5'])
  expect(document.querySelector('.sa-task-brief')?.textContent).toContain('验证报告已交付。')
  expect(document.querySelector('.sa-task-brief')?.textContent).toContain('下载 任务群验收结果.zip')
  expect(text()).not.toContain('Worker 职责：修复前端显示问题')
  expect(text()).not.toContain('运行命令：pnpm test')
  expect(server.requests.some(request => request.path.includes('workers/worker-alpha-1234/activity'))).toBe(false)

  await click(detailsTab('执行详情'))
  expect(text()).toContain('前端 Worker')
  expect(text()).toContain('测试 Worker')
  expect(text()).not.toContain('PASS 3 tests')
  await click(zh['room.showActivity'])
  expect(server.requests.some(request => request.path === 'rooms/web%3Ademo/workers/worker-alpha-1234/activity?offset=0&limit=50'
    || request.path === 'rooms/web:demo/workers/worker-alpha-1234/activity?offset=0&limit=50')).toBe(true)
  expect(document.querySelector('.dt-room-activity pre')?.textContent).toContain('PASS 3 tests')
  expect(document.querySelector('.dt-room-activity button[aria-expanded]')).toBeNull()

  await click(detailsTab('协作动态'))
  expect(text()).toContain('线程协作消息')
  expect(document.querySelector('[data-message-id="room-m4"]')?.textContent).toContain('Worker 职责：修复前端显示问题')
  expect(all('[data-message-id]')).toHaveLength(5)
  await click(document.querySelector('[data-message-id="room-m4"] button') as HTMLElement)
  expect(document.querySelector('[data-message-id="room-m4"] pre')?.textContent).toBe('仅处理面板样式与交互。')
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

  await mentionWorker()
  await type(input, '只发给测试 Worker')
  await click(zh['room.send'])
  const second = server.requests.filter(request => request.path.endsWith('/messages')).at(-1)!
  expect(second.body).toMatchObject({ text: '只发给测试 Worker', router: false, mentions: ['worker-beta-5678'] })
  expect((second.body as { requestId: string }).requestId).not.toBe((first.body as { requestId: string }).requestId)
  expect(input.value).toBe('')
  await type(input, '@已停止')
  expect(all('[role="option"]')).toHaveLength(1)
  expect(all('[role="option"]')[0]?.textContent).toContain('执行成员 3')
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
  expect(detailsTab('对话').getAttribute('aria-selected')).toBe('true')
  expect(document.querySelector('#sa-room-content')?.textContent).toContain('请处理任务')
  expect(server.requests.some(request => request.path === 'web/tasks/demo')).toBe(false)
  await click(detailsTab('交付物1'))
  expect(document.querySelector('.sa-artifact-list')?.textContent).toContain('下载 任务群验收结果.zip')
})

it('refreshes the room list without discarding the existing paged rooms', async () => {
  server.setup.machine.mode = 'personal'
  const original = server.rooms.items[0]!
  server.rooms.items.push(...Array.from({ length: 54 }, (_, index) => ({ ...original, key: `qq:history-${index + 1}`,
    title: `历史任务 ${index + 1}`, source: 'qq', workers: [] })))
  await mount()
  await click(document.getElementById('dt-tab-rooms')!)
  await click(zh.loadMore)
  expect(taskRow('历史任务 54')).toBeDefined()
  server.rooms.items.unshift({ ...server.rooms.items[0]!, key: 'qq:group-9', title: 'QQ 来源的新任务', source: 'qq',
    workers: [], updatedAt: new Date().toISOString() })
  const before = server.requests.filter(request => request.path.startsWith('rooms?')).length
  await vi.waitFor(async () => {
    await settle()
    expect(server.requests.filter(request => request.path.startsWith('rooms?')).length).toBeGreaterThan(before)
    expect(taskRow('QQ 来源的新任务')).toBeDefined()
  }, { timeout: 5200, interval: 40 })
  expect(taskRow('前端 Worker')).toBeDefined()
  expect(taskRow('历史任务 54')).toBeDefined()
}, 10000)

it('keeps an older page visible when polling adds newer messages', async () => {
  const room = server.rooms.views['web:demo']!
  room.messages = Array.from({ length: 52 }, (_, index) => ({ id: `history-${index}`, at: new Date(Date.UTC(2026, 10, 1, 0, index)).toISOString(),
    kind: 'collaboration' as const, actor: { role: 'worker' as const, name: '前端 Worker' }, text: `历史消息 ${index}`, audience: 'thread' as const }))
  room.updatedAt = room.messages.at(-1)!.at
  at({ page: 'rooms', id: room.key })
  server.setup.machine.mode = 'personal'
  await mount()
  await click(detailsTab('协作动态'))
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
}, 10000)

it('flags a selected Worker that stops during the room and disables that stale target', async () => {
  at({ page: 'rooms', id: 'web:demo' })
  server.setup.machine.mode = 'personal'
  await mount()
  await mentionWorker()
  server.rooms.views['web:demo']!.workers.find(worker => worker.id === 'worker-beta-5678')!.active = false
  await new Promise<void>((resolve, reject) => {
    const stop = setTimeout(() => reject(new Error('room poll did not update worker state')), 5200)
    const poll = setInterval(() => {
      if (text().includes('所选成员已结束或离开任务')) { clearInterval(poll); clearTimeout(stop); resolve() }
    }, 40)
  })
  await type(field<HTMLTextAreaElement>(zh['room.message']), '目标状态发生变化')
  expect(document.querySelector('.mc-route-hint')?.textContent).toContain('开启 R 可继续安排')
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

it('preserves task search, status, source, sort and list position when returning from task details', async () => {
  server.setup.machine.mode = 'personal'
  const original = server.rooms.views['web:demo']!
  const completed = { ...original, key: 'qq:completed', title: 'QQ 私聊', source: 'qq', workers: [
    { ...original.workers[0]!, id: 'worker-completed', title: '整理排休表', stage: 'ended', active: false, summary: '已输出工作簿' },
  ] }
  const reference = { ...completed, key: 'web:reference', source: 'web', workers: [
    { ...completed.workers[0]!, id: 'worker-reference', title: '整理排休表的参考材料' },
  ] }
  server.rooms.items.push(completed, reference)
  server.rooms.views[completed.key] = completed
  await mount()
  await click(document.getElementById('dt-tab-rooms')!)
  await type(field<HTMLInputElement>('搜索任务'), '排休')
  expect(all('.sa-task-row')).toHaveLength(2)
  await click(all('.sa-task-filters button').find(item => item.textContent?.startsWith('已结束'))!)
  await type(field<HTMLSelectElement>('任务来源'), 'qq')
  await type(field<HTMLSelectElement>('任务排序'), 'title')
  expect(all('.sa-task-row')).toHaveLength(1)
  const page = document.querySelector('.dt-page') as HTMLElement
  page.scrollTop = 640
  await click(taskRow('整理排休表'))
  expect(document.querySelector('.sa-task-title h2')?.textContent).toBe('整理排休表')
  await click('全部任务')
  expect(field<HTMLInputElement>('搜索任务').value).toBe('排休')
  expect(field<HTMLSelectElement>('任务来源').value).toBe('qq')
  expect(field<HTMLSelectElement>('任务排序').value).toBe('title')
  expect(all('.sa-task-filters button').find(item => item.textContent?.startsWith('已结束'))?.getAttribute('aria-pressed')).toBe('true')
  expect(all('.sa-task-row')).toHaveLength(1)
  await vi.waitFor(() => expect(document.querySelector('.dt-page')?.scrollTop).toBe(640))
  await type(field<HTMLInputElement>('搜索任务'), '找不到的任务关键词')
  expect(text()).toContain('换个条件找找')
  await click('清除筛选')
  expect(field<HTMLInputElement>('搜索任务').value).toBe('')
  expect(field<HTMLSelectElement>('任务来源').value).toBe('all')
  expect(all('.sa-task-row')).toHaveLength(3)
})

it('restores a room draft and its selected recipient after leaving the page without leaking it into another task', async () => {
  server.setup.machine.mode = 'personal'
  const original = server.rooms.views['web:demo']!
  const other = { ...original, key: 'web:other', title: '另一个任务', workers: [
    { ...original.workers[0]!, id: 'worker-other', title: '独立任务' },
  ] }
  server.rooms.items.push(other)
  server.rooms.views[other.key] = other
  at({ page: 'rooms', id: original.key })
  await mount()
  await mentionWorker()
  await type(field<HTMLTextAreaElement>(zh['room.message']), '离开页面后继续编辑的要求\n保留第二行')
  await click(document.getElementById('dt-tab-overview')!)
  await click(document.getElementById('dt-tab-rooms')!)
  await click(taskRow('独立任务'))
  expect(field<HTMLTextAreaElement>(zh['room.message']).value).toBe('')
  expect(find('交给调度助手').getAttribute('aria-pressed')).toBe('true')
  expect(all('.mc-mention-chip')).toHaveLength(0)
  await click('全部任务')
  await click(taskRow('前端 Worker'))
  expect(field<HTMLTextAreaElement>(zh['room.message']).value).toBe('离开页面后继续编辑的要求\n保留第二行')
  expect(find('交给调度助手').getAttribute('aria-pressed')).toBe('false')
  expect(document.querySelector('.mc-mention-chip')?.textContent).toContain('执行成员 2')
  expect(server.requests.filter(request => request.method === 'POST' && request.path.endsWith('/messages'))).toHaveLength(0)
})

it('reuses a failed room delivery request after navigating away and restoring the draft', async () => {
  server.setup.machine.mode = 'personal'
  at({ page: 'rooms', id: 'web:demo' })
  await mount()
  server.roomMessageError = '临时断线'
  await mentionWorker()
  await type(field<HTMLTextAreaElement>(zh['room.message']), '恢复后重试同一条要求')
  await click(zh['room.send'])
  const failed = server.requests.filter(request => request.path.endsWith('/messages')).at(-1)!
  await click('全部任务')
  await click(taskRow('前端 Worker'))
  expect(field<HTMLTextAreaElement>(zh['room.message']).value).toBe('恢复后重试同一条要求')
  delete server.roomMessageError
  await click(zh['room.send'])
  const sent = server.requests.filter(request => request.path.endsWith('/messages')).at(-1)!
  expect(sent.body).toEqual(failed.body)
  expect(field<HTMLTextAreaElement>(zh['room.message']).value).toBe('')
})

it('starts a new delivery when the person cancels a failed draft and re-enters the same text', async () => {
  server.setup.machine.mode = 'personal'
  at({ page: 'rooms', id: 'web:demo' })
  await mount()
  server.roomMessageError = '临时断线'
  await type(field<HTMLTextAreaElement>(zh['room.message']), '取消后重新交办的内容')
  await click(zh['room.send'])
  const failed = server.requests.filter(request => request.path.endsWith('/messages')).at(-1)!
  await click(zh.cancel)
  expect(field<HTMLTextAreaElement>(zh['room.message']).value).toBe('')
  await type(field<HTMLTextAreaElement>(zh['room.message']), '取消后重新交办的内容')
  delete server.roomMessageError
  await click(zh['room.send'])
  const sent = server.requests.filter(request => request.path.endsWith('/messages')).at(-1)!
  expect((sent.body as { requestId: string }).requestId).not.toBe((failed.body as { requestId: string }).requestId)
})
