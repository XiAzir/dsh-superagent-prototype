export type WatchdogStatus = 'healthy' | 'waiting' | 'stalled' | 'diverged'
export function loopbackUrl(input: string): string
export function assessorInput(snapshot: unknown): string
export function runCommand(command: string[], options?: { input?: string; timeoutMs?: number; maxOutput?: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv }): Promise<{ stdout: string; stderr: string }>
export function watchdogOnce(options: Record<string, unknown>): Promise<{ report: Record<string, unknown>; changed: boolean; exitCode: number }>
