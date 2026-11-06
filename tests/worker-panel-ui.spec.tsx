// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { WorkerPanel, installWorkerPanel, WORKER_PANEL_KIND } from '../src/client/worker-panel.tsx'
import { zh } from '../src/client/locales.ts'
import type { T } from '../src/client/text.ts'
import type { Call } from '../src/client/api.ts'
import type { WorkerPanelView } from '../src/app/worker-panel.ts'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const t = ((key: keyof typeof zh, args?: Record<string, string | number>) => Object.entries(args ?? {}).reduce((value, [key, data]) => value.replaceAll(`{${key}}`, String(data)), zh[key] ?? key)) as T
const at = '2026-11-06T10:00:00Z'
const data = (sessionId = 'conversation-a'): WorkerPanelView => ({ sessionId, eligible: true, scope: 'conversation', pending: false, paused: false,
  rooms: [{ key: `dsh-session:${sessionId}`, title: '排查服务器过滤器' }], workers: [
    { id: 'w1', title: '验证服务器过滤器', stage: 'working', summary: '已经定位规则，正在重放请求。', sessionId: 'worker-w1', active: true, subscribed: true,
      updatedAt: at, completed: ['读取过滤规则'], pending: ['重放请求', '回归验证'], roomKey: `dsh-session:${sessionId}`, roomKeys: [`dsh-session:${sessionId}`] },
    { id: 'w2', title: '检查请求日志', stage: 'person', action: 'answer', summary: '需要确认测试范围', attention: '是否包含历史请求？', sessionId: 'worker-w2', active: true, subscribed: true,
      updatedAt: at, completed: [], pending: [], roomKey: `dsh-session:${sessionId}`, roomKeys: [`dsh-session:${sessionId}`] },
  ], messages: [
    { id: 'assignment:1', at, kind: 'assignment', actor: { role: 'router', name: 'Router' }, text: '安排 Worker 检查过滤规则', audience: 'worker', ticketId: 'w1', roomKey: `dsh-session:${sessionId}` },
    { id: 'report:1', at, kind: 'report', reportState: 'progress', actor: { role: 'worker', name: '验证服务器过滤器', ticketId: 'w1' }, text: '已读取规则，继续验证', audience: 'record', ticketId: 'w1', roomKey: `dsh-session:${sessionId}` },
    { id: 'report:2', at, kind: 'report', reportState: 'waiting', actor: { role: 'worker', name: '检查请求日志', ticketId: 'w2' }, text: '是否包含历史请求？', audience: 'router', ticketId: 'w2', roomKey: `dsh-session:${sessionId}` },
  ] })
