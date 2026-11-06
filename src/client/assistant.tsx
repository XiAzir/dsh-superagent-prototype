/** Owner-facing personal assistant records, settings, approvals, and scheduled checks. */
import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { PersonalKind, PersonalRecord, PersonalSettings } from '../core/personal/model.ts'
import type { DshSuperagentKey } from './locales.ts'
import { usePagedPoll, usePoll } from './api.ts'
import { Button, Icon, Input, Tag } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { errorText, when, type T } from './text.ts'
import { Hint, LoadState, PageHead, Section } from './widgets.tsx'

const KINDS: { kind: PersonalKind; key: string }[] = [
  { kind: 'attention', key: 'assistant.attention' }, { kind: 'authorization', key: 'assistant.authorizations' },
  { kind: 'commitment', key: 'assistant.commitments' }, { kind: 'goal', key: 'assistant.goals' },
  { kind: 'fact', key: 'assistant.memories' }, { kind: 'constraint', key: 'assistant.constraints' },
  { kind: 'action', key: 'assistant.actions' },
]
type EditableKind = 'goal' | 'commitment' | 'fact' | 'constraint'
const EDITABLE: EditableKind[] = ['goal', 'commitment', 'fact', 'constraint']
const copy = (t: T, zh: string, en: string) => t('lang') === 'zh' ? zh : en
const PAGE_DRAFT = 'superagent/ui/assistant-page'
type Editor = { kind: EditableKind; record?: PersonalRecord }
function readDraft<V>(key: string): V | undefined {
  try { return JSON.parse(sessionStorage.getItem(key) ?? 'null') as V | undefined } catch { return undefined }
}
function saveDraft(key: string, value?: unknown) {
  try { if (value === undefined) sessionStorage.removeItem(key); else sessionStorage.setItem(key, JSON.stringify(value)) } catch { /* The active form stays usable when browser storage is unavailable. */ }
}
function pageDraft(): { kind: PersonalKind; editor?: Editor } {
  const saved = readDraft<{ kind: PersonalKind; editor?: Editor }>(PAGE_DRAFT)
  const kind = KINDS.some(item => item.kind === saved?.kind) ? saved!.kind : 'attention'
  const editor = saved?.editor && EDITABLE.includes(saved.editor.kind) ? saved.editor : undefined
  return { kind, editor }
}
const editorKey = (kind: EditableKind, record?: PersonalRecord) => `superagent/ui/assistant/${kind}/${record?.id ?? 'new'}`
function optionLabel(t: T, field: Field, option: string): string {
  if (field.name === 'status') return t(`assistant.status.${option}` as DshSuperagentKey)
  if (field.name === 'scope') return t(option === 'global' ? 'assistant.scope.global' : 'assistant.scope.ticket')
  const labels: Record<string, [string, string]> = {
    user: ['我', 'Me'], assistant: ['助理', 'Assistant'], external: ['外部人员', 'Someone else'],
    time: ['时间', 'Time'], budget: ['预算', 'Budget'], privacy: ['隐私', 'Privacy'], channel: ['沟通渠道', 'Channel'],
    risk: ['风险', 'Risk'], soft: ['优先遵守', 'Preference'], hard: ['必须遵守', 'Required'],
  }
  return labels[option] ? copy(t, ...labels[option]) : option
}
type Field = { name: string; label: string; type?: 'text' | 'number' | 'datetime-local' | 'textarea' | 'select'; options?: string[] }
const FIELDS: Record<EditableKind, Field[]> = {
  goal: [{ name: 'title', label: 'title' }, { name: 'description', label: 'description', type: 'textarea' },
    { name: 'priority', label: 'priority', type: 'number' }, { name: 'successCriteria', label: 'successCriteria', type: 'textarea' },
    { name: 'status', label: 'status', type: 'select', options: ['active', 'paused', 'completed', 'cancelled'] }],
  commitment: [{ name: 'title', label: 'title' }, { name: 'owner', label: 'owner', type: 'select', options: ['user', 'assistant', 'external'] },
    { name: 'counterparty', label: 'counterparty' }, { name: 'dueAt', label: 'dueAt', type: 'datetime-local' },
    { name: 'expectedAt', label: 'expectedAt', type: 'datetime-local' }, { name: 'nextCheckAt', label: 'nextCheckAt', type: 'datetime-local' },
    { name: 'status', label: 'status', type: 'select', options: ['open', 'waiting', 'overdue', 'fulfilled', 'cancelled'] },
    { name: 'goalIds', label: 'goalIds' }, { name: 'ticketIds', label: 'ticketIds' }],
  fact: [{ name: 'subject', label: 'subject' }, { name: 'predicate', label: 'predicate' }, { name: 'value', label: 'value' },
    { name: 'scope', label: 'scope' }, { name: 'validFrom', label: 'validFrom', type: 'datetime-local' },
    { name: 'validUntil', label: 'validUntil', type: 'datetime-local' }],
  constraint: [{ name: 'title', label: 'title' }, { name: 'kind', label: 'kind', type: 'select', options: ['time', 'budget', 'privacy', 'channel', 'risk'] },
    { name: 'severity', label: 'severity', type: 'select', options: ['soft', 'hard'] }, { name: 'startAt', label: 'startAt', type: 'datetime-local' },
    { name: 'endAt', label: 'endAt', type: 'datetime-local' }, { name: 'amount', label: 'amount', type: 'number' },
    { name: 'currency', label: 'currency' }, { name: 'scope', label: 'scope', type: 'select', options: ['global', 'current-ticket'] }],
}
const initialFields = (kind: EditableKind): Record<string, unknown> => kind === 'goal'
  ? { title: '', description: '', priority: 50, successCriteria: [], status: 'active' }
  : kind === 'commitment' ? { title: '', owner: 'assistant', status: 'open', goalIds: [], ticketIds: [] }
  : kind === 'fact' ? { subject: '', predicate: '', value: '', confidence: 1, confirmation: 'user', status: 'active' }
  : { title: '', kind: 'time', severity: 'soft', status: 'active' }

