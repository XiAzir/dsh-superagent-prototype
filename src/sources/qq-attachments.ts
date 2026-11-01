import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, realpath, rm, stat } from 'node:fs/promises'
import { isIP } from 'node:net'
import { lookup as dnsLookup } from 'node:dns'
import { Transform, type Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { OneBotAttachment } from './onebot-message.ts'

export type QQAttachmentStatus = 'downloaded' | 'unavailable' | 'failed' | 'unauthorized'

export interface QQAttachmentFetchResult {
  status: QQAttachmentStatus
  path?: string
  name?: string
  size?: number
  mime?: string
  source?: 'message-url' | 'api-url' | 'napcat-cache'
  error?: { code: string; message: string; retryable: boolean }
}

export interface QQAttachmentFetchOptions {
  attachment: OneBotAttachment
  messageId: string
  /** Caller sets this only after the user has explicitly authorized fetching this attachment. */
  authorized: boolean
  /** Trusted application state directory; never taken from event data. */
  stateDir: string
  /** NapCat OneBot API client. API credentials stay inside this injected function. */
  call: (action: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>
  /** Absolute root containing files returned by NapCat's get_file API, if same-host paths are enabled. */
  napcatCacheRoot?: string
  /** Set only when the caller verified the OneBot peer is loopback and the cache root is trusted. */
  allowLocalFiles?: boolean
  /** Exact URL origins trusted by deployment configuration, primarily for message URLs and local fixtures. */
  downloadOrigins?: string[]
  signal?: AbortSignal
  timeoutMs?: number
  maxBytes?: number
  maxRedirects?: number
  retries?: number
}

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_REDIRECTS = 3
const DEFAULT_RETRIES = 2

/** Structured adapter failure used to classify retryable attachment errors. */
class FetchFault extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) { super(message) }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function apiData(value: unknown): Record<string, unknown> | undefined {
  const root = asRecord(value)
  return asRecord(root?.data) ?? asRecord(root?.response) ?? root
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value! > 0 ? value! : fallback
}

function validateName(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value || value.length > 240 || /[\x00-\x1f\x7f]/.test(value)) return undefined
  if (value.includes('/') || value.includes('\\') || value === '.' || value === '..' || value.includes('..')) return undefined
  if (isAbsolute(value) || basename(value) !== value || /^[a-z]:/i.test(value)) return undefined
  const cleaned = value.replace(/[<>:"|?*]/g, '_').trim().replace(/[. ]+$/, '')
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : undefined
}

function privateIPv4(host: string): boolean {
  const parts = host.split('.').map(Number)
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return true
  const [a, b] = parts as [number, number, number, number]
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168)) || (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0) || (a === 100 && b >= 64 && b <= 127)
}

function originAllowed(url: URL, origins: string[] = []): boolean {
  return origins.some(origin => { try { return new URL(origin).origin === url.origin } catch { return false } })
}

function messageUrlTrusted(input: string, origins: string[] = []): boolean {
  try { return originAllowed(allowedHttpUrl(input, origins), origins) } catch { return false }
}

