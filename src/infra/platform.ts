/** Small platform adapters shared by command callers and deployment setup. */
import { existsSync } from 'node:fs'

export const isAbsolutePath = (value: string): boolean => value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(value)

/** Resolve a paired Windows batch entry to its PowerShell implementation. */
export function windowsCommandTarget(program: string): string {
  if (process.platform !== 'win32' || !/\.(?:cmd|bat)$/i.test(program)) return program
  const script = program.replace(/\.(?:cmd|bat)$/i, '.ps1')
  if (!existsSync(script)) throw new Error(`Cannot safely execute ${program}; a paired PowerShell .ps1 wrapper is required.`)
  return script
}

/** Keep Windows environment names unique even when callers use different casing. */
export function commandEnvironment(env: Record<string, string | undefined>): Record<string, string | undefined> {
  if (process.platform !== 'win32') return { ...env }
  const values = new Map<string, [string, string | undefined]>()
  for (const [name, value] of Object.entries(env)) {
    const key = name.toUpperCase()
    const old = values.get(key)
    values.set(key, [old?.[0] ?? name, value])
  }
  return Object.fromEntries([...values.values()])
}

/** Convert explicit PowerShell script paths to an invocation Node can spawn without a shell. */
export function commandInvocation(program: string, args: string[]): { file: string; args: string[] } {
  program = windowsCommandTarget(program)
  if (process.platform === 'win32' && /\.ps1$/i.test(program)) {
    return { file: 'pwsh.exe', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', program, ...args] }
  }
  return { file: program, args }
}
