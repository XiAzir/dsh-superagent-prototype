import { createServer, type Server } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import WebSocket, { WebSocketServer } from 'ws'

export type OneBotState = 'connecting' | 'connected' | 'disconnected' | 'error'
interface ConnectionBase { token: string; requestTimeoutMs?: number; maxPayload?: number }
export type OneBotConnection = ConnectionBase & (
  | { mode: 'forward'; url: string; reconnectMinMs?: number; reconnectMaxMs?: number }
  | { mode: 'reverse'; host?: string; port: number; path: string }
)
export interface OneBotClientOptions {
  connection: OneBotConnection
  onEvent?: (event: unknown) => void | Promise<void>
  onState?: (state: OneBotState, detail?: string) => void
  onError?: (error: Error) => void
}
interface RpcResponse { status?: unknown; retcode?: unknown; data?: unknown; echo?: unknown }
interface Pending { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>; signal?: AbortSignal; abort?: () => void }

const DEFAULT_TIMEOUT = 10_000
const DEFAULT_MAX_PAYLOAD = 2 * 1024 * 1024
const CLOSE_TIMEOUT_MS = 500
const errorOf = (value: unknown): Error => value instanceof Error ? value : new Error(String(value))
const secureEqual = (left: string, right: string): boolean => {
  const a = Buffer.from(left), b = Buffer.from(right)
  const length = Math.max(a.length, b.length, 1)
  const paddedA = Buffer.alloc(length), paddedB = Buffer.alloc(length)
  a.copy(paddedA); b.copy(paddedB)
  const same = timingSafeEqual(paddedA, paddedB)
  return same && a.length === b.length
}
const isLoopback = (host: string): boolean => ['127.0.0.1', '::1', 'localhost'].includes(host.toLowerCase())

/** OneBot v11 bidirectional JSON RPC transport for NapCat. */
export class OneBotClient {
  readonly connection: OneBotConnection
  private readonly options: OneBotClientOptions
  private socket?: WebSocket
  private wss?: WebSocketServer
  private http?: Server
  private pending = new Map<string, Pending>()
  private nextEcho = 0
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private reconnectAttempt = 0
  private stopped = true
  private currentState: OneBotState = 'disconnected'
  private loginSelfId?: string

  constructor(options: OneBotClientOptions) { this.options = options; this.connection = options.connection }
  get selfId(): string | undefined { return this.loginSelfId }
  get connected(): boolean { return !!this.socket && this.socket.readyState === WebSocket.OPEN }

  async start(): Promise<void> {
    if (!this.stopped) return
    this.stopped = false
    if (this.connection.mode === 'reverse') await this.startReverse()
    else this.connectForward()
  }

