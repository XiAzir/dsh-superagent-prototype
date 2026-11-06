/** Connect ordinary conversations in the Superagent workspace to its durable routing and reply pipeline. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { z } from 'zod'
import { key, latestReport, ticketStage, type ReceiveResult, type Trigger } from '../core/index.ts'
import { sameDirectory } from '../infra/environment.ts'
import { family } from '../kv.ts'
import { SourcePolicySchema } from '../policy.ts'
import type { SourceKind } from '../sources/kind.ts'
import type { ArtifactRegistry } from './artifacts.ts'
import type { Store } from './store.ts'
import type { Tool } from './tools/tool.ts'

const SOURCE = 'dsh-session'
const conversationKey = family<{ sessionId: string; cwd: string }>('session-conversation:')
type Media = Extract<UserMessage['content'][number], { type: 'file' | 'image' }>
const mediaKey = family<Media[]>('session-conversation-media:')
const threadOf = (sessionId: string) => `${SOURCE}:${sessionId}`

export const SESSION_CONVERSATION_PROMPT = `You are Superagent's conversation interface in its workspace.
Every human message is sent to the main Router with its own trigger_id and original Session. The Router handles intake, replies, and worker dispatch. Use orchestrator_session_status for local context; do not acknowledge or answer again after a Router reply.
Messages marked [Superagent delivery] are status updates, questions, or results from the Router. Present their useful content and file paths. They are system context, not new human requests. Human follow-ups are routed to the Router from this Session.
Preserve user constraints. Leave implementation to the workers. Do not run shell commands, search for external worker skills, create other sessions, or duplicate dispatched work.`

interface SessionConversationHost {
  stateDir: string
  masterId?: string
  store: Store
  configured(): boolean
  receive(trigger: Trigger): ReceiveResult
  prompt(sessionId: string, requestId: string, text: string): Promise<void>
  artifacts: Pick<ArtifactRegistry, 'verify'>
  attachmentPath?(block: Media): string | undefined
}

/** Keeps one source thread per human conversation; Outbox and AgentDelivery own durable, idempotent reply delivery. */
export class SessionConversations {
  readonly kind: SourceKind<Record<string, never>>
  constructor(private readonly host: SessionConversationHost) {
    const authorized = () => {
      const settings = host.store.settings()
      return settings.sources[SOURCE]?.enabled !== false && !!settings.policy.sources[SOURCE]?.allowed.some(actor => actor.id === 'owner')
    }
    this.kind = {
      kind: SOURCE, title: { zh: 'Superagent 会话', en: 'Superagent conversations' },
      description: { zh: '在 Superagent 工作区新建对话，自动接单、派工并将结果回复到原会话。', en: 'Route workspace conversations to workers and return results to the originating Session.' },
      schema: z.object({}).strict(), fields: [], health: [],
      scope: () => authorized() ? { listened: true, observed: false } : { listened: false, reason: 'source_disabled' },
      policy: { schema: SourcePolicySchema, fields: [],
        explicit: { zh: '本机 Superagent 工作区内的用户消息由 owner 直接交办。', en: 'Human messages in the local Superagent workspace are direct owner requests.' } },
      environment: {
        variables: [{ key: 'DSH_SUPERAGENT_SESSION_CWD', description: { zh: '交办任务的原会话工作目录', en: 'Working directory of the originating human Session' } }],
        values: ({ trigger }) => ({ DSH_SUPERAGENT_SESSION_CWD: String(trigger?.meta.cwd ?? '') }),
      },
      attachments: {
        references: trigger => trigger.attachments ?? [],
        read: async (trigger, id, _agent, signal) => {
          signal.throwIfAborted()
          const block = host.store.get(mediaKey(trigger.id))?.find(item => item.attachment.attachmentId === id)
          if (!block) throw new Error('Choose an attachment from this conversation message')
          const path = host.attachmentPath?.(block)
          return { type: block.type, name: block.attachment.name, size: block.attachment.bytes, ...path ? { path } : {},
            ...block.type === 'image' ? { image: block.attachment } : {} }
        },
      },
      threadContext: {
        messageId: trigger => trigger.id,
        read: async (_commands, trigger, part, cursor) => {
          const thread = threadOf(String(trigger.meta.sessionId))
          const before = cursor ? z.object({ at: z.string(), id: z.string() }).parse(JSON.parse(cursor)) : undefined
          const first = part === 'root' ? host.store.read.firstTrigger(thread) : undefined
          const rows = part === 'root' ? first ? [first] : [] : host.store.read.threadTriggers(thread, 31, before).reverse()
          const page = rows.slice(0, 30), last = page.at(-1)
          const messages = page.slice().reverse().map(item => ({ id: item.id, from: 'owner', text: item.text, at: item.at,
            ...item.attachments?.length ? { attachments: item.attachments } : {} }))
          return { messages, body: { messages }, ...rows.length > 30 && last ? { next: JSON.stringify({ at: last.at, id: last.id }) } : {} }
        },
      },
      channel: {
        artifacts: true,
        allowed: address => authorized() && !!host.store.get(conversationKey(address.sessionId ?? '')),
        link: () => ({ url: '', label: { zh: '原会话', en: 'Original Session' } }),
        send: async (_context, message) => {
          const sessionId = message.channel.address.sessionId ?? ''
          if (!authorized() || !host.store.get(conversationKey(sessionId))) return 'gone'
          const files = await Promise.all((message.artifacts ?? []).map(async id => {
            if (!message.ticketId) throw new Error('Session artifact delivery requires its originating ticket')
            const artifact = await host.artifacts.verify(id, message.ticketId)
            return `${artifact.name}: ${artifact.path}`
          }))
          if (!authorized()) return 'gone'
          // The Router already has this Session's question and the tool result in its current turn.
          // A queued self-message would start a second answer turn for the same request.
          if (sessionId !== host.masterId) {
            await host.prompt(sessionId, `session-reply:${message.id}`, `[Superagent delivery]\n${message.text}${files.length ? `\n\n${files.join('\n')}` : ''}`)
          }
          return 'sent'
        },
      },
    }
  }
  /** Exact canonical workspace match; worker directories, subagents and other workspaces retain their own roles. */
  matches(agent: Agent): boolean {
    const header = agent.session.header
    return !!header?.cwd && header.origin !== 'subagent' && !agent.id.startsWith('worker-') && sameDirectory(header.cwd, this.host.stateDir)
  }
  /** Accept only original human messages; the same inbox/history event always yields the same Trigger ID. */
  receive(agent: Agent, message: UserMessage): void {
    if (!this.matches(agent) || message.source.kind !== 'user') return
    const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
    const media = message.content.filter((block): block is Media => block.type === 'image' || block.type === 'file')
    if (!text.trim() && !media.length) return
    const { store } = this.host, id = `session-message-${key(agent.id, message.id)}`
    if (store.triggers.get(id)) return
    const at = new Date().toISOString(), cwd = agent.session.header.cwd!
    store.atomic(() => {
      store.set(conversationKey(agent.id), { sessionId: agent.id, cwd })
      if (media.length) store.set(mediaKey(id), media)
      this.host.receive({ id, source: SOURCE, routing: 'router', threads: [{ source: SOURCE, id: agent.id }],
        actor: { source: SOURCE, id: 'owner' }, human: true, addressed: 'direct', text, at,
        ...media.length ? { attachments: media.map(block => ({ id: block.attachment.attachmentId, type: block.type,
          name: block.attachment.name, size: block.attachment.bytes, status: 'available', read: `attachment/${id}/${block.attachment.attachmentId}` })) } : {},
        channel: { source: SOURCE, thread: threadOf(agent.id), address: { sessionId: agent.id } },
        meta: { sessionId: agent.id, messageId: message.id, cwd } })
      store.threads.describe(threadOf(agent.id), { label: text.split('\n')[0]!.slice(0, 100) })
    })
  }
  tools(agent: Agent): Tool[] {
    return [{ name: 'orchestrator_session_status', description: 'Read intake and worker status for this Superagent conversation.',
      schema: z.object({}).strict(), execute: async () => {
        // Reconcile durable inbox/history if the plugin was restarted after this turn began.
        const history = agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'user')
        const latest = history.at(-1)
        if (latest?.type === 'user/message') this.receive(agent, latest.data)
        for (const message of [...agent.inbox.nextTurn, ...agent.inbox.nextStep]) this.receive(agent, message)
        const { store } = this.host, settings = store.settings(), thread = store.threads.get(threadOf(agent.id))
        const tickets = (thread?.subscriptions ?? []).flatMap(id => {
          const ticket = store.tickets.get(id)
          return ticket ? [{ id, title: ticket.title, ...ticketStage(ticket), summary: latestReport(ticket)?.summary ?? '' }] : []
        })
        const error = !this.host.configured() ? 'Superagent 正在初始化。'
          : settings.sources[SOURCE]?.enabled === false ? 'Superagent 会话来源已关闭。'
            : !settings.policy.sources[SOURCE]?.allowed.some(actor => actor.id === 'owner') ? 'Superagent 会话的 owner 授权已关闭。' : undefined
        return { session_id: agent.id, queued: !!thread?.pending.length || !!thread?.evaluating, paused: settings.paused, tickets, ...error ? { error } : {} }
      } }]
  }
}
