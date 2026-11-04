import { vi } from 'vitest'
import { AgentModel, modelSelectionProjectionDefinition, type ModelSelection } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

/** Exercise the real DSH model-selection owner while the surrounding Agent remains in memory. */
export function fixtureModel(session: Pick<Session, 'append' | 'snapshotEvents'>) {
  let state = session.snapshotEvents().reduce((current, event) => modelSelectionProjectionDefinition.apply(current, event),
    { lastUsed: null, pending: null } as { lastUsed: ModelSelection | null; pending: ModelSelection | null })
  const append = session.append.bind(session) as (type: string, data: unknown, ...options: unknown[]) => unknown
  ;(session as unknown as { append: (type: string, data: unknown, ...options: unknown[]) => unknown }).append = vi.fn((type: string, data: unknown, ...options: unknown[]) => {
    const result = append(type, data, ...options)
    state = modelSelectionProjectionDefinition.apply(state, { type, data } as SessionEvent)
    return result
  })
  return new AgentModel(() => {
    return state
  }, session as Session, { provider: 'host', model: 'default' })
}

/** A paged durable reader over the fixture's current event logs. */
export function fixturePersistence(events: (id: string) => readonly SessionEvent[]) {
  return {
    flush: vi.fn(async () => {}),
    stat: vi.fn(async (id: string) => ({ eventCount: events(id).length })),
    open: vi.fn(async (id: string) => {
      const saved = [...events(id)]
      return { read: async (offset = 0, length?: number) => ({ events: saved.slice(offset, length === undefined ? undefined : offset + length) }),
        [Symbol.asyncDispose]: async () => {} }
    }),
  }
}
