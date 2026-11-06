/** Personal-mode task rooms: one shared Router/Worker timeline with lazy, bounded execution details. */
import { useEffect, useRef, useState } from 'react'
import type { RoomActivity, RoomMessage, TaskRoomSummary, TaskRoomView } from '../app/task-rooms.ts'
import { Button, Dot, Icon, Input, Tag } from './controls.tsx'
import { ArtifactDownload } from './artifacts.tsx'
import { usePoll } from './api.ts'
import { usePanel, usePanelData } from './provider.tsx'
import { errorText, when } from './text.ts'
import { Hint, LoadState, MarkdownLite, PageHead, Section, SessionButton } from './widgets.tsx'
import { useSessionDraft } from './session-draft.ts'
import { roomStatus, roomTitle, sourceLabel } from './task-ui.ts'
import { MessageComposer, MessageImages } from './message-composer.tsx'
import { TicketVerification, VerificationBadge } from './verification.tsx'
import { TaskEnvironment, TaskFeedback } from './remote-environments.tsx'

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
  return <li>
    <span className="dt-room-activity-type">{item.type}</span>
    <pre>{item.text}</pre>
  </li>
}

function WorkerList({ room }: { room: TaskRoomView }) {
  const { t, call } = usePanel()
  const [expanded, setExpanded] = useState<string[]>([])
  return <Section title={t('room.workers')} count={room.workers.length}>
    {!room.workers.length ? <Hint>{t('room.noWorkers')}</Hint> : <ul className="dt-room-workers">{room.workers.map(worker => {
      const open = expanded.includes(worker.id)
      return <li key={worker.id}>
        <div className="dt-room-worker">
          <Dot state={worker.active ? 'ongoing' : 'idle'} label={t(worker.active ? 'room.active' : 'room.stopped')} />
          <div className="dt-row-main"><div className="dt-room-worker-title">{worker.title}</div>
            <div className="dt-row-meta"><span>{shortWorkerId(worker.id, room.workers)}</span><span>{roomStatus({ ...room, workers: [worker], pending: false }, t('lang') === 'zh').label}</span>
              <Tag tone={worker.subscribed ? 'info' : 'neutral'}>{t(worker.subscribed ? 'room.subscribed' : 'room.unsubscribed')}</Tag>
            </div>
            {worker.summary && <MarkdownLite text={worker.summary} />}
            <VerificationBadge acceptance={worker.acceptance} verification={worker.verification} t={t} />
          </div>
          <Button variant="ghost" size="sm" aria-expanded={open} onClick={() => setExpanded(current => open
            ? current.filter(id => id !== worker.id) : [...current, worker.id])}>{t(open ? 'room.hideActivity' : 'room.showActivity')}</Button>
        </div>
        {worker.sessionId && <SessionButton sessionId={worker.sessionId} label={t('lang') === 'zh' ? '打开完整执行会话' : 'Open full execution chat'} />}
        <TaskEnvironment id={worker.id} call={call} t={t} />
        <TaskFeedback id={worker.id} call={call} t={t} />
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
function Message({ roomKey, message, workers }: { roomKey: string; message: RoomMessage; workers: TaskRoomView['workers'] }) {
  const { t } = usePanel()
  const [open, setOpen] = useState(false)
  const isUser = message.kind === 'user'
  const hasDetails = !!message.details
  const artifacts = message.artifacts
  return <li className={`dt-room-message${isUser ? ' dt-room-user' : ''}`} data-message-id={message.id}>
    <div className="dt-room-message-head"><strong>{message.actor.role === 'router' ? (t('lang') === 'zh' ? '调度助手' : 'Coordinator')
      : message.actor.role === 'user' ? (t('lang') === 'zh' ? '你' : 'You') : message.actor.name}</strong><time dateTime={message.at}>{when(message.at, t('lang'))}</time></div>
    {!!message.mentions?.length && <div className="dt-row-meta">{message.mentions.map(id => {
      const number = workers.findIndex(worker => worker.id === id) + 1
      return <Tag key={id} tone="info">@{t('lang') === 'zh' ? `执行成员${number ? ` ${number}` : ''}` : `Worker${number ? ` ${number}` : ''}`}</Tag>
    })}{message.router && <span>{t('lang') === 'zh' ? '由 R 协调' : 'Coordinated by R'}</span>}</div>}
    {isUser ? <p className="dt-room-message-text">{message.text}</p> : <MarkdownLite text={message.text} />}
    <MessageImages attachments={message.attachments} />
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
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const paused = room.paused || !!state?.paused
  return <>
    <MessageComposer draftKey={`superagent/room-draft/${room.key}`} call={call} t={t} label={t('room.message')}
      placeholder={t('lang') === 'zh' ? '补充要求，输入 @ 选择执行成员，也可粘贴或拖入图片…' : 'Add a request, @ a worker, paste or drop images…'}
      submitLabel={t('room.send')} disabled={!room.writable} sendDisabled={paused}
      workers={room.workers.map((worker, index) => ({ id: worker.id, name: t('lang') === 'zh' ? `执行成员 ${index + 1}` : `Worker ${index + 1}`,
        title: worker.title, active: worker.active, subscribed: worker.subscribed }))}
      onSend={async ({ text, requestId, router, mentions, attachmentIds }) => {
        await call('POST rooms/:key/messages', { key: room.key, body: { text, requestId, router, mentions,
          ...(attachmentIds.length ? { attachmentIds } : {}) } })
        if (mounted.current) onSent()
      }} />
    {!room.writable && <p className="dt-hint">{t('room.readOnly')}</p>}
    {paused && <p className="dt-banner" role="status">{t('room.paused')}</p>}
  </>
}

function Room({ id }: { id: string }) {
  const { t, navigate, call } = usePanel()
  const chinese = t('lang') === 'zh'
  const copy = (zh: string, en: string) => chinese ? zh : en
  const { data, error, reload, loadEarlier } = useRoom(id)
  const [tab, setTab] = useSessionDraft<'conversation' | 'collaboration' | 'artifacts' | 'execution'>(`superagent/room-tab/${id}`, 'conversation')
  const [earlierBusy, setEarlierBusy] = useState(false)
  const [earlierFailure, setEarlierFailure] = useState('')
  const [anchorId, setAnchorId] = useState<string>()
  if (!data) return <><PageHead title={t('room.title')} /><LoadState error={error} loading={!error} />
    {error && <Button variant="outline" size="sm" onClick={() => { void reload() }}>{t('retry')}</Button>}</>
  const anchorIndex = anchorId ? data.messages.findIndex(message => message.id === anchorId) : -1
  const end = anchorIndex >= 0 ? anchorIndex + 1 : data.messages.length
  const start = Math.max(0, end - PAGE)
  const visibleMessages = data.messages.slice(start, end)
  const conversation = visibleMessages.filter(message => message.kind === 'user' || message.kind === 'router'
    || message.kind === 'report' || (message.actor.role === 'router' && message.kind !== 'assignment' && message.audience !== 'worker'))
  const latestReply = data.messages.findLast(message => message.actor.role === 'router' && message.kind !== 'assignment'
    && message.audience !== 'worker' && message.text.trim()) ?? data.messages.findLast(message => message.kind === 'report' && message.text.trim())
  const artifacts = [...new Map(data.messages.flatMap(message => (message.artifacts ?? []).map(artifact => [artifact.id, artifact] as const))).values()]
  const status = roomStatus(data, chinese)
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
    <div className="sa-task-heading"><button type="button" className="sa-back" onClick={() => navigate({ page: 'rooms' })}>
      <Icon name="chevron-left" />{copy('全部任务', 'All tasks')}</button>
      <div className="sa-task-title"><h2>{roomTitle(data, chinese)}</h2><Tag tone={status.tone}>{status.label}</Tag></div>
      <div className="dt-row-meta"><span>{sourceLabel(data.source, chinese)}</span><span>{copy('最近更新', 'Updated')} {when(data.updatedAt, t('lang'))}</span>
        <span>{copy(`${data.workers.length} 位执行成员`, `${data.workers.length} workers`)}</span></div></div>
    {error && <><LoadState error={error} loading={false} /><Button variant="outline" size="sm" onClick={() => { void reload() }}>{t('retry')}</Button></>}
    <section className="sa-task-brief" data-state={status.key} aria-label={copy('任务近况', 'Task update')}>
      <div className="sa-eyebrow">{copy('任务近况', 'LATEST UPDATE')}</div>
      {latestReply ? <ReportPreview key={latestReply.id} text={latestReply.text} /> : <p>{data.pending
        ? copy('请求已收到，正在准备下一步。你可以继续补充背景与要求。', 'Your request is received. You can add context while the next step is prepared.')
        : copy('任务动态会集中显示在这里，继续发送消息即可补充要求。', 'Updates will appear here. Send a message to add requirements.')}</p>}
      {!!artifacts.length && <div className="sa-brief-artifacts">{artifacts.map(artifact => <ArtifactDownload key={artifact.id} room={data.key} artifact={artifact} />)}</div>}
    </section>
    {data.workers.map(worker => <TicketVerification key={worker.id} id={worker.id} taskTitle={worker.title}
      acceptance={worker.acceptance} verification={worker.verification} hold={worker.hold} call={call} t={t} onChanged={reload} />)}
    <div className="sa-detail-tabs" role="tablist" aria-label={copy('任务详情', 'Task details')} onKeyDown={event => {
      const tabs = ['conversation', 'collaboration', 'artifacts', 'execution'] as const
      if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const index = tabs.indexOf(tab), next = event.key === 'Home' ? 0 : event.key === 'End' ? 3 : (index + (event.key === 'ArrowRight' ? 1 : -1) + 4) % 4
      setTab(tabs[next]!); requestAnimationFrame(() => document.getElementById(`sa-detail-${tabs[next]}`)?.focus())
    }}>{([
      ['conversation', copy('对话', 'Conversation')], ['collaboration', copy('协作动态', 'Collaboration')],
      ['artifacts', copy('交付物', 'Deliverables')], ['execution', copy('执行详情', 'Execution')],
    ] as const).map(([value, label]) => <button type="button" role="tab" id={`sa-detail-${value}`} key={value} aria-selected={tab === value}
      aria-controls="sa-room-content" tabIndex={tab === value ? 0 : -1} onClick={() => setTab(value)}>{label}
      {value === 'artifacts' && artifacts.length > 0 && <span>{artifacts.length}</span>}</button>)}</div>
    <div id="sa-room-content" role="tabpanel" aria-labelledby={`sa-detail-${tab}`} className="sa-detail-content">
    {(tab === 'conversation' || tab === 'collaboration') && <>
    <Section title={tab === 'conversation' ? copy('任务对话', 'Conversation') : copy('协作时间线', 'Collaboration timeline')}
      action={<Button size="sm" onClick={() => { setAnchorId(undefined); document.getElementById('sa-room-composer')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }) }}>{copy('继续交办', 'Continue task')}<Icon name="chevron-down" size={14} /></Button>}>
      {data.messages.length === 0 ? <Hint>{t('room.empty')}</Hint> : <ol className="dt-room-timeline" aria-label={t('room.timeline')}>
        {(tab === 'conversation' ? conversation : visibleMessages).map(message => <Message key={message.id} roomKey={data.key} message={message} workers={data.workers} />)}
      </ol>}
      {(start > 0 || data.earlier) && <Button variant="outline" size="sm" disabled={earlierBusy} icon={<Icon name="chevron-up" size={14} />}
        onClick={() => { void pageOlder() }}>{t(earlierBusy ? 'loading' : 'loadEarlier')}</Button>}
      {anchorId && end < data.messages.length && <Button variant="outline" size="sm" onClick={pageNewer}>{t('room.loadNewer')}</Button>}
      {earlierFailure && <p className="dt-error" role="alert">{earlierFailure} <Button size="sm" variant="outline" disabled={earlierBusy}
        onClick={() => { void pageOlder() }}>{t('retry')}</Button></p>}
    </Section>
    <div id="sa-room-composer"><Composer room={data} onSent={() => { setAnchorId(undefined); void reload() }} /></div></>}
    {tab === 'artifacts' && <Section title={copy('全部交付物', 'All deliverables')} count={artifacts.length}>
      {artifacts.length ? <div className="sa-artifact-list">{artifacts.map(artifact => <ArtifactDownload key={artifact.id} room={data.key} artifact={artifact} />)}</div>
        : <div className="sa-empty-state"><Icon name="copy" size={28} /><h3>{copy('交付物会收在这里', 'Deliverables will appear here')}</h3>
          <p>{copy('执行过程中生成并交付的文档、代码和附件会自动归档到本任务。', 'Documents, code and attachments delivered during execution will appear in this task.')}</p></div>}
    </Section>}
    {tab === 'execution' && <WorkerList room={data} />}
    </div>
  </div>
}

function ReportPreview({ text }: { text: string }) {
  const { t } = usePanel()
  const [expanded, setExpanded] = useState(false)
  const long = text.length > 700 || text.split('\n').length > 10
  return <><div className={!expanded && long ? 'sa-report-preview' : undefined}><MarkdownLite text={text} /></div>
    {long && <Button size="sm" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
      {t('lang') === 'zh' ? expanded ? '收起报告' : '展开报告' : expanded ? 'Collapse report' : 'Expand report'}
      <Icon name={expanded ? 'chevron-up' : 'chevron-down'} size={14} /></Button>}</>
}

function RoomList() {
  const { t, call, navigate } = usePanel()
  const chinese = t('lang') === 'zh'
  const copy = (zh: string, en: string) => chinese ? zh : en
  const [filters, setFilters] = useSessionDraft('superagent/task-filters', { query: '', status: 'all', source: 'all', sort: 'updated' })
  const listRoot = useRef<HTMLDivElement>(null)
  const restored = useRef(false)
  const [stateData, setStateData] = useState<{ items: TaskRoomSummary[]; next?: number | null; error?: string; busy: boolean }>(
    { items: [], busy: true })
  const items = stateData.items
  const next = stateData.next
  const busy = stateData.busy
  const failure = stateData.error ?? ''
  const statuses = [
    { value: 'all', label: copy('全部任务', 'All tasks') }, { value: 'attention', label: copy('需要我处理', 'Needs me') },
    { value: 'working', label: copy('进行中', 'In progress') }, { value: 'waiting', label: copy('等待后续', 'Waiting') },
    { value: 'ended', label: copy('已结束', 'Ended') },
  ]
  const matchesStatus = (room: TaskRoomSummary, value: string) => value === 'all' || (value === 'working'
    ? ['working', 'queued'].includes(roomStatus(room, chinese).key) : roomStatus(room, chinese).key === value)
  const visible = items.filter(room => matchesStatus(room, filters.status) && (filters.source === 'all' || room.source === filters.source)
    && `${room.title} ${room.workers.map(worker => `${worker.title} ${worker.summary}`).join(' ')}`.toLocaleLowerCase().includes(filters.query.trim().toLocaleLowerCase()))
    .sort((a, b) => filters.sort === 'title' ? roomTitle(a, chinese).localeCompare(roomTitle(b, chinese)) : b.updatedAt.localeCompare(a.updatedAt))
  useEffect(() => {
    if (!items.length || restored.current) return
    restored.current = true
    try { const top = Number(sessionStorage.getItem('superagent/task-list-scroll') ?? 0)
      requestAnimationFrame(() => { const page = listRoot.current?.closest('.dt-page'); if (page) page.scrollTop = top }) } catch { /* List remains usable without storage. */ }
  }, [items.length])
  const open = (room: TaskRoomSummary) => {
    try { sessionStorage.setItem('superagent/task-list-scroll', String(listRoot.current?.closest('.dt-page')?.scrollTop ?? 0)) } catch { /* Optional convenience. */ }
    navigate({ page: 'rooms', id: room.key })
  }
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
  return <div ref={listRoot} className="dt-room-page sa-task-list-page">
    <div className="sa-page-intro"><div className="sa-eyebrow">{copy('所有工作，一处跟进', 'ALL YOUR WORK, TOGETHER')}</div>
      <h2>{copy('任务', 'Tasks')}</h2><p>{copy('查看进展、继续交办，或取回已经交付的结果。', 'Follow progress, continue a task, or find a delivered result.')}</p></div>
    <div className="sa-task-filters" role="group" aria-label={copy('筛选任务', 'Filter tasks')}>
      {statuses.map(status => <button type="button" key={status.value} aria-pressed={filters.status === status.value}
        onClick={() => setFilters(current => ({ ...current, status: status.value }))}>{status.label}
        <span>{items.filter(room => matchesStatus(room, status.value)).length}</span></button>)}
    </div>
    <div className="sa-list-tools"><Input type="search" icon={<Icon name="search" />} value={filters.query}
      aria-label={copy('搜索任务', 'Search tasks')} placeholder={copy('搜索任务目标、进展或关键词…', 'Search goals, updates or keywords…')}
      onChange={event => setFilters(current => ({ ...current, query: event.target.value }))} />
      <label className="sa-inline-field"><span>{copy('来源', 'Source')}</span><select className="dt-select" aria-label={copy('任务来源', 'Task source')} value={filters.source}
        onChange={event => setFilters(current => ({ ...current, source: event.target.value }))}><option value="all">{copy('全部来源', 'All sources')}</option>
        {[...new Set(items.map(room => room.source))].map(source => <option key={source} value={source}>{sourceLabel(source, chinese)}</option>)}</select></label>
      <select className="dt-select sa-list-sort" aria-label={copy('任务排序', 'Sort tasks')} value={filters.sort}
        onChange={event => setFilters(current => ({ ...current, sort: event.target.value }))}><option value="updated">{copy('最近更新', 'Recently updated')}</option>
        <option value="title">{copy('按名称', 'By name')}</option></select>
    </div>
    {failure && <p className="dt-error" role="alert">{failure} <Button size="sm" variant="outline" onClick={() => { void load() }}>{t('retry')}</Button></p>}
    <Section title={copy('任务列表', 'Task list')} count={visible.length}>
      {busy && !items.length && <Hint>{t('loading')}</Hint>}
      {!visible.length && !busy ? <div className="sa-empty-state"><Icon name="search" size={28} />
        <h3>{items.length ? copy('换个条件找找', 'Try another filter') : copy('从一个目标开始', 'Start with a goal')}</h3>
        <p>{items.length ? copy('试试其他关键词，或清除筛选查看全部任务。', 'Try another keyword or clear the filters.')
          : copy('描述想完成的事情，后续进展与交付结果会集中收在这里。', 'Describe what you want to accomplish. Progress and results will stay here.')}</p>
        <Button variant="outline" onClick={() => items.length ? setFilters({ query: '', status: 'all', source: 'all', sort: 'updated' })
          : navigate({ page: 'tasks' })}>{items.length ? copy('清除筛选', 'Clear filters') : copy('交办第一个任务', 'Create your first task')}</Button>
      </div> : <ul className="sa-task-list">{visible.map(room => {
        const status = roomStatus(room, chinese), summary = room.workers.find(worker => worker.summary)?.summary
        return <li key={room.key}><button type="button" className="sa-task-row" onClick={() => open(room)}>
          <span className="sa-task-source" aria-hidden="true"><Icon name={room.source === 'qq' ? 'message' : room.source === 'github' ? 'pull' : 'session'} size={19} /></span>
          <span className="sa-task-row-body"><span className="sa-task-row-title">{roomTitle(room, chinese)}</span>
            <span className="sa-task-row-summary">{summary ? summary.replace(/[#*`]/g, '').split('\n').filter(Boolean).join(' ')
              : room.title !== roomTitle(room, chinese) ? room.title : copy('打开任务查看对话与最新动态', 'Open to view the conversation and latest updates')}</span>
            <span className="sa-task-row-meta"><span>{sourceLabel(room.source, chinese)}</span><span>{copy(`${room.workers.length} 位执行成员`, `${room.workers.length} workers`)}</span></span>
          </span><span className="sa-task-row-end"><Tag tone={status.tone}>{status.label}</Tag>
            <time dateTime={room.updatedAt}>{when(room.updatedAt, t('lang'))}</time></span><Icon name="chevron-right" size={16} />
        </button></li>
      })}</ul>}
      {next !== null && next !== undefined && <Hint>{copy(`当前筛选已载入的 ${items.length} 个任务；可继续载入历史任务。`, `Filtering ${items.length} loaded tasks. Load more to include older tasks.`)}</Hint>}
      {next !== null && items.length > 0 && <Button variant="outline" size="sm" disabled={busy} onClick={() => { void load(next ?? 0) }}>
        {busy ? t('loading') : t('loadMore')}</Button>}
    </Section>
  </div>
}

export function RoomsPage({ id }: { id?: string }) { return id ? <Room id={id} /> : <RoomList /> }
