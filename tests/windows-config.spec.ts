import { expect, it } from 'vitest'
import { ExecutorConfigSchema } from '../src/policy.ts'
import { isAbsolutePath } from '../src/infra/platform.ts'

it('accepts drive-qualified and UNC execution roots and rejects drive-relative paths', () => {
  for (const path of ['C:/agent/work', 'E:\\agent work\\tasks', '\\\\server\\share\\work', '/srv/agent']) {
    expect(isAbsolutePath(path), path).toBe(true)
    expect(ExecutorConfigSchema.parse({ directory: path }).directory).toBe(path)
  }
  for (const path of ['C:relative', '\\relative', 'work/tasks', '~/work']) {
    expect(isAbsolutePath(path), path).toBe(false)
    expect(() => ExecutorConfigSchema.parse({ directory: path }), path).toThrow()
  }
})

it.skipIf(process.platform !== 'win32')('protects required command names across Windows case and executable extensions', () => {
  for (const name of ['GH', 'gh.exe', 'Git.CMD', 'lark-cli.PS1', 'CON', 'nul.cmd', 'LPT1']) {
    expect(() => ExecutorConfigSchema.parse({ blockedCommands: [name] }), name).toThrow()
  }
  expect(ExecutorConfigSchema.parse({ blockedCommands: ['personal-gh'] }).blockedCommands).toEqual(['personal-gh'])
})
