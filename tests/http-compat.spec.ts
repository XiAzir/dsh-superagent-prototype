import { Agent, createServer, get, type Server } from 'node:http'
import WebSocket, { WebSocketServer } from 'ws'
import { describe, expect, it } from 'vitest'
import { configureHttpNoReuse } from '../src/infra/http-compat.ts'

function service(server: unknown) {
  return { server }
}

function request(server: Server, agent: import('node:http').Agent) {
  return new Promise<{ status: number | undefined; connection: string | undefined; reusedSocket: boolean }>((resolve, reject) => {
    const address = server.address()
    if (!address || typeof address === 'string') { reject(new Error('HTTP test server is not listening')); return }
    const req = get({ host: '127.0.0.1', port: address.port, agent }, res => {
      res.resume()
      res.once('end', () => resolve({ status: res.statusCode, connection: res.headers.connection, reusedSocket: req.reusedSocket }))
    })
    req.once('error', reject)
  })
}

describe('configureHttpNoReuse', () => {
  it('does not read the server when disabled', () => {
    const webServer = Object.defineProperty({}, 'server', { get() { throw new Error('must not read disabled adapter') } })
    expect(() => configureHttpNoReuse(webServer, false)).not.toThrow()
  })

  it('sets the per-socket request limit and restores it on disposal', () => {
    const rawServer = {
      maxRequestsPerSocket: 0,
      listen() {},
      close() {},
      closeAllConnections() {},
      address() { return null },
      on() {},
    }
    const dispose = configureHttpNoReuse(service(rawServer), true)
    expect(rawServer.maxRequestsPerSocket).toBe(1)
    dispose()
    expect(rawServer.maxRequestsPerSocket).toBe(0)
  })

  it('does not overwrite a later server setting while disposing', () => {
    const rawServer = {
      maxRequestsPerSocket: 4,
      listen() {},
      close() {},
      closeAllConnections() {},
      address() { return null },
      on() {},
    }
    const dispose = configureHttpNoReuse(service(rawServer), true)
    rawServer.maxRequestsPerSocket = 2
    dispose()
    expect(rawServer.maxRequestsPerSocket).toBe(2)
  })

  it('fails clearly when the DSH private HTTP server adapter is missing', () => {
    expect(() => configureHttpNoReuse({}, true)).toThrow(/webServer implementation/)
    expect(() => configureHttpNoReuse(service(null), true)).toThrow(/webServer implementation/)
  })

  it('closes every real HTTP socket after one request', async () => {
    const server = createServer((_req, res) => { res.end('ok') })
    const dispose = configureHttpNoReuse(service(server), true)
    const agent = new Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 })
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => {
          server.off('error', reject)
          resolve()
        })
      })
      const first = await request(server, agent)
      const second = await request(server, agent)
      expect(first.status).toBe(200)
      expect(second.status).toBe(200)
      expect(first.connection?.toLowerCase()).toBe('close')
      expect(second.connection?.toLowerCase()).toBe('close')
      expect(first.reusedSocket).toBe(false)
      expect(second.reusedSocket).toBe(false)
    } finally {
      agent.destroy()
      dispose()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('leaves WebSocket upgrades working', async () => {
    const server = createServer()
    const webSockets = new WebSocketServer({ noServer: true })
    server.on('upgrade', (request, socket, head) => {
      webSockets.handleUpgrade(request, socket, head, webSocket => {
        webSocket.send('ok')
        webSocket.close()
      })
    })
    const dispose = configureHttpNoReuse(service(server), true)
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => {
          server.off('error', reject)
          resolve()
        })
      })
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('HTTP test server is not listening')
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}`)
      const closed = new Promise<void>((resolve, reject) => {
        socket.once('close', () => resolve())
        socket.once('error', reject)
      })
      const message = await new Promise<string>((resolve, reject) => {
        socket.once('message', data => resolve(data.toString()))
        socket.once('error', reject)
      })
      expect(message).toBe('ok')
      socket.close()
      await closed
    } finally {
      dispose()
      await new Promise<void>(resolve => webSockets.close(() => resolve()))
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})