function allowedHttpUrl(input: string, origins: string[] = []): URL {
  let url: URL
  try { url = new URL(input) } catch { throw new FetchFault('invalid_url', '附件下载地址无效') }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new FetchFault('invalid_url', '附件下载地址协议无效')
  if (url.username || url.password) throw new FetchFault('invalid_url', '附件下载地址包含不支持的凭据')
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const trustedOrigin = originAllowed(url, origins)
  if (!host) throw new FetchFault('blocked_url', '附件下载地址主机无效')
  if (!trustedOrigin && (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local'))) throw new FetchFault('blocked_url', '附件下载地址指向本机或局域网')
  const ipVersion = isIP(host)
  if (!trustedOrigin && ipVersion === 4 && privateIPv4(host)) throw new FetchFault('blocked_url', '附件下载地址指向本机或局域网')
  if (!trustedOrigin && ipVersion === 6 && !host.startsWith('2') && !host.startsWith('3')) throw new FetchFault('blocked_url', '附件下载地址指向本机或局域网')
  return url
}

function contentTypeMime(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const mime = value.split(';', 1)[0]?.trim().toLowerCase()
  return mime && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime) ? mime : undefined
}

function declaredSize(...values: unknown[]): number | undefined {
  for (const value of values) {
    const size = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value
    if (typeof size === 'number' && Number.isSafeInteger(size) && size >= 0) return size
  }
  return undefined
}

function verifySize(actual: number, expected: number | undefined, maxBytes: number): void {
  if (actual > maxBytes) throw new FetchFault('too_large', `附件超过 ${maxBytes} 字节上限`)
  if (expected !== undefined && actual !== expected) throw new FetchFault('size_mismatch', '下载附件大小与消息元数据不一致')
}

function mimeFromName(name: string): string | undefined {
  const types: Record<string, string> = {
    '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
    '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.zip': 'application/zip',
  }
  return types[extname(name).toLowerCase()]
}

function messageAttachment(value: unknown, original: OneBotAttachment): Record<string, unknown> | undefined {
  const root = asRecord(value)
  const message = root?.message
  if (!Array.isArray(message)) return undefined
  const candidates: Record<string, unknown>[] = []
  const wantedId = original.file_id ?? original.id
  const wantedName = [original.file_name, original.name, original.file].find(value => typeof value === 'string' && validateName(value))
  const sameType: Record<string, unknown>[] = []
  for (const item of message) {
    const segment = asRecord(item), data = asRecord(segment?.data)
    if (segment?.type !== original.type || !data) continue
    sameType.push(data)
    if (wantedId) {
      if (data.file_id === wantedId || data.id === wantedId) candidates.push(data)
      continue
    }
    const candidateName = [data.file_name, data.name, data.file].find(value => typeof value === 'string' && validateName(value))
    if (wantedName && candidateName === wantedName) candidates.push(data)
  }
  if (!wantedId && !wantedName) candidates.push(...sameType)
  if (candidates.length > 1) throw new FetchFault('ambiguous_attachment', '消息中存在多个匹配附件，无法安全确定目标')
  return candidates[0]
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw new FetchFault(signal.reason instanceof Error && signal.reason.message === 'timeout' ? 'timeout' : 'aborted', signal.reason instanceof Error && signal.reason.message === 'timeout' ? '附件获取超时' : '附件获取已取消', signal.reason instanceof Error && signal.reason.message === 'timeout')
}

async function invoke<T>(fn: () => Promise<T>, retries: number, signal: AbortSignal): Promise<T> {
  let last: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    checkAbort(signal)
    try {
      return await fn()
    } catch (error) {
      last = error
      if (error instanceof FetchFault && !error.retryable) throw error
      checkAbort(signal)
      if (attempt >= retries) break
      await new Promise(resolveDelay => setTimeout(resolveDelay, Math.min(150 * 2 ** attempt, 1200)))
      checkAbort(signal)
    }
  }
  if (last instanceof FetchFault) throw last
  throw new FetchFault('api_error', last instanceof Error ? last.message : 'OneBot API 调用失败', true)
}

function publicLookup(trustedOrigin: boolean) {
  return (hostname: string, _options: unknown, callback: (error: NodeJS.ErrnoException | null, address?: string | Array<{ address: string; family: number }>, family?: number) => void) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error) { callback(error); return }
      const list = addresses as Array<{ address: string; family: number }>
      if (!trustedOrigin && list.some(entry => entry.family === 4 ? privateIPv4(entry.address) : !entry.address.toLowerCase().startsWith('2') && !entry.address.toLowerCase().startsWith('3'))) {
        callback(new FetchFault('blocked_url', '附件下载域名解析到本机或局域网'))
        return
      }
      const chosen = list[0]
      if (!chosen) { callback(new Error('empty dns result')); return }
      callback(null, chosen.address, chosen.family)
    })
  }
}

