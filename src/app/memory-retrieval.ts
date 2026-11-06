/** Deterministic, scope-aware retrieval for durable memory; Chinese bigrams need no external tokenizer. */
import type { MemoryContext, MemoryMetadata, MemorySearchDocument } from './memory.ts'

const normalize = (text: string) => text.normalize('NFKC').toLocaleLowerCase().replace(/\s+/gu, ' ').trim()
const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u

/** Keep Latin words and contiguous Chinese runs separate so mixed queries retain every meaningful part. */
function terms(text: string): string[] {
  const chunks = normalize(text).match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+|[\p{L}\p{N}]+/gu) ?? []
  return [...new Set(chunks.flatMap(chunk => cjk.test(chunk)
    ? [...chunk].length === 1 ? [chunk] : [...chunk].slice(0, -1).map((char, index) => char + [...chunk][index + 1])
    : [chunk]))]
}

export function memorySearchDocument(metadata: Pick<MemoryMetadata, 'topic' | 'title' | 'summary' | 'aliases'>, content: string): MemorySearchDocument {
  const heading = normalize(`${metadata.topic} ${metadata.title} ${metadata.summary} ${(metadata.aliases ?? []).join(' ')}`)
  return { heading, terms: terms(`${heading} ${content}`) }
}

/** Global facts remain eligible; scoped facts require the task to match every declared dimension. */
export function memoryScopeMatch(metadata: MemoryMetadata, context: MemoryContext): number {
  const scopes = metadata.scopes ?? ['global']
  if (!context.scopes?.length && !context.ticketId) return 0
  const requested = new Set([...(context.scopes ?? []), ...context.ticketId ? [`ticket:${context.ticketId}`] : []])
  if (scopes.includes('global')) return 0
  const kinds = [...new Set(scopes.map(scope => scope.slice(0, scope.indexOf(':'))))]
  // Different dimensions compose: project:a + source:qq applies to project a on QQ; alternatives within one dimension are OR.
  if (kinds.some(kind => !scopes.some(scope => scope.startsWith(`${kind}:`) && requested.has(scope)))) return -1
  const matches = scopes.filter(scope => requested.has(scope)).length
  return matches || -1
}

/** Relevance uses all query terms, then exact phrases and title/summary locality for ordering. */
export function memoryQueryScore(metadata: MemoryMetadata, document: MemorySearchDocument | undefined, query: string): number {
  const wanted = normalize(query)
  if (!wanted) return 0
  const heading = document?.heading ?? normalize(`${metadata.topic} ${metadata.title} ${metadata.summary} ${(metadata.aliases ?? []).join(' ')}`)
  const queryTerms = terms(wanted)
  const available = new Set(document?.terms ?? terms(heading))
  if (!queryTerms.length) return heading.includes(wanted) ? 10 : -1
  const latin = queryTerms.filter(term => !cjk.test(term)), chinese = queryTerms.filter(term => cjk.test(term))
  // Every Latin/number term matters, so topic-64 does not match all other topic-* entries.
  if (latin.some(term => !available.has(term) && !heading.includes(term))) return -1
  const matchedChinese = chinese.filter(term => available.has(term) || heading.includes(term)).length
  if (chinese.length && matchedChinese / chinese.length < 0.6) return -1
  const fraction = (latin.length + matchedChinese) / queryTerms.length
  return fraction * 20 + (heading.includes(wanted) ? 30 : 0)
    + queryTerms.filter(term => normalize(metadata.title).includes(term)).length * 2
}

/** Expiry is evaluated at read time; persisted rows and historical versions remain available for audit. */
export function memoryEffective(metadata: MemoryMetadata, at: string): boolean {
  return metadata.status === 'active' && (!metadata.validFrom || metadata.validFrom <= at) && (!metadata.validUntil || metadata.validUntil > at)
}

export function rankMemories(records: MemoryMetadata[], context: MemoryContext, at: string,
  search: (topic: string) => MemorySearchDocument | undefined): MemoryMetadata[] {
  const query = context.query?.trim() ?? ''
  const ranked = records.flatMap(metadata => {
    const scope = memoryScopeMatch(metadata, context)
    if (scope < 0) return []
    const relevance = query ? memoryQueryScore(metadata, search(metadata.topic), query) : 0
    if (relevance < 0) return []
    const evidence = metadata.confidence === 'supported' ? 4 : metadata.confidence === 'inferred' ? 0 : 1
    const freshness = metadata.confirmedAt ? Math.max(0, 30 - (Date.parse(at) - Date.parse(metadata.confirmedAt)) / 86_400_000) / 30 : 0
    return [{ metadata, score: relevance * 1000 + scope * 100 + evidence * 10 + (metadata.importance ?? 50) / 10 + freshness }]
  })
  return ranked.sort((a, b) => b.score - a.score || a.metadata.topic.localeCompare(b.metadata.topic)).map(item => item.metadata)
}
