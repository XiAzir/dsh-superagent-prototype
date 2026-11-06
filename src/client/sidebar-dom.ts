/** Additive workspace-region mounts; the native browser keeps its own component and state. */
export interface SidebarMount {
  root: HTMLElement
  tabs: HTMLDivElement
  panel: HTMLDivElement
  dispose(): void
}

export function mountSidebarViews(region: HTMLElement): SidebarMount | undefined {
  const root = region.firstElementChild
  if (!(root instanceof HTMLElement) || root.children.length < 2) return undefined
  const header = root.firstElementChild
  if (!(header instanceof HTMLElement) || root.hasAttribute('data-superagent-sidebar')) return undefined
  const tabs = document.createElement('div'), panel = document.createElement('div')
  tabs.dataset.superagentSidebarTabs = ''; panel.dataset.superagentSidebarPanel = ''
  root.setAttribute('data-superagent-sidebar', '')
  header.after(tabs)
  root.append(panel)
  return { root, tabs, panel, dispose() {
    root.removeAttribute('data-superagent-sidebar'); root.removeAttribute('data-superagent-view')
    tabs.remove(); panel.remove()
  } }
}

/** Observe only DOM structure so mode styling and input changes do not trigger reattachment. */
export function observeSidebarViews(onMount: (mount: SidebarMount | undefined) => void): () => void {
  let current: SidebarMount | undefined, queued = false, disposed = false
  const check = () => {
    queued = false
    if (disposed) return
    const region = document.querySelector<HTMLElement>('[data-slot="sidebar.workspaces"]')
    if (current && region?.firstElementChild === current.root && current.root.isConnected
      && current.tabs.parentElement === current.root && current.panel.parentElement === current.root) return
    current?.dispose(); current = undefined
    if (region) current = mountSidebarViews(region)
    onMount(current)
  }
  const observer = new MutationObserver(() => {
    if (!queued) { queued = true; queueMicrotask(check) }
  })
  observer.observe(document.body, { childList: true, subtree: true })
  check()
  return () => { disposed = true; observer.disconnect(); current?.dispose(); current = undefined }
}
