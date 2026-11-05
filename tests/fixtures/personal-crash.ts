import { spawn, type ChildProcess } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

export interface CrashChild {
  child: ChildProcess
  ready: Promise<void>
  stopped: Promise<void>
  kill(): void
}

/** Start a native Node TypeScript child that holds a SQLite writer open after the requested durability point. */
export function personalCrashChild(database: string, phase: 'committed' | 'uncommitted'): CrashChild {
  const storeUrl = pathToFileURL(resolve('src/app/store.ts')).href
  const source = `
    import { Store } from ${JSON.stringify(storeUrl)};
    const store = new Store(${JSON.stringify(database)});
    const at = '2026-11-05T09:00:00.000Z';
    const fact = { id: 'crash-fact', revision: 0, createdAt: at, updatedAt: at, sourceRefs: ['owner/panel'], subject: 'owner',
      predicate: 'timezone', value: 'Asia/Shanghai', scope: 'global', confidence: 1, confirmation: 'user', status: 'active' };
    const ticket = { id: 'crash-ticket', title: 'Durable followup', decisionId: 'decision-crash', channels: [], assignments: [], inputs: [], undelivered: [],
      createdAt: at, updatedAt: at, mandate: { strength: 'explicit', policyVersion: 'v1', basis: { via: 'listed' },
        actor: { source: 'feishu', id: 'ou_alice' }, scope: 'personal' }, origin: { triggerId: 'trigger-crash', triggerIds: ['trigger-crash'] },
      followups: [{ id: 'followup-1', key: 'review', revision: 1, at: '2026-11-06T09:00:00.000Z', purpose: 'Review the result',
        successCondition: 'Owner confirms completion', resumeInstruction: 'Ask for an update', status: 'scheduled', createdAt: at }] };
    if (${JSON.stringify(phase)} === 'committed') {
      store.atomic(() => { store.personal.save('fact', fact, 0); store.tickets.save(ticket); });
      process.send('COMMITTED');
    } else {
      store.atomic(() => { store.personal.save('fact', fact, 0); process.send('UNCOMMITTED'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); });
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  `
  const child = spawn(process.execPath, ['--experimental-transform-types', '--input-type=module', '-e', source], {
    cwd: resolve('.'), stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true,
  })
  let reached = false, errors = ''
  child.stderr?.setEncoding('utf8').on('data', chunk => { errors += chunk })
  const marker = phase === 'committed' ? 'COMMITTED' : 'UNCOMMITTED'
  let resolveReady!: () => void, rejectReady!: (error: Error) => void
  const ready = new Promise<void>((resolveReadyPromise, rejectReadyPromise) => { resolveReady = resolveReadyPromise; rejectReady = rejectReadyPromise })
  const readyTimeout = setTimeout(() => rejectReady(new Error(`Child did not reach ${phase} point. stderr: ${errors}`)), 10_000)
  child.on('message', message => {
    if (message === marker) { reached = true; clearTimeout(readyTimeout); resolveReady() }
  })
  child.once('error', error => { clearTimeout(readyTimeout); rejectReady(error) })
  child.once('exit', (code, signal) => {
    clearTimeout(readyTimeout)
    if (!reached) rejectReady(new Error(`Child exited before ${phase} point (code ${code}, signal ${signal}). stderr: ${errors}`))
  })
  const stopped = new Promise<void>((resolveStopped, rejectStopped) => {
    child.once('exit', () => resolveStopped())
    child.once('error', rejectStopped)
  })
  return { child, ready, stopped, kill: () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') } }
}
