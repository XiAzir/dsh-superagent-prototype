/** First-class web task entry for personal mode. */
import { useRef, useState, type FormEvent } from 'react'
import type { WebTaskSummary, WebTaskView } from '../app/web-tasks.ts'
import { Button, Dot, Icon, Tag } from './controls.tsx'
import { usePoll } from './api.ts'
import type { DshSuperagentKey } from './locales.ts'
import { usePanel } from './provider.tsx'
import { errorText, valueLabel, when } from './text.ts'
import { Hint, LoadState, MarkdownLite, PageHead, Section } from './widgets.tsx'
import { ArtifactDownload } from './artifacts.tsx'

const statusKey = (status: WebTaskSummary['status']): DshSuperagentKey => `webTask.status.${status}`
const statusTone = (status: WebTaskSummary['status']) => status === 'done' ? 'success'
  : status === 'working' ? 'info' : status === 'person' ? 'warning' : 'neutral'
const dotState = (status: WebTaskSummary['status']) => status === 'done' ? 'done'
  : status === 'working' || status === 'queued' ? 'ongoing' : status === 'person' ? 'warning' : 'idle'

function TaskComposer({ task, onCreated, onMessage }: { task?: WebTaskView; onCreated: (task: WebTaskView) => void
  onMessage: (task: WebTaskView) => void }) {
  const { t, call } = usePanel()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  const sending = useRef(false)
  const pending = useRef<{ text: string; requestId: string }>()
  const create = !task
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const message = text.trim()
    if (sending.current || !message || message.length > 16_000) return
    if (!pending.current || pending.current.text !== message) pending.current = { text: message, requestId: crypto.randomUUID() }
    sending.current = true; setBusy(true); setFailure('')
    try {
      const body = pending.current
      const result = create
        ? await call('POST web/tasks', { body })
        : await call('POST web/tasks/:id/messages', { id: task.id, body })
      pending.current = undefined
      setText('')
      if (create) onCreated(result)
      else onMessage(result)
    } catch (error) {
      setFailure(errorText(error))
    } finally {
      sending.current = false; setBusy(false)
    }
  }
  const label = create ? t('webTask.newPrompt') : t('webTask.followup')
  return <form className="dt-form dt-web-task-composer" onSubmit={event => { void submit(event) }}>
    <label className="dt-field">
      <span className="dt-field-head">{label}</span>
      <textarea id={create ? 'dt-web-task-input' : undefined} autoFocus={create} className="dt-textarea" rows={create ? 5 : 3}
        maxLength={16_000} value={text} disabled={busy}
        aria-label={label} placeholder={t(create ? 'webTask.newPlaceholder' : 'webTask.followupPlaceholder')}
        onChange={event => { setText(event.target.value); setFailure('') }} />
      <small>{t('webTask.charCount', { count: text.trim().length })}</small>
    </label>
    {failure && <p className="dt-error" role="alert">{failure}</p>}
    <div className="dt-row-actions">
      <Button type="submit" variant="primary" disabled={busy || !text.trim() || text.trim().length > 16_000}
        icon={<Icon name={busy ? 'running' : 'plus'} size={14} />}>
        {busy ? t('webTask.sending') : t(create ? 'webTask.create' : 'webTask.send')}
      </Button>
    </div>
  </form>
}

function TaskList({ items, selectedId }: { items: WebTaskSummary[]; selectedId?: string }) {
  const { t, navigate } = usePanel()
  if (!items.length) return <div className="dt-web-task-empty"><Hint>{t('webTask.empty')}</Hint>
    <p className="dt-hint">{t('webTask.emptyHint')}</p></div>
  return <ul className="dt-list dt-web-task-list">{items.map(item => <li key={item.id} className="dt-row dt-link"
    data-selected={item.id === selectedId || undefined}>
    <Dot state={dotState(item.status)} label={t(statusKey(item.status))} />
    <div className="dt-row-main">
      <div className="dt-row-title"><button type="button" className="dt-open dt-open-wrap" onClick={() => navigate({ page: 'tasks', id: item.id })}>
        {item.title || t('webTask.untitled')}
      </button></div>
      <div className="dt-row-meta"><Tag tone={statusTone(item.status)}>{t(statusKey(item.status))}</Tag>
        <span>{t('webTask.updated')}</span><time dateTime={item.updatedAt}>{when(item.updatedAt, t('lang'))}</time>
      </div>
      {item.tickets.length > 0 && <div className="dt-row-meta">{t('webTask.ticketCount', { count: item.tickets.length })}</div>}
    </div>
  </li>)}</ul>
}

