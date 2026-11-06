// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { usePanel, mount, click, type, at, text, find } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()
const time = '2026-11-07T02:00:00.000Z'
const device = () => ({ id: 'laptop', label: '我的电脑', url: 'https://device.example.com', status: 'offline' as const })
const settings = () => at({ page: 'settings', query: { group: 'execution' } })
const task = () => at({ page: 'execution', id: 't1' })
async function openEnvironment() { await click(document.querySelector('.sa-remote-task > summary') as HTMLElement) }
function unknownCommand() {
  server.environments.items = [device()]
  server.environmentViews.t1 = { deviceId: 'laptop', commands: [{ commandId: 'command-unknown-1', requestId: 'request-1', deviceId: 'laptop',
    ticketId: 't1', payloadHash: 'payload-hash', state: 'unknown', effectiveState: 'unknown', createdAt: time, updatedAt: time,
    remote: { commandId: 'command-unknown-1', ticketId: 't1', payloadHash: 'payload-hash', state: 'unknown', directory: '/work/t1',
      createdAt: time, stdout: '已写出 report.pdf，需核对实际文件。', stderr: '' } }] }
}

it('registers a device using only the stored credential reference and exposes no token input or returned credential', async () => {
  settings(); await mount()
  const section = document.querySelector(`[aria-label="${zh['remote.settings']}"]`)!
  await click(section.querySelector('details > summary') as HTMLElement)
  await type(document.getElementById('sa-device-id') as HTMLInputElement, 'laptop')
  await type(document.getElementById('sa-device-label') as HTMLInputElement, '我的电脑')
  await type(document.getElementById('sa-device-url') as HTMLInputElement, 'https://device.example.com')
  await type(document.getElementById('sa-device-credentialRef') as HTMLInputElement, 'MY_DEVICE_CREDENTIAL')
  await click(zh['remote.register'])
  expect(server.environmentRegistrations).toEqual([{ id: 'laptop', label: '我的电脑', url: 'https://device.example.com', credentialRef: 'MY_DEVICE_CREDENTIAL' }])
  expect(server.environments.items[0]).not.toHaveProperty('credentialRef')
  expect(section.querySelector('input[type="password"]')).toBeNull()
  expect((document.getElementById('sa-device-credentialRef') as HTMLInputElement).value).toBe('')
  expect(text()).toContain(zh['remote.registered'])
})

it('shows an offline probe without removing device details or execution settings', async () => {
  server.environments.items = [device()]; server.environmentProbeErrors.laptop = '设备暂未上线'
  settings(); await mount(); await click(zh['remote.probe'])
  expect(text()).toContain(zh['remote.state.offline'])
  expect(text()).toContain('设备暂未上线')
  expect(text()).toContain('https://device.example.com')
  expect(text()).toContain(zh.maxWorkers)
})

it('binds the selected registered device while retaining the task stop control', async () => {
  server.environments.items = [device()]
  task(); await mount(); await openEnvironment()
  expect(text()).toContain(zh['remote.local'])
  await type(document.getElementById('sa-task-device-t1') as HTMLSelectElement, 'laptop')
  await click('切换至 我的电脑')
  expect(server.environmentViews.t1?.deviceId).toBe('laptop')
  expect(text()).toContain('当前环境：我的电脑')
  expect(find(zh.stop)).toBeDefined()
})

it('preserves the selected environment and original task when safe binding is refused', async () => {
  server.environments.items = [device()]; server.environmentBindError = '先核实此前命令的执行结果。'
  task(); await mount(); await openEnvironment()
  await type(document.getElementById('sa-task-device-t1') as HTMLSelectElement, 'laptop')
  await click('切换至 我的电脑')
  expect(text()).toContain('先核实此前命令的执行结果。')
  expect((document.getElementById('sa-task-device-t1') as HTMLSelectElement).value).toBe('laptop')
  expect(server.environmentViews.t1).toBeUndefined()
  expect(text()).toContain('修复回归')
  expect(find(zh.stop)).toBeDefined()
})

it('requires concrete owner evidence and an explicit target/outcome confirmation, retaining unknown state and output after failure', async () => {
  unknownCommand(); server.environmentResolveError = '命令状态已变化，请重新核对。'
  task(); await mount(); await openEnvironment()
  const command = document.querySelector('[data-command-id="command-unknown-1"]')!
  expect(command.textContent).toContain(zh['remote.command.unknown'])
  await click([...command.querySelectorAll('summary')].find(item => item.textContent === zh['remote.resolve']) as HTMLElement)
  expect((find(zh['remote.preview']) as HTMLButtonElement).disabled).toBe(true)
  const evidence = document.getElementById('sa-command-evidence-command-unknown-1') as HTMLTextAreaElement
  await type(evidence, '已在目标电脑打开 report.pdf，正文与请求一致。')
  await click(zh['remote.preview'])
  expect(command.textContent).toContain('我的电脑 · 命令 command-unknown-1')
  await click('确认记录为“已完成”')
  expect(command.textContent).toContain('命令状态已变化，请重新核对。')
  expect(evidence.value).toBe('已在目标电脑打开 report.pdf，正文与请求一致。')
  expect(command.textContent).toContain('已写出 report.pdf，需核对实际文件。')
  expect(server.environmentViews.t1!.commands[0]!.effectiveState).toBe('unknown')
  delete server.environmentResolveError
  await click(zh['remote.preview']); await click('确认记录为“已完成”')
  const resolved = server.environmentViews.t1!.commands[0]!
  expect(resolved.state).toBe('unknown')
  expect(resolved.effectiveState).toBe('completed')
  expect(resolved.ownerResolution?.evidence).toBe(evidence.value)
  const submitted = server.requests.filter(request => request.path.endsWith('/resolve')).at(-1)!
  expect(submitted.body).toMatchObject({ outcome: 'completed', expectedUpdatedAt: time })
  expect(text()).toContain('人工核实为：已完成')
})

it('displays missing cost and judgment data as unknown', async () => {
  settings(); await mount()
  const summary = document.querySelector(`[aria-label="${zh['evaluation.title']}"]`)!
  const cost = [...summary.querySelectorAll('dt')].find(item => item.textContent === zh['evaluation.cost'])!
  expect(cost.nextElementSibling?.textContent).toBe(zh['evaluation.unknown'])
  expect(summary.textContent).toContain('人工完成判断 0 项')
})

it('records separate adoption/correctness feedback with one stable identity across failure and retry', async () => {
  task(); await mount()
  await type(document.getElementById('sa-feedback-t1-accepted') as HTMLSelectElement, 'yes')
  await type(document.getElementById('sa-feedback-t1-correct') as HTMLSelectElement, 'no')
  server.feedbackError = '效果记录暂时离线'
  await click(zh['feedback.save'])
  expect(text()).toContain('效果记录暂时离线')
  delete server.feedbackError; await click(zh['feedback.save'])
  const requests = server.requests.filter(request => request.path === 'tickets/t1/feedback')
  expect(requests).toHaveLength(2)
  expect(requests[0]!.body).toEqual(requests[1]!.body)
  expect(server.feedbackRecords).toEqual([{ ticketId: 't1', body: expect.objectContaining({ accepted: true, correct: false }) }])
  expect(text()).toContain(zh['feedback.saved'])
  expect(find(zh.stop)).toBeDefined()
})
