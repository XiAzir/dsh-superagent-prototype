/** Fixed regression workloads. Expected routes are retained by the scorer and omitted from provider input. */
export const AUTONOMY_TASK_SET_VERSION = 'autonomy-fixtures-v3'
export type FixtureTask = 'summary' | 'stopped' | 'recovery' | 'reproduction' | 'waiting'
export interface ReplayFixture {
  id: string
  kind: 'noise' | 'request' | 'followup' | 'status' | 'stop' | 'ci' | 'observation' | 'correction' | 'duplicate'
  thread: string
  text: string
  task?: FixtureTask
  target?: FixtureTask
  duplicateOf?: string
  control?: 'status' | 'stop' | 'supplement'
  expected: { kind: 'accept' | 'attach' | 'ignore' | 'status' | 'stop' | 'duplicate'; target?: FixtureTask }
}
export const replayFixtures: readonly ReplayFixture[] = [
  { id: 'noise-1', kind: 'noise', thread: 'lounge', text: '今天午饭吃什么？', expected: { kind: 'ignore' } },
  { id: 'summary-request', kind: 'request', thread: 'summary', text: '读取数据 [3,5,7]，生成 summary.json（JSON 对象，count 字段为数据总数，total 字段为合计）和 report.txt，核对总数与合计。', task: 'summary', expected: { kind: 'accept' } },
  { id: 'stopped-request', kind: 'request', thread: 'stopped', text: '筛选输入 [1,2,3] 的奇数，生成 filtered.json。', task: 'stopped', expected: { kind: 'accept' } },
  { id: 'summary-followup', kind: 'followup', thread: 'summary', text: '补充要求：报告也列出原始数据。', target: 'summary', control: 'supplement', expected: { kind: 'attach', target: 'summary' } },
  { id: 'summary-conversation', kind: 'followup', thread: 'summary', text: '这份汇总后续会用于内部核对。', target: 'summary', expected: { kind: 'attach', target: 'summary' } },
  { id: 'stopped-followup', kind: 'followup', thread: 'stopped', text: '筛选结果采用排序后的数组。', target: 'stopped', control: 'supplement', expected: { kind: 'attach', target: 'stopped' } },
  { id: 'summary-status', kind: 'status', thread: 'summary', text: '查看这项汇总任务的进度。', target: 'summary', control: 'status', expected: { kind: 'status', target: 'summary' } },
  { id: 'ci-summary', kind: 'ci', thread: 'summary', text: 'Fixture CI: input schema validation passed.', target: 'summary', expected: { kind: 'attach', target: 'summary' } },
  { id: 'recovery-request', kind: 'request', thread: 'recovery', text: '执行一次本地记账并生成 receipt.json（JSON 对象，operationId 字段为 "fixture-operation"，count 字段为该操作的记账次数，成功时应为 1）；遇到宿主重启时沿 effects.json 已有记录继续，保持同一操作只记一次。', task: 'recovery', expected: { kind: 'accept' } },
  { id: 'waiting-request', kind: 'request', thread: 'waiting', text: '等待 external.txt 出现后读取其内容，生成 resumed.txt，继续原工单。', task: 'waiting', expected: { kind: 'accept' } },
  { id: 'observation', kind: 'observation', thread: 'observation', text: '讨论反馈：Node.js JSON.parse 解析 {invalid-json} 时崩溃，可在独立目录复现，将实际错误名称和原始输入记录到 reproduction.txt。', task: 'reproduction', expected: { kind: 'accept' } },
  { id: 'stop-filter', kind: 'stop', thread: 'stopped', text: '停止筛选任务。', target: 'stopped', control: 'stop', expected: { kind: 'stop', target: 'stopped' } },
  { id: 'stopped-status', kind: 'status', thread: 'stopped', text: '查看已停止筛选任务的状态。', target: 'stopped', control: 'status', expected: { kind: 'status', target: 'stopped' } },
  { id: 'summary-correction', kind: 'correction', thread: 'summary', text: '修正此前要求：报告标题使用“经核实的汇总”。', target: 'summary', control: 'supplement', expected: { kind: 'attach', target: 'summary' } },
  { id: 'duplicate-summary', kind: 'duplicate', thread: 'summary', text: '读取数据 [3,5,7]，生成 summary.json（JSON 对象，count 字段为数据总数，total 字段为合计）和 report.txt，核对总数与合计。', duplicateOf: 'summary-request', expected: { kind: 'duplicate' } },
]

export interface FixtureDefinition {
  task: FixtureTask
  instruction: string
  files: { name: string; content: string }[]
  outputNames: string[]
}
export const taskFixtures: Record<FixtureTask, FixtureDefinition> = {
  summary: { task: 'summary', instruction: 'Read input.json. Create summary.json with count and total. Create report.txt containing title 经核实的汇总 and original values 3,5,7.',
    files: [{ name: 'input.json', content: JSON.stringify({ values: [3, 5, 7] }) }], outputNames: ['summary.json', 'report.txt'] },
  stopped: { task: 'stopped', instruction: 'Filter odd values from input.json into filtered.json.',
    files: [{ name: 'input.json', content: JSON.stringify([1, 2, 3]) }], outputNames: ['filtered.json'] },
  recovery: { task: 'recovery', instruction: 'Use the existing effects.json checkpoint and generate receipt.json with count=1 and operationId=fixture-operation. Preserve the existing operation.',
    files: [], outputNames: ['receipt.json'] },
  reproduction: { task: 'reproduction', instruction: 'Use the actual Node.js JSON.parse observation in observed-runtime.json to write its error name and original input to reproduction.txt.',
    files: [{ name: 'invalid.json', content: '{invalid-json}' }], outputNames: ['reproduction.txt'] },
  waiting: { task: 'waiting', instruction: 'Wait for external.txt and copy its observed contents into resumed.txt.', files: [], outputNames: ['resumed.txt'] },
}
