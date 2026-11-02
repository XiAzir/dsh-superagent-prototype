import fs from 'node:fs';
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';

const PUBLIC_HOST = 'superagent.1994622.xyz';
const DEFAULT_ORIGIN = `https://${PUBLIC_HOST}`;
const DEFAULT_STATE_FILE = '/var/lib/cnb-superagent/state.json';
const LOOPBACK = '127.0.0.1';
const MAX_STATE_BYTES = 64 * 1024;
const MAX_WEB_COOKIE_BYTES = 4096;
const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailers', 'transfer-encoding', 'upgrade',
]);
const COOKIE_PAIR = /^dsh-auth-[A-Za-z0-9_-]{43}=[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]+$/;

function secretMatches(supplied, expected) {
  if (typeof supplied !== 'string') return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function responseError(res, status, message) {
  const body = Buffer.from(JSON.stringify({ error: message }));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    connection: 'close',
  });
  res.end(body);
}

function cleanRequestHeaders(headers, { host, origin, cookie } = {}) {
  const result = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (HOP_HEADERS.has(lower) || lower === 'host' || lower === 'authorization' ||
        lower === 'x-superagent-proxy-key' || lower.startsWith('x-forwarded-') ||
        lower.startsWith('x-real-') || lower === 'forwarded') continue;
    if (lower === 'cookie' && cookie !== undefined) continue;
    if (lower === 'origin' && origin !== undefined) continue;
    result[name] = value;
  }
  result.host = host;
  result.connection = 'close';
  if (origin !== undefined) result.origin = origin;
  if (cookie !== undefined) result.cookie = cookie;
  return result;
}

function activeSession(config) {
  let fd;
  try {
    fd = fs.openSync(config.stateFile, 'r');
    if (fs.fstatSync(fd).size > MAX_STATE_BYTES) return null;
    const buffer = Buffer.alloc(MAX_STATE_BYTES + 1);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_STATE_BYTES) return null;
    const state = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
    const lease = state?.lease;
    const session = state?.web_session;
    if (!lease || typeof lease.owner !== 'string' || !Number.isFinite(lease.expires_at) ||
        lease.expires_at <= Date.now() / 1000 || !session || session.owner !== lease.owner ||
        typeof session.cookie !== 'string' || Buffer.byteLength(session.cookie, 'utf8') > MAX_WEB_COOKIE_BYTES ||
        !COOKIE_PAIR.test(session.cookie)) return null;
    return { cookie: session.cookie };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function validateRequest(req, config, { websocket = false } = {}) {
  if (!secretMatches(req.headers['x-superagent-proxy-key'], config.proxySecret)) return 401;
  if (req.headers.host !== config.publicHost) return 400;
  if (!ALLOWED_METHODS.has(req.method)) return 405;
  if (typeof req.url !== 'string' || !req.url.startsWith('/') || req.url.startsWith('//') || req.url.includes('\\')) return 400;
  if (websocket && (req.method !== 'GET' || req.headers.upgrade?.toLowerCase() !== 'websocket' ||
      !String(req.headers.connection ?? '').toLowerCase().split(/\s*,\s*/).includes('upgrade'))) return 400;
  if (websocket && req.headers['sec-fetch-site'] === 'cross-site') return 403;
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== config.publicOrigin) return 403;
  if ((req.method !== 'GET' && req.method !== 'HEAD') || websocket) {
    if (origin !== config.publicOrigin) return 403;
  }
  if (req.url?.length > 8192) return 414;
  let parsed;
  try {
    parsed = new URL(req.url, config.publicOrigin);
  } catch {
    return 400;
  }
  if (parsed.searchParams.has('token')) return 400;
  if ((req.method === 'GET' || req.method === 'HEAD') && req.headers['sec-fetch-site'] === 'cross-site') {
    const topLevelRoot = req.method === 'GET' && parsed.pathname === '/' &&
      req.headers['sec-fetch-mode'] === 'navigate' &&
      (!req.headers['sec-fetch-dest'] || req.headers['sec-fetch-dest'] === 'document');
    if (!topLevelRoot) return 403;
  }
  return 0;
}

