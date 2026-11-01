/** Local management UI for persistent scheduled command tasks. */
import { useRef, useState } from 'react'
import type { ApiResponse } from '../app/api.ts'
import { ApiError } from './api.ts'
import { Button, Icon, Input, Switch } from './controls.tsx'
import { useAction, usePanel } from './provider.tsx'
import { When, ConfirmButton, Hint, LoadState, Section } from './widgets.tsx'
import { Fields } from './settings-kit.tsx'
import { usePoll } from './api.ts'
import { errorText } from './text.ts'

type Item = ApiResponse<'GET schedules'>['items'][number]
type Config = Item['config']
const initial: Config = { name: '', enabled: true, program: '', args: [], cwd: '', intervalSeconds: 300, timeoutSeconds: 120 }

function ScheduleEditor({ item, onCancel, onSaved }: { item?: Item; onCancel: () => void; onSaved: () => Promise<void> }) {
  const { t, call, notify } = usePanel()
  const [config, setConfig] = useState<Config>(() => item?.config ?? initial)
  const [args, setArgs] = useState(() => item?.config.args.join('\n') ?? '')
  const [revision, setRevision] = useState(item?.revision)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [error, setError] = useState<string>()
  const [conflict, setConflict] = useState(false)
  const save = async () => {
    if (busyRef.current) return
    busyRef.current = true; setBusy(true); setError(undefined); setConflict(false)
    try {
      const next = { ...config, args: args === '' ? [] : args.split(/\r?\n/) }
      if (item) await call('PUT schedules/:id', { id: item.id, body: { revision: revision!, config: next } })
      else await call('POST schedules', { body: { config: next } })
      notify(t('scheduleSaved'))
      await onSaved()
      onCancel()
    } catch (failure) {
      setError(errorText(failure))
      setConflict(failure instanceof ApiError && failure.status === 409)
    } finally { busyRef.current = false; setBusy(false) }
  }
  const reloadLatest = async () => {
    if (!item || busyRef.current) return
    busyRef.current = true; setBusy(true)
    try {
      const latest = (await call('GET schedules')).items.find(candidate => candidate.id === item.id)
      if (!latest) { setError(t('scheduleGone')); setConflict(false); return }
      setConfig(latest.config); setArgs(latest.config.args.join('\n')); setRevision(latest.revision); setError(undefined); setConflict(false)
    } catch (failure) { setError(errorText(failure)) }
    finally { busyRef.current = false; setBusy(false) }
  }
  const change = (field: keyof Config, value: string | boolean | number | null) => setConfig(current => ({ ...current, [field]: value }))
  return <form className="dt-form dt-block" onSubmit={event => { event.preventDefault(); void save() }}>
    <h3 className="dt-block-title">{t(item ? 'scheduleEdit' : 'scheduleAdd')}</h3>
    <Fields disabled={busy}>
    <div className="dt-grid2">
      <div className="dt-field"><label className="dt-field-head" htmlFor="dt-schedule-name">{t('scheduleName')}</label>
        <Input id="dt-schedule-name" required maxLength={100} value={config.name} onChange={event => change('name', event.target.value)} /></div>
      <div className="dt-field"><span className="dt-field-head">{t('scheduleEnabled')}</span>
        <Switch checked={config.enabled} onChange={enabled => change('enabled', enabled)} label={t('scheduleEnabled')} /></div>
    </div>
    <div className="dt-field"><label className="dt-field-head" htmlFor="dt-schedule-program">{t('scheduleProgram')}</label>
      <Input id="dt-schedule-program" className="dt-mono" required spellCheck={false} value={config.program}
        onChange={event => change('program', event.target.value)} /></div>
    <div className="dt-field"><label className="dt-field-head" htmlFor="dt-schedule-args">{t('scheduleArgs')}</label>
      <small>{t('scheduleArgsHint')}</small>
      <textarea id="dt-schedule-args" className="dt-textarea dt-mono" rows={4} maxLength={16384} spellCheck={false} value={args}
        onChange={event => setArgs(event.target.value)} /></div>
    <div className="dt-field"><label className="dt-field-head" htmlFor="dt-schedule-cwd">{t('scheduleCwd')}</label>
      <Input id="dt-schedule-cwd" className="dt-mono" required spellCheck={false} value={config.cwd}
        onChange={event => change('cwd', event.target.value)} /></div>
    <div className="dt-grid2">
      <div className="dt-field"><label className="dt-field-head" htmlFor="dt-schedule-interval">{t('scheduleInterval')}</label>
        <Input id="dt-schedule-interval" type="number" min={60} max={31536000} required value={config.intervalSeconds ?? ''}
          onChange={event => change('intervalSeconds', event.target.value === '' ? null : Number(event.target.value))} /></div>
      <div className="dt-field"><label className="dt-field-head" htmlFor="dt-schedule-timeout">{t('scheduleTimeout')}</label>
        <Input id="dt-schedule-timeout" type="number" min={1} max={300} required value={config.timeoutSeconds ?? ''}
          onChange={event => change('timeoutSeconds', event.target.value === '' ? null : Number(event.target.value))} /></div>
    </div>
    </Fields>
    {error && <p className="dt-error" role="alert">{error}</p>}
    <div className="dt-actions">
      <Button variant="primary" disabled={busy} aria-busy={busy} icon={busy ? <Icon name="running" /> : undefined}
        type="submit">{t('scheduleSave')}</Button>
      <Button variant="ghost" disabled={busy} onClick={onCancel}>{t('scheduleCancel')}</Button>
      {conflict && <Button variant="outline" disabled={busy} aria-busy={busy} onClick={() => { void reloadLatest() }}>
        {t('scheduleReloadLatest')}</Button>}
    </div>
  </form>
}

