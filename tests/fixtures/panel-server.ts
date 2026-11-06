/**
 * Typed fake management API server for panel tests. Implements every route in `src/app/api.ts` and records any
 * undeclared query parameter or body mismatch in `server.misuse`, which `usePanelServer` asserts is empty after each test.
 */
import { afterEach, beforeEach, expect, vi } from 'vitest'
import { z } from 'zod'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { Api, ApiResponse, RouteParams } from '../../src/app/api.ts'
import type { PersonalApi, PersonalDashboard } from '../../src/app/personal-http.ts'
import type { PersonalKind, PersonalRecord, PersonalRecordMap, PersonalSettings } from '../../src/core/personal/model.ts'
import type { RoomActivity, RoomMessage, TaskRoomSummary, TaskRoomView } from '../../src/app/task-rooms.ts'
import { SKILL_NAME, SKILL_PREFIX, TEAM_SECTIONS, builtInBase, builtInPart, builtInParts, composePrompt, composeSkill, defaultPrompts,
  environmentSection, policySection, promptParts } from '../../src/app/prompts.ts'
import type { DroppedReply, HistoryView, Problem, PromptsView, SetupView, SourceStatusRow, SourceView, StateView, ThreadPageView,
  ThreadRow, TicketPageView,
  TicketRow, TicketStage,
  TriggerRow } from '../../src/client/api.ts'
import { SETUP_FIELDS } from '../../src/deployment.ts'
import { EvalConfigSchema, ExecutorConfigSchema, PolicyConfigSchema, SettingsSchema } from '../../src/policy.ts'
import { SetupError, type SetupCode } from '../../src/setup.ts'
import { feishuChannel } from '../../src/sources/feishu-trigger.ts'
import { githubChannel } from '../../src/sources/github-trigger.ts'
import { feishuKind } from '../../src/sources/feishu.ts'
import { githubKind } from '../../src/sources/github.ts'
import type { Health } from '../../src/sources/host.ts'
import type { FieldSpec, SourceKind } from '../../src/sources/kind.ts'
import { QqConfigSchema } from '../../src/app/qq-source.ts'
import { testDeployment } from './deployment.ts'

export const MEMBER = 'ou_alice'
const ALLOWED: Record<string, { id: string; name?: string }[]> = { feishu: [{ id: MEMBER, name: 'Alice' }], github: [{ id: 'alice' }] }
type Actor = TriggerRow['actor']
/** Resolve an actor display label using the fixture policy's allowed list or the source kind's unnamed fallback. */
export function actor(source: string, id: string, human = true): Actor {
  if (!id) return { source, id }
  const entry = ALLOWED[source]?.find(item => item.id.toLowerCase() === id.toLowerCase())
  const unnamed = source === 'feishu' ? feishuKind.policy?.unnamed : undefined
  const name = entry ? entry.name || entry.id : unnamed ? undefined : id
  return { source, id, name: name ? { zh: name, en: name } : human ? unnamed!.person : unnamed!.bot }
}
type TicketFields = Omit<TicketRow, 'stage' | 'action'>
const TICKET = {
  id: 't1', title: '修复回归', state: 'open', actions: { retry: false, stop: true }, strength: 'explicit', ended: undefined,
  attention: undefined, assignments: 1, inputs: 2, undelivered: 0, deliveryError: undefined, sessionId: 'worker-t1', directory: '/w/t1',
  summary: 'working on it', createdAt: '2026-09-22T00:00:00Z', updatedAt: '2026-09-23T00:00:00Z',
  threads: [{ key: 'github:42', source: 'github', title: '#42 Fix login', url: 'https://github.com/acme/widgets/pull/42',
    facts: { number: { value: '#42' }, ci: { label: { zh: 'CI 失败', en: 'CI failed' }, value: '1', problem: true } } }],
} satisfies TicketFields
export const ticketSummary = (fields: Partial<TicketFields> = {}, stage: TicketStage = { stage: 'working' }): TicketRow =>
  ({ ...TICKET, ...fields, ...stage })
export const threadSummary = (fields: Partial<ThreadRow> = {}): ThreadRow => ({
  key: 'feishu:oc_1:om_root', source: 'feishu', title: '这个文案好奇怪', stage: 'subscribed', latest: undefined, lastAt: '2026-09-23T00:00:00Z',
  createdAt: '2026-09-22T00:00:00Z', subscriptions: 1, tickets: [{ id: 't1', title: '修复回归', state: 'open' }], evaluating: undefined,
  pending: 0, pollError: undefined, url: undefined, facts: { chat: { value: '团队群' } }, ...fields,
})
type TriggerFields = Partial<Omit<TriggerRow, 'disposition' | 'actions'>> & { disposition?: Partial<TriggerRow['disposition']> }
/** Build a trigger row on the default thread and compute `actions.requeue` using the host's eligibility rules. */
export function trigger(id: string, at: string, { disposition, ...fields }: TriggerFields = {}): TriggerRow {
  const row = { id, source: 'feishu', actor: actor('feishu', MEMBER), human: true, at, text: `message ${id}`, preview: `message ${id}`,
    url: undefined, threads: ['feishu:oc_1:om_root'], ...fields,
    disposition: { queued: false, evaluating: false, delivered: false, filtered: undefined, fanout: [], handbacks: [], decision: undefined,
      ...disposition } }
  return { ...row, actions: { requeue: requeueable(row) } }
}
const requeueable = ({ human, disposition: d }: Pick<TriggerRow, 'human' | 'disposition'>) => human && !d.queued && !d.evaluating
  && (!!d.filtered || d.decision?.outcome === 'unavailable' || d.delivered || (d.fanout.length > 0 && !d.decision))
type SearchItem = ApiResponse<'GET search'>['items'][number]
export function found(id: string, at: string, { threadTitle, filtered,
  ...fields }: TriggerFields & { threadTitle?: string; filtered?: string } = {}): SearchItem {
  const { text: _text, ...result } = trigger(id, at, fields)
  return filtered === undefined ? { ...result, threadTitle } : { ...result, threadTitle: undefined, filtered }
}
export const promptVersion = (revision: number, config: PromptsView['current']['config']): PromptsView['current'] =>
  ({ revision, previousRevision: revision ? revision - 1 : null, savedAt: '', source: 'panel', config })
