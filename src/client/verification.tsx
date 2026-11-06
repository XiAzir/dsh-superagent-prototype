/** Additive result review controls shared by task pages and the native collaboration sidebar. */
import { useEffect, useRef, useState } from 'react'
import type { ApiResponse } from '../app/api.ts'
import type { AcceptancePlan, CompletionVerification } from '../core/verification.ts'
import { usePoll, type Call } from './api.ts'
import { Button, Icon } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { errorText, when, type T } from './text.ts'
import CSS from './verification.css?raw'

export const VERIFICATION_CSS = CSS
type View = ApiResponse<'GET tickets/:id/verification'>
type Config = ApiResponse<'GET verification/config'>
type WatchdogConfig = ApiResponse<'GET watchdog/config'>
export interface VerificationProps { acceptance?: AcceptancePlan | null; verification?: CompletionVerification | null }
const freshId = () => globalThis.crypto?.randomUUID?.() ?? `verify_${Date.now()}_${Math.random().toString(36).slice(2)}`

/** Cards keep a text label as well as color; only the focused detail announces live status changes. */
export function VerificationBadge({ acceptance, verification, t }: VerificationProps & { t: T }) {
  if (!acceptance && !verification) return null
  const state = verification?.state ?? 'not_started'
  return <span className="sa-verification-badge" data-state={state}>
    <Icon name={state === 'passed' ? 'decision' : state === 'unknown' || state === 'needs_changes' ? 'alert' : 'review'} size={14} />
    <span>{t(acceptance?.mode === 'enforce' ? 'verification.mode.enforce' : 'verification.mode.observe')}
      {(verification || acceptance?.mode === 'enforce') && ` · ${t(`verification.state.${state}`)}`}</span>
  </span>
}

type TicketVerificationProps = VerificationProps & {
  id: string; taskTitle?: string; hold?: { reason: string }; call: Call; t: T; onChanged?: () => Promise<unknown> | void
}
export function TicketVerification(props: TicketVerificationProps) {
  return props.acceptance || props.verification || props.hold ? <VerificationDetail key={props.id} {...props} /> : null
}

