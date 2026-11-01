import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, isAbsolute, join, relative, sep } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { afterEach, expect, it, vi } from 'vitest'
import { readQqMedia } from '../src/sources/qq-media.ts'

const directories: string[] = []
async function workdir() { const path = await mkdtemp(join(tmpdir(), 'qq-media-test-')); directories.push(path); return path }
afterEach(async () => {
  const root = await realpath(tmpdir())
  await Promise.all(directories.splice(0).map(async path => {
    const resolved = await realpath(path).catch(() => '')
    const rel = relative(root, resolved)
    if (resolved && basename(resolved).startsWith('qq-media-test-') && rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) {
      await rm(resolved, { recursive: true, force: true })
    }
  }))
})

async function mediaBinary(kind: 'ffmpeg' | 'ffprobe'): Promise<string> {
  const upper = kind.toUpperCase(), configured = process.env[`SUPERAGENT_${upper}_PATH`] ?? process.env[`${upper}_PATH`]
  if (configured) {
    const info = await stat(configured).catch(() => undefined)
    return info?.isDirectory() ? join(configured, `${kind}${process.platform === 'win32' ? '.exe' : ''}`) : configured
  }
  if (process.platform === 'win32') {
    const home = homedir()
    for (const entry of await readdir(home, { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory() && /^ffmpeg-.*-essentials_build$/i.test(entry.name)) return join(home, entry.name, 'bin', `${kind}.exe`)
    }
  }
  return `${kind}${process.platform === 'win32' ? '.exe' : ''}`
}

/** Test helper has a hard deadline and waits for the child close event after requesting termination. */
async function runBounded(binary: string, args: string[], timeoutMs = 12_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', timedOut = false
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr = (stderr + chunk).slice(-4000) })
    const timer = setTimeout(() => { timedOut = true; child.kill() }, timeoutMs)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', code => {
      clearTimeout(timer)
      if (timedOut) reject(new Error(`fixture process timed out (${timeoutMs}ms)`))
      else if (code !== 0) reject(new Error(`fixture process exited ${code}: ${stderr}`))
      else resolve(stdout)
    })
  })
}

function mockAgent(modalities: string[] | null = ['text', 'image'], limits = { maxImageBytes: 4_000_000, maxMessageImageBytes: 4_000_000 }) {
  const ctx = new Context()
  let count = 0
  const saveImage = vi.fn(async ({ data, mediaType, name }: { data: Uint8Array; mediaType: string; name?: string }) => ({
    attachmentId: `img-${++count}`, mediaType, bytes: data.byteLength, ...(name ? { name } : {}),
  }))
  ctx.reflect.provide('attachments', { saveImage, imageLimits: limits })
  ctx.reflect.provide('llm', { resolveModelInfo: vi.fn(async () => modalities === null ? {} : { inputModalities: modalities }) })
  const agent = { ctx, session: { requestHeader: () => ({ config: { provider: 'test-provider', model: 'test-model' } }) }, options: {} } as unknown as Agent
  return { agent, saveImage }
}

