/** Shared owner message editor: durable drafts, image uploads and explicit collaboration routing. */
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import type { Call } from './api.ts'
import { Icon } from './controls.tsx'
import { errorText, type T } from './text.ts'
import CSS from './message-composer.css?raw'

export interface MessageImage { id: string; name: string; mediaType: string; size: number }
export interface MentionWorker { id: string; name: string; title: string; active: boolean; subscribed: boolean }
export interface ComposerMessage { text: string; requestId: string; attachmentIds: string[]; router: boolean; mentions: string[] }
interface Draft { text: string; router: boolean; mentions: string[]; images: MessageImage[]; requestId: string; fingerprint: string }
interface Upload { key: string; file: File; preview?: string; error?: string; busy: boolean }
export interface MessageComposerProps {
  draftKey: string; call: Call; t: T; label: string; placeholder?: string; submitLabel?: string
  workers?: MentionWorker[]; disabled?: boolean; sendDisabled?: boolean; textareaId?: string; rows?: number; autoFocus?: boolean
  starters?: { label: string; text: string }[]
  mentionRequest?: { id: number; workerId: string }
  onSend(message: ComposerMessage): Promise<void>
}
const empty = (): Draft => ({ text: '', router: true, mentions: [], images: [], requestId: '', fingerprint: '' })
function loadDraft(key: string): Draft {
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) ?? 'null') as Partial<Draft> & { recipient?: string }
    if (!saved || typeof saved !== 'object') return empty()
    return { ...empty(), text: typeof saved.text === 'string' ? saved.text.slice(0, 16000) : '',
      router: typeof saved.router === 'boolean' ? saved.router : true,
      mentions: Array.isArray(saved.mentions) ? saved.mentions.filter((id): id is string => typeof id === 'string').slice(0, 50)
        : saved.recipient && saved.recipient !== 'router' ? [saved.recipient] : [],
      images: Array.isArray(saved.images) ? saved.images.filter(image => typeof image?.id === 'string'
        && typeof image.name === 'string' && typeof image.mediaType === 'string' && typeof image.size === 'number').slice(0, 8) : [],
      requestId: typeof saved.requestId === 'string' ? saved.requestId : '', fingerprint: typeof saved.fingerprint === 'string' ? saved.fingerprint : '' }
  } catch { return empty() }
}
const DRAFT_EVENT = 'superagent:message-draft'
function persist(key: string, draft: Draft) {
  try { sessionStorage.setItem(key, JSON.stringify(draft)) } catch { /* Editing remains available. */ }
  window.dispatchEvent(new CustomEvent(DRAFT_EVENT, { detail: { key, draft } }))
}
const signature = (draft: Draft) => JSON.stringify([draft.text.trim(), draft.router, draft.mentions, draft.images.map(image => image.id)])
const imageUrl = (id: string) => `/orchestrator/api/web/attachments/${encodeURIComponent(id)}`

/** Authenticated image preview shared by pending drafts and delivered messages. */
export function MessageImages({ attachments, compact = false }: { attachments?: MessageImage[]; compact?: boolean }) {
  if (!attachments?.length) return null
  return <><style>{CSS}</style><div className={`mc-images${compact ? ' mc-images-compact' : ''}`}>{attachments.map(image => <ImagePreview key={image.id} image={image} />)}</div></>
}
function ImagePreview({ image }: { image: MessageImage }) {
  const [preview, setPreview] = useState('')
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let alive = true, url = ''
    const controller = new AbortController()
    setFailed(false)
    void fetch(imageUrl(image.id), { headers: { 'x-orchestrator-request': '1' }, signal: controller.signal })
      .then(response => { if (!response.ok) throw new Error(); return response.blob() })
      .then(blob => { if (alive) { url = URL.createObjectURL(blob); setPreview(url) } })
      .catch(() => { if (alive) setFailed(true) })
    return () => { alive = false; controller.abort(); if (url) URL.revokeObjectURL(url) }
  }, [image.id, attempt])
  return <span className="mc-image-preview">{preview ? <a href={preview} target="_blank" rel="noopener noreferrer" title={image.name}>
    <img src={preview} alt={image.name} /></a> : failed ? <button type="button" onClick={() => setAttempt(value => value + 1)} title={image.name}>↻ {image.name}</button>
    : <span className="mc-image-loading">{image.name}</span>}</span>
}

