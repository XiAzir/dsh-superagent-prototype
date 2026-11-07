/** Executor Session tools for reading ticket context, acknowledging requests, managing threads, handing back out-of-scope triggers, and reporting status. */
import { z } from 'zod'
import { join, basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import { parseRemoteArtifactReference, type RemoteEnvironments } from '../../remote/client.ts'
import { liveTicket, runningAssignment, type EngineForExecutor, type Ticket } from '../../core/index.ts'
import { IM_WORDS } from '../../infra/text.ts'
import { claimPull, readPull } from '../../sources/github-pull.ts'
import type { SourceContext } from '../../sources/host.ts'
import { readResource, type ResourceHost } from '../resources.ts'
import type { Store } from '../store.ts'
import { reportRelay, threadFollowedNotice } from '../notices.ts'
import type { Sessions } from '../sessions.ts'
import { AcknowledgementSchema, readTool, tool, type Tool } from './tool.ts'
import { requestForWorker } from '../request-views.ts'

export interface ExecutorToolsHost {
  readonly remote?: Pick<RemoteEnvironments, 'hasUnsettled' | 'downloadArtifact' | 'binding'>
  readonly verification?: Pick<import('../verification.ts').VerificationService, 'enqueue'>
  readonly engine: Pick<EngineForExecutor, 'report' | 'reply' | 'markUnrelated' | 'handback' | 'claimRequest' | 'transferRequest' | 'followForContext' | 'collaborate' | 'cancelFollowup'>
  readonly store: Pick<Store, 'tickets' | 'replyStatus' | 'atomic'>
  readonly sessions: Pick<Sessions, 'relay' | 'notify'>
  readonly resources: ResourceHost
  /** GitHub Source context whose pull-request rules govern claiming a reported PR. */
  readonly github: SourceContext
  /** Schedules a pass to deliver the collaboration note inputs queued by the Engine. */
  requestPass(): void
  sendReplies(receiptId?: string): Promise<void>
}

export function executorTools(host: ExecutorToolsHost, ticket: Ticket): Tool[] {
  const ticketId = ticket.id
  const currentAssignment = (receiptReplay = false) => {
    const current = host.store.tickets.get(ticketId), assignment = current && runningAssignment(current)
    // Core validates new mutations; an exact durable receipt can be read after a successful transfer ended its source.
    if (receiptReplay && current?.assignments.at(-1)) return current.assignments.at(-1)!.id
    if (!current || !liveTicket(current) || current.hold || !assignment) throw new Error('A live, unheld Assignment must own this request operation')
    return assignment.id
  }
  return [
    readTool('Read one page of this ticket’s listed resources; follow page links.',
      true, (resource, offset, limit, signal) => readResource(host.resources, resource, offset, limit, ticketId, signal)),
    tool({
      name: 'orchestrator_thread_publish',
      description: 'Publish peer-relevant context on a subscribed thread; skip routine updates. Reuse IDs only for retries.',
      schema: z.object({
        thread: z.string().min(1),
        text: z.string().trim().min(1).max(4000),
        request_id: z.string().trim().min(1).max(200),
      }).strict(),
      execute: async args => {
        const current = host.store.tickets.get(ticketId)
        const currentAssignmentId = current && runningAssignment(current)?.id
        if (!currentAssignmentId) throw new Error('No running Assignment owns this publication')
        const receipt = host.engine.collaborate(ticketId, args.thread, args.text, args.request_id, currentAssignmentId)
        host.requestPass()
        return { published: true, ...receipt }
      },
    }),
    tool({
      name: 'orchestrator_ack',
      description: 'Acknowledge one original human request before substantial work, as the replies section says; it posts as a reply to that message.',
      schema: z.object({
        trigger_id: z.string(),
        text: AcknowledgementSchema.describe(`At most ${IM_WORDS} words; Markdown is supported.`),
      }).strict(),
      execute: async args => {
        const reply = host.engine.reply({ purpose: 'acknowledgement', ticketId, triggerId: args.trigger_id, text: args.text })
        if (reply.status !== 'sent') await host.sendReplies(reply.id)
        return { trigger_id: args.trigger_id, acknowledgement: host.store.replyStatus(reply.id)!, reused: reply.reused }
      },
    }),
    tool({
      name: 'orchestrator_thread_unrelated',
      description: 'Stop following an attached thread that is not about this ticket, as the work section says; its own threads cannot be dropped.',
      schema: z.object({
        thread: z.string().min(1).describe('The thread key, which trigger/<id> of one of its messages shows as thread, such as feishu:<chat>:<root> or github:<number>.'),
        reason: z.string().trim().min(1).max(300).describe('One sentence on why the thread is not about this ticket.'),
      }).strict(),
      execute: async args => { host.engine.markUnrelated(ticketId, args.thread, args.reason); return { removed: true, thread: args.thread } },
    }),
    tool({
      name: 'orchestrator_thread_follow',
      description: 'Follow a related thread, such as an Issue or another PR, for context only.',
      schema: z.object({
        thread: z.string().describe('Thread key, such as github:<number>.'),
        reason: z.string().trim().min(1).max(300).describe('How it relates, in one sentence.'),
      }).strict(),
      execute: async args => host.store.atomic(() => {
        const at = args.thread.indexOf(':')
        if (at < 1 || at === args.thread.length - 1) throw new Error('A thread key is <source>:<id>, such as github:<number>')
        const followed = host.engine.followForContext(ticketId, { source: args.thread.slice(0, at), id: args.thread.slice(at + 1) })
        if (followed) host.sessions.notify(...threadFollowedNotice(ticketId, args.thread, args.reason))
        return { followed, thread: args.thread }
      }),
    }),
    tool({
      name: 'orchestrator_request_claim',
      description: 'Claim matching scope from the original request; internally confirms its thread.',
      schema: z.object({ trigger_id: z.string().min(1), expected_revision: z.number().int().min(0),
        reason: z.string().trim().min(1).max(300).describe('Original goal/output relation.') }).strict(),
      execute: async args => {
        const request = host.engine.claimRequest(ticketId, args.trigger_id, args.reason, currentAssignment(), args.expected_revision)
        host.requestPass(); return { request: requestForWorker(request, ticketId) }
      },
    }),
    tool({
      name: 'orchestrator_request_transfer',
      description: 'Transfer a request to its identified task; retain work and IDs. Reuse request_id on retry.',
      schema: z.object({ trigger_id: z.string().min(1), to_ticket_id: z.string().min(1), expected_revision: z.number().int().min(0),
        request_id: z.string().trim().min(1).max(200), reason: z.string().trim().min(1).max(500)
          .describe('Owner relation, reusable findings/receipts, remaining work.') }).strict(),
      execute: async args => {
        const request = host.engine.transferRequest(ticketId, args.trigger_id, args.to_ticket_id, args.reason, args.request_id,
          currentAssignment(true), args.expected_revision)
        host.requestPass(); return { request: requestForWorker(request, ticketId) }
      },
    }),
    tool({
      name: 'orchestrator_trigger_handback',
      description: 'Return original/later work outside this task; retain its ID and release this responsibility. Retry safely.',
      schema: z.object({
        trigger_id: z.string().min(1),
        reason: z.string().trim().min(1).max(300).describe('One sentence on what it asks for beyond this ticket.'),
        expected_revision: z.number().int().min(0).optional(),
      }).strict(),
      execute: async args => {
        const queued = host.engine.handback(ticketId, args.trigger_id, args.reason, currentAssignment(true), args.expected_revision)
        host.requestPass(); return { trigger_id: args.trigger_id, queued }
      },
    }),
    tool({
      name: 'orchestrator_report',
      description: 'Report structured progress, waiting, ready, blocked, failed or dropped, as the work and handoff sections say. Schedule external rechecks with next_check.',
      schema: z.object({
        state: z.enum(['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped']),
        summary: z.string().min(1).max(4000).refine(value => value.trim().length > 0, 'Summary must contain text'),
        completed: z.array(z.string().trim().min(1).max(500)).max(30).optional(),
        pending: z.array(z.string().trim().min(1).max(500)).max(30).optional(),
        waiting_for: z.object({ subject: z.string().trim().min(1).max(500), expected_at: z.string().datetime({ offset: true }).optional(),
          kind: z.enum(['external', 'human', 'event']) }).strict().optional(),
        evidence: z.array(z.object({ description: z.string().trim().min(1).max(1000), ref: z.string().trim().min(1).max(1000).optional() }).strict()).max(30).optional(),
        next_check: z.object({ key: z.string().trim().min(1).max(200), at: z.string().datetime({ offset: true }),
          purpose: z.string().trim().min(1).max(500), success_condition: z.string().trim().min(1).max(1000),
          resume_instruction: z.string().trim().min(1).max(2000) }).strict().optional(),
        human_action: z.string().trim().min(1).max(1000).nullish().describe('One concrete question for a person, also with state=progress or waiting; omit to keep the pending one, null to clear it.'),
        question_for_trigger_id: z.string().optional().describe('With human_action: the human message that raised the question, which is asked where that person wrote.'),
        pr_number: z.number().int().positive().nullish().describe(host.github.deployment.github
          ? `The ticket's PR: its source PR, or one by ${host.github.deployment.github.login} from a branch named after this ticket (DSH_SUPERAGENT_NAME).`
          : 'The ticket\'s GitHub PR number; only available when a GitHub Source is configured. Omit when the task has no PR.'),
        reply_to_trigger_id: z.string().optional().describe('The explicit human question this report answers; never for ordinary progress.'),
        artifacts: z.array(z.object({ path: z.string().min(1), name: z.string().optional(),
          kind: z.enum(['file', 'image', 'video']).optional() }).strict()).max(8).optional()
          .describe('With state=ready: output files inside this task directory. The host snapshots them and the Router delivers them through the original source; do not call QQ or handle its credentials yourself.'),
      }).strict(),
      execute: async (args, signal) => {
        const current = host.store.tickets.get(ticketId)
        if (!current || !liveTicket(current)) throw new Error('Ticket ended (PR was closed or work finished); do not resume it')
        // Bind this call before artifact or PR reads yield; registrations survive retries with the worker Session.
        const assignmentId = runningAssignment(current)?.id
        if (args.pr_number != null && (!host.github.deployment.github || !host.github.deployment.repository)) {
          throw new Error('PR reporting requires a configured GitHub Source; omit pr_number when this task has no GitHub PR')
        }
        if (args.artifacts?.length && args.state !== 'ready') throw new Error('Report deliverable artifacts only with state=ready')
        if (args.state === 'ready' && host.remote?.hasUnsettled(ticketId)) throw new Error('Remote commands are still running or awaiting outcome verification; read their existing command IDs before reporting ready')
        const artifacts = args.artifacts?.length ? await Promise.all(args.artifacts.map(async item => {
          if (!host.resources.artifacts || !current.execution?.directory) throw new Error('Task artifact storage is unavailable')
          const remote = parseRemoteArtifactReference(item.path)
          if (remote) {
            if (!host.remote || host.remote.binding(ticketId) !== remote.deviceId) throw new Error('Artifact environment does not match this task')
            const destination = join(current.execution.directory, '.remote-artifacts', randomUUID(), basename(remote.path))
            const downloaded = await host.remote.downloadArtifact(ticketId, remote.deviceId, remote.path, destination)
            return host.resources.artifacts.stage(ticketId, current.execution.directory, downloaded.path, item.name ?? basename(remote.path), item.kind, signal)
          }
          return host.resources.artifacts.stage(ticketId, current.execution.directory, item.path, item.name, item.kind, signal)
        })) : []
        const pull = args.pr_number != null ? await readPull(host.github, args.pr_number, signal) : undefined
        // Claim the PR, record the report, and queue the relay atomically so a rejected PR claim or invalid report leaves no partial state, and a recorded report always reaches the main Session.
        return host.store.atomic(() => {
          const refused = pull && claimPull(host.github, ticketId, pull)
          if (refused) throw new Error(refused)
          const report = { state: args.state, summary: args.summary,
            ...(args.completed ? { completed: args.completed } : {}), ...(args.pending ? { pending: args.pending } : {}),
            ...(args.waiting_for ? { waitingFor: { subject: args.waiting_for.subject, kind: args.waiting_for.kind,
              ...(args.waiting_for.expected_at ? { expectedAt: args.waiting_for.expected_at } : {}) } } : {}),
            ...(args.evidence ? { evidence: args.evidence } : {}), ...(args.next_check ? { nextCheck: { key: args.next_check.key, at: args.next_check.at,
              purpose: args.next_check.purpose, successCondition: args.next_check.success_condition,
              resumeInstruction: args.next_check.resume_instruction } } : {}),
            ...(args.human_action !== undefined ? { question: args.human_action } : {}),
            ...artifacts.length ? { artifacts: artifacts.map(item => item.id) } : {},
            ...(args.question_for_trigger_id ? { askedBy: args.question_for_trigger_id } : {}),
            ...(args.reply_to_trigger_id ? { answers: args.reply_to_trigger_id } : {}) }
          if (!assignmentId) throw new Error('No running Assignment owns this report')
          const updated = host.engine.report(ticketId, report, assignmentId)
          host.verification?.enqueue(updated)
          const relay = reportRelay(updated, report)
          if (relay) host.sessions.relay(relay.id, relay.text)
          const notification = relay ? 'orchestrator' : 'internal_only'
          return { reported: true, notification, ...artifacts.length ? { artifacts: artifacts.map(({ id, name, size }) => ({ id, name, size })) } : {},
            ...(updated.attention ? { attention: updated.attention } : {}) }
        })
      },
    }),
    tool({
      name: 'orchestrator_followup_cancel',
      description: 'Cancel this ticket’s scheduled recheck by its stable key.',
      schema: z.object({ key: z.string().trim().min(1).max(200) }).strict(),
      execute: async args => {
        const current = host.store.tickets.get(ticketId)
        const assignmentId = current && runningAssignment(current)?.id
        if (!assignmentId) throw new Error('No running Assignment owns this cancellation')
        host.engine.cancelFollowup(ticketId, args.key, assignmentId)
        return { cancelled: true, key: args.key }
      },
    }),
  ]
}
