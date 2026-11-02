import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { createGateway } from './web_gateway.mjs';

const SECRET = 'test-proxy-secret-' + 'x'.repeat(40);
const ORIGIN = 'https://superagent.1994622.xyz';
const HOST = 'superagent.1994622.xyz';
const COOKIE = `dsh-auth-${'A'.repeat(43)}=very-private`;

async function listen(server, host = '127.0.0.1') {
  server.listen(0, host);
  await once(server, 'listening');
  return server.address().port;
}

async function fixture(upstreamHandler, gatewayOptions = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'web-gateway-'));
  const stateFile = path.join(temp, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify({
    lease: { owner: 'build-1', expires_at: Date.now() / 1000 + 60 },
    web_session: { owner: 'build-1', cookie: COOKIE, updated_at: Date.now() / 1000 },
  }));
  const upstream = http.createServer(upstreamHandler);
  const upstreamPort = await listen(upstream);
  const gateway = createGateway({
    listenPort: 0,
    upstreamPort,
    upstreamHost: '127.0.0.1:13082',
    stateFile,
    proxySecret: SECRET,
    headerTimeoutMs: 1000,
    ...gatewayOptions,
  });
  const gatewayPort = await listen(gateway);
  return {
    temp, stateFile, upstream, gateway, gatewayPort,
    async close() {
      for (const socket of this.rawSockets ?? []) socket.destroy();
      await Promise.all([new Promise((r) => this.gateway.close(r)), new Promise((r) => this.upstream.close(r))]);
      fs.rmSync(temp, { recursive: true, force: true });
    },
  };
}

function headers(overrides = {}) {
  return {
    Host: HOST,
    'X-Superagent-Proxy-Key': SECRET,
    ...overrides,
  };
}

async function fetchAt(port, route = '/', options = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1', port, path: route, method: options.method ?? 'GET',
      headers: options.headers ?? {},
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: { get: (name) => response.headers[name.toLowerCase()] ?? null },
        text: async () => Buffer.concat(chunks).toString(),
      }));
    });
    request.on('error', reject);
    if (options.body) request.write(options.body);
    request.end();
  });
}

test('root bootstrap uses active archive cookie and returns protected cookie flags', async (t) => {
  let observed;
  const f = await fixture((req, res) => {
    observed = { cookie: req.headers.cookie, host: req.headers.host, auth: req.headers.authorization };
    res.writeHead(200, { 'set-cookie': 'upstream=should-not-escape' });
    res.end('root');
  });
  t.after(() => f.close());
  const response = await fetchAt(f.gatewayPort, '/', { headers: headers() });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'root');
  assert.deepEqual(observed, { cookie: COOKIE, host: '127.0.0.1:13082', auth: undefined });
  const setCookie = [].concat(response.headers.get('set-cookie') ?? []).join(', ');
  assert.match(setCookie, /^dsh-auth-A{43}=very-private; Secure; HttpOnly; SameSite=Strict; Path=\/$/);
  assert.doesNotMatch(setCookie, /upstream/);
});

test('auth key and exact Host are required; token query is rejected', async (t) => {
  const f = await fixture((_req, res) => res.end('ok'));
  t.after(() => f.close());
  assert.equal((await fetchAt(f.gatewayPort, '/', { headers: headers({ 'X-Superagent-Proxy-Key': 'wrong' }) })).status, 401);
  assert.equal((await fetchAt(f.gatewayPort, '/', { headers: headers({ Host: 'superagent.1994622.xyz:443' }) })).status, 400);
  assert.equal((await fetchAt(f.gatewayPort, '/?token=secret', { headers: headers() })).status, 400);
  assert.equal((await fetchAt(f.gatewayPort, '/api/status', { headers: headers({ Authorization: 'Basic secret' }) })).status, 200);
});

