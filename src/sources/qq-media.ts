/** Turns downloaded QQ image/video attachments into model-visible image references. */
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, realpath, rm, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, extname, isAbsolute, join, relative, sep } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-llm'
import type { QQAttachmentFetchResult } from './qq-attachments.ts'

const VIDEO_LIMIT_MS = 30_000
const MAX_FRAMES = 6
const MAX_DIMENSION = 1280
const IMAGE_FORMATS: Record<ImageMediaType, { extension: string; magic(data: Buffer): boolean }> = {
  'image/png': { extension: '.png', magic: data => data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) },
  'image/jpeg': { extension: '.jpg', magic: data => data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff },
  'image/webp': { extension: '.webp', magic: data => data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP' },
  'image/gif': { extension: '.gif', magic: data => data.length >= 6 && ['GIF87a', 'GIF89a'].includes(data.toString('ascii', 0, 6)) },
}

export interface QqDownloadedAttachment extends QQAttachmentFetchResult { id: string; type: string }
export interface QqMediaReadResult extends QqDownloadedAttachment {
  understanding: { status: 'visual_input_ready' | 'unavailable' | 'skipped' | 'failed'; reason?: string; media?: 'image' | 'video' }
  /** Image refs are rendered as multimodal tool output; video refs are in timestamp order. */
  images?: ImageAttachmentRef[]
  frames?: { timestamp: number; image: ImageAttachmentRef }[]
  duration?: number
  audio_present?: boolean
  /** States the limits of video coverage: sampled visual frames only, with no audio transcription. */
  coverage?: string
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }

function modelRoute(agent: Agent): { provider: string; model: string } | undefined {
  const route = agent.session.requestHeader()?.config
  const provider = route?.provider ?? agent.options.provider
  const model = route?.model ?? agent.options.model
  return provider && model ? { provider, model } : undefined
}

async function imageCapability(agent: Agent, signal: AbortSignal): Promise<string | undefined> {
  const route = modelRoute(agent), llm = agent.ctx.get('llm')
  if (!route || !llm) return '当前模型路由不可用，无法确认图片输入能力'
  const info = await llm.resolveModelInfo(route.provider, route.model, signal)
  // Match DSH's attachment contract: an omitted capability list leaves the custom provider's input route available.
  return info.inputModalities !== undefined && !info.inputModalities.includes('image') ? `当前模型 ${route.model} 不支持图片输入` : undefined
}

async function binaryCandidates(kind: 'ffmpeg' | 'ffprobe'): Promise<string[]> {
  const upper = kind.toUpperCase()
  const configured = [process.env[`SUPERAGENT_${upper}_PATH`], process.env[`${upper}_PATH`]]
  const ext = process.platform === 'win32' ? '.exe' : ''
  const candidates: string[] = []
  for (const value of configured.filter((item): item is string => !!item)) {
    const info = await stat(value).catch(() => undefined)
    candidates.push(info?.isDirectory() ? join(value, `${kind}${ext}`) : value)
  }
  candidates.push(`${kind}${ext}`)
  if (process.platform === 'win32') {
    const home = homedir()
    const builds = await readdir(home, { withFileTypes: true }).catch(() => [])
    for (const build of builds.filter(item => item.isDirectory() && /^ffmpeg-.*-essentials_build$/i.test(item.name))) {
      candidates.push(join(home, build.name, 'bin', `${kind}.exe`))
    }
  }
  return [...new Set(candidates)]
}

/** A bounded FFmpeg process failure with an optional cancellation, timeout, or spawn code. */
class ProcessError extends Error { constructor(message: string, readonly code?: string) { super(message) } }

