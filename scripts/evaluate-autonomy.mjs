#!/usr/bin/env node
/** Run isolated protocol and file-task evaluations; never connects to the operator's active DSH instance. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const option = name => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined }
const allowed = new Set(['--mode', '--provider-config', '--model', '--provider-name', '--provider-tasks', '--help'])
for (let at = 0; at < args.length; at++) {
  if (!allowed.has(args[at])) throw new Error(`Unknown evaluation option ${args[at]}`)
  if (!['--help', '--provider-tasks'].includes(args[at])) { if (!args[at + 1] || args[at + 1].startsWith('--')) throw new Error(`Missing value for ${args[at]}`); at++ }
}
if (args.includes('--help')) {
  process.stdout.write('node scripts/evaluate-autonomy.mjs [--mode all|router-first|structured-fast-path|subscription-fast-path|single-worker] [--provider-config argv.json --provider-name NAME --model MODEL --provider-tasks]\n')
} else {
  const { runAutonomyEvaluation, cliEvaluationProvider } = await import('../lib/autonomy-evaluation.js').catch(() => {
    throw new Error('Build the worktree first to create lib/autonomy-evaluation.js.')
  })
  const requestedMode = option('--mode') ?? 'all'
  const modes = requestedMode === 'all' ? ['router-first', 'structured-fast-path', 'subscription-fast-path', 'single-worker'] : [requestedMode]
  if (modes.some(mode => !['router-first', 'structured-fast-path', 'subscription-fast-path', 'single-worker'].includes(mode))) throw new Error('Unsupported evaluation mode')
  let provider
  const providerFile = option('--provider-config')
  if (providerFile) {
    const argv = JSON.parse(await readFile(resolve(providerFile), 'utf8'))
    provider = cliEvaluationProvider(argv, { name: option('--provider-name') ?? 'configured-cli', model: option('--model'), executeTasks: args.includes('--provider-tasks') })
  } else if (args.includes('--provider-tasks')) throw new Error('--provider-tasks requires --provider-config')
  let gitRevision = null
  try { gitRevision = (await promisify(execFile)('git', ['-C', root, 'rev-parse', 'HEAD'], { windowsHide: true })).stdout.trim() } catch { /* Metadata remains explicitly unknown. */ }
  const runId = new Date().toISOString().replace(/[:.]/g, '-')
  const buildHash = createHash('sha256').update(await readFile(join(root, 'lib', 'autonomy-evaluation.js'))).digest('hex')
  const output = join(root, '.artifacts', 'evaluation', runId)
  await mkdir(output, { recursive: true })
  const results = []
  for (const mode of modes) {
    const result = await runAutonomyEvaluation({ directory: join(output, mode), mode, runId: `${runId}-${mode}`, gitRevision: gitRevision ?? undefined, buildHash, provider })
    results.push(result)
    process.stdout.write(JSON.stringify({ mode, failures: result.failures.length, tasks: result.tasks.length,
      routerDecisions: result.summary.metrics.routerDecisions, wrongRoutes: result.summary.metrics.wrongRoutes, result: result.output.result }) + '\n')
  }
  const summary = { schema: 1, runId, gitRevision, providerConfigured: !!provider,
    interpretation: 'Local protocol and subprocess fixture measurements. Human adoption and unreported model usage remain unknown.',
    runs: results.map(result => ({ mode: result.mode, configHash: result.configHash, result: result.output.result, failures: result.failures, summary: result.summary })) }
  await writeFile(join(output, 'comparison.json'), JSON.stringify(summary, null, 2))
  process.stdout.write(`Comparison: ${join(output, 'comparison.json')}\n`)
  if (results.some(result => result.failures.length)) process.exitCode = 1
}
