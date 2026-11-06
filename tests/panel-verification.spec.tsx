// @vitest-environment jsdom
import { act } from 'react'
import { expect, it } from 'vitest'
import type { AcceptancePlan, CompletionVerification } from '../src/core/verification.ts'
import { zh } from '../src/client/locales.ts'
import { usePanel, mount, click, type, at, text, find, all, settle } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()
const atTime = '2026-11-07T01:00:00.000Z'
const plan = (mode: AcceptancePlan['mode'] = 'enforce'): AcceptancePlan => ({ revision: 1, mode, createdAt: atTime,
  criteria: [{ id: 'fix-login', kind: 'code', description: '登录失败时显示明确提示。', sourceRefs: ['trigger/request-1'] }] })
const review = (state: CompletionVerification['state']): CompletionVerification => ({ state, reportKey: 'report-1', at: atTime,
  summary: state === 'passed' ? '登录失败提示已实际验证。' : state === 'unknown' ? '尚缺真实请求的执行结果。' : '等待读取执行结果。', attempt: 1,
  checks: state === 'passed' ? [{ criterionId: 'fix-login', state: 'passed', summary: '失败请求返回后显示提示。', evidenceRefs: ['execution/login-request-1'] }] : [] })
function setup(mode: AcceptancePlan['mode'] = 'enforce', state: CompletionVerification['state'] = 'pending') {
  const acceptance = plan(mode), verification = review(state)
  server.ticketDetails.t1!.acceptance = acceptance
  if (mode === 'enforce') server.ticketDetails.t1!.verification = verification
  server.verificationViews.t1 = { acceptance, verification, history: [] }
  at({ page: 'execution', id: 't1' })
}

it('updates pending verification to passed while retaining the task and original stop/session controls', async () => {
  setup(); await mount()
  expect(document.querySelector('.sa-verification [role="status"]')?.textContent).toContain(zh['verification.state.pending'])
  expect(find(zh.stop)).toBeDefined()
  expect(server.requests.some(request => request.path === 'tickets/t1/verification')).toBe(false)
  server.ticketDetails.t1!.verification = review('passed')
  server.verificationViews.t1!.verification = review('passed')
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')) }); await settle()
  expect(document.querySelector('.sa-verification [role="status"]')?.textContent).toContain(zh['verification.state.passed'])
  expect(text()).toContain('修复回归')
  expect(find(zh.stop)).toBeDefined()
  await click(zh['verification.details'])
  expect(text()).toContain('登录失败时显示明确提示。')
  expect(text()).toContain('失败请求返回后显示提示。')
  expect(text()).toContain('execution/login-request-1')
})

it('keeps unknown evidence visible and reuses the verification request id across a failed retry', async () => {
  setup('enforce', 'unknown'); await mount()
  expect(text()).toContain(zh['verification.state.unknown'])
  server.verificationRequestError = '验收服务暂时离线'
  await click(zh['verification.retry'])
  expect(document.querySelector('.sa-verification [role="alert"]')?.textContent).toContain('验收服务暂时离线')
  expect(text()).toContain('修复回归')
  expect(find(zh.stop)).toBeDefined()
  delete server.verificationRequestError
  await click(zh['verification.retry'])
  const posts = server.requests.filter(request => request.method === 'POST' && request.path === 'tickets/t1/verify')
  expect(posts).toHaveLength(2)
  expect(posts[0]!.body).toEqual(posts[1]!.body)
  expect(text()).toContain(zh['verification.requested'])
  expect(document.querySelector('.sa-verification [role="status"]')?.textContent).toContain(zh['verification.state.pending'])
})

it('keeps task content usable when the verification detail API fails and offers local retry', async () => {
  setup('enforce', 'unknown'); server.verificationError = '证据读取暂时失败'
  await mount(); await click(zh['verification.details'])
  expect(document.querySelector('.sa-verification [role="alert"]')?.textContent).toContain('证据读取暂时失败')
  expect(text()).toContain('修复回归')
  expect(text()).toContain('尚缺真实请求的执行结果。')
  expect(find(zh.stop)).toBeDefined()
  delete server.verificationError
  await click(document.querySelector('.sa-verification [role="alert"] button') as HTMLElement)
  expect(document.querySelector('.sa-verification [role="alert"]')).toBeNull()
  expect(text()).toContain('登录失败时显示明确提示。')
})