async function download(urlInput: string, target: string, limit: number, maxRedirects: number, signal: AbortSignal, origins: string[]): Promise<{ size: number; mime?: string }> {
  let url = allowedHttpUrl(urlInput, origins)
  for (let redirect = 0; redirect <= maxRedirects; redirect++) {
    checkAbort(signal)
    const trustedOrigin = originAllowed(url, origins)
    const requestImpl = url.protocol === 'https:' ? httpsRequest : httpRequest
    const response = await new Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; body: Readable }>((resolveResponse, reject) => {
      const request = requestImpl(url, { signal, lookup: publicLookup(trustedOrigin) as never }, incoming => {
        resolveResponse({ status: incoming.statusCode ?? 0, headers: incoming.headers, body: incoming as Readable })
      })
      request.once('error', reject)
      request.end()
    })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      response.body.destroy()
      const location = response.headers.location
      if (!location || redirect === maxRedirects) throw new FetchFault('redirect_limit', '附件下载重定向次数超限')
      url = allowedHttpUrl(new URL(location, url).toString(), origins)
      continue
    }
    if (response.status < 200 || response.status >= 300) { response.body.destroy(); throw new FetchFault('http_error', `附件服务器返回 HTTP ${response.status}`, response.status >= 500 || response.status === 429) }
    const declared = Number(response.headers['content-length'])
    if (Number.isFinite(declared) && declared > limit) { response.body.destroy(); throw new FetchFault('too_large', `附件超过 ${limit} 字节上限`) }
    let size = 0
    const limiter = new Transform({ transform(chunk, _encoding, callback) { size += chunk.length; if (size > limit) callback(new FetchFault('too_large', `附件超过 ${limit} 字节上限`)); else callback(null, chunk) } })
    try { await pipeline(response.body as never, limiter, createWriteStream(target, { flags: 'wx' }), { signal }) }
    catch (error) { await rm(target, { force: true }); throw error }
    return { size, mime: contentTypeMime(response.headers['content-type']) }
  }
  throw new FetchFault('redirect_limit', '附件下载重定向次数超限')
}

async function copyNapCatFile(source: string, cacheRoot: string | undefined, target: string, maxBytes: number, signal: AbortSignal): Promise<number> {
  if (!isAbsolute(source)) throw new FetchFault('untrusted_path', 'NapCat 返回了不受信任的本机路径')
  let path: string
  try { path = await realpath(source) } catch { throw new FetchFault('untrusted_path', 'NapCat 返回的缓存文件不可访问') }
  if (cacheRoot) {
    let root: string
    try { root = await realpath(cacheRoot) } catch { throw new FetchFault('untrusted_path', 'NapCat 缓存根目录不可访问') }
    const rel = relative(root, path)
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new FetchFault('untrusted_path', 'NapCat 文件路径超出可信缓存目录')
  }
  const info = await stat(path)
  if (!info.isFile()) throw new FetchFault('invalid_file', 'NapCat 返回的路径不是普通文件')
  if (info.size > maxBytes) throw new FetchFault('too_large', `附件超过 ${maxBytes} 字节上限`)
  checkAbort(signal)
  try { await pipeline(createReadStream(path), createWriteStream(target, { flags: 'wx' }), { signal }) }
  catch (error) { await rm(target, { force: true }); throw error }
  checkAbort(signal)
  return info.size
}