/** Uses argument arrays and shell:false. The caller's deadline covers process launch and execution. */
async function runProcess(kind: 'ffmpeg' | 'ffprobe', args: string[], signal: AbortSignal, deadline: number, maxOutput = 1_000_000): Promise<string> {
  let lastError: unknown
  for (const binary of await binaryCandidates(kind)) {
    signal.throwIfAborted()
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new ProcessError('视频处理超过 30 秒时限', 'timeout')
    try {
      return await new Promise<string>((resolve, reject) => {
        let stdout = '', stderr = '', settled = false, termination: (Error & { code?: string }) | undefined
        const child = spawn(binary, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
        const finish = (error?: Error, value = '') => {
          if (settled) return
          settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort)
          error ? reject(error) : resolve(value)
        }
        const stop = (error: ProcessError) => { termination ??= error; child.kill() }
        const abort = () => stop(new ProcessError('视频处理已取消', 'aborted'))
        const timer = setTimeout(() => stop(new ProcessError('视频处理超过 30 秒时限', 'timeout')), remaining)
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
        child.stdout.setEncoding('utf8').on('data', chunk => {
          if (termination) return
          stdout += chunk
          if (stdout.length > maxOutput) { stdout = ''; stop(new ProcessError('媒体探测输出超过限制')) }
        })
        child.stderr.setEncoding('utf8').on('data', chunk => { stderr = (stderr + chunk).slice(-64_000) })
        child.once('error', error => { termination ??= new ProcessError(error.message, (error as NodeJS.ErrnoException).code) })
        child.once('close', code => {
          if (settled) return
          if (termination) finish(termination)
          else if (code !== 0) finish(new ProcessError(`${kind} 执行失败${stderr.trim() ? `: ${stderr.trim().slice(-1000)}` : ` (exit ${code})`}`))
          else finish(undefined, stdout)
        })
      })
    } catch (error) {
      lastError = error
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
  }
  throw new ProcessError(`${kind} 不可用；请安装 FFmpeg 或配置 SUPERAGENT_${kind.toUpperCase()}_PATH`, (lastError as NodeJS.ErrnoException | undefined)?.code)
}

function temporaryChild(path: string, parent: string, prefix: string): boolean {
  const rel = relative(parent, path)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) && basename(path).startsWith(prefix)
}

async function tempDirectory(prefix: string): Promise<{ path: string; parent: string }> {
  const parent = await realpath(tmpdir()), path = await mkdtemp(join(parent, prefix))
  const resolved = await realpath(path)
  if (!temporaryChild(resolved, parent, prefix)) { await rm(path, { recursive: true, force: true }); throw new Error('媒体临时目录路径校验失败') }
  return { path: resolved, parent }
}

async function saveImage(agent: Agent, path: string, name: string | undefined, signal: AbortSignal, remainingBudget?: number): Promise<{ image: ImageAttachmentRef; bytes: number }> {
  const attachments = agent.ctx.get('attachments')
  if (!attachments) throw new Error('当前会话没有图片附件服务')
  const info = await stat(path)
  const limit = Math.min(attachments.imageLimits.maxImageBytes, attachments.imageLimits.maxMessageImageBytes, remainingBudget ?? Infinity)
  if (!info.isFile() || info.size > limit) throw new Error('图片超过会话附件字节上限或文件类型无效')
  const data = await readFile(path, { signal }); signal.throwIfAborted()
  if (data.byteLength > limit) throw new Error('图片超过会话附件字节上限')
  const format = Object.entries(IMAGE_FORMATS).find(([, value]) => value.magic(data))
  if (!format) throw new Error('图片字节格式无效，仅支持 PNG、JPEG、WebP 或 GIF')
  const mediaType = format[0] as ImageMediaType
  const requestedName = name || basename(path)
  const actualName = `${basename(requestedName, extname(requestedName)) || 'image'}${IMAGE_FORMATS[mediaType].extension}`
  const image = await attachments.saveImage({ data, mediaType, name: actualName })
  signal.throwIfAborted()
  return { image, bytes: data.byteLength }
}

async function readImage(agent: Agent, attachment: QqDownloadedAttachment, signal: AbortSignal): Promise<QqMediaReadResult> {
  if (!attachment.path) return { ...attachment, understanding: { status: 'skipped', reason: '下载结果没有本地文件路径' } }
  const unavailable = await imageCapability(agent, signal)
  if (unavailable) return { ...attachment, understanding: { status: 'unavailable', reason: unavailable } }
  const { image } = await saveImage(agent, attachment.path, attachment.name, signal)
  return { ...attachment, understanding: { status: 'visual_input_ready', media: 'image' }, images: [image] }
}