it('detects a real PNG by bytes when the downloaded path has no extension', async () => {
  const dir = await workdir(), generated = join(dir, 'tiny.png'), path = join(dir, 'download-without-extension')
  await runBounded(await mediaBinary('ffmpeg'), ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=4x4', '-frames:v', '1', '-f', 'image2', '-vcodec', 'png', '-y', generated])
  await writeFile(path, await readFile(generated))
  const { agent, saveImage } = mockAgent()
  const result = await readQqMedia(agent, { id: 'a1', type: 'image', status: 'downloaded', path, name: 'picture' }, new AbortController().signal)
  expect(result).toMatchObject({ id: 'a1', status: 'downloaded', path, understanding: { status: 'visual_input_ready', media: 'image' }, images: [{ attachmentId: 'img-1' }] })
  expect(saveImage).toHaveBeenCalledWith(expect.objectContaining({ mediaType: 'image/png', name: 'picture.png' }))
})

it('refuses invalid image bytes and reports unavailable modality without saving', async () => {
  const dir = await workdir(), path = join(dir, 'invalid.png')
  await writeFile(path, Buffer.from('not an image'))
  const { agent, saveImage } = mockAgent()
  const invalid = await readQqMedia(agent, { id: 'bad', type: 'image', status: 'downloaded', path }, new AbortController().signal)
  expect(invalid).toMatchObject({ status: 'downloaded', path, understanding: { status: 'failed', reason: expect.stringContaining('字节格式无效') } })
  expect(saveImage).not.toHaveBeenCalled()
  const noImage = mockAgent(['text'])
  const unavailable = await readQqMedia(noImage.agent, { id: 'no-modality', type: 'image', status: 'downloaded', path }, new AbortController().signal)
  expect(unavailable.understanding).toMatchObject({ status: 'unavailable' })
  expect(noImage.saveImage).not.toHaveBeenCalled()
})

it('keeps image input available when a custom provider omits modality metadata, matching DSH', async () => {
  const dir = await workdir(), path = join(dir, 'image.png')
  await writeFile(path, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9V0AAAAASUVORK5CYII=', 'base64'))
  const { agent, saveImage } = mockAgent(null)
  const result = await readQqMedia(agent, { id: 'custom-provider', type: 'image', status: 'downloaded', path }, new AbortController().signal)
  expect(result.understanding).toMatchObject({ status: 'visual_input_ready', media: 'image' })
  expect(result.images).toEqual([expect.objectContaining({ attachmentId: 'img-1', mediaType: 'image/png' })])
  expect(saveImage).toHaveBeenCalledTimes(1)
})

it('extracts at most six ordered bounded frames and labels video coverage', async () => {
  const dir = await workdir(), video = join(dir, 'sample.mp4'), tool = await mediaBinary('ffmpeg')
  await runBounded(tool, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=96x64:rate=4', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=8000',
    '-t', '8', '-c:v', 'mpeg4', '-q:v', '5', '-c:a', 'aac', '-shortest', '-y', video])
  const tempParent = await realpath(tmpdir())
  const before = new Set((await readdir(tempParent)).filter(name => name.startsWith('superagent-qq-video-')))
  const { agent, saveImage } = mockAgent()
  const result = await readQqMedia(agent, { id: 'v1', type: 'video', status: 'downloaded', path: video, name: 'sample.mp4' }, new AbortController().signal)
  expect(result).toMatchObject({ status: 'downloaded', path: video, understanding: { status: 'visual_input_ready', media: 'video' }, audio_present: true })
  expect(result.coverage).toMatch(/最多 6 张.*未进行音频转录/)
  expect(result.duration).toBeCloseTo(8, 1)
  expect(result.frames).toHaveLength(6)
  expect(result.images).toHaveLength(6)
  expect(result.frames!.map(frame => frame.timestamp)).toEqual([...result.frames!.map(frame => frame.timestamp)].sort((a, b) => a - b))
  expect(result.frames!.every(frame => frame.timestamp > 0 && frame.timestamp < result.duration!)).toBe(true)
  expect(saveImage).toHaveBeenCalledTimes(6)
  const savedSizes = await Promise.all(saveImage.mock.calls.map(async ([input], index) => {
    const data = (input as { data: Uint8Array }).data
    const output = join(dir, `saved-${index}.jpg`); await writeFile(output, data)
    const probe = await runBounded(await mediaBinary('ffprobe'), ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', output])
    return { size: (await stat(output)).size, ...JSON.parse(probe).streams[0] as { width: number; height: number } }
  }))
  expect(savedSizes.every(frame => frame.size > 0 && frame.width <= 1280 && frame.height <= 1280)).toBe(true)
  expect((await readdir(tempParent)).filter(name => name.startsWith('superagent-qq-video-')).filter(name => !before.has(name))).toEqual([])
})

it('bounds total video frame bytes by the session message limit', async () => {
  const dir = await workdir(), video = join(dir, 'sample.mp4')
  const ffmpeg = await mediaBinary('ffmpeg')
  await runBounded(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:size=96x64:rate=4', '-t', '4', '-c:v', 'mpeg4', '-y', video])
  const singleFrame = join(dir, 'single.jpg')
  await runBounded(ffmpeg, ['-v', 'error', '-ss', '0.500', '-i', video, '-frames:v', '1', '-vf', "scale=w='min(1280,iw)':h='min(1280,ih)':force_original_aspect_ratio=decrease", '-q:v', '3', '-y', singleFrame])
  const singleFrameBytes = (await stat(singleFrame)).size
  const tempParent = await realpath(tmpdir())
  const before = new Set((await readdir(tempParent)).filter(name => name.startsWith('superagent-qq-video-')))
  const { agent, saveImage } = mockAgent(['text', 'image'], { maxImageBytes: 4_000_000, maxMessageImageBytes: singleFrameBytes + 1 })
  const result = await readQqMedia(agent, { id: 'v2', type: 'video', status: 'downloaded', path: video }, new AbortController().signal)
  expect(result.understanding).toMatchObject({ status: 'failed', reason: expect.stringContaining('字节上限') })
  expect(saveImage).toHaveBeenCalledTimes(1)
  expect((await readdir(tempParent)).filter(name => name.startsWith('superagent-qq-video-')).filter(name => !before.has(name))).toEqual([])
})

it('leaves non-downloaded attachments in skipped understanding state', async () => {
  const { agent } = mockAgent()
  await expect(readQqMedia(agent, { id: 'a3', type: 'video', status: 'unavailable' }, new AbortController().signal))
    .resolves.toMatchObject({ status: 'unavailable', understanding: { status: 'skipped' } })
})
