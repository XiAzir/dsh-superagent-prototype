/** Personal-mode task rooms: one shared Router/Worker timeline with lazy, bounded execution details. */
import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { RoomActivity, RoomMessage, TaskRoomSummary, TaskRoomView } from '../app/task-rooms.ts'
import { Button, Dot, Icon, Tag } from './controls.tsx'
import { ArtifactDownload } from './artifacts.tsx'
import { usePoll } from './api.ts'
import { usePanel, usePanelData } from './provider.tsx'
import { errorText, when } from './text.ts'
import { Hint, LoadState, PageHead, Section } from './widgets.tsx'

const PAGE = 50
const shortWorkerId = (id: string, workers: TaskRoomView['workers']) => {
  let length = 8
  while (workers.some(worker => worker.id !== id && worker.id.slice(0, length) === id.slice(0, length)) && length < id.length) length++
  return id.slice(0, length)
}
type Older = { messages: RoomMessage[]; cursor: string | null }
const overlaps = (a: RoomMessage[], b: RoomMessage[]) => a.some(item => b.some(other => other.id === item.id))
const byTime = (messages: RoomMessage[]) => [...new Map(messages.map(item => [item.id, item])).values()]
  .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
const hasGap = (newest: TaskRoomView, older?: Older) => !!older && newest.earlier !== null && !overlaps(newest.messages, older.messages)
function merge(newest: TaskRoomView, older?: Older): TaskRoomView {
  if (!older || newest.earlier === null || hasGap(newest, older)) return newest
  return { ...newest, messages: byTime([...older.messages, ...newest.messages]), earlier: older.cursor }
}

function useRoom(key: string) {
  const { call, notify } = usePanel()
  const [older, setOlder] = useState<Older>()
  const { data: newest, error, reload } = usePoll(() => call('GET rooms/:key', { key, query: { limit: PAGE } }), [key], 4000)
  const data = newest && merge(newest, older)
  const gap = !!newest && hasGap(newest, older)
  useEffect(() => {
    if (!gap || !newest || !older) return
    let active = true
    const fill = async () => {
      let run = newest.messages, cursor = newest.earlier
      while (cursor !== null && !overlaps(run, older.messages)) {
        const page = await call('GET rooms/:key', { key, query: { limit: PAGE, before: cursor } })
        run = [...page.messages, ...run]; cursor = page.earlier
      }
      if (active) setOlder({ messages: byTime([...older.messages, ...run]), cursor: overlaps(run, older.messages) ? older.cursor : cursor })
    }
    void fill().catch((failure: unknown) => { if (active) notify(errorText(failure)) })
    return () => { active = false }
  }, [gap, newest, older, call, key, notify])
  const loadEarlier = async () => {
    if (!data?.earlier) return undefined
    const page = await call('GET rooms/:key', { key, query: { limit: PAGE, before: data.earlier } })
    setOlder({ messages: byTime([...page.messages, ...data.messages]), cursor: page.earlier })
    return page.messages.at(-1)?.id
  }
  return { data, error, reload, loadEarlier }
}

