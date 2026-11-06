/** Personal workbench: actionable work first, then current work and recent task rooms. */
import type { TaskRoomSummary } from '../app/task-rooms.ts'
import { usePoll } from './api.ts'
import { Button, Icon, Tag } from './controls.tsx'
import { ProblemLine } from './overview.tsx'
import { usePanel, usePanelData } from './provider.tsx'
import { TicketLine } from './rows.tsx'
import { roomStatus, roomTitle, sourceLabel } from './task-ui.ts'
import { when } from './text.ts'
import { LoadState, Section } from './widgets.tsx'

function RoomPreview({ room }: { room: TaskRoomSummary }) {
  const { t, navigate } = usePanel()
  const chinese = t('lang') !== 'en'
  const status = roomStatus(room, chinese)
  const latest = room.workers.find(worker => worker.summary)?.summary
  return <li><button type="button" className="sa-workbench-task" onClick={() => navigate({ page: 'rooms', id: room.key })}>
    <span className="sa-workbench-task-icon" aria-hidden="true"><Icon name={status.key === 'attention' ? 'ask' : status.key === 'working' ? 'running' : 'message'} size={19} /></span>
    <span className="sa-workbench-task-body"><span className="sa-workbench-task-title">{roomTitle(room, chinese)}</span>
      {latest && <span className="sa-workbench-task-excerpt">{latest.replace(/[#*`]/g, '').replace(/\[内容已截断[\s\S]*$/, '').trim()}</span>}
      <span className="sa-workbench-task-meta">{sourceLabel(room.source, chinese)}<span aria-hidden="true">·</span><time dateTime={room.updatedAt}>{when(room.updatedAt, t('lang'))}</time></span>
    </span><Tag tone={status.tone}>{status.label}</Tag><span className="sa-workbench-task-arrow" aria-hidden="true"><Icon name="chevron-right" size={17} /></span>
  </button></li>
}

export function WorkbenchPage() {
  const { t, call, navigate } = usePanel()
  const { state } = usePanelData()
  const chinese = t('lang') !== 'en'
  const overview = usePoll(() => call('GET overview'), [], 5000)
  const rooms = usePoll(() => call('GET rooms', { query: { limit: 50 } }), [], 5000)
  const data = overview.data
  const items = rooms.data?.items ?? []
  const active = items.filter(room => ['working', 'queued', 'waiting'].includes(roomStatus(room, chinese).key))
  const attention = items.filter(room => roomStatus(room, chinese).key === 'attention')
  const reload = async () => { await Promise.all([overview.reload(), rooms.reload()]) }
  return <div className="sa-workbench">
    <div className="sa-workbench-intro"><div><p className="sa-eyebrow">{chinese ? '你的工作空间' : 'YOUR WORKSPACE'}</p>
      <h2>{chinese ? '把注意力留给重要的事。' : 'Make room for what matters.'}</h2>
      <p>{chinese ? '查看需要你处理的事项，跟进正在推进的工作。' : 'Handle what needs you and keep your work moving.'}</p></div>
      <span className="sa-workbench-service" data-paused={state?.paused || !!overview.error || !!rooms.error || undefined}><span aria-hidden="true" />{overview.error || rooms.error
        ? chinese ? '连接待恢复' : 'Waiting to reconnect' : !state || !data ? chinese ? '正在连接…' : 'Connecting…' : state.paused
          ? chinese ? '任务处理已暂停' : 'Processing paused' : chinese ? '工作空间已连接' : 'Workspace connected'}</span></div>
    <div className="sa-workbench-metrics" aria-label={chinese ? '工作概况' : 'Work overview'}>
      <button type="button" onClick={() => document.getElementById('sa-needs-you')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
        <span>{chinese ? '需要你处理' : 'Needs your attention'}</span><strong>{data ? data.person.length : '—'}</strong><small>{chinese ? '确认、补充与决策' : 'Questions and decisions'}</small></button>
      <button type="button" onClick={() => navigate({ page: 'execution', query: { filter: 'working' } })}>
        <span>{chinese ? '正在执行' : 'In progress'}</span><strong>{data ? data.executor.running : '—'}</strong><small>{chinese ? '执行成员正在推进' : 'Workers moving tasks forward'}</small></button>
      <button type="button" onClick={() => navigate({ page: 'execution', query: { filter: 'open' } })}>
        <span>{chinese ? '等待开始' : 'Queued'}</span><strong>{data ? data.executor.queued : '—'}</strong><small>{chinese ? '已接收，等待执行' : 'Received and ready to run'}</small></button>
    </div>
    <LoadState error={overview.error ?? rooms.error} loading={!data || !rooms.data} />
    {(overview.error || rooms.error) && <Button variant="outline" icon={<Icon name="refresh" />} onClick={() => { void reload() }}>{t('retry')}</Button>}
    <section id="sa-needs-you" className="sa-workbench-attention">
      <Section title={chinese ? '需要你处理' : 'Needs your attention'} count={data?.person.length ?? 0}
        action={<Button variant="ghost" onClick={() => navigate({ page: 'assistant' })}>{chinese ? '查看个人待办' : 'Personal to-dos'}<Icon name="chevron-right" size={14} /></Button>}>
        {data?.person.length ? <ul className="dt-list dt-cards">{data.person.map(ticket => <TicketLine key={ticket.id} ticket={ticket} question onChanged={reload} />)}</ul>
          : attention.length ? <ul className="sa-workbench-task-list">{attention.slice(0, 4).map(room => <RoomPreview key={room.key} room={room} />)}</ul>
            : data && <div className="sa-workbench-clear"><span aria-hidden="true"><Icon name="decision" size={22} /></span><div><strong>{chinese ? '当前没有待处理的任务问题' : 'No task questions waiting for you'}</strong>
              <p>{chinese ? '需要补充信息或确认时，任务会出现在这里。个人承诺与授权可在个人助理中查看。' : 'Tasks needing your input appear here. Find commitments and approvals in your assistant.'}</p></div></div>}
      </Section>
    </section>
    {!!data?.problems.length && <Section title={chinese ? '工作空间提醒' : 'Workspace notices'} count={data.problems.length}>
      <ul className="dt-list dt-cards">{data.problems.map((problem, index) => <ProblemLine key={index} problem={problem} onChanged={reload} />)}</ul>
    </Section>}
    {!!active.length && <Section title={chinese ? '持续推进中' : 'Moving forward'} count={active.length}>
      <ul className="sa-workbench-task-list">{active.slice(0, 4).map(room => <RoomPreview key={room.key} room={room} />)}</ul>
    </Section>}
    <Section title={chinese ? '最近任务' : 'Recent tasks'} action={<Button variant="ghost" onClick={() => navigate({ page: 'rooms' })}>{chinese ? '查看全部任务' : 'All tasks'}<Icon name="chevron-right" size={14} /></Button>}>
      {items.length ? <ul className="sa-workbench-task-list">{items.slice(0, 6).map(room => <RoomPreview key={room.key} room={room} />)}</ul>
        : rooms.data && <div className="sa-workbench-empty"><Icon name="message" size={28} /><strong>{chinese ? '从一个具体目标开始' : 'Start with a clear goal'}</strong>
          <p>{chinese ? '点击右上角「新建任务」，告诉助手目标、背景和期望结果。' : 'Choose New task and describe your goal, context and desired result.'}</p></div>}
    </Section>
    {data && <details className="sa-workbench-runtime"><summary><Icon name="settings" size={16} /><span>{chinese ? '运行概况' : 'Runtime overview'}</span><small>{chinese ? '过去 24 小时与执行容量' : 'Last 24 hours and capacity'}</small><Icon name="chevron-down" size={14} /></summary>
      <div className="sa-workbench-runtime-body"><dl><div><dt>{chinese ? '收到请求' : 'Received'}</dt><dd>{data.flow.received}</dd></div>
        <div><dt>{chinese ? '接单或续做' : 'Accepted'}</dt><dd>{data.flow.accepted}</dd></div>
        <div><dt>{chinese ? '执行容量' : 'Worker capacity'}</dt><dd>{data.executor.running} / {data.executor.maxWorkers}</dd></div>
        <div><dt>{chinese ? '等待新消息' : 'Waiting for input'}</dt><dd>{data.executor.idle}</dd></div></dl>
        <Button variant="outline" onClick={() => navigate({ page: 'source' })}>{chinese ? '查看连接与运行状态' : 'View connections and runtime'}</Button></div>
    </details>}
  </div>
}
