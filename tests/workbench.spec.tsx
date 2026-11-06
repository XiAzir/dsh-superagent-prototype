// @vitest-environment jsdom
// Personal workspace navigation and end-to-end entry into real task and attention views.
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { en, zh } from '../src/client/locales.ts'
import { all, at, click, mount, remount, settle, tab, text, usePanel } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()

it('opens the personal workbench with four primary destinations and shows real task questions', async () => {
  server.setup.machine.mode = 'personal'
  await mount()
  expect(all('.sa-shell-tabs [role="tab"]').map(item => item.textContent)).toEqual(['工作台', '任务', '个人助理', '设置'])
  expect(tab('工作台').getAttribute('aria-selected')).toBe('true')
  expect(document.querySelector('main')?.getAttribute('aria-labelledby')).toBe('dt-tab-overview')
  expect(all('.sa-workbench-metrics strong').map(item => item.textContent)).toEqual(['2', '2', '0'])
  expect(document.querySelector('#sa-needs-you')?.textContent).toContain('需要确认按钮颜色')
  expect(document.querySelector('#sa-needs-you')?.textContent).toContain('LlmError')
  expect(server.requests.some(request => request.path === 'rooms?limit=50')).toBe(true)
  const runtime = document.querySelector<HTMLDetailsElement>('.sa-workbench-runtime')!
  expect(runtime.open).toBe(false)
  await click(runtime.querySelector('summary')!)
  expect(runtime.open).toBe(true)
  expect(runtime.textContent).toContain('执行容量')
})

it('opens a real room directly from the workbench and retains that destination after remount', async () => {
  server.setup.machine.mode = 'personal'
  await mount()
  const room = server.rooms.items[0]!
  expect(document.querySelector('.sa-workbench-task-title')?.textContent).toBe(room.workers[0]!.title)
  await click(document.querySelector<HTMLElement>('.sa-workbench-task')!)
  expect(tab('任务').getAttribute('aria-selected')).toBe('true')
  expect(server.requests.some(request => request.path.startsWith(`rooms/${room.key}?`))).toBe(true)
  expect(document.querySelector('[data-message-id="room-m1"]')).not.toBeNull()
  await remount()
  expect(document.querySelector('[data-message-id="room-m1"]')).not.toBeNull()
  expect(tab('任务').getAttribute('aria-selected')).toBe('true')
})

it('opens an attention ticket from the workbench without losing its execution actions', async () => {
  server.setup.machine.mode = 'personal'
  await mount()
  const ticket = document.querySelector<HTMLElement>('#sa-needs-you .dt-ticket .dt-open')!
  expect(ticket).not.toBeNull()
  await click(ticket)
  expect(tab('设置').getAttribute('aria-selected')).toBe('true')
  expect(server.requests.some(request => request.path.startsWith('tickets/'))).toBe(true)
  expect(document.querySelector('.sa-shell-operations button[aria-current="page"]')?.getAttribute('aria-label')).toBe(zh['tab.execution'])
})

it('keeps all operational pages reachable under the settings primary destination', async () => {
  server.setup.machine.mode = 'personal'
  await mount()
  await click(tab('设置'))
  for (const name of [zh['tab.source'], zh['tab.trigger'], zh['tab.eval'], zh['tab.execution']]) {
    const destination = all('.sa-shell-operations button').find(button => button.getAttribute('aria-label') === name)!
    await click(destination)
    expect(tab('设置').getAttribute('aria-selected')).toBe('true')
    expect(document.querySelector('.sa-shell-operations button[aria-current="page"]')).toBe(destination)
    expect(document.querySelector('main')?.getAttribute('aria-labelledby')).toBe('dt-tab-settings')
  }
  expect(server.requests.some(request => request.path === 'sources')).toBe(true)
  expect(server.requests.some(request => request.path.startsWith('threads?'))).toBe(true)
  expect(server.requests.some(request => request.path.startsWith('decisions?'))).toBe(true)
  expect(server.requests.some(request => request.path.startsWith('tickets?'))).toBe(true)
  await click(all('.sa-shell-operations button').find(button => button.textContent === '配置')!)
  expect(document.querySelector('.dt-settings')).not.toBeNull()
})

it('lets keyboard navigation select the four primary destinations and exposes one new-task entry', async () => {
  server.setup.machine.mode = 'personal'
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 0 })
  await mount()
  const list = document.querySelector('.sa-shell-tabs')!
  await act(async () => { list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })) })
  await settle()
  expect(tab('任务').getAttribute('aria-selected')).toBe('true')
  expect(all('.sa-shell-header button').filter(button => button.textContent === zh['webTask.newTask'])).toHaveLength(1)
  await click(all('.sa-shell-header button').find(button => button.textContent === zh['webTask.newTask'])!)
  expect(tab('任务').getAttribute('aria-selected')).toBe('true')
  expect(all('.sa-shell-header button').filter(button => button.textContent === zh['webTask.newTask'])).toHaveLength(0)
  expect(document.querySelector('textarea[aria-label="描述你要完成的任务"]')).not.toBeNull()
})

it('renders the personal workbench in English and preserves legacy repository navigation', async () => {
  server.setup.machine.mode = 'personal'
  await mount(en)
  expect(all('.sa-shell-tabs [role="tab"]').map(item => item.textContent)).toEqual(['Workbench', 'Tasks', 'Assistant', 'Settings'])
  expect(text()).toContain('Recent tasks')
  server.setup.machine.mode = 'repository'
  at({ page: 'overview' })
  await remount(en)
  expect(all('.sa-shell-tabs [role="tab"]').map(item => item.textContent)).toEqual(['Overview', 'Source', 'Trigger', 'Eval', 'Execution', 'Settings'])
  expect(document.querySelector('.sa-shell-operations')).toBeNull()
  expect(document.querySelector('[role="search"]')).not.toBeNull()
})
