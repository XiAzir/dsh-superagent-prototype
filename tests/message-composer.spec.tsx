// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { MessageComposer, type MessageComposerProps } from '../src/client/message-composer.tsx'
import { zh } from '../src/client/locales.ts'
import type { Call } from '../src/client/api.ts'
import type { T } from '../src/client/text.ts'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const t = ((key: keyof typeof zh) => zh[key] ?? key) as T
const workers = [
  { id: 'worker-a', name: '执行成员 1', title: '排查服务器日志', active: true, subscribed: true },
  { id: 'worker-b', name: '执行成员 2', title: '修复页面布局', active: true, subscribed: true },
  { id: 'worker-c', name: '执行成员 3', title: '已归档的历史任务', active: false, subscribed: false },
]
let root: Root | undefined, container: HTMLDivElement
const flush = async () => { for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve() }) }
const input = () => container.querySelector('textarea')!
const sendButton = () => container.querySelector<HTMLButtonElement>('.mc-send')!
const routerButton = () => container.querySelector<HTMLButtonElement>('[aria-label="交给调度助手"]')!
async function click(element: HTMLElement) { await act(async () => { element.click() }); await flush() }
async function type(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input(), value)
    input().setSelectionRange(value.length, value.length)
    input().dispatchEvent(new Event('input', { bubbles: true }))
  }); await flush()
}
async function mount(props: Partial<MessageComposerProps> = {}) {
  if (!container) { container = document.createElement('div'); document.body.append(container); root = createRoot(container) }
  const onSend = vi.fn(async () => {}), call = vi.fn(async () => ({})) as unknown as Call
  await act(async () => { root!.render(<MessageComposer draftKey="test/composer" label="协作输入" t={t} call={call} workers={workers} onSend={onSend} {...props} />) })
  await flush(); return { onSend, call }
}
async function select(name: string) {
  await type('@' + name)
  const option = container.querySelector<HTMLElement>('[role="option"]')!
  expect(option).not.toBeNull(); await click(option)
  expect(container.querySelector('[role="listbox"]')).toBeNull()
}
afterEach(() => {
  if (root) act(() => root!.unmount()); root = undefined
  container?.remove(); container = undefined!
  sessionStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})

it('selects one worker per @, filters full names and task titles, and sends each route explicitly', async () => {
  const { onSend } = await mount()
  expect(routerButton().getAttribute('aria-pressed')).toBe('true')
  await type('安排下一步'); await click(sendButton())
  expect(onSend).toHaveBeenLastCalledWith(expect.objectContaining({ router: true, mentions: [], text: '安排下一步' }))
  await click(routerButton()); await type('指定成员')
  expect(sendButton().disabled).toBe(true)
  expect(container.textContent).toContain('请选择 @成员或开启 R')
  await select('执行成员 1')
  await select('修复页面')
  expect(container.querySelectorAll('.mc-mention-chip')).toHaveLength(2)
  await type('请分别检查截图'); await click(sendButton())
  expect(onSend).toHaveBeenLastCalledWith(expect.objectContaining({ router: false, mentions: ['worker-a', 'worker-b'] }))
  await select('执行成员 1'); await click(routerButton()); await type('协调处理'); await click(sendButton())
  expect(onSend).toHaveBeenLastCalledWith(expect.objectContaining({ router: true, mentions: ['worker-a'], text: '协调处理' }))
})

it('allows ended workers as Router context and asks for Router before direct delivery', async () => {
  const { onSend } = await mount()
  await select('历史任务'); await type('继续这个任务'); await click(routerButton())
  expect(sendButton().disabled).toBe(true)
  expect(container.textContent).toContain('开启 R 可继续安排')
  await click(routerButton()); await click(sendButton())
  expect(onSend).toHaveBeenCalledWith(expect.objectContaining({ router: true, mentions: ['worker-c'] }))
})

it('supports keyboard mention selection, escape and input-method composition', async () => {
  const { onSend } = await mount()
  await type('@执行成员')
  await act(async () => { input().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })) })
  await act(async () => { input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
  expect(container.querySelector('.mc-mention-chip')?.textContent).toContain('执行成员 2')
  await type('@'); await act(async () => { input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
  expect(container.querySelector('[role="listbox"]')).toBeNull()
  await type('输入法完成前')
  await act(async () => { input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true, bubbles: true })) })
  expect(onSend).not.toHaveBeenCalled()
  await act(async () => { input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })) })
  expect(onSend).toHaveBeenCalledTimes(1)
})

it('persists @ targets and the R toggle per conversation, and preserves retry identity after remount', async () => {
  const onSend = vi.fn().mockRejectedValueOnce(new Error('暂时断线')).mockResolvedValue(undefined)
  await mount({ onSend })
  await select('执行成员 1'); await click(routerButton()); await type('稳定请求'); await click(sendButton())
  const first = onSend.mock.calls[0]![0]
  expect(container.textContent).toContain('暂时断线')
  await mount({ draftKey: 'another', onSend })
  expect(input().value).toBe(''); expect(routerButton().getAttribute('aria-pressed')).toBe('true')
  await mount({ onSend })
  expect(input().value).toBe('稳定请求'); expect(routerButton().getAttribute('aria-pressed')).toBe('false')
  expect(container.querySelector('.mc-mention-chip')?.textContent).toContain('执行成员 1')
  await click(sendButton())
  expect(onSend.mock.calls[1]![0]).toEqual(first)
  expect(input().value).toBe('')
})

