/** Type-only management API contract between the web panel and host routes, imported by the panel without bundling host code. */
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import type { PromptConfig, Prompts } from './prompts.ts'
import type { PromptsView, StateView, TicketPageView } from './http.ts'
import type { HistoryView } from './settings-history.ts'
import type { OverviewView } from './views/overview.ts'
import type { SettingsView } from './views/settings.ts'
import type { SourceStatusView } from './views/sources.ts'
import type { DecisionListView, SearchView, ThreadDetailView, ThreadListView } from './views/threads.ts'
import type { TicketListView } from './views/tickets.ts'
import type { WebTaskSummary, WebTaskView } from './web-tasks.ts'
import type { QqStatus } from './qq-source.ts'
import type { ScheduleConfig, ScheduleItem, ScheduleList } from './schedules.ts'
import type { TaskRoomSummary, TaskRoomView, RoomActivity } from './task-rooms.ts'
import type { WorkerPanelView } from './worker-panel.ts'
import type { PersonalApi } from './personal-http.ts'
import type { WebImage } from './web-attachments.ts'

export const TICKET_FILTERS = ['open', 'person', 'working', 'idle', 'ended'] as const
export const THREAD_FILTERS = ['subscribed', 'evaluating', 'recent', 'all'] as const
export type TicketFilter = typeof TICKET_FILTERS[number]
export type ThreadFilter = typeof THREAD_FILTERS[number]
interface Paged { offset?: number; limit?: number }
/** Whether a context update was already injected into the main Session or is still pending delivery. */
type Delivery = 'injected' | 'pending'
export interface CollaborationMessageBody { text: string; requestId: string; recipient?: string; router?: boolean; mentions?: string[]; attachmentIds?: string[] }