/** Build a dropped outbound reply fixture (`feishu` replies to `oc_1`/`om_root`; `github` comments on PR #42). */
export const droppedReply = (id: string, hoursAgo: number, source: 'feishu' | 'github', reason: DroppedReply['dropped']['reason'],
  { ticket, thread }: { ticket?: DroppedReply['ticket']; thread?: false } = {}): DroppedReply => ({
  id, preview: `Reply ${id}`, kind: 'reply',
  channel: source === 'feishu' ? feishuChannel('oc_1', 'om_root') : githubChannel(42),
  dropped: { at: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(), reason }, ...ticket ? { ticket } : {},
  ...thread === false ? {} : { thread: source === 'feishu' ? 'feishu:oc_1:om_root' : 'github:42' },
})
const dayAgo = () => new Date(Date.now() - 86_400_000).toISOString()
export const problemOf = (code: SetupCode, values: Record<string, string> = {}) => new SetupError(code, values).problem
// The kinds' configurations differ, and the fake reads them only as the records the views carry.
const qqLabel = (zh: string, en: string) => ({ zh, en })
const qqFields: FieldSpec[] = [
  { key: 'connection', type: 'select', label: qqLabel('连接方式', 'Connection'), options: [
    { value: 'forward', label: qqLabel('正向 WebSocket', 'Forward WebSocket') },
    { value: 'reverse', label: qqLabel('反向 WebSocket', 'Reverse WebSocket') }] },
  { key: 'url', type: 'text', label: qqLabel('OneBot WebSocket 地址', 'OneBot WebSocket URL') },
  { key: 'privateMessages', type: 'switch', label: qqLabel('接收已授权账号的私聊', 'Receive authorized private messages') },
  { key: 'groups', type: 'rows', label: qqLabel('接收的 QQ 群', 'Allowed groups'), columns: [
    { key: 'id', type: 'text', label: qqLabel('群号', 'Group ID') }, { key: 'name', type: 'text', optional: true, label: qqLabel('名称', 'Name') }] },
  { key: 'commandPrefix', type: 'text', label: qqLabel('交办命令前缀', 'Command prefix') },
  { key: 'sessionMinutes', type: 'number', label: qqLabel('会话窗口 / 分钟', 'Session window / minutes'), min: 1, max: 1440 },
  { key: 'groupFollowups', type: 'select', label: qqLabel('群聊追问关联', 'Group follow-ups'), options: [
    { value: 'reply', label: qqLabel('引用回复原消息', 'Quoted replies') },
    { value: 'sender-window', label: qqLabel('同一发送者的会话窗口', 'Sender session window') }] },
  { key: 'replyChunkSize', type: 'number', label: qqLabel('每段回复字符数', 'Reply chunk characters'), min: 200, max: 4000 },
  { key: 'maxReplyChunks', type: 'number', label: qqLabel('每条回复最多分段数', 'Maximum reply chunks'), min: 1, max: 50 },
]
const qqKind = { kind: 'qq', title: qqLabel('QQ · OneBot v11', 'QQ · OneBot v11'), description: qqLabel('NapCat / SnowLuma OneBot v11', 'NapCat / SnowLuma OneBot v11'),
  schema: QqConfigSchema, health: ['qq'], fields: qqFields } as unknown as SourceKind
const KINDS = [feishuKind, githubKind, qqKind] as unknown as SourceKind[]
export const MACHINE = { stateDir: '/srv/dsh-superagent', promptMaxChars: 100000, admissionContextMaxPages: 10,
  admissionContextTimeoutMs: 15000 }

type Settings = ReturnType<typeof SettingsSchema.parse>
export interface PanelServer {
  models: ApiResponse<'GET models'>
  joined?: Record<string, string>; joining?: Record<string, string>
  joinError?: string
  settings: Settings; revisions: Record<string, number>
  prompts: PromptsView
  tickets: { open: TicketRow[]; ended: TicketRow[] }; ticketDetails: Record<string, TicketPageView>
  ticketDelay?: Promise<void>
  schedules: ApiResponse<'GET schedules'>
  decisions: ApiResponse<'GET decisions'>['items']
  decisionDelay?: Promise<void>
  threads: ThreadRow[]
  threadPages: (key: string, query: { before?: string; around?: string }) => ThreadPageView | undefined
  person: TicketRow[]; search: Pick<ApiResponse<'GET search'>, 'items' | 'threads'>; history: HistoryView
  requests: { path: string; method: string; body?: unknown }[]
  /** Requests with undeclared query params or invalid body presence; asserted empty after each test. */
  misuse: string[]
  queued: Set<string>
  searching?: (query: string) => Promise<void>
  setup: SetupView
  health: Record<string, Health>
  /** When true, all API requests return an empty 404 to simulate the host plugin being stopped. */
  down: boolean
  /** Count of responses not yet consumed by the client. */
  pending: number
  form?: ConfigForm<Record<string, unknown>> | undefined
  opened: string[]
  dropped: DroppedReply[]
  failing: Extract<Problem, { kind: 'outgoing' }>['outgoing'][]
  webTasks: { items: ApiResponse<'GET web/tasks'>['items']; records: Record<string, ApiResponse<'GET web/tasks/:id'>> }
  rooms: { items: TaskRoomSummary[]; views: Record<string, TaskRoomView>; activities: Record<string, RoomActivity> }
  roomMessageError?: string
  qqStatus: ApiResponse<'GET qq/status'>
  qqToken?: string
  qqTokenError?: string
  personal: PersonalDashboard
  personalRecords: { [K in PersonalKind]: PersonalRecordMap[K][] }
}
export let server: PanelServer

