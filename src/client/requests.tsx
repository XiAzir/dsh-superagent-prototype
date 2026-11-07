/** Existing task and execution settings expose request ownership and bounded routing recovery. */
import { useEffect, useState } from 'react'
import type { ApiResponse } from '../app/api.ts'
import { usePoll, type Call } from './api.ts'
import { Button } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { errorText, when, type T } from './text.ts'

/** Request history loads only when the user expands the existing task detail. */
export function TicketRequests({ id, call, t }: { id: string; call: Call; t: T }) {
  const [expanded, setExpanded] = useState(false)
  return <section className="sa-verification"><details open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary>{t('requests.title')}</summary>
    {expanded && <RequestDetails key={id} id={id} call={call} t={t} />}
  </details></section>
}
function RequestDetails({ id, call, t }: { id: string; call: Call; t: T }) {
  const { data, error, reload } = usePoll(() => call('GET tickets/:id/requests', { id, query: { limit: 30 } }), [id, call], 5000)
  return <>
    {error && <p role="alert" className="dt-error">{error.message} <Button size="sm" onClick={() => void reload()}>{t('retry')}</Button></p>}
    {!data && !error && <p role="status">{t('loading')}</p>}
    {data?.items.length === 0 && <p>{t('requests.empty')}</p>}
    <ol className="sa-verification-list">{data?.items.map(({ request, source }) => <li key={request.id}>
      <strong>{t(`requests.state.${request.state}`)}</strong> · <small>{when(source.at, t('lang'))}</small>
      <p>{source.preview}</p>
      {request.owners.map(owner => <p key={owner.ticketId}><span>{t('requests.owner')}</span> <code title={owner.ticketId}>{owner.ticketId.slice(0, 12)}</code></p>)}
      <details><summary>{t('requests.history')}</summary><ol>{request.history.map(item => <li key={item.revision}>
        {item.reason ?? item.kind} · <small>{when(item.at, t('lang'))}</small>
      </li>)}</ol></details>
    </li>)}</ol>
    {data?.next_offset != null && <p>{t('requests.moreHint')}</p>}
  </>
}

/** Coverage checks share the existing execution settings and retain local failure/retry state. */
export function RequestRecoverySettings() {
  const { call, t } = usePanel()
  const { data, error, reload } = usePoll(() => call('GET routing-review/config'), [call])
  const [draft, setDraft] = useState<ApiResponse<'GET routing-review/config'>>(), [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState(''), [notice, setNotice] = useState('')
  useEffect(() => { if (data) setDraft(data) }, [data])
  const save = async () => {
    if (!draft || busy) return
    setBusy(true); setFailure(''); setNotice('')
    try { await call('PUT routing-review/config', { body: draft }); setNotice(t('verification.saved')); await reload() }
    catch (error) { setFailure(errorText(error)) } finally { setBusy(false) }
  }
  return <section className="sa-verification"><h3>{t('requests.settings')}</h3><p>{t('requests.settingsHint')}</p>
    {error && <p role="alert" className="dt-error">{error.message} <Button size="sm" onClick={() => void reload()}>{t('retry')}</Button></p>}
    {draft && <fieldset className="dt-fieldset" disabled={busy}>
      <div className="dt-field"><label htmlFor="sa-request-review-mode">{t('verification.settingMode')}</label>
        <select id="sa-request-review-mode" className="dt-select" value={draft.mode} onChange={event => setDraft({ ...draft, mode: event.target.value as typeof draft.mode })}>
          {(['off', 'observe', 'repair'] as const).map(mode => <option key={mode} value={mode}>{t(`requests.mode.${mode}`)}</option>)}
        </select></div>
      <p>{t('requests.budget', { limit: draft.maxReviewsPerHour, repairs: draft.maxRecoveries })}</p>
      <Button size="sm" variant="outline" onClick={() => void save()}>{t(busy ? 'verification.saving' : 'save')}</Button>
    </fieldset>}
    {notice && <p role="status">{notice}</p>}{failure && <p role="alert" className="dt-error">{failure}</p>}
  </section>
}
