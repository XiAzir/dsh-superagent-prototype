/** Owner-visible device binding and evidence-backed resolution of uncertain remote outcomes. */
import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { ApiResponse } from '../app/api.ts'
import { usePoll, type Call } from './api.ts'
import { Button, Input } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { errorText, when, type T } from './text.ts'
import { VERIFICATION_CSS } from './verification.tsx'

type Devices = ApiResponse<'GET environments'>['items']
type Environment = ApiResponse<'GET tickets/:id/environment'>
type Command = Environment['commands'][number]
type Outcome = 'completed' | 'failed' | 'cancelled'
const freshId = () => globalThis.crypto?.randomUUID?.() ?? `owner_${Date.now()}_${Math.random().toString(36).slice(2)}`

export function RemoteEnvironmentSettings() {
  const { call, t } = usePanel()
  const { data, error, reload } = usePoll(() => call('GET environments'), [call], 10_000)
  const [draft, setDraft] = useState({ id: '', label: '', url: '', credentialRef: '' })
  const [busy, setBusy] = useState(''), [failures, setFailures] = useState<Record<string, string>>({}), [notice, setNotice] = useState('')
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const register = async (event: FormEvent) => {
    event.preventDefault(); if (busy) return
    setBusy('register'); setNotice(''); setFailures(current => ({ ...current, register: '' }))
    try {
      await call('POST environments', { body: draft })
      if (mounted.current) { setDraft({ id: '', label: '', url: '', credentialRef: '' }); setNotice(t('remote.registered')); await reload() }
    } catch (error) { if (mounted.current) setFailures(current => ({ ...current, register: errorText(error) })) }
    finally { if (mounted.current) setBusy('') }
  }
  const probe = async (id: string) => {
    if (busy) return
    setBusy(id); setFailures(current => ({ ...current, [id]: '' }))
    try { await call('POST environments/:id/probe', { id }) }
    catch (error) { if (mounted.current) setFailures(current => ({ ...current, [id]: errorText(error) })) }
    finally { if (mounted.current) { setBusy(''); await reload() } }
  }
  return <section className="sa-verification sa-supervision-settings" aria-label={t('remote.settings')}>
    <style>{VERIFICATION_CSS}</style><h3>{t('remote.settings')}</h3>
    {error && <p className="dt-error" role="alert">{error.message} <Button size="sm" onClick={() => { void reload() }}>{t('retry')}</Button></p>}
    {data?.items.length === 0 && <p>{t('remote.noDevices')}</p>}
    <ul className="sa-verification-list">{data?.items.map(device => <li key={device.id}>
      <strong>{device.label}</strong> · <span>{t(`remote.state.${device.status}`)}</span>
      <p><code>{device.id}</code> · {device.url}</p>{device.lastSeenAt && <small>{when(device.lastSeenAt, t('lang'))}</small>}
      {device.error && <p>{device.error}</p>}
      <div><Button size="sm" variant="outline" disabled={!!busy} onClick={() => { void probe(device.id) }}>{t('remote.probe')}</Button></div>
      {failures[device.id] && <p className="dt-error" role="alert">{failures[device.id]}</p>}
    </li>)}</ul>
    <details><summary>{t('remote.register')}</summary><p>{t('remote.credentialHint')}</p>
      <form onSubmit={event => { void register(event) }}><fieldset className="dt-fieldset" disabled={!!busy}>
        {(['id', 'label', 'url', 'credentialRef'] as const).map(name => <div className="dt-field" key={name}>
          <label htmlFor={`sa-device-${name}`}>{t(`remote.${name}`)}</label><Input id={`sa-device-${name}`} value={draft[name]}
            type={name === 'url' ? 'url' : 'text'} required maxLength={name === 'id' ? 64 : name === 'label' ? 100 : 500}
            pattern={name === 'id' ? '[A-Za-z0-9][A-Za-z0-9_-]{0,63}' : undefined} autoComplete="off" spellCheck={false}
            onChange={event => setDraft(current => ({ ...current, [name]: event.target.value }))} />
        </div>)}
        <Button type="submit" variant="outline" size="sm">{t(busy === 'register' ? 'verification.saving' : 'remote.register')}</Button>
      </fieldset></form>
      {failures.register && <p className="dt-error" role="alert">{failures.register}</p>}
    </details>{notice && <p role="status">{notice}</p>}
  </section>
}

