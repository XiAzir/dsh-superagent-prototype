/** Native right-sidebar registration for the collaboration workbench. */
import type { Context } from '@deepseek-ai/cordis'
import type { UseSidebarRightTabInfo } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { caller, type Call } from './api.ts'
import type { T } from './text.ts'
import { WorkerPanel } from './collaboration.tsx'
export { WorkerPanel } from './collaboration.tsx'

export const WORKER_PANEL_KIND = 'dsh-superagent/workers'
export const workerCaller = (t: T): Call => caller(() => ({ offline: t('offline'), notRunning: t('hostNotRunning'),
  serverError: status => t('serverError', { status }), requestFailed: status => t('requestFailed', { status }),
  setup: () => t('workerPanel.setup'), user: failure => t(`userError.${failure.code}`, failure.values) }))

/** Register an additive native tab and open it once per eligible desktop Session, preserving later user choices. */
export function installWorkerPanel(ctx: Context, t: T, openSession: (id: string) => Promise<void>): void {
  const call = workerCaller(t)
  ctx.effect(() => ctx.sidebarRightTabs.register({ id: WORKER_PANEL_KIND, kind: WORKER_PANEL_KIND, title: () => t('workerPanel.title'),
    guide: [{ id: 'workers', order: 15, title: () => t('workerPanel.title'), description: () => t('workerPanel.guide') }] }))
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: WORKER_PANEL_KIND, locale: 'dshSuperagent' },
    ({ sessionId, useTabInfo, t: translate }: { sessionId: SessionId; useTabInfo: UseSidebarRightTabInfo; t: T }) => {
      const { tab } = useTabInfo()
      return tab.visible ? <WorkerPanel key={sessionId} sessionId={sessionId} call={call} t={translate} openSession={openSession} /> : null
    }))
  ctx.effect(() => {
    const opened = new Set<string>()
    let active = true, generation = 0
    const check = async () => {
      const id = ctx.sidebarRight.mounted.getSnapshot(), request = ++generation
      if (!id || opened.has(id) || window.innerWidth < 1600) return
      try {
        const view = await call('GET sessions/:id/workers', { id })
        if (!active || request !== generation || ctx.sidebarRight.mounted.getSnapshot() !== id || !view.eligible) return
        ctx.sidebarRight.openTab(WORKER_PANEL_KIND); opened.add(id)
      } catch { /* The guide entry remains available while the backend restarts. */ }
    }
    const release = ctx.sidebarRight.mounted.subscribe(() => { void check() })
    queueMicrotask(() => { if (active) void check() })
    return () => { active = false; generation++; release() }
  })
}
