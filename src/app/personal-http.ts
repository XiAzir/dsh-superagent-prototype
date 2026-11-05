/** Same-origin owner operations for personal state; included in the existing management router. */
import { z } from 'zod'
import type { Store } from './store.ts'
import { EditablePersonalKinds, PersonalError, PersonalWriteSchema, type PersonalCoordinator } from './personal-coordinator.ts'
import { PersonalSettingsSchema, type PersonalKind, type PersonalRecord, type PersonalSettings, type PersonalRecordMap } from '../core/personal/model.ts'
import type { PersonalHistoryEntry } from './personal-store.ts'
import type { PersonalRuntime } from './personal-runtime.ts'
import type { Followup, Engine } from '../core/index.ts'

export interface PersonalDashboard {
  settings: PersonalSettings
  counts: Record<PersonalKind, number>
  followups: { ticketId: string; title: string; checks: Followup[] }[]
}
export interface PersonalApi {
  'GET personal/authorizations/:id/request': { response: { authorization: PersonalRecordMap['authorization']; action: PersonalRecordMap['action'] } }
  'POST personal/attention/:id/acknowledge': { response: { item: PersonalRecordMap['attention'] } }
  'POST personal/authorizations/:id/grant': { body: { revision: number; requestHash: string; expiresAt?: string }; response: { item: PersonalRecordMap['authorization'] } }
  'POST personal/authorizations/:id/revoke': { body: { revision: number; requestHash: string }; response: { item: PersonalRecordMap['authorization'] } }
  'POST personal/actions/:id/execute': { response: { item: PersonalRecordMap['action'] } }
  'POST personal/followups/:ticketId/:key/cancel': { response: { cancelled: true } }
  'GET personal': { response: PersonalDashboard }
  'PUT personal/settings': { body: { value: PersonalSettings; revision: number }; response: PersonalSettings }
  'GET personal/records/:kind': { query?: { offset?: number; limit?: number; status?: string; ticketId?: string };
    response: { items: PersonalRecord[]; next_offset: number | null } }
  'PUT personal/records/:kind/:id': { body: { value: Record<string, unknown>; revision: number }; response: { item: PersonalRecord } }
  'DELETE personal/records/:kind/:id': { body: { revision: number }; response: { removed: true } }
  'GET personal/records/:kind/:id/history': { response: { items: PersonalHistoryEntry[] } }
  'POST personal/conflicts': { body: { startAt?: string; endAt?: string; amount?: number; currency?: string; scope?: string };
    response: { items: { id: string; title: string; severity: 'soft' | 'hard'; sourceRefs: string[] }[] } }
}
export interface PersonalHttpHost {
  store: Store
  personal?: PersonalCoordinator
  personalRuntime?: PersonalRuntime
  engine?: Pick<Engine, 'cancelFollowup'>
  requestPass(): void
}
const Kind = z.enum(['goal', 'commitment', 'fact', 'constraint', 'attention', 'authorization', 'action'])
const Revision = z.object({ revision: z.number().int().nonnegative() }).strict()
export function personalRoutes(host: PersonalHttpHost) {
  const coordinator = () => {
    if (!host.personal?.host.personalMode()) throw new PersonalError(403, '请在个人模式中使用个人助理。')
    return host.personal
  }
  return {
    'GET personal/authorizations/:id/request': ({ params }: { params: { id: string } }) => {
      const service = coordinator()
      const authorization = host.store.personal.get('authorization', params.id)
      const action = service.all('action').find(item => item.authorizationId === params.id)
      if (!authorization || !action || authorization.requestHash !== action.requestHash) throw new PersonalError(404, '完整行动请求暂不可用。')
      return { authorization, action }
    },
    'POST personal/attention/:id/acknowledge': ({ params }: { params: { id: string } }) => {
      coordinator().requireEnabled(); return { item: host.personalRuntime!.attention.acknowledge(params.id) }
    },
    'POST personal/authorizations/:id/grant': async ({ params, body }: { params: { id: string }; body: () => Promise<unknown> }) => {
      coordinator().requireEnabled()
      const args = z.object({ revision: z.number().int().nonnegative(), requestHash: z.string().length(64), expiresAt: z.string().datetime({ offset: true }).optional() }).strict().parse(await body())
      const auth = host.store.personal.get('authorization', params.id)
      if (!auth) throw new PersonalError(404, '授权请求不存在。')
      coordinator().ownerTicket(auth.ticketId)
      const item = host.personalRuntime!.actions.grant(params.id, { expectedRevision: args.revision, requestHash: args.requestHash,
        grantedBy: 'owner/panel', ...(args.expiresAt ? { expiresAt: args.expiresAt } : {}) })
      host.requestPass(); return { item }
    },
    'POST personal/authorizations/:id/revoke': async ({ params, body }: { params: { id: string }; body: () => Promise<unknown> }) => {
      coordinator().requireEnabled()
      const args = z.object({ revision: z.number().int().nonnegative(), requestHash: z.string().length(64) }).strict().parse(await body())
      const item = host.personalRuntime!.actions.revoke(params.id, { expectedRevision: args.revision, requestHash: args.requestHash })
      host.personalRuntime!.tick(); return { item }
    },
    'POST personal/actions/:id/execute': async ({ params }: { params: { id: string } }) => {
      coordinator().requireEnabled()
      const action = host.store.personal.get('action', params.id)
      if (!action) throw new PersonalError(404, '行动不存在。')
      coordinator().ownerTicket(action.ticketId)
      const item = await host.personalRuntime!.actions.execute(params.id); host.requestPass(); return { item }
    },
    'POST personal/followups/:ticketId/:key/cancel': ({ params }: { params: { ticketId: string; key: string } }) => {
      coordinator().ownerTicket(params.ticketId)
      host.engine!.cancelFollowup(params.ticketId, params.key); host.requestPass(); return { cancelled: true as const }
    },
    'GET personal': (): PersonalDashboard => {
      const service = coordinator()
      return { settings: host.store.personal.settings(),
        counts: Object.fromEntries(Kind.options.map(kind => [kind, service.all(kind).length])) as Record<PersonalKind, number>,
        followups: host.store.tickets.open().flatMap(ticket => {
          const checks = ticket.followups?.filter(item => item.status === 'scheduled') ?? []
          return checks.length ? [{ ticketId: ticket.id, title: ticket.title, checks }] : []
        }) }
    },
    'PUT personal/settings': async ({ body }: { body: (bytes?: number) => Promise<unknown> }) => {
      coordinator()
      const request = z.object({ value: PersonalSettingsSchema, revision: z.number().int().nonnegative() }).strict().parse(await body(16000))
      const result = host.store.personal.configure(request.value, request.revision)
      host.personalRuntime?.tick()
      host.requestPass()
      return result
    },
    'GET personal/records/:kind': ({ params, query }: { params: { kind: string }; query: Record<string, string> }) => {
      const parsed = z.object({ offset: z.coerce.number().int().nonnegative().default(0), limit: z.coerce.number().int().min(1).max(100).default(50),
        status: z.string().optional(), ticketId: z.string().optional() }).strict().parse(query)
      return coordinator().list(Kind.parse(params.kind), parsed)
    },
    'PUT personal/records/:kind/:id': async ({ params, body }: { params: { kind: string; id: string }; body: () => Promise<unknown> }) => {
      const request = PersonalWriteSchema.parse({ ...z.object({ value: z.record(z.string(), z.unknown()), revision: z.number().int().nonnegative() }).strict().parse(await body()), id: params.id })
      const item = coordinator().write(z.enum(EditablePersonalKinds).parse(params.kind), request)
      host.requestPass(); return { item }
    },
    'DELETE personal/records/:kind/:id': async ({ params, body }: { params: { kind: string; id: string }; body: () => Promise<unknown> }) => {
      coordinator().remove(z.enum(EditablePersonalKinds).parse(params.kind), params.id, Revision.parse(await body()).revision)
      return { removed: true as const }
    },
    'GET personal/records/:kind/:id/history': ({ params }: { params: { kind: string; id: string } }) => {
      coordinator(); return { items: host.store.personal.history(Kind.parse(params.kind), params.id) }
    },
    'POST personal/conflicts': async ({ body }: { body: () => Promise<unknown> }) => {
      const service = coordinator(); service.requireEnabled()
      return { items: service.conflicts(await body() as never) }
    },
  }
}
