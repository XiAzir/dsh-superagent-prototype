import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { getDefaultAutoSelectFamily, setDefaultAutoSelectFamily } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OneBotAttachment } from '../src/sources/onebot-message.ts'
import { fetchOneBotAttachment } from '../src/sources/qq-attachments.ts'

let root: string | undefined
const servers: Server[] = []
async function tempDir() {
  root = await mkdtemp(join(tmpdir(), 'qq-attachment-test-'))
  return root
}
async function fixture(body: Uint8Array, contentType = 'application/octet-stream') {
  const server = createServer((_request, response) => { response.writeHead(200, { 'content-type': contentType }); response.end(body) })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture failed to listen')
  const origin = `http://127.0.0.1:${address.port}`
  return { origin, url: `${origin}/attachment` }
}
afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  if (root) await rm(root, { recursive: true, force: true }); root = undefined
})

describe('fetchOneBotAttachment', () => {
  it('requires explicit authorization and performs no API call before authorization', async () => {
    const call = vi.fn()
    const result = await fetchOneBotAttachment({ attachment: { type: 'file', file_id: 'f1' }, messageId: '12', authorized: false, stateDir: await tempDir(), call })
    expect(result).toMatchObject({ status: 'unauthorized', error: { code: 'unauthorized', retryable: false } })
    expect(call).not.toHaveBeenCalled()
  })

  it('downloads API URL to a controlled location and enforces metadata', async () => {
    const stateDir = await tempDir()
    const remote = await fixture(new Uint8Array([37, 80, 68, 70]), 'application/pdf')
    const call = vi.fn(async () => ({ data: { url: remote.url, file_name: 'report.pdf', file_size: 4 } }))
    const result = await fetchOneBotAttachment({ attachment: { type: 'file', file_id: 'uuid-1', file: 'report.pdf' }, messageId: '-9', authorized: true, stateDir, call, downloadOrigins: [remote.origin] })
    expect(call).toHaveBeenCalledWith('get_file', { file: 'uuid-1' }, expect.any(AbortSignal))
    expect(result).toMatchObject({ status: 'downloaded', name: 'report.pdf', size: 4, mime: 'application/pdf', source: 'api-url' })
    expect(result.path).toContain(join(stateDir, 'qq-attachments'))
    expect(await readFile(result.path!)).toEqual(Buffer.from([37, 80, 68, 70]))
  })

  it.each(['image', 'video', 'file'] as const)('downloads a %s through a hostname with Node dual-stack address selection', async type => {
    const stateDir = await tempDir()
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
    const remote = await fixture(bytes, 'image/png')
    const url = remote.url.replace('127.0.0.1', 'localhost')
    const previous = getDefaultAutoSelectFamily()
    setDefaultAutoSelectFamily(true)
    try {
      const call = vi.fn(async () => ({ url, file_name: 'download.png', file_size: bytes.length }))
      const result = await fetchOneBotAttachment({ attachment: { type, file: 'download.png', file_id: 'known-locator' },
        messageId: '17', authorized: true, stateDir, call, retries: 0, downloadOrigins: [new URL(url).origin] })
      expect(result).toMatchObject({ status: 'downloaded', size: bytes.length, source: 'api-url' })
      expect(call).toHaveBeenCalledWith(type === 'image' ? 'get_image' : 'get_file', { file: 'known-locator' }, expect.any(AbortSignal))
      expect(await readFile(result.path!)).toEqual(Buffer.from(bytes))
    } finally { setDefaultAutoSelectFamily(previous) }
  })

  it('recovers the file_id from get_msg and permits only an API-returned file under an allowed NapCat root', async () => {
    const stateDir = await tempDir(), cache = join(stateDir, 'cache'), source = join(stateDir, 'outside-cache.txt')
    await mkdir(cache); await writeFile(source, 'not permitted')
    const cached = join(cache, 'napcat-file.bin'); await writeFile(cached, 'safe')
    const call = vi.fn(async (action: string) => action === 'get_msg'
      ? { data: { message: [{ type: 'file', data: { file_id: 'recovered', file: 'safe.bin' } }] } }
      : { data: { file: cached, filename: 'safe.bin' } })
    const attachment: OneBotAttachment = { type: 'file' }
    const result = await fetchOneBotAttachment({ attachment, messageId: '55', authorized: true, stateDir, call, allowLocalFiles: true })
    expect(call).toHaveBeenNthCalledWith(1, 'get_msg', { message_id: '55' }, expect.any(AbortSignal))
    expect(call).toHaveBeenNthCalledWith(2, 'get_file', { file: 'recovered' }, expect.any(AbortSignal))
    expect(result).toMatchObject({ status: 'downloaded', name: 'safe.bin', size: 4, source: 'napcat-cache' })
    expect(await readFile(result.path!, 'utf8')).toBe('safe')
    const untrusted = await fetchOneBotAttachment({ attachment: { type: 'file', file_id: 'x' }, messageId: '56', authorized: true, stateDir, call: async () => ({ file: source, filename: 'bad.txt' }), allowLocalFiles: true, napcatCacheRoot: cache })
    expect(untrusted).toMatchObject({ status: 'failed', error: { code: 'untrusted_path', retryable: false } })
  })

  it('rejects suspicious filenames and sender-supplied local paths', async () => {
    const stateDir = await tempDir()
    const pathInput: OneBotAttachment = { type: 'file', file: 'C:\\Users\\victim\\secret.txt' }
    const neverCall = vi.fn()
    const pathResult = await fetchOneBotAttachment({ attachment: pathInput, messageId: '1', authorized: true, stateDir, call: neverCall, allowLocalFiles: true, napcatCacheRoot: stateDir })
    expect(pathResult).toMatchObject({ status: 'failed', error: { code: 'invalid_name' } })
    expect(neverCall).not.toHaveBeenCalled()
    const call = vi.fn(async () => ({ data: { file: 'C:\\Users\\victim\\secret.txt', filename: '../secret.txt' } }))
    const apiNameResult = await fetchOneBotAttachment({ attachment: { type: 'file', file_id: 'known', file: 'safe.txt' }, messageId: '1', authorized: true, stateDir, call, allowLocalFiles: true, napcatCacheRoot: stateDir })
    expect(apiNameResult).toMatchObject({ status: 'failed', error: { code: 'invalid_name' } })
    expect(call).toHaveBeenCalledWith('get_file', { file: 'known' }, expect.any(AbortSignal))
  })

  it('retries transient API errors, blocks private URLs and reports byte-limit failures', async () => {
    const stateDir = await tempDir(), call = vi.fn().mockRejectedValueOnce(new Error('temporary')).mockResolvedValue({ url: 'http://127.0.0.1/private', filename: 'x.txt' })
    const blocked = await fetchOneBotAttachment({ attachment: { type: 'file', file_id: 'x' }, messageId: '1', authorized: true, stateDir, call, retries: 1 })
    expect(call).toHaveBeenCalledTimes(3)
    expect(blocked).toMatchObject({ status: 'failed', error: { code: 'blocked_url' } })
    const hugeCall = async () => ({ url: 'https://cdn.example.test/huge', filename: 'x.txt' })
    const remote = await fixture(new Uint8Array([1, 2, 3]))
    const huge = await fetchOneBotAttachment({ attachment: { type: 'file', file_id: 'huge' }, messageId: '2', authorized: true, stateDir, call: async () => ({ url: remote.url, filename: 'x.txt' }), maxBytes: 2, downloadOrigins: [remote.origin] })
    expect(huge).toMatchObject({ status: 'failed', error: { code: 'too_large' } })
  })

  it('removes downloaded bytes when server content disagrees with declared attachment size', async () => {
    const stateDir = await tempDir(), remote = await fixture(new Uint8Array([1, 2, 3, 4]))
    const result = await fetchOneBotAttachment({ attachment: { type: 'file', file_id: 'mismatch', file_size: 3 }, messageId: '8', authorized: true, stateDir,
      call: async () => ({ url: remote.url, file_name: 'data.bin' }), downloadOrigins: [remote.origin] })
    expect(result).toMatchObject({ status: 'failed', error: { code: 'size_mismatch' } })
    const folder = join(stateDir, 'qq-attachments')
    expect(await readdir(folder)).toEqual([])
  })

  it('bounds the entire API flow by one timeout and rejects ambiguous get_msg recovery', async () => {
    const stateDir = await tempDir()
    const timedOut = await fetchOneBotAttachment({ attachment: { type: 'file', file_id: 'slow' }, messageId: '3', authorized: true, stateDir, timeoutMs: 20, call: () => new Promise(() => {}) })
    expect(timedOut).toMatchObject({ status: 'failed', error: { code: 'timeout', retryable: true } })
    const ambiguous = await fetchOneBotAttachment({ attachment: { type: 'file', file: 'same.txt' }, messageId: '4', authorized: true, stateDir, call: async () => ({ data: { message: [
      { type: 'file', data: { file: 'same.txt', file_id: 'a' } }, { type: 'file', data: { file: 'same.txt', file_id: 'b' } },
    ] } }) })
    expect(ambiguous).toMatchObject({ status: 'failed', error: { code: 'ambiguous_attachment' } })
  })
})
