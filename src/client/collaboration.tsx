/** Two-pane collaboration: member summaries stay beside their own chronological history. */
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { WorkerPanelView, WorkerPanelWorker } from '../app/worker-panel.ts'
import type { RoomActivity, RoomMessage, TaskRoomView } from '../app/task-rooms.ts'
import { usePoll, type Call } from './api.ts'
import { Icon } from './controls.tsx'
import { MessageComposer, MessageImages } from './message-composer.tsx'
import { errorText, type T } from './text.ts'
import { inlines, markdownBlocks } from './markdown.ts'
import CSS from './worker-panel.css?raw'
import { TicketVerification, VerificationBadge, VERIFICATION_CSS } from './verification.tsx'

type Message = RoomMessage & { roomKey?: string }
type ReadingTab = 'progress' | 'conversation' | 'execution'
const copy = (t: T, zh: string, en: string) => t('lang') === 'en' ? en : zh
const memberName = (t: T, number: number) => copy(t, `执行成员 ${number}`, `Worker ${number}`)
const clock = (value: string, t: T) => Number.isNaN(Date.parse(value)) ? ''
  : new Intl.DateTimeFormat(t('lang') === 'en' ? 'en' : 'zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value))
function stored<T>(key: string, fallback: T): T { try { return JSON.parse(sessionStorage.getItem(key) ?? 'null') ?? fallback } catch { return fallback } }
function save(key: string, value: unknown) { try { sessionStorage.setItem(key, JSON.stringify(value)) } catch { /* Reading remains available when storage is full. */ } }
function stateOf(worker: WorkerPanelWorker) {
  return worker.stage === 'working' && worker.action === 'queued' ? 'queued'
    : worker.stage === 'person' ? 'person' : worker.stage === 'ended' ? 'ended' : worker.stage === 'working' ? 'working' : 'idle'
}
function ReportText({ text }: { text: string }) {
  const inline = (value: string) => inlines(value).map((part, index) => part.kind === 'bold' ? <strong key={index}>{part.text}</strong>
    : part.kind === 'code' ? <code key={index}>{part.text}</code> : part.kind === 'link'
      ? <a key={index} href={part.url} target="_blank" rel="noopener noreferrer">{part.text}</a> : <Fragment key={index}>{part.text}</Fragment>)
  return <div className="sa-markdown">{markdownBlocks(text).map((block, index) => block.kind === 'list'
    ? block.ordered ? <ol key={index}>{block.items.map((item, at) => <li key={at}>{inline(item)}</li>)}</ol>
      : <ul key={index}>{block.items.map((item, at) => <li key={at}>{inline(item)}</li>)}</ul>
    : <p key={index} className={block.kind === 'heading' ? 'sa-markdown-heading' : undefined}>{inline(block.text)}</p>)}</div>
}
function Brief({ text, t }: { text: string; t: T }) {
  const [expanded, setExpanded] = useState(false)
  const long = Array.from(text).length > 480 || text.split('\n').length > 10
  return <><ReportText text={long && !expanded ? `${Array.from(text).slice(0, 440).join('')}…` : text} />
    {long && <button className="sa-message-expand" type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? t('workerPanel.fold') : copy(t, '展开全文', 'Read more')}</button>}</>
}
function MemberCard({ worker, number, selected, t, onSelect }: { worker: WorkerPanelWorker; number: number; selected: boolean; t: T; onSelect(): void }) {
  const state = stateOf(worker), summary = worker.attention || worker.waitingFor || worker.summary || t('workerPanel.awaitReport')
  return <button type="button" className={`sa-worker sa-worker-${state}${selected ? ' sa-worker-selected' : ''}`} aria-pressed={selected}
    aria-label={copy(t, `查看${memberName(t, number)}：${worker.title}`, `View ${memberName(t, number)}: ${worker.title}`)} onClick={onSelect}>
    <span className="sa-worker-top"><span className="sa-avatar sa-avatar-worker" aria-hidden="true">{number}</span><strong>{memberName(t, number)}</strong>
      <span className={`sa-state sa-state-${state}`} title={t(`workerPanel.state.${state}`)}><i aria-hidden="true" /><span>{t(`workerPanel.state.${state}`)}</span></span></span>
    <span className="sa-worker-title" title={worker.title}>{worker.title}</span>
    <span className="sa-worker-summary">{summary.replace(/^#+\s*/gm, '').replace(/\*\*|`/g, '')}</span>
    <VerificationBadge acceptance={worker.acceptance} verification={worker.verification} t={t} />
    <time dateTime={worker.updatedAt}>{clock(worker.updatedAt, t)}</time>
  </button>
}
function GroupMessage({ message, numberOf, t }: { message: Message; numberOf(id: string): number; t: T }) {
  const [expanded, setExpanded] = useState(false)
  const workerId = message.actor.ticketId ?? message.ticketId
  const number = workerId ? numberOf(workerId) : 0
  const worker = message.actor.role === 'worker', owner = message.actor.role === 'user'
  const name = worker ? memberName(t, number) : owner ? t('workerPanel.you') : message.actor.role === 'router' ? copy(t, '调度助手', 'Router') : 'Superagent'
  return <li className={`sa-message${owner ? ' sa-message-owner' : ''}`}>
    <span className={`sa-avatar ${worker ? 'sa-avatar-worker' : owner ? 'sa-avatar-owner' : 'sa-avatar-router'}`} aria-hidden="true">{worker ? number : owner ? 'U' : 'R'}</span>
    <div className="sa-message-main"><div className="sa-message-head"><strong>{name}</strong><span>{t(`workerPanel.kind.${message.kind}`)}</span>
      <time dateTime={message.at}>{clock(message.at, t)}</time></div>
      {worker && <div className="sa-message-task">{message.actor.name}</div>}
      <div className="sa-message-bubble">{owner ? <p className="sa-user-text">{message.text}</p> : <Brief text={message.text} t={t} />}
        {owner && !!message.mentions?.length && <div className="sa-message-routing">{message.mentions.map(id => <span key={id}>@{memberName(t, numberOf(id))}</span>)}<small>{message.router ? copy(t, '由 R 协调', 'Via R') : copy(t, '直达成员', 'Direct')}</small></div>}
        <MessageImages attachments={message.attachments ?? []} /></div>
      {message.delivery === 'held' && <small>{t('workerPanel.held')}</small>}
      {message.delivery === 'failed' && <small className="sa-error">{t('workerPanel.deliveryFailed')}</small>}
      {message.details && <button type="button" className="sa-message-expand" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? t('workerPanel.fold') : copy(t, '查看详细说明', 'Show details')}</button>}
      {expanded && message.details && <pre className="sa-message-details">{message.details}</pre>}
    </div>
  </li>
}
function reportLabel(message: Message, t: T) {
  const labels: Record<string, [string, string]> = { progress: ['阶段进展', 'Progress'], waiting: ['等待中', 'Waiting'], ready: ['完成结果', 'Result'],
    blocked: ['遇到阻碍', 'Blocked'], failed: ['执行失败', 'Failed'], dropped: ['任务结束', 'Closed'] }
  const label = labels[message.reportState ?? 'progress'] ?? labels.progress!
  return copy(t, label[0], label[1])
}
const merge = (messages: Message[]) => [...new Map(messages.map(message => [message.id, message])).values()].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))

