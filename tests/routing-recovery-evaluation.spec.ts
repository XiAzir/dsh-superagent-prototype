import { mkdtempSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { runRoutingRecoveryEvaluation, ROUTING_RECOVERY_FAULTS } from '../src/evaluation/recovery.ts'
import { Store } from '../src/app/store.ts'

const directories: string[] = []
const temporary = () => { const directory = mkdtempSync(join(tmpdir(), 'routing-recovery-evaluation-')); directories.push(directory); return directory }
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

it('recovers four deliberately wrong routes by original request identity and completes real files after a SQLite restart', async () => {
  const result = await runRoutingRecoveryEvaluation({ directory: temporary() })
  expect(result.passed).toBe(true)
  expect(result.scenarios.map(item => item.fault)).toEqual(ROUTING_RECOVERY_FAULTS)
  expect(JSON.parse(await readFile(result.output, 'utf8'))).toEqual(result)
  for (const item of result.scenarios) {
    expect(item.failures).toEqual([])
    expect(item.before.id).toBe(item.originalRequestId)
    expect(item.recovered.id).toBe(item.originalRequestId)
    expect(item.final).toMatchObject({ id: item.originalRequestId, state: 'completed' })
    expect(item.requestCoverage).toEqual({ expected: 2, completed: 2, cancelled: 0, orphaned: 0 })
    expect(item.effects).toMatchObject({ duplicate: 0, unexpected: 0 })
    expect(item.effects.operations.filter(id => id === item.originalRequestId)).toHaveLength(1)
    expect(item.humanInterventions).toBe(0)
    expect(item.additionalModelCalls).toBe(0)
    expect(item.additionalTokens).toBeNull()
    expect(item.recoveryMs).toBeGreaterThanOrEqual(0)
    expect(item.correctiveActions).toBeGreaterThan(0)
    const output = item.files.find(file => file.requestId === item.originalRequestId)!
    const content = JSON.parse(await readFile(output.path, 'utf8'))
    expect(content).toMatchObject({ requestId: item.originalRequestId, completed: true })
    const store = new Store(item.database)
    expect(content.originalText).toBe(store.triggers.get(item.originalRequestId)?.text)
    expect(store.triggers.disposition(item.originalRequestId)?.request).toStrictEqual(item.final)
    store.close()
  }
  const attach = result.scenarios.find(item => item.fault === 'false-attach')!
  expect(attach.before.state).toBe('proposed')
  expect(attach.canonicalTicketId).not.toBe(attach.wrongTicketId)
  const accepted = result.scenarios.find(item => item.fault === 'false-accept')!
  expect(accepted.effects.reusedPriorCheckpoint).toBe(true)
  expect(accepted.additionalRouterDecisions).toBe(0)
  expect(accepted.final.history.filter(item => item.kind === 'transferred')).toHaveLength(1)
  expect(result.scenarios.find(item => item.fault === 'false-status')!.before.state).toBe('answered')
  expect(result.scenarios.find(item => item.fault === 'false-ignore')!.before.state).toBe('ignored')
}, 30000)

it('stops the recovered canonical owner even after a false accept moved the original request', async () => {
  const result = await runRoutingRecoveryEvaluation({ directory: temporary(), faults: ['false-accept'], stopAfterRecovery: true })
  expect(result.passed).toBe(true)
  const item = result.scenarios[0]!
  expect(item.stoppedTicketId).toBe(item.canonicalTicketId)
  expect(item.stoppedTicketId).not.toBe(item.wrongTicketId)
  expect(item.final.state).toBe('cancelled')
  expect(item.requestCoverage).toEqual({ expected: 2, completed: 0, cancelled: 2, orphaned: 0 })
  const store = new Store(item.database)
  expect(store.tickets.get(item.stoppedTicketId!)?.ended).toMatchObject({ by: 'human', outcome: 'stopped' })
  expect(store.tickets.get(item.wrongTicketId!)?.requestRedirect).toMatchObject({ triggerId: item.originalRequestId, toTicketId: item.canonicalTicketId })
  store.close()
  expect(item.effects.operations).toEqual([item.originalRequestId])
  expect(item.effects.duplicate).toBe(0)
}, 20000)

it('rejects unsupported or duplicated fault schedules before executing work', async () => {
  await expect(runRoutingRecoveryEvaluation({ directory: temporary(), faults: [] })).rejects.toThrow('distinct supported')
  await expect(runRoutingRecoveryEvaluation({ directory: temporary(), faults: ['false-attach', 'false-attach'] })).rejects.toThrow('distinct supported')
})
