// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { usePanel, mount, click, field, text, type } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()

it('opens the personal assistant, enables settings, and creates a goal with a stable ID', async () => {
  server.setup.machine.mode = 'personal'
  await mount()
  await click(zh['tab.assistant'])
  expect(text()).toContain('个人助理设置')
  expect(text()).toContain('QQ 账号使用 qq:ID')
  const enabled = document.querySelector<HTMLInputElement>('.dt-assistant-enabled input')!
  await click(enabled)
  await click(zh['assistant.save'])
  expect(server.personal.settings.enabled).toBe(false)
  await click(enabled)
  await click(zh['assistant.save'])
  expect(server.personal.settings.enabled).toBe(true)
  await click(zh['assistant.goals'])
  await click(zh['assistant.create'])
  await type(field<HTMLInputElement>('标题'), '完成季度计划')
  await click(zh['assistant.saveRecord'])
  expect(server.personalRecords.goal.some(item => item.title === '完成季度计划')).toBe(true)
  const write = server.requests.find(item => item.path.startsWith('personal/records/goal/'))
  expect(write?.body).toMatchObject({ value: { title: '完成季度计划' }, revision: 0 })
})

it('shows complete authorization scope, target, payload, and request hash before an explicit approval', async () => {
  server.setup.machine.mode = 'personal'
  await mount()
  await click(zh['tab.assistant'])
  await click(zh['assistant.authorizations'])
  expect(text()).toContain('calendar.write')
  expect(text()).toContain('a'.repeat(64))
  expect(text()).toContain('Alice · 2026-11-08 10:00')
  expect(text()).toContain('周日 10:00 在上海时区创建“周计划回顾”，邀请 Alice。')
  expect(server.requests.some(request => request.path.includes('authorizations/auth-demo/request'))).toBe(true)
  await click(zh['assistant.actions'])
  expect(text()).toContain('Alice · 2026-11-08 10:00')
  expect(text()).toContain('周计划回顾')
})

it('confirms a candidate memory with only editable fields in the CAS write', async () => {
  server.setup.machine.mode = 'personal'
  await mount()
  await click(zh['tab.assistant'])
  await click(zh['assistant.memories'])
  await click(zh['assistant.confirmMemory'])
  const request = server.requests.filter(item => item.path === 'personal/records/fact/fact-candidate').at(-1)!
  expect(request.body).toEqual({ revision: 0, value: { status: 'active', confirmation: 'user' } })
  expect(server.personalRecords.fact[0]?.status).toBe('active')
})

it('retains a dirty settings draft when the server revision changes during polling', async () => {
  server.setup.machine.mode = 'personal'
  await mount()
  await click(zh['tab.assistant'])
  const timezone = field<HTMLInputElement>(zh['assistant.timezone'])
  await type(timezone, 'Europe/Paris')
  server.personal.settings = { ...server.personal.settings, timezone: 'UTC', revision: server.personal.settings.revision + 1 }
  await vi.waitFor(() => expect(server.requests.some(request => request.path === 'personal' && request.method === 'GET')).toBe(true), { timeout: 4500 })
  await new Promise(resolve => setTimeout(resolve, 4200))
  expect(timezone.value).toBe('Europe/Paris')
  expect(text()).toContain(zh['assistant.settingsConflictHint'][0])
  await click(zh['assistant.save'])
  expect(timezone.value).toBe('Europe/Paris')
  expect(text()).toContain(zh['assistant.settingsError'][0])
})

it('keeps approval disabled when the linked request hash has changed', async () => {
  server.setup.machine.mode = 'personal'
  server.personalRecords.action[0] = { ...server.personalRecords.action[0]!, requestHash: 'b'.repeat(64) }
  await mount()
  await click(zh['tab.assistant'])
  await click(zh['assistant.authorizations'])
  expect(text()).toContain('周日 10:00 在上海时区创建“周计划回顾”，邀请 Alice。')
  expect(text()).toContain(zh['assistant.authorizationHashMismatch'][0])
  const approve = document.querySelector<HTMLButtonElement>('.dt-assistant-approve')!
  expect(approve.disabled).toBe(true)
})