function localValue(value: unknown, field: Field): string {
  if (field.type === 'datetime-local' && typeof value === 'string' && value) {
    const date = new Date(value)
    if (!Number.isNaN(date.getTime())) return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  }
  if (Array.isArray(value)) return value.join(field.name === 'successCriteria' ? '\n' : ', ')
  return value == null ? '' : String(value)
}
function parseField(value: string, field: Field): unknown {
  if (field.type === 'number') return value === '' ? undefined : Number(value)
  if (field.type === 'datetime-local') return value ? new Date(value).toISOString() : undefined
  if (field.name === 'successCriteria') return value.split(/[\r\n,，]+/).map(item => item.trim()).filter(Boolean)
  if (field.name === 'goalIds' || field.name === 'ticketIds') return value.split(',').map(item => item.trim()).filter(Boolean)
  return value || undefined
}

function RecordEditor({ kind, record, onClose, onSaved }: { kind: EditableKind; record?: PersonalRecord; onClose: () => void; onSaved: () => void }) {
  const { t, call } = usePanel()
  const goals = usePoll(() => call('GET personal/records/:kind', { kind: 'goal', query: { limit: 100 } }), [], 5000)
  const key = editorKey(kind, record)
  const [restored] = useState(() => readDraft<{ fields: Record<string, unknown>; newId: string; revision?: number }>(key))
  const [fields, setFields] = useState(() => ({ ...initialFields(kind), ...(record as unknown as Record<string, unknown> | undefined), ...restored?.fields }))
  const [newId] = useState(() => restored?.newId ?? crypto.randomUUID())
  const [revision] = useState(() => restored?.revision ?? record?.revision ?? 0)
  const [busy, setBusy] = useState(false), [failure, setFailure] = useState('')
  const sending = useRef(false)
  useEffect(() => { document.getElementById(`assistant-field-${FIELDS[kind][0]!.name}`)?.focus() }, [kind])
  const set = (name: string, value: unknown) => setFields(current => {
    const next = { ...current, [name]: value }
    saveDraft(key, { fields: next, newId, revision })
    return next
  })
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (sending.current) return
    sending.current = true; setBusy(true); setFailure('')
    try {
      const value = Object.fromEntries(FIELDS[kind].flatMap(field => {
        const parsed = parseField(localValue(fields[field.name], field), field)
        return parsed === undefined ? [] : [[field.name, parsed]]
      }))
      if (kind === 'fact') Object.assign(value, { confidence: Number(fields.confidence ?? 1), confirmation: 'user', status: fields.status ?? 'active' })
      const id = record?.id ?? newId
      await call('PUT personal/records/:kind/:id', { kind, id, body: { value, revision } })
      saveDraft(key)
      onSaved()
    } catch (error) { setFailure(errorText(error)) }
    finally { sending.current = false; setBusy(false) }
  }
  return <form className="dt-form dt-block dt-assistant-editor" onSubmit={event => { void submit(event) }}>
    <h3 className="dt-block-title">{t(record ? 'assistant.edit' : 'assistant.create')} · {t(`assistant.field.${kind}` as DshSuperagentKey)}</h3>
    <div className="dt-assistant-grid">{FIELDS[kind].map(field => <label className="dt-field" key={field.name} htmlFor={`assistant-field-${field.name}`}>
      <span className="dt-field-head">{field.name === 'successCriteria' ? copy(t, '完成标准', 'Success criteria')
        : field.name === 'goalIds' ? copy(t, '关联目标', 'Linked goals') : t(`assistant.field.${field.label}` as DshSuperagentKey)}</span>
      {field.name === 'goalIds' ? <select id={`assistant-field-${field.name}`} className="dt-select" multiple size={Math.min(5, Math.max(2, goals.data?.items.length ?? 2))}
        value={Array.isArray(fields.goalIds) ? fields.goalIds.map(String) : []} onChange={event => set('goalIds', [...event.currentTarget.selectedOptions].map(option => option.value))}>
        {(goals.data?.items ?? []).map(item => { const goal = item as unknown as { id: string; title?: string }
          return <option key={goal.id} value={goal.id}>{goal.title ?? goal.id}</option> })}</select>
        : field.type === 'textarea' ? <textarea id={`assistant-field-${field.name}`} className="dt-textarea" rows={field.name === 'successCriteria' ? 3 : 2} value={localValue(fields[field.name], field)}
        placeholder={field.name === 'successCriteria' ? copy(t, '每行写一条可验证的完成标准', 'One verifiable outcome per line') : undefined}
        onChange={event => set(field.name, event.target.value)} />
        : field.type === 'select' ? <select id={`assistant-field-${field.name}`} className="dt-select" value={localValue(fields[field.name], field)}
          onChange={event => set(field.name, event.target.value)}>{field.options?.map(option => <option key={option} value={option}>
            {optionLabel(t, field, option)}</option>)}</select>
        : <Input id={`assistant-field-${field.name}`} type={field.type === 'datetime-local' ? 'datetime-local' : field.type ?? 'text'} value={localValue(fields[field.name], field)}
          min={field.name === 'priority' ? 0 : undefined} max={field.name === 'priority' ? 100 : undefined}
          onChange={event => set(field.name, event.target.value)} />}
      {field.type === 'datetime-local' && <small>{t('assistant.datetimeHint', { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone })}</small>}
      {field.name === 'priority' && <small>{copy(t, '0–100，数字越大越优先；50 为普通优先级。', '0–100; higher numbers come first. 50 is normal priority.')}</small>}
      {field.name === 'successCriteria' && <small>{copy(t, '每行一条，也支持粘贴逗号分隔的旧记录。', 'Use one item per line. Existing comma-separated lists are also supported.')}</small>}
    </label>)}</div>
    {failure && <p className="dt-error" role="alert">{t('assistant.recordError')} {failure}</p>}
    <div className="dt-row-actions"><Button type="submit" variant="primary" disabled={busy}>{busy ? t('assistant.saving') : t('assistant.saveRecord')}</Button>
      <Button onClick={() => { saveDraft(key); onClose() }}>{t('cancel')}</Button></div>
  </form>
}

