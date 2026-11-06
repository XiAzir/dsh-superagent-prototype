/** First-class web task entry for personal mode. */
import { useEffect, useRef } from 'react'
import type { WebTaskSummary, WebTaskView } from '../app/web-tasks.ts'
import { Button, Dot, Icon, Tag } from './controls.tsx'
import { usePoll } from './api.ts'
import type { DshSuperagentKey } from './locales.ts'
import { usePanel } from './provider.tsx'
import { valueLabel, when } from './text.ts'
import { Hint, LoadState, MarkdownLite, PageHead, Section } from './widgets.tsx'
import { ArtifactDownload } from './artifacts.tsx'
import { MessageComposer, MessageImages } from './message-composer.tsx'

const statusKey = (status: WebTaskSummary['status']): DshSuperagentKey => `webTask.status.${status}`
const statusTone = (status: WebTaskSummary['status']) => status === 'done' ? 'success'
  : status === 'working' ? 'info' : status === 'person' ? 'warning' : 'neutral'
const dotState = (status: WebTaskSummary['status']) => status === 'done' ? 'done'
  : status === 'working' || status === 'queued' ? 'ongoing' : status === 'person' ? 'warning' : 'idle'

function TaskComposer({ task, onCreated, onMessage }: { task?: WebTaskView; onCreated: (task: WebTaskView) => void
  onMessage: (task: WebTaskView) => void }) {
  const { t, call } = usePanel()
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const create = !task, chinese = t('lang') === 'zh'
  const starterLabels = chinese ? ['分析与研究', '编写与修改', '检查与排障'] : ['Research & analysis', 'Create & edit', 'Review & debug']
  const starterTexts = chinese
    ? ['请帮我研究：\n\n背景：\n期望结果：', '请帮我完成：\n\n相关资料或路径：\n验收标准：', '请帮我检查：\n\n遇到的问题：\n已有线索：']
    : ['Please research:\n\nContext:\nExpected result:', 'Please create or edit:\n\nReferences or paths:\nAcceptance criteria:', 'Please investigate:\n\nProblem:\nAvailable evidence:']
  return <MessageComposer draftKey={`superagent/task-draft/${task?.id ?? 'new'}`} call={call} t={t}
    label={t(create ? 'webTask.newPrompt' : 'webTask.followup')} placeholder={t(create ? 'webTask.newPlaceholder' : 'webTask.followupPlaceholder')}
    submitLabel={t(create ? 'webTask.create' : 'webTask.send')} textareaId={create ? 'dt-web-task-input' : undefined}
    rows={create ? 5 : 3} autoFocus={create} starters={create ? starterLabels.map((label, index) => ({ label, text: starterTexts[index]! })) : undefined}
    onSend={async ({ text, requestId, attachmentIds }) => {
      const body = { text, requestId, ...(attachmentIds.length ? { attachmentIds } : {}) }
      const result = create ? await call('POST web/tasks', { body }) : await call('POST web/tasks/:id/messages', { id: task.id, body })
      if (mounted.current) { if (create) onCreated(result); else onMessage(result) }
    }} />
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
          <MessageImages attachments={message.attachments} />
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
  const selected = usePoll(() => id ? call('GET web/tasks/:id', { id }) : Promise.resolve(undefined), [id], 4000)
  const chinese = t('lang') === 'zh'
  const created = (task: WebTaskView) => navigate({ page: 'rooms', id: `web:${task.id}` })
  return <div className="dt-web-task-page sa-new-task-page">
    {id ? <>
      {selected.data ? <><LoadState error={selected.error} loading={false} /><TaskThread key={selected.data.id} task={selected.data}
        onUpdated={() => { void selected.reload() }} /></>
        : <><PageHead title={t('webTask.title')}><Button variant="outline" size="sm" icon={<Icon name="plus" size={14} />}
          onClick={() => navigate({ page: 'tasks' })}>{t('webTask.newTask')}</Button></PageHead>
          <LoadState error={selected.error} loading={!selected.data} /></>}
    </> : <>
      <button type="button" className="sa-back" onClick={() => navigate({ page: 'rooms' })}><Icon name="chevron-left" />{chinese ? '全部任务' : 'All tasks'}</button>
      <div className="sa-page-intro"><div className="sa-eyebrow">{chinese ? '把目标交给 SUPERAGENT' : 'MAKE ROOM FOR YOUR NEXT IDEA'}</div>
        <h2>{chinese ? '想完成什么？' : 'What would you like to accomplish?'}</h2>
        <p>{chinese ? '写下目标、已有背景和期望结果。任务创建后，可以随时补充要求和查看进展。' : 'Describe the goal, context and expected result. You can add requirements and follow progress at any time.'}</p></div>
      <div className="sa-new-task-card">
        <TaskComposer onCreated={created} onMessage={created} />
      </div><div className="sa-new-task-guidance"><Icon name="review" size={18} /><p>{chinese
        ? '清楚的目标有助于顺利交付：说明要解决的问题、可使用的资料，以及你希望收到的成果。'
        : 'A clear goal helps delivery: include the problem, available references and the result you want to receive.'}</p></div>
    </>}
  </div>
}
