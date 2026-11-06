import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { expect, it } from 'vitest'
import { watchdogOnce } from '../scripts/dsh-superagent-watchdog.mjs'

const snapshot = () => ({ schema: 1, snapshotHash: 'snapshot-version', observedAt: '2026-11-07T00:00:00.000Z',
  infrastructure: { configured: true, paused: false, health: {}, setup: [] }, executor: { activeWorkers: 1, maxWorkers: 2 },
  page: { offset: 0, limit: 20, total: 1, nextOffset: 0 }, candidates: [], tickets: [{ id: 'work', revision: 'ticket-version',
    status: 'working', stage: 'working', report: { state: 'progress', summary: 'Repeating command' }, repeatedErrors: 0 }] })
const assessment = () => ({ status: 'stalled', semanticStatus: 'reviewed', semanticReview: 'configured', reviewId: 'review-1',
  snapshotHash: 'semantic-snapshot', mode: 'observe', findings: [{ ticketId: 'work', status: 'stalled',
    evidence: ['Identical command failed three times'], recommendation: 'Inspect the failing precondition' }] })

it('uses bundled semantic review, persists its identity and leaves the default mode observational', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchdog-model-')), calls: { url: string; body?: unknown }[] = []
  try {
    const result = await watchdogOnce({ modelAssessor: true, stateFile: join(directory, 'state.json'),
      fetchImpl: async (url: string, init?: RequestInit) => {
        calls.push({ url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) })
        return { ok: true, json: async () => init?.method === 'POST' ? assessment() : snapshot() }
      }, emit: async () => {} })
    expect(new URL(calls[0]!.url).searchParams.get('limit')).toBe('20')
    expect(calls[1]).toMatchObject({ url: 'http://127.0.0.1:3082/orchestrator/api/watchdog/assess',
      body: { expectedHash: 'snapshot-version', offset: 0, maxTickets: 20 } })
    expect(calls).toHaveLength(2)
    expect(result.report).toMatchObject({ status: 'stalled', infrastructureStatus: 'healthy', semanticStatus: 'reviewed', reviewId: 'review-1', mode: 'observe' })
    const state = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'))
    expect(state.reviews).toHaveLength(1)
    expect(state.reviews[0]).toMatchObject({ reviewId: 'review-1', snapshotHash: 'semantic-snapshot' })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('submits only explicit revision-bound advice and preserves model failures as unknown', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchdog-model-advice-')), bodies: unknown[] = []
  try {
    const fetchImpl = async (url: string, init?: RequestInit) => {
      if (url.endsWith('/advice')) { bodies.push(JSON.parse(String(init?.body))); return { ok: true, json: async () => ({ requested: false, reason: 'stale' }) } }
      return { ok: true, json: async () => url.endsWith('/assess') ? assessment() : snapshot() }
    }
    const explicit = await watchdogOnce({ modelAssessor: true, advise: true, stateFile: join(directory, 'advice.json'), fetchImpl, emit: async () => {} })
    expect(bodies).toEqual([{ reviewId: 'review-1', ticketId: 'work', expectedRevision: 'ticket-version' }])
    expect(explicit.report.advice).toEqual([{ requested: false, reason: 'stale' }])
    const failed = await watchdogOnce({ modelAssessor: true, advise: true, recover: true, stateFile: join(directory, 'failed.json'),
      fetchImpl: async (url: string) => { if (url.endsWith('/assess')) throw new Error('model service unavailable'); return { ok: true, json: async () => snapshot() } },
      commandRunner: async () => { throw new Error('Host restart must not run for a model failure') }, emit: async () => {} })
    expect(failed.report).toMatchObject({ status: 'unknown', semanticStatus: 'unknown', infrastructureStatus: 'healthy', errorKind: 'assessor' })
    expect(failed.report.recovery).toBeUndefined()
    expect(failed.report.advice).toBeUndefined()
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('executes the model-assessor route from the independent CLI process', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchdog-model-process-')), requests: string[] = []
  const server: Server = createServer(async (req, res) => {
    requests.push(req.url ?? '')
    if (req.method === 'POST') {
      let body = ''; for await (const chunk of req) body += chunk
      const request = JSON.parse(body)
      if (request.expectedHash !== 'snapshot-version') { res.writeHead(409); res.end(); return }
    }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(req.method === 'POST' ? assessment() : snapshot()))
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  try {
    const child = spawn(process.execPath, [resolve('scripts/dsh-superagent-watchdog.mjs'), '--once', '--model-assessor', '--url',
      `http://127.0.0.1:${(server.address() as { port: number }).port}`, '--state-file', join(directory, 'state.json')], { windowsHide: true })
    let out = '', err = ''; child.stdout.on('data', chunk => { out += String(chunk) }); child.stderr.on('data', chunk => { err += String(chunk) })
    const [code] = await once(child, 'close')
    expect(code).toBe(3); expect(err).toBe('')
    expect(JSON.parse(out)).toMatchObject({ reviewId: 'review-1', semanticStatus: 'reviewed', infrastructureStatus: 'healthy' })
    expect(requests).toHaveLength(2)
    expect(requests[1]).toBe('/orchestrator/api/watchdog/assess')
  } finally { await new Promise<void>(resolveDone => server.close(() => resolveDone())); await rm(directory, { recursive: true, force: true }) }
})