export function PersonalAssistantPage() {
  const { t, call, navigate, notify } = usePanel()
  const dashboard = usePoll(() => call('GET personal'), [], 4000)
  const [view, setView] = useState(pageDraft)
  const { kind, editor } = view
  const change = (next: { kind: PersonalKind; editor?: Editor }) => { setView(next); saveDraft(PAGE_DRAFT, next) }
  const select = (next: PersonalKind) => change({ kind: next })
  const edit = (next?: Editor) => change({ kind, ...(next ? { editor: next } : {}) })
  const paged = usePagedPoll(offset => call('GET personal/records/:kind', { kind, query: { offset, limit: 50 } }), [kind], 5000)
  const focus = usePoll(async () => {
    const [attention, authorizations, commitments] = await Promise.all([
      call('GET personal/records/:kind', { kind: 'attention', query: { status: 'queued', limit: 100 } }),
      call('GET personal/records/:kind', { kind: 'authorization', query: { status: 'requested', limit: 100 } }),
      call('GET personal/records/:kind', { kind: 'commitment', query: { limit: 100 } }),
    ])
    const upcoming = commitments.items.filter(item => ['open', 'waiting', 'overdue'].includes(item.status))
      .map(item => item as PersonalRecord<'commitment'>)
      .sort((a, b) => (a.dueAt ?? a.nextCheckAt ?? a.expectedAt ?? '9999').localeCompare(b.dueAt ?? b.nextCheckAt ?? b.expectedAt ?? '9999'))
    return { attention, authorizations, upcoming, commitmentsMore: commitments.next_offset !== null }
  }, [], 5000)
  const reload = async () => { await Promise.all([dashboard.reload(), paged.reload(), focus.reload()]) }
  const mutate = async (action: () => Promise<unknown>) => { try { await action(); await reload() } catch (error) { notify(errorText(error)) } }
  const settings = dashboard.data?.settings
  return <div className="dt-assistant-page">
    <div className="sa-assistant-intro"><PageHead title={t('assistant.title')} />
      <p>{copy(t, '把需要关注的事放在眼前，让目标、承诺与记忆持续连接。', 'Keep what needs your attention close, and your goals, commitments and memory connected.')}</p></div>
    <LoadState error={dashboard.error} loading={!dashboard.data} />
    {settings?.enabled && dashboard.data && <>
      <div className="sa-assistant-metrics" aria-label={copy(t, '个人助理概况', 'Assistant overview')}>
        {([
          { kind: 'attention', label: copy(t, '待处理事项', 'Needs attention'), count: focus.data ? `${focus.data.attention.items.length}${focus.data.attention.next_offset !== null ? '+' : ''}` : '—' },
          { kind: 'authorization', label: copy(t, '等待批准', 'Awaiting approval'), count: focus.data ? `${focus.data.authorizations.items.length}${focus.data.authorizations.next_offset !== null ? '+' : ''}` : '—' },
          { kind: 'commitment', label: copy(t, '进行中的承诺', 'Open commitments'), count: focus.data ? `${focus.data.upcoming.length}${focus.data.commitmentsMore ? '+' : ''}` : '—' },
          { kind: 'goal', label: copy(t, '目标记录', 'Goals'), count: dashboard.data.counts.goal },
        ] as const).map(item => <button type="button" className="sa-assistant-metric" key={item.kind} onClick={() => select(item.kind)}
          aria-pressed={kind === item.kind}><span>{item.label}</span><strong>{item.count}</strong><Icon name="chevron-right" size={16} /></button>)}
      </div>
      {focus.error && <p className="dt-error" role="status">{focus.error.message}</p>}
      {!!focus.data?.upcoming.length && kind !== 'commitment' && <Section title={copy(t, '近期承诺', 'Upcoming commitments')}
        action={<Button variant="ghost" onClick={() => select('commitment')}>{copy(t, '查看全部', 'View all')}</Button>}>
        <ul className="dt-assistant-list">{focus.data.upcoming.slice(0, 3).map(item => <li key={item.id} className="dt-assistant-row">
          <div className="dt-assistant-record"><strong>{item.title}</strong><Tag tone={item.status === 'overdue' ? 'warning' : 'neutral'}>{t(`assistant.status.${item.status}` as DshSuperagentKey)}</Tag>
            <p>{item.dueAt ? `${t('assistant.field.dueAt')} · ${when(item.dueAt, t('lang'))}` : item.nextCheckAt ? `${t('assistant.field.nextCheckAt')} · ${when(item.nextCheckAt, t('lang'))}`
              : item.expectedAt ? `${t('assistant.field.expectedAt')} · ${when(item.expectedAt, t('lang'))}` : copy(t, '等待补充时间安排', 'Add a time to keep this moving')}</p></div>
          <Button variant="outline" onClick={() => change({ kind: 'commitment', editor: { kind: 'commitment', record: item } })}>{t('assistant.edit')}</Button>
        </li>)}</ul>
      </Section>}
      {dashboard.data.followups.length > 0 && <Section title={copy(t, '接下来的自动复查', 'Scheduled follow-ups')}>
        {dashboard.data.followups.flatMap(group => group.checks.map(check => ({ ...check, ticketId: group.ticketId, title: group.title })))
          .sort((a, b) => a.at.localeCompare(b.at)).map(check => <article className="dt-assistant-row" key={`${check.ticketId}:${check.id}`}>
            <div className="dt-assistant-record"><strong>{check.purpose}</strong><p>{when(check.at, t('lang'))} · {check.title}</p><small>{check.successCondition}</small><small>{check.resumeInstruction}</small></div>
            <div className="dt-row-actions"><Button variant="outline" onClick={() => navigate({ page: 'execution', id: check.ticketId })}>{t('assistant.ticket')}</Button>
              <Button onClick={() => { void mutate(() => call('POST personal/followups/:ticketId/:key/cancel', { ticketId: check.ticketId, key: check.key })) }}>{t('assistant.cancelFollowup')}</Button></div>
          </article>)}
      </Section>}
      <section className="dt-assistant-tabs" aria-label={t('assistant.title')}>
        {KINDS.map(item => <button type="button" key={item.kind} aria-label={t(item.key as DshSuperagentKey)} aria-pressed={kind === item.kind} className="dt-assistant-tab"
          onClick={() => select(item.kind)}>{t(item.key as DshSuperagentKey)}<span className="sa-assistant-tab-count">{dashboard.data!.counts[item.kind]}</span></button>)}
      </section>
      {editor && <RecordEditor key={editorKey(editor.kind, editor.record)} kind={editor.kind} record={editor.record} onClose={() => edit()} onSaved={() => {
        edit(); void reload()
      }} />}
      <Records kind={kind} records={paged.data?.items ?? []} loading={!paged.data && !paged.error} error={paged.error}
        onCreate={EDITABLE.includes(kind as EditableKind) ? () => edit({ kind: kind as EditableKind }) : undefined}
        onEdit={record => edit({ kind: kind as EditableKind, record })}
        action={mutate} reload={reload} navigate={navigate} />
      {paged.data?.next_offset !== null && paged.data && <Button disabled={paged.loadingMore} onClick={() => { void paged.loadMore() }}>{t('loadMore')}</Button>}
    </>}
    {settings && <details className="sa-assistant-settings-fold" open={settings.enabled ? undefined : true}>
      <summary><span><Icon name="settings" />{t('assistant.settings')}</span><small>{settings.enabled ? `${settings.timezone} · ${settings.quietStart}–${settings.quietEnd}`
        : copy(t, '启用后开始持续跟进', 'Enable to start following up')}</small><Icon name="chevron-down" /></summary>
      <SettingsForm settings={settings} onSaved={reload} />
    </details>}
  </div>
}

