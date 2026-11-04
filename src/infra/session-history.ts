import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'

const PAGE_SIZE = 256

/** Read a stored Session through the persistence service without resolving or activating its Agent. */
export async function readSessionEvents(ctx: Context, sessionId: SessionId, signal?: AbortSignal): Promise<SessionEvent[]> {
  signal?.throwIfAborted()
  await ctx.sessionPersistence.flush()
  const snapshot = await ctx.sessionPersistence.stat(sessionId, { signal })
  if (!snapshot) return []
  await using handle = await ctx.sessionPersistence.open(sessionId, 'read', { signal })
  if (snapshot.eventCount === undefined) return [...(await handle.read(0, undefined, { signal })).events]
  const events: SessionEvent[] = []
  for (let offset = 0; offset < snapshot.eventCount; ) {
    signal?.throwIfAborted()
    const page = await handle.read(offset, Math.min(PAGE_SIZE, snapshot.eventCount - offset), { signal })
    if (!page.events.length) break
    events.push(...page.events)
    offset += page.events.length
  }
  return events
}

/** Read only the latest turn's durable history, which is sufficient to restore current retry and failure health. */
export async function readLatestTurnEvents(ctx: Context, sessionId: SessionId, signal?: AbortSignal): Promise<SessionEvent[]> {
  signal?.throwIfAborted()
  await ctx.sessionPersistence.flush()
  const snapshot = await ctx.sessionPersistence.stat(sessionId, { signal })
  if (!snapshot) return []
  await using handle = await ctx.sessionPersistence.open(sessionId, 'read', { signal })
  if (snapshot.eventCount === undefined) {
    const events = [...(await handle.read(0, undefined, { signal })).events]
    const start = events.findLastIndex(event => event.type === 'turn/start')
    return start < 0 ? events : events.slice(start)
  }
  const pages: SessionEvent[][] = []
  let end = snapshot.eventCount
  while (end > 0) {
    signal?.throwIfAborted()
    const start = Math.max(0, end - PAGE_SIZE)
    const { events } = await handle.read(start, end - start, { signal })
    if (!events.length) break
    pages.unshift([...events])
    const turnStart = [...events].reverse().find(event => event.type === 'turn/start')
    if (turnStart) {
      const offset = events.findIndex(event => event.seq === turnStart.seq)
      pages[0] = events.slice(offset)
      break
    }
    end = start
  }
  return pages.flat()
}

/** Find the latest assistant message from the durable tail, paging backwards without loading the full log. */
export async function lastAssistantMessage(ctx: Context, sessionId: SessionId, signal?: AbortSignal): Promise<Extract<SessionEvent, { type: 'assistant/message' }> | undefined> {
  signal?.throwIfAborted()
  await ctx.sessionPersistence.flush()
  const snapshot = await ctx.sessionPersistence.stat(sessionId, { signal })
  if (!snapshot || snapshot.eventCount === undefined) return undefined
  await using handle = await ctx.sessionPersistence.open(sessionId, 'read', { signal })
  for (let end = snapshot.eventCount; end > 0; ) {
    signal?.throwIfAborted()
    const start = Math.max(0, end - PAGE_SIZE)
    const { events } = await handle.read(start, end - start, { signal })
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event?.type === 'assistant/message') return event
    }
    if (!events.length) break
    end = start
  }
  return undefined
}