function Activity({ room, workerId }: { room: string; workerId: string }) {
  const { t, call } = usePanel()
  const [data, setData] = useState<RoomActivity>()
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  const [offset, setOffset] = useState(0)
  const [failedOffset, setFailedOffset] = useState<number>()
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const load = async (from = 0) => {
    setBusy(true); setFailure(''); setFailedOffset(undefined)
    try {
      const page = await call('GET rooms/:key/workers/:ticketId/activity', { key: room, ticketId: workerId,
        query: { offset: from, limit: PAGE } })
      if (!mounted.current) return
      setData(current => from === 0 ? page : { items: [...current?.items ?? [], ...page.items.filter(item => !current?.items.some(old => old.id === item.id))],
        next_offset: page.next_offset })
      setOffset(page.next_offset ?? 0)
    } catch (error) { if (mounted.current) { setFailure(errorText(error)); setFailedOffset(from) } }
    finally { if (mounted.current) setBusy(false) }
  }
  useEffect(() => { void load(0) }, [room, workerId])
  return <div className="dt-room-activity">
    {failure && <p className="dt-error" role="alert">{failure}</p>}
    {!data && busy && <Hint>{t('loading')}</Hint>}
    {data?.items.length === 0 && <Hint>{t('room.noActivity')}</Hint>}
    {!!data?.items.length && <ol className="dt-room-activity-list">{data.items.map(item => <ActivityItem key={item.id} item={item} />)}</ol>}
    {failure && <Button variant="outline" size="sm" disabled={busy} onClick={() => { void load(failedOffset ?? 0) }}>{t('retry')}</Button>}
    {data?.next_offset !== null && data && <Button variant="outline" size="sm" disabled={busy} onClick={() => { void load(offset) }}>
      {busy ? t('loading') : t('loadMore')}
    </Button>}
  </div>
}

function ActivityItem({ item }: { item: RoomActivity['items'][number] }) {
  const { t } = usePanel()
  const [open, setOpen] = useState(false)
  return <li>
    <span className="dt-room-activity-type">{item.type}</span>
    <Button variant="ghost" size="sm" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      {t(open ? 'room.hideDetails' : 'room.showDetails')}
    </Button>
    {open && <pre>{item.text}</pre>}
  </li>
}

function WorkerList({ room }: { room: TaskRoomView }) {
  const { t } = usePanel()
  const [expanded, setExpanded] = useState<string[]>([])
  return <Section title={t('room.workers')} count={room.workers.length}>
    {!room.workers.length ? <Hint>{t('room.noWorkers')}</Hint> : <ul className="dt-room-workers">{room.workers.map(worker => {
      const open = expanded.includes(worker.id)
      return <li key={worker.id}>
        <div className="dt-room-worker">
          <Dot state={worker.active ? 'ongoing' : 'idle'} label={t(worker.active ? 'room.active' : 'room.stopped')} />
          <div className="dt-row-main"><div className="dt-room-worker-title">{worker.title}</div>
            <div className="dt-row-meta"><span>{shortWorkerId(worker.id, room.workers)}</span><span>{worker.stage}</span>
              <Tag tone={worker.subscribed ? 'info' : 'neutral'}>{t(worker.subscribed ? 'room.subscribed' : 'room.unsubscribed')}</Tag>
            </div>
            {worker.summary && <p className="dt-room-summary">{worker.summary}</p>}
          </div>
          <Button variant="ghost" size="sm" aria-expanded={open} onClick={() => setExpanded(current => open
            ? current.filter(id => id !== worker.id) : [...current, worker.id])}>{t(open ? 'room.hideActivity' : 'room.showActivity')}</Button>
        </div>
        {open && <Activity key={worker.id} room={room.key} workerId={worker.id} />}
      </li>
    })}</ul>}
  </Section>
}

function audienceLabel(t: ReturnType<typeof usePanel>['t'], message: RoomMessage) {
  const audience = message.audience
  if (audience === 'router') return t('room.audience.router')
  if (audience === 'worker') return t('room.audience.worker', { recipient: message.recipient ?? message.ticketId ?? '' })
  return t(`room.audience.${audience}`)
}
function deliveryLabel(t: ReturnType<typeof usePanel>['t'], delivery: NonNullable<RoomMessage['delivery']>) {
  return t(`room.delivery.${delivery}`)
}
function Message({ roomKey, message }: { roomKey: string; message: RoomMessage }) {
  const { t } = usePanel()
  const [open, setOpen] = useState(false)
  const isUser = message.kind === 'user'
  const hasDetails = !!message.details
  const artifacts = message.artifacts
  return <li className={`dt-room-message${isUser ? ' dt-room-user' : ''}`} data-message-id={message.id}>
    <div className="dt-room-message-head"><strong>{message.actor.name}</strong><time dateTime={message.at}>{when(message.at, t('lang'))}</time></div>
    <p className="dt-room-message-text">{message.text}</p>
    <div className="dt-row-meta"><Tag tone={message.audience === 'record' ? 'neutral' : 'info'}>{audienceLabel(t, message)}</Tag>
      {message.delivery && <span>{deliveryLabel(t, message.delivery)}</span>}
    </div>
    {hasDetails && <><Button variant="ghost" size="sm" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      {t(open ? 'room.hideDetails' : 'room.showDetails')}
    </Button>{open && <pre className="dt-room-details">{message.details}</pre>}</>}
    {!!artifacts?.length && <ul className="dt-web-task-artifacts">{artifacts.map(artifact => <li key={artifact.id}>
      <ArtifactDownload room={roomKey} artifact={artifact} />
    </li>)}</ul>}
  </li>
}

