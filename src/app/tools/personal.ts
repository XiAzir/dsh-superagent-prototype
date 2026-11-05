/** Owner-scoped Router tools and bounded Worker context. Approval is reserved for authenticated HTTP. */
import { z } from 'zod'
import { EditablePersonalKinds, type PersonalCoordinator } from '../personal-coordinator.ts'
import { tool, type Tool } from './tool.ts'
import type { PersonalRuntime } from '../personal-runtime.ts'

export function personalTools(service: PersonalCoordinator, ticketId?: string, runtime?: PersonalRuntime): Tool[] {
  if (!service.host.personalMode()) return []
  const actions: Tool[] = runtime ? [tool({
    name: 'orchestrator_personal_action',
    description: 'Prepare an exact ticket_reply for owner approval in the personal assistant page, or inspect/execute that approved request. This tool never grants approval. Target is source:thread from this ticket channels; text is the full outgoing content.',
    schema: z.object({ operation: z.enum(['prepare', 'check', 'execute']), trigger_id: z.string().optional(), ticket_id: z.string().optional(),
      action_id: z.string().optional(), request_id: z.string().min(1).max(200).optional(), target: z.string().optional(), text: z.string().max(4000).optional() }).strict(),
    execute: async args => {
      if (!ticketId) service.ownerTrigger(args.trigger_id ?? '')
      const id = ticketId ?? args.ticket_id ?? ''
      service.ownerTicket(id)
      if (args.operation === 'prepare') {
        const ticket = service.host.store.tickets.get(id)!
        if (!args.target || !ticket.channels.some(channel => `${channel.source}:${channel.thread}` === args.target)) throw new Error('请选择工单已有渠道。')
        if (!args.request_id || !args.text?.trim()) throw new Error('请提供稳定请求编号和完整发送正文。')
        const action = runtime.actions.prepare(id, { idempotencyKey: `${id}:${args.request_id}`, action: 'ticket_reply', target: args.target,
          payload: { text: args.text }, scope: ['ticket:reply'], risk: 'L3', expiresAt: new Date(Date.now() + 86_400_000).toISOString() })
        return { action, next: '请在个人助理页面核对目标和完整正文后批准。' }
      }
      const action = service.host.store.personal.get('action', args.action_id ?? '')
      if (!action || action.ticketId !== id) throw new Error('行动与当前工单不匹配。')
      return args.operation === 'check' ? runtime.actions.check(action.id) : runtime.actions.execute(action.id)
    },
  })] : []
  if (ticketId) return [...actions, tool({
    name: 'orchestrator_personal_context',
    description: 'Read confirmed personal facts and commitments linked to this owner ticket. Sources and expiry remain authoritative.',
    schema: z.object({}).strict(), execute: async () => service.context(ticketId),
  })]
  return [...actions, tool({
    name: 'orchestrator_personal_context',
    description: 'Read the owner goals, open commitments, effective confirmed facts and constraints before planning. Supply the original owner trigger.',
    schema: z.object({ trigger_id: z.string().min(1) }).strict(),
    execute: async args => { service.ownerTrigger(args.trigger_id); return service.context() },
  }), tool({
    name: 'orchestrator_personal_record',
    description: 'Record an explicitly requested goal, commitment or soft constraint with original owner evidence. Facts are proposals for owner confirmation. Use stable id and read revision; inspect conflicts before scheduling. JSON value uses camelCase fields.',
    schema: z.object({ trigger_id: z.string().min(1), kind: z.enum(EditablePersonalKinds), id: z.string().min(1).max(200),
      revision: z.number().int().nonnegative(), value: z.record(z.string(), z.unknown()).describe(
        'Patch fields only. goal: title, description?, priority 0..100, successCriteria[], status active/paused/completed/cancelled. '
        + 'commitment: title, owner user/assistant/external, counterparty?, dueAt?/expectedAt?/nextCheckAt? (ISO with timezone; at least one), goalIds[], ticketIds[], status open/waiting/overdue/fulfilled/cancelled. '
        + 'fact: subject, predicate, value, scope global or ticket:<id>, validFrom?, validUntil?, supersedes?; proposals await owner confirmation. '
        + 'constraint: title, kind time/budget/privacy/channel/risk, severity soft, startAt?, endAt?, amount?, currency?, scope?. '
        + 'Never include id/revision/timestamps/sourceRefs inside value.') }).strict(),
    execute: async args => service.write(args.kind, { id: args.id, revision: args.revision, value: args.value }, { triggerId: args.trigger_id }),
  }), tool({
    name: 'orchestrator_personal_conflicts',
    description: 'Check a proposed time interval or spend against active personal constraints before making commitments.',
    schema: z.object({ trigger_id: z.string().min(1), startAt: z.string().optional(), endAt: z.string().optional(),
      amount: z.number().nonnegative().optional(), currency: z.string().optional(), scope: z.string().optional() }).strict(),
    execute: async ({ trigger_id, ...proposal }) => { service.ownerTrigger(trigger_id); return { conflicts: service.conflicts(proposal) } },
  })]
}
