/** Worker tools bound to one owner-selected environment and the current authorized ticket. */
import { z } from 'zod'
import { tool, type Tool } from '../app/tools/tool.ts'
import type { RemoteEnvironments } from './client.ts'
import { EnvironmentError, safeRemoteText } from './protocol.ts'

export function remoteTools(remote: RemoteEnvironments, ticketId: string): Tool[] {
  const guarded = async <T>(work: () => Promise<T>): Promise<T | { state: 'waiting_environment' | 'failed'; error: string; message: string }> => {
    try { return await work() } catch (error) {
      return { state: error instanceof EnvironmentError && error.status === 503 ? 'waiting_environment' : 'failed',
        error: error instanceof EnvironmentError ? error.code : 'environment_error', message: safeRemoteText(error instanceof Error ? error.message : error, undefined, 1000) }
    }
  }
  const device = () => remote.assertBinding(ticketId)
  return [
    tool({ name: 'orchestrator_environment', description: 'Read this ticket’s bound execution device and remote working directory. Device-offline waits retain this ticket.',
      schema: z.object({}).strict(), execute: async () => guarded(async () => {
        const rank = (state: string) => state === 'unknown' ? 0 : ['queued', 'waiting_environment', 'accepted', 'running'].includes(state) ? 1 : 2
        const commands = remote.commands(ticketId).sort((a, b) => rank(a.effectiveState) - rank(b.effectiveState)
          || b.updatedAt.localeCompare(a.updatedAt) || a.commandId.localeCompare(b.commandId))
        return { device: remote.list().find(item => item.id === device()), ...await remote.workspace(ticketId), command_count: commands.length,
          commands: commands.slice(0, 8).map(command => ({ commandId: command.commandId, requestId: command.requestId,
            requestTriggerId: command.requestTriggerId ?? null, originalTicketId: command.ticketId, state: command.effectiveState })) }
      }) }),
    tool({ name: 'orchestrator_environment_start', description: 'Start a shell command on the bound remote device. Keep request_id for the same operation across request transfers. source_request_id selects a claimed original request when this ticket owns several. Paths use the first execution ticket’s directory on a retry. Query command_id after a lost response; inspect unknown outcomes before new work.',
      schema: z.object({ request_id: z.string().min(1).max(200), command: z.string().min(1).max(64000),
        source_request_id: z.string().min(1).max(200).optional(),
        cwd: z.string().max(1024).optional().describe('Task-relative directory; omit for the task root.'),
        timeout_ms: z.number().int().min(100).max(86_400_000).optional() }).strict(),
      execute: async args => guarded(() => remote.start(device(), ticketId, { requestId: args.request_id, requestTriggerId: args.source_request_id,
        command: args.command, cwd: args.cwd, timeoutMs: args.timeout_ms })) }),
    tool({ name: 'orchestrator_environment_status', description: 'Read a durable remote command result, including output. Reconnect by querying the same command_id; preserve unknown outcomes.',
      schema: z.object({ command_id: z.string().min(1).max(200) }).strict(), execute: async args => guarded(() => remote.status(ticketId, args.command_id)) }),
    tool({ name: 'orchestrator_environment_cancel', description: 'Cancel a remote command. Offline cancellation is durable and is applied after reconnect, before any queued start.',
      schema: z.object({ command_id: z.string().min(1).max(200) }).strict(), execute: async args => guarded(() => remote.cancel(ticketId, args.command_id)) }),
    tool({ name: 'orchestrator_environment_read', description: 'Read UTF-8 task-local remote file bytes with SHA-256 verification. Large outputs are paged in this tool. Report deliverables with remote://device/path.',
      schema: z.object({ path: z.string().min(1).max(1024), offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(16000).default(8000) }).strict(), execute: async args => guarded(async () => {
        const file = await remote.readFile(ticketId, device(), args.path), text = await remote.toolText(ticketId, Buffer.from(file.base64, 'base64').toString('utf8'))
        return { path: file.path, directory: file.directory, bytes: file.bytes, sha256: file.sha256, text: text.slice(args.offset, args.offset + args.limit),
          offset: args.offset, next_offset: args.offset + args.limit < text.length ? args.offset + args.limit : null, total_chars: text.length }
      }) }),
    tool({ name: 'orchestrator_environment_write', description: 'Write UTF-8 text inside this ticket’s remote directory and verify its SHA-256 receipt. Overwrite must be explicit; identical retries reuse the existing file.',
      schema: z.object({ path: z.string().min(1).max(1024), text: z.string().max(1_000_000), overwrite: z.boolean().default(false) }).strict(),
      execute: async args => guarded(() => remote.writeFile(ticketId, device(), args.path, Buffer.from(args.text), args.overwrite)) }),
  ]
}