function responseHeaders(upstreamHeaders, bootstrap, config) {
  const headers = {};
  for (const [name, value] of Object.entries(upstreamHeaders)) {
    const lower = name.toLowerCase();
    if (HOP_HEADERS.has(lower) || lower === 'set-cookie') continue;
    if (lower === 'location' && typeof value === 'string') {
      try {
        const url = new URL(value, config.upstreamOrigin);
        if (url.searchParams.has('token')) return null;
        if ((url.hostname === '127.0.0.1' || url.hostname === 'localhost') &&
            (url.port === '13082' || url.port === '13083')) {
          headers[name] = `${url.pathname}${url.search}${url.hash}`;
        } else {
          headers[name] = value;
        }
      } catch {
        headers[name] = value;
      }
    } else {
      headers[name] = value;
    }
  }
  headers['cache-control'] = 'no-store';
  if (bootstrap) headers['set-cookie'] = `${bootstrap}; Secure; HttpOnly; SameSite=Strict; Path=/`;
  return headers;
}

export function createGateway(options = {}) {
  const config = {
    publicOrigin: options.publicOrigin ?? process.env.PUBLIC_ORIGIN ?? DEFAULT_ORIGIN,
    publicHost: options.publicHost ?? PUBLIC_HOST,
    listenHost: options.listenHost ?? LOOPBACK,
    listenPort: Number(options.listenPort ?? 13084),
    upstreamHost: options.upstreamHost ?? '127.0.0.1:13082',
    upstreamAddress: options.upstreamAddress ?? LOOPBACK,
    upstreamPort: Number(options.upstreamPort ?? 13083),
    upstreamOrigin: options.upstreamOrigin ?? 'http://127.0.0.1:13082',
    stateFile: options.stateFile ?? DEFAULT_STATE_FILE,
    proxySecret: options.proxySecret ?? process.env.SUPERAGENT_PROXY_SECRET ?? '',
    headerTimeoutMs: Number(options.headerTimeoutMs ?? 15000),
  };
  if (config.publicOrigin !== DEFAULT_ORIGIN || config.publicHost !== PUBLIC_HOST) throw new Error('PUBLIC_ORIGIN and Host are fixed for this gateway');
  if (config.listenHost !== LOOPBACK && config.listenHost !== '::1') throw new Error('gateway must listen on loopback');
  if (Buffer.byteLength(config.proxySecret) < 32) throw new Error('SUPERAGENT_PROXY_SECRET must be at least 32 bytes');

  const server = http.createServer((req, res) => {
    const invalid = validateRequest(req, config);
    if (invalid) return responseError(res, invalid, 'request rejected');
    const session = activeSession(config);
    if (!session) return responseError(res, 503, 'Web session unavailable');
    let parsed;
    try { parsed = new URL(req.url, config.publicOrigin); } catch { return responseError(res, 400, 'invalid request'); }
    const bootstrap = req.method === 'GET' && parsed.pathname === '/';
    const headers = cleanRequestHeaders(req.headers, {
      host: config.upstreamHost,
      origin: req.headers.origin ? config.upstreamOrigin : undefined,
      cookie: bootstrap ? session.cookie : undefined,
    });
    const upstream = http.request({
      host: config.upstreamAddress,
      port: config.upstreamPort,
      method: req.method,
      path: req.url,
      headers,
      agent: false,
      timeout: config.headerTimeoutMs,
    });
    let finished = false;
    const fail = (status, message) => {
      if (finished) return;
      finished = true;
      if (!res.headersSent) responseError(res, status, message);
      else res.destroy();
    };
    upstream.setTimeout(config.headerTimeoutMs, () => upstream.destroy(new Error('upstream timeout')));
    upstream.on('response', (upstreamRes) => {
      upstream.setTimeout(0);
      upstreamRes.socket?.setTimeout(0);
      const outHeaders = responseHeaders(upstreamRes.headers, bootstrap ? session.cookie : null, config);
      if (!outHeaders) {
        upstreamRes.destroy();
        return fail(502, 'upstream redirect rejected');
      }
      finished = true;
      res.writeHead(upstreamRes.statusCode ?? 502, outHeaders);
      upstreamRes.on('aborted', () => res.destroy());
      upstreamRes.on('error', () => res.destroy());
      upstreamRes.pipe(res);
    });
    upstream.on('error', () => fail(502, 'upstream unavailable'));
    req.on('aborted', () => upstream.destroy());
    res.on('close', () => { if (!res.writableEnded) upstream.destroy(); });
    req.pipe(upstream);
  });

  server.on('checkContinue', (req, res) => {
    const invalid = validateRequest(req, config);
    if (invalid) return responseError(res, invalid, 'request rejected');
    res.writeContinue();
    server.emit('request', req, res);
  });

  server.on('connect', (req, socket) => {
    const invalid = validateRequest(req, config);
    const status = invalid || 405;
    const reason = status === 401 ? 'Unauthorized' : status === 400 ? 'Bad Request' : status === 403 ? 'Forbidden' : 'Method Not Allowed';
    socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  });

  server.on('upgrade', (req, clientSocket, head) => {
    const invalid = validateRequest(req, config, { websocket: true });
    const session = invalid ? null : activeSession(config);
    if (invalid || !session || typeof req.headers.cookie !== 'string' || !req.headers.cookie.length) {
      const status = invalid || 403;
      const reason = status === 401 ? 'Unauthorized' : status === 400 ? 'Bad Request' : 'Forbidden';
      clientSocket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    let parsed;
    try { parsed = new URL(req.url, config.publicOrigin); } catch {
      clientSocket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    if (parsed.pathname !== '/api/remote.mux' || parsed.searchParams.has('token')) {
      clientSocket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const headers = cleanRequestHeaders(req.headers, {
      host: config.upstreamHost,
      origin: config.upstreamOrigin,
    });
    headers.connection = 'Upgrade';
    headers.upgrade = 'websocket';
    const upstream = http.request({
      host: config.upstreamAddress, port: config.upstreamPort, method: 'GET', path: req.url,
      headers, agent: false, timeout: config.headerTimeoutMs,
    });
    upstream.setTimeout(config.headerTimeoutMs, () => upstream.destroy(new Error('upstream timeout')));
    upstream.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
      upstream.setTimeout(0);
      upstreamSocket.setTimeout(0);
      clientSocket.setTimeout(0);
      if (upstreamRes.statusCode !== 101 || upstreamRes.headers.upgrade?.toLowerCase() !== 'websocket' ||
          !String(upstreamRes.headers.connection ?? '').toLowerCase().split(/\s*,\s*/).includes('upgrade')) {
        upstreamSocket.destroy();
        clientSocket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      const wsHeaders = ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade'];
      for (const name of ['sec-websocket-accept', 'sec-websocket-protocol', 'sec-websocket-extensions']) {
        if (upstreamRes.headers[name]) wsHeaders.push(`${name}: ${upstreamRes.headers[name]}`);
      }
      clientSocket.write(`${wsHeaders.join('\r\n')}\r\n\r\n`);
      if (upstreamHead?.length) clientSocket.write(upstreamHead);
      if (head?.length) upstreamSocket.write(head);
      clientSocket.pipe(upstreamSocket);
      upstreamSocket.pipe(clientSocket);
      clientSocket.on('error', () => upstreamSocket.destroy());
      upstreamSocket.on('error', () => clientSocket.destroy());
      clientSocket.on('close', () => upstreamSocket.destroy());
      upstreamSocket.on('close', () => clientSocket.destroy());
    });
    upstream.on('response', (upstreamRes) => {
      upstreamRes.resume();
      clientSocket.end(`HTTP/1.1 ${upstreamRes.statusCode ?? 502} ${upstreamRes.statusMessage ?? 'Bad Gateway'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    });
    upstream.on('error', () => clientSocket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'));
    clientSocket.on('error', () => upstream.destroy());
    clientSocket.on('close', () => upstream.destroy());
    upstream.end();
  });
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = createGateway({
    publicOrigin: DEFAULT_ORIGIN,
    listenHost: LOOPBACK,
    listenPort: 13084,
    upstreamAddress: LOOPBACK,
    upstreamPort: 13083,
    upstreamHost: '127.0.0.1:13082',
    stateFile: DEFAULT_STATE_FILE,
  });
  server.listen(13084, LOOPBACK);
}
