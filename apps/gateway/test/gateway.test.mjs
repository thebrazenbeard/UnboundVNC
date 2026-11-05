import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createTcpServer, connect } from 'node:net';
import { request } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createGateway } from '../src/server.mjs';

async function fixture(t) {
  const rfb = createTcpServer(socket => {
    socket.write('RFB 003.008\n');
    socket.on('data', data => socket.write(data));
  });
  await new Promise(resolve => rfb.listen(0, '127.0.0.1', resolve));
  const gateway = createGateway({ port: 0 });
  const url = await gateway.listen();
  t.after(async () => { await gateway.close(); await new Promise(resolve => rfb.close(resolve)); });
  return { url, origin: url, port: rfb.address().port };
}

async function session(f, target = { host: '127.0.0.1', port: f.port }, headers = {}) {
  return fetch(`${f.url}/api/sessions`, {
    method: 'POST',
    headers: { Origin: f.origin, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(target),
  });
}

function maskedBinary(payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const mask = randomBytes(4);
  const header = Buffer.from([0x82, 0x80 | data.length, ...mask]);
  const encoded = Buffer.from(data);
  for (let i = 0; i < data.length; i++) encoded[i] ^= mask[i % 4];
  return Buffer.concat([header, encoded]);
}

async function upgrade(f, wsPath, origin = f.origin) {
  const { port } = new URL(f.url);
  const socket = connect({ host: '127.0.0.1', port: Number(port) });
  const key = randomBytes(16).toString('base64');
  socket.write(`GET ${wsPath} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\nOrigin: ${origin}\r\n\r\n`);
  let cache = Buffer.alloc(0);
  const waiters = new Set();
  socket.on('data', chunk => { cache = Buffer.concat([cache, chunk]); for (const wake of waiters) wake(); });
  async function readUntil(predicate) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiters.delete(check); reject(new Error('socket read timeout')); }, 3000);
      function check() {
        const result = predicate(cache);
        if (result) { clearTimeout(timer); waiters.delete(check); resolve(result); }
      }
      waiters.add(check);
      check();
    });
  }
  const response = await readUntil(data => {
    const end = data.indexOf('\r\n\r\n');
    return end < 0 ? null : data.subarray(0, end + 4).toString();
  });
  const split = cache.indexOf('\r\n\r\n') + 4;
  cache = cache.subarray(split);
  return { socket, response, async nextFrame() {
    const result = await readUntil(buffer => {
      if (buffer.length < 2) return null;
      let count = buffer[1] & 127;
      let start = 2;
      if (count === 126) { if (buffer.length < 4) return null; count = buffer.readUInt16BE(2); start = 4; }
      if (buffer.length < count + start) return null;
      const body = buffer.subarray(start, start + count);
      cache = buffer.subarray(start + count);
      return body;
    });
    return result;
  } };
}

async function postWithHost(f, host) {
  const endpoint = new URL(f.url);
  return new Promise((resolve, reject) => {
    const req = request({ hostname: endpoint.hostname, port: Number(endpoint.port), path: '/api/sessions', method: 'POST', headers: { Host: host, Origin: f.origin, 'content-type': 'application/json' } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end('{}');
  });
}

test('health is local and no remote support is advertised', async t => {
  const f = await fixture(t);
  const res = await fetch(`${f.url}/api/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, transport: 'local-rfb-websocket', remoteAccess: false });
});

test('rejects external targets, invalid ports, CSRF origins, and missing origins', async t => {
  const f = await fixture(t);
  for (const target of [
    { host: '8.8.8.8', port: 5900 },
    { host: '192.168.1.42', port: 5900 },
    { host: 'localhost', port: 0 },
    { host: '127.0.0.1', port: 65536 },
  ]) assert.equal((await session(f, target)).status, 400);
  assert.equal((await session(f, undefined, { Origin: 'https://attacker.example' })).status, 403);
  assert.equal((await session(f, undefined, { Origin: '' })).status, 403);
  assert.equal((await session(f, undefined, { 'content-type': 'text/plain' })).status, 403);
  assert.equal(await postWithHost(f, 'evil.example'), 403);
});

test('single-use WS ticket bridges RFB banner and masked binary payload', async t => {
  const f = await fixture(t);
  const res = await session(f);
  assert.equal(res.status, 201);
  const ticket = await res.json();
  assert.match(ticket.wsPath, /^\/ws\/session\/[A-Za-z0-9_-]{43}$/);
  const connected = await upgrade(f, ticket.wsPath);
  t.after(() => connected.socket.destroy());
  assert.match(connected.response, /^HTTP\/1\.1 101 Switching Protocols/);
  assert.equal((await connected.nextFrame()).toString(), 'RFB 003.008\n');
  connected.socket.write(maskedBinary('hello RFB'));
  assert.equal((await connected.nextFrame()).toString(), 'hello RFB');
  const replay = await upgrade(f, ticket.wsPath);
  t.after(() => replay.socket.destroy());
  assert.match(replay.response, /^HTTP\/1\.1 403/);
});

test('rejects cross-origin WS handshake without exposing consumed ticket', async t => {
  const f = await fixture(t);
  const ticket = await (await session(f)).json();
  const attempt = await upgrade(f, ticket.wsPath, 'https://attacker.example');
  t.after(() => attempt.socket.destroy());
  assert.match(attempt.response, /^HTTP\/1\.1 403/);
  const good = await upgrade(f, ticket.wsPath);
  t.after(() => good.socket.destroy());
  assert.match(good.response, /^HTTP\/1\.1 101/);
});

test('refuses non-loopback bind', () => {
  assert.throws(() => createGateway({ host: '0.0.0.0' }), /loopback/);
});