function SettingsForm({ settings, onSaved }: { settings: PersonalSettings; onSaved: () => Promise<unknown> }) {
  const { t, call } = usePanel()
  const draftKey = 'superagent/ui/assistant-settings'
  const [restored] = useState(() => readDraft<PersonalSettings>(draftKey))
  const [value, setValue] = useState<PersonalSettings>(restored?.revision !== undefined ? restored : settings), [dirty, setDirty] = useState(!!restored)
  const [busy, setBusy] = useState(false), [failure, setFailure] = useState('')
  const [saved, setSaved] = useState(false)
  useEffect(() => { if (!dirty) setValue(settings) }, [settings, dirty])
  const set = <K extends keyof PersonalSettings>(name: K, next: PersonalSettings[K]) => {
    setDirty(true); setSaved(false); setValue(current => {
      const updated = { ...current, [name]: next }
      saveDraft(draftKey, updated)
      return updated
    })
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setFailure('')
    try {
      const saved = await call('PUT personal/settings', { body: { value, revision: value.revision } })
      setValue(saved); setDirty(false); saveDraft(draftKey); setSaved(true); await onSaved()
    }
    catch (error) { setFailure(`${t('assistant.settingsError')} ${errorText(error)}`) }
    finally { setBusy(false) }
  }
  return <form className="dt-form dt-block dt-assistant-settings" onSubmit={event => { void submit(event) }}>
    <h2 className="dt-block-title">{t('assistant.settings')}</h2>
    <label className="dt-assistant-enabled"><input type="checkbox" checked={value.enabled} onChange={event => set('enabled', event.target.checked)} />{t('assistant.enabled')}</label>
    <div className="dt-assistant-grid">
      <label className="dt-field" htmlFor="assistant-settings-timezone"><span>{t('assistant.timezone')}</span><Input id="assistant-settings-timezone" value={value.timezone} onChange={event => set('timezone', event.target.value)} /></label>
      <label className="dt-field" htmlFor="assistant-settings-owners"><span>{t('assistant.ownerActors')}</span><Input id="assistant-settings-owners" value={value.ownerActors.join(', ')} onChange={event => set('ownerActors', event.target.value.split(',').map(x => x.trim()).filter(Boolean))} />
          <small>{t('assistant.ownerHint')}</small></label>
      <label className="dt-field"><span>{t('assistant.quietStart')}</span><Input type="time" value={value.quietStart} onChange={event => set('quietStart', event.target.value)} /></label>
      <label className="dt-field"><span>{t('assistant.quietEnd')}</span><Input type="time" value={value.quietEnd} onChange={event => set('quietEnd', event.target.value)} /></label>
      <label className="dt-field"><span>{t('assistant.digestMinutes')}</span><Input type="number" min={1} max={10080} value={value.digestMinutes} onChange={event => set('digestMinutes', Number(event.target.value))} /></label>
    </div>
    {dirty && settings.revision !== value.revision && <p className="dt-banner" role="status">{t('assistant.settingsConflictHint')}</p>}
    {failure && <p className="dt-error" role="alert">{failure}</p>}
    {saved && <p className="dt-hint" role="status">{copy(t, '设置已保存', 'Settings saved')}</p>}
    {dirty && <div className="dt-row-actions"><Button type="submit" variant="primary" disabled={busy}>{busy ? t('assistant.saving') : t('assistant.save')}</Button>
      <Button disabled={busy} onClick={() => { setValue(settings); setDirty(false); setFailure(''); saveDraft(draftKey) }}>{copy(t, '放弃修改', 'Discard changes')}</Button></div>}
  </form>
}

