/** Authenticated downloads for files delivered into a personal task conversation. */
import { useEffect, useRef, useState } from 'react'
import { Button } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { errorText } from './text.ts'

export function ArtifactDownload({ conversation, artifact }: { conversation: string; artifact: { id: string; name: string; size: number } }) {
  const { t } = usePanel()
  const [busy, setBusy] = useState(false), [failure, setFailure] = useState('')
  const pending = useRef<AbortController>()
  useEffect(() => () => { pending.current?.abort() }, [])
  const download = async () => {
    if (pending.current) return
    const controller = pending.current = new AbortController()
    setBusy(true); setFailure('')
    try {
      const response = await fetch(`/orchestrator/api/web/tasks/${encodeURIComponent(conversation)}/artifacts/${encodeURIComponent(artifact.id)}`, {
        headers: { 'x-orchestrator-request': '1' }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]) })
      if (!response.ok) {
        const detail = await response.json().catch(() => ({})) as { error?: string }
        throw new Error(detail.error ?? t('webTask.downloadFailed'))
      }
      const blob = await response.blob()
      if (controller.signal.aborted) return
      const url = URL.createObjectURL(blob), link = document.createElement('a')
      try {
        link.href = url; link.download = artifact.name; link.hidden = true
        document.body.append(link); link.click()
      } finally { link.remove(); setTimeout(() => { URL.revokeObjectURL(url) }, 1000) }
    } catch (error) {
      if (!controller.signal.aborted) setFailure(errorText(error))
    } finally {
      if (!controller.signal.aborted) setBusy(false)
      if (pending.current === controller) pending.current = undefined
    }
  }
  return <div className="dt-web-task-artifact">
    <Button variant="outline" disabled={busy} aria-busy={busy} className="dt-web-task-artifact-button"
      onClick={() => { void download() }}>{t(busy ? 'webTask.downloading' : 'webTask.download', { name: artifact.name })}</Button>
    <small>{(artifact.size / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} KB</small>
    {failure && <p className="dt-error" role="alert">{failure}</p>}
  </div>
}