export function TaskEnvironment({ id, title, call, t, onChanged }: { id: string; title?: string; call: Call; t: T; onChanged?: () => Promise<unknown> | void }) {
  return <TaskEnvironmentDetail key={id} id={id} title={title} call={call} t={t} onChanged={onChanged} />
}
function TaskEnvironmentDetail({ id, title, call, t, onChanged }: { id: string; title?: string; call: Call; t: T; onChanged?: () => Promise<unknown> | void }) {
  const [open, setOpen] = useState(false), [deviceId, setDeviceId] = useState(''), [busy, setBusy] = useState(false), [failure, setFailure] = useState(''), [notice, setNotice] = useState('')
  const { data: environment, error, reload } = usePoll(() => open ? call('GET tickets/:id/environment', { id }) : Promise.resolve<Environment | undefined>(undefined), [id, call, open], 4000)
  const devices = usePoll(() => open ? call('GET environments') : Promise.resolve<{ items: Devices } | undefined>(undefined), [id, call, open], 10_000)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { if (environment) setDeviceId(environment.deviceId ?? '') }, [environment?.deviceId])
  const label = (selected: string | null) => devices.data?.items.find(item => item.id === selected)?.label ?? selected ?? t('remote.local')
  const bind = async () => {
    if (!deviceId || busy) return
    setBusy(true); setFailure(''); setNotice('')
    try {
      await call('PUT tickets/:id/environment', { id, body: { deviceId } })
      if (mounted.current) { setNotice(t('remote.bound')); await reload(); await onChanged?.() }
    } catch (error) { if (mounted.current) setFailure(errorText(error)) }
    finally { if (mounted.current) setBusy(false) }
  }
  return <details className="sa-verification sa-remote-task" onToggle={event => setOpen(event.currentTarget.open)}>
    <style>{VERIFICATION_CSS}</style><summary>{t('remote.task')}{title ? ` · ${title}` : ''}</summary>
    {open && <>
      {error && <p className="dt-error" role="alert">{error.message} <Button size="sm" onClick={() => { void reload() }}>{t('retry')}</Button></p>}
      {devices.error && <p className="dt-error" role="alert">{devices.error.message} <Button size="sm" onClick={() => { void devices.reload() }}>{t('retry')}</Button></p>}
      {!environment && !error && <p role="status">{t('loading')}</p>}
      {environment && <><p>{t('remote.current', { device: label(environment.deviceId) })}</p>
        {!!devices.data?.items.length && <><label htmlFor={`sa-task-device-${id}`}>{t('remote.choose')}</label>
          <select id={`sa-task-device-${id}`} className="dt-select" value={deviceId} disabled={busy} onChange={event => setDeviceId(event.target.value)}>
            <option value="">{t('remote.choose')}</option>{devices.data.items.map(device => <option key={device.id} value={device.id}>
              {device.label} · {t(`remote.state.${device.status}`)}</option>)}</select>
          <p className="sa-verification-muted">{t('remote.bindHint')}</p>
          <Button size="sm" variant="outline" disabled={busy || !deviceId || deviceId === environment.deviceId} onClick={() => { void bind() }}>{t('remote.bind', { device: label(deviceId) })}</Button></>}
        {environment.commands.length === 0 && <p>{t('remote.noCommands')}</p>}
        <ol className="sa-verification-list">{environment.commands.map(command => <li key={command.commandId}>
          <CommandView id={id} command={command} device={label(command.deviceId)} call={call} t={t} onChanged={reload} />
        </li>)}</ol>
      </>}
      {failure && <p className="dt-error" role="alert">{failure}</p>}{notice && <p role="status">{notice}</p>}
    </>}
  </details>
}