  async call<T = unknown>(action: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    if (this.stopped || !this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error('OneBot is not connected')
    if (signal?.aborted) throw new Error('OneBot request aborted')
    const echo = `${Date.now().toString(36)}-${(++this.nextEcho).toString(36)}`
    return await new Promise<T>((resolve, reject) => {
      const timeout = this.connection.requestTimeoutMs ?? DEFAULT_TIMEOUT
      const timer = setTimeout(() => this.settle(echo, new Error(`OneBot RPC timeout: ${action}`)), timeout)
      const pending: Pending = { resolve: value => resolve(value as T), reject, timer, signal }
      if (signal) {
        pending.abort = () => this.settle(echo, new Error('OneBot request aborted'))
        signal.addEventListener('abort', pending.abort, { once: true })
      }
      this.pending.set(echo, pending)
      try { this.socket!.send(JSON.stringify({ action, params, echo }), error => { if (error) this.settle(echo, error) }) }
      catch (error) { this.settle(echo, errorOf(error)) }
    })
  }

  async getLoginInfo(signal?: AbortSignal): Promise<Record<string, unknown> & { user_id: string }> {
    const info = await this.call<Record<string, unknown>>('get_login_info', {}, signal)
    const id = normalizePositiveId(info && info.user_id)
    if (!id) throw new Error('OneBot get_login_info returned an invalid user_id')
    this.loginSelfId = id
    return { ...info, user_id: id }
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    this.rejectAll(new Error('OneBot client stopped'))
    const socket = this.socket
    this.socket = undefined
    if (socket) await closeSocket(socket)
    if (this.wss) {
      await Promise.all([...this.wss.clients].map(client => closeSocket(client)))
      await new Promise<void>(resolve => this.wss!.close(() => resolve()))
      this.wss = undefined
    }
    if (this.http?.listening) await new Promise<void>(resolve => this.http!.close(() => resolve()))
    this.http = undefined
    this.setState('disconnected')
  }

  private setState(state: OneBotState, detail?: string): void {
    this.currentState = state
    try { this.options.onState?.(state, detail) } catch (error) { this.reportError(error) }
  }
  private reportError(error: unknown): void { try { this.options.onError?.(errorOf(error)) } catch { /* consumer errors are isolated */ } }
  private settle(echo: string, error?: Error, value?: unknown): void {
    const item = this.pending.get(echo)
    if (!item) return
    this.pending.delete(echo)
    clearTimeout(item.timer)
    if (item.abort && item.signal) item.signal.removeEventListener('abort', item.abort)
    if (error) item.reject(error); else item.resolve(value)
  }
  private rejectAll(error: Error): void { for (const echo of [...this.pending.keys()]) this.settle(echo, error) }

  private connectForward(): void {
    if (this.stopped || this.connection.mode !== 'forward') return
    this.setState('connecting')
    let socket: WebSocket
    try { socket = new WebSocket(this.connection.url, { headers: { Authorization: `Bearer ${this.connection.token}` }, maxPayload: this.connection.maxPayload ?? DEFAULT_MAX_PAYLOAD }) }
    catch (error) { this.handleDisconnect(undefined, errorOf(error)); return }
    this.socket = socket
    socket.on('open', () => { if (this.socket !== socket || this.stopped) return; this.reconnectAttempt = 0; this.setState('connected') })
    socket.on('message', data => { if (this.socket === socket) this.receive(data.toString()) })
    socket.on('error', error => { if (this.socket === socket) this.reportError(error) })
    socket.on('close', () => { if (this.socket === socket) this.handleDisconnect(socket) })
  }

  private handleDisconnect(socket?: WebSocket, error?: Error): void {
    if (socket && this.socket !== socket) return
    this.socket = undefined
    this.rejectAll(new Error('OneBot connection closed'))
    if (error) { this.reportError(error); this.setState('error', 'WebSocket connection failed') }
    else this.setState('disconnected')
    if (!this.stopped && this.connection.mode === 'forward') this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopped || this.connection.mode !== 'forward') return
    const min = Math.max(100, this.connection.reconnectMinMs ?? 500)
    const max = Math.max(min, this.connection.reconnectMaxMs ?? 30_000)
    const base = Math.min(max, min * 2 ** Math.min(this.reconnectAttempt++, 16))
    const delay = Math.round(base * (0.8 + Math.random() * 0.4))
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = undefined; this.connectForward() }, delay)
  }

  private async startReverse(): Promise<void> {
    const connection = this.connection
    if (connection.mode !== 'reverse') return
    const host = connection.host ?? '127.0.0.1'
    if (!isLoopback(host)) throw new Error('OneBot reverse listener must use a loopback host')
    const expectedPath = connection.path.startsWith('/') ? connection.path : `/${connection.path}`
    this.setState('connecting')
    this.http = createServer()
    this.wss = new WebSocketServer({ noServer: true, maxPayload: connection.maxPayload ?? DEFAULT_MAX_PAYLOAD })
    this.http.on('upgrade', (request, socket, head) => {
      let pathname = ''
      try { pathname = new URL(request.url ?? '/', `http://${host}`).pathname } catch { socket.destroy(); return }
      const auth = request.headers.authorization ?? ''
      const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : ''
      let queryToken = ''
      try { queryToken = new URL(request.url ?? '/', `http://${host}`).searchParams.get('access_token') ?? '' } catch { /* malformed URL */ }
      if (pathname !== expectedPath || !(secureEqual(bearer, connection.token) || (!bearer && secureEqual(queryToken, connection.token)))) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); return
      }
      this.wss!.handleUpgrade(request, socket, head, ws => this.wss!.emit('connection', ws, request))
    })
    this.wss.on('connection', ws => {
      const old = this.socket
      if (old && old !== ws) {
        this.rejectAll(new Error('OneBot reverse connection replaced'))
        void closeSocket(old).catch(error => this.reportError(error))
      }
      this.socket = ws
      this.setState('connected')
      ws.on('message', data => { if (this.socket === ws) this.receive(data.toString()) })
      ws.on('error', error => { if (this.socket === ws) this.reportError(error) })
      ws.on('close', () => { if (this.socket === ws) { this.socket = undefined; this.rejectAll(new Error('OneBot connection closed')); if (!this.stopped) this.setState('disconnected') } })
    })
    await new Promise<void>((resolve, reject) => {
      this.http!.once('error', reject)
      this.http!.listen(connection.port, host, () => { this.http!.removeListener('error', reject); resolve() })
    }).catch(error => { this.setState('error', 'Reverse listener could not start'); throw error })
  }

  private receive(raw: string): void {
    let message: unknown
    try { message = JSON.parse(raw) } catch { this.reportError(new Error('OneBot sent malformed JSON')); return }
    if (!message || typeof message !== 'object' || Array.isArray(message)) { this.reportError(new Error('OneBot sent an invalid packet')); return }
    const packet = message as Record<string, unknown>
    if (Object.hasOwn(packet, 'echo')) {
      if (typeof packet.echo !== 'string') { this.reportError(new Error('OneBot RPC response has invalid echo')); return }
      const response = packet as RpcResponse
      if (!this.pending.has(packet.echo)) return
      if (!['ok', 'async', 'failed'].includes(String(response.status)) || typeof response.retcode !== 'number' || !Number.isInteger(response.retcode)) {
        this.settle(packet.echo, new Error('OneBot RPC response has invalid status or retcode'))
        this.reportError(new Error('OneBot RPC response has invalid status or retcode'))
        return
      }
      if (response.status === 'failed' || response.retcode !== 0) {
        this.settle(packet.echo, new Error(`OneBot RPC failed (retcode ${response.retcode})`)); return
      }
      this.settle(packet.echo, undefined, response.data)
      return
    }
    try {
      const result = this.options.onEvent?.(message)
      if (result && typeof (result as Promise<void>).then === 'function') void (result as Promise<void>).catch(error => this.reportError(error))
    } catch (error) { this.reportError(error) }
  }
}

/** Closes cooperatively for a short window, then terminates peers that do not answer the close frame. */
async function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return
  await new Promise<void>(resolve => {
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      socket.removeAllListeners('open')
      socket.removeAllListeners('message')
      resolve()
    }
    const timer = setTimeout(() => { try { socket.terminate() } finally { finish() } }, CLOSE_TIMEOUT_MS)
    socket.once('close', finish)
    if (socket.readyState === WebSocket.CONNECTING) { try { socket.terminate() } finally { finish() }; return }
    try { socket.close(1000, 'client stopped') } catch { try { socket.terminate() } finally { finish() } }
  })
}

function normalizePositiveId(value: unknown): string | undefined {
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : typeof value === 'string' ? value : ''
  return /^[1-9]\d*$/.test(text) ? text : undefined
}
