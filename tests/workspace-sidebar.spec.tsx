// @vitest-environment jsdom
import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { WorkspaceSidebar } from '../src/client/workspace-sidebar.tsx'
import { observeSidebarViews } from '../src/client/sidebar-dom.ts'
import { zh } from '../src/client/locales.ts'
import { translator } from './fixtures/panel.tsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ''; sessionStorage.clear(); vi.unstubAllGlobals() })
const t = translator(zh)
const now = Date.now()
const session = (id: string, cwd: string, title = id) => ({ id, cwd, title, displayTitle: title, updatedAt: now, blank: false, running: false, retainedBy: {} })
const nativeRegion = () => {
  const region = document.createElement('div'); region.dataset.slot = 'sidebar.workspaces'
  region.innerHTML = '<div><header><span class="host_sectionLabel host_wide">工作区</span><button>原生搜索</button></header><div data-native-list><div role="tree"><button aria-expanded="true">普通工作区已展开</button><input value="native filter"></div></div></div>'
  document.body.append(region); return region
}
async function flush() { for (let index = 0; index < 5; index++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) }
async function click(label: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === label || item.getAttribute('aria-label') === label)!
  expect(button, label).toBeTruthy(); await act(async () => { button.click() }); await flush()
}
async function fixture(mode = 'personal', roomKey = 'web:fix') {
  nativeRegion()
  let list = { phase: 'ready', ids: ['master', 'owner', 'worker-1', 'other'], byId: {
    master: session('master', 'C:/state/superagent'), owner: session('owner', 'C:/state/superagent', '交办会话'),
    'worker-1': session('worker-1', 'C:/state/superagent/work/fix', '修复会话'), other: session('other', 'E:/other', '普通会话'),
  }, projectionsBySession: {} }
  const subscribers = new Set<() => void>()
  const ctx = { sessions: { list: { getSnapshot: () => list, subscribe: (fn: () => void) => { subscribers.add(fn); return () => subscribers.delete(fn) } }, refresh: vi.fn(async () => {}) },
    uiWorkspace: { openSession: vi.fn(), startSession: vi.fn() }, layout: { selectPanel: vi.fn() } }
  const fetcher = vi.fn(async (url: string) => {
    if (url.endsWith('/state')) return Response.json({ mode, masterId: 'master', masterReady: true, setup: { machine: { stateDir: 'C:/state/superagent' } } })
    if (url.includes('/rooms')) return Response.json({ items: [{ key: roomKey, title: '修复登录流程', source: 'web', updatedAt: new Date(now).toISOString(), pending: false,
      workers: [{ id: 'w1', title: '修复登录流程', stage: 'working', sessionId: 'worker-1', active: true, subscribed: true, summary: '正在验证' }] }], next_offset: null })
    return Response.json({ error: 'unavailable' }, { status: 503 })
  })
  vi.stubGlobal('fetch', fetcher)
  const element = document.createElement('div'); document.body.append(element); root = createRoot(element)
  const props = { ctx, t, useWorkspaces: (select: (value: unknown) => unknown) => select({ items: [{ workspaceId: 'main-ws', path: 'C:/state/superagent' }], archivedSessionIds: [] }),
    usePanelInfo: (select: (value: unknown) => unknown) => select({ activePanelId: null }) } as unknown as ComponentProps<typeof WorkspaceSidebar>
  await act(async () => { root!.render(<WorkspaceSidebar {...props} />) }); await flush()
  return { ctx, fetcher, subscribers, update: () => { list = { ...list }; for (const subscriber of subscribers) subscriber() } }
}

it('switches views below the native header while retaining the native tree and its state', async () => {
  await fixture()
  const native = document.querySelector('[data-native-list]')!, input = native.querySelector('input')!
  expect(document.querySelector('[data-superagent-sidebar]')?.getAttribute('data-superagent-view')).toBe('superagent')
  expect(document.querySelector('[data-superagent-sidebar-tabs]')?.previousElementSibling?.tagName).toBe('HEADER')
  expect(document.querySelector('.sa-side-main')).not.toBeNull()
  expect(document.querySelector('.sa-side-panel')?.textContent).toContain('交办会话')
  expect(document.querySelector('.sa-side-panel')?.textContent).not.toContain('普通会话')
  await click('DSH')
  expect(document.querySelector('[data-superagent-sidebar-panel]')?.hasAttribute('hidden')).toBe(true)
  expect(document.querySelector('[data-native-list]')).toBe(native)
  expect(input.value).toBe('native filter')
  expect(native.querySelector('[aria-expanded=true]')).not.toBeNull()
  await click('Superagent')
  expect(document.querySelector('[data-native-list]')).toBe(native)
  expect(document.querySelector('.sa-side-task')?.textContent).toContain('修复登录流程')
})