it('reads observation findings without implying that the task is gated or mutating the original verification field', async () => {
  setup('observe', 'passed'); await mount()
  const badge = document.querySelector('.sa-verification-badge')!
  expect(badge.textContent).toBe(zh['verification.mode.observe'])
  await click(zh['verification.details'])
  expect(document.querySelector('.sa-verification-badge')?.textContent).toContain(zh['verification.state.passed'])
  expect(text()).toContain(zh['verification.observeHint'])
  expect(text()).not.toContain(zh['verification.enforceHint'])
  expect(server.ticketDetails.t1!.verification).toBeUndefined()
})

it('keeps verification and supervision configuration inside Execution settings and applies new-task defaults explicitly', async () => {
  server.ticketDetails.t1!.acceptance = plan('observe')
  at({ page: 'settings', query: { group: 'execution' } }); await mount()
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(zh['settingsGroup.execution'])
  expect(all('.dt-settings-link')).toHaveLength(6)
  await type(document.getElementById('sa-verification-mode') as HTMLSelectElement, 'enforce')
  await type(document.getElementById('sa-verification-repairs') as HTMLSelectElement, '1')
  const section = document.querySelector(`[aria-label="${zh['verification.settings']}"]`)!
  await click([...section.querySelectorAll('button')].find(button => button.textContent === zh.save)!)
  expect(server.verificationConfig).toEqual({ mode: 'enforce', maxRepairs: 1 })
  expect(server.ticketDetails.t1!.acceptance?.mode).toBe('observe')
  expect(text()).toContain(zh['verification.newTasksHint'])
  await type(document.getElementById('sa-supervision-mode') as HTMLSelectElement, 'advise')
  const supervision = document.querySelector(`[aria-label="${zh['supervision.settings']}"]`)!
  await click([...supervision.querySelectorAll('button')].find(button => button.textContent === zh.save)!)
  expect(server.supervisionConfig).toEqual({ mode: 'advise' })
})

it('keeps the existing execution settings usable when the added configuration API is unavailable', async () => {
  server.verificationConfigError = '独立验收正在初始化'
  at({ page: 'settings', query: { group: 'execution' } }); await mount()
  expect(text()).toContain('独立验收正在初始化')
  expect(document.querySelector('input')).toBeDefined()
  expect(text()).toContain(zh.maxWorkers)
  expect(document.getElementById('sa-supervision-mode')).toBeDefined()
})

it('adds verification to room workers without replacing conversation, artifacts or direct-message controls', async () => {
  server.setup.machine.mode = 'personal'
  const worker = server.rooms.views['web:demo']!.workers[0]!
  worker.acceptance = plan(); worker.verification = review('needs_changes')
  server.verificationViews[worker.id] = { acceptance: worker.acceptance, verification: worker.verification, history: [] }
  at({ page: 'rooms', id: 'web:demo' }); await mount()
  expect(document.querySelector('.sa-verification-badge')?.textContent).toContain(zh['verification.state.needs_changes'])
  expect(document.querySelector('textarea')).toBeDefined()
  expect(find('交给调度助手')).toBeDefined()
  expect(all('.sa-detail-tabs [role="tab"]')).toHaveLength(4)
  expect(document.querySelector('.sa-task-brief')?.textContent).toContain('任务群验收结果.zip')
})

it('resumes a held task through its existing ticket endpoint without removing the stop action', async () => {
  setup(); server.ticketDetails.t1!.hold = { kind: 'budget', reason: '达到本轮资源额度', at: atTime }
  await mount()
  expect(text()).toContain('达到本轮资源额度')
  await click(zh['verification.resume'])
  expect(server.requests.some(request => request.method === 'POST' && request.path === 'tickets/t1/resume')).toBe(true)
  expect(server.ticketDetails.t1!.hold).toBeUndefined()
  expect(find(zh.stop)).toBeDefined()
})