function resolved() {
  const accounts = server.setup.accounts
  return accounts ? testDeployment({ repository: accounts.repository, github: { cli: '/bin/false', login: accounts.agent, noreply: '' },
    ...accounts.feishu ? { feishu: { cli: '/bin/false', ...accounts.feishu } } : { feishu: undefined } }) : undefined
}
/** Default source health: paused during setup; Feishu defaults to `socket closed` unless overridden or paused by setup. */
function healthOf(name: string): Health {
  if (server.setup.problem) return { state: 'paused', detail: 'Waiting for setup', code: 'setupPending' }
  if (server.health[name]) return server.health[name]
  if (name !== 'feishu') return { state: 'ready', detail: '' }
  return server.setup.feishuProblem ? { state: 'paused', detail: server.setup.feishuProblem.detail } : { state: 'error',
    detail: 'socket closed' }
}
const problemOf_ = (id: string) => [server.setup.problem, server.setup.feishuProblem].find(item => item?.place === id) ?? undefined
function sourceSettings(): SourceView[] {
  return KINDS.map(kind => {
    const config = kind.schema.parse(server.settings.sources[kind.kind]?.config ?? {})
    const problem = problemOf_(kind.kind)
    const { admission: _admission, ...part } = server.settings.policy.sources[kind.kind] ?? { allowed: [], admission: {} }
    const sync = kind.policy?.sync && { label: kind.policy.sync.label, ready: kind.policy.sync.ready(kind.policy.schema.parse(part)),
      health: server.health[`sync:${kind.kind}`] }
    const policy = kind.policy && { fields: kind.policy.fields, explicit: kind.policy.explicit, ...kind.policy.rows
      ? { rows: kind.policy.rows(config) } : {}, ...sync ? { sync } : {} }
    return { id: kind.kind, kind: kind.kind, title: kind.title, description: kind.description, installed: true,
      value: { enabled: server.settings.sources[kind.kind]?.enabled ?? true, config },
        revision: server.revisions[`source:${kind.kind}`] ?? 0,
      restarts: SETUP_FIELDS[kind.kind] ?? [], fields: kind.fields, facts: kind.facts?.(resolved()) ?? {},
      labels: kind.kind === 'feishu' ? { oc_team: '团队群', oc_other: '另一个群', ...server.joined } : {}, ...problem ? { problem } : {},
      ...policy ? { policy } : {} }
  })
}
function sourceStatuses(): SourceStatusRow[] {
  return KINDS.map(kind => {
    const enabled = server.settings.sources[kind.kind]?.enabled ?? true
    const health = kind.health.map(name => ({ name, ...healthOf(name) }))
    const problem = problemOf_(kind.kind)
    const state = !enabled ? 'off' : problem || health.some(item => item.state === 'error') ? 'error' : server.setup.problem ? 'setup'
      : health.some(item => item.state === 'starting') ? 'starting' : health.some(item => item.state === 'paused') ? 'paused' : 'ready'
    const feishu = kind.kind === 'feishu'
    return { id: kind.kind, title: kind.title, installed: true, enabled, state, health, ...problem ? { problem } : {},
      stats: { received: feishu ? 12 : 0, filtered: feishu ? 2 : 0, lastAt: '2026-09-23T00:00:00Z' },
      filtered: feishu ? [] : [{ id: 'e9', at: '2026-09-23T00:02:00Z', actor: actor('github', 'someone'), preview: 'looks wrong',
        reason: { code: 'source_disabled' } }],
      dropped: server.dropped.filter(item => item.channel.source === kind.kind && item.dropped.at >= dayAgo()) }
  })
}
const stateView = (): StateView => ({
  setup: server.setup, load: { running: server.setup.problem ? 0 : 2, queued: 0, maxWorkers: server.settings.executor.maxWorkers },
  mode: server.setup.machine.mode ?? 'repository', masterReady: !server.setup.problem, masterId: 'master', paused: server.settings.paused,
  // The panel does not read health; the service script does.
  health: {},
})
const settingsView = (): ApiResponse<'GET settings'> => ({
  policyVersion: 'abcdef1234567890',
  blocks: { policy: { value: server.settings.policy, revision: server.revisions.policy ?? 0 },
    eval: { value: server.settings.eval, revision: server.revisions.eval ?? 0 },
    executor: { value: server.settings.executor, revision: server.revisions.executor ?? 0 } },
  sources: sourceSettings(),
  environment: { root: '/srv/dsh-superagent/work', variables: [
    { owner: 'executor', enabled: true, variables: [{ key: 'DSH_SUPERAGENT_DIR', description: { zh: '工单的执行目录',
      en: 'The ticket directory' } },
      { key: 'DSH_SUPERAGENT_NAME', description: { zh: '工单短名', en: 'Short name' } }] },
    { owner: 'github', enabled: false, variables: [{ key: 'DSH_SUPERAGENT_GITHUB_REPOSITORY', description: { zh: '仓库',
      en: 'Repository' } }] }] },
})
const overviewView = (): ApiResponse<'GET overview'> => {
  const { problem, feishuProblem } = server.setup
  const setup = problem ?? feishuProblem
  return {
    problems: [...setup ? [{ kind: 'setup' as const, ...setup }] : [],
      ...KINDS.some(kind => server.settings.sources[kind.kind]?.enabled !== false) ? [] : [{ kind: 'no-source' as const }],
      ...feishuProblem || server.settings.sources.feishu?.enabled === false ? [] : [{ kind: 'source-error' as const, source: { id: 'feishu',
        title: { zh: '飞书', en: 'Feishu' },
        health: { name: 'feishu', state: 'error' as const, detail: 'socket closed' } } }],
      ...server.threads.filter(thread => thread.evaluating && thread.evaluating.deadline < new Date().toISOString())
        .map(thread => ({ kind: 'eval-overdue' as const, thread })),
      { kind: 'eval-unavailable' as const, decisionId: 'u1', thread: threadSummary(), reason: [{ code: 'timeout' }], triggerId: 'e3' },
      ...server.settings.paused ? [{ kind: 'executor-paused' as const }] : [],
      // As on the host, every entry in error that is not a Source's own, a Policy sync, or the individually listed unavailable Evals is a runtime-error.
      ...Object.entries(server.health).filter(([name, item]) => item.state === 'error' && !KINDS.some(kind => kind.health.includes(name))
        && !name.startsWith('sync:') && name !== 'evals')
        .map(([name, item]) => ({ kind: 'runtime-error' as const, name, detail: item.detail })),
      ...Object.values(server.settings.policy.sources).some(part => part.allowed.length) ? [] : [{ kind: 'no-allowed' as const }],
      ...server.failing.map(outgoing => ({ kind: 'outgoing' as const, outgoing }))],
    person: server.person, executor: { running: 2, queued: 0, maxWorkers: server.settings.executor.maxWorkers, idle: 1 },
    flow: { received: 12, filtered: 2, triggers: 10, judged: 5, accepted: 1, evaluating: 0,
      dropped: server.dropped.filter(item => item.dropped.at >= dayAgo()).length },
    policyVersion: 'abcdef1234567890',
  }
}
export const acceptDecision = (): NonNullable<TicketPageView['decision']> => ({ id: 'd1', kind: 'accept', outcome: 'accept',
  reason: [{ code: 'explicitRouted' }], at: '2026-09-22T00:00:00Z', strength: 'explicit', ticketId: undefined,
  triggerIds: ['e1'], thread: 'feishu:oc_1:om_root', rules: [], preview: '@bot 修一下', ticketTitle: undefined })