async function fetchAuthorized(options: QQAttachmentFetchOptions, signal: AbortSignal, limits: { maxBytes: number; retries: number; maxRedirects: number }): Promise<QQAttachmentFetchResult> {
  const { attachment, messageId } = options
  let outputPath: string | undefined
  try {
    const hash = createHash('sha256').update(`${messageId}:${attachment.file_id ?? attachment.id ?? attachment.file_name ?? attachment.name ?? attachment.file ?? ''}`).digest('hex')
    const directory = join(resolve(options.stateDir), 'qq-attachments')
    await mkdir(directory, { recursive: true })
    const rawName = [attachment.file_name, attachment.name, attachment.file].find(value => typeof value === 'string' && value)
    let name = validateName(rawName)
    if (rawName && !name) throw new FetchFault('invalid_name', '附件名称含路径或可疑字符')
    const targetPath = join(directory, `${hash.slice(0, 24)}-${randomBytes(6).toString('hex')}${extname(name ?? '')}`)
    outputPath = targetPath

    let lookupFault: unknown
    // A message URL is usable only when its origin is explicitly trusted by the bridge/configuration.
    if (attachment.url && messageUrlTrusted(attachment.url, options.downloadOrigins)) {
      try {
        const saved = await invoke(() => download(attachment.url!, targetPath, limits.maxBytes, limits.maxRedirects, signal, options.downloadOrigins ?? []), limits.retries, signal)
        checkAbort(signal)
        const info = await stat(targetPath)
        if (info.size !== saved.size) throw new FetchFault('size_mismatch', '保存后的附件大小校验失败')
        verifySize(info.size, declaredSize(attachment.file_size, attachment.size), limits.maxBytes)
        return { status: 'downloaded', path: targetPath, ...(name ? { name } : {}), size: info.size, mime: saved.mime ?? (name ? mimeFromName(name) : undefined), source: 'message-url' }
      } catch (error) { lookupFault = error; await rm(targetPath, { force: true }) }
    }

    let apiMeta: Record<string, unknown> | undefined
    let trustedApiMeta = false
    // Image/video segments conventionally carry their opaque OneBot locator in `file`.
    let apiLocator = attachment.file_id ?? attachment.id ?? (attachment.type !== 'file' ? attachment.file : undefined)
    const action = attachment.type === 'image' ? 'get_image' : 'get_file'
    const readApiMeta = async (locator: string): Promise<void> => {
      const response = await invoke(() => options.call(action, { file: locator }, signal), limits.retries, signal)
      checkAbort(signal)
      apiMeta = apiData(response) ?? {}
      trustedApiMeta = true
      const apiName = [apiMeta.file_name, apiMeta.filename, apiMeta.name].find(value => typeof value === 'string' && value)
      if (apiName) {
        const validated = validateName(apiName)
        if (!validated) throw new FetchFault('invalid_name', '附件名称含路径或可疑字符')
        name = validated
      }
    }
    if (apiLocator) {
      try { await readApiMeta(apiLocator) } catch (error) { lookupFault = error; apiMeta = undefined; trustedApiMeta = false }
    }

    const tryApiMeta = async (): Promise<QQAttachmentFetchResult | undefined> => {
      if (!apiMeta || !trustedApiMeta) return undefined
      checkAbort(signal)
      if (typeof apiMeta.url === 'string' && apiMeta.url) {
        const saved = await invoke(() => download(apiMeta!.url as string, targetPath, limits.maxBytes, limits.maxRedirects, signal, options.downloadOrigins ?? []), limits.retries, signal)
        checkAbort(signal)
        const info = await stat(targetPath)
        if (info.size !== saved.size) throw new FetchFault('size_mismatch', '保存后的附件大小校验失败')
        verifySize(info.size, declaredSize(apiMeta.file_size, apiMeta.size, attachment.file_size, attachment.size), limits.maxBytes)
        return { status: 'downloaded', path: targetPath, ...(name ? { name } : {}), size: info.size, mime: saved.mime ?? (name ? mimeFromName(name) : undefined), source: 'api-url' }
      }
      const apiPath = [apiMeta.file, apiMeta.path].find(value => typeof value === 'string' && isAbsolute(value))
      if (typeof apiPath === 'string') {
        if (!options.allowLocalFiles) throw new FetchFault('untrusted_path', '未启用 NapCat 本机缓存路径访问')
        const size = await copyNapCatFile(apiPath, options.napcatCacheRoot, targetPath, limits.maxBytes, signal)
        checkAbort(signal)
        const info = await stat(targetPath)
        if (info.size !== size) throw new FetchFault('size_mismatch', '保存后的附件大小校验失败')
        verifySize(info.size, declaredSize(apiMeta.file_size, apiMeta.size, attachment.file_size, attachment.size), limits.maxBytes)
        return { status: 'downloaded', path: targetPath, ...(name ? { name } : {}), size, mime: name ? mimeFromName(name) : undefined, source: 'napcat-cache' }
      }
      return undefined
    }

    if (apiMeta) {
      try { const result = await tryApiMeta(); if (result) return result }
      catch (error) { lookupFault = error; await rm(targetPath, { force: true }) }
    }

    // On stale/missing locator or a failed first download, recover the matching segment from get_msg.
    checkAbort(signal)
    try {
      const response = await invoke(() => options.call('get_msg', { message_id: messageId }, signal), limits.retries, signal)
      checkAbort(signal)
      const found = messageAttachment(apiData(response) ?? response, attachment)
      if (found) {
        const recoveredId = [found.file_id, found.id, ...(attachment.type !== 'file' ? [found.file] : [])]
          .find(value => typeof value === 'string' && validateName(value))
        if (typeof recoveredId === 'string' && recoveredId !== apiLocator) {
          apiLocator = recoveredId
          try { await readApiMeta(recoveredId); const result = await tryApiMeta(); if (result) return result }
          catch (error) { lookupFault = error; await rm(targetPath, { force: true }) }
        }
        if (typeof found.url === 'string' && messageUrlTrusted(found.url, options.downloadOrigins)) {
          const saved = await invoke(() => download(found.url as string, targetPath, limits.maxBytes, limits.maxRedirects, signal, options.downloadOrigins ?? []), limits.retries, signal)
          checkAbort(signal)
          const info = await stat(targetPath)
          if (info.size !== saved.size) throw new FetchFault('size_mismatch', '保存后的附件大小校验失败')
          verifySize(info.size, declaredSize(found.file_size, found.size, attachment.file_size, attachment.size), limits.maxBytes)
          return { status: 'downloaded', path: targetPath, ...(name ? { name } : {}), size: info.size, mime: saved.mime ?? (name ? mimeFromName(name) : undefined), source: 'message-url' }
        }
      }
    } catch (error) { lookupFault = error }

    await rm(targetPath, { force: true })
    const fault = lookupFault instanceof FetchFault ? lookupFault : undefined
    if (fault) throw fault
    return { status: 'unavailable', ...(name ? { name } : {}), error: { code: 'locator_unavailable', message: 'OneBot API 未返回可用的附件下载地址或缓存文件', retryable: true } }
  } catch (error) {
    if (outputPath) await rm(outputPath, { force: true }).catch(() => undefined)
    let fault: FetchFault
    try { checkAbort(signal); fault = error instanceof FetchFault ? error : new FetchFault('download_error', error instanceof Error ? error.message : '附件获取失败', true) }
    catch (aborted) { fault = aborted instanceof FetchFault ? aborted : new FetchFault('aborted', '附件获取已取消') }
    return { status: fault.code === 'locator_unavailable' ? 'unavailable' : 'failed', error: { code: fault.code, message: fault.message, retryable: fault.retryable } }
  }
}