function ScheduleRow({ item, reload, onEdit }: { item: Item; reload: () => Promise<void>; onEdit: () => void }) {
  const { t, call, notify } = usePanel()
  const toggle = useAction(async () => {
    await call('PUT schedules/:id', { id: item.id, body: { revision: item.revision,
      config: { ...item.config, enabled: !item.config.enabled } } })
  }, { reload })
  const run = useAction(async () => {
    const result = await call('POST schedules/:id/run', { id: item.id })
    notify(t(result.status === 'running' ? 'scheduleStarted' : 'scheduleQueued'))
  }, { reload })
  const remove = async () => { await call('DELETE schedules/:id', { id: item.id, body: { revision: item.revision } }) }
  const last = item.lastRun
  const lastStatus = last ? t(`schedule.${last.status}`) : t('scheduleNeverRun')
  return <li className="dt-card">
    <div className="dt-card-head">
      <strong className="dt-card-title">{item.config.name}</strong>
      <span className="dt-hint">{item.config.enabled ? t('scheduleEnabled') : t('scheduleDisabled')}</span>
      {item.running && <span className="dt-stage" data-state="ongoing">{t('scheduleRunning')}</span>}
    </div>
    <p className="dt-mono dt-clamp">{item.config.program}{item.config.args.length ? ` ${item.config.args.join(' ')}` : ''}</p>
    <div className="dt-row-meta">
      <span>{t('scheduleInterval')} · {item.config.intervalSeconds}</span>
      <span>{t('scheduleNextRun')} · {item.nextRunAt ? <When at={item.nextRunAt} /> : t('empty')}</span>
      <span>{t('scheduleLastRun')} · {last ? <>{lastStatus} · <When at={last.finishedAt ?? last.startedAt} />
        {last.exitCode !== undefined ? ` · ${t('scheduleExitCode', { code: last.exitCode })}` : ''}
        {last.error ? ` · ${last.error}` : ''}</> : lastStatus}</span>
    </div>
    <div className="dt-actions">
      <Button variant="outline" size="sm" disabled={toggle.busy} aria-busy={toggle.busy}
        onClick={() => { void toggle.run() }}>{t(item.config.enabled ? 'scheduleDisableAction' : 'scheduleEnableAction')}</Button>
      <Button variant="outline" size="sm" disabled={run.busy || item.running} aria-busy={run.busy || item.running}
        icon={<Icon name={run.busy ? 'running' : 'play'} />} onClick={() => { void run.run() }}>{t('scheduleRun')}</Button>
      <Button variant="ghost" size="sm" onClick={onEdit}>{t('scheduleEdit')}</Button>
      <ConfirmButton label={t('scheduleDelete')} title={t('scheduleDelete')} message={t('scheduleDeleteConfirm', { name: item.config.name })}
        variant="ghost" icon="trash" onConfirm={async () => { await remove(); await reload() }} />
    </div>
  </li>
}

export function SchedulesSettings() {
  const { t, call } = usePanel()
  const { data, error, reload } = usePoll(() => call('GET schedules'), [call])
  const [editing, setEditing] = useState<Item | 'new'>()
  return <div className="dt-form">
    <Hint>{t('scheduleIntro')}</Hint>
    <LoadState error={error} loading={!data} />
    {editing !== undefined && <ScheduleEditor key={editing === 'new' ? 'new' : editing.id} item={editing === 'new' ? undefined : editing}
      onCancel={() => setEditing(undefined)} onSaved={reload} />}
    {editing === undefined && <Section title={t('schedulesTitle')} action={<Button variant="outline" size="sm" icon={<Icon name="plus" />}
      onClick={() => setEditing('new')}>{t('scheduleAdd')}</Button>}>
      {data?.items.length ? <ul className="dt-cards">{data.items.map(item => <ScheduleRow key={item.id} item={item} reload={reload}
        onEdit={() => setEditing(item)} />)}</ul> : data && <Hint>{t('schedulesEmpty')}</Hint>}
    </Section>}
  </div>
}
