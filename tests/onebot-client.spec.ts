import { createServer } from 'node:http'
import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import { OneBotClient } from '../src/sources/onebot-client.ts'

const clients: OneBotClient[] = []
const servers: WebSocketServer[] = []
const httpServers: ReturnType<typeof createServer>[] = []
afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.stop()))
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { for (const socket of server.clients) socket.terminate(); server.close(() => resolve()) })))
  await Promise.all(httpServers.splice(0).map(server => server.listening ? new Promise<void>(resolve => server.close(() => resolve())) : Promise.resolve()))
})

async function forwardServer(handler: (socket: WebSocket, data: Record<string, unknown>) => void): Promise<{ url: string; server: WebSocketServer }> {
  const server = new WebSocketServer({ port: 0 })
  servers.push(server)
  await once(server, 'listening')
  server.on('connection', socket => socket.on('message', raw => {
    try { handler(socket, JSON.parse(raw.toString()) as Record<string, unknown>) } catch { /* invalid test packet */ }
  }))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected TCP server address')
  return { url: `ws://127.0.0.1:${address.port}`, server }
}

function makeClient(url: string, extra: Partial<ConstructorParameters<typeof OneBotClient>[0]> = {}): OneBotClient {
  const client = new OneBotClient({ connection: { mode: 'forward', url, token: 'secret', requestTimeoutMs: 150, reconnectMinMs: 100, reconnectMaxMs: 100 }, ...extra })
  clients.push(client)
  return client
}