/** Keyed editor prevents late uploads and send completions from changing another conversation's draft. */
export function MessageComposer(props: MessageComposerProps) { return <Editor key={props.draftKey} {...props} /> }
function Editor({ draftKey, call, t, label, placeholder, submitLabel, workers, disabled, sendDisabled, textareaId, rows = 3,
  autoFocus, starters, mentionRequest, onSend }: MessageComposerProps) {
  const chinese = t('lang') !== 'en'
  const copy = (zh: string, en: string) => chinese ? zh : en
  const [draft, setDraft] = useState(() => loadDraft(draftKey))
  const current = useRef(draft)
  const mounted = useRef(true), lock = useRef(false)
  const [busy, setBusy] = useState(false), [failure, setFailure] = useState(''), [feedback, setFeedback] = useState('')
  const [sendFailed, setSendFailed] = useState(false)
  const [uploads, setUploads] = useState<Upload[]>([])
  const uploadsRef = useRef(uploads); uploadsRef.current = uploads
  const previews = useRef(new Set<string>())
  const input = useRef<HTMLTextAreaElement>(null), fileInput = useRef<HTMLInputElement>(null)
  const [mention, setMention] = useState<{ start: number; end: number; query: string }>()
  const [highlight, setHighlight] = useState(0), [dragging, setDragging] = useState(false)
  const listId = useId()
  const update = (next: Draft | ((value: Draft) => Draft)) => {
    const value = typeof next === 'function' ? next(current.current) : next
    current.current = value; persist(draftKey, value); if (mounted.current) setDraft(value)
  }
  useEffect(() => {
    mounted.current = true
    const synchronized = (event: Event) => {
      const detail = (event as CustomEvent<{ key: string; draft: Draft }>).detail
      if (detail.key === draftKey) { current.current = detail.draft; setDraft(detail.draft) }
    }
    window.addEventListener(DRAFT_EVENT, synchronized)
    return () => { mounted.current = false; window.removeEventListener(DRAFT_EVENT, synchronized); for (const url of previews.current) URL.revokeObjectURL(url) }
  }, [])
  useEffect(() => {
    if (!mentionRequest) return
    update(value => ({ ...value, mentions: [...new Set([...value.mentions, mentionRequest.workerId])] }))
    input.current?.focus()
  }, [mentionRequest?.id])
  const options = (workers ?? []).filter(worker => !draft.mentions.includes(worker.id)
    && `${worker.name} ${worker.title}`.toLocaleLowerCase().includes(mention?.query.toLocaleLowerCase() ?? ''))
  const unavailable = !!workers && draft.mentions.some(id => !workers.some(worker => worker.id === id && worker.active && worker.subscribed))
  const routeInvalid = !!workers && !draft.router && (!draft.mentions.length || unavailable)
  const content = !!draft.text.trim() || draft.images.length > 0
  const blocked = !!disabled || !!sendDisabled || busy || !content || draft.text.trim().length > 16000 || routeInvalid || uploads.length > 0
  const routeHint = !workers ? copy('草稿自动保留 · Ctrl / ⌘ + Enter 发送', 'Draft saved · Ctrl / ⌘ + Enter to send')
    : !draft.router && !draft.mentions.length ? copy('请选择 @成员或开启 R', 'Mention a worker or enable R')
      : !draft.router && unavailable ? copy('所选成员已结束或离开任务，开启 R 可继续安排', 'A selected worker is unavailable; enable R to continue')
        : draft.router ? draft.mentions.length ? copy(`由 R 协调 ${draft.mentions.length} 位成员`, `R coordinates ${draft.mentions.length} workers`)
          : copy('发送给 R', 'Send to R') : copy(`直达 ${draft.mentions.length} 位成员`, `Direct to ${draft.mentions.length} workers`)
  const detectMention = (text: string, caret: number) => {
    if (!workers) return
    const before = text.slice(0, caret), match = /@([^@\n]{0,80})$/.exec(before)
    setMention(match ? { start: caret - match[1]!.length - 1, end: caret, query: match[1]! } : undefined)
    setHighlight(0)
  }
  const choose = (worker: MentionWorker) => {
    if (!mention) return
    const caret = mention.start
    update(value => ({ ...value, text: value.text.slice(0, mention.start) + value.text.slice(mention.end),
      mentions: [...new Set([...value.mentions, worker.id])] }))
    setMention(undefined); setFailure('')
    queueMicrotask(() => { input.current?.focus(); input.current?.setSelectionRange(caret, caret) })
  }
  const upload = async (item: Upload) => {
    setUploads(values => values.map(value => value.key === item.key ? { ...value, busy: true, error: undefined } : value))
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1] ?? ''); reader.onerror = reject; reader.readAsDataURL(item.file)
      })
      const image = await call('POST web/attachments', { body: { name: item.file.name, mediaType: item.file.type, data, requestId: item.key } })
      // A removed or abandoned upload is kept on the server without reappearing in a draft.
      if (!mounted.current || !uploadsRef.current.some(value => value.key === item.key)) return
      update(value => ({ ...value, images: [...value.images, image] }))
      setUploads(values => values.filter(value => value.key !== item.key))
      if (item.preview) { URL.revokeObjectURL(item.preview); previews.current.delete(item.preview) }
    } catch (error) { if (mounted.current) setUploads(values => values.map(value => value.key === item.key ? { ...value, busy: false, error: errorText(error) } : value)) }
  }
  const addFiles = (files: File[]) => {
    if (disabled || busy) return
    const available = Math.max(0, 8 - current.current.images.length - uploadsRef.current.length)
    const accepted: Upload[] = []
    for (const file of files) {
      if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) { setFailure(copy('请选择 PNG、JPEG、WebP 或 GIF 图片。', 'Choose PNG, JPEG, WebP or GIF images.')); continue }
      if (file.size > 10 * 1024 * 1024) { setFailure(copy('单张图片最大 10 MB。', 'Each image can be up to 10 MB.')); continue }
      if (accepted.length >= available) { setFailure(copy('每条消息最多添加 8 张图片。', 'Add up to 8 images per message.')); break }
      const preview = typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : undefined
      if (preview) previews.current.add(preview)
      accepted.push({ key: crypto.randomUUID(), file, preview, busy: true })
    }
    uploadsRef.current = [...uploadsRef.current, ...accepted]
    setUploads(uploadsRef.current)
    for (const item of accepted) void upload(item)
  }
  const send = async () => {
    if (blocked || lock.current) return
    lock.current = true; setBusy(true); setFailure(''); setFeedback(''); setSendFailed(false); setMention(undefined)
    const snapshot = current.current, fingerprint = signature(snapshot)
    const requestId = snapshot.fingerprint === fingerprint && snapshot.requestId ? snapshot.requestId : crypto.randomUUID()
    update(value => ({ ...value, fingerprint, requestId }))
    try {
      await onSend({ text: snapshot.text.trim(), attachmentIds: snapshot.images.map(image => image.id),
        mentions: workers ? snapshot.mentions : [], router: workers ? snapshot.router : true, requestId })
      // Re-read persisted state: a user may have left and resumed editing while this request was pending.
      const latest = mounted.current ? current.current : loadDraft(draftKey)
      if (latest.requestId === requestId && signature(latest) === fingerprint) update({ ...empty(), router: latest.router })
      if (mounted.current) setFeedback(copy('已发送', 'Sent'))
    } catch (error) { if (mounted.current) { setFailure(errorText(error)); setSendFailed(true) } }
    finally { lock.current = false; if (mounted.current) setBusy(false) }
  }
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return
    if (mention) {
      if (event.key === 'Escape') { event.preventDefault(); setMention(undefined); return }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); setHighlight(value => options.length ? (value + (event.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length : 0); return
      }
      if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey && options.length) { event.preventDefault(); choose(options[Math.min(highlight, options.length - 1)]!); return }
    }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void send() }
  }
  return <form className={`mc-composer${dragging ? ' mc-dragging' : ''}`} onSubmit={event => { event.preventDefault(); void send() }}
    onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); setDragging(true) } }}
    onDragLeave={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDragging(false) }}
    onDrop={event => { event.preventDefault(); setDragging(false); addFiles(Array.from(event.dataTransfer.files)) }}>
    <style>{CSS}</style>
    <label className="mc-label" htmlFor={textareaId ?? `${listId}-input`}>{label}</label>
    {!!draft.mentions.length && workers && <div className="mc-mentions" aria-label={copy('已提及成员', 'Mentioned workers')}>{draft.mentions.map(id => {
      const worker = workers.find(worker => worker.id === id), name = worker?.name ?? copy('历史成员', 'Previous worker')
      return <span key={id} className="mc-mention-chip" title={worker?.title}>@{name}<button type="button" disabled={busy} aria-label={copy(`移除 ${name}`, `Remove ${name}`)}
        onClick={() => update(value => ({ ...value, mentions: value.mentions.filter(value => value !== id) }))}>×</button></span>
    })}</div>}
    <div className="mc-input-wrap">
      <textarea ref={input} id={textareaId ?? `${listId}-input`} autoFocus={autoFocus} rows={rows} maxLength={16000} value={draft.text}
        disabled={disabled || busy} aria-label={label} placeholder={placeholder}
        role={workers ? 'combobox' : undefined} aria-haspopup={workers ? 'listbox' : undefined}
        aria-expanded={workers ? !!mention : undefined} aria-controls={mention ? listId : undefined} aria-autocomplete={workers ? 'list' : undefined}
        aria-activedescendant={mention && options.length ? `${listId}-${Math.min(highlight, options.length - 1)}` : undefined}
        onChange={event => { update(value => ({ ...value, text: event.target.value })); setFailure(''); setFeedback(''); detectMention(event.target.value, event.target.selectionStart) }}
        onClick={event => detectMention(event.currentTarget.value, event.currentTarget.selectionStart)}
        onBlur={() => setMention(undefined)}
        onKeyDown={keyDown} onPaste={event => {
          const files = Array.from(event.clipboardData.items).filter(item => item.kind === 'file' && item.type.startsWith('image/')).flatMap(item => item.getAsFile() ?? [])
          if (files.length) { event.preventDefault(); addFiles(files) }
        }} />
      {mention && <div id={listId} role="listbox" aria-label={copy('选择执行成员', 'Choose a worker')} className="mc-mention-menu">
        {options.length ? options.map((worker, index) => <button key={worker.id} id={`${listId}-${index}`} type="button" role="option" aria-selected={highlight === index}
          onMouseDown={event => event.preventDefault()} onClick={() => choose(worker)} className={highlight === index ? 'mc-option-highlight' : undefined}>
          <span className={`mc-worker-dot${worker.active ? ' mc-worker-dot-active' : ''}`} title={copy(worker.active ? '进行中' : '已结束', worker.active ? 'Active' : 'Ended')} />
          <span><strong>{worker.name}</strong><small>{worker.title}</small></span></button>) : <p>{copy('没有匹配的成员', 'No matching workers')}</p>}
      </div>}
    </div>
    {(draft.images.length > 0 || uploads.length > 0) && <div className="mc-attachments" aria-label={copy('消息图片', 'Message images')}>
      {draft.images.map(image => <div className="mc-attachment" key={image.id}><MessageImages attachments={[image]} compact />
        <button type="button" className="mc-image-remove" disabled={busy} aria-label={copy(`移除图片 ${image.name}`, `Remove image ${image.name}`)}
          onClick={() => update(value => ({ ...value, images: value.images.filter(item => item.id !== image.id) }))}>×</button></div>)}
      {uploads.map(item => <div className="mc-attachment mc-upload" key={item.key}>{item.preview && <img src={item.preview} alt={item.file.name} />}
        <span role="status">{item.error || copy('上传中…', 'Uploading…')}</span>
        {item.error && <button type="button" onClick={() => { void upload(item) }}>{copy('重试上传', 'Retry upload')}</button>}
        <button type="button" className="mc-image-remove" aria-label={copy(`移除图片 ${item.file.name}`, `Remove image ${item.file.name}`)} onClick={() => {
          uploadsRef.current = uploadsRef.current.filter(value => value.key !== item.key); setUploads(uploadsRef.current)
          if (item.preview) { URL.revokeObjectURL(item.preview); previews.current.delete(item.preview) }
        }}>×</button></div>)}
    </div>}
    {!!starters?.length && <div className="sa-prompt-starters">{starters.map(starter => <button type="button" key={starter.label} disabled={disabled || busy}
      onClick={() => { if (!current.current.text.trim()) update(value => ({ ...value, text: starter.text })); input.current?.focus() }}>{starter.label}</button>)}</div>}
    {failure && <p className="mc-error" role="alert">{failure}</p>}
    <div className="mc-toolbar"><input ref={fileInput} className="mc-file-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple tabIndex={-1}
      onChange={event => { addFiles(Array.from(event.target.files ?? [])); event.target.value = '' }} />
      <button type="button" className="mc-add-image" disabled={disabled || busy || draft.images.length + uploads.length >= 8} title={copy('添加图片，也可粘贴或拖入', 'Add images, paste or drop')}
        aria-label={copy('添加图片', 'Add images')} onClick={() => fileInput.current?.click()}><Icon name="plus" size={17} /></button>
      <span className="mc-route-hint" role="status">{feedback || routeHint}</span>
      {sendFailed && <button type="button" disabled={busy} onClick={() => {
        update(value => ({ ...empty(), router: value.router })); setFailure(''); setFeedback(''); setSendFailed(false)
      }}>{t('cancel')}</button>}
      {workers && <button type="button" className={`mc-router-toggle${draft.router ? ' mc-router-on' : ''}`} aria-label={copy('交给调度助手', 'Send through Router')}
        title={copy('交给调度助手', 'Send through Router')} aria-pressed={draft.router} disabled={disabled || busy}
        onClick={() => { update(value => ({ ...value, router: !value.router })); setFeedback('') }}><span className="mc-router-label">{copy('发送给', 'Send to')}</span><span className="mc-router-logo" aria-hidden="true">R</span></button>}
      <button type="submit" className="mc-send" disabled={blocked}><Icon name={busy ? 'running' : 'play'} size={13} />{busy ? copy('发送中…', 'Sending…') : sendFailed ? t('retry') : submitLabel ?? copy('发送', 'Send')}</button>
    </div>
  </form>
}
