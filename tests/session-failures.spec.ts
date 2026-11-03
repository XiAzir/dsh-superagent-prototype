import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { restoredFailure, safeFailureMessage, SessionFailures } from '../src/app/session-failures.ts'

const sessionEvent = (type: string, data: unknown, time = Date.parse('2026-11-01T12:00:00.000Z')) =>
  ({ type, data, seq: 0, time } as unknown as SessionEvent)
const failedTurn = (message: string, time?: number) => sessionEvent('turn/end', {
  turn: 1, reason: { kind: 'error', error: { message, code: 'PROVIDER_ERROR' } },
}, time)

describe('managed Session failure projection', () => {
  it('restores the latest failed turn and clears it when a later turn starts or completes', () => {
    const events = [
      sessionEvent('turn/start', { turn: 1 }),
      failedTurn('The model endpoint returned 405'),
      sessionEvent('turn/start', { turn: 2 }, Date.parse('2026-11-01T12:01:00.000Z')),
    ]
    expect(restoredFailure('orchestrator-main', events)).toBeUndefined()
    expect(restoredFailure('orchestrator-main', [sessionEvent('turn/start', { turn: 1 }), failedTurn('bad request')]))
      .toEqual({ sessionId: 'orchestrator-main', message: 'bad request', at: '2026-11-01T12:00:00.000Z' })
    expect(restoredFailure('orchestrator-main', [failedTurn('old failure'), sessionEvent('turn/end', {
      turn: 2, reason: { kind: 'completed' },
    })])).toBeUndefined()
  })

  it('tracks only the latest managed failure, updates it from live errors, and clears on a new turn', () => {
    const failures = new SessionFailures()
    failures.restore('worker-1', [failedTurn('previous 503')])
    failures.observe('worker-1', failedTurn('new 405', Date.parse('2026-11-01T12:01:00.000Z')))
    failures.failed('orchestrator-main', new Error('Current 405'), '2026-11-01T12:02:00.000Z')
    expect(failures.list()).toEqual([
      { sessionId: 'worker-1', message: 'new 405', at: '2026-11-01T12:01:00.000Z' },
      { sessionId: 'orchestrator-main', message: 'Current 405', at: '2026-11-01T12:02:00.000Z' },
    ])
    failures.observe('worker-1', sessionEvent('turn/start', { turn: 2 }))
    expect(failures.list().map(failure => failure.sessionId)).toEqual(['orchestrator-main'])
  })

  it('redacts credentials and request headers and caps displayed error text at 2,000 characters', () => {
    const message = safeFailureMessage('Authorization: Bearer bearer-secret x-api-key=key-secret api_key=other-secret sk-1234567890123456 ' + 'x'.repeat(2100))
    expect(message).not.toContain('bearer-secret')
    expect(message).not.toContain('key-secret')
    expect(message).not.toContain('other-secret')
    expect(message).not.toContain('sk-1234567890123456')
    expect(message).toContain('Authorization: [REDACTED]')
    expect(message.length).toBeLessThanOrEqual(2000)
    expect(safeFailureMessage({ headers: { Authorization: 'private' } })).toBe('Session run failed')
  })
})
