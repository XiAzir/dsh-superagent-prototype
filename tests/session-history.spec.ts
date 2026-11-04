import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { lastAssistantMessage, readLatestTurnEvents, readSessionEvents } from '../src/infra/session-history.ts'

function persistence(events: readonly SessionEvent[], eventCount: number | undefined = events.length, missing = false) {
  const reads: { offset: number; length: number | undefined; signal?: AbortSignal }[] = []
  const close = vi.fn(async () => {})
  const handle = {
    read: vi.fn(async (offset = 0, length?: number, options?: { signal?: AbortSignal }) => {
      reads.push({ offset, length, signal: options?.signal })
      options?.signal?.throwIfAborted()
      return { events: events.slice(offset, length === undefined ? undefined : offset + length) }
    }),
    close,
    [Symbol.asyncDispose]: close,
  }
  const sessionPersistence = {
    flush: vi.fn(async () => {}),
    open: vi.fn(async (_id: SessionId, access: string, options?: { signal?: AbortSignal }) => {
      expect(access).toBe('read')
      options?.signal?.throwIfAborted()
      return handle
    }),
    stat: vi.fn(async (_id: SessionId, options?: { signal?: AbortSignal }) => {
      options?.signal?.throwIfAborted()
      return missing ? undefined : { ...(Number.isNaN(eventCount) ? {} : { eventCount }) }
    }),
  }
  return { ctx: { sessionPersistence } as unknown as Context, reads, handle, sessionPersistence }
}

const event = (type: string, seq: number): SessionEvent => ({ type, seq } as unknown as SessionEvent)

describe('readSessionEvents', () => {
  it('reads a cold stored session in ordered pages without resolving an Agent', async () => {
    const events = Array.from({ length: 600 }, (_, seq) => event('turn/start', seq))
    const store = persistence(events)
    const result = await readSessionEvents(store.ctx, 'worker-cold' as SessionId)
    expect(result).toEqual(events)
    expect(store.reads.map(({ offset, length }) => [offset, length])).toEqual([[0, 256], [256, 256], [512, 88]])
    expect(store.sessionPersistence.open).toHaveBeenCalledTimes(1)
    expect(store.sessionPersistence.flush).toHaveBeenCalledTimes(1)
    expect(store.handle.close).toHaveBeenCalledTimes(1)
  })

  it('forwards cancellation to open and each read', async () => {
    const controller = new AbortController()
    const store = persistence([event('turn/start', 0)])
    await readSessionEvents(store.ctx, 'worker-cold' as SessionId, controller.signal)
    expect(store.sessionPersistence.open).toHaveBeenCalledWith('worker-cold', 'read', { signal: controller.signal })
    expect(store.reads[0]?.signal).toBe(controller.signal)
  })

  it('uses the count observed at read start as a fixed history cut', async () => {
    const events = Array.from({ length: 700 }, (_, seq) => event('turn/start', seq))
    const store = persistence(events, 300)
    expect(await readSessionEvents(store.ctx, 'worker-live' as SessionId)).toEqual(events.slice(0, 300))
    expect(store.reads.map(({ offset, length }) => [offset, length])).toEqual([[0, 256], [256, 44]])
  })

  it('uses one storage snapshot read when a backend omits its event count', async () => {
    const events = [event('turn/start', 0), event('assistant/message', 1)]
    const store = persistence(events, Number.NaN)
    expect(await readSessionEvents(store.ctx, 'worker-cold' as SessionId)).toEqual(events)
    expect(store.reads.map(({ offset, length }) => [offset, length])).toEqual([[0, undefined]])
  })

  it('finds the last assistant message by scanning backward from the stored event count', async () => {
    const events = Array.from({ length: 700 }, (_, seq) => event(seq === 300 || seq === 699 ? 'assistant/message' : 'tool/result', seq))
    const store = persistence(events)
    const last = await lastAssistantMessage(store.ctx, 'worker-cold' as SessionId)
    expect(last?.seq).toBe(699)
    expect(store.reads.map(({ offset, length }) => [offset, length])).toEqual([[444, 256]])
    expect(store.sessionPersistence.stat).toHaveBeenCalledTimes(1)
    expect(store.handle.close).toHaveBeenCalledTimes(1)
  })

  it('returns no tail message when storage has no assistant message', async () => {
    const store = persistence([event('turn/start', 0), event('tool/result', 1)])
    expect(await lastAssistantMessage(store.ctx, 'worker-cold' as SessionId)).toBeUndefined()
    expect(store.reads.map(({ offset, length }) => [offset, length])).toEqual([[0, 2]])
  })

  it('observes aborts before reading a page', async () => {
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    const store = persistence([event('turn/start', 0)])
    await expect(readSessionEvents(store.ctx, 'worker-cold' as SessionId, controller.signal)).rejects.toThrow('cancelled')
    expect(store.sessionPersistence.flush).not.toHaveBeenCalled()
    expect(store.handle.read).not.toHaveBeenCalled()
    expect(store.handle.close).not.toHaveBeenCalled()
  })
})

describe('readLatestTurnEvents', () => {
  it('treats a just-created Agent without a materialized header as an empty history', async () => {
    const store = persistence([], undefined, true)
    expect(await readLatestTurnEvents(store.ctx, 'worker-new' as SessionId)).toEqual([])
    expect(store.sessionPersistence.open).not.toHaveBeenCalled()
  })

  it('reads backward to the newest turn boundary and returns that turn in event order', async () => {
    const events = Array.from({ length: 700 }, (_, seq) => event(seq === 300 || seq === 600 ? 'turn/start' : 'step/start', seq))
    const store = persistence(events)
    expect(await readLatestTurnEvents(store.ctx, 'worker-cold' as SessionId)).toEqual(events.slice(600))
    expect(store.reads.map(({ offset, length }) => [offset, length])).toEqual([[444, 256]])
    expect(store.sessionPersistence.flush).toHaveBeenCalledTimes(1)
    expect(store.handle.close).toHaveBeenCalledTimes(1)
  })

  it('falls back to one snapshot read when a backend omits its event count', async () => {
    const events = [event('turn/start', 0), event('step/start', 1), event('turn/start', 2), event('step/start', 3)]
    const store = persistence(events, Number.NaN)
    expect(await readLatestTurnEvents(store.ctx, 'worker-cold' as SessionId)).toEqual(events.slice(2))
    expect(store.reads.map(({ offset, length }) => [offset, length])).toEqual([[0, undefined]])
  })
})