const ticketDetail = (): TicketPageView => ({
  ...ticketSummary(), paused: false, decision: acceptDecision(), threads: [threadSummary()],
  mandate: { strength: 'explicit', policyVersion: 'abcdef1234567890', basis: { via: 'addressed', sender: 'Alice', addressed: 'mention' },
    actor: actor('feishu', MEMBER), scope: '修复登录页回归' },
  basis: { facts: [{ name: 'sender', value: 'Alice' }, { name: 'addressed', value: 'mention' }], legacy: false },
  environment: [{ key: 'DSH_SUPERAGENT_DIR', value: '/w/t1', description: { zh: '执行目录', en: 'Directory' }, owner: 'executor' },
    { key: 'DSH_SUPERAGENT_GITHUB_NUMBER', value: '', description: { zh: '编号', en: 'Number' }, owner: 'github' }],
  channels: [{ source: 'feishu', url: 'https://applink.feishu.cn/client/chat/open?openChatId=oc_1', label: { zh: '飞书消息',
    en: 'Feishu message' } },
    { source: 'github', url: 'https://github.com/acme/widgets/issues/42', label: { zh: 'GitHub #42', en: 'GitHub #42' } }],
  assignments: [{ id: 'a1', state: 'running', createdAt: '2026-09-22T00:00:00Z',
    startedAt: '2026-09-22T00:01:00Z',
    report: { state: 'progress', summary: 'working', at: '2026-09-22T00:02:00Z' } }],
  inputs: [{ id: 'i1', kind: 'trigger', triggerId: 'e2', at: '2026-09-22T00:03:00Z', delivered: false,
    trigger: { id: 'e2', actor: actor('feishu', MEMBER), human: true, preview: '顺便改标题', thread: 'feishu:oc_1:om_root' } },
  { id: 'i2', kind: 'policy-changed', at: '2026-09-22T00:04:00Z', delivered: true, from: 'aaaaaaaaaaaaaaaa', to: 'bbbbbbbbbbbbbbbb' }],
})
function threadPage(key: string, { before, around }: { before?: string; around?: string }): ThreadPageView | undefined {
  if (key !== threadSummary().key) return undefined
  const base = { ...threadSummary(), tickets: [ticketSummary()], correlated: [{ key: 'github:42', title: 'PR 42' }], decisions: [],
    url: 'https://example.test/thread', context: [] }
  const decision = { id: 'd1', outcome: 'accept' as const, reason: [{ code: 'said', values: { text: 'x' } }], ticketId: 't1' }
  if (before === 'cursor-1' || around === 'e1') return { ...base, timeline: [trigger('e1', '2026-09-20T00:00:00Z',
    { disposition: { decision } })], earlier: null }
  return { ...base, earlier: 'cursor-1', timeline: [trigger('e3', '2026-09-23T00:00:00Z', { disposition: { fanout: ['t1'] } }),
    trigger('e4', '2026-09-23T00:01:00Z', { disposition: { filtered: { code: 'not_a_member' } } })] }
}
function initial(): PanelServer {
  const settings = SettingsSchema.parse({
    policy: { sources: { feishu: { allowed: [{ id: 'ou_alice', name: 'Alice' }], syncChat: 'oc_team' },
      github: { allowed: [{ id: 'alice' }] }, qq: { allowed: [] } },
      rules: [{ id: 'copy', name: '文案修改', enabled: true, instruction: '修正明确的文案错误' }] },
    sources: { feishu: { enabled: true, config: { cli: 'lark-bot', chats: [{ chatId: 'oc_team', listen: 'mentions' }],
      directMessages: true } },
      github: { enabled: true, config: { repository: 'acme/widgets', cli: 'gh-agent' } }, qq: { enabled: false, config: {} } },
    executor: { blockedCommands: ['gh-personal'] },
  })
  const ended = ticketSummary({ id: 't0', title: '旧工单', state: 'ended', actions: { retry: false, stop: false },
    ended: { at: '2026-09-21T00:00:00Z', by: 'human', reason: 'Human asked to stop', outcome: 'stopped' } }, { stage: 'ended' })
  const reply = { source: 'feishu', url: 'https://applink.feishu.cn/client/chat/open?openChatId=oc_1', label: { zh: '飞书消息',
    en: 'Feishu message' } }
  const defaults = { revision: 0, previousRevision: null, savedAt: '', source: 'defaults' }
  return {
    health: {}, down: false, pending: 0, opened: [], requests: [], misuse: [], queued: new Set(), dropped: [], failing: [],
    models: { default: { provider: 'host', model: 'default' }, routableProviders: ['worker-provider'], failures: [],
      groups: [{ id: 'worker-provider', name: 'Worker provider', models: [{ id: 'worker-model', name: 'Worker model',
        reasoning: { efforts: [{ id: 'high', name: 'High' }] } }] }] },
    setup: { machine: { ...MACHINE, mode: 'repository' }, problem: null, feishuProblem: null,
      accounts: { repository: 'acme/widgets', agent: 'agent-bot', feishu: { appId: 'cli_bot', brand: 'feishu', botId: 'ou_bot',
        name: 'Widgets Bot' } } },
    personal: { settings: { enabled: true, timezone: 'Asia/Shanghai', ownerActors: ['web:owner'], quietStart: '22:00', quietEnd: '08:00', digestMinutes: 60, revision: 1 },
      counts: { goal: 1, commitment: 0, fact: 1, constraint: 0, attention: 0, authorization: 1, action: 1 }, followups: [] },
    personalRecords: {
      goal: [{ id: 'goal-demo', revision: 0, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', sourceRefs: [],
        title: '整理每周计划', priority: 60, successCriteria: ['每周日回顾'], status: 'active' }],
      commitment: [], fact: [{ id: 'fact-candidate', revision: 0, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z',
        sourceRefs: ['trigger/source-note'], subject: '工作时间', predicate: '偏好', value: '上午', confidence: 0.7, confirmation: 'inferred', status: 'candidate' }],
      constraint: [], attention: [],
      authorization: [{ id: 'auth-demo', revision: 0, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z',
        sourceRefs: [], ticketId: 't1', risk: 'L2', scope: ['calendar.write'], status: 'requested', requestHash: 'a'.repeat(64) }],
      action: [{ id: 'action-demo', revision: 0, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', sourceRefs: [],
        ticketId: 't1', authorizationId: 'auth-demo', idempotencyKey: 'demo', action: 'calendar.create', target: 'Alice · 2026-11-08 10:00',
        requestHash: 'a'.repeat(64), payload: { text: '周日 10:00 在上海时区创建“周计划回顾”，邀请 Alice。' }, status: 'prepared' }],
    },
    settings, revisions: { policy: 3, eval: 1, executor: 0 }, webTasks: { items: [], records: {} },
    rooms: (() => {
      const key = 'web:demo'
      const workers = [
        { id: 'worker-alpha-1234', title: '前端 Worker', stage: 'working', summary: '正在更新页面', sessionId: 'session-a', active: true, subscribed: true },
        { id: 'worker-beta-5678', title: '测试 Worker', stage: 'waiting', summary: '等待反馈', sessionId: 'session-b', active: true, subscribed: true },
        { id: 'worker-stopped', title: '已停止 Worker', stage: 'ended', summary: '', sessionId: 'session-c', active: false, subscribed: true },
        { id: 'worker-unsubscribed', title: '未订阅 Worker', stage: 'working', summary: '', sessionId: 'session-d', active: true, subscribed: false },
      ]
      const messages: RoomMessage[] = [
        { id: 'room-m1', at: '2026-11-01T10:00:00Z', kind: 'user', actor: { role: 'user', name: 'Alice' }, text: '请处理任务', audience: 'router' },
        { id: 'room-m2', at: '2026-11-01T10:01:00Z', kind: 'collaboration', actor: { role: 'worker', name: '前端 Worker', ticketId: workers[0]!.id }, text: '页面结构已更新', audience: 'thread' },
        { id: 'room-m3', at: '2026-11-01T10:02:00Z', kind: 'system', actor: { role: 'worker', name: '前端 Worker', ticketId: workers[0]!.id }, text: '运行命令：pnpm test', audience: 'record', ticketId: workers[0]!.id, details: 'PASS 3 tests' },
        { id: 'room-m4', at: '2026-11-01T10:03:00Z', kind: 'assignment', actor: { role: 'router', name: 'Router' }, text: 'Worker 职责：修复前端显示问题', audience: 'worker', recipient: workers[0]!.id, ticketId: workers[0]!.id, details: '仅处理面板样式与交互。' },
        { id: 'room-m5', at: '2026-11-01T10:04:00Z', kind: 'report', actor: { role: 'worker', name: '质量验证 Worker', ticketId: workers[1]!.id },
          text: '验证报告已交付。', audience: 'router', ticketId: workers[1]!.id,
          artifacts: [{ id: 'room-report-a', name: '任务群验收结果.zip', size: 2048 }] },
      ]
      const view: TaskRoomView = { key, title: '改进任务面板', source: 'web', updatedAt: messages.at(-1)!.at, workers, pending: false,
        messages, earlier: null, writable: true, paused: false }
      return { items: [view], views: { [key]: view }, activities: { [workers[0]!.id]: { items: [
        { id: 'activity-1', type: 'tool', text: 'pnpm test\nPASS 3 tests' },
      ], next_offset: null } } }
    })(),
    qqStatus: { enabled: false, mode: 'forward', state: 'disabled', detail: 'QQ 来源已关闭。', forwardUrl: 'ws://127.0.0.1:3001',
      reverseUrl: 'ws://127.0.0.1:6199/onebot/v11/ws', tokenConfigured: false, allowedUsers: 0, groups: 0, received: 0 },
    prompts: { masterId: 'master', sections: TEAM_SECTIONS, skillName: SKILL_NAME.source, builtin: ['feishu', 'github'],
      skillPrefix: SKILL_PREFIX, revision: 0, current: { ...defaults, config: defaultPrompts() },
      defaults: defaultPrompts(), parts: Object.entries(builtInParts()).map(([key, part]) => ({ key, ...part, base: builtInBase(part.text) })),
      defaultChanged: [], revisions: [{ ...defaults, changed: [] }], sessions: [], failures: [], notificationPending: false, next_offset: null },
    tickets: { open: [ticketSummary()], ended: [ended] }, ticketDetails: { t1: ticketDetail() }, decisions: [acceptDecision()],
    schedules: { revision: 1, items: [{ id: 'schedule-1', revision: 1, config: { name: '邮箱检查', enabled: true,
      program: 'C:\\Python\\python.exe', args: ['mail_check.py', '--quiet'], cwd: 'C:\\mail-check', intervalSeconds: 300,
      timeoutSeconds: 120 }, nextRunAt: '2026-11-02T00:00:00.000Z', lastRun: { status: 'success', startedAt: '2026-11-01T00:00:00.000Z',
      finishedAt: '2026-11-01T00:00:03.000Z', exitCode: 0 }, running: false }] },
    threads: [threadSummary()], threadPages: threadPage,
    person: [ticketSummary({ attention: { id: 'q1', question: '需要确认按钮颜色' }, note: { text: '需要确认按钮颜色', error: false }, reply },
      { stage: 'person', action: 'answer' }),
      ticketSummary({ id: 't4', title: '截图工具', actions: { retry: true, stop: true }, sessionId: 'worker-t4',
        summary: 'LlmError: no adapter registered for provider "provider-a"',
        note: { text: 'LlmError: no adapter registered for provider "provider-a"', error: true } }, { stage: 'person', action: 'failed' })],
    search: { items: [], threads: [] },
    history: { current: 3, policyVersion: 'abcdef1234567890', items: [
      { revision: 4, savedAt: '2026-09-23T00:00:00Z', source: 'panel', policyVersion: '9876543210fedcba', policyChanged: true, notified: [],
        block: 'source:feishu',
        changes: [{ code: 'sourceRowsAdded', source: 'feishu', field: 'chats', items: ['oc_team'] }] },
      { revision: 3, savedAt: '2026-09-22T00:00:00Z', source: 'panel', policyVersion: 'abcdef1234567890', policyChanged: true,
        notified: [{ id: 't1', title: '修复回归' }], block: 'policy',
        changes: [{ code: 'mode', from: 'off', to: 'observe' }, { code: 'sourceField', source: 'feishu', field: 'directMessages',
          from: true, to: false },
          { code: 'sourceRowsAdded', source: 'feishu', field: 'chats', items: ['oc_other', 'oc_new'] }] }] },
  }
}