function CommandView({ id, command, device, call, t, onChanged }: { id: string; command: Command; device: string; call: Call; t: T; onChanged(): Promise<unknown> }) {
  const [busy, setBusy] = useState(false), [failure, setFailure] = useState(''), [notice, setNotice] = useState('')
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const cancel = async () => {
    if (busy) return
    setBusy(true); setFailure('')
    try {
      await call('POST tickets/:id/environment/commands/:commandId/cancel', { id, commandId: command.commandId })
      if (mounted.current) { setNotice(t('remote.cancelled')); await onChanged() }
    } catch (error) { if (mounted.current) setFailure(errorText(error)) }
    finally { if (mounted.current) setBusy(false) }
  }
  return <div className="sa-remote-command" data-command-id={command.commandId}>
    <strong>{t('remote.command', { id: command.commandId.slice(0, 12) })}</strong>
    <p role="status">{t(`remote.command.${command.effectiveState}`)} · {device}</p>
    <p><code>{command.commandId}</code></p>
    {command.error && <p>{command.error}</p>}
    {command.remote && <details><summary>{t('remote.output')}</summary><p><code>{command.remote.directory}</code></p>
      <pre>{command.remote.stdout}</pre>{command.remote.stderr && <pre>{command.remote.stderr}</pre>}</details>}
    {['queued', 'waiting_environment', 'accepted', 'running'].includes(command.effectiveState) && <Button size="sm" variant="outline" disabled={busy} onClick={() => { void cancel() }}>{t('remote.cancel')}</Button>}
    {command.ownerResolution && <><p>{t('remote.ownerResolution', { state: t(`remote.command.${command.ownerResolution.outcome}`) })}</p>
      <p>{command.ownerResolution.evidence}</p><small>{when(command.ownerResolution.at, t('lang'))}</small></>}
    {command.state === 'unknown' && <details><summary>{t(command.ownerResolution ? 'remote.resolveCorrection' : 'remote.resolve')}</summary>
      <ResolveUnknown id={id} command={command} device={device} call={call} t={t} onChanged={onChanged} /></details>}
    {failure && <p className="dt-error" role="alert">{failure}</p>}{notice && <p role="status">{notice}</p>}
  </div>
}

function ResolveUnknown({ id, command, device, call, t, onChanged }: { id: string; command: Command; device: string; call: Call; t: T; onChanged(): Promise<unknown> }) {
  const [outcome, setOutcome] = useState<Outcome>(command.ownerResolution?.outcome ?? 'completed'), [evidence, setEvidence] = useState(command.ownerResolution?.evidence ?? '')
  const [preview, setPreview] = useState<{ outcome: Outcome; evidence: string; expectedUpdatedAt: string }>(), [busy, setBusy] = useState(false), [failure, setFailure] = useState(''), [notice, setNotice] = useState('')
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const resolve = async () => {
    if (!preview || busy) return
    setBusy(true); setFailure('')
    try {
      await call('POST tickets/:id/environment/commands/:commandId/resolve', { id, commandId: command.commandId, body: preview })
      if (mounted.current) { setPreview(undefined); setNotice(t('remote.resolved')); await onChanged() }
    } catch (error) { if (mounted.current) { setFailure(errorText(error)); setPreview(undefined) } }
    finally { if (mounted.current) setBusy(false) }
  }
  return <div className="sa-remote-resolution"><p>{t('remote.resolveHint')}</p>
    <fieldset className="dt-fieldset" disabled={busy}>
      <label htmlFor={`sa-command-outcome-${command.commandId}`}>{t('remote.outcome')}</label>
      <select id={`sa-command-outcome-${command.commandId}`} className="dt-select" value={outcome} onChange={event => { setOutcome(event.target.value as Outcome); setPreview(undefined); setNotice('') }}>
        {(['completed', 'failed', 'cancelled'] as const).map(state => <option key={state} value={state}>{t(`remote.command.${state}`)}</option>)}</select>
      <label htmlFor={`sa-command-evidence-${command.commandId}`}>{t('remote.evidence')}</label>
      <textarea id={`sa-command-evidence-${command.commandId}`} className="dt-textarea" rows={3} maxLength={2000} required value={evidence}
        onChange={event => { setEvidence(event.target.value); setPreview(undefined); setNotice('') }} />
      {!preview && <Button size="sm" variant="outline" disabled={!evidence.trim()} onClick={() => setPreview({ outcome, evidence: evidence.trim(), expectedUpdatedAt: command.updatedAt })}>{t('remote.preview')}</Button>}
      {preview && <div className="dt-banner"><p>{t('remote.confirmTarget', { device, command: command.commandId, state: t(`remote.command.${preview.outcome}`) })}</p>
        <p>{preview.evidence}</p><Button size="sm" variant="outline" onClick={() => { void resolve() }}>{t('remote.confirm', { state: t(`remote.command.${preview.outcome}`) })}</Button>
        <Button size="sm" onClick={() => setPreview(undefined)}>{t('cancel')}</Button></div>}
    </fieldset>{failure && <p className="dt-error" role="alert">{failure}</p>}{notice && <p role="status">{notice}</p>}
  </div>
}

