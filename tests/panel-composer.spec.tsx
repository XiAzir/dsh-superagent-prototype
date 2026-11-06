// @vitest-environment jsdom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { usePanel, at, mount, click, type, field, find, settle } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'
import { zh } from '../src/client/locales.ts'

usePanel()

it('restores a new-task draft after visiting another page and clears it after successful delivery', async () => {
  server.setup.machine.mode = 'personal'
  at({ page: 'tasks' })
  await mount()
  const prompt = () => field<HTMLTextAreaElement>(zh['webTask.newPrompt'])
  await type(prompt(), '检查界面\n保留背景和验收标准')
  await click(find('工作台', '[role="tab"]'))
  await click(zh['webTask.newTask'])
  expect(prompt().value).toBe('检查界面\n保留背景和验收标准')
  await act(async () => { prompt().closest('form')!.requestSubmit() }); await settle()
  const request = server.requests.find(item => item.method === 'POST' && item.path === 'web/tasks')!
  expect(request.body).toMatchObject({ text: '检查界面\n保留背景和验收标准' })
  expect(document.querySelector('.sa-task-heading')).not.toBeNull()
  await click(zh['webTask.newTask'])
  expect(prompt().value).toBe('')
})

it('allows a task starter to fill an empty draft and preserves an existing user draft', async () => {
  server.setup.machine.mode = 'personal'; at({ page: 'tasks' }); await mount()
  const prompt = field<HTMLTextAreaElement>(zh['webTask.newPrompt'])
  await click('分析与研究')
  expect(prompt.value).toContain('期望结果：')
  await type(prompt, '我已经写好的完整需求')
  await click('检查与排障')
  expect(prompt.value).toBe('我已经写好的完整需求')
})

it('submits a task with the keyboard shortcut and ignores input-method composition', async () => {
  server.setup.machine.mode = 'personal'; at({ page: 'tasks' }); await mount()
  const prompt = field<HTMLTextAreaElement>(zh['webTask.newPrompt'])
  await type(prompt, '键盘交办')
  await act(async () => { prompt.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true, bubbles: true })) })
  expect(server.requests.filter(item => item.method === 'POST' && item.path === 'web/tasks')).toHaveLength(0)
  await act(async () => { prompt.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })) }); await settle()
  expect(server.requests.filter(item => item.method === 'POST' && item.path === 'web/tasks')).toHaveLength(1)
})

it('keeps a newer draft and the current page when a previously submitted request finishes after navigation', async () => {
  server.setup.machine.mode = 'personal'; at({ page: 'tasks' }); await mount()
  const original = vi.mocked(globalThis.fetch).getMockImplementation()!
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (String(input).endsWith('/web/tasks') && init?.method === 'POST') await held
    return original(input, init)
  })
  await type(field<HTMLTextAreaElement>(zh['webTask.newPrompt']), '正在发送的第一个任务')
  await act(async () => { field<HTMLTextAreaElement>(zh['webTask.newPrompt']).closest('form')!.requestSubmit() })
  await click(find('工作台', '[role="tab"]'))
  await click(zh['webTask.newTask'])
  await type(field<HTMLTextAreaElement>(zh['webTask.newPrompt']), '稍后再交办的第二个任务')
  await act(async () => { release(); await new Promise(resolve => setTimeout(resolve, 0)) }); await settle()
  expect(field<HTMLTextAreaElement>(zh['webTask.newPrompt']).value).toBe('稍后再交办的第二个任务')
  await click(find('工作台', '[role="tab"]')); await click(zh['webTask.newTask'])
  expect(field<HTMLTextAreaElement>(zh['webTask.newPrompt']).value).toBe('稍后再交办的第二个任务')
})
