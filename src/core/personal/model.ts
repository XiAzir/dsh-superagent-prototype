/** Structured, validated records owned by the personal assistant data layer. */
import { z } from 'zod'

const id = z.string().min(1).max(512)
const shortText = z.string().min(1).max(512)
const text = z.string().max(20_000)
const refs = z.array(id).max(200)
const definedValue = z.unknown().refine(value => value !== undefined)
const zonedDate = z.string().datetime({ offset: true }).transform(value => new Date(value).toISOString())
const optionalDate = zonedDate.optional()
const common = {
  id, revision: z.number().int().nonnegative(), createdAt: zonedDate, updatedAt: zonedDate,
  sourceRefs: refs,
}
const record = <S extends z.ZodRawShape>(fields: S) => z.object({ ...common, ...fields }).strict()

export const GoalSchema = record({
  title: shortText, description: text.optional(), priority: z.number().int().min(0).max(100),
  successCriteria: z.array(text).max(100), status: z.enum(['active', 'paused', 'completed', 'cancelled']),
})
export const CommitmentSchema = record({
  title: shortText, owner: z.enum(['user', 'assistant', 'external']), counterparty: text.optional(),
  dueAt: optionalDate, expectedAt: optionalDate, nextCheckAt: optionalDate,
  status: z.enum(['open', 'waiting', 'overdue', 'fulfilled', 'cancelled']), goalIds: refs, ticketIds: refs,
})
export const PersonalFactSchema = record({
  subject: shortText, predicate: shortText, value: definedValue, scope: text.optional(),
  confidence: z.number().min(0).max(1), confirmation: z.enum(['user', 'inferred', 'imported']),
  status: z.enum(['candidate', 'active', 'superseded', 'revoked']), validFrom: optionalDate, validUntil: optionalDate,
  supersedes: z.string().optional(),
})
export const ConstraintSchema = record({
  title: shortText, kind: z.enum(['time', 'budget', 'privacy', 'channel', 'risk']), severity: z.enum(['soft', 'hard']),
  status: z.enum(['active', 'expired', 'revoked']), startAt: optionalDate, endAt: optionalDate,
  amount: z.number().nonnegative().optional(), currency: z.string().max(16).optional(), scope: text.optional(),
})
export const AttentionItemSchema = record({
  title: shortText, summary: text, priority: z.enum(['P0', 'P1', 'P2', 'P3']),
  status: z.enum(['queued', 'sent', 'acknowledged', 'resolved']), ticketId: z.string().optional(), commitmentId: z.string().optional(),
  digestKey: shortText, notBefore: optionalDate, dueAt: optionalDate, sentAt: optionalDate,
})
export const AuthorizationSchema = record({
  ticketId: id, risk: z.enum(['L0', 'L1', 'L2', 'L3']), scope: z.array(shortText).max(100),
  status: z.enum(['requested', 'granted', 'revoked', 'expired']), expiresAt: optionalDate,
  requestHash: z.string().optional(), grantedBy: z.string().optional(), grantedAt: optionalDate,
})
export const ActionRecordSchema = record({
  ticketId: id, authorizationId: id.optional(), idempotencyKey: shortText,
  action: shortText, target: shortText, requestHash: shortText, payload: definedValue,
  status: z.enum(['prepared', 'executing', 'verified', 'failed', 'uncertain']), result: z.unknown().optional(), verifiedAt: optionalDate,
})

export const PersonalSchemas = {
  goal: GoalSchema, commitment: CommitmentSchema, fact: PersonalFactSchema, constraint: ConstraintSchema,
  attention: AttentionItemSchema, authorization: AuthorizationSchema, action: ActionRecordSchema,
} as const
export type PersonalKind = keyof typeof PersonalSchemas
export type PersonalRecordMap = {
  goal: z.infer<typeof GoalSchema>; commitment: z.infer<typeof CommitmentSchema>; fact: z.infer<typeof PersonalFactSchema>
  constraint: z.infer<typeof ConstraintSchema>; attention: z.infer<typeof AttentionItemSchema>
  authorization: z.infer<typeof AuthorizationSchema>; action: z.infer<typeof ActionRecordSchema>
}
export type PersonalRecord<K extends PersonalKind = PersonalKind> = PersonalRecordMap[K]

export const PersonalSettingsSchema = z.object({
  enabled: z.boolean(), timezone: z.string().min(1).refine(value => {
    try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return true } catch { return false }
  }, 'Invalid IANA timezone'), ownerActors: z.array(id).max(200).default(['web:owner']), quietStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  quietEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), digestMinutes: z.number().int().min(1).max(10080), revision: z.number().int().nonnegative(),
}).strict()
export type PersonalSettings = z.infer<typeof PersonalSettingsSchema>