/** A refusal response carrying the host's HTTP status code and JSON error body. Returned by route handlers when a request is rejected. */
class Refusal { constructor(readonly status: 400 | 404 | 409 | 500, readonly body: Record<string, unknown>) {} }
const refuse = (status: Refusal['status'], error: string, more: Record<string, unknown> = {}) => new Refusal(status, { error, ...more })
type Query<K extends keyof Api> = Api[K] extends { query?: infer Q } ? keyof NonNullable<Q> & string : never
type Body<K extends keyof Api> = Api[K] extends { body: infer B } ? B : undefined
interface Request<K extends keyof Api> { params: RouteParams<K>; query: Partial<Record<Query<K>, string>>; body: Body<K> }
type Answer<K extends keyof Api> = ApiResponse<K> | Refusal
type Route<K extends keyof Api> = { query?: readonly Query<K>[]; answer: (request: Request<K>) => Answer<K> | Promise<Answer<K>> }
  & (Api[K] extends { body: unknown } ? { body: true } : { body?: never })
const page = <T>(items: T[], offset = 0, limit = 50) => ({ items: items.slice(offset, offset + limit), total: items.length,
  next_offset: offset + limit < items.length ? offset + limit : null })
const ticketOf = (id: string) =>
  [...server.tickets.open, ...server.person, ...server.tickets.ended].find(ticket => ticket.id === id) ?? server.ticketDetails[id]
const SourceSave = z.object({ enabled: z.boolean(), config: z.unknown() })