describe('OneBotClient', () => {
  it('keeps correlated upload progress separate from the final reply and renews the idle timeout on advancing bytes', async () => {
    const { url } = await forwardServer((socket, packet) => {
      for (const [delay, uploaded] of [[30, 20], [90, 50], [150, 100]]) setTimeout(() => {
        socket.send(JSON.stringify({ status: 'async', retcode: 0, echo: packet.echo,
          data: { type: 'upload_progress', uploaded_bytes: uploaded, total_bytes: 100, phase: 'uploading' } }))
      }, delay)
      setTimeout(() => socket.send(JSON.stringify({ status: 'ok', retcode: 0, echo: packet.echo, data: { file_id: 'uploaded' } })), 200)
    })
    const client = makeClient(url); await client.start(); await waitConnected(client)
    const progress: number[] = []
    const result = await client.call('upload_private_file', {}, undefined, 100, { totalTimeoutMs: 1000,
      onProgress: value => progress.push(value.uploadedBytes) })
    expect(result).toEqual({ file_id: 'uploaded' })
    expect(progress).toEqual([20, 50, 100])
  })

  it('expires stalled uploads despite repeated progress packets and ignores regressing, invalid and other-request frames', async () => {
    const { url } = await forwardServer((socket, packet) => {
      const frame = (echo: unknown, uploaded: number, total = 100) => socket.send(JSON.stringify({ status: 'async', retcode: 0, echo,
        data: { type: 'upload_progress', uploaded_bytes: uploaded, total_bytes: total, phase: 'uploading' } }))
      frame(packet.echo, 10)
      frame(packet.echo, 9); frame(packet.echo, 101); frame(packet.echo, 20, 200); frame('unknown', 90)
      for (const delay of [20, 40, 60, 80]) setTimeout(() => frame(packet.echo, 10), delay)
    })
    const client = makeClient(url); await client.start(); await waitConnected(client)
    const progress: number[] = []
    await expect(client.call('upload_private_file', {}, undefined, 100, { totalTimeoutMs: 1000,
      onProgress: value => progress.push(value.uploadedBytes) })).rejects.toThrow('stalled')
    expect(progress).toEqual([10])
  })

  it('enforces a total upload deadline while bytes keep advancing', async () => {
    const { url } = await forwardServer((socket, packet) => {
      for (const [delay, uploaded] of [[10, 10], [40, 20], [70, 30], [100, 40]]) setTimeout(() => {
        socket.send(JSON.stringify({ status: 'async', retcode: 0, echo: packet.echo,
          data: { type: 'upload_progress', uploaded_bytes: uploaded, total_bytes: 100, phase: 'uploading' } }))
      }, delay)
    })
    const client = makeClient(url); await client.start(); await waitConnected(client)
    await expect(client.call('upload_private_file', {}, undefined, 80, { totalTimeoutMs: 120,
      onProgress: () => {} })).rejects.toThrow('total timeout')
  })
  it('correlates concurrent RPC responses by echo and exposes login self id', async () => {
    const { url } = await forwardServer((socket, packet) => {
      if (packet.action === 'get_login_info') socket.send(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: 9988 }, echo: packet.echo }))
      else setTimeout(() => socket.send(JSON.stringify({ status: 'ok', retcode: 0, data: { value: packet.params }, echo: packet.action === 'slow' ? String(packet.echo) : packet.echo })), packet.action === 'slow' ? 15 : 1)
    })
    const client = makeClient(url)
    await client.start()
    await waitConnected(client)
    const [a, b] = await Promise.all([client.call<{ value: { n: number } }>('slow', { n: 1 }), client.call<{ value: { n: number } }>('fast', { n: 2 })])
    expect(a.value.n).toBe(1)
    expect(b.value.n).toBe(2)
    expect((await client.getLoginInfo()).user_id).toBe('9988')
    expect(client.selfId).toBe('9988')
  })

  it('rejects failed retcodes and malformed packets without crashing the socket', async () => {
    const { url } = await forwardServer((socket, packet) => {
      socket.send('{bad json')
      socket.send(JSON.stringify(packet.action === 'missing-status'
        ? { retcode: 0, data: {}, echo: packet.echo }
        : { status: 'failed', retcode: 1200, data: {}, echo: packet.echo }))
    })
    const errors: Error[] = []
    const client = makeClient(url, { onError: error => errors.push(error) })
    await client.start(); await waitConnected(client)
    await expect(client.call('bad')).rejects.toThrow('retcode 1200')
    await expect(client.call('missing-status')).rejects.toThrow('invalid status or retcode')
    expect(errors.some(error => error.message.includes('malformed JSON'))).toBe(true)
  })

  it('rejects pending calls when the connection drops, and clears calls on timeout or stop', async () => {
    const { url, server } = await forwardServer(() => undefined)
    const client = makeClient(url)
    await client.start(); await waitConnected(client)
    const pending = client.call('pending')
    server.clients.forEach(socket => socket.terminate())
    await expect(pending).rejects.toThrow('connection closed')
    await waitConnected(client)
    await expect(client.call('timeout')).rejects.toThrow('timeout')
    const controller = new AbortController()
    const aborted = client.call('aborted', {}, controller.signal)
    controller.abort()
    await expect(aborted).rejects.toThrow('aborted')
    const stopped = client.call('stop')
    const stoppedResult = expect(stopped).rejects.toThrow('stopped')
    await client.stop()
    await stoppedResult
  })

  it('validates reverse listener path and bearer auth, then handles a reverse RPC', async () => {
    const server = createServer()
    httpServers.push(server)
    // Resolve an ephemeral port by reserving one, then use it for the reverse listener.
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected TCP server address')
    const port = address.port
    await new Promise<void>(resolve => server.close(() => resolve()))
    const reverse = new OneBotClient({ connection: { mode: 'reverse', port, host: '127.0.0.1', path: '/onebot/v11/ws', token: 'reverse-secret' } })
    clients.push(reverse)
    await reverse.start()
    const badPath = new WebSocket(`ws://127.0.0.1:${port}/wrong`, { headers: { Authorization: 'Bearer reverse-secret' } })
    await expect(once(badPath, 'open')).rejects.toBeDefined()
    const unauthorized = new WebSocket(`ws://127.0.0.1:${port}/onebot/v11/ws`, { headers: { Authorization: 'Bearer wrong' } })
    await expect(once(unauthorized, 'open')).rejects.toBeDefined()
    const socket = new WebSocket(`ws://127.0.0.1:${port}/onebot/v11/ws`, { headers: { Authorization: 'Bearer reverse-secret' } })
    await once(socket, 'open')
    const pending = reverse.call('ping')
    const [raw] = await once(socket, 'message')
    const packet = JSON.parse(raw.toString()) as { echo: string | number }
    socket.send(JSON.stringify({ status: 'ok', retcode: 0, data: 'pong', echo: packet.echo }))
    await expect(pending).resolves.toBe('pong')
    socket.close()

    const first = new WebSocket(`ws://127.0.0.1:${port}/onebot/v11/ws`, { headers: { Authorization: 'Bearer reverse-secret' } })
    await once(first, 'open')
    const interrupted = reverse.call('will_be_replaced')
    const interruptedResult = expect(interrupted).rejects.toThrow('replaced')
    const second = new WebSocket(`ws://127.0.0.1:${port}/onebot/v11/ws`, { headers: { Authorization: 'Bearer reverse-secret' } })
    await once(second, 'open')
    await interruptedResult
    second.close()
  })

  it('rejects a non-loopback reverse bind address', async () => {
    const client = new OneBotClient({ connection: { mode: 'reverse', port: 12345, host: '0.0.0.0', path: '/ws', token: 'secret' } })
    clients.push(client)
    await expect(client.start()).rejects.toThrow('loopback')
  })

  it('bounds stop when a connected peer ignores the WebSocket close frame', async () => {
    const { url, server } = await forwardServer(socket => {
      // Keep the server side open after it receives the client's close frame.
      socket.close = (() => socket) as typeof socket.close
    })
    const client = makeClient(url)
    await client.start(); await waitConnected(client)
    const startedAt = Date.now()
    await client.stop()
    expect(Date.now() - startedAt).toBeLessThan(1500)
  })
})

async function waitConnected(client: OneBotClient): Promise<void> {
  const end = Date.now() + 1000
  while (!client.connected && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 5))
  if (!client.connected) throw new Error('OneBot connection did not open')
}
