/** Owner uploads stored as immutable image handles and resolved through the Web source. */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { z } from 'zod'
import { key, type Trigger } from '../core/index.ts'
import { record } from '../kv.ts'
import type { Store } from './store.ts'

export const MAX_WEB_IMAGE_BYTES = 10 * 1024 * 1024
export const MAX_WEB_IMAGE_BODY_BYTES = Math.ceil(MAX_WEB_IMAGE_BYTES / 3) * 4 + 4096
export interface WebImage { id: string; name: string; mediaType: string; size: number }
interface StoredImage extends WebImage { sha256: string }
const imageKey = (id: string) => record<StoredImage>(`web-image:${id}`)
const ImageUpload = z.object({ name: z.string().trim().min(1).max(240),
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  data: z.string().min(1).max(Math.ceil(MAX_WEB_IMAGE_BYTES / 3) * 4),
  requestId: z.string().regex(/^[A-Za-z0-9_-]{8,80}$/) }).strict()
export const WebImageIds = z.array(z.string().regex(/^[a-f0-9]{32}$/)).max(8).default([])
export class WebImageError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) { super(message) }
}
const magic = (type: string, bytes: Buffer): boolean => type === 'image/png'
  ? bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  : type === 'image/jpeg' ? bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    : type === 'image/webp' ? bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
      : bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))

export class WebAttachmentStore {
  constructor(private readonly store: Pick<Store, 'get' | 'set'>, private readonly stateDir: string,
    private readonly authorized: () => boolean) {}
  private allow(): void { if (!this.authorized()) throw new WebImageError(409, '请恢复个人模式的 Web 来源与 owner 授权后使用图片。') }
  private path(image: StoredImage): string { return join(this.stateDir, 'web-images', `${image.id}.${image.sha256}`) }
  upload(input: unknown): WebImage {
    this.allow()
    const request = ImageUpload.parse(input)
    if (request.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(request.data)) throw new WebImageError(400, '图片编码无效。')
    const bytes = Buffer.from(request.data, 'base64')
    if (bytes.toString('base64') !== request.data) throw new WebImageError(400, '图片编码无效。')
    if (!bytes.length || bytes.length > MAX_WEB_IMAGE_BYTES || !magic(request.mediaType, bytes)) throw new WebImageError(400, '请选择 10 MB 以内的 PNG、JPEG、WebP 或 GIF 图片。')
    const id = key('web-image', request.requestId), sha256 = createHash('sha256').update(bytes).digest('hex')
    const name = basename(request.name.replaceAll('\\', '/')).replace(/[\u0000-\u001f\u007f]/g, '') || 'image'
    const image: StoredImage = { id, name, mediaType: request.mediaType, size: bytes.length, sha256 }
    const old = this.store.get(imageKey(id))
    if (old && JSON.stringify(old) !== JSON.stringify(image)) throw new WebImageError(409, '图片上传编号已用于另一张图片。')
    mkdirSync(join(this.stateDir, 'web-images'), { recursive: true, mode: 0o700 })
    try { writeFileSync(this.path(image), bytes, { flag: 'wx', mode: 0o600 }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    this.allow(); this.store.set(imageKey(id), image)
    return this.describe(id)
  }
  describe(id: string): WebImage {
    this.allow()
    const image = /^[a-f0-9]{32}$/.test(id) ? this.store.get(imageKey(id)) : undefined
    if (!image) throw new WebImageError(404, '图片不存在，请重新上传。')
    const { sha256: _hash, ...description } = image
    return description
  }
  descriptions(ids: string[]): WebImage[] { return [...new Set(ids)].map(id => this.describe(id)) }
  bytes(id: string): { image: WebImage; bytes: Buffer } {
    const description = this.describe(id), image = this.store.get(imageKey(id))!
    let bytes: Buffer
    try { bytes = readFileSync(this.path(image)) } catch { throw new WebImageError(404, '图片文件暂时不可用，请重新上传。') }
    if (bytes.length !== image.size || bytes.length > MAX_WEB_IMAGE_BYTES || createHash('sha256').update(bytes).digest('hex') !== image.sha256) {
      throw new WebImageError(404, '图片文件校验失败，请重新上传。')
    }
    this.allow(); return { image: description, bytes }
  }
  references(triggerId: string, ids: string[]) {
    return this.descriptions(ids).map(image => ({ id: image.id, type: 'image' as const, name: image.name, size: image.size,
      status: 'available', read: `attachment/${triggerId}/${image.id}` }))
  }
  async read(trigger: Trigger, id: string, agent: Agent | undefined, signal: AbortSignal): Promise<unknown> {
    this.allow(); signal.throwIfAborted()
    if (trigger.source !== 'web' || trigger.actor.id !== 'owner' || !trigger.attachments?.some(image => image.id === id)) throw new WebImageError(404, '请选择当前消息附带的图片。')
    const { image, bytes } = this.bytes(id), stored = this.store.get(imageKey(id))!
    const result = { id, type: 'image', name: image.name, size: image.size, path: this.path(stored), status: 'downloaded' }
    if (!agent) return result
    const attachments = agent.ctx.get('attachments')
    if (!attachments) return { ...result, understanding: { status: 'unavailable', reason: '当前会话的图片附件服务正在初始化。' } }
    if (bytes.length > Math.min(attachments.imageLimits.maxImageBytes, attachments.imageLimits.maxMessageImageBytes)) {
      return { ...result, understanding: { status: 'unavailable', reason: '图片超过当前模型的附件上限，可使用本地图片路径继续查看。' } }
    }
    const visual = await attachments.saveImage({ data: bytes, mediaType: image.mediaType as ImageMediaType, name: image.name })
    signal.throwIfAborted(); this.allow()
    return { ...result, understanding: { status: 'visual_input_ready', media: 'image' }, images: [visual] }
  }
}
