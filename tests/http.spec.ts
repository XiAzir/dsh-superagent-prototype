import { expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { registerHttp } from '../src/app/http.ts'
import { ArtifactRegistry } from '../src/app/artifacts.ts'
import { Store } from '../src/app/store.ts'
import { record } from '../src/kv.ts'
import { PromptConflict } from '../src/app/prompts.ts'
import { SettingsConflict } from '../src/app/settings.ts'
import type { HttpHost } from '../src/app/http.ts'
import { SettingsSchema } from '../src/policy.ts'
import { SetupError } from '../src/setup.ts'

type Handler = (req: unknown, res: unknown) => Promise<void>
type Headers = Record<string, string | undefined>

it('protects the QQ credential endpoint with the same origin check and accepts only a bounded token value', async () => {
  const saved: string[] = []
  const call = serve({ qq: { status: async () => ({ tokenConfigured: true }), setToken: async (value: string) => {
    saved.push(value); return { configured: !!value }
  } } })
  expect(await call('PUT', 'qq/token', { value: 'onebot-test-token' }, { 'x-orchestrator-request': undefined })).toMatchObject({ status: 403 })
  expect(saved).toEqual([])
  expect(await call('PUT', 'qq/token', { value: 'x'.repeat(4001) })).toMatchObject({ status: 400 })
  expect(await call('PUT', 'qq/token', { value: 'onebot-test-token', actor: 'forged' })).toMatchObject({ status: 400 })
  expect(await call('PUT', 'qq/token', { value: 'onebot-test-token' })).toEqual({ status: 200, body: { configured: true } })
  expect(await call('GET', 'qq/status')).toEqual({ status: 200, body: { tokenConfigured: true } })
  expect(saved).toEqual(['onebot-test-token'])
})
/** Mount management HTTP routes on a fake web server and return a request helper that includes default panel headers. */
function serve(runtime: Partial<Record<keyof HttpHost, unknown>>, host = '127.0.0.1') {
  let handler: Handler = async () => {}
  const ctx = { webServer: { host, port: 3082, register: (route: { handler: Handler }) => { handler = route.handler; return () => {} } } }
  registerHttp(ctx as never, { ready: Promise.resolve(), ...runtime } as unknown as HttpHost)
  return async (method: string, path: string, body?: unknown, headers: Headers = {}) => {
    let status = 0, data = Buffer.alloc(0)
    let responseHeaders: Record<string, string> = {}
    const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
    const sent = Object.fromEntries(Object.entries({ host: '127.0.0.1:3082', 'x-orchestrator-request': '1', ...headers }).filter(([,
      value]) => value !== undefined))
    const req = { method, url: `/orchestrator/api/${path}`, headers: sent, async *[Symbol.asyncIterator]() { yield* chunks } }
    await handler(req, { writeHead: (code: number, values?: Record<string, string>) => { status = code; responseHeaders = values ?? {} },
      end: (value?: string | Buffer | Uint8Array) => { if (value !== undefined) data = Buffer.from(value) } })
    if (responseHeaders['content-type'] === 'application/octet-stream') return { status, bytes: data, headers: responseHeaders }
    return { status, body: JSON.parse(data.toString('utf8')) as Record<string, unknown> }
  }
}

it('answers each kind of failure with its own status', async () => {
  const saves: unknown[] = []
  const call = serve({
    store: { tickets: { get: () => undefined }, blockRevision: () => 0 },
    sources: { instances: () => [{ id: 'github' }] },
    settings: { save: async (...args: unknown[]) => {
      saves.push(args)
      if (args[1] === 'stale') throw new SettingsConflict('Settings changed. Reload before saving.')
      if (args[1] === 'invalid') z.object({ maxWorkers: z.number() }).parse({})
      if (args[1] === 'refused') throw new SetupError('agentCliUnset')
      if (args[1] === 'broken') throw new Error('disk full')
      return { saved: true, revision: 1, restarting: false }
    } },
  })
  expect(await call('PUT', 'settings/executor', { value: 'stale', revision: 0 })).toMatchObject({ status: 409 })
  expect(await call('PUT', 'settings/executor', { value: 'invalid', revision: 0 })).toMatchObject({ status: 400, body: { issues: [{ path: 'maxWorkers' }] } })
  expect(await call('PUT', 'settings/source:github', { value: 'refused', revision: 0 })).toMatchObject({ status: 400, body: { setup: { code: 'agentCliUnset', place: 'github' } } })
  expect(await call('PUT', 'settings/executor', { value: 'broken', revision: 0 })).toEqual({ status: 500, body: { error: 'disk full' } })
  // Block names are validated before calling settings.save: reject unknown blocks or non-existent Sources.
  expect(await call('PUT', 'settings/pause', { value: {}, revision: 0 })).toMatchObject({ status: 400 })
  expect(await call('PUT', 'settings/source:feishu', { value: {}, revision: 0 })).toEqual({ status: 404, body: { error: 'Source not found' } })
  expect(saves).toHaveLength(4)
  expect(await call('POST', 'tickets/t9/retry')).toEqual({ status: 404, body: { error: 'Ticket not found' } })
  expect(await call('GET', 'nothing/here')).toEqual({ status: 404, body: { error: 'Unknown operation' } })
  expect(await call('POST', 'executor/pause', 'not json')).toEqual({ status: 400, body: { error: 'The request body is not JSON' } })
})

it('decodes path parameters and parses each route\'s query', async () => {
  const seen: unknown[] = []
  const call = serve({
    store: { settings: () => SettingsSchema.parse({}),
      read: { decisions: (filter: unknown, offset: number, limit: number) => { seen.push({ filter, offset, limit }); return { items: [], more: false } } } },
    links: () => () => ({ url: '', label: { zh: '', en: '' } }),
    engine: { unsubscribe: (key: string) => { seen.push(key); return true } },
    sessions: { delivery: async () => 'injected' },
  })
  expect(await call('POST', `threads/${encodeURIComponent('feishu:oc_1:om/root')}/unsubscribe`)).toMatchObject({ status: 200, body: { context_delivery: 'injected' } })
  // Invalid offsets default to 0, and limits above the route maximum are clamped.
  expect(await call('GET', 'decisions?kind=accept%2Creopen&limit=500&offset=x&window=24h')).toEqual({ status: 200, body: { items: [], next_offset: null } })
  expect(seen).toEqual(['feishu:oc_1:om/root', { filter: { kinds: ['accept', 'reopen'], since: expect.any(String) }, offset: 0, limit: 200 }])
})

it('answers only a same-origin request from the panel on the loopback address', async () => {
  const call = serve({ sessions: { delivery: async () => 'injected' }, engine: { unsubscribe: () => true } })
  const post = (headers: Headers) => call('POST', 'threads/github%3A1/unsubscribe', undefined, headers)
  for (const headers of [{ 'x-orchestrator-request': undefined }, { host: 'evil.example:3082' }, { host: '127.0.0.1:9999' },
    { origin: 'http://evil.example' }, { host: 'localhost:3082', origin: 'http://127.0.0.1:3082' }]) {
    expect(await post(headers), JSON.stringify(headers)).toEqual({ status: 403,
      body: { error: 'Same-origin management request required' } })
  }
  expect(await post({ host: 'localhost:3082', origin: 'http://localhost:3082' })).toMatchObject({ status: 200 })
  // Management routes require a loopback Web server.
  expect(() => serve({}, '0.0.0.0')).toThrow('Orchestrator management requires a loopback Web server')
})

it('applies same-origin checks to personal Web task posts and maps setup and lookup failures', async () => {
  const store = { settings: () => SettingsSchema.parse({ sources: { web: { enabled: true, config: {} } },
    policy: { sources: { web: { allowed: [{ id: 'owner' }] } } } }), get: () => undefined,
    keys: () => [], threads: { get: () => undefined }, tickets: { get: () => undefined }, decisions: { byThread: () => [] } }
  const call = serve({ machine: { mode: 'personal', promptMaxChars: { get: () => 100_000 }, admissionContextMaxPages: { get: () => 10 },
      admissionContextTimeoutMs: { get: () => 15_000 } }, store,
    configured: () => false, health: {}, requestPass: () => {}, engine: { receive: () => 'stored' } })

  expect(await call('POST', 'web/tasks', { text: '新任务', requestId: 'request_123456' }, { origin: 'http://evil.example' }))
    .toEqual({ status: 403, body: { error: 'Same-origin management request required' } })
  expect(await call('POST', 'web/tasks', { text: '新任务', requestId: 'request_123456' }))
    .toMatchObject({ status: 503 })
  expect(await call('GET', 'web/tasks/missing')).toEqual({ status: 404, body: { error: '任务对话不存在。' } })
})

it('serves only immutable delivered Web artifact bytes to the authorized owner over a same-origin request', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'http-web-artifact-'))
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  try {
    store.saveSettings(SettingsSchema.parse({ sources: { web: { enabled: true, config: {} } },
      policy: { sources: { web: { allowed: [{ id: 'owner', name: 'Owner' }] } } } }))
    const artifacts = new ArtifactRegistry(store, directory)
    const work = join(directory, 'work', 'ticket-delivered')
    mkdirSync(work, { recursive: true })
    const source = join(work, 'report.txt')
    writeFileSync(source, 'immutable snapshot bytes')
    const artifact = await artifacts.stage('ticket-delivered', work, source, '交付报告.txt', 'file')
    writeFileSync(source, 'changed after snapshot')
    const delivered = { id: artifact.id, ticketId: 'ticket-delivered', name: artifact.name, size: artifact.size, kind: artifact.kind }
    store.set(record('web-task:conversation-delivered'), { id: 'conversation-delivered', title: '交付', createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z', messages: [{ id: 'assistant-1', role: 'assistant', text: '完成', at: '2026-01-01T00:00:00.000Z', artifacts: [delivered] }] } as never)
    store.set(record('web-task:conversation-other'), { id: 'conversation-other', title: '其他', createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z', messages: [] } as never)
    const call = serve({ store, artifacts, machine: { mode: 'personal', promptMaxChars: { get: () => 100_000 },
      admissionContextMaxPages: { get: () => 10 }, admissionContextTimeoutMs: { get: () => 15_000 } }, configured: () => true, health: {},
      engine: { receive: () => 'stored' }, requestPass: () => {} })
    const path = (conversation: string, id: string) => `web/tasks/${conversation}/artifacts/${id}`

    const response = await call('GET', path('conversation-delivered', artifact.id))
    expect(response).toMatchObject({ status: 200, bytes: Buffer.from('immutable snapshot bytes'), headers: {
      'content-type': 'application/octet-stream', 'content-length': String(artifact.size), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      'content-disposition': `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent('交付报告.txt')}`,
    } })
    expect(await call('GET', path('conversation-other', artifact.id))).toMatchObject({ status: 404 })
    expect(await call('GET', path('conversation-delivered', 'artifact_not-delivered'))).toMatchObject({ status: 404 })
    expect(await call('GET', path('conversation-delivered', artifact.id), undefined, { 'x-orchestrator-request': undefined }))
      .toMatchObject({ status: 403, body: { error: 'Same-origin management request required' } })

    const originalSettings = store.settings.bind(store)
    let settingReads = 0
    store.settings = () => {
      settingReads++
      const current = originalSettings()
      return settingReads > 1 ? SettingsSchema.parse({ ...current,
        sources: { ...current.sources, web: { enabled: false, config: {} } } }) : current
    }
    try {
      expect(await call('GET', path('conversation-delivered', artifact.id))).toMatchObject({ status: 409 })
      expect(settingReads).toBe(2)
    } finally { store.settings = originalSettings }

    store.saveSettings(SettingsSchema.parse({ ...store.settings(), sources: { ...store.settings().sources, web: { enabled: false, config: {} } } }))
    expect(await call('GET', path('conversation-delivered', artifact.id))).toMatchObject({ status: 409 })
    store.saveSettings(SettingsSchema.parse({ ...store.settings(), sources: { ...store.settings().sources, web: { enabled: true, config: {} } },
      policy: { ...store.settings().policy, sources: { web: { allowed: [] } } } }))
    expect(await call('GET', path('conversation-delivered', artifact.id))).toMatchObject({ status: 409 })
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }) }
})

it('answers a prompt save that lost a race with 409, and a settings body over 128 KiB with 400', async () => {
  const saves: unknown[] = []
  const call = serve({
    machine: { promptMaxChars: { get: () => 100_000 } },
    store: { atomic: (work: () => unknown) => work(), blockRevision: () => 0 },
    prompts: { save: () => { throw new PromptConflict('Prompt version changed to 3; compare the latest version before saving') } },
    sessions: { notify: () => {}, delivery: async () => 'injected' },
    settings: { save: async (...args: unknown[]) => { saves.push(args); return { saved: true, revision: 1, restarting: false } } },
  })
  expect(await call('PUT', 'prompts', { config: {}, baseRevision: 2 }))
    .toEqual({ status: 409, body: { error: 'Prompt version changed to 3; compare the latest version before saving' } })
  const value = { prepare: 'x'.repeat(128 * 1024) }
  expect(await call('PUT', 'settings/executor', { value, revision: 0 })).toEqual({ status: 400,
    body: { error: `Request exceeds ${128 * 1024} bytes` } })
  expect(saves).toEqual([])
})
