/** Persistent source attachment handles; credentials and OneBot locators stay inside the QQ adapter. */
import { stat } from 'node:fs/promises'
import { key, type Trigger } from '../core/index.ts'
import { record } from '../kv.ts'
import type { OneBotAttachment } from '../sources/onebot-message.ts'
import { fetchOneBotAttachment, type QQAttachmentFetchResult } from '../sources/qq-attachments.ts'
import type { SourceAttachmentRef } from '../sources/kind.ts'
import type { Store } from './store.ts'

interface AttachmentRecord { triggerId: string; index: number; input: OneBotAttachment; result?: QQAttachmentFetchResult }
const attachmentKey = (id: string) => record<AttachmentRecord>(`qq-attachment:${id}`)
interface Host {
  store: Pick<Store, 'get' | 'set'>
  stateDir: string
  allowed(trigger: Trigger): boolean
  call(action: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>
  localPeer(): boolean
  signal(): AbortSignal
}

/** Resolves only handles belonging to the original authorized message, coalescing repeated reads across workers. */
export class QqAttachmentStore {
  private readonly inflight = new Map<string, Promise<QQAttachmentFetchResult>>()
  constructor(private readonly host: Host) {}
  async idle(): Promise<void> { await Promise.allSettled([...this.inflight.values()]) }
  references(trigger: Trigger): SourceAttachmentRef[] {
    if (!Array.isArray(trigger.meta.attachments)) return []
    return trigger.meta.attachments.slice(0, 16).flatMap((value, index) => {
      if (!value || typeof value !== 'object' || !['file', 'image', 'video', 'record'].includes(value.type)) return []
      const input = value as OneBotAttachment, id = key('qq-attachment', trigger.id, String(index))
      const stored = this.host.store.get(attachmentKey(id))
      if (!stored) this.host.store.set(attachmentKey(id), { triggerId: trigger.id, index, input })
      const result = stored?.result
      const name = input.name ?? input.file_name ?? (input.type === 'file' ? input.file : undefined)
      return [{ id, type: input.type, ...(name ? { name } : {}),
        ...typeof (result?.size ?? input.size ?? input.file_size) === 'number' ? { size: result?.size ?? input.size ?? input.file_size } : {},
        status: result?.status ?? 'pending', read: `attachment/${trigger.id}/${id}` }]
    })
  }
  async read(trigger: Trigger, id: string, signal?: AbortSignal): Promise<QQAttachmentFetchResult & { id: string; type: OneBotAttachment['type'] }> {
    if (!this.host.allowed(trigger)) throw new Error('The attachment sender or source is no longer authorized')
    const reference = this.references(trigger).find(item => item.id === id)
    const stored = this.host.store.get(attachmentKey(id))
    if (!reference || !stored || stored.triggerId !== trigger.id) throw new Error('Choose an attachment reference returned by this source message')
    const cached = stored.result
    if (cached?.status === 'downloaded' && cached.path && await stat(cached.path).then(value => value.isFile() && value.size === cached.size, () => false)) {
      return { id, type: stored.input.type, ...cached }
    }
    let pending = this.inflight.get(id)
    if (!pending) {
      pending = fetchOneBotAttachment({ attachment: stored.input, messageId: String(trigger.meta.messageId), authorized: true,
        chat: { messageType: trigger.meta.messageType === 'group' ? 'group' : 'private',
          id: String(trigger.meta.messageType === 'group' ? trigger.meta.groupId : trigger.meta.userId) },
        stateDir: this.host.stateDir, call: (action, params, cancel) => this.host.call(action, params, cancel),
        allowLocalFiles: this.host.localPeer(), signal: this.host.signal() })
        .then(result => { this.host.store.set(attachmentKey(id), { ...stored, result }); return result })
        .finally(() => { this.inflight.delete(id) })
      this.inflight.set(id, pending)
    }
    signal?.throwIfAborted()
    const result = await pending
    signal?.throwIfAborted()
    if (!this.host.allowed(trigger)) throw new Error('Attachment access was revoked while downloading')
    return { id, type: stored.input.type, ...result }
  }
}
