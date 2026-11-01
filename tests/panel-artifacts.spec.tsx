// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { ArtifactDownload } from '../src/client/artifacts.tsx'
import { PanelProvider } from '../src/client/provider.tsx'
import { zh } from '../src/client/locales.ts'
import { translator } from './fixtures/panel.tsx'

let root: Root | undefined, container: HTMLElement | undefined
afterEach(() => {
  act(() => root?.unmount()); container?.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
async function render() {
  container = document.createElement('div'); document.body.append(container)
  root = createRoot(container)
  await act(async () => root!.render(<PanelProvider t={translator(zh)}><ArtifactDownload conversation="task-a"
    artifact={{ id: 'artifact-a', name: '十月排休表.xlsx', size: 1024 }} /></PanelProvider>))
}

it('downloads with the same-origin header, preserves the filename and shows accessible busy feedback', async () => {
  let finish!: (response: Response) => void
  const pending = new Promise<Response>(resolve => { finish = resolve })
  const fetcher = vi.fn((url: string) => url.includes('/artifacts/') ? pending : Promise.resolve(new Response('{"load":{"running":0}}')))
  vi.stubGlobal('fetch', fetcher)
  const create = vi.fn(() => 'blob:test-artifact'), revoke = vi.fn()
  vi.stubGlobal('URL', class extends URL { static createObjectURL = create; static revokeObjectURL = revoke })
  let filename = ''
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { filename = this.download })
  await render()
  const button = container!.querySelector('button')!
  expect(button.textContent).toBe('下载 十月排休表.xlsx')
  await act(async () => button.click())
  expect(button.disabled).toBe(true); expect(button.getAttribute('aria-busy')).toBe('true')
  expect(fetcher).toHaveBeenCalledWith('/orchestrator/api/web/tasks/task-a/artifacts/artifact-a', expect.objectContaining({ headers: { 'x-orchestrator-request': '1' } }))
  await act(async () => { finish(new Response('actual file bytes')); await pending })
  expect(create).toHaveBeenCalledTimes(1)
  expect(filename).toBe('十月排休表.xlsx')
  expect(button.disabled).toBe(false)
  expect(container!.querySelector('[role="alert"]')).toBeNull()
})

it('shows a download refusal next to the button and lets the person retry', async () => {
  vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(url.includes('/artifacts/')
    ? new Response('{"error":"Web 账号授权已关闭"}', { status: 403 }) : new Response('{"load":{"running":0}}'))))
  await render()
  const button = container!.querySelector('button')!
  await act(async () => button.click())
  expect(container!.querySelector('[role="alert"]')?.textContent).toBe('Web 账号授权已关闭')
  expect(button.disabled).toBe(false)
})
