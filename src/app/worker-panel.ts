/** Bounded, owner-visible worker and collaboration projection for the active Superagent conversation. */
import { currentVerification, latestAssignment, latestReport, ticketStage, type Ticket } from '../core/index.ts'
import { workerSessionId } from '../executor/dsh.ts'
import { record } from '../kv.ts'
import type { RoomMessage, RoomWorker, TaskRoomSummary, TaskRooms } from './task-rooms.ts'
import type { Store } from './store.ts'

export interface WorkerPanelWorker extends RoomWorker {
  acceptance?: Ticket['acceptance']
  verification?: Ticket['verification']
  hold?: Ticket['hold']
  action?: string
  updatedAt: string
  completed: string[]
  pending: string[]
  waitingFor?: string
  attention?: string
  roomKey: string
  roomKeys: string[]
}
export interface WorkerPanelView {
  sessionId: string
  eligible: boolean
  scope: 'router' | 'conversation' | null
  pending: boolean
  paused: boolean
  workers: WorkerPanelWorker[]
  messages: (RoomMessage & { roomKey: string })[]
  rooms: { key: string; title: string }[]
}

const MAX_WORKERS = 50
const MAX_MESSAGES = 60
const MAX_ROOMS = 100
const safeText = (value: string): string => value
  .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[redacted]')
  .replace(/\b(?:gh[pousr]_|github_pat_|xox[baprs]-|sk-)[A-Za-z0-9_-]{12,}\b/g, '[redacted]')
  .replace(/(["']?(?:access[_-]?token|refresh[_-]?token|token|secret|password|passwd|authorization|api[_-]?key)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}\]]+)/gi, '$1"[redacted]"')
  .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[private key redacted]')
const short = (value: string, max = 500): string => { const safe = safeText(value); return safe.length > max ? `${safe.slice(0, max)}…` : safe }
const list = (values: string[] | undefined): string[] => (values ?? []).slice(0, 12).map(value => short(value, 240))

function workerView(ticket: Ticket, summary: TaskRoomSummary['workers'][number], roomKey: string): WorkerPanelWorker {
  const assignment = latestAssignment(ticket), report = latestReport(ticket), stage = ticketStage(ticket)
  return { ...summary, ...('action' in stage ? { action: stage.action } : {}), updatedAt: report?.at ?? ticket.updatedAt,
    ...ticket.acceptance ? { acceptance: ticket.acceptance } : {}, ...currentVerification(ticket) ? { verification: currentVerification(ticket) } : {},
    ...ticket.hold ? { hold: ticket.hold } : {},
    completed: list(report?.completed), pending: list(report?.pending),
    ...(report?.waitingFor ? { waitingFor: short(report.waitingFor.subject, 240) } : {}),
    ...(ticket.attention?.question ? { attention: short(ticket.attention.question, 500) } : {}),
    // Keep report state and activity-derived summary aligned with the current assignment.
    summary: short(summary.summary || report?.summary || '', 600),
    sessionId: assignment?.startedAt ? workerSessionId(ticket.id) : summary.sessionId,
    roomKey, roomKeys: [roomKey] }
}

/** Projects one known Superagent session. Main Router requests aggregate recent rooms; conversation requests stay scoped. */
export function workerPanel(input: { store: Store; rooms: Pick<TaskRooms, 'get' | 'list'>; masterId: string; conversationIds: string[] }, sessionId: string): WorkerPanelView {
  const router = sessionId === input.masterId
  const knownConversation = input.conversationIds.includes(sessionId)
    || input.store.get(record<{ sessionId: string; cwd: string }>(`session-conversation:${sessionId}`))?.sessionId === sessionId
  const eligible = router || knownConversation
  const scope = router ? 'router' : knownConversation ? 'conversation' : null
  const empty = (): WorkerPanelView => ({ sessionId, eligible: false, scope: null, pending: false,
    paused: input.store.settings().paused, workers: [], messages: [], rooms: [] })
  if (!eligible) return empty()

  let summaries: TaskRoomSummary[]
  if (router) {
    summaries = []
    for (let offset = 0; ; offset += 100) {
      const page = input.rooms.list(offset, 100).items
      summaries.push(...page)
      if (page.length < 100 || summaries.length >= 10_000) break
    }
    summaries.sort((a, b) => Number(b.pending) - Number(a.pending) || b.updatedAt.localeCompare(a.updatedAt))
  } else {
    const key = `dsh-session:${sessionId}`
    const thread = input.store.threads.get(key)
    summaries = thread ? [input.rooms.get(key)] : []
  }

  const pending = summaries.some(room => room.pending)
  const allWorkers = new Map<string, WorkerPanelWorker>()
  const messages: (RoomMessage & { roomKey: string })[] = []
  const messageIds = new Set<string>()
  for (const room of summaries) {
    for (const member of room.workers) {
      const ticket = input.store.tickets.get(member.id)
      if (!ticket) continue
      const projected = workerView(ticket, member, room.key)
      const previous = allWorkers.get(member.id)
      if (!previous) allWorkers.set(member.id, projected)
      else {
        const roomKeys = [...new Set([...previous.roomKeys, room.key])]
        const replace = (projected.subscribed && !previous.subscribed) || (projected.subscribed === previous.subscribed && projected.updatedAt > previous.updatedAt)
        allWorkers.set(member.id, { ...(replace ? projected : previous), roomKeys })
      }
    }
  }
  const messageRooms = [...summaries].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, MAX_ROOMS)
  for (const room of messageRooms) {
    const view = input.rooms.get(room.key, undefined, 100)
    for (const message of view.messages) {
      if (messageIds.has(message.id)) continue
      messageIds.add(message.id)
      messages.push({ ...message, roomKey: room.key })
    }
  }
  const workers = [...allWorkers.values()].sort((a, b) => Number(b.active) - Number(a.active)
    || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)).slice(0, MAX_WORKERS)
  const orderedMessages = messages.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id)).slice(-MAX_MESSAGES)
  return { sessionId, eligible, scope, pending, paused: input.store.settings().paused, workers,
    messages: orderedMessages, rooms: summaries.slice(0, MAX_ROOMS).map(({ key, title }) => ({ key, title })) }
}