const ROUTES: { [K in keyof Api]: Route<K> } = {
  'GET personal': { answer: () => server.personal },
  'PUT personal/settings': { body: true, answer: ({ body }) => {
    if (body.revision !== server.personal.settings.revision) return refuse(409, '设置已在别处修改。')
    server.personal.settings = { ...body.value, revision: body.revision + 1 }; return server.personal.settings
  } },
  'GET personal/records/:kind': { query: ['offset', 'limit', 'status', 'ticketId'], answer: ({ params, query }) => {
    const kind = params.kind as PersonalKind
    const rows = server.personalRecords[kind].filter(item => (!query.status || item.status === query.status)
      && (!query.ticketId || ('ticketId' in item && item.ticketId === query.ticketId)))
    const offset = Number(query.offset ?? 0), limit = Number(query.limit ?? 50)
    return { items: rows.slice(offset, offset + limit), next_offset: offset + limit < rows.length ? offset + limit : null }
  } },
  'PUT personal/records/:kind/:id': { body: true, answer: ({ params, body }) => {
    const kind = params.kind as PersonalKind, rows = server.personalRecords[kind]
    if (Object.keys(body.value).some(field => ['id', 'revision', 'createdAt', 'updatedAt', 'sourceRefs'].includes(field))) {
      return refuse(400, '身份、来源和版本由服务端保存。')
    }
    const index = rows.findIndex(item => item.id === params.id)
    if (index >= 0 && rows[index]!.revision !== body.revision) return refuse(409, '记录版本冲突。')
    const at = new Date().toISOString(), prior = rows[index]
    const item = { ...prior, ...body.value, id: params.id, revision: (prior?.revision ?? -1) + 1,
      createdAt: prior?.createdAt ?? at, updatedAt: at, sourceRefs: prior?.sourceRefs ?? [] } as PersonalRecord
    const save = <K extends PersonalKind>(records: PersonalRecordMap[K][], value: PersonalRecordMap[K]) => {
      if (index < 0) records.unshift(value); else records[index] = value
    }
    switch (kind) {
      case 'goal': save(server.personalRecords.goal, item as PersonalRecordMap['goal']); break
      case 'commitment': save(server.personalRecords.commitment, item as PersonalRecordMap['commitment']); break
      case 'fact': save(server.personalRecords.fact, item as PersonalRecordMap['fact']); break
      case 'constraint': save(server.personalRecords.constraint, item as PersonalRecordMap['constraint']); break
      case 'attention': save(server.personalRecords.attention, item as PersonalRecordMap['attention']); break
      case 'authorization': save(server.personalRecords.authorization, item as PersonalRecordMap['authorization']); break
      case 'action': save(server.personalRecords.action, item as PersonalRecordMap['action']); break
    }
    return { item }
  } },
  'DELETE personal/records/:kind/:id': { body: true, answer: ({ params, body }) => {
    const rows = server.personalRecords[params.kind as PersonalKind], index = rows.findIndex(item => item.id === params.id)
    if (index >= 0 && rows[index]!.revision !== body.revision) return refuse(409, '记录版本冲突。')
    if (index >= 0) rows.splice(index, 1)
    return { removed: true }
  } },
  'GET personal/records/:kind/:id/history': { answer: () => ({ items: [] }) },
  'POST personal/attention/:id/acknowledge': { answer: ({ params }) => {
    const rows = server.personalRecords.attention, item = rows.find(row => row.id === params.id)
    if (!item) return refuse(404, '待确认事项不存在。')
    const updated = { ...item, status: 'acknowledged' as const, revision: item.revision + 1, updatedAt: new Date().toISOString() }
    rows[rows.indexOf(item)] = updated; return { item: updated }
  } },
  'POST personal/authorizations/:id/grant': { body: true, answer: ({ params, body }) => {
    const rows = server.personalRecords.authorization, item = rows.find(row => row.id === params.id)
    if (!item || item.requestHash !== body.requestHash || item.revision !== body.revision) return refuse(409, '授权内容已变化。')
    const updated = { ...item, status: 'granted' as const, ...(body.expiresAt ? { expiresAt: body.expiresAt } : {}), revision: item.revision + 1, updatedAt: new Date().toISOString() }
    rows[rows.indexOf(item)] = updated; return { item: updated }
  } },
  'GET personal/authorizations/:id/request': { answer: ({ params }) => {
    const authorization = server.personalRecords.authorization.find(item => item.id === params.id)
    const action = server.personalRecords.action.find(item => item.authorizationId === params.id)
    if (!authorization || !action) return refuse(404, '授权请求或行动记录不存在。')
    return { authorization, action }
  } },
  'POST personal/authorizations/:id/revoke': { body: true, answer: ({ params, body }) => {
    const rows = server.personalRecords.authorization, item = rows.find(row => row.id === params.id)
    if (!item || item.requestHash !== body.requestHash || item.revision !== body.revision) return refuse(409, '授权内容已变化。')
    const updated = { ...item, status: 'revoked' as const, revision: item.revision + 1, updatedAt: new Date().toISOString() }
    rows[rows.indexOf(item)] = updated; return { item: updated }
  } },
  'POST personal/actions/:id/execute': { answer: ({ params }) => {
    const rows = server.personalRecords.action, item = rows.find(row => row.id === params.id)
    if (!item) return refuse(404, '行动不存在。')
    const updated = { ...item, status: 'verified' as const, verifiedAt: new Date().toISOString(), revision: item.revision + 1 }
    rows[rows.indexOf(item)] = updated; return { item: updated }
  } },
  'POST personal/followups/:ticketId/:key/cancel': { answer: () => ({ cancelled: true }) },
  'POST personal/conflicts': { body: true, answer: () => ({ items: [] }) },
  'GET rooms': { query: ['offset', 'limit'], answer: ({ query }) => {
    const offset = Number(query.offset ?? 0), limit = Number(query.limit ?? 50), items = server.rooms.items.slice(offset, offset + limit)
    return { items, next_offset: offset + limit < server.rooms.items.length ? offset + limit : null }
  } },
  'GET rooms/:key': { query: ['before', 'limit'], answer: ({ params, query }) => {
    const room = server.rooms.views[params.key]
    if (!room) return refuse(404, '任务群不存在。')
    const limit = Number(query.limit ?? 50)
    if (!query.before) return { ...room, messages: room.messages.slice(-limit), earlier: room.messages.length > limit ? room.messages.at(-limit)?.id ?? null : null }
    const index = room.messages.findIndex(item => item.id === query.before)
    if (index < 0) return { ...room, messages: [], earlier: null }
    const start = Math.max(0, index - limit)
    return { ...room, messages: room.messages.slice(start, index), earlier: start > 0 ? room.messages[start - 1]?.id ?? null : null }
  } },
  'POST rooms/:key/messages': { body: true, answer: ({ params, body }) => {
    const room = server.rooms.views[params.key]
    if (!room) return refuse(404, '任务群不存在。')
    if (server.roomMessageError) return refuse(500, server.roomMessageError)
    const previous = room.messages.find(item => item.id === body.requestId)
    if (previous) return { ...room, messages: room.messages }
    const worker = room.workers.find(item => item.id === body.recipient)
    const message: RoomMessage = { id: body.requestId, at: new Date().toISOString(), kind: 'user', actor: { role: 'user', name: 'Alice' },
      text: body.text, audience: body.recipient ? 'worker' : 'router', recipient: worker?.title ?? body.recipient,
      ...(body.recipient ? { ticketId: body.recipient } : {}) }
    room.messages.push(message); room.updatedAt = message.at
    return { ...room }
  } },
  'GET rooms/:key/workers/:ticketId/activity': { query: ['offset', 'limit'], answer: ({ params, query }) => {
    const data = server.rooms.activities[params.ticketId] ?? { items: [], next_offset: null }
    const offset = Number(query.offset ?? 0), limit = Number(query.limit ?? 50)
    const items = data.items.slice(offset, offset + limit)
    return { items, next_offset: offset + limit < data.items.length ? offset + limit : null }
  } },
  'GET qq/status': { answer: () => ({ ...server.qqStatus, tokenConfigured: !!server.qqToken || server.qqStatus.tokenConfigured }) },
  'PUT qq/token': { body: true, answer: ({ body }) => {
    if (server.qqTokenError) return refuse(500, server.qqTokenError)
    server.qqToken = body.value
    server.qqStatus = { ...server.qqStatus, tokenConfigured: !!body.value }
    return { configured: !!body.value }
  } },
  'GET web/tasks': { query: ['offset', 'limit'], answer: ({ query }) => {
    const offset = Number(query.offset ?? 0), limit = Number(query.limit ?? 50)
    return { items: server.webTasks.items.slice(offset, offset + limit), next_offset: offset + limit < server.webTasks.items.length ? offset + limit : null }
  } },
  'GET web/tasks/:id': { answer: ({ params }) => server.webTasks.records[params.id] ?? refuse(404, '任务对话不存在。') },
  'POST web/tasks': { body: true, answer: ({ body }) => {
    const id = `web-task-${body.requestId}`
    const existing = server.webTasks.records[id]
    if (existing) return existing.messages[0]?.text === body.text ? existing : refuse(409, '这次发送的编号已经用于另一段内容，请重新发送。')
    const at = new Date().toISOString()
    const created = { id, title: body.text.split('\n')[0]!.slice(0, 100), createdAt: at, updatedAt: at, status: 'queued' as const,
      tickets: [], messages: [{ id: `web-message-${body.requestId}`, role: 'user' as const, text: body.text, at }] }
    server.webTasks.records[id] = created
    const { messages: _messages, ...summary } = created
    server.webTasks.items.unshift(summary)
    return created
  } },
  'POST web/tasks/:id/messages': { body: true, answer: ({ params, body }) => {
    const task = server.webTasks.records[params.id]
    if (!task) return refuse(404, '任务对话不存在。')
    const previous = task.messages.find(message => message.id === `web-message-${body.requestId}`)
    if (previous) return previous.text === body.text ? task : refuse(409, '这次发送的编号已经用于另一段内容，请重新发送。')
    const at = new Date().toISOString()
    task.messages.push({ id: `web-message-${body.requestId}`, role: 'user', text: body.text, at }); task.updatedAt = at
    const summary = server.webTasks.items.find(item => item.id === task.id)
    if (summary) summary.updatedAt = at
    return task
  } },
  'GET state': { answer: stateView },
  'GET schedules': { answer: () => server.schedules },
  'POST schedules': { body: true, answer: ({ body }) => {
    const revision = ++server.schedules.revision
    const item = { id: `schedule-${server.schedules.items.length + 2}`, revision: 1, config: body.config,
      nextRunAt: body.config.enabled ? new Date(Date.now() + body.config.intervalSeconds * 1000).toISOString() : null, running: false }
    server.schedules.items.push(item)
    return { item }
  } },
  'PUT schedules/:id': { body: true, answer: ({ params, body }) => {
    const item = server.schedules.items.find(candidate => candidate.id === params.id)
    if (!item) return refuse(404, 'Schedule not found')
    if (item.revision !== body.revision) return refuse(409, 'Schedule changed. Reload before saving.')
    item.revision++; server.schedules.revision++
    item.config = body.config
    item.nextRunAt = body.config.enabled ? new Date(Date.now() + body.config.intervalSeconds * 1000).toISOString() : null
    return { item }
  } },
  'POST schedules/:id/run': { answer: ({ params }) => {
    const item = server.schedules.items.find(candidate => candidate.id === params.id)
    if (!item) return refuse(404, 'Schedule not found')
    const status = server.settings.paused ? 'queued' : 'running'
    item.running = status === 'running'
    item.lastRun = { status: 'running', startedAt: new Date().toISOString() }
    return { status, item }
  } },
  'DELETE schedules/:id': { body: true, answer: ({ params, body }) => {
    const index = server.schedules.items.findIndex(candidate => candidate.id === params.id)
    if (index < 0) return refuse(404, 'Schedule not found')
    if (server.schedules.items[index]!.revision !== body.revision) return refuse(409, 'Schedule changed. Reload before saving.')
    server.schedules.items.splice(index, 1); server.schedules.revision++
    return { removed: true }
  } },
  'GET watchdog/snapshot': { answer: () => ({ schema: 1, observedAt: new Date().toISOString(), infrastructure: { configured: true, paused: false, health: {}, setup: [] },
    executor: { activeWorkers: 0, maxWorkers: 4 }, tickets: [], candidates: [], baseline: { status: 'healthy', findings: [], semanticReview: 'not_configured' } }) },
  'POST watchdog/tickets/:id/request-status': { answer: () => ({ requested: false }) },
  'GET overview': { answer: overviewView },
  'GET search': { query: ['q'], answer: async ({ query }) => {
    const q = query.q ?? ''
    await server.searching?.(q)
    return { tickets: [], threads: server.search.threads, items: server.search.items.filter(item => item.preview.includes(q)) }
  } },
  'GET sources': { answer: sourceStatuses },
  'GET settings': { answer: settingsView },
  'POST sources/:id/labels': { answer: () => {
    // Label refresh failures come from the bot CLI and are returned verbatim.
    if (server.joinError) return refuse(500, server.joinError)
    const added = Object.values(server.joining ?? {}); server.joined = { ...server.joined, ...server.joining }; server.joining = undefined
    return { added }
  } },
  'GET threads': { query: ['filter', 'offset', 'limit'], answer: () => page(server.threads) },
  'GET threads/:key': { query: ['limit', 'before', 'around'], answer: ({ params, query }) => {
    const found = server.threadPages(params.key, query)
    if (!found) return refuse(404, 'Thread not found')
    // A Trigger sent to Eval again is queued and cannot be requeued.
    const queued = (item: TriggerRow) => ({ ...item, disposition: { ...item.disposition, queued: true }, actions: { requeue: false } })
    return { ...found, timeline: found.timeline.map(item => server.queued.has(item.id) ? queued(item) : item) }
  } },
  'POST threads/:key/unsubscribe': { answer: ({ params }) => {
    const removed = server.threads.length > 0
    server.threads = []
    return { removed, thread: params.key, context_delivery: 'injected' }
  } },
  'POST triggers/:id/requeue': { answer: ({ params }) => { server.queued.add(params.id); return { queued: true } } },
  'GET decisions': { query: ['kind', 'window', 'offset', 'limit'], answer: async ({ query }) => {
    const items = query.kind === 'ignore' ? [] : server.decisions
    const selected = page(items, Number(query.offset ?? 0), Number(query.limit ?? 50))
    if (query.kind === 'accept,reopen') await server.decisionDelay
    return selected
  } },
  'POST decisions/:id/dismiss': { answer: ({ params }) => params.id === 'u1' ? { dismissed: true } : refuse(404,
    'Unavailable Eval not found') },
  'GET tickets': { query: ['state', 'offset', 'limit'], answer: async ({ query }) => {
    const result = page(server.tickets[query.state === 'ended' ? 'ended' : 'open'], Number(query.offset ?? 0), Number(query.limit ?? 50))
    await server.ticketDelay
    return result
  } },
  'GET tickets/:id': { answer: ({ params }) => server.ticketDetails[params.id] ?? refuse(404, 'Ticket not found') },
  'POST tickets/:id/retry': { answer: ({ params }) => {
    const ticket = ticketOf(params.id)
    if (!ticket) return refuse(404, 'Ticket not found')
    return ticket.actions.retry ? { retried: true } : refuse(400, 'Only an open ticket can be retried, and only when its worker last reported failed or blocked and no person has sent a message since, or when delivering an Input to its worker failed',
      { code: 'notRetryable', values: {} })
  } },
  'POST tickets/:id/stop': { answer: ({ params }) => {
    if (!ticketOf(params.id)) return refuse(404, 'Ticket not found')
    server.tickets.open = []; server.person = server.person.filter(ticket => ticket.id !== params.id)
    return { stopped: true }
  } },
  'POST executor/pause': { body: true, answer: ({ body }) => {
    server.settings = { ...server.settings, paused: body.paused }
    server.revisions.pause = (server.revisions.pause ?? 0) + 1
    return { paused: body.paused }
  } },
  'PUT settings/:block': { body: true, answer: ({ params: { block }, body }) => {
    const source = block.startsWith('source:') ? KINDS.find(kind => `source:${kind.kind}` === block) : undefined
    if (!['policy', 'eval', 'executor'].includes(block) && !source) return block.startsWith('source:') ? refuse(404, 'Source not found')
      : refuse(400, 'Invalid settings: block')
    if (body.revision !== (server.revisions[block] ?? 0)) return refuse(409, 'Settings changed. Reload before saving.')
    let restarting = false
    if (block === 'policy') server.settings = { ...server.settings, policy: PolicyConfigSchema.parse(body.value) }
    else if (block === 'executor') server.settings = { ...server.settings, executor: ExecutorConfigSchema.parse(body.value) }
    else if (block === 'eval') server.settings = { ...server.settings, eval: EvalConfigSchema.parse(body.value) }
    else if (source) {
      const { enabled, config: value } = SourceSave.parse(body.value)
      const config = source.schema.parse(value)
      // As on the server, a changed CLI that fails its check refuses the save with the setup problem.
      if (config.cli === 'lark-broken') {
        const refused = new SetupError('feishuCliFailed', { output: 'lark-cli: app secret missing' })
        return refuse(400, refused.message, { setup: refused.problem })
      }
      restarting = (config.cli ?? '') !== (server.settings.sources[source.kind]?.config.cli ?? '')
      server.settings = { ...server.settings, sources: { ...server.settings.sources, [source.kind]: { enabled, config } } }
    }
    server.revisions[block] = (server.revisions[block] ?? 0) + 1
    return { restarting, revision: server.revisions[block] }
  } },
  'GET policy/history': { answer: () => server.history },
  'POST policy-sync/:id': { answer: ({ params }) => ({ policy: server.settings.policy.sources[params.id] }) },
  'POST setup/check': { answer: () => ({ restarting: true }) },
  'GET models': { answer: () => server.models },
  'GET prompts': { query: ['revision', 'offset'], answer: () => server.prompts },
  'PUT prompts': { body: true, answer: ({ body }) => {
    const { revision } = server.prompts
    if (body.baseRevision !== revision) return refuse(409,
      `Prompt version changed to ${revision}; compare the latest version before saving`)
    // As the host does: a template keeps its placeholders, and no overrides are stored as none.
    const { overrides = {}, ...config } = body.config as PromptsView['current']['config']
    for (const [part, override] of Object.entries(overrides)) {
      if (!builtInPart(part)) return refuse(400, 'refused', { code: 'unknownPromptPart', values: { part } })
      const missing = (builtInPart(part)?.placeholders ?? []).filter(placeholder => !override.text.includes(placeholder))
      if (missing.length) return refuse(400, 'refused', { code: 'promptPlaceholders', values: { part, placeholders: missing.join(', ') } })
    }
    server.prompts.revision++
    server.prompts.current = promptVersion(server.prompts.revision, Object.keys(overrides).length ? { ...config, overrides } : config)
    return { revision: server.prompts.revision, context_delivery: 'injected' }
  } },
  'POST prompts/preview': { body: true, answer: ({ body }) => {
    const skills = [...server.setup.accounts?.feishu ? ['feishu'] : [], 'github', ...Object.keys(body.skills)].map(name => [name,
      composeSkill(body, name)])
    // The generated parts from their templates, without variables or rules.
    const environment = environmentSection(body, []), policy = policySection(SettingsSchema.parse({ policy: { rules: [] } }), body)
    return { parts: { orchestrator: promptParts(body, 'orchestrator', environment, policy), worker: promptParts(body, 'worker', environment) },
      skills: Object.fromEntries(skills),
      orchestrator: composePrompt(body, 'orchestrator'), worker: composePrompt(body, 'worker'), scope: '' }
  } },
}