function VerificationDetail({ id, taskTitle, acceptance, verification, hold, call, t, onChanged }: TicketVerificationProps) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState<'verify' | 'resume'>(), [failure, setFailure] = useState(''), [notice, setNotice] = useState('')
  const mounted = useRef(true), requestId = useRef<string>(), activeId = useRef(id)
  activeId.current = id
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { setOpen(false); setFailure(''); setNotice(''); setBusy(undefined); requestId.current = undefined }, [id])
  const { data, error, reload } = usePoll(async () => ({ ticketId: id, view: open ? await call('GET tickets/:id/verification', { id })
    : { acceptance: acceptance ?? null, verification: verification ?? null, history: [] } as View }), [id, open, call], 4000)
  const details = data?.ticketId === id ? data.view : undefined
  const current = open && details ? details : { acceptance, verification }
  const review = current.verification, plan = current.acceptance
  if (!plan && !review && !hold) return null
  const action = async (kind: 'verify' | 'resume') => {
    if (busy) return
    setBusy(kind); setFailure(''); setNotice('')
    try {
      let ready = true
      if (kind === 'verify') {
        requestId.current ??= freshId()
        const result = await call('POST tickets/:id/verify', { id, body: { requestId: requestId.current } })
        ready = result.reviewId !== null
        requestId.current = undefined
      } else await call('POST tickets/:id/resume', { id })
      if (!mounted.current || activeId.current !== id) return
      setNotice(t(kind === 'verify' ? ready ? 'verification.requested' : 'verification.notReady' : 'verification.resumed'))
      setOpen(true)
      await onChanged?.(); await reload()
    } catch (error) { if (mounted.current && activeId.current === id) setFailure(errorText(error)) }
    finally { if (mounted.current && activeId.current === id) setBusy(undefined) }
  }
  return <section className="sa-verification" aria-label={`${t('verification.title')}${taskTitle ? ` · ${taskTitle}` : ''}`}>
    <style>{CSS}</style><div className="sa-verification-head"><strong>{t('verification.title')}</strong>
      <span role="status" aria-atomic="true"><VerificationBadge acceptance={plan} verification={review} t={t} /></span></div>
    {taskTitle && <p className="sa-verification-muted">{taskTitle}</p>}
    {review?.summary && <p>{review.summary}</p>}
    {plan && <p className="sa-verification-muted">{t(plan.mode === 'observe' ? 'verification.observeHint' : 'verification.enforceHint')}</p>}
    {hold && <p>{t('verification.held', { reason: hold.reason })}</p>}
    <div className="sa-verification-actions">
      <Button size="sm" variant="outline" aria-expanded={open} onClick={() => setOpen(value => !value)}>{t(open ? 'verification.hide' : 'verification.details')}</Button>
      {(plan || review) && <Button size="sm" variant="outline" disabled={!!busy || review?.state === 'running'} onClick={() => { void action('verify') }}>
        {t(busy === 'verify' ? 'verification.requesting' : 'verification.retry')}</Button>}
      {hold && <Button size="sm" variant="outline" disabled={!!busy} onClick={() => { void action('resume') }}>{t('verification.resume')}</Button>}
    </div>
    {notice && <p role="status">{notice}</p>}
    {failure && <p className="dt-error" role="alert">{failure}</p>}
    {open && <div className="sa-verification-detail">
      {error && <p className="dt-error" role="alert">{error.message} <Button size="sm" variant="outline" onClick={() => { void reload() }}>{t('retry')}</Button></p>}
      {!!plan?.criteria.length && <><h4>{t('verification.criteria')}</h4><ol className="sa-verification-list">{plan.criteria.map(criterion => {
        const check = review?.checks.find(item => item.criterionId === criterion.id)
        return <li key={criterion.id}><strong>{criterion.description}</strong>
          {check && <><p>{t(`verification.state.${check.state}`)} · {check.summary}</p>
            {!!check.evidenceRefs.length && <details><summary>{t('verification.evidence')}</summary>
              {check.evidenceRefs.map(ref => <p key={ref}><code>{ref}</code></p>)}</details>}</>}
        </li>
      })}</ol></>}
      {!plan?.criteria.length && <p className="sa-verification-muted">{t('verification.noCriteria')}</p>}
      {review && <p className="sa-verification-muted">{t('verification.attempt', { attempt: review.attempt })} · {when(review.at, t('lang'))}</p>}
      {!!details?.history.length && <details><summary>{t('verification.history', { count: details.history.length })}</summary>
        <ol className="sa-verification-list">{details.history.map(item => <li key={item.id}><strong>{t(`verification.state.${item.state}`)}</strong>
          <p>{item.summary}</p><small>{when(item.at, t('lang'))}</small></li>)}</ol></details>}
    </div>}
  </section>
}

/** These controls live inside the existing Execution settings group; failures stay local to their section. */
export function VerificationSettings() {
  const { call, t } = usePanel()
  const { data: saved, error, reload } = usePoll(() => call('GET verification/config'), [call])
  const [draft, setDraft] = useState<Config>(), [busy, setBusy] = useState(false), [failure, setFailure] = useState(''), [notice, setNotice] = useState('')
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { if (saved) setDraft(saved) }, [saved])
  const save = async () => {
    if (!draft || busy) return
    setBusy(true); setFailure(''); setNotice('')
    try { await call('PUT verification/config', { body: draft }); if (mounted.current) { setNotice(t('verification.saved')); await reload() } }
    catch (error) { if (mounted.current) setFailure(errorText(error)) } finally { if (mounted.current) setBusy(false) }
  }
  return <><section className="sa-verification sa-supervision-settings" aria-label={t('verification.settings')}>
    <style>{CSS}</style><h3>{t('verification.settings')}</h3><p>{t('verification.newTasksHint')}</p>
    {!draft && !error && <p role="status">{t('loading')}</p>}
    {error && <p className="dt-error" role="alert">{error.message} <Button size="sm" onClick={() => { void reload() }}>{t('retry')}</Button></p>}
    {draft && <><fieldset className="dt-fieldset" disabled={busy}>
      <div className="dt-field"><label htmlFor="sa-verification-mode">{t('verification.settingMode')}</label>
        <select id="sa-verification-mode" className="dt-select" value={draft.mode} onChange={event => setDraft({ ...draft, mode: event.target.value as Config['mode'] })}>
          {(['off', 'observe', 'enforce'] as const).map(mode => <option value={mode} key={mode}>{t(`verification.mode.${mode}`)}</option>)}</select></div>
      <div className="dt-field"><label htmlFor="sa-verification-repairs">{t('verification.repairs')}</label>
        <select id="sa-verification-repairs" className="dt-select" value={draft.maxRepairs} onChange={event => setDraft({ ...draft, maxRepairs: Number(event.target.value) })}>
          {[0, 1, 2, 3].map(value => <option key={value} value={value}>{value}</option>)}</select></div>
      <Button variant="outline" size="sm" disabled={busy} onClick={() => { void save() }}>{t(busy ? 'verification.saving' : 'save')}</Button>
    </fieldset>{notice && <p role="status">{notice}</p>}{failure && <p className="dt-error" role="alert">{failure}</p>}</>}
  </section><SupervisionSettings call={call} t={t} /></>
}

