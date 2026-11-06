// @vitest-environment jsdom
// The QQ Source's connection guidance, status and separate token actions.
import { expect, it } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { usePanel, mount, all, click, type, field, at, text } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()

it('shows live QQ status, mode-specific OneBot guidance, and saves or clears the token separately', async () => {
  at({ page: 'settings', query: { group: 'source', source: 'qq' } })
  await mount()
  const card = document.getElementById('dt-source-qq')!
  expect(card.textContent).toContain('QQ 连接状态')
  expect(card.textContent).toContain('已关闭')
  expect(card.textContent).toContain('ws://127.0.0.1:3001')
  expect(card.textContent).toContain('在 NapCat 或 SnowLuma 中启用 OneBot v11 WebSocket 服务端')
  expect(card.querySelectorAll('form')).toHaveLength(0)
  expect(card.querySelectorAll('input[type="password"]')).toHaveLength(1)

  await click([...card.querySelectorAll('button')].find(button => button.textContent === '反向 WebSocket')!)
  expect(card.textContent).toContain('ws://127.0.0.1:6199/onebot/v11/ws')
  expect(card.textContent).toContain('在 NapCat 或 SnowLuma 中启用 OneBot v11 WebSocket 客户端')
  expect(card.textContent).not.toContain('启用 OneBot v11 WebSocket 服务端')

  const token = field<HTMLInputElement>(zh['qq.tokenTitle'])
  await type(token, 'test-onebot-token')
  server.qqTokenError = 'credential store unavailable'
  await click(zh['qq.tokenSave'])
  expect(token.value).toBe('test-onebot-token')
  expect(card.textContent).toContain('credential store unavailable')

  delete server.qqTokenError
  await click(zh['qq.tokenSave'])
  expect(server.requests.find(request => request.path === 'qq/token')).toMatchObject({ method: 'PUT',
    body: { value: 'test-onebot-token' } })
  expect(token.value).toBe('')
  expect(card.textContent).toContain(zh['qq.tokenConfigured'])
  await click(zh['qq.tokenClear'])
  expect(server.requests.filter(request => request.path === 'qq/token').at(-1)).toMatchObject({ method: 'PUT', body: { value: '' } })
  expect(card.textContent).toContain(zh['qq.tokenMissing'])
  expect(all('.dt-card')).toHaveLength(3)
})

it('links QQ authorization to Settings → Eval', async () => {
  at({ page: 'settings', query: { group: 'source', source: 'qq' } })
  await mount()
  await click(zh['qq.configureAllowed'])
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(zh['settingsGroup.eval'])
  expect(text()).toContain(zh['settingsGroup.eval'])
})