it('uploads images before sending and supports a pure-image message without storing image data in the draft', async () => {
  const image = { id: 'image-1', name: '截图.png', mediaType: 'image/png', size: 4 }
  const call = vi.fn(async () => image) as unknown as Call
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob(['image'], { type: 'image/png' }))))
  vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:test-image'), revokeObjectURL: vi.fn() })
  const { onSend } = await mount({ call, workers: undefined })
  const picker = container.querySelector<HTMLInputElement>('input[type="file"]')!
  const file = new File(['data'], '截图.png', { type: 'image/png' })
  Object.defineProperty(picker, 'files', { value: [file], configurable: true })
  await act(async () => { picker.dispatchEvent(new Event('change', { bubbles: true })) })
  await vi.waitFor(async () => { await flush(); expect(container.querySelectorAll('.mc-attachment:not(.mc-upload)')).toHaveLength(1) })
  expect(call).toHaveBeenCalledWith('POST web/attachments', expect.objectContaining({ body: expect.objectContaining({ name: '截图.png', mediaType: 'image/png', data: 'ZGF0YQ==' }) }))
  expect(sessionStorage.getItem('test/composer')).toContain('image-1')
  expect(sessionStorage.getItem('test/composer')).not.toContain('ZGF0YQ==')
  expect(sendButton().disabled).toBe(false)
  await click(sendButton())
  expect(onSend).toHaveBeenCalledWith(expect.objectContaining({ text: '', attachmentIds: ['image-1'] }))
})

it('keeps failed uploads visible with an idempotent retry and supports deleting them', async () => {
  const image = { id: 'image-2', name: 'retry.png', mediaType: 'image/png', size: 1 }
  const call = vi.fn().mockRejectedValueOnce(new Error('上传失败')).mockResolvedValue(image) as unknown as Call
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob(['image']))))
  vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:test-image'), revokeObjectURL: vi.fn() })
  await mount({ call })
  const event = new Event('paste', { bubbles: true })
  Object.defineProperty(event, 'clipboardData', { value: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => new File(['a'], 'retry.png', { type: 'image/png' }) }] } })
  await act(async () => { input().dispatchEvent(event) })
  await vi.waitFor(async () => { await flush(); expect(container.textContent).toContain('上传失败') })
  expect(sendButton().disabled).toBe(true)
  await click([...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '重试上传')!)
  await vi.waitFor(async () => { await flush(); expect(container.querySelectorAll('.mc-attachment:not(.mc-upload)')).toHaveLength(1) })
  const calls = vi.mocked(call).mock.calls
  expect((calls[0]![1] as { body: { requestId: string } }).body.requestId).toBe((calls[1]![1] as { body: { requestId: string } }).body.requestId)
  await click(container.querySelector<HTMLButtonElement>('[aria-label="移除图片 retry.png"]')!)
  expect(container.querySelectorAll('.mc-attachment')).toHaveLength(0)
})

it('preserves a new draft when a previous send completes after leaving and returning', async () => {
  let resolve!: () => void
  const onSend = vi.fn(() => new Promise<void>(done => { resolve = done }))
  await mount({ onSend }); await type('原来的发送'); await click(sendButton())
  await mount({ draftKey: 'another', onSend }); await mount({ onSend }); await type('刚写的新草稿')
  await act(async () => { resolve() }); await flush()
  expect(input().value).toBe('刚写的新草稿')
  expect(JSON.parse(sessionStorage.getItem('test/composer')!).text).toBe('刚写的新草稿')
})

it('clears a restored unchanged draft when its original in-flight send succeeds', async () => {
  let resolve!: () => void
  const onSend = vi.fn(() => new Promise<void>(done => { resolve = done }))
  await mount({ onSend }); await type('仍在发送的内容'); await click(sendButton())
  await mount({ draftKey: 'another', onSend }); await mount({ onSend })
  expect(input().value).toBe('仍在发送的内容')
  await act(async () => { resolve() }); await flush()
  expect(input().value).toBe('')
})

it('remains usable and clears a successful draft when browser storage is unavailable', async () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage full') })
  const { onSend } = await mount()
  await type('浏览器存储已满仍可发送'); await click(sendButton())
  expect(onSend).toHaveBeenCalledTimes(1)
  expect(input().value).toBe('')
})

it('accepts dropped images and rejects unsupported or oversized files before uploading', async () => {
  const call = vi.fn(async () => ({ id: 'drop-1', name: 'drop.webp', mediaType: 'image/webp', size: 1 })) as unknown as Call
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob(['image']))))
  vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:test-image'), revokeObjectURL: vi.fn() })
  await mount({ call })
  const drop = new Event('drop', { bubbles: true, cancelable: true })
  const large = new File(['a'], 'large.png', { type: 'image/png' }); Object.defineProperty(large, 'size', { value: 11 * 1024 * 1024 })
  Object.defineProperty(drop, 'dataTransfer', { value: { files: [large, new File(['a'], 'wrong.txt', { type: 'text/plain' }), new File(['a'], 'drop.webp', { type: 'image/webp' })] } })
  await act(async () => { container.querySelector('form')!.dispatchEvent(drop) })
  await vi.waitFor(async () => { await flush(); expect(call).toHaveBeenCalledTimes(1) })
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('请选择 PNG')
})