/** Each member loads their own journal pages, independent of the bounded overall activity feed. */
function MemberReading({ worker, initial, call, t, numberOf, readingKey }: { worker?: WorkerPanelWorker; initial: Message[]; call: Call; t: T;
  numberOf(id: string): number; readingKey: string }) {
  const [tab, setTab] = useState<ReadingTab>(() => {
    const saved = stored<ReadingTab>(`${readingKey}/tab`, 'progress')
    return ['progress', 'conversation', 'execution'].includes(saved) && (worker || saved !== 'execution') ? saved : 'progress'
  })
  const viewport = useRef<HTMLDivElement>(null), nearEnd = useRef(true), priorLast = useRef<string>(), restored = useRef(false)
  const prepend = useRef<{ height: number; top: number }>()
  const [unread, setUnread] = useState(false), [older, setOlder] = useState<Message[]>([]), [loadingMore, setLoadingMore] = useState(false)
  const [pageError, setPageError] = useState('')
  const cursors = useRef(new Map<string, string | null>())
  const roomKeys = worker ? [...new Set(worker.roomKeys?.length ? worker.roomKeys : [worker.roomKey])].sort() : []
  const signature = roomKeys.join('\n')
  const { data: page, error } = usePoll(async () => {
    if (!worker) return { messages: initial, rooms: [] as { key: string; page: TaskRoomView }[] }
    const rooms = await Promise.all(roomKeys.map(async key => ({ key, page: await call('GET rooms/:key', { key, query: { workerId: worker.id, limit: 30 } }) })))
    return { messages: merge(rooms.flatMap(({ key, page }) => page.messages.map(message => ({ ...message, roomKey: key })))), rooms }
  }, [call, worker?.id, signature, worker ? '' : JSON.stringify(initial)], 3000)
  const earlierPages = (page?.rooms ?? []).map(room => [room.key, cursors.current.has(room.key) ? cursors.current.get(room.key) : room.page.earlier] as const)
    .filter((entry): entry is readonly [string, string] => !!entry[1])
  const messages = merge([...older, ...(page?.messages ?? initial)])
  const visible = tab === 'progress' ? messages.filter(message => message.kind === 'report' && message.actor.role === 'worker') : messages
  const last = visible.at(-1)?.id
  const scrollKey = `${readingKey}/scroll/${tab}`
  useLayoutEffect(() => { save(`${readingKey}/tab`, tab); restored.current = false; priorLast.current = undefined; setUnread(false) }, [tab, readingKey])
  useLayoutEffect(() => {
    const element = viewport.current
    if (!element) return
    if (prepend.current) { element.scrollTop = prepend.current.top + element.scrollHeight - prepend.current.height; prepend.current = undefined }
    else if (!restored.current && page) {
      const position = stored<number | null>(scrollKey, null)
      element.scrollTop = position ?? element.scrollHeight
      nearEnd.current = element.scrollHeight - element.scrollTop - element.clientHeight < 60
      restored.current = true
    } else if (priorLast.current && last !== priorLast.current) {
      if (nearEnd.current) element.scrollTop = element.scrollHeight
      else setUnread(true)
    }
    priorLast.current = last
  }, [last, page, older, scrollKey])
  const loadOlder = async () => {
    if (loadingMore || !worker) return
    setLoadingMore(true); setPageError('')
    const positions = earlierPages
    try {
      const pages = await Promise.all(positions.map(async ([key, before]) => ({ key, page: await call('GET rooms/:key', { key, query: { workerId: worker.id, before, limit: 30 } }) })))
      if (viewport.current) prepend.current = { height: viewport.current.scrollHeight, top: viewport.current.scrollTop }
      for (const item of pages) cursors.current.set(item.key, item.page.earlier)
      setOlder(current => merge([...current, ...pages.flatMap(({ key, page }) => page.messages.map(message => ({ ...message, roomKey: key })))]))
    } catch (failure) { setPageError(errorText(failure)) }
    finally { setLoadingMore(false) }
  }
  const jump = () => { if (viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight; nearEnd.current = true; setUnread(false) }
  const tabs: { id: ReadingTab; label: string }[] = [{ id: 'progress', label: copy(t, '阶段简述', 'Progress') }, { id: 'conversation', label: copy(t, '协作对话', 'Conversation') },
    ...worker ? [{ id: 'execution' as const, label: copy(t, '执行记录', 'Execution') }] : []]
  return <div className="sa-reading">
    <div className="sa-reading-tabs" role="tablist" aria-label={copy(t, '成员内容', 'Member content')} onKeyDown={event => {
      const index = tabs.findIndex(item => item.id === tab)
      const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index - 1 + tabs.length) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1
      if (next < 0) return
      event.preventDefault(); setTab(tabs[next]!.id)
      ;(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next])?.focus()
    }}>{tabs.map(item => <button type="button" role="tab" key={item.id} id={`${readingKey}-${item.id}`} aria-controls={`${readingKey}-reading`}
      aria-selected={tab === item.id} tabIndex={tab === item.id ? 0 : -1} onClick={() => setTab(item.id)}>{item.label}</button>)}</div>
    <div className="sa-reading-scroll" role="tabpanel" id={`${readingKey}-reading`} aria-labelledby={`${readingKey}-${tab}`} ref={viewport} tabIndex={0}
      onScroll={() => { const element = viewport.current; if (element) { nearEnd.current = element.scrollHeight - element.scrollTop - element.clientHeight < 60; save(scrollKey, element.scrollTop); if (nearEnd.current) setUnread(false) } }}>
      {(error || pageError) && <p className="sa-error" role="alert">{pageError || error?.message}</p>}
      {tab === 'execution' && worker ? <Execution worker={worker} call={call} t={t} /> : <>
        {earlierPages.length > 0 && <button type="button" className="sa-load-history" disabled={loadingMore} onClick={() => { void loadOlder() }}>{copy(t, loadingMore ? '正在加载…' : '查看更早记录', loadingMore ? 'Loading…' : 'Earlier history')}</button>}
        {tab === 'progress' ? <ol className="sa-timeline">{visible.map(message => <li key={message.id} className="sa-timeline-entry">
          <div className="sa-timeline-meta"><strong>{reportLabel(message, t)}</strong>{!worker && <span>{memberName(t, numberOf(message.actor.ticketId ?? message.ticketId ?? ''))}</span>}
            <time dateTime={message.at}>{clock(message.at, t)}</time></div>
          {!worker && <p className="sa-message-task">{message.actor.name}</p>}<Brief text={message.text} t={t} /></li>)}</ol>
          : <ol className="sa-message-list">{visible.map(message => <GroupMessage key={message.id} message={message} numberOf={numberOf} t={t} />)}</ol>}
        {!visible.length && <div className="sa-feed-empty"><Icon name={tab === 'progress' ? 'clock' : 'message'} size={24} /><p>{copy(t, tab === 'progress' ? '阶段简述将在这里持续更新' : '协作消息将在这里显示', tab === 'progress' ? 'Progress updates will appear here' : 'Conversation will appear here')}</p>
          {tab === 'progress' && worker?.summary && <Brief text={worker.summary} t={t} />}</div>}
      </>}
    </div>
    {unread && <button type="button" className="sa-new-messages" onClick={jump}>{copy(t, '有新动态', 'New updates')}<Icon name="chevron-down" size={13} /></button>}
  </div>
}
function Execution({ worker, call, t }: { worker: WorkerPanelWorker; call: Call; t: T }) {
  const { data, error } = usePoll(() => call('GET rooms/:key/workers/:ticketId/activity', { key: worker.roomKey, ticketId: worker.id, query: { limit: 30 } }), [call, worker.id, worker.roomKey], 5000)
  const [older, setOlder] = useState<RoomActivity['items']>([]), [cursor, setCursor] = useState<number | null | undefined>(), [failure, setFailure] = useState(''), [busy, setBusy] = useState(false)
  const more = async () => {
    const offset = cursor === undefined ? data?.next_offset : cursor
    if (offset == null || busy) return
    setBusy(true); setFailure('')
    try { const page = await call('GET rooms/:key/workers/:ticketId/activity', { key: worker.roomKey, ticketId: worker.id, query: { offset, limit: 30 } }); setOlder(current => [...current, ...page.items]); setCursor(page.next_offset) }
    catch (failure) { setFailure(errorText(failure)) } finally { setBusy(false) }
  }
  const items = [...new Map([...(data?.items ?? []), ...older].map(item => [item.id, item])).values()]
  return <div className="sa-execution">{(error || failure) && <p className="sa-error" role="alert">{failure || error?.message}</p>}
    {!data && !error && <p className="sa-muted">{t('loading')}</p>}
    {items.length ? <ol>{items.map(item => <li key={item.id}><span>{item.type}</span><pre>{item.text}</pre></li>)}</ol> : data && <p className="sa-muted">{t('room.noActivity')}</p>}
    {(cursor === undefined ? data?.next_offset : cursor) != null && <button type="button" className="sa-load-history" disabled={busy} onClick={() => { void more() }}>{copy(t, '加载更多执行记录', 'More execution records')}</button>}</div>
}

