/** Fixed recall tasks with independently stated expected facts; reused by persistence and evaluation suites. */
import type { MemorySaveArgs } from '../../src/app/memory.ts'

export const MEMORY_EVALUATION_AT = '2027-02-07T01:00:00.000Z'
export const MEMORY_EVALUATION_FACTS: MemorySaveArgs[] = [
  { topic: 'vendor-reply-style', title: '供应商邮件回复风格', summary: '给供应商的邮件使用正式、简洁的语气。',
    content: '起草供应商邮件时先说明订单，再列需要确认的事项。', scopes: ['global'], importance: 70 },
  { topic: 'atlas-work-release', title: 'Atlas 发布规范', summary: '工作项目 Atlas 上线前先通过持续集成检查。',
    content: '部署工作项目 Atlas 前应检查 CI，并将版本部署到预发布环境。', scopes: ['project:atlas-work'], aliases: ['Atlas发布上线', 'CI'], importance: 80 },
  { topic: 'atlas-home-release', title: 'Atlas 发布规范', summary: '个人项目 Atlas 使用手动上传的静态页面发布流程。',
    content: '个人项目与工作项目各自使用独立的发布流程。', scopes: ['project:atlas-home'], aliases: ['Atlas发布上线'], importance: 90 },
  { topic: 'calendar-old', title: '会议时区约定', summary: '旧项目会议使用欧洲中部时间。', content: '这项约定只用于已经结束的旧项目。',
    scopes: ['global'], valid_until: '2027-01-01T00:00:00.000Z', importance: 100 },
  { topic: 'calendar-current', title: '会议时区约定', summary: '当前会议安排使用 Asia/Shanghai 时区。',
    content: '涉及日程与会议的时间统一标明 Asia/Shanghai。', scopes: ['global'], importance: 75 },
  { topic: 'vendor-archive', title: '采购资料归档', summary: '采购材料按订单编号保存。',
    content: '供应商报价收到后核对交期与税费，再归档到订单目录。', scopes: ['project:procurement'], importance: 40 },
  { topic: 'qq-contact', title: '联系渠道', summary: 'QQ 群沟通中优先回复原群消息。', content: '来源为 QQ 的工作沿原群沟通。',
    scopes: ['source:qq'], importance: 60 },
  { topic: 'email-contact', title: '联系渠道', summary: '正式邮件往来沿原邮件线程回复。', content: '邮件交付保留原线程。',
    scopes: ['source:mail'], importance: 60 },
].map((fact, index) => ({ ...fact, expected_revision: 0, evidence: 'user', confirmed_at: '2027-02-01T00:00:00.000Z',
  sources: [{ kind: 'trigger', ref: `memory-fixture-${index}`, quote: fact.summary }] })) as MemorySaveArgs[]

export const MEMORY_RECALL_CASES = [
  { name: 'Chinese words across a summary', query: '供应商 邮件', scopes: ['project:procurement'], expected: 'vendor-reply-style', forbidden: ['atlas-home-release'] },
  { name: 'Same project name in isolated scopes', query: 'Atlas 发布', scopes: ['project:atlas-work'], expected: 'atlas-work-release', forbidden: ['atlas-home-release'] },
  { name: 'Other Atlas scope keeps its own fact', query: 'Atlas 发布', scopes: ['project:atlas-home'], expected: 'atlas-home-release', forbidden: ['atlas-work-release'] },
  { name: 'Expired long-term agreement', query: '会议 时区', scopes: ['global'], expected: 'calendar-current', forbidden: ['calendar-old'] },
  { name: 'Chinese terms present only in the body', query: '供应商报价 交期', scopes: ['project:procurement'], expected: 'vendor-archive', forbidden: ['atlas-work-release'] },
  { name: 'Cross-source retrieval preserves explicit source scope', query: '联系渠道', scopes: ['source:qq'], expected: 'qq-contact', forbidden: ['email-contact'] },
]
