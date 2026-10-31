import type { SessionEvent } from '@deepseek-ai/dsh-session'

export interface SessionFailure {
  sessionId: string
  message: string
  at: string
}

const REDACTIONS: readonly [RegExp, string][] = [
  [/(authorization|proxy-authorization|x-api-key|api-key|cookie|set-cookie)\s*[:=]\s*(?:(?:bearer|basic)\s+)?(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1: [REDACTED]'],
  [/\bbearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]'],
  [/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)\b\s*([=:])\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1$2[REDACTED]'],
  [/\bsk-[A-Za-z0-9_-]{8,}\b/gi, '[REDACTED]'],
]

/** Select a plain error message and remove common credential and request-header forms before exposing it. */
export function safeFailureMessage(value: unknown): string {
  let message = value instanceof Error ? value.message
    : typeof value === 'string' ? value
      : value && typeof value === 'object' && 'message' in value && typeof value.message === 'string' ? value.message
        : 'Session run failed'
  for (const [pattern, replacement] of REDACTIONS) message = message.replace(pattern, replacement)
  if (!message.trim()) message = 'Session run failed'
  return message.length > 2000 ? `${message.slice(0, 1997)}...` : message
}

function atOf(time: number | undefined): string {
  const date = typeof time === 'number' ? new Date(time) : new Date()
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString()
}

function failureFromErrorEnd(sessionId: string, event: SessionEvent<'turn/end'>): SessionFailure | undefined {
  return event.data.reason.kind === 'error'
    ? { sessionId, message: safeFailureMessage(event.data.reason.error.message), at: atOf(event.time) }
    : undefined
}

/** Fold the durable event stream to the outcome of the latest turn, clearing failures when a later turn starts. */
export function restoredFailure(sessionId: string, events: readonly SessionEvent[]): SessionFailure | undefined {
  let failure: SessionFailure | undefined
  for (const event of events) {
    if (event.type === 'turn/start') failure = undefined
    else if (event.type === 'turn/end') failure = failureFromErrorEnd(sessionId, event)
  }
  return failure
}

/** Latest live failure per managed Session, reconstructed from its event history when that Session loads. */
export class SessionFailures {
  private readonly failures = new Map<string, SessionFailure>()

  restore(sessionId: string, events: readonly SessionEvent[]): void {
    const failure = restoredFailure(sessionId, events)
    if (failure) this.failures.set(sessionId, failure)
    else this.failures.delete(sessionId)
  }

  observe(sessionId: string, event: SessionEvent): void {
    if (event.type === 'turn/start') this.failures.delete(sessionId)
    else if (event.type === 'turn/end') {
      const failure = failureFromErrorEnd(sessionId, event)
      if (failure) this.failures.set(sessionId, failure)
      else this.failures.delete(sessionId)
    }
  }

  failed(sessionId: string, error: unknown, at = new Date().toISOString()): void {
    this.failures.set(sessionId, { sessionId, message: safeFailureMessage(error), at })
  }

  list(): SessionFailure[] {
    return [...this.failures.values()].sort((a, b) => a.at.localeCompare(b.at) || a.sessionId.localeCompare(b.sessionId))
  }
}