export function WorkerPanel({ sessionId, call, t, openSession }: { sessionId: string; call: Call; t: T; openSession(id: string): Promise<void> }) {
  const { data: snapshot, error, reload } = usePoll(() => call('GET sessions/:id/workers', { id: sessionId }), [call, sessionId], 2000)
  const data = snapshot?.sessionId === sessionId ? snapshot : undefined
  const selectionKey = `superagent/collaboration/${sessionId}`
  const [selected, setSelected] = useState(() => stored<string>(`${selectionKey}/member`, 'all'))
  const [query, setQuery] = useState(''), [navigationError, setNavigationError] = useState('')
  const numbers = useRef(new Map<string, number>(stored<[string, number][]>(`${selectionKey}/numbers`, [])))
  const workers = data?.workers ?? []
  for (const worker of workers) if (!numbers.current.has(worker.id)) numbers.current.set(worker.id, numbers.current.size + 1)
  useEffect(() => { save(`${selectionKey}/numbers`, [...numbers.current]) }, [selectionKey, workers.length])
  const numberOf = (id: string) => numbers.current.get(id) ?? 0
  const worker = workers.find(item => item.id === selected)
  const scope = worker?.id ?? 'all'
  const visibleWorkers = workers.filter(item => `${memberName(t, numberOf(item.id))} ${item.title} ${item.summary}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
  const choose = (id: string) => { setSelected(id); save(`${selectionKey}/member`, id); setNavigationError('') }
  return <aside className="sa-panel" aria-label={t('workerPanel.title')}>
    <style>{CSS}{VERIFICATION_CSS}</style><header className="sa-panel-head"><div><span className="sa-eyebrow">SUPERAGENT</span><h2>{t('workerPanel.title')}</h2></div>
      <button type="button" className="sa-icon-button" aria-label={t('workerPanel.refresh')} title={t('workerPanel.refresh')} onClick={() => { void reload() }}><Icon name="refresh" size={16} /></button></header>
    {error && <div className="sa-panel-warning" role="alert">{error.message}<button onClick={() => { void reload() }}>{t('retry')}</button></div>}
    {!data && !error && <p className="sa-empty">{t('loading')}</p>}
    {data && !data.eligible && <p className="sa-empty">{t('workerPanel.unrelated')}</p>}
    {data?.eligible && <><div className="sa-group-summary"><span className="sa-avatar sa-avatar-router" aria-hidden="true">R</span><div><strong>{data.scope === 'router' ? copy(t, '全部任务的协作进展', 'All task collaboration') : t('workerPanel.thisConversation')}</strong>
      <p role="status">{copy(t, `${workers.length} 位执行成员 · ${workers.filter(item => stateOf(item) === 'working').length} 进行中 · ${workers.filter(item => stateOf(item) === 'person').length} 待确认`, t('workerPanel.counts', { total: workers.length, running: workers.filter(item => stateOf(item) === 'working').length, waiting: workers.filter(item => stateOf(item) === 'person').length }))}</p></div></div>
      {data.paused && <p className="sa-panel-warning">{t('workerPanel.paused')}</p>}
      <div className="sa-collaboration-split"><nav className="sa-member-rail" aria-label={copy(t, '执行成员', 'Workers')}>
        <label className="sa-member-search"><Icon name="search" size={14} /><input type="search" aria-label={copy(t, '搜索执行成员', 'Search workers')} value={query} placeholder={copy(t, '搜索成员或任务', 'Search members')} onChange={event => setQuery(event.target.value)} /></label>
        <div className="sa-member-scroll"><button type="button" className={`sa-overview-member${scope === 'all' ? ' sa-worker-selected' : ''}`} aria-pressed={scope === 'all'} onClick={() => choose('all')}><span className="sa-avatar sa-avatar-router" aria-hidden="true">R</span><span><strong>{copy(t, '全部协作', 'All activity')}</strong><small>{copy(t, '查看最近动态', 'Recent updates')}</small></span></button>
          {visibleWorkers.map(item => <MemberCard key={item.id} worker={item} number={numberOf(item.id)} selected={scope === item.id} t={t} onSelect={() => choose(item.id)} />)}
          {!visibleWorkers.length && <p className="sa-rail-empty">{copy(t, query ? '没有匹配的成员' : '任务开始后显示执行成员', query ? 'No matching members' : 'Workers appear when tasks start')}</p>}</div>
      </nav><section className="sa-member-detail" aria-label={worker ? memberName(t, numberOf(worker.id)) : copy(t, '全部协作详情', 'All activity detail')}>
        <header className="sa-detail-head"><div><strong>{worker ? memberName(t, numberOf(worker.id)) : copy(t, '全部协作', 'All activity')}</strong>
          {worker && <span className={`sa-state sa-state-${stateOf(worker)}`}><i aria-hidden="true" />{t(`workerPanel.state.${stateOf(worker)}`)}</span>}
          <h3>{worker ? worker.title : copy(t, '各成员的阶段进展与协作消息', 'Progress and conversation across workers')}</h3></div>
          {worker?.sessionId && <button className="sa-icon-button" type="button" title={copy(t, '打开完整会话', 'Open full session')} aria-label={t('workerPanel.openWorker', { number: numberOf(worker.id) })} onClick={() => { void openSession(worker.sessionId).catch(failure => setNavigationError(errorText(failure))) }}><Icon name="external" size={15} /></button>}</header>
        {navigationError && <p className="sa-panel-warning" role="alert">{navigationError}</p>}
        {worker?.attention && <div className="sa-attention-banner"><Icon name="ask" size={15} /><span>{worker.attention}</span></div>}
        {worker && <TicketVerification key={`verification-${worker.id}`} id={worker.id} acceptance={worker.acceptance} verification={worker.verification}
          hold={worker.hold} call={call} t={t} onChanged={reload} />}
        <MemberReading key={scope} worker={worker} initial={data.messages.filter(message => !worker || message.ticketId === worker.id || message.actor.ticketId === worker.id || message.recipient === worker.id)}
          call={call} t={t} numberOf={numberOf} readingKey={`${selectionKey}/${scope}`} />
      </section></div>
      <div className="sa-panel-composer"><MessageComposer key={sessionId} draftKey={`superagent/collaboration-draft/${sessionId}`} call={call} t={t}
        label={copy(t, '协作消息', 'Collaboration message')} placeholder={copy(t, '补充要求，输入 @ 选择成员，支持粘贴图片…', 'Add a request, @ a worker, or paste an image…')}
        workers={workers.map(item => ({ id: item.id, name: memberName(t, numberOf(item.id)), title: item.title, active: item.active, subscribed: item.subscribed }))}
        sendDisabled={data.paused || !data.rooms.length} rows={2} onSend={async payload => { await call('POST sessions/:id/collaboration', { id: sessionId, body: payload }); await reload() }} /></div>
    </>}
  </aside>
}
