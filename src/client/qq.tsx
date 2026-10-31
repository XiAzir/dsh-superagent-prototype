/** QQ connection status, NapCat mode guidance, and credential controls for the QQ Source card. */
import { useState } from 'react'
import type { QqStatus } from '../app/qq-source.ts'
import { usePoll } from './api.ts'
import { Button, Dot, Input, Tag } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { settingsRoute } from './route.ts'
import { errorText, when } from './text.ts'
import { Hint } from './widgets.tsx'

function statusDot(state: QqStatus['state']) {
  return state === 'connected' ? 'done' : state === 'connecting' ? 'ongoing' : state === 'error' ? 'error'
    : state === 'disconnected' ? 'warning' : 'idle'
}

/** QQ-only controls live inside the existing Source form; the credential actions are explicit buttons. */
export function QqSourcePanel({ config }: { config: Record<string, unknown> }) {
  const { t, call, navigate, notify } = usePanel()
  const { data, error, reload } = usePoll(() => call('GET qq/status'), [call], 2000)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [tokenError, setTokenError] = useState('')
  const mode = config.connection === 'reverse' ? 'reverse' : 'forward'
  const guide = mode === 'reverse' ? 'qq.reverseGuide' : 'qq.forwardGuide'
  const host = String(config.host ?? '127.0.0.1')
  const url = mode === 'reverse'
    ? `ws://${host === '::1' ? '[::1]' : host}:${String(config.port ?? 6199)}${String(config.path ?? '/onebot/v11/ws')}`
    : String(config.url ?? data?.forwardUrl ?? 'ws://127.0.0.1:3001')
  const save = async (value: string, clear: boolean) => {
    setBusy(true)
    setTokenError('')
    try {
      await call('PUT qq/token', { body: { value } })
      if (clear) setToken('')
      notify(t(value.trim() ? 'qq.tokenSaved' : 'qq.tokenCleared'))
      await reload()
    } catch (failure) { setTokenError(errorText(failure)) }
    finally { setBusy(false) }
  }
  return <section className="dt-form" aria-label={t('qq.connectionStatus')}>
    <div className="dt-status-head">
      <h3 className="dt-status-title">{t('qq.connectionStatus')}</h3>
      {data && <><Dot state={statusDot(data.state)} /><span className="dt-status-text" data-state={statusDot(data.state)}>
        {t(`qq.state.${data.state}`)}</span></>}
    </div>
    {error && <p className="dt-error">{errorText(error)}</p>}
    {data && <>
      {data.detail && <p className={data.state === 'error' ? 'dt-error' : 'dt-hint'}>{data.detail}</p>}
      <div className="dt-row-meta">
        <Tag tone="neutral">{t(`qq.mode.${data.mode}`)}</Tag>
        <span>{t('qq.allowedUsers')}: {data.allowedUsers}</span>
        <span>{t('qq.groups')}: {data.groups}</span>
        <span>{t('qq.received')}: {data.received}</span>
      </div>
      {data.selfId && <p className="dt-hint">{t('qq.selfId')}: <span className="dt-mono">{data.selfId}</span></p>}
      {data.lastMessageAt && <p className="dt-hint">{t('qq.lastMessage')}: {when(data.lastMessageAt, t('lang'))}</p>}
      {url && <p className="dt-hint">{t(mode === 'reverse' ? 'qq.reverseUrl' : 'qq.forwardUrl')}: <span className="dt-mono">{url}</span></p>}
    </>}
    <Hint>{t(guide)}</Hint>
    <div className="dt-field">
      <div className="dt-field-head">{t('qq.tokenTitle')} <Tag tone={data?.tokenConfigured ? 'success' : 'neutral'}>
        {t(data?.tokenConfigured ? 'qq.tokenConfigured' : 'qq.tokenMissing')}</Tag></div>
      <Input type="password" aria-label={t('qq.tokenTitle')} autoComplete="new-password" spellCheck={false}
        placeholder={t('qq.tokenPlaceholder')} value={token}
        disabled={busy} onChange={event => setToken(event.target.value)} />
      <div className="dt-row-buttons">
        <Button variant="primary" disabled={busy || !token.trim()} onClick={() => { void save(token, true) }}>{t('qq.tokenSave')}</Button>
        <Button disabled={busy || !data?.tokenConfigured} onClick={() => { void save('', true) }}>{t('qq.tokenClear')}</Button>
      </div>
      {tokenError && <p className="dt-error" role="status">{tokenError}</p>}
    </div>
    <button type="button" className="dt-textlink" onClick={() => navigate(settingsRoute('eval'))}>
      {t('qq.configureAllowed')}
    </button>
  </section>
}
