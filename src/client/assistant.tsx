/** Owner-facing personal assistant records, settings, approvals, and scheduled checks. */
import { useEffect, useState, type FormEvent } from 'react'
import type { PersonalKind, PersonalRecord, PersonalSettings } from '../core/personal/model.ts'
import type { DshSuperagentKey } from './locales.ts'
import { usePagedPoll, usePoll } from './api.ts'
import { Button, Icon, Input, Tag } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { errorText, when } from './text.ts'
import { Hint, LoadState, PageHead, Section } from './widgets.tsx'

const KINDS: { kind: PersonalKind; key: string }[] = [
  { kind: 'goal', key: 'assistant.goals' }, { kind: 'commitment', key: 'assistant.commitments' },
  { kind: 'fact', key: 'assistant.memories' }, { kind: 'constraint', key: 'assistant.constraints' },
  { kind: 'attention', key: 'assistant.attention' }, { kind: 'authorization', key: 'assistant.authorizations' },
  { kind: 'action', key: 'assistant.actions' },
]
type EditableKind = 'goal' | 'commitment' | 'fact' | 'constraint'
const EDITABLE: EditableKind[] = ['goal', 'commitment', 'fact', 'constraint']
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
  if (Array.isArray(value)) return value.join(', ')
  return value == null ? '' : String(value)
}
function parseField(value: string, field: Field): unknown {
  if (field.type === 'number') return value === '' ? undefined : Number(value)
  if (field.type === 'datetime-local') return value ? new Date(value).toISOString() : undefined
  if (field.name === 'successCriteria' || field.name === 'goalIds' || field.name === 'ticketIds') return value.split(',').map(item => item.trim()).filter(Boolean)
  return value || undefined
}

function RecordEditor({ kind, record, onClose, onSaved }: { kind: EditableKind; record?: PersonalRecord; onClose: () => void; onSaved: () => void }) {
  const { t, call } = usePanel()
  const goals = usePoll(() => call('GET personal/records/:kind', { kind: 'goal', query: { limit: 100 } }), [], 5000)
  const [fields, setFields] = useState(() => ({ ...initialFields(kind), ...(record as unknown as Record<string, unknown> | undefined) }))
  const [newId] = useState(() => crypto.randomUUID())
  const [busy, setBusy] = useState(false), [failure, setFailure] = useState('')
  const set = (name: string, value: unknown) => setFields(current => ({ ...current, [name]: value }))
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setFailure('')
    try {
      const value = Object.fromEntries(FIELDS[kind].flatMap(field => {
        const parsed = parseField(localValue(fields[field.name], field), field)
        return parsed === undefined ? [] : [[field.name, parsed]]
      }))
      if (kind === 'fact') Object.assign(value, { confidence: Number(fields.confidence ?? 1), confirmation: 'user', status: fields.status ?? 'active' })
      const id = record?.id ?? newId, revision = record?.revision ?? 0
      await call('PUT personal/records/:kind/:id', { kind, id, body: { value, revision } })
      onSaved()
    } catch (error) { setFailure(errorText(error)) }
    finally { setBusy(false) }
  }
  return <form className="dt-form dt-block dt-assistant-editor" onSubmit={event => { void submit(event) }}>
    <h3 className="dt-block-title">{t(record ? 'assistant.edit' : 'assistant.create')} · {t(`assistant.field.${kind}` as DshSuperagentKey)}</h3>
    <div className="dt-assistant-grid">{FIELDS[kind].map(field => <label className="dt-field" key={field.name} htmlFor={`assistant-field-${field.name}`}>
      <span className="dt-field-head">{t(`assistant.field.${field.label}` as DshSuperagentKey)}</span>
      {field.name === 'goalIds' ? <select id={`assistant-field-${field.name}`} className="dt-select" multiple size={Math.min(5, Math.max(2, goals.data?.items.length ?? 2))}
        value={Array.isArray(fields.goalIds) ? fields.goalIds.map(String) : []} onChange={event => set('goalIds', [...event.currentTarget.selectedOptions].map(option => option.value))}>
        {(goals.data?.items ?? []).map(item => { const goal = item as unknown as { id: string; title?: string }
          return <option key={goal.id} value={goal.id}>{goal.title ?? goal.id}</option> })}</select>
        : field.type === 'textarea' ? <textarea id={`assistant-field-${field.name}`} className="dt-textarea" rows={2} value={localValue(fields[field.name], field)}
        onChange={event => set(field.name, event.target.value)} />
        : field.type === 'select' ? <select id={`assistant-field-${field.name}`} className="dt-select" value={localValue(fields[field.name], field)}
          onChange={event => set(field.name, event.target.value)}>{field.options?.map(option => <option key={option} value={option}>
            {field.name === 'scope' ? t(option === 'global' ? 'assistant.scope.global' : 'assistant.scope.ticket') : option}</option>)}</select>
        : <Input id={`assistant-field-${field.name}`} type={field.type === 'datetime-local' ? 'datetime-local' : field.type ?? 'text'} value={localValue(fields[field.name], field)}
          onChange={event => set(field.name, event.target.value)} />}
      {field.type === 'datetime-local' && <small>{t('assistant.datetimeHint', { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone })}</small>}
    </label>)}</div>
    {failure && <p className="dt-error" role="alert">{t('assistant.recordError')} {failure}</p>}
    <div className="dt-row-actions"><Button type="submit" variant="primary" disabled={busy}>{busy ? t('assistant.saving') : t('assistant.saveRecord')}</Button>
      <Button onClick={onClose}>{t('cancel')}</Button></div>
  </form>
}

