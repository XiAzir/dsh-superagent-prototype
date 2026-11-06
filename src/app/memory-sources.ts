/** Canonical source references for memory. Resolution is delegated to the host's existing authorized resource readers. */
import { z } from 'zod'

export const MemorySourceSchema = z.object({
  kind: z.enum(['trigger', 'ticket', 'document', 'url']),
  ref: z.string().trim().min(1).max(500),
  locator: z.string().trim().min(1).max(300).optional(),
  quote: z.string().trim().min(1).max(1000).optional(),
  observedAt: z.string().datetime({ offset: true }).optional(),
}).strict()
export type MemorySourceInput = z.infer<typeof MemorySourceSchema>
export interface MemorySource extends Omit<MemorySourceInput, 'kind'> {
  kind: MemorySourceInput['kind'] | 'legacy'
  resolution: 'resolved' | 'unresolved' | 'legacy'
  checkedAt?: string
}
export type MemorySourceResolver = (source: Readonly<MemorySourceInput>) => boolean

/** Older strings retain their original representation and gain a parsed, explicit resolution status. */
export function parseMemorySource(value: string | MemorySourceInput): MemorySourceInput | { kind: 'legacy'; ref: string } {
  if (typeof value !== 'string') return MemorySourceSchema.parse(value)
  const text = value.trim()
  const match = /^(trigger|ticket|document)(?::|\/)(.+)$/u.exec(text)
  if (match) return { kind: match[1] as MemorySourceInput['kind'], ref: match[2]! }
  if (/^https?:\/\//u.test(text)) return { kind: 'url', ref: text }
  return { kind: 'legacy', ref: text }
}

export function resolveMemorySources(values: readonly (string | MemorySourceInput)[], now: string,
  resolver?: MemorySourceResolver): { sources: string[]; sourceRefs: MemorySource[] } {
  if (!values.length || values.length > 16) throw new Error('1 to 16 evidence sources are required')
  const sourceRefs = values.map(value => {
    const parsed = parseMemorySource(value)
    if (!parsed.ref || parsed.ref.length > 500) throw new Error('each source must contain 1 to 500 characters')
    if (parsed.kind === 'legacy') return { ...parsed, resolution: 'legacy' as const }
    if (parsed.kind === 'url') {
      const url = new URL(parsed.ref)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('memory URL evidence must be HTTP(S) without credentials')
    }
    const input = MemorySourceSchema.parse(parsed)
    let resolved = false
    try { resolved = resolver?.(input) === true } catch { /* A source lookup failure leaves a candidate available for later revalidation. */ }
    return { ...input, resolution: resolved ? 'resolved' as const : 'unresolved' as const, ...resolver ? { checkedAt: now } : {} }
  })
  return { sources: values.map((value, index) => typeof value === 'string' ? value.trim()
    : `${sourceRefs[index]!.kind}:${sourceRefs[index]!.ref}${value.locator ? `#${value.locator}` : ''}`), sourceRefs }
}