function Records({ kind, records, loading, error, onCreate, onEdit, action, reload, navigate }: { kind: PersonalKind; records: PersonalRecord[]; loading: boolean
  error?: Error; onCreate?: () => void; onEdit: (record: PersonalRecord) => void; action: (action: () => Promise<unknown>) => void; reload: () => Promise<unknown>
  navigate: (route: { page: 'execution'; id: string }) => void }) {
  const { t, call } = usePanel()
  const [deleting, setDeleting] = useState<string>()
  const editable = EDITABLE.includes(kind as EditableKind)
  const authorizationIds = kind === 'authorization' ? records.map(record => record.id) : []
  const authorizationRequests = usePoll(() => Promise.all(authorizationIds.map(id =>
    call('GET personal/authorizations/:id/request', { id }))), [kind, authorizationIds.join(',')], 5000)
  const run = async (route: 'PUT personal/records/:kind/:id' | 'DELETE personal/records/:kind/:id' | 'POST personal/attention/:id/acknowledge'
    | 'POST personal/authorizations/:id/grant' | 'POST personal/authorizations/:id/revoke' | 'POST personal/actions/:id/execute', args: Record<string, unknown>) => call(route, args as never)
  const empty: Record<PersonalKind, [string, string]> = {
    attention: ['当前没有需要处理的事项。新的提醒与待确认内容会出现在这里。', 'You are all caught up. New reminders and items to review will appear here.'],
    authorization: ['当前没有授权请求。助理准备好行动后，你可以在这里查看完整内容并批准。', 'No requests to approve. Prepared actions will appear here with their full details.'],
    commitment: ['记录一项有时间安排的承诺，让助理持续跟进下一步。', 'Add a commitment and a time so your assistant can follow up.'],
    goal: ['写下想达成的结果与完成标准，后续任务就有了共同方向。', 'Define an outcome and what success looks like to guide future tasks.'],
    fact: ['保存长期偏好与已确认事实，让助理在后续任务中沿用。', 'Save lasting preferences and confirmed facts for future tasks.'],
    constraint: ['补充时间、预算或沟通偏好，帮助助理做出合适安排。', 'Add timing, budget or communication preferences to guide your assistant.'],
    action: ['行动执行后，会在这里留下结果和核实记录。', 'Executed actions and their verification results will appear here.'],
  }
  return <Section title={t(KINDS.find(item => item.kind === kind)!.key as DshSuperagentKey)} count={records.length} action={onCreate && records.length > 0 && <Button variant="outline"
    icon={<Icon name="plus" size={14} />} onClick={onCreate}>{t('assistant.create')}</Button>}>
    {loading && <Hint>{t('assistant.loading')}</Hint>}{error && <p role="alert" className="dt-error">{error.message}</p>}
    {!loading && !error && !records.length && <div className="sa-assistant-empty"><Icon name={kind === 'authorization' ? 'shield' : kind === 'attention' ? 'decision' : 'inbox'} size={28} />
      <h3>{t('assistant.empty')}</h3><p>{copy(t, ...empty[kind])}</p>{onCreate && <Button variant="primary" icon={<Icon name="plus" />} aria-label={t('assistant.create')} onClick={onCreate}>
        {t('assistant.create')} {t(`assistant.field.${kind}` as DshSuperagentKey)}</Button>}</div>}
    <ul className="dt-assistant-list">{records.map(record => {
      const data = record as unknown as Record<string, unknown>
      const title = String(data.title ?? data.subject ?? data.action ?? data.ticketId ?? record.id)
      const status = String(data.status ?? '')
      const paired = kind === 'authorization' ? authorizationRequests.data?.find(item => item.authorization.id === record.id) : undefined
      const pairedAction = paired?.action as unknown as Record<string, unknown> | undefined
      const linkedAction = paired && paired.authorization.requestHash === data.requestHash && paired.action.requestHash === data.requestHash
        ? paired.action as unknown as Record<string, unknown> : undefined
      const label = kind === 'authorization' ? `${t('assistant.authorizationFor')} ${String(linkedAction?.action ?? data.risk ?? '')}`
        : title
      return <li className="dt-assistant-row" key={record.id}><div className="dt-assistant-record">
        <strong>{label}</strong><Tag tone={status === 'active' || status === 'granted' || status === 'verified' ? 'success' : status === 'requested' || status === 'candidate' ? 'warning' : 'neutral'}>{t(`assistant.status.${status}` as DshSuperagentKey)}</Tag>
        <p>{kind === 'fact' ? `${String(data.predicate)}: ${String(data.value)}` : String(data.description ?? data.summary ?? data.target ?? '')}</p>
        {kind === 'goal' && Array.isArray(data.successCriteria) && data.successCriteria.length > 0 && <ul className="sa-assistant-criteria">
          {data.successCriteria.map((criterion, index) => <li key={index}>{String(criterion)}</li>)}</ul>}
        {kind === 'commitment' && <p className="dt-hint">{[
          typeof data.dueAt === 'string' ? `${t('assistant.field.dueAt')} · ${when(data.dueAt, t('lang'))}` : '',
          typeof data.nextCheckAt === 'string' ? `${t('assistant.field.nextCheckAt')} · ${when(data.nextCheckAt, t('lang'))}` : '',
        ].filter(Boolean).join('　')}</p>}
        {kind === 'authorization' && (!authorizationRequests.data || !pairedAction) && <p className="dt-hint" role={authorizationRequests.error ? 'alert' : 'status'}>
          {authorizationRequests.error ? authorizationRequests.error.message : t('assistant.authorizationLoading')}</p>}
        {kind === 'authorization' && pairedAction && !linkedAction && <p className="dt-error" role="alert">{t('assistant.authorizationHashMismatch')}</p>}
        {(kind === 'authorization' || kind === 'action') && <AuthorizationDetail record={kind === 'authorization' ? { ...data,
          actionName: pairedAction?.action, target: pairedAction?.target, payload: pairedAction?.payload } : data} kind={kind} />}
        {typeof data.ticketId === 'string' && <button className="dt-textlink" type="button" onClick={() => navigate({ page: 'execution', id: data.ticketId as string })}>{t('assistant.ticket')}: {String(data.ticketId)}</button>}
      </div><div className="dt-row-actions">
        {editable && <Button size="sm" onClick={() => onEdit(record)}>{t('assistant.edit')}</Button>}
        {kind === 'fact' && status === 'candidate' && <Button size="sm" variant="primary" onClick={() => action(() => run('PUT personal/records/:kind/:id', {
          kind, id: record.id, body: { revision: record.revision, value: { status: 'active', confirmation: 'user' } } }))}>{t('assistant.confirmMemory')}</Button>}
        {kind === 'fact' && status === 'active' && <Button size="sm" onClick={() => action(() => run('PUT personal/records/:kind/:id', {
          kind, id: record.id, body: { revision: record.revision, value: { status: 'revoked' } } }))}>{t('assistant.revokeMemory')}</Button>}
        {kind === 'attention' && status !== 'acknowledged' && <Button size="sm" onClick={() => action(() => run('POST personal/attention/:id/acknowledge', { id: record.id }))}>{t('assistant.acknowledge')}</Button>}
        {kind === 'authorization' && ['requested', 'granted'].includes(status) && <AuthorizationButtons record={data} mutate={action}
          disabled={!linkedAction} approved={status === 'granted'} />}
        {kind === 'action' && status === 'prepared' && <Button size="sm" variant="primary" onClick={() => action(() => run('POST personal/actions/:id/execute', { id: record.id }))}>{t('assistant.execute')}</Button>}
        {kind === 'action' && ['executing', 'uncertain', 'failed'].includes(status) && <Button size="sm" onClick={() => action(() => run('POST personal/actions/:id/execute', { id: record.id }))}>{t('assistant.verify')}</Button>}
        {editable && (deleting === record.id ? <><span className="dt-hint">{copy(t, '删除这条记录？', 'Delete this record?')}</span>
          <Button onClick={() => action(async () => { await run('DELETE personal/records/:kind/:id', { kind, id: record.id, body: { revision: record.revision } }); setDeleting(undefined) })}>{copy(t, '确认删除', 'Confirm delete')}</Button>
          <Button onClick={() => setDeleting(undefined)}>{copy(t, '保留', 'Keep')}</Button></>
          : <Button onClick={() => setDeleting(record.id)}>{t('assistant.delete')}</Button>)}
      </div></li>
    })}</ul>
  </Section>
}