function TaskThread({ task, onUpdated }: { task: WebTaskView; onUpdated: (task: WebTaskView) => void }) {
  const { t, navigate } = usePanel()
  return <>
    <PageHead title={task.title || t('webTask.untitled')}>
      <Button variant="outline" size="sm" onClick={() => navigate({ page: 'rooms', id: `web:${task.id}` })}>{t('room.view')}</Button>
      <Tag tone={statusTone(task.status)}>{t(statusKey(task.status))}</Tag>
    </PageHead>
    <div className="dt-row-meta dt-status-line">
      <span>{t('webTask.created')} <time dateTime={task.createdAt}>{when(task.createdAt, t('lang'))}</time></span>
      <span>{t('webTask.updated')} <time dateTime={task.updatedAt}>{when(task.updatedAt, t('lang'))}</time></span>
    </div>
    {task.error && <p className="dt-banner dt-danger" role="status">{task.error}</p>}
    {task.tickets.length > 0 && <Section title={t('webTask.relatedTickets')} count={task.tickets.length}>
      <ul className="dt-list">{task.tickets.map(ticket => <li className="dt-row dt-link" key={ticket.id}>
        <Dot state={ticket.stage === 'ended' ? 'done' : 'ongoing'} />
        <div className="dt-row-main"><div className="dt-row-title"><button type="button" className="dt-open dt-open-wrap"
          onClick={() => navigate({ page: 'execution', id: ticket.id })}>{ticket.title}</button></div>
          <div className="dt-row-meta"><span>{ticket.stage === 'ended' ? t('ticket.ended')
            : ticket.stage === 'person' ? t('webTask.status.person') : valueLabel(t, 'stage', ticket.stage)}</span></div>
        </div>
      </li>)}</ul>
    </Section>}
    <Section title={t('webTask.conversation')} count={task.messages.length}>
      {task.messages.length === 0 ? <Hint>{t('webTask.waiting')}</Hint> : <ol className="dt-web-task-messages" aria-label={t('webTask.conversation')}>
        {task.messages.map(message => <li key={message.id} className={`dt-web-task-message dt-web-task-${message.role}`}>
          <div className="dt-web-task-message-head"><strong>{t(message.role === 'user' ? 'webTask.you' : 'webTask.assistant')}</strong>
            <time dateTime={message.at}>{when(message.at, t('lang'))}</time></div>
          {message.role === 'assistant' ? <MarkdownLite text={message.text} />
            : <div className="dt-web-task-user-text">{message.text}</div>}
          {!!message.artifacts?.length && <ul className="dt-web-task-artifacts">
            {message.artifacts.map(artifact => <li key={artifact.id}><ArtifactDownload conversation={task.id} artifact={artifact} /></li>)}
          </ul>}
        </li>)}
      </ol>}
    </Section>
    {task.tickets.some(ticket => ticket.summary.trim() && !task.messages.some(message => message.role === 'assistant' && message.text === ticket.summary)) &&
      <Section title={t('webTask.ticketResults')}>
        <div className="dt-web-task-results">{task.tickets.filter(ticket => ticket.summary.trim() && !task.messages.some(message => message.role === 'assistant' && message.text === ticket.summary)).map(ticket => <article key={ticket.id}>
          <h3>{ticket.title}</h3><MarkdownLite text={ticket.summary} />
        </article>)}</div>
      </Section>}
    <TaskComposer task={task} onCreated={onUpdated} onMessage={onUpdated} />
  </>
}

export function PersonalPage({ id }: { id?: string }) {
  const { t, call, navigate } = usePanel()
  const tasks = usePoll(() => call('GET web/tasks', { query: { limit: 50 } }), [], 4000)
  const selected = usePoll(() => id ? call('GET web/tasks/:id', { id }) : Promise.resolve(undefined), [id], 4000)
  const [older, setOlder] = useState<WebTaskSummary[]>([])
  const [nextOffset, setNextOffset] = useState<number | null | undefined>(undefined)
  const [moreBusy, setMoreBusy] = useState(false)
  const [moreError, setMoreError] = useState('')
  const list: WebTaskSummary[] = [...tasks.data?.items ?? [], ...older.filter(item => !tasks.data?.items.some(latest => latest.id === item.id))]
  const loadMore = async () => {
    const offset = nextOffset === undefined ? tasks.data?.next_offset : nextOffset
    if (offset === null || offset === undefined || moreBusy) return
    setMoreBusy(true); setMoreError('')
    try {
      const page = await call('GET web/tasks', { query: { offset, limit: 50 } })
      setOlder(current => [...current, ...page.items.filter(item => !current.some(existing => existing.id === item.id))])
      setNextOffset(page.next_offset)
    } catch (error) { setMoreError(errorText(error)) }
    finally { setMoreBusy(false) }
  }
  const created = (task: WebTaskView) => navigate({ page: 'rooms', id: `web:${task.id}` })
  return <div className="dt-web-task-page">
    {id ? <>
      {selected.data ? <><LoadState error={selected.error} loading={false} /><TaskThread key={selected.data.id} task={selected.data}
        onUpdated={() => { void selected.reload(); void tasks.reload() }} /></>
        : <><PageHead title={t('webTask.title')}><Button variant="outline" size="sm" icon={<Icon name="plus" size={14} />}
          onClick={() => navigate({ page: 'tasks' })}>{t('webTask.newTask')}</Button></PageHead>
          <LoadState error={selected.error} loading={!selected.data} /></>}
    </> : <>
      <PageHead title={t('webTask.title')}>
        <Button variant="primary" size="sm" icon={<Icon name="plus" size={14} />} onClick={() => document.getElementById('dt-web-task-input')?.focus()}>
          {t('webTask.newTask')}
        </Button>
      </PageHead>
      <Section title={t('webTask.newTask')}>
        <TaskComposer onCreated={created} onMessage={created} />
      </Section>
      <Section title={t('webTask.taskList')} count={list.length}>
        {!tasks.data && <LoadState error={tasks.error} loading />}
        {tasks.data && <TaskList items={list} />}
        {moreError && <p className="dt-error" role="alert">{moreError}</p>}
        {(nextOffset === undefined ? tasks.data?.next_offset !== null : nextOffset !== null) && tasks.data && <Button variant="outline" size="sm"
          disabled={moreBusy} icon={<Icon name={moreBusy ? 'running' : 'chevron-down'} size={14} />} onClick={() => { void loadMore() }}>
          {t(moreBusy ? 'webTask.loadingMore' : 'loadMore')}
        </Button>}
      </Section>
    </>}
  </div>
}