interface ProbeInfo { format?: { duration?: string }; streams?: { codec_type?: string; width?: number; height?: number }[] }
async function readVideo(agent: Agent, attachment: QqDownloadedAttachment, signal: AbortSignal): Promise<QqMediaReadResult> {
  if (!attachment.path) return { ...attachment, understanding: { status: 'skipped', reason: '下载结果没有本地文件路径' } }
  const unavailable = await imageCapability(agent, signal)
  if (unavailable) return { ...attachment, understanding: { status: 'unavailable', reason: `${unavailable}；视频理解需要把抽样画面作为图片输入` } }
  const started = Date.now(), deadline = started + VIDEO_LIMIT_MS
  const probe = JSON.parse(await runProcess('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', attachment.path], signal, deadline)) as ProbeInfo
  const duration = Number(probe.format?.duration)
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('视频时长无效')
  const frameCount = Math.min(MAX_FRAMES, Math.max(1, Math.ceil(duration)))
  const timestamps = Array.from({ length: frameCount }, (_, index) => duration * (index + 0.5) / frameCount)
  const attachments = agent.ctx.get('attachments')
  if (!attachments) throw new Error('当前会话没有图片附件服务')
  const maxMessageBytes = attachments.imageLimits.maxMessageImageBytes
  const temp = await tempDirectory('superagent-qq-video-')
  const frames: { timestamp: number; image: ImageAttachmentRef }[] = []
  let totalImageBytes = 0
  try {
    for (let index = 0; index < timestamps.length; index++) {
      signal.throwIfAborted()
      const timestamp = timestamps[index]!, output = join(temp.path, `frame-${String(index).padStart(2, '0')}.jpg`)
      await runProcess('ffmpeg', ['-v', 'error', '-nostdin', '-protocol_whitelist', 'file,pipe', '-ss', timestamp.toFixed(3), '-i', attachment.path,
        '-frames:v', '1', '-vf', `scale=w='min(${MAX_DIMENSION},iw)':h='min(${MAX_DIMENSION},ih)':force_original_aspect_ratio=decrease`, '-q:v', '3', '-y', output], signal, deadline)
      const saved = await saveImage(agent, output, `${attachment.name ?? 'video'}-frame-${index + 1}.jpg`, signal, maxMessageBytes - totalImageBytes)
      totalImageBytes += saved.bytes
      frames.push({ timestamp: Number(timestamp.toFixed(3)), image: saved.image })
    }
  } finally {
    const resolved = await realpath(temp.path).catch(() => '')
    if (resolved && temporaryChild(resolved, temp.parent, 'superagent-qq-video-')) await rm(resolved, { recursive: true, force: true })
  }
  return { ...attachment, understanding: { status: 'visual_input_ready', media: 'video' }, images: frames.map(frame => frame.image), frames,
    duration, audio_present: probe.streams?.some(stream => stream.codec_type === 'audio') ?? false,
    coverage: `仅分析最多 ${MAX_FRAMES} 张按时间顺序抽取的采样画面；音频只标记是否存在，未进行音频转录。` }
}

/** Keeps the downloaded attachment fields intact and adds an explicitly separate model-understanding result. */
export async function readQqMedia(agent: Agent, attachment: QqDownloadedAttachment, signal: AbortSignal): Promise<QqMediaReadResult> {
  if (attachment.status !== 'downloaded' || !attachment.path) return { ...attachment, understanding: { status: 'skipped', reason: `附件下载状态为 ${attachment.status}` } }
  try {
    if (attachment.type === 'image') return await readImage(agent, attachment, signal)
    if (attachment.type === 'video') return await readVideo(agent, attachment, signal)
    return { ...attachment, understanding: { status: 'unavailable', reason: `暂不支持理解 ${attachment.type} 类型附件` } }
  } catch (error) {
    if (signal.aborted) throw error
    return { ...attachment, understanding: { status: 'failed', reason: errorMessage(error) } }
  }
}
