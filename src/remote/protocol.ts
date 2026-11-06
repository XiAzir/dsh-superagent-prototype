/** Versioned wire vocabulary shared by the environment daemon and its host client. */
import { createHash } from 'node:crypto'

export const ENVIRONMENT_PROTOCOL = 1, ENVIRONMENT_SCHEMA = 1, ENVIRONMENT_VERSION = '1.0.0'
export type CommandState = 'accepted' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out' | 'unknown'
export interface CommandPayload { ticketId: string; command: string; cwd?: string; timeoutMs?: number }
export interface CommandRequest extends CommandPayload { commandId: string; payloadHash?: string }
export interface RemoteCommand {
  commandId: string; ticketId: string; payloadHash: string; state: CommandState; directory: string
  createdAt: string; startedAt?: string; endedAt?: string; exitCode?: number | null; reason?: string
  stdout: string; stderr: string; truncated?: boolean
}
export interface EnvironmentHealth {
  protocol: number; schema: number; version: string; daemonId: string; platform: string; node: string
  activeCommands: number; maxFileBytes: number
}
export interface RemoteFile { path: string; directory: string; bytes: number; sha256: string; base64: string }
/** Carries a stable environment protocol error code and HTTP status across daemon and host operations. */
export class EnvironmentError extends Error {
  code: string
  status: number
  constructor(code: string, message: string, status = 400) { super(message); this.name = 'EnvironmentError'; this.code = code; this.status = status }
}
export function validId(value: unknown, label = 'id'): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value)) throw new EnvironmentError('invalid_id', `Invalid ${label}`)
  return value
}
export function commandPayload(value: unknown): CommandPayload {
  const input = value as Partial<CommandRequest>
  if (!input || typeof input !== 'object' || typeof input.command !== 'string' || !input.command.trim() || input.command.length > 64_000)
    throw new EnvironmentError('invalid_command', 'Command must contain 1 to 64000 characters')
  if (input.cwd !== undefined && (typeof input.cwd !== 'string' || input.cwd.length > 1024)) throw new EnvironmentError('invalid_path', 'Invalid working directory')
  const timeoutMs = input.timeoutMs ?? 600_000
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 86_400_000) throw new EnvironmentError('invalid_timeout', 'Command timeout must be between 100 and 86400000 ms')
  return { ticketId: validId(input.ticketId, 'ticketId'), command: input.command, cwd: input.cwd || '.', timeoutMs }
}
export const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
export const payloadHash = (payload: CommandPayload): string => sha256(JSON.stringify(commandPayload(payload)))
export const terminalCommand = (state: CommandState): boolean => !['accepted', 'running'].includes(state)
export function safeRemoteText(value: unknown, secret?: string, limit = 64_000): string {
  let text = String(value)
  if (secret) text = text.split(secret).join('[redacted]')
  return text.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[private key redacted]')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[redacted]')
    .replace(/(["']?(?:access[_-]?token|refresh[_-]?token|token|secret|password|authorization|api[_-]?key)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}\]]+)/gi, '$1"[redacted]"').slice(0, limit)
}
export function environmentUrl(input: string, allowInsecureHttp = false): string {
  let url: URL
  try { url = new URL(input) } catch { throw new EnvironmentError('invalid_url', 'Environment URL must be absolute') }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  if (url.username || url.password || url.search || url.hash || !['http:', 'https:'].includes(url.protocol)
    || (url.protocol === 'http:' && !local && !allowInsecureHttp)) throw new EnvironmentError('invalid_url', 'Remote environments require HTTPS or explicit private-network HTTP configuration')
  return url.toString().replace(/\/$/, '')
}