function match(method: string, segments: string[]) {
  for (const key of Object.keys(ROUTES) as (keyof Api)[]) {
    const [verb, path] = key.split(' ') as [string, string]
    const pattern = path.split('/')
    if (verb !== method || pattern.length !== segments.length || !pattern.every((part, index) => part.startsWith(':')
      || part === segments[index])) continue
    return { key, params: Object.fromEntries(pattern.flatMap((part, index) => part.startsWith(':') ? [[part.slice(1),
      decodeURIComponent(segments[index]!)]] : [])) }
  }
  return undefined
}
async function run<K extends keyof Api>(key: K, params: Record<string, string>, query: URLSearchParams, body: unknown): Promise<Answer<K>> {
  const route: Route<K> = ROUTES[key]
  const read: readonly string[] = route.query ?? []
  for (const name of query.keys()) if (!read.includes(name)) server.misuse.push(`${key} with the query parameter ${name}`)
  if ((body !== undefined) !== !!route.body) server.misuse.push(`${key} ${body === undefined ? 'without' : 'with'} a body`)
  const values: Partial<Record<Query<K>, string>> = {}
  for (const name of route.query ?? []) { const value = query.get(name); if (value !== null) values[name] = value }
  return route.answer({ params: params as RouteParams<K>, query: values, body: body as Body<K> })
}
/**
 * Response wrapper that increments `server.pending` when constructed and decrements it when `.text()` is consumed.
 * Requests held back by `server.searching` are not constructed until `searching` resolves, so they do not count as pending early.
 */
