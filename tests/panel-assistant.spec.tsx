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

it('keeps assistant settings collapsed by default and saves changes after opening them', async () => {
  server.setup.machine.mode = 'personal'
  await mount()
  await click(zh['tab.assistant'])
  const summary = [...document.querySelectorAll<HTMLElement>('summary')].find(item => item.textContent?.includes(zh['assistant.settings']))!
  const fold = summary.closest('details')!
  expect(fold.open).toBe(false)
  expect(server.requests.filter(request => request.method === 'PUT' && request.path === 'personal/settings')).toHaveLength(0)

  await click(summary)
  expect(fold.open).toBe(true)
  await type(field<HTMLInputElement>(zh['assistant.timezone']), 'Europe/Paris')
  await click(zh['assistant.save'])
  expect(server.personal.settings.timezone).toBe('Europe/Paris')
  expect(server.requests.filter(request => request.method === 'PUT' && request.path === 'personal/settings')).toEqual([
    expect.objectContaining({ body: { revision: 1, value: expect.objectContaining({ timezone: 'Europe/Paris', revision: 1 }) } }),
  ])
  expect(text()).toContain('设置已保存')
})

it('opens on attention items and acknowledges the selected item through the API', async () => {
  server.setup.machine.mode = 'personal'
  server.personalRecords.attention.push({ id: 'attention-review', revision: 0, createdAt: '2026-11-06T00:00:00.000Z',
    updatedAt: '2026-11-06T00:00:00.000Z', sourceRefs: [], title: '请确认下周安排', summary: '周一上午有两个时间冲突，请选择保留的安排。',
    priority: 'P1', status: 'queued', digestKey: 'review-week' })
  await mount()
  await click(zh['tab.assistant'])
  const active = document.querySelector<HTMLButtonElement>('.dt-assistant-tabs button[aria-pressed="true"]')!
  expect(active.getAttribute('aria-label')).toBe(zh['assistant.attention'])
  expect(text()).toContain('请确认下周安排')
  expect(text()).toContain('周一上午有两个时间冲突，请选择保留的安排。')
  expect(text()).not.toContain('整理每周计划')
  await click(zh['assistant.acknowledge'])
  expect(server.personalRecords.attention[0]?.status).toBe('acknowledged')
  expect(server.requests.filter(request => request.method === 'POST' && request.path === 'personal/attention/attention-review/acknowledge')).toHaveLength(1)
  expect(text()).toContain(zh['assistant.status.acknowledged'])
})

it('restores an unfinished editor after main navigation and serializes multiline criteria once', async () => {
  server.setup.machine.mode = 'personal'
  await mount()
  await click(zh['tab.assistant'])
  await click(zh['assistant.goals'])
  await click(zh['assistant.create'])
  await type(field<HTMLInputElement>('标题'), '交付可复用的任务工作台')
  const criteria = document.querySelector<HTMLTextAreaElement>('#assistant-field-successCriteria')!
  await type(criteria, '完成需求核对\n\n验证关键流程\n发布使用说明')
  const status = document.querySelector<HTMLSelectElement>('#assistant-field-status')!
  expect([...status.options].find(option => option.value === 'active')?.textContent).toBe(zh['assistant.status.active'])

  await click('工作台')
  expect(document.querySelector('#assistant-field-title')).toBeNull()
  await click(zh['tab.assistant'])
  expect(field<HTMLInputElement>('标题').value).toBe('交付可复用的任务工作台')
  expect(document.querySelector<HTMLTextAreaElement>('#assistant-field-successCriteria')?.value).toBe('完成需求核对\n\n验证关键流程\n发布使用说明')
  expect(server.requests.filter(request => request.method === 'PUT' && request.path.startsWith('personal/records/goal/'))).toHaveLength(0)

  await click(zh['assistant.saveRecord'])
  const writes = server.requests.filter(request => request.method === 'PUT' && request.path.startsWith('personal/records/goal/'))
  expect(writes).toHaveLength(1)
  expect(writes[0]?.body).toMatchObject({ revision: 0, value: { title: '交付可复用的任务工作台',
    successCriteria: ['完成需求核对', '验证关键流程', '发布使用说明'], status: 'active' } })
  const saved = server.personalRecords.goal.find(item => item.title === '交付可复用的任务工作台')!
  expect(writes[0]?.path).toBe(`personal/records/goal/${saved.id}`)
  expect(saved.successCriteria).toEqual(['完成需求核对', '验证关键流程', '发布使用说明'])

  await click('工作台')
  await click(zh['tab.assistant'])
  expect(document.querySelector('#assistant-field-title')).toBeNull()
  expect(text()).toContain('交付可复用的任务工作台')
})

it('requires an inline confirmation before deleting and lets the user keep the record', async () => {
  server.setup.machine.mode = 'personal'
  await mount()
  await click(zh['tab.assistant'])
  await click(zh['assistant.goals'])
  await click(zh['assistant.delete'])
  expect(text()).toContain('删除这条记录？')
  expect(server.requests.filter(request => request.method === 'DELETE')).toHaveLength(0)
  expect(server.personalRecords.goal.some(item => item.id === 'goal-demo')).toBe(true)

  await click('保留')
  expect(text()).not.toContain('删除这条记录？')
  expect(server.requests.filter(request => request.method === 'DELETE')).toHaveLength(0)
  await click(zh['assistant.delete'])
  await click('确认删除')
  expect(server.requests.filter(request => request.method === 'DELETE' && request.path === 'personal/records/goal/goal-demo')).toEqual([
    expect.objectContaining({ body: { revision: 0 } }),
  ])
  expect(server.personalRecords.goal).toHaveLength(0)
  expect(text()).not.toContain('整理每周计划')
  expect(text()).toContain('写下想达成的结果与完成标准')
})