/** Fetches one attachment only after an explicit authorization decision. */
export async function fetchOneBotAttachment(options: QQAttachmentFetchOptions): Promise<QQAttachmentFetchResult> {
  if (!options.authorized) return { status: 'unauthorized', error: { code: 'unauthorized', message: '尚未授权获取此附件', retryable: false } }
  if (!/^-?\d+$/.test(options.messageId) || options.messageId === '-0') return { status: 'failed', error: { code: 'invalid_message_id', message: '消息 ID 无效', retryable: false } }
  if (options.signal?.aborted) return { status: 'failed', error: { code: 'aborted', message: '附件获取已取消', retryable: false } }
  const timeoutMs = positiveLimit(options.timeoutMs, DEFAULT_TIMEOUT_MS)
  const controller = new AbortController()
  const abortFromCaller = () => controller.abort(options.signal?.reason ?? new Error('aborted'))
  options.signal?.addEventListener('abort', abortFromCaller, { once: true })
  const timeout = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
  const abortPromise = new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => {
    const timedOut = controller.signal.reason instanceof Error && controller.signal.reason.message === 'timeout'
    reject(new FetchFault(timedOut ? 'timeout' : 'aborted', timedOut ? '附件获取超时' : '附件获取已取消', timedOut))
  }, { once: true }))
  try {
    const work = fetchAuthorized(options, controller.signal, {
      maxBytes: positiveLimit(options.maxBytes, DEFAULT_MAX_BYTES),
      retries: Math.min(5, Math.max(0, options.retries ?? DEFAULT_RETRIES)),
      maxRedirects: Math.min(5, Math.max(0, options.maxRedirects ?? DEFAULT_REDIRECTS)),
    })
    return await Promise.race([work, abortPromise])
  } catch (error) {
    const fault = error instanceof FetchFault ? error : new FetchFault('download_error', error instanceof Error ? error.message : '附件获取失败', true)
    return { status: 'failed', error: { code: fault.code, message: fault.message, retryable: fault.retryable } }
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', abortFromCaller)
  }
}