export function PersonalAssistantPage() {
  const { t, call, navigate, notify } = usePanel()
  const dashboard = usePoll(() => call('GET personal'), [], 4000)
  const [kind, setKind] = useState<PersonalKind>('goal'), [editor, setEditor] = useState<{ kind: EditableKind; record?: PersonalRecord }>()
  const paged = usePagedPoll(offset => call('GET personal/records/:kind', { kind, query: { offset, limit: 50 } }), [kind], 5000)
  const reload = async () => { await Promise.all([dashboard.reload(), paged.reload()]) }
  const mutate = async (action: () => Promise<unknown>) => { try { await action(); await reload() } catch (error) { notify(errorText(error)) } }
  const settings = dashboard.data?.settings
  return <div className="dt-assistant-page">
    <PageHead title={t('assistant.title')} />
    <LoadState error={dashboard.error} loading={!dashboard.data} />
    {settings && <SettingsForm settings={settings} onSaved={reload} />}
    {settings?.enabled && dashboard.data && <>
      <section className="dt-assistant-tabs" aria-label={t('assistant.title')}>
        {KINDS.map(item => <button type="button" key={item.kind} aria-pressed={kind === item.kind} className="dt-assistant-tab"
          onClick={() => { setEditor(undefined); setKind(item.kind) }}>{t(item.key as DshSuperagentKey)}</button>)}
      </section>
      {editor && <RecordEditor kind={editor.kind} record={editor.record} onClose={() => setEditor(undefined)} onSaved={() => {
        setEditor(undefined); void reload()
      }} />}
      <Records kind={kind} records={paged.data?.items ?? []} loading={!paged.data && !paged.error} error={paged.error}
        onCreate={EDITABLE.includes(kind as EditableKind) ? () => setEditor({ kind: kind as EditableKind }) : undefined}
        onEdit={record => setEditor({ kind: kind as EditableKind, record })}
        action={mutate} reload={reload} navigate={navigate} />
      {paged.data?.next_offset !== null && paged.data && <Button disabled={paged.loadingMore} onClick={() => { void paged.loadMore() }}>{t('loadMore')}</Button>}
      {dashboard.data.followups.map(group => <Section key={group.ticketId} title={`${t('assistant.followups')} · ${group.title}`}>
        {group.checks.map(check => <article className="dt-assistant-row" key={check.id}><div><strong>{check.purpose}</strong>
          <p>{when(check.at, t('lang'))} · {check.successCondition}</p><small>{check.resumeInstruction}</small></div>
          <Button variant="outline" size="sm" onClick={() => { void mutate(() => call('POST personal/followups/:ticketId/:key/cancel',
            { ticketId: group.ticketId, key: check.key })) }}>{t('assistant.cancelFollowup')}</Button>
          <Button size="sm" onClick={() => navigate({ page: 'execution', id: group.ticketId })}>{t('assistant.ticket')}</Button></article>)}
      </Section>)}
    </>}
  </div>
}

function SettingsForm({ settings, onSaved }: { settings: PersonalSettings; onSaved: () => Promise<unknown> }) {
  const { t, call } = usePanel()
  const [value, setValue] = useState<PersonalSettings>(settings), [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false), [failure, setFailure] = useState('')
  useEffect(() => { if (!dirty) setValue(settings) }, [settings, dirty])
  const set = <K extends keyof PersonalSettings>(name: K, next: PersonalSettings[K]) => {
    setDirty(true); setValue(current => ({ ...current, [name]: next }))
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setFailure('')
    try {
      const saved = await call('PUT personal/settings', { body: { value, revision: value.revision } })
      setValue(saved); setDirty(false); await onSaved()
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
    <Button type="submit" variant="primary" disabled={busy}>{busy ? t('assistant.saving') : t('assistant.save')}</Button>
  </form>
}

function Records({ kind, records, loading, error, onCreate, onEdit, action, reload, navigate }: { kind: PersonalKind; records: PersonalRecord[]; loading: boolean
  error?: Error; onCreate?: () => void; onEdit: (record: PersonalRecord) => void; action: (action: () => Promise<unknown>) => void; reload: () => Promise<unknown>
  navigate: (route: { page: 'execution'; id: string }) => void }) {
  const { t, call } = usePanel()
  const editable = EDITABLE.includes(kind as EditableKind)
  const authorizationIds = kind === 'authorization' ? records.map(record => record.id) : []
  const authorizationRequests = usePoll(() => Promise.all(authorizationIds.map(id =>
    call('GET personal/authorizations/:id/request', { id }))), [kind, authorizationIds.join(',')], 5000)
  const run = async (route: 'PUT personal/records/:kind/:id' | 'DELETE personal/records/:kind/:id' | 'POST personal/attention/:id/acknowledge'
    | 'POST personal/authorizations/:id/grant' | 'POST personal/authorizations/:id/revoke' | 'POST personal/actions/:id/execute', args: Record<string, unknown>) => call(route, args as never)
  return <Section title={t(KINDS.find(item => item.kind === kind)!.key as DshSuperagentKey)} count={records.length} action={onCreate && <Button variant="outline" size="sm"
    icon={<Icon name="plus" size={14} />} onClick={onCreate}>{t('assistant.create')}</Button>}>
    {loading && <Hint>{t('assistant.loading')}</Hint>}{error && <p role="alert" className="dt-error">{error.message}</p>}
    {!loading && !error && !records.length && <Hint>{t('assistant.empty')}</Hint>}
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
        {editable && <Button size="sm" onClick={() => action(() => run('DELETE personal/records/:kind/:id', { kind, id: record.id, body: { revision: record.revision } }))}>{t('assistant.delete')}</Button>}
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