test('origin and cross-site navigation checks reject CSRF while allowing top-level root navigation', async (t) => {
  let hits = 0;
  const f = await fixture((_req, res) => { hits++; res.end('ok'); });
  t.after(() => f.close());
  assert.equal((await fetchAt(f.gatewayPort, '/api/change', { method: 'POST', headers: headers() })).status, 403);
  assert.equal((await fetchAt(f.gatewayPort, '/api/change', { method: 'POST', headers: headers({ Origin: 'https://attacker.invalid' }) })).status, 403);
  assert.equal((await fetchAt(f.gatewayPort, '/api/read', { headers: headers({ Origin: 'https://attacker.invalid' }) })).status, 403);
  assert.equal((await fetchAt(f.gatewayPort, '/api/read', { headers: headers({ 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'cors' }) })).status, 403);
  assert.equal((await fetchAt(f.gatewayPort, '//attacker.invalid/path', { headers: headers() })).status, 400);
  assert.equal((await fetchAt(f.gatewayPort, 'http://attacker.invalid/path', { headers: headers() })).status, 400);
  assert.equal((await fetchAt(f.gatewayPort, '/api/options', { method: 'OPTIONS', headers: headers() })).status, 403);
  assert.equal((await fetchAt(f.gatewayPort, '/api/options', { method: 'OPTIONS', headers: headers({ Origin: ORIGIN }) })).status, 200);
  assert.equal((await fetchAt(f.gatewayPort, '/', { headers: headers({ 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' }) })).status, 200);
  assert.equal(hits, 2);
});

test('forwarding fixes upstream Host and Origin and removes proxy and forwarded credentials', async (t) => {
  let observed;
  const f = await fixture((req, res) => {
    observed = req.headers;
    res.end('ok');
  });
  t.after(() => f.close());
  const response = await fetchAt(f.gatewayPort, '/api/remote.mux?x=1', {
    method: 'POST', body: 'payload',
    headers: headers({ Origin: ORIGIN, Authorization: 'Basic credential', 'X-Forwarded-For': '1.2.3.4', 'X-Orchestrator-Request': 'preserve' }),
  });
  assert.equal(response.status, 200);
  assert.equal(observed.host, '127.0.0.1:13082');
  assert.equal(observed.origin, 'http://127.0.0.1:13082');
  assert.equal(observed.authorization, undefined);
  assert.equal(observed['x-superagent-proxy-key'], undefined);
  assert.equal(observed['x-forwarded-for'], undefined);
  assert.equal(observed['x-orchestrator-request'], 'preserve');
});

test('API requests without a browser cookie are passed through for DSH authorization', async (t) => {
  let seenCookie;
  const f = await fixture((req, res) => {
    seenCookie = req.headers.cookie;
    res.writeHead(seenCookie ? 200 : 401).end();
  });
  t.after(() => f.close());
  const response = await fetchAt(f.gatewayPort, '/api/private', { headers: headers() });
  assert.equal(response.status, 401);
  assert.equal(seenCookie, undefined);
});

test('HTTP body streams and client disconnect cancels upstream request', async (t) => {
  let canceled = false;
  const f = await fixture((req, res) => {
    if (req.url === '/slow') {
      res.writeHead(200);
      res.write('first');
      res.on('close', () => { canceled = true; });
      const timer = setTimeout(() => res.end('last'), 5000);
      res.on('close', () => clearTimeout(timer));
      return;
    }
    req.pipe(res);
  });
  t.after(() => f.close());
  const echo = await fetchAt(f.gatewayPort, '/echo', { method: 'POST', body: 'streamed-body', headers: headers({ Origin: ORIGIN }) });
  assert.equal(await echo.text(), 'streamed-body');
  const socket = net.connect(f.gatewayPort, '127.0.0.1');
  await once(socket, 'connect');
  socket.write(`GET /slow HTTP/1.1\r\nHost: ${HOST}\r\nX-Superagent-Proxy-Key: ${SECRET}\r\nConnection: close\r\n\r\n`);
  await once(socket, 'data');
  socket.destroy();
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(canceled, true);
});

test('idle SSE survives the header timeout and upstream abort closes the client stream', async (t) => {
  const f = await fixture((req, res) => {
    if (req.url === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: first\n\n');
      setTimeout(() => res.end('data: second\n\n'), 700);
      return;
    }
    res.writeHead(200);
    res.write('partial');
    setTimeout(() => res.socket.destroy(), 30);
  }, { headerTimeoutMs: 300 });
  t.after(() => f.close());
  const sse = await fetchAt(f.gatewayPort, '/events', { headers: headers() });
  assert.equal(sse.status, 200);
  assert.match(await sse.text(), /data: first[\s\S]*data: second/);

  const aborted = await new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: f.gatewayPort, path: '/aborted', headers: headers() }, (res) => {
      res.once('aborted', () => resolve(true));
      res.once('end', () => resolve(false));
      res.once('error', () => resolve(true));
    });
    request.setTimeout(1500, () => reject(new Error('downstream hung after upstream abort')));
    request.on('error', reject);
    request.end();
  });
  assert.equal(aborted, true);
});

test('missing, stale, and expired active session fail closed', async (t) => {
  const f = await fixture((_req, res) => res.end('should not reach upstream'));
  t.after(() => f.close());
  fs.writeFileSync(f.stateFile, JSON.stringify({ lease: { owner: 'other', expires_at: Date.now() / 1000 + 60 }, web_session: { owner: 'build-1', cookie: COOKIE } }));
  assert.equal((await fetchAt(f.gatewayPort, '/', { headers: headers() })).status, 503);
  fs.writeFileSync(f.stateFile, JSON.stringify({ lease: { owner: 'build-1', expires_at: Date.now() / 1000 - 1 }, web_session: { owner: 'build-1', cookie: COOKIE } }));
  assert.equal((await fetchAt(f.gatewayPort, '/', { headers: headers() })).status, 503);
  assert.equal((await fetchAt(f.gatewayPort, '/api/private', { headers: headers() })).status, 503);
  fs.writeFileSync(f.stateFile, JSON.stringify({ lease: { owner: 'build-1', expires_at: Date.now() / 1000 + 60 }, web_session: { owner: 'build-1', cookie: `dsh-auth-${'A'.repeat(43)}=${'x'.repeat(4096)}` } }));
  assert.equal((await fetchAt(f.gatewayPort, '/api/private', { headers: headers() })).status, 503);
  fs.writeFileSync(f.stateFile, JSON.stringify({ x: 'x'.repeat(64 * 1024) }));
  assert.equal((await fetchAt(f.gatewayPort, '/api/private', { headers: headers() })).status, 503);
});

test('upstream token redirects are blocked and loopback redirects become relative', async (t) => {
  const f = await fixture((req, res) => {
    if (req.url === '/token') res.writeHead(302, { Location: '/login?token=private' }).end();
    else res.writeHead(302, { Location: 'http://127.0.0.1:13082/next?q=1' }).end();
  });
  t.after(() => f.close());
  const blocked = await fetchAt(f.gatewayPort, '/token', { headers: headers() });
  assert.equal(blocked.status, 502);
  const normalized = await fetchAt(f.gatewayPort, '/redirect', { headers: headers() });
  assert.equal(normalized.headers.get('location'), '/next?q=1');
});

test('WebSocket tunnel requires auth, exact Origin, active session, cookie, and a real 101', async (t) => {
  const f = await fixture((_req, res) => res.end('http fallback'));
  t.after(() => f.close());
  f.rawSockets = new Set();
  const wsPort = await new Promise((resolve, reject) => {
    const probe = net.createServer((socket) => {
      f.rawSockets.add(socket);
      socket.on('close', () => f.rawSockets.delete(socket));
      socket.once('data', (data) => {
        const req = data.toString();
        assert.match(req, /^GET \/api\/remote\.mux HTTP\/1\.1/);
        assert.match(req, /Host: 127\.0\.0\.1:13082/i);
        assert.match(req, /Origin: http:\/\/127\.0\.0\.1:13082/i);
        socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: mock-accept\r\nSec-WebSocket-Protocol: superagent\r\n\r\n');
        setTimeout(() => socket.write('late-frame'), 700);
        socket.on('data', (payload) => socket.write(payload));
      });
    });
    probe.listen(0, '127.0.0.1', () => resolve(probe.address().port));
    probe.on('error', reject);
    f.upstream.close();
    f.upstream = probe;
    probe.on('close', () => {});
  });
  // Gateway was constructed with the HTTP mock port; replace it with a gateway targeting the raw mock.
  await new Promise((resolve) => f.gateway.close(resolve));
  f.gateway = createGateway({ listenPort: 0, upstreamPort: wsPort, stateFile: f.stateFile, proxySecret: SECRET, headerTimeoutMs: 300 });
  const gatewayPort = await listen(f.gateway);
  for (const [origin, key, cookie, expected, fetchSite] of [[ORIGIN, SECRET, 'x=y', '101 Switching'], ['https://attacker.invalid', SECRET, 'x=y', '403 Forbidden'], [ORIGIN, 'wrong', 'x=y', '401 Unauthorized'], [ORIGIN, SECRET, '', '403 Forbidden'], [ORIGIN, SECRET, 'x=y', '403 Forbidden', 'cross-site']]) {
    const socket = net.connect(gatewayPort, '127.0.0.1');
    await once(socket, 'connect');
    socket.write(`GET /api/remote.mux HTTP/1.1\r\nHost: ${HOST}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: abc\r\nSec-WebSocket-Version: 13\r\nOrigin: ${origin}\r\nX-Superagent-Proxy-Key: ${key}\r\nCookie: ${cookie}\r\n${fetchSite ? `Sec-Fetch-Site: ${fetchSite}\r\n` : ''}\r\n`);
    const [data] = await once(socket, 'data');
    assert.match(data.toString(), new RegExp(expected));
    if (expected.startsWith('101')) {
      const [idleData] = await once(socket, 'data');
      assert.equal(idleData.toString(), 'late-frame');
    }
    socket.destroy();
  }
});