function fakeCall(snapshot: () => WorkerPanelView = () => data()) {
  return vi.fn(async (route: string, args?: { id?: string; query?: { workerId?: string; before?: string }; body?: unknown }) => {
    const view = snapshot()
    if (route === 'GET rooms/:key') return { ...view.rooms[0], writable: true, paused: view.paused, workers: view.workers, earlier: null,
      messages: view.messages.filter(message => !args?.query?.workerId || message.ticketId === args.query.workerId || message.actor.ticketId === args.query.workerId) }
    if (route.endsWith('/activity')) return { items: [], next_offset: null }
    return view
  })
}
let root: Root | undefined, container: HTMLDivElement
const flush = async () => { for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve() }) }
async function render(call: Call, sessionId = 'conversation-a') {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  const openSession = vi.fn(async () => {})
  await act(async () => { root!.render(<WorkerPanel key={sessionId} sessionId={sessionId} call={call} t={t} openSession={openSession} />) }); await flush()
  return { openSession }
}
async function click(selector: string) { await act(async () => { (container.querySelector(selector) as HTMLButtonElement).click() }); await flush() }
async function input(text: string) {
  await act(async () => {
    const element = container.querySelector('textarea')!
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(element, text)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  }); await flush()
}
afterEach(() => { if (root) act(() => root!.unmount()); root = undefined; container?.remove(); sessionStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('keeps member cards beside their scoped progress and conversations, with direct full-session navigation', async () => {
  const callMock = fakeCall(), { openSession } = await render(callMock as unknown as Call)
  expect(container.querySelectorAll('.sa-member-rail .sa-worker')).toHaveLength(2)
  expect(container.textContent).toContain('2 位执行成员 · 1 进行中 · 1 待确认')
  expect(container.querySelectorAll('.sa-group-summary .sa-avatar')).toHaveLength(1)
  expect(container.querySelectorAll('.sa-timeline-entry')).toHaveLength(2)
  await click('.sa-worker[aria-label^="查看执行成员 1"]')
  expect(container.querySelector('.sa-detail-head h3')?.textContent).toBe('验证服务器过滤器')
  expect(container.querySelectorAll('.sa-timeline-entry')).toHaveLength(1)
  expect(container.querySelector('.sa-reading-scroll')?.textContent).not.toContain('是否包含历史请求')
  expect(callMock).toHaveBeenCalledWith('GET rooms/:key', { key: 'dsh-session:conversation-a', query: { workerId: 'w1', limit: 30 } })
  await click('[role="tab"]:nth-child(2)')
  expect(container.querySelectorAll('.sa-message')).toHaveLength(2)
  await click('[aria-label="打开 Worker 1 会话"]')
  expect(openSession).toHaveBeenCalledWith('worker-w1')
})

it('adds members with repeated @ and keeps multi-target direct-send identity through a failed request and remount', async () => {
  let failed = true
  const base = fakeCall(), callMock = vi.fn(async (route: string, args?: unknown) => {
    if (route === 'POST sessions/:id/collaboration' && failed) { failed = false; throw new Error('临时网络故障') }
    return base(route, args as never)
  })
  const call = callMock as unknown as Call, { openSession } = await render(call)
  await input('@执行成员 1'); await click('[role="option"]')
  expect(container.querySelector('[role="listbox"]')).toBeNull()
  await input('@执行成员 2'); await click('[role="option"]')
  expect(container.querySelectorAll('.mc-mention-chip')).toHaveLength(2)
  await click('[aria-label="交给调度助手"]'); await input('包含今天的请求')
  const send = async () => { await act(async () => { container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) }); await flush() }
  await send()
  expect(container.textContent).toContain('临时网络故障')
  await act(async () => { root!.render(<WorkerPanel key="restored" sessionId="conversation-a" call={call} t={t} openSession={openSession} />) }); await flush()
  expect(container.querySelector('textarea')?.value).toBe('包含今天的请求')
  expect(container.querySelectorAll('.mc-mention-chip')).toHaveLength(2)
  expect(container.querySelector('[aria-label="交给调度助手"]')?.getAttribute('aria-pressed')).toBe('false')
  await send()
  const posts = callMock.mock.calls.filter(([route]) => route === 'POST sessions/:id/collaboration') as [string, { id: string; body: { text: string; router: boolean; mentions: string[]; requestId: string } }][]
  expect(posts).toHaveLength(2)
  expect(posts[0]![1]).toMatchObject({ id: 'conversation-a', body: { text: '包含今天的请求', router: false, mentions: ['w1', 'w2'] } })
  expect(posts[0]![1].body.requestId).toBe(posts[1]![1].body.requestId)
  expect(container.querySelector('textarea')?.value).toBe('')
})

it('loads a worker’s earlier reports independently and displays them in chronological order', async () => {
  const base = fakeCall()
  const call = vi.fn(async (route: string, args?: { query?: { before?: string } }) => {
    const value = await base(route, args)
    if (route !== 'GET rooms/:key') return value
    return { ...value, earlier: args?.query?.before ? null : 'older-cursor', messages: args?.query?.before ? [
      { ...data().messages[1], id: 'report:earlier', at: '2026-11-06T09:00:00Z', text: '开始检查服务配置' },
    ] : data().messages.filter(message => message.ticketId === 'w1') }
  }) as unknown as Call
  await render(call); await click('.sa-worker[aria-label^="查看执行成员 1"]')
  await click('.sa-load-history')
  expect([...container.querySelectorAll('.sa-timeline-entry .sa-markdown')].map(element => element.textContent)).toEqual(['开始检查服务配置', '已读取规则，继续验证'])
  expect(container.querySelector('.sa-load-history')).toBeNull()
})

it('restores the selected member, reading tab and draft while keeping a new conversation isolated', async () => {
  const call = vi.fn(async (route: string, args: { id?: string; key?: string; query?: { workerId?: string } }) =>
    fakeCall(() => data(args.id ?? args.key?.replace('dsh-session:', '') ?? 'conversation-a'))(route, args)) as unknown as Call
  const { openSession } = await render(call)
  await click('.sa-worker[aria-label^="查看执行成员 2"]'); await click('[role="tab"]:nth-child(2)'); await input('保留这个补充要求')
  await act(async () => { root!.render(<WorkerPanel key="conversation-b" sessionId="conversation-b" call={call} t={t} openSession={openSession} />) }); await flush()
  expect(container.querySelector('textarea')?.value).toBe('')
  expect(container.querySelector('.sa-overview-member')?.getAttribute('aria-pressed')).toBe('true')
  await act(async () => { root!.render(<WorkerPanel key="conversation-a-restored" sessionId="conversation-a" call={call} t={t} openSession={openSession} />) }); await flush()
  expect(container.querySelector('textarea')?.value).toBe('保留这个补充要求')
  expect(container.querySelector('.sa-worker[aria-label^="查看执行成员 2"]')?.getAttribute('aria-pressed')).toBe('true')
  expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('协作对话')
})

it('keeps the reader in place when a new overview summary arrives and offers a new-update button', async () => {
  let snapshot = data()
  const call = fakeCall(() => snapshot) as unknown as Call
  await render(call)
  const viewport = container.querySelector('.sa-reading-scroll') as HTMLDivElement
  Object.defineProperties(viewport, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 200 } })
  await act(async () => { viewport.scrollTop = 120; viewport.dispatchEvent(new Event('scroll', { bubbles: true })) })
  snapshot = { ...snapshot, messages: [...snapshot.messages, { ...snapshot.messages[1]!, id: 'report:new', at: '2026-11-06T10:05:00Z', text: '重放请求已通过' }] }
  await click('[aria-label="刷新协作进度"]')
  expect(viewport.scrollTop).toBe(120)
  expect(container.querySelector('.sa-new-messages')?.textContent).toContain('有新动态')
  await click('.sa-new-messages')
  expect(viewport.scrollTop).toBe(1000)
})

