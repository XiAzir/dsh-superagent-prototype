/** DSH/Superagent views inside the native workspace region, retaining the original tree. */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import type { Context } from '@deepseek-ai/cordis'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import type { ISessions, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { openKnownSession, SessionNavigationError } from '../navigation.ts'
import type { TaskRoomSummary } from '../app/task-rooms.ts'
import { usePoll, type StateView } from './api.ts'
import { workerCaller } from './worker-panel.tsx'
import { Icon } from './controls.tsx'
import { useSessionDraft } from './session-draft.ts'
import { observeSidebarViews, type SidebarMount } from './sidebar-dom.ts'
import { projectSidebar, type SidebarTaskGroup } from './sidebar-model.ts'
import { roomStatus } from './task-ui.ts'
import { remember, type Route } from './route.ts'
import { errorText, when, type T } from './text.ts'
import CSS from './workspace-sidebar.css?raw'

type SidebarContext = Context & { sessions: ISessions }
type HostHooks = Pick<GlobalStandardProps, 'useWorkspaces' | 'usePanelInfo'>
const copy = (t: T, zh: string, en: string) => t('lang') === 'en' ? en : zh
const basename = (value: string) => value.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || value
const pathKey = (value: string) => /^[A-Za-z]:|^\\\\/.test(value) ? value.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase() : value.replace(/\/+$/, '')

function SessionRow({ session, label, active, open, t }: { session: SessionSummary; label?: string; active: boolean; open(id: string): void; t: T }) {
  return <button type="button" className="sa-side-session" data-selected={active || undefined} aria-current={active ? 'page' : undefined}
    aria-label={label || session.title || session.displayTitle}
    title={session.cwd ? `${session.displayTitle}\n${session.cwd}` : session.displayTitle} onClick={() => open(session.id)}>
    {session.running ? <span className="sa-side-running" aria-label={copy(t, '执行中', 'Running')} /> : <Icon name="session" size={14} />}
    <span>{label || session.title || session.displayTitle}</span><time dateTime={new Date(session.updatedAt).toISOString()}>{when(new Date(session.updatedAt).toISOString(), t('lang'))}</time>
  </button>
}

function TaskGroup({ group, sessions, archived, selected, expanded, toggle, open, openTask, query, t, masterId }: {
  group: SidebarTaskGroup; sessions: Record<string, SessionSummary>; archived: ReadonlySet<string>; selected?: string; expanded: boolean
  toggle(): void; open(id: string): void; openTask(key: string, ticketId?: string): void; query: string; t: T; masterId: string
}) {
  const chinese = t('lang') !== 'en'
  const status = roomStatus({ key: group.id, title: group.title, source: '', pending: group.pending, updatedAt: group.updatedAt, workers: group.workers }, chinese)
  const rows = group.sessionIds.map(id => sessions[id]).filter((row): row is SessionSummary => !!row && !archived.has(row.id))
  const paths = [...new Set(rows.map(row => row.cwd).filter((value): value is string => !!value))]
  const visible = expanded || !!query
  const taskKey = group.roomKeys.find(key => key !== `dsh-session:${masterId}`) ?? group.roomKeys[0]!
  const ticketId = taskKey === `dsh-session:${masterId}` && group.workers.length === 1 ? group.workers[0]!.id : undefined
  return <li className="sa-side-task" data-state={status.key}>
    <div className="sa-side-task-heading"><button type="button" className="sa-side-task-toggle" aria-expanded={visible}
      onClick={toggle} title={group.title}><Icon name={visible ? 'chevron-down' : 'chevron-right'} size={12} /><Icon name="workspace" size={15} />
      <span>{group.title}</span></button><button type="button" className="sa-side-icon" aria-label={copy(t, `打开任务：${group.title}`, `Open task: ${group.title}`)}
        title={copy(t, '打开任务详情', 'Open task details')} onClick={() => openTask(taskKey, ticketId)}><Icon name="external" size={13} /></button></div>
    <div className="sa-side-task-meta"><span data-tone={status.tone}>{status.label}</span>
      <span title={paths.join('\n')}>{paths.length > 1 ? copy(t, `${paths.length} 个工作区`, `${paths.length} workspaces`) : paths[0] ? basename(paths[0]) : copy(t, '任务会话', 'Task conversation')}</span></div>
    {visible && <div className="sa-side-task-children">
      {rows.map(row => <SessionRow key={row.id} session={row} active={row.id === selected} open={open} t={t} />)}
      {!rows.length && <button type="button" className="sa-side-empty-action" onClick={() => openTask(taskKey, ticketId)}>
        {copy(t, '查看任务对话与进展', 'View conversation and progress')}<Icon name="chevron-right" size={12} /></button>}
    </div>}
  </li>
}

function SuperagentTree({ ctx, t, state, selected, sessions, workspaces, archivedIds }: {
  ctx: SidebarContext; t: T; state: StateView; selected?: string; sessions: Record<string, SessionSummary>
  workspaces: readonly { workspaceId: string; path: string; title?: string }[]
  archivedIds: readonly string[]
}) {
  const call = useCallback(workerCaller(t), [t])
  const rooms = usePoll(async () => {
    const items: TaskRoomSummary[] = []
    for (let offset = 0; ; offset += 100) {
      const page = await call('GET rooms', { query: { offset, limit: 100 } })
      items.push(...page.items)
      if (page.next_offset === null || page.next_offset <= offset || offset >= 9900) break
      offset = page.next_offset - 100
    }
    return items
  }, [call], 7000)
  const [query, setQuery] = useSessionDraft('superagent/sidebar-query', '')
  const [expanded, setExpanded] = useSessionDraft<Record<string, boolean>>('superagent/sidebar-expanded', {})
  const [failure, setFailure] = useState(''), [busy, setBusy] = useState(false)
  const opening = useRef<AbortController>()
  const scroll = useRef<HTMLDivElement>(null)
  const archived = new Set(archivedIds)
  const model = projectSidebar({ masterId: state.masterId, stateDir: state.setup.machine.stateDir,
    sessions: Object.values(sessions), rooms: rooms.data ?? [], archivedIds })
  const word = query.trim().toLocaleLowerCase()
  const matches = (value: string) => value.toLocaleLowerCase().includes(word)
  const mainSessions = model.mainSessions.filter(row => !word || matches(`${row.title || row.displayTitle} ${row.cwd ?? ''}`))
  const groups = model.groups.filter(group => !word || matches(`${group.title} ${group.workers.map(worker => `${worker.title} ${worker.summary}`).join(' ')} ${group.sessionIds.map(id => `${sessions[id]?.displayTitle ?? ''} ${sessions[id]?.cwd ?? ''}`).join(' ')}`))
  const current = groups.filter(group => group.pending || group.workers.some(worker => worker.active || worker.stage === 'person'))
  const history = groups.filter(group => !current.includes(group))
  const master = sessions[state.masterId]
  const mainOpen = expanded.main !== false || !!word
  const toggle = (key: string, fallback = false) => setExpanded(value => ({ ...value, [key]: !(value[key] ?? fallback) }))
  useEffect(() => {
    try { if (scroll.current) scroll.current.scrollTop = Number(sessionStorage.getItem('superagent/sidebar-scroll') ?? '0') } catch { /* Scroll memory is optional. */ }
    return () => { opening.current?.abort() }
  }, [])
  const open = (id: string) => {
    opening.current?.abort(); const controller = new AbortController(); opening.current = controller
    setFailure('')
    void openKnownSession(ctx.sessions, id as never, target => { ctx.uiWorkspace.openSession(target) }, controller.signal)
      .catch(error => { if (!controller.signal.aborted) setFailure(error instanceof SessionNavigationError
        ? t(error.code === 'not-ready' ? 'sessionListNotReady' : 'sessionNotListed') : errorText(error)) })
  }
  const openTask = (key: string, ticketId?: string) => {
    const route: Route = ticketId ? { page: 'execution', id: ticketId } : { page: 'rooms', id: key }
    try {
      opening.current?.abort()
      remember({ route, stack: [] }); ctx.layout.selectPanel('dsh-superagent' as MainPanelId)
      window.dispatchEvent(new CustomEvent('dsh-superagent:navigate', { detail: route }))
    } catch (error) { setFailure(errorText(error)) }
  }
  const create = async () => {
    if (busy) return
    setBusy(true); setFailure('')
    try {
      const workspace = workspaces.find(item => pathKey(item.path) === pathKey(state.setup.machine.stateDir))
      if (workspace) ctx.uiWorkspace.startSession(workspace.workspaceId as never)
      else open(await ctx.sessions.create({ cwd: state.setup.machine.stateDir }))
    } catch (error) { setFailure(errorText(error)) }
    finally { setBusy(false) }
  }
  const renderGroup = (group: SidebarTaskGroup) => <TaskGroup key={group.id} group={group} sessions={sessions} archived={archived}
    masterId={state.masterId} selected={selected} expanded={expanded[group.id] ?? (group.pending || group.workers.some(worker => worker.active))}
    toggle={() => toggle(group.id, group.pending || group.workers.some(worker => worker.active))} open={open} openTask={openTask} query={word} t={t} />
  return <div className="sa-side-browser">
    <label className="sa-side-search"><Icon name="search" size={14} /><input type="search" value={query} aria-label={copy(t, '搜索 Superagent 工作区和会话', 'Search Superagent workspaces and chats')}
      placeholder={copy(t, '搜索任务或会话…', 'Search tasks or chats…')} onChange={event => setQuery(event.target.value)} /></label>
    {failure && <p className="sa-side-error" role="alert">{failure}</p>}
    <div ref={scroll} className="sa-side-scroll" onScroll={event => { try { sessionStorage.setItem('superagent/sidebar-scroll', String(event.currentTarget.scrollTop)) } catch { /* Optional convenience. */ } }}>
      <section className="sa-side-main" aria-label={copy(t, 'Superagent 主工作区', 'Superagent main workspace')}>
        <div className="sa-side-main-heading"><button type="button" aria-expanded={mainOpen} onClick={() => toggle('main', true)} title={state.setup.machine.stateDir}>
          <Icon name={mainOpen ? 'chevron-down' : 'chevron-right'} size={12} /><Icon name="workspace" size={16} /><span>{copy(t, '主工作区', 'Main workspace')}</span>
          <span className="sa-side-pinned">{copy(t, '置顶', 'Pinned')}</span></button><button type="button" className="sa-side-icon" disabled={busy}
            aria-label={copy(t, '新建 Superagent 会话', 'New Superagent chat')} onClick={() => { void create() }}><Icon name="plus" size={15} /></button></div>
        {mainOpen && <div className="sa-side-main-children">
          {master && !archived.has(master.id) ? <SessionRow session={master} label={copy(t, '主对话', 'Main chat')} active={selected === master.id} open={open} t={t} />
            : <button type="button" className="sa-side-session" disabled={!state.masterReady} onClick={() => open(state.masterId)}><Icon name="session" size={14} />{copy(t, '主对话', 'Main chat')}</button>}
          {mainSessions.map(row => <SessionRow key={row.id} session={row as SessionSummary} active={row.id === selected} open={open} t={t} />)}
        </div>}
      </section>
      <section aria-label={copy(t, '执行任务', 'Active tasks')}><h3 className="sa-side-section-title">{copy(t, '执行任务', 'Active tasks')}<span>{current.length}</span></h3>
        <ul className="sa-side-tasks">{current.map(renderGroup)}</ul>
        {!current.length && rooms.data && <p className="sa-side-hint">{copy(t, '当前没有执行中的任务。', 'No tasks are running.')}</p>}
      </section>
      {!!history.length && <section><button type="button" className="sa-side-history" aria-expanded={expanded.history === true || !!word} onClick={() => toggle('history')}>
        <Icon name={expanded.history || word ? 'chevron-down' : 'chevron-right'} size={12} />{copy(t, '历史任务', 'Task history')}<span>{history.length}</span></button>
        {(expanded.history || word) && <ul className="sa-side-tasks">{history.map(renderGroup)}</ul>}</section>}
      {rooms.error && <div className="sa-side-error" role="alert">{rooms.error.message}<button type="button" onClick={() => { void rooms.reload() }}>{t('retry')}</button></div>}
      {!rooms.data && !rooms.error && <p className="sa-side-hint" role="status">{t('loading')}</p>}
      {word && !mainSessions.length && !groups.length && <p className="sa-side-hint">{copy(t, '没有匹配的任务或会话。', 'No matching task or chat.')}</p>}
    </div>
  </div>
}

export function WorkspaceSidebar({ ctx, t, useWorkspaces, usePanelInfo }: { ctx: SidebarContext; t: T } & HostHooks) {
  const call = useCallback(workerCaller(t), [t])
  const { data: state } = usePoll(() => call('GET state'), [call], 7000)
  const [mount, setMount] = useState<SidebarMount>()
  const [view, setView] = useSessionDraft<'dsh' | 'superagent'>('superagent/sidebar-view', 'superagent')
  const subscribe = useCallback((notify: () => void) => ctx.sessions.list.subscribe(notify), [ctx])
  const snapshot = useCallback(() => ctx.sessions.list.getSnapshot(), [ctx])
  const catalog = useSyncExternalStore(subscribe, snapshot, snapshot)
  const workspace = useWorkspaces((value: { items: readonly { workspaceId: string; path: string; title?: string }[]; archivedSessionIds: readonly string[] }) => value)
  const panel = usePanelInfo((value: { activePanelId: MainPanelId | null }) => value.activePanelId)
  const enabled = state?.mode === 'personal'
  const selected = panel ? undefined : (Object.values(catalog.byId) as SessionSummary[]).find(row => ((row.retainedBy as Readonly<Record<string, number | undefined>>).mainView ?? 0) > 0)?.id
  useEffect(() => { if (enabled) return observeSidebarViews(setMount) }, [enabled])
  useEffect(() => {
    if (!mount) return
    mount.root.dataset.superagentView = view
    const native = mount.root.children[0]?.nextElementSibling?.nextElementSibling
    // The native browser stays mounted. `hidden` on the alternate panel also keeps it out of keyboard navigation.
    mount.panel.hidden = view !== 'superagent'
    if (native instanceof HTMLElement && native !== mount.panel) native.inert = view === 'superagent'
    return () => { if (native instanceof HTMLElement) native.inert = false }
  }, [mount, view])
  useEffect(() => {
    const nativeShortcut = (event: KeyboardEvent) => { if (view === 'superagent' && event.ctrlKey && event.altKey && ['k', 'o'].includes(event.key.toLowerCase())) setView('dsh') }
    window.addEventListener('keydown', nativeShortcut, true)
    return () => { window.removeEventListener('keydown', nativeShortcut, true) }
  }, [view, setView])
  if (!enabled || !state || !mount) return null
  const choose = (next: 'dsh' | 'superagent') => setView(next)
  return <>{createPortal(<><style>{CSS}</style><div className="sa-side-switch" role="tablist" aria-label={copy(t, '工作区视图', 'Workspace view')}
    onKeyDown={event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const next = event.key === 'Home' ? 'dsh' : event.key === 'End' ? 'superagent' : view === 'dsh' ? 'superagent' : 'dsh'; choose(next); mount.tabs.querySelector<HTMLButtonElement>(`[data-view="${next}"]`)?.focus() } }}>
    {(['dsh', 'superagent'] as const).map(value => <button key={value} type="button" role="tab" id={`sa-sidebar-${value}`} data-view={value}
      aria-selected={view === value} tabIndex={view === value ? 0 : -1} aria-controls={value === 'superagent' ? 'sa-superagent-workspaces' : undefined}
      onClick={() => choose(value)}>{value === 'dsh' ? 'DSH' : 'Superagent'}</button>)}
  </div></>, mount.tabs)}
    {createPortal(<div id="sa-superagent-workspaces" role="tabpanel" aria-labelledby="sa-sidebar-superagent" className="sa-side-panel">
      <SuperagentTree ctx={ctx} t={t} state={state} selected={selected} sessions={catalog.byId} workspaces={workspace.items} archivedIds={workspace.archivedSessionIds} />
    </div>, mount.panel)}</>
}

export function installWorkspaceSidebar(ctx: SidebarContext, t: T): void {
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'dsh-superagent/workspace-views', locale: 'dshSuperagent' },
    (props: HostHooks) => <WorkspaceSidebar ctx={ctx} t={t} {...props} />))
}