function AuthorizationDetail({ record, kind }: { record: Record<string, unknown>; kind: PersonalKind }) {
  const { t } = usePanel()
  return <dl className="dt-assistant-details">
    {kind === 'authorization' && <><div><dt>{t('assistant.risk')}</dt><dd>{String(record.risk)}</dd></div>
      <div><dt>{t('assistant.target')}</dt><dd>{String(record.target ?? '')}</dd></div>
      <div><dt>{t('assistant.scope')}</dt><dd>{Array.isArray(record.scope) ? record.scope.join(', ') : ''}</dd></div>
      <div><dt>{t('assistant.expiresAt')}</dt><dd>{String(record.expiresAt ?? t('assistant.noExpiry'))}</dd></div>
      <div className="dt-assistant-request"><h3>{t('assistant.fullRequest')}</h3>
        {record.payload && typeof record.payload === 'object' && typeof (record.payload as Record<string, unknown>).text === 'string'
          ? <p>{String((record.payload as Record<string, unknown>).text)}</p>
          : <pre>{JSON.stringify(record.payload ?? {}, null, 2)}</pre>}
      </div><details><summary>{t('assistant.hash')}</summary><code>{String(record.requestHash ?? '')}</code></details></>}
    {kind === 'action' && <><div><dt>{t('assistant.target')}</dt><dd>{String(record.target)}</dd></div>
      <div><dt>{t('assistant.payload')}</dt><dd><pre>{JSON.stringify(record.payload, null, 2)}</pre></dd></div>
      <div><dt>{t('assistant.hash')}</dt><dd><code>{String(record.requestHash)}</code></dd></div></>}
  </dl>
}

function AuthorizationButtons({ record, mutate, disabled, approved }: { record: Record<string, unknown>; mutate: (action: () => Promise<unknown>) => void
  disabled: boolean; approved: boolean }) {
  const { t, call } = usePanel()
  const [expiresAt, setExpiresAt] = useState('')
  const grant = () => mutate(() => call('POST personal/authorizations/:id/grant', { id: String(record.id), body: {
    revision: Number(record.revision), requestHash: String(record.requestHash), ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}) } }))
  const revoke = () => mutate(() => call('POST personal/authorizations/:id/revoke', { id: String(record.id), body: {
    revision: Number(record.revision), requestHash: String(record.requestHash) } }))
  return <><label className="dt-field"><span>{t('assistant.expiresAt')}</span><Input type="datetime-local" value={expiresAt} onChange={event => setExpiresAt(event.target.value)} /></label>
    {!approved && <Button className="dt-assistant-approve" variant="primary" size="sm" disabled={disabled} onClick={grant}>{t('assistant.approve')}</Button>}
    <Button size="sm" disabled={disabled} onClick={revoke}>{t('assistant.revokeAuthorization')}</Button></>
}