export interface Api extends PersonalApi {
  'GET tickets/:id/requests': { query?: Paged; response: { items: import('./request-views.ts').RequestView[]; next_offset: number | null } }
  'GET routing-review/config': { response: import('./request-review.ts').RequestReviewConfig }
  'PUT routing-review/config': { body: import('./request-review.ts').RequestReviewConfig; response: import('./request-review.ts').RequestReviewConfig }
  'GET routing-review/history': { query?: { triggerId?: string; limit?: number }; response: import('./request-review.ts').RequestReview[] }
  'POST triggers/:id/review': { body: { requestId: string }; response: { reviewId: string | null } }
  'GET environments': { response: { items: ReturnType<import('../remote/client.ts').RemoteEnvironments['list']> } }
  'POST environments': { body: import('../remote/client.ts').RemoteDeviceConfig; response: { registered: true } }
  'POST environments/:id/probe': { response: ReturnType<import('../remote/client.ts').RemoteEnvironments['list']>[number] }
  'GET tickets/:id/environment': { response: { deviceId: string | null; commands: ReturnType<import('../remote/client.ts').RemoteEnvironments['commands']> } }
  'PUT tickets/:id/environment': { body: { deviceId: string }; response: { deviceId: string } }
  'POST tickets/:id/environment/commands/:commandId/cancel': { response: import('../remote/client.ts').RemoteOperationResult }
  'POST tickets/:id/environment/commands/:commandId/resolve': { body: { outcome: 'completed' | 'failed' | 'cancelled'; evidence: string; expectedUpdatedAt?: string };
    response: import('../remote/client.ts').RemoteOperationResult }
  'GET evaluation/summary': { response: import('../evaluation/ledger.ts').EvaluationSummary }
  'POST tickets/:id/feedback': { body: { requestId: string; accepted?: boolean; correct?: boolean; routingCorrection?: boolean }; response: { recorded: true } }
  'GET verification/config': { response: import('./verification.ts').VerificationConfig }
  'PUT verification/config': { body: import('./verification.ts').VerificationConfig; response: import('./verification.ts').VerificationConfig }
  'GET tickets/:id/verification': { response: { acceptance: import('../core/verification.ts').AcceptancePlan | null;
    verification: import('../core/verification.ts').CompletionVerification | null; history: import('./verification.ts').VerificationRecord[] } }
  'PUT tickets/:id/acceptance': { body: { expectedRevision: number; criteria: import('../core/verification.ts').AcceptanceCriterion[] };
    response: { acceptance: import('../core/verification.ts').AcceptancePlan } }
  'POST tickets/:id/verify': { body: { requestId: string }; response: { reviewId: string | null } }
  'POST tickets/:id/resume': { response: { resumed: boolean } }
  'POST watchdog/assess': { body: { expectedHash?: string; offset?: number; maxTickets?: number; candidateAfterMs?: number };
    response: import('./supervision.ts').SupervisionAssessment }
  'GET watchdog/reviews': { query?: { ticketId?: string; limit?: number }; response: ReturnType<import('./supervision.ts').SupervisionService['history']> }
  'GET watchdog/reviews/:id': { response: import('./supervision.ts').SupervisionReview }
  'GET watchdog/config': { response: { mode: 'observe' | 'advise' } }
  'POST watchdog/config': { body: { mode: 'observe' | 'advise' }; response: { mode: 'observe' | 'advise' } }
  'POST watchdog/advice': { body: { reviewId: string; ticketId: string; expectedRevision: string }; response: import('./supervision.ts').SupervisionAdvice }
  'GET qq/observations': { query?: { groupId?: string; offset?: number; limit?: number };
    response: ReturnType<import('./qq-observation.ts').QqObservationBudget['records']> }
  'POST web/tasks/:id/actions': { body: import('./web-tasks.ts').WebTaskActionInput; response: import('./web-tasks.ts').WebTaskActionResult }
  'GET rooms': { query?: Paged; response: { items: TaskRoomSummary[]; next_offset: number | null } }
  'GET rooms/:key': { query?: { before?: string; limit?: number; workerId?: string }; response: TaskRoomView }
  'POST rooms/:key/messages': { body: CollaborationMessageBody; response: TaskRoomView }
  'GET rooms/:key/workers/:ticketId/activity': { query?: Paged; response: RoomActivity }
  'GET sessions/:id/workers': { response: WorkerPanelView }
  'POST sessions/:id/collaboration': { body: CollaborationMessageBody; response: WorkerPanelView }
  'POST web/attachments': { body: { name: string; mediaType: string; data: string; requestId: string }; response: WebImage }
  'GET schedules': { response: ScheduleList }
  'POST schedules': { body: { config: ScheduleConfig }; response: { item: ScheduleItem } }
  'PUT schedules/:id': { body: { revision: number; config: ScheduleConfig }; response: { item: ScheduleItem } }
  'POST schedules/:id/run': { response: { status: 'queued' | 'running'; item: ScheduleItem } }
  'DELETE schedules/:id': { body: { revision: number }; response: { removed: true } }
  'GET qq/status': { response: QqStatus }
  'PUT qq/token': { body: { value: string }; response: { configured: boolean } }
  'GET web/tasks': { query?: Paged; response: { items: WebTaskSummary[]; next_offset: number | null } }
  'GET web/tasks/:id': { response: WebTaskView }
  'POST web/tasks': { body: { text: string; requestId: string; attachmentIds?: string[] }; response: WebTaskView }
  'POST web/tasks/:id/messages': { body: { text: string; requestId: string; attachmentIds?: string[] }; response: WebTaskView }
  'GET state': { response: StateView }
  /** Bounded diagnostic projection for the external Watchdog process; contains no source message bodies or environment values. */
  'GET watchdog/snapshot': { query?: { offset?: number; limit?: number; candidateAfterMs?: number };
    response: import('./watchdog.ts').WatchdogSnapshot & { baseline: ReturnType<typeof import('./watchdog.ts').baselineAssessment> } }
  /** Ask an explicitly waiting worker for a status report; other ticket states are unchanged. */
  'POST watchdog/tickets/:id/request-status': { response: { requested: boolean } }
  'GET overview': { response: OverviewView }
  'GET search': { query: { q: string }; response: SearchView }
  'GET sources': { response: SourceStatusView[] }
  'GET settings': { response: SettingsView }
  'POST sources/:id/labels': { response: { added: string[] } }
  'GET threads': { query?: Paged & { filter?: ThreadFilter }; response: ThreadListView }
  'GET threads/:key': { query?: { limit?: number; before?: string; around?: string }; response: ThreadDetailView }
  'POST threads/:key/unsubscribe': { response: { removed: boolean; thread: string; context_delivery: Delivery } }
  'POST triggers/:id/requeue': { response: { queued: boolean } }
  'GET decisions': { query?: Paged & { kind?: string; window?: '24h' }; response: DecisionListView }
  'POST decisions/:id/dismiss': { response: { dismissed: true } }
  'GET tickets': { query?: Paged & { state?: TicketFilter }; response: TicketListView }
  'GET tickets/:id': { response: TicketPageView }
  'POST tickets/:id/retry': { response: { retried: true } }
  'POST tickets/:id/stop': { response: { stopped: true } }
  'POST executor/pause': { body: { paused: boolean }; response: { paused: boolean } }
  'PUT settings/:block': { body: { value: unknown; revision: number }; response: { revision: number; restarting: boolean } }
  'GET policy/history': { response: HistoryView }
  'POST policy-sync/:id': { response: { policy: unknown } }
  'POST setup/check': { response: { restarting: true } }
  'GET models': { response: ModelCatalog }
  'GET prompts': { query?: { revision?: number; offset?: number }; response: PromptsView }
  'PUT prompts': { body: { config: PromptConfig; baseRevision: number }; response: { revision: number; context_delivery: Delivery } }
  'POST prompts/preview': { body: PromptConfig; response: ReturnType<Prompts['preview']> }
}
type Path<K> = K extends `${string} ${infer P}` ? P : never
type Params<P> = P extends `${string}:${infer Name}/${infer Rest}` ? Record<Name, string> & Params<Rest>
  : P extends `${string}:${infer Name}` ? Record<Name, string> : unknown
export type RouteParams<K extends keyof Api> = Params<Path<K>>
export type ApiRequest<K extends keyof Api> = RouteParams<K> & Omit<Api[K], 'response'>
export type ApiResponse<K extends keyof Api> = Api[K]['response']
