// @vitest-environment jsdom
// Local management of persistent scheduled command tasks.
import { expect, it } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { all, at, click, field, find, mount, text, type, usePanel } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()

it('creates a scheduled argv task from the local Settings page', async () => {
  at({ page: 'settings', query: { group: 'schedules' } })
  await mount()
  expect(text()).toContain('任务随 Superagent 启动运行')
  expect(text()).toContain('邮箱检查')
  await click(zh.scheduleAdd)
  await type(field<HTMLInputElement>(zh.scheduleName), '每五分钟检查邮箱')
  await type(field<HTMLInputElement>(zh.scheduleProgram), 'C:\\Python\\python.exe')
  await type(field<HTMLTextAreaElement>(zh.scheduleArgs), 'mail_check.py\n--quiet')
  await type(field<HTMLInputElement>(zh.scheduleCwd), 'C:\\mail-check')
  await type(field<HTMLInputElement>(zh.scheduleInterval), '300')
  await type(field<HTMLInputElement>(zh.scheduleTimeout), '120')
  await click(zh.scheduleSave)
  const request = server.requests.find(entry => entry.path === 'schedules' && entry.method === 'POST')
  expect(request?.body).toEqual({ config: { name: '每五分钟检查邮箱', enabled: true, program: 'C:\\Python\\python.exe',
    args: ['mail_check.py', '--quiet'], cwd: 'C:\\mail-check', intervalSeconds: 300, timeoutSeconds: 120 } })
  expect(all('.dt-card').some(card => card.textContent?.includes('每五分钟检查邮箱'))).toBe(true)
})

it('edits, disables, runs, and confirms deletion with each item revision', async () => {
  at({ page: 'settings', query: { group: 'schedules' } })
  await mount()
  await click(find(zh.scheduleEdit, '.dt-card button'))
  await type(field<HTMLInputElement>(zh.scheduleName), '邮箱轮询')
  await click(zh.scheduleSave)
  expect(server.requests.filter(entry => entry.path === 'schedules/schedule-1' && entry.method === 'PUT').at(-1)?.body).toMatchObject({
    revision: 1, config: { name: '邮箱轮询', intervalSeconds: 300 },
  })
  await click(zh.scheduleDisableAction)
  expect(server.schedules.items[0]?.config.enabled).toBe(false)
  await click(zh.scheduleRun)
  expect(server.requests.some(entry => entry.path === 'schedules/schedule-1/run' && entry.method === 'POST')).toBe(true)
  await click(zh.scheduleDelete)
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('删除“邮箱轮询”这个定时任务？')
  await click(zh.confirm)
  expect(server.requests.find(entry => entry.path === 'schedules/schedule-1' && entry.method === 'DELETE')?.body).toEqual({ revision: 3 })
  expect(server.schedules.items).toHaveLength(0)
})

it('keeps an edit open and reports a revision conflict', async () => {
  at({ page: 'settings', query: { group: 'schedules' } })
  await mount()
  server.schedules.items[0]!.revision++
  await click(find(zh.scheduleEdit, '.dt-card button'))
  await click(zh.scheduleSave)
  expect(document.querySelector('.dt-error[role="alert"]')?.textContent).toContain('Schedule changed. Reload before saving.')
  expect(field<HTMLInputElement>(zh.scheduleName).value).toBe('邮箱检查')
  expect(find(zh.scheduleReloadLatest)).toBeTruthy()
  await click(zh.scheduleReloadLatest)
  await type(field<HTMLInputElement>(zh.scheduleName), '冲突后继续保存')
  await click(zh.scheduleSave)
  expect(server.requests.filter(entry => entry.path === 'schedules/schedule-1' && entry.method === 'PUT').at(-1)?.body).toMatchObject({
    revision: 2, config: { name: '冲突后继续保存' },
  })
})