function Composer({ room, onSent }: { room: TaskRoomView; onSent: () => void }) {
  const { t, call } = usePanel()
  const { state } = usePanelData()
  const [text, setText] = useState('')
  const [recipient, setRecipient] = useState('router')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  const pending = useRef<{ fingerprint: string; requestId: string }>()
  const sending = useRef(false)
  const eligible = room.workers.filter(worker => worker.active && worker.subscribed)
  const targetUnavailable = recipient !== 'router' && !eligible.some(worker => worker.id === recipient)
  const paused = room.paused || !!state?.paused
  const fingerprint = `${recipient}\u0000${text.trim()}`
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const message = text.trim()
    if (!message || message.length > 16_000 || sending.current || !room.writable || paused || targetUnavailable) return
    if (!pending.current || pending.current.fingerprint !== fingerprint) pending.current = { fingerprint, requestId: crypto.randomUUID() }
    sending.current = true; setBusy(true); setFailure('')
    try {
      await call('POST rooms/:key/messages', { key: room.key, body: { text: message, requestId: pending.current.requestId,
        ...(recipient === 'router' ? {} : { recipient }) } })
      pending.current = undefined; setText(''); onSent()
    } catch (error) { setFailure(errorText(error)) }
    finally { sending.current = false; setBusy(false) }
  }
  return <form className="dt-form dt-room-composer" onSubmit={event => { void submit(event) }}>
    <label className="dt-field"><span className="dt-field-head">{t('room.recipient')}</span>
      <select className="dt-select" aria-label={t('room.recipient')} value={recipient} disabled={busy}
        aria-describedby={targetUnavailable ? 'dt-room-target-error' : undefined}
        onChange={event => { setRecipient(event.target.value); setFailure('') }}>
        <option value="router">{t('room.toRouter')}</option>
        {targetUnavailable && <option value={recipient} disabled>{t('room.workerUnavailable', { id: shortWorkerId(recipient, room.workers) })}</option>}
        {eligible.map(worker => <option key={worker.id} value={worker.id}>{t('room.toWorker', { title: worker.title,
          id: shortWorkerId(worker.id, room.workers) })}</option>)}
      </select>
      <small>{t('room.recipientHint')}</small>
    </label>
    {targetUnavailable && <p id="dt-room-target-error" className="dt-error" role="alert">{t('room.workerUnavailable',
      { id: shortWorkerId(recipient, room.workers) })}</p>}
    <label className="dt-field"><span className="dt-field-head">{t('room.message')}</span>
      <textarea className="dt-textarea" rows={3} maxLength={16_000} value={text} disabled={busy || !room.writable}
        aria-label={t('room.message')} aria-describedby={failure ? 'dt-room-send-error' : undefined}
        placeholder={t('room.messagePlaceholder')} onChange={event => { setText(event.target.value); setFailure('') }} />
      <small>{t('webTask.charCount', { count: text.trim().length })}</small>
    </label>
    {failure && <p id="dt-room-send-error" className="dt-error" role="alert">{failure}</p>}
    {!room.writable && <p className="dt-hint">{t('room.readOnly')}</p>}
    {paused && <p className="dt-banner" role="status">{t('room.paused')}</p>}
    <div className="dt-row-actions">
      {failure && <Button variant="outline" disabled={busy} onClick={() => { setText(''); setFailure(''); pending.current = undefined }}>{t('cancel')}</Button>}
      <Button type="submit" variant="primary" disabled={busy || paused || targetUnavailable || !text.trim() || text.trim().length > 16_000 || !room.writable}
        icon={<Icon name={busy ? 'running' : 'message'} size={14} />}>{busy ? t('room.sending') : t(failure ? 'retry' : 'room.send')}</Button>
    </div>
  </form>
}