export function EvaluationSummaryPanel() {
  const { call, t } = usePanel()
  const { data, error, reload } = usePoll(() => call('GET evaluation/summary'), [call], 15_000)
  const value = (number: number | null | undefined, percentage = false) => number == null ? t('evaluation.unknown')
    : percentage ? `${(number * 100).toFixed(1)}%` : number.toLocaleString(t('lang') === 'zh' ? 'zh-CN' : 'en', { maximumFractionDigits: 6 })
  return <section className="sa-verification" aria-label={t('evaluation.title')}><h3>{t('evaluation.title')}</h3>
    {error && <p className="dt-error" role="alert">{error.message} <Button size="sm" onClick={() => { void reload() }}>{t('retry')}</Button></p>}
    {data && <><dl className="sa-evaluation-grid">{([
      ['events', data.events], ['routerDecisions', data.metrics.routerDecisions], ['interventions', data.metrics.humanInterventions],
      ['routingCorrections', data.metrics.routingCorrections], ['falseCompletions', data.metrics.falseCompletions],
      ['wrongRoutes', data.metrics.wrongRoutes], ['tokens', data.metrics.tokens], ['cost', data.metrics.cost],
    ] as const).map(([name, number]) => <div key={name}><dt>{t(`evaluation.${name}`)}</dt><dd>{value(number)}</dd></div>)}
      <div><dt>{t('evaluation.adoption')}</dt><dd>{value(data.metrics.adoptionRate, true)}</dd></div>
      <div><dt>{t('evaluation.p95')}</dt><dd>{data.metrics.completionLatencyMs.p95 == null ? t('evaluation.unknown') : `${value(data.metrics.completionLatencyMs.p95)} ms`}</dd></div></dl>
      <p className="sa-verification-muted">{t('evaluation.coverage', { completion: data.coverage.completionJudgments, adoption: data.coverage.adoptionJudgments })}</p></>}
  </section>
}

export function TaskFeedback({ id, call, t }: { id: string; call: Call; t: T }) {
  const [accepted, setAccepted] = useState(''), [correct, setCorrect] = useState(''), [routing, setRouting] = useState(false)
  const [busy, setBusy] = useState(false), [failure, setFailure] = useState(''), [saved, setSaved] = useState(false)
  const request = useRef<{ signature: string; id: string }>(), mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const save = async () => {
    const body = { ...accepted ? { accepted: accepted === 'yes' } : {}, ...correct ? { correct: correct === 'yes' } : {}, ...routing ? { routingCorrection: true } : {} }
    const signature = JSON.stringify(body)
    if (request.current?.signature !== signature) request.current = { signature, id: freshId() }
    setBusy(true); setFailure('')
    try { await call('POST tickets/:id/feedback', { id, body: { ...body, requestId: request.current.id } }); if (mounted.current) setSaved(true) }
    catch (error) { if (mounted.current) setFailure(errorText(error)) } finally { if (mounted.current) setBusy(false) }
  }
  return <details className="sa-verification"><summary>{t('feedback.title')}</summary><fieldset className="dt-fieldset" disabled={busy}>
    {([['accepted', accepted, setAccepted], ['correct', correct, setCorrect]] as const).map(([name, value, set]) => <div className="dt-field" key={name}>
      <label htmlFor={`sa-feedback-${id}-${name}`}>{t(`feedback.${name}`)}</label><select id={`sa-feedback-${id}-${name}`} className="dt-select" value={value}
        onChange={event => { set(event.target.value); setSaved(false) }}><option value="">{t('feedback.unset')}</option><option value="yes">{t('yes')}</option><option value="no">{t('no')}</option></select></div>)}
    <label><input type="checkbox" checked={routing} onChange={event => { setRouting(event.target.checked); setSaved(false) }} /> {t('feedback.routing')}</label>
    <div><Button size="sm" variant="outline" disabled={saved || (!accepted && !correct && !routing)} onClick={() => { void save() }}>{t('feedback.save')}</Button></div>
  </fieldset>{failure && <p className="dt-error" role="alert">{failure}</p>}{saved && <p role="status">{t('feedback.saved')}</p>}</details>
}