class Reply extends Response {
  constructor(value: unknown, status: number) { super(JSON.stringify(value), { status,
    headers: { 'content-type': 'application/json' } }); server.pending++ }
  override async text() { server.pending--; return super.text() }
}

export function usePanelServer(cleanup: () => void) {
  beforeEach(() => {
    sessionStorage.clear()
    server = initial()
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      if (server.down) return new Response(null, { status: 404 })
      const address = new URL(url, 'http://127.0.0.1:3082')
      const path = address.pathname.replace('/orchestrator/api/', '')
      const method = init?.method ?? 'GET'
      const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined
      server.requests.push({ path: decodeURIComponent(`${path}${address.search}`), method, ...body === undefined ? {} : { body } })
      const route = match(method, path.split('/'))
      if (!route) return new Reply({ error: 'Unknown operation' }, 404)
      const answer = await run(route.key, route.params, address.searchParams, body)
      return answer instanceof Refusal ? new Reply(answer.body, answer.status) : new Reply(answer, 200)
    }))
  })
  afterEach(() => {
    try { expect(server.misuse).toEqual([]) }
    finally { cleanup(); vi.unstubAllGlobals() }
  })
}

type Ops = Parameters<ConfigForm<Record<string, unknown>>['mutate']>[0]
/** Fake DSH host configuration form that records mutations and optionally applies them to its snapshot. */
export function fakeForm(writable = true, accept = true) {
  const listeners = new Set<() => void>()
  let snapshot: ConfigFormSnapshot<Record<string, unknown>> = { status: 'ready', value: { ...MACHINE }, base: undefined, user: undefined,
    revision: 1, writable }
  const notify = () => { for (const listener of listeners) listener() }
  const mutations: { ops: Ops; revision: number | undefined }[] = []
  const form: ConfigForm<Record<string, unknown>> = {
    getSnapshot: () => snapshot,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    mutate: async (ops, revision) => {
      mutations.push({ ops, revision })
      if (!accept || revision !== snapshot.revision) return false
      const value = { ...snapshot.value }
      for (const op of ops) { if (op.op === 'set') value[op.path[0]!] = op.value; else delete value[op.path[0]!] }
      snapshot = { ...snapshot, value, revision: snapshot.revision! + 1 }
      notify()
      return true
    },
    set: async () => false, unset: async () => false,
  }
  const publish = (patch: Partial<ConfigFormSnapshot<Record<string, unknown>>>) => { snapshot = { ...snapshot, ...patch }; notify() }
  return { form, mutations, publish }
}