function Room({ id }: { id: string }) {
  const { t, navigate } = usePanel()
  const { state } = usePanelData()
  const { data, error, reload, loadEarlier } = useRoom(id)
  const [earlierBusy, setEarlierBusy] = useState(false)
  const [earlierFailure, setEarlierFailure] = useState('')
  const [anchorId, setAnchorId] = useState<string>()
  if (!data) return <><PageHead title={t('room.title')} /><LoadState error={error} loading={!error} />
    {error && <Button variant="outline" size="sm" onClick={() => { void reload() }}>{t('retry')}</Button>}</>
  const anchorIndex = anchorId ? data.messages.findIndex(message => message.id === anchorId) : -1
  const end = anchorIndex >= 0 ? anchorIndex + 1 : data.messages.length
  const start = Math.max(0, end - PAGE)
  const visibleMessages = data.messages.slice(start, end)
  const pageOlder = async () => {
    if (start > 0) { setAnchorId(data.messages[start > PAGE ? start - PAGE : start - 1]!.id); return }
    if (!data.earlier) return
    setEarlierBusy(true); setEarlierFailure('')
    try {
      const page = await loadEarlier()
      if (page) setAnchorId(page)
    } catch (failure) { setEarlierFailure(errorText(failure)) }
    finally { setEarlierBusy(false) }
  }
  const pageNewer = () => {
    if (end + PAGE >= data.messages.length) setAnchorId(undefined)
    else setAnchorId(data.messages[Math.min(data.messages.length - 1, end + PAGE - 1)]!.id)
  }
  return <div className="dt-room-page">
    <PageHead title={data.title || t('room.untitled')}>
      {data.key.startsWith('web:') && <Button variant="outline" size="sm" onClick={() => navigate({ page: 'tasks', id: data.key.slice(4) })}>
        {t('room.openTaskConversation')}
      </Button>}
      {state?.mode === 'personal' && <Button variant="outline" size="sm" icon={<Icon name="plus" size={14} />}
        onClick={() => navigate({ page: 'tasks' })}>{t('webTask.newTask')}</Button>}
    </PageHead>
    <div className="dt-row-meta dt-status-line"><span>{data.source}</span>{data.pending && <Tag tone="warning">{t('room.pending')}</Tag>}
      <span>{t('room.updated', { time: when(data.updatedAt, t('lang')) })}</span></div>
    {error && <><LoadState error={error} loading={false} /><Button variant="outline" size="sm" onClick={() => { void reload() }}>{t('retry')}</Button></>}
    <WorkerList room={data} />
    <Section title={t('room.timeline')} count={data.messages.length}>
      {data.messages.length === 0 ? <Hint>{t('room.empty')}</Hint> : <ol className="dt-room-timeline" aria-label={t('room.timeline')}>
        {visibleMessages.map(message => <Message key={message.id} roomKey={data.key} message={message} />)}
      </ol>}
      {(start > 0 || data.earlier) && <Button variant="outline" size="sm" disabled={earlierBusy} icon={<Icon name="chevron-up" size={14} />}
        onClick={() => { void pageOlder() }}>{t(earlierBusy ? 'loading' : 'loadEarlier')}</Button>}
      {anchorId && end < data.messages.length && <Button variant="outline" size="sm" onClick={pageNewer}>{t('room.loadNewer')}</Button>}
      {earlierFailure && <p className="dt-error" role="alert">{earlierFailure} <Button size="sm" variant="outline" disabled={earlierBusy}
        onClick={() => { void pageOlder() }}>{t('retry')}</Button></p>}
    </Section>
    <Composer room={data} onSent={() => { void reload() }} />
  </div>
}