it('shows an actionable fetch error and removes the previous conversation while the new one loads', async () => {
  const call = vi.fn(async (_route: string, args: { id: string }) => { if (args.id === 'conversation-b') throw new Error('服务暂时离线'); return data() }) as unknown as Call
  const { openSession } = await render(call)
  await act(async () => { root!.render(<WorkerPanel key="conversation-b" sessionId="conversation-b" call={call} t={t} openSession={openSession} />) }); await flush()
  expect(container.textContent).toContain('服务暂时离线')
  expect(container.textContent).not.toContain('验证服务器过滤器')
  expect(container.querySelector('[role="alert"] button')?.textContent).toBe(zh.retry)
})

it('registers the native tab, opens eligible sessions once, and discards a stale eligibility response', async () => {
  let current: string | undefined = 'conversation-a', listener = () => {}, resolveA = (_response: Response) => {}
  const disposers: (() => void)[] = [], registrations: Record<string, unknown>[] = [], openTab = vi.fn()
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1920 })
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('conversation-a') ? new Promise<Response>(resolve => { resolveA = resolve }) : Response.json(data('conversation-b'))))
  const ctx = { sidebarRightTabs: { register: vi.fn(() => () => {}) },
    sidebarRight: { mounted: { getSnapshot: () => current, subscribe: (callback: () => void) => { listener = callback; return () => {} } }, openTab },
    slots: { inject: (_name: string, fn: () => void) => fn(), register: (options: Record<string, unknown>) => { registrations.push(options); return () => {} } },
    effect: (effect: () => () => void) => { disposers.push(effect()) },
  }
  installWorkerPanel(ctx as never, t, async () => {}); await flush()
  current = 'conversation-b'; listener(); await flush()
  expect(openTab).toHaveBeenCalledExactlyOnceWith(WORKER_PANEL_KIND)
  resolveA(Response.json(data('conversation-a'))); await flush()
  expect(openTab).toHaveBeenCalledTimes(1)
  listener(); await flush(); expect(openTab).toHaveBeenCalledTimes(1)
  expect(registrations[0]).toMatchObject({ name: 'sidebar.right.pane.tab', key: WORKER_PANEL_KIND })
  disposers.reverse().forEach(dispose => dispose())
})

it('leaves the collaboration tab available for manual opening on a laptop-width screen', async () => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1366 })
  const openTab = vi.fn(), register = vi.fn(() => () => {}), disposers: (() => void)[] = [], fetch = vi.fn(async () => Response.json(data()))
  vi.stubGlobal('fetch', fetch)
  const ctx = { sidebarRightTabs: { register }, sidebarRight: { mounted: { getSnapshot: () => 'conversation-a', subscribe: () => () => {} }, openTab },
    slots: { inject: (_name: string, fn: () => void) => fn(), register: () => () => {} }, effect: (effect: () => () => void) => { disposers.push(effect()) } }
  installWorkerPanel(ctx as never, t, async () => {}); await flush()
  expect(register).toHaveBeenCalled(); expect(openTab).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled()
  disposers.reverse().forEach(dispose => dispose())
})

it('updates a member verification badge while keeping direct messaging and full-session controls available', async () => {
  let snapshot = data()
  snapshot.workers[0]!.acceptance = { revision: 1, mode: 'enforce', createdAt: at,
    criteria: [{ id: 'replay', description: '重放请求并核对过滤结果。', kind: 'code', sourceRefs: ['trigger/request'] }] }
  snapshot.workers[0]!.verification = { state: 'pending', reportKey: 'report-1', at, summary: '等待独立验收', checks: [], attempt: 1 }
  const call = fakeCall(() => snapshot) as unknown as Call
  await render(call)
  expect(container.querySelector('.sa-worker .sa-verification-badge')?.textContent).toContain(zh['verification.state.pending'])
  await click('.sa-worker[aria-label^="查看执行成员 1"]')
  expect(container.querySelector('.sa-member-detail .sa-verification')?.textContent).toContain('等待独立验收')
  snapshot = { ...snapshot, workers: snapshot.workers.map(worker => worker.id === 'w1'
    ? { ...worker, verification: { ...worker.verification!, state: 'passed', summary: '请求重放与过滤结果已核验。' } } : worker) }
  await click('[aria-label="刷新协作进度"]')
  expect(container.querySelector('.sa-worker .sa-verification-badge')?.textContent).toContain(zh['verification.state.passed'])
  expect(container.querySelector('[aria-label="打开 Worker 1 会话"]')).not.toBeNull()
  expect(container.querySelector('[aria-label="交给调度助手"]')).not.toBeNull()
  expect(container.querySelector('textarea')).not.toBeNull()
})
