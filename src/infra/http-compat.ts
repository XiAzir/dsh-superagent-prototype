/** Opt in to one HTTP request per DSH webserver socket for CNB's SSH-forwarded HTTP transport. */
export function configureHttpNoReuse(webServer: unknown, enabled: boolean): () => void {
  if (!enabled) return () => {}

  // Private adapter verified against DSH / dsh-host-webserver 0.2.2-rc.1.
  // Recheck this shape and the real-socket test on every DSH host-webserver upgrade.
  const service = webServer as { server?: unknown } | null
  const candidate = service?.server
  if (candidate === null || candidate === undefined || typeof candidate !== 'object') {
    throw new Error('dsh-superagent: DSH HTTP no-reuse adapter is incompatible with this webServer implementation')
  }
  const server = candidate as {
    maxRequestsPerSocket?: unknown
    listen?: unknown
    close?: unknown
    closeAllConnections?: unknown
    address?: unknown
    on?: unknown
  } | undefined
  if (server === undefined || typeof server.maxRequestsPerSocket !== 'number'
    || typeof server.listen !== 'function' || typeof server.close !== 'function'
    || typeof server.closeAllConnections !== 'function' || typeof server.address !== 'function'
    || typeof server.on !== 'function') {
    throw new Error('dsh-superagent: DSH HTTP no-reuse adapter is incompatible with this webServer implementation')
  }

  const previous = server.maxRequestsPerSocket
  server.maxRequestsPerSocket = 1
  return () => {
    if (server.maxRequestsPerSocket === 1) server.maxRequestsPerSocket = previous
  }
}