function RoomList() {
  const { t, call, navigate } = usePanel()
  const { state } = usePanelData()
  const [stateData, setStateData] = useState<{ items: TaskRoomSummary[]; next?: number | null; error?: string; busy: boolean }>(
    { items: [], busy: true })
  const items = stateData.items
  const next = stateData.next
  const busy = stateData.busy
  const failure = stateData.error ?? ''
  const mounted = useRef(true)
  const loading = useRef(false)
  const load = async (offset = 0) => {
    if (loading.current) return
    loading.current = true
    setStateData(current => ({ ...current, busy: true, error: undefined }))
    try {
      const page = await call('GET rooms', { query: { offset, limit: PAGE } })
      if (mounted.current) setStateData(current => {
        const existing = offset === 0 ? current.items : current.items
        const merged = new Map(existing.map(item => [item.key, item]))
        for (const item of page.items) merged.set(item.key, { ...merged.get(item.key), ...item })
        const ordered = offset === 0 ? [...page.items.map(item => merged.get(item.key)!), ...existing.filter(item => !page.items.some(row => row.key === item.key))]
          : [...existing, ...page.items.filter(item => !existing.some(old => old.key === item.key)).map(item => merged.get(item.key)!)]
        return { items: ordered, next: page.next_offset, busy: false }
      })
    } catch (error) { if (mounted.current) setStateData(current => ({ ...current, error: errorText(error), busy: false })) }
    finally { loading.current = false; if (mounted.current) setStateData(current => ({ ...current, busy: false })) }
  }
  useEffect(() => {
    let active = true
    mounted.current = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      if (active) await load(0)
      if (active) timer = setTimeout(() => { void poll() }, document.hidden ? 24_000 : 4_000)
    }
    void poll()
    const shown = () => { if (!document.hidden && active) { clearTimeout(timer); void poll() } }
    document.addEventListener('visibilitychange', shown)
    return () => { active = false; mounted.current = false; clearTimeout(timer); document.removeEventListener('visibilitychange', shown) }
  }, [call])
  return <div className="dt-room-page"><PageHead title={t('room.title')}>
    {state?.mode === 'personal' && <Button variant="primary" size="sm" icon={<Icon name="plus" size={14} />}
      onClick={() => navigate({ page: 'tasks' })}>{t('webTask.newTask')}</Button>}
  </PageHead>
    {failure && <p className="dt-error" role="alert">{failure} <Button size="sm" variant="outline" onClick={() => { void load() }}>{t('retry')}</Button></p>}
    <Section title={t('room.list')} count={items.length}>
      {!items.length && !busy ? <Hint>{t('room.listEmpty')}</Hint> : <ul className="dt-list">{items.map(room => <li className="dt-row dt-link" key={room.key}>
        <Dot state={room.pending ? 'warning' : 'ongoing'} />
        <div className="dt-row-main"><div className="dt-row-title"><button type="button" className="dt-open dt-open-wrap"
          onClick={() => navigate({ page: 'rooms', id: room.key })}>{room.title || t('room.untitled')}</button></div>
          <div className="dt-row-meta"><span>{room.source}</span><span>{t('room.workerCount', { count: room.workers.length })}</span>
            <time dateTime={room.updatedAt}>{when(room.updatedAt, t('lang'))}</time></div>
        </div>
      </li>)}</ul>}
      {next !== null && items.length > 0 && <Button variant="outline" size="sm" disabled={busy} onClick={() => { void load(next ?? 0) }}>
        {busy ? t('loading') : t('loadMore')}</Button>}
    </Section>
  </div>
}

export function RoomsPage({ id }: { id?: string }) { return id ? <Room id={id} /> : <RoomList /> }