function SupervisionSettings({ call, t }: { call: Call; t: T }) {
  const { data, error, reload } = usePoll(() => call('GET watchdog/config'), [call])
  const reviews = usePoll(() => call('GET watchdog/reviews', { query: { limit: 5 } }), [call], 10_000)
  const [mode, setMode] = useState<WatchdogConfig['mode']>('observe'), [busy, setBusy] = useState(false), [failure, setFailure] = useState(''), [notice, setNotice] = useState('')
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { if (data) setMode(data.mode) }, [data])
  const save = async () => {
    if (busy) return
    setBusy(true); setFailure(''); setNotice('')
    try { await call('POST watchdog/config', { body: { mode } }); if (mounted.current) { setNotice(t('verification.saved')); await reload() } }
    catch (error) { if (mounted.current) setFailure(errorText(error)) } finally { if (mounted.current) setBusy(false) }
  }
  return <section className="sa-verification sa-supervision-settings" aria-label={t('supervision.settings')}>
    <h3>{t('supervision.settings')}</h3><p>{t('supervision.hint')}</p>
    {!data && !error && <p role="status">{t('loading')}</p>}
    {error && <p className="dt-error" role="alert">{error.message} <Button size="sm" onClick={() => { void reload() }}>{t('retry')}</Button></p>}
    {data && <fieldset className="dt-fieldset" disabled={busy}><div className="dt-field"><label htmlFor="sa-supervision-mode">{t('verification.settingMode')}</label>
      <select id="sa-supervision-mode" className="dt-select" value={mode} onChange={event => setMode(event.target.value as WatchdogConfig['mode'])}>
        <option value="observe">{t('supervision.mode.observe')}</option><option value="advise">{t('supervision.mode.advise')}</option></select></div>
      <Button variant="outline" size="sm" onClick={() => { void save() }}>{t(busy ? 'verification.saving' : 'save')}</Button></fieldset>}
    {notice && <p role="status">{notice}</p>}{failure && <p className="dt-error" role="alert">{failure}</p>}
    <details><summary>{t('supervision.history')}</summary>
      {reviews.error && <p className="dt-error" role="alert">{reviews.error.message} <Button size="sm" onClick={() => { void reviews.reload() }}>{t('retry')}</Button></p>}
      {reviews.data?.length === 0 && <p className="sa-verification-muted">{t('supervision.noReviews')}</p>}
      <ol className="sa-verification-list">{reviews.data?.map(item => <li key={item.id}>
        <strong>{t(`supervision.state.${item.assessment?.status ?? 'unknown'}`)}</strong><small> · {when(item.createdAt, t('lang'))}</small>
        {item.error && <p>{item.error}</p>}{item.assessment?.findings.map((finding, index) => <div key={index}>
          <p>{finding.recommendation}</p><ul>{finding.evidence.map((evidence, at) => <li key={at}>{evidence}</li>)}</ul></div>)}</li>)}</ol>
    </details>
  </section>
}