it('opens real session identities, creates in the main workspace and navigates to the task detail', async () => {
  const { ctx } = await fixture()
  await click('主对话'); expect(ctx.uiWorkspace.openSession).toHaveBeenCalledWith('master')
  await click('修复会话'); expect(ctx.uiWorkspace.openSession).toHaveBeenCalledWith('worker-1')
  await click('新建 Superagent 会话'); expect(ctx.uiWorkspace.startSession).toHaveBeenCalledWith('main-ws')
  const navigation = vi.fn(); window.addEventListener('dsh-superagent:navigate', navigation)
  await click('打开任务：修复登录流程')
  expect(ctx.layout.selectPanel).toHaveBeenCalledWith('dsh-superagent')
  expect(navigation.mock.calls[0]![0].detail).toEqual({ page: 'rooms', id: 'web:fix' })
  window.removeEventListener('dsh-superagent:navigate', navigation)
})

it('remembers tab and expansion state and supports keyboard switching', async () => {
  await fixture()
  await click('DSH')
  const tab = document.getElementById('sa-sidebar-dsh')!
  await act(async () => { tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })) }); await flush()
  expect(document.activeElement?.id).toBe('sa-sidebar-superagent')
  expect(document.getElementById('sa-sidebar-superagent')?.getAttribute('aria-selected')).toBe('true')
  await click('DSH'); expect(JSON.parse(sessionStorage.getItem('superagent/sidebar-view')!)).toBe('dsh')
})

it('opens the exact worker ticket when the only room is the shared master conversation', async () => {
  const { ctx } = await fixture('personal', 'dsh-session:master')
  const navigation = vi.fn(); window.addEventListener('dsh-superagent:navigate', navigation)
  await click('打开任务：修复登录流程')
  expect(ctx.layout.selectPanel).toHaveBeenCalledWith('dsh-superagent')
  expect(navigation.mock.calls[0]![0].detail).toEqual({ page: 'execution', id: 'w1' })
  window.removeEventListener('dsh-superagent:navigate', navigation)
})

it('leaves the original workspace region untouched in repository mode and removes enhancements on disposal', async () => {
  await fixture('repository')
  expect(document.querySelector('[data-superagent-sidebar-tabs]')).toBeNull()
  expect(document.querySelector('[data-native-list]')).not.toBeNull()
})

it('restores the native region and catalog subscription after the enhancement is disposed', async () => {
  const { subscribers } = await fixture()
  const native = document.querySelector<HTMLElement>('[data-native-list]')!
  expect(native.inert).toBe(true)
  expect(subscribers.size).toBe(1)
  await act(async () => { root!.unmount() }); root = undefined
  expect(document.querySelector('[data-superagent-sidebar-tabs]')).toBeNull()
  expect(document.querySelector('[data-superagent-sidebar-panel]')).toBeNull()
  expect(document.querySelector('[data-native-list]')).toBe(native)
  expect(native.inert).toBe(false)
  expect(subscribers.size).toBe(0)
})

it('reattaches once after the host replaces its browsing region, and cleans up injected DOM', async () => {
  const first = nativeRegion(), mounts: (HTMLElement | undefined)[] = []
  const stop = observeSidebarViews(mount => { mounts.push(mount?.root) })
  expect(first.querySelectorAll('[data-superagent-sidebar-tabs]')).toHaveLength(1)
  first.remove(); const second = nativeRegion(); await flush()
  expect(second.querySelectorAll('[data-superagent-sidebar-tabs]')).toHaveLength(1)
  expect(mounts).toHaveLength(2)
  stop()
  expect(second.querySelector('[data-superagent-sidebar-tabs]')).toBeNull()
  expect(second.querySelector('[data-native-list]')).not.toBeNull()
})
