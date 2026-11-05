import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createTcpServer, connect } from 'node:net';
import { request } from 'node:http';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createGateway, parseAllowedPorts } from '../src/server.mjs';

async function fixture(t, gatewayOptions = {}) {
  const rfb = createTcpServer(socket => {
    socket.write('RFB 003.008\n');
    socket.on('data', data => socket.write(data));
  });
  await new Promise(resolve => rfb.listen(0, '127.0.0.1', resolve));
  // Production default only permits 5900. Isolate this test's ephemeral RFB fixture.
  const gateway = createGateway({ port: 0, allowedPorts: [rfb.address().port], ...gatewayOptions });
  const url = await gateway.listen();
  t.after(async () => { await gateway.close(); await new Promise(resolve => rfb.close(resolve)); });
  return { url, origin: url, port: rfb.address().port, gateway };
}

async function session(f, target = { host: '127.0.0.1', port: f.port }, headers = {}) {
  return fetch(`${f.url}/api/sessions`, {
    method: 'POST',
    headers: { Origin: f.origin, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(target),
  });
}

function maskedBinary(payload) {
  return maskedFrame(payload, 2);
}

function maskedFrame(payload, opcode) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const mask = randomBytes(4);
  const header = data.length < 126 ? Buffer.from([0x80 | opcode, 0x80 | data.length, ...mask])
    : data.length < 65536 ? Buffer.from([0x80 | opcode, 0xfe, data.length >> 8, data.length & 255, ...mask])
    : Buffer.from([0x80 | opcode, 0xff, 0, 0, 0, 0, (data.length / 2 ** 24) & 255, (data.length >>> 16) & 255, (data.length >>> 8) & 255, data.length & 255, ...mask]);
  const encoded = Buffer.from(data);
  for (let i = 0; i < data.length; i++) encoded[i] ^= mask[i % 4];
  return Buffer.concat([header, encoded]);
}

async function upgrade(f, wsPath, origin = f.origin, socketOptions = {}) {
  const { port } = new URL(f.url);
  const socket = connect({ host: '127.0.0.1', port: Number(port), ...socketOptions });
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
  async function nextPacket() {
    const result = await readUntil(buffer => {
      if (buffer.length < 2) return null;
      let count = buffer[1] & 127;
      let start = 2;
      if (count === 126) { if (buffer.length < 4) return null; count = buffer.readUInt16BE(2); start = 4; }
      if (count === 127) { if (buffer.length < 10) return null; count = Number(buffer.readBigUInt64BE(2)); start = 10; }
      if (buffer.length < count + start) return null;
      const body = buffer.subarray(start, start + count);
      cache = buffer.subarray(start + count);
      return { opcode: buffer[0] & 15, body };
    });
    return result;
  }
  return { socket, response, nextPacket, async nextFrame() { return (await nextPacket()).body; } };
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
  assert.equal((await session(f, { host: '127.0.0.1', port: f.port + (f.port === 65535 ? -1 : 1) })).status, 403);
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

test('abrupt downstream TCP close releases the upstream RFB socket', async t => {
  const rfb = createTcpServer(socket => socket.write('RFB 003.008\n'));
  await new Promise(resolve => rfb.listen(0, '127.0.0.1', resolve));
  const upstreamAccepted = once(rfb, 'connection');
  const gateway = createGateway({ port: 0, allowedPorts: [rfb.address().port] });
  const url = await gateway.listen();
  const ticket = await (await session({ url, origin: url, port: rfb.address().port })).json();
  const client = await upgrade({ url, origin: url }, ticket.wsPath);
  const [upstream] = await upstreamAccepted;
  t.after(async () => {
    client.socket.destroy();
    upstream.destroy();
    await gateway.close();
    await new Promise(resolve => rfb.close(resolve));
  });
  assert.match(client.response, /^HTTP\/1\.1 101/);
  assert.equal((await client.nextFrame()).toString(), 'RFB 003.008\n');
  const upstreamClosed = once(upstream, 'close', { signal: AbortSignal.timeout(1500) });
  client.socket.destroy(); // Abrupt network loss, not a masked WebSocket Close.
  await upstreamClosed;
});

test('upstream RFB TCP FIN releases the downstream WebSocket socket', async t => {
  const rfb = createTcpServer(socket => socket.write('RFB 003.008\n'));
  await new Promise(resolve => rfb.listen(0, '127.0.0.1', resolve));
  const upstreamAccepted = once(rfb, 'connection');
  const gateway = createGateway({ port: 0, allowedPorts: [rfb.address().port] });
  const url = await gateway.listen();
  const ticket = await (await session({ url, origin: url, port: rfb.address().port })).json();
  const client = await upgrade({ url, origin: url }, ticket.wsPath);
  const [upstream] = await upstreamAccepted;
  t.after(async () => {
    client.socket.destroy();
    upstream.destroy();
    await gateway.close();
    await new Promise(resolve => rfb.close(resolve));
  });
  assert.equal((await client.nextFrame()).toString(), 'RFB 003.008\n');
  const downstreamClosed = once(client.socket, 'close', { signal: AbortSignal.timeout(1500) });
  upstream.end(); // TCP FIN without a complete RFB close exchange.
  await downstreamClosed;
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

test('incomplete HTTP Upgrade headers cannot hold a burst of gateway sockets beyond five seconds', async t => {
  const sockets = [];
  function closedWithin(socket) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('partial HTTP socket exceeded six-second deadline')), 6000);
      socket.once('close', () => { clearTimeout(timer); resolve(); });
    });
  }
  // Register before fixture's gateway.close() hook, so even a RED timeout
  // destroys all deliberately incomplete HTTP connections during cleanup.
  t.after(() => { for (const socket of sockets) socket.destroy(); });
  const f = await fixture(t);
  const port = Number(new URL(f.url).port);
  const closures = [];
  for (let i = 0; i < 9; i++) {
    const socket = connect({ host: '127.0.0.1', port });
    socket.on('error', () => {});
    sockets.push(socket);
    closures.push(closedWithin(socket));
    socket.write(`GET /ws/session/incomplete HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nX-Slow: `);
    // Repeated bytes can reset a socket *idle* timeout; neither that nor
    // nine simultaneous connections should reset the HTTP headers deadline.
    const drip = setInterval(() => { if (!socket.destroyed) socket.write('a'); }, 1000);
    socket.on('close', () => clearInterval(drip));
  }
  // A completed health request must not create a keep-alive escape hatch:
  // its next partial Upgrade has to receive a fresh absolute deadline.
  const reused = connect({ host: '127.0.0.1', port });
  reused.on('error', () => {});
  sockets.push(reused);
  const response = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('health response timeout')), 1500);
    let received = '';
    reused.on('data', chunk => {
      received += chunk.toString();
      if (received.includes('"ok":true')) { clearTimeout(timer); resolve(); }
    });
  });
  reused.write(`GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: keep-alive\r\n\r\n`);
  await response;
  assert.equal(reused.destroyed, false);
  closures.push(closedWithin(reused));
  reused.write(`GET /ws/session/incomplete HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nX-Slow: `);
  const reusedDrip = setInterval(() => { if (!reused.destroyed) reused.write('a'); }, 1000);
  reused.on('close', () => clearInterval(reusedDrip));
  await Promise.all(closures);
  const ticket = await (await session(f)).json();
  const connected = await upgrade(f, ticket.wsPath);
  t.after(() => connected.socket.destroy());
  assert.match(connected.response, /^HTTP\/1\.1 101/);
  assert.equal((await connected.nextFrame()).toString(), 'RFB 003.008\n');
});

test('pre-upgrade partial HTTP sockets have a separate admission cap', async t => {
  const sockets = [];
  t.after(() => { for (const socket of sockets) socket.destroy(); });
  const f = await fixture(t);
  const port = Number(new URL(f.url).port);
  const connected = [];
  for (let i = 0; i < 24; i++) {
    const socket = connect({ host: '127.0.0.1', port });
    socket.on('error', () => {});
    sockets.push(socket);
    connected.push(new Promise(resolve => {
      socket.once('connect', resolve);
      socket.once('error', resolve);
    }));
    socket.write('G'); // Start but never finish an HTTP request.
  }
  await Promise.all(connected);
  await new Promise(resolve => setTimeout(resolve, 100));
  const live = await new Promise((resolve, reject) => f.gateway.server.getConnections((error, count) => error ? reject(error) : resolve(count)));
  assert.ok(live <= 16, `partial HTTP headers occupied ${live} gateway sockets; expected at most 16`);
  const closed = sockets.map(socket => socket.destroyed ? Promise.resolve() : new Promise(resolve => socket.once('close', resolve)));
  for (const socket of sockets) socket.destroy();
  await Promise.all(closed);
  // Admission must recover as promptly as the stalled clients disconnect.
  const ticket = await (await session(f)).json();
  const recovered = await upgrade(f, ticket.wsPath);
  assert.match(recovered.response, /^HTTP\/1\.1 101/);
  assert.equal((await recovered.nextFrame()).toString(), 'RFB 003.008\n');
  recovered.socket.destroy();
});

test('rejected WS Upgrade cannot keep a half-open TCP socket outside the HTTP deadline', async t => {
  const f = await fixture(t);
  const serverAccepted = once(f.gateway.server, 'connection');
  // A bad ticket gets HTTP 403+FIN, but this deliberately nonconformant peer
  // withholds its own FIN. It must remain counted and reach the hard deadline.
  const attempt = await upgrade(f, `/ws/session/${'Z'.repeat(43)}`, f.origin, { allowHalfOpen: true });
  attempt.socket.on('error', () => {});
  t.after(() => attempt.socket.destroy());
  const [serverSocket] = await serverAccepted;
  assert.match(attempt.response, /^HTTP\/1\.1 403/);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('rejected Upgrade held a half-open TCP socket beyond six seconds')), 6000);
    serverSocket.once('close', () => { clearTimeout(timer); resolve(); });
  });
});

test('gateway shutdown promptly destroys incomplete headers and rejected half-open upgrades', async t => {
  const gateway = createGateway({ port: 0 });
  const url = await gateway.listen();
  const port = Number(new URL(url).port);
  const sockets = [];
  t.after(() => { for (const socket of sockets) socket.destroy(); });

  const first = once(gateway.server, 'connection');
  const partial = connect({ host: '127.0.0.1', port });
  partial.on('error', () => {});
  sockets.push(partial);
  partial.write(`GET /ws/session/incomplete HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nX-Slow: `);
  const [serverPartial] = await first;

  const second = once(gateway.server, 'connection');
  const rejected = connect({ host: '127.0.0.1', port, allowHalfOpen: true });
  rejected.on('error', () => {});
  sockets.push(rejected);
  const rejection = new Promise(resolve => rejected.on('data', chunk => {
    if (chunk.toString().includes('403 Forbidden')) resolve();
  }));
  rejected.write(`GET /ws/session/${'Z'.repeat(43)} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nOrigin: ${url}\r\n\r\n`);
  const [serverRejected] = await second;
  await rejection;

  const peerClosed = [serverPartial, serverRejected].map(socket => new Promise(resolve => socket.once('close', resolve)));
  const shutdown = Promise.all([gateway.close(), ...peerClosed]);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('gateway.close() left incomplete HTTP sockets alive')), 1500);
    shutdown.then(() => { clearTimeout(timeout); resolve(); }, error => { clearTimeout(timeout); reject(error); });
  });
  assert.equal(serverPartial.destroyed, true);
  assert.equal(serverRejected.destroyed, true);
});

test('refuses non-loopback bind', () => {
  assert.throws(() => createGateway({ host: '0.0.0.0' }), /loopback/);
  assert.throws(() => createGateway({ allowedPorts: [] }), /allowlist/);
  assert.throws(() => createGateway({ allowedPorts: [0] }), /allowlist/);
});

test('only standard VNC port 5900 is allowed by default', async t => {
  const gateway = createGateway({ port: 0 });
  const url = await gateway.listen();
  t.after(async () => gateway.close());
  const nonVnc = await fetch(`${url}/api/sessions`, {
    method: 'POST', headers: { Origin: url, 'content-type': 'application/json' },
    body: JSON.stringify({ host: 'localhost', port: 8080 }),
  });
  assert.equal(nonVnc.status, 403);
  assert.deepEqual(await nonVnc.json(), { error: 'target_port_not_allowed' });
  const standardVnc = await fetch(`${url}/api/sessions`, {
    method: 'POST', headers: { Origin: url, 'content-type': 'application/json' },
    body: JSON.stringify({ host: 'localhost', port: 5900 }),
  });
  assert.equal(standardVnc.status, 201);
});

test('explicit 5901 launch allowlist grants a loopback ticket without enabling arbitrary ports', async t => {
  assert.deepEqual(parseAllowedPorts(undefined), [5900]);
  assert.deepEqual(parseAllowedPorts('5901'), [5901]);
  assert.deepEqual(parseAllowedPorts('5900,5901'), [5900, 5901]);
  for (const bad of ['', '0', '65536', '5901,', '5901,5901', '5900-5902', '*', ' 5901', '5901 ', Array(33).fill('5901').join(',')]) {
    assert.throws(() => parseAllowedPorts(bad), /UNBOUNDVNC_GATEWAY_ALLOWED_PORTS/);
  }

  // Use the real CLI entry point, not just a programmatic createGateway call.
  const child = spawn(process.execPath, ['src/server.mjs'], {
    cwd: new URL('../', import.meta.url),
    env: { ...process.env, UNBOUNDVNC_GATEWAY_PORT: '0', UNBOUNDVNC_GATEWAY_ALLOWED_PORTS: '5901' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  const url = await new Promise((resolve, reject) => {
    let output = '';
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => reject(new Error(`gateway CLI startup timeout: ${stderr}`)), 8000);
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = /UnboundVNC local RFB gateway: (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`gateway CLI exited ${code}`)); });
  });
  const headers = { Origin: url, 'content-type': 'application/json' };
  const ticket = await fetch(`${url}/api/sessions`, {
    method: 'POST', headers, body: JSON.stringify({ host: '127.0.0.1', port: 5901 }),
  });
  assert.equal(ticket.status, 201);
  assert.match((await ticket.json()).wsPath, /^\/ws\/session\//);
  const denied = await fetch(`${url}/api/sessions`, {
    method: 'POST', headers, body: JSON.stringify({ host: '127.0.0.1', port: 5900 }),
  });
  assert.equal(denied.status, 403);
  const external = await fetch(`${url}/api/sessions`, {
    method: 'POST', headers, body: JSON.stringify({ host: '192.168.1.42', port: 5901 }),
  });
  assert.equal(external.status, 400);
});

test('rejects a non-RFB localhost service even on an explicitly allowed port', async t => {
  const fake = createTcpServer(socket => socket.write('NOT RFB!! x\n'));
  await new Promise(resolve => fake.listen(0, '127.0.0.1', resolve));
  const targetPort = fake.address().port;
  const gateway = createGateway({ port: 0, allowedPorts: [targetPort] });
  const url = await gateway.listen();
  t.after(async () => { await gateway.close(); await new Promise(resolve => fake.close(resolve)); });
  const ticket = await (await session({ url, origin: url, port: targetPort })).json();
  const attempt = await upgrade({ url, origin: url }, ticket.wsPath);
  t.after(() => attempt.socket.destroy());
  assert.match(attempt.response, /^HTTP\/1\.1 403/);
});

test('a trickling RFB banner cannot extend the upstream handshake deadline', async t => {
  const upstream = createTcpServer(socket => {
    socket.on('error', () => {});
    socket.write('R');
    // Each byte arrives before the ordinary 5-second idle timeout, but the
    // peer never completes a twelve-byte RFB greeting in that time.
    const drip = setInterval(() => { if (!socket.destroyed) socket.write('R'); }, 1000);
    socket.on('close', () => clearInterval(drip));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const gateway = createGateway({ port: 0, allowedPorts: [upstream.address().port] });
  const url = await gateway.listen();
  const ticket = await (await session({ url, origin: url, port: upstream.address().port })).json();
  const upstreamAccepted = once(upstream, 'connection');
  const client = connect({ host: '127.0.0.1', port: Number(new URL(url).port) });
  client.on('error', () => {});
  t.after(async () => {
    client.destroy();
    await gateway.close();
    await new Promise(resolve => upstream.close(resolve));
  });
  client.write(`GET ${ticket.wsPath} HTTP/1.1\r\nHost: 127.0.0.1:${new URL(url).port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nOrigin: ${url}\r\n\r\n`);
  const [serverSocket] = await upstreamAccepted;
  // The absolute deadline is five seconds; leave scheduling slack without
  // letting an idle-timeout-only implementation pass. TCP reset can emit
  // ECONNRESET just before 'close'; that is successful cleanup, not failure.
  serverSocket.on('error', () => {});
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('trickling RFB socket exceeded 5800ms close deadline')), 5800);
    serverSocket.once('close', () => { clearTimeout(timer); resolve(); });
  });
});

test('quiet authorized sessions survive multiple WebSocket heartbeats', async t => {
  const f = await fixture(t, { heartbeatMs: 150 });
  const ticket = await (await session(f)).json();
  const connected = await upgrade(f, ticket.wsPath);
  t.after(() => connected.socket.destroy());
  assert.equal((await connected.nextFrame()).toString(), 'RFB 003.008\n');
  for (let i = 0; i < 3; i++) {
    const ping = await connected.nextPacket();
    assert.equal(ping.opcode, 9);
    connected.socket.write(maskedFrame(ping.body, 10));
  }
  connected.socket.write(maskedBinary('still connected'));
  let echoed = null;
  for (let i = 0; i < 5 && !echoed; i++) {
    const packet = await connected.nextPacket();
    if (packet.opcode === 9) connected.socket.write(maskedFrame(packet.body, 10));
    else if (packet.opcode === 2) echoed = packet.body.toString();
    else assert.fail(`unexpected WebSocket opcode ${packet.opcode}`);
  }
  assert.equal(echoed, 'still connected');
});

test('unsolicited and stale Pong frames cannot satisfy a heartbeat challenge', async t => {
  const f = await fixture(t, { heartbeatMs: 100 });
  const ticket = await (await session(f)).json();
  const connected = await upgrade(f, ticket.wsPath);
  t.after(() => connected.socket.destroy());
  connected.socket.on('error', () => {});
  assert.equal((await connected.nextFrame()).toString(), 'RFB 003.008\n');
  connected.socket.write(maskedFrame('unsolicited', 10));
  const ping = await connected.nextPacket();
  assert.equal(ping.opcode, 9);
  connected.socket.write(maskedFrame(Buffer.alloc(ping.body.length, 0), 10));
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('stale Pong incorrectly kept the session alive')), 1200);
    connected.socket.once('close', () => { clearTimeout(timeout); resolve(); });
  });
});

test('a nearly complete 1 MiB frame followed by a coalesced second frame is accepted', async t => {
  const f = await fixture(t);
  const ticket = await (await session(f)).json();
  const connected = await upgrade(f, ticket.wsPath);
  t.after(() => connected.socket.destroy());
  assert.equal((await connected.nextFrame()).toString(), 'RFB 003.008\n');
  const payload = Buffer.alloc(1024 * 1024, 0x42);
  const small = Buffer.alloc(132, 0x43);
  const largeFrame = maskedBinary(payload);
  // Deliberately leave the parser holding all but 32 bytes of its maximum
  // legal frame before coalescing the tail with a second valid frame. The old
  // pre-parse aggregate-size check rejected this combination.
  connected.socket.write(largeFrame.subarray(0, -32));
  await new Promise(resolve => setTimeout(resolve, 80));
  connected.socket.write(Buffer.concat([largeFrame.subarray(-32), maskedBinary(small)]));
  let received = 0;
  while (received < payload.length + small.length) {
    const packet = await connected.nextPacket();
    assert.equal(packet.opcode, 2);
    received += packet.body.length;
  }
  assert.equal(received, payload.length + small.length);
  assert.equal(connected.socket.destroyed, false);
});

test('one 1 MiB masked frame survives 4096 tiny TCP writes and a following frame', async t => {
  const f = await fixture(t);
  const ticket = await (await session(f)).json();
  const connected = await upgrade(f, ticket.wsPath);
  t.after(() => connected.socket.destroy());
  assert.equal((await connected.nextFrame()).toString(), 'RFB 003.008\n');
  const payload = Buffer.alloc(1024 * 1024, 0x5a);
  const bytes = maskedBinary(payload);
  const count = 4096;
  const stride = Math.ceil(bytes.length / count);
  for (let offset = 0; offset < bytes.length; offset += stride) {
    if (!connected.socket.write(bytes.subarray(offset, offset + stride))) await once(connected.socket, 'drain');
  }
  connected.socket.write(maskedBinary('tail'));
  let total = 0;
  while (total < payload.length + 4) {
    const packet = await connected.nextPacket();
    assert.equal(packet.opcode, 2);
    if (total < payload.length) assert.equal(packet.body[0], 0x5a);
    total += packet.body.length;
  }
  assert.equal(total, payload.length + 4);
  assert.equal(connected.socket.destroyed, false);
});

test('RFC 6455 rejects illegal control frames, invalid close reasons and noncanonical lengths', async t => {
  const withFirst = (packet, first) => { const copy = Buffer.from(packet); copy[0] = first; return copy; };
  const badFrames = [
    ['fragmented Ping', withFirst(maskedFrame('a', 9), 0x09)],
    ['fragmented Close', withFirst(maskedFrame(Buffer.alloc(0), 8), 0x08)],
    ['Ping with extended-size marker', Buffer.from([0x89, 0xfe])],
    ['Close with one-byte payload', maskedFrame(Buffer.from([0]), 8)],
    ['Close with invalid UTF-8 reason', maskedFrame(Buffer.from([0x03, 0xe8, 0xc3, 0x28]), 8)],
    ['Close with reserved 1005 code', maskedFrame(Buffer.from([0x03, 0xed]), 8)],
    ['unknown opcode', maskedFrame('a', 3)],
    ['unmasked payload', Buffer.from([0x82, 1, 0x41])],
    ['nonminimal 16-bit length', Buffer.from([0x82, 0xfe, 0, 1, 0, 0, 0, 0, 0x41])],
    ['nonminimal 64-bit length', Buffer.from([0x82, 0xff, 0, 0, 0, 0, 0, 0, 0, 126])],
    ['over 1 MiB advertised length', Buffer.from([0x82, 0xff, 0, 0, 0, 0, 0, 0x10, 0, 1])],
  ];
  for (const [name, bytes] of badFrames) {
    await t.test(name, async t => {
      const f = await fixture(t);
      const ticket = await (await session(f)).json();
      const connected = await upgrade(f, ticket.wsPath);
      t.after(() => connected.socket.destroy());
      connected.socket.on('error', () => {});
      assert.equal((await connected.nextFrame()).toString(), 'RFB 003.008\n');
      const closed = once(connected.socket, 'close', { signal: AbortSignal.timeout(1500) });
      connected.socket.write(bytes);
      await closed;
    });
  }
});

test('valid masked Close echoes code and reason before TCP teardown', async t => {
  const f = await fixture(t);
  const ticket = await (await session(f)).json();
  const connected = await upgrade(f, ticket.wsPath);
  t.after(() => connected.socket.destroy());
  assert.equal((await connected.nextFrame()).toString(), 'RFB 003.008\n');
  const payload = Buffer.from([0x03, 0xe8, ...Buffer.from('done')]);
  connected.socket.write(maskedFrame(payload, 8));
  const response = await connected.nextPacket();
  assert.equal(response.opcode, 8);
  assert.deepEqual(response.body, payload);
});

test('valid masked Close cannot strand a TCP half-open peer outside gateway tracking', async t => {
  const rfb = createTcpServer(socket => socket.write('RFB 003.008\n'));
  await new Promise(resolve => rfb.listen(0, '127.0.0.1', resolve));
  const gateway = createGateway({ port: 0, allowedPorts: [rfb.address().port] });
  const url = await gateway.listen();
  const ticket = await (await session({ url, origin: url, port: rfb.address().port })).json();
  const incoming = once(gateway.server, 'connection');
  // allowHalfOpen keeps our TCP write side open after gateway's FIN. A
  // malicious/nonconformant peer can therefore withhold its own FIN forever.
  const connected = await upgrade({ url, origin: url }, ticket.wsPath, url, { allowHalfOpen: true });
  const [serverSocket] = await incoming;
  t.after(async () => {
    connected.socket.destroy();
    serverSocket.destroy();
    await gateway.close();
    await new Promise(resolve => rfb.close(resolve));
  });
  assert.equal((await connected.nextFrame()).toString(), 'RFB 003.008\n');
  const peerClosed = once(serverSocket, 'close', { signal: AbortSignal.timeout(800) });
  const payload = Buffer.from([0x03, 0xe8, ...Buffer.from('done')]);
  connected.socket.write(maskedFrame(payload, 8));
  const echoed = await connected.nextPacket();
  assert.equal(echoed.opcode, 8);
  assert.deepEqual(echoed.body, payload);
  await peerClosed;
});

test('fragmented binary RFB stream permits interleaved masked Ping control frames', async t => {
  const f = await fixture(t);
  const ticket = await (await session(f)).json();
  const connected = await upgrade(f, ticket.wsPath);
  t.after(() => connected.socket.destroy());
  assert.equal((await connected.nextFrame()).toString(), 'RFB 003.008\n');
  const first = maskedFrame('part-', 2);
  first[0] &= 0x7f; // nonfinal binary fragment
  connected.socket.write(Buffer.concat([first, maskedFrame('ping-data', 9), maskedFrame('two', 0)]));
  let pong = null;
  let rfbData = '';
  // TCP may coalesce adjacent upstream RFB writes into a single WS packet.
  for (let i = 0; i < 4 && (pong === null || rfbData.length < 8); i++) {
    const packet = await connected.nextPacket();
    if (packet.opcode === 10) pong = packet.body.toString();
    else if (packet.opcode === 2) rfbData += packet.body.toString();
    else assert.fail(`unexpected opcode ${packet.opcode}`);
  }
  assert.equal(pong, 'ping-data');
  assert.equal(rfbData, 'part-two');
  connected.socket.write(maskedBinary('next'));
  assert.equal((await connected.nextFrame()).toString(), 'next');
});

test('sustained RFB traffic can exceed 64 MiB without lifetime-byte disconnect', async t => {
  const CHUNK = 64 * 1024;
  const TARGET = 65 * 1024 * 1024;
  const floodServer = createTcpServer(socket => {
    socket.write('RFB 003.008\n');
    socket.once('data', async () => {
      try {
        let remaining = TARGET;
        const payload = Buffer.alloc(CHUNK, 0x5a);
        while (remaining > 0 && !socket.destroyed) {
          const next = payload.subarray(0, Math.min(CHUNK, remaining));
          remaining -= next.length;
          if (!socket.write(next)) await once(socket, 'drain');
        }
      } catch { /* peer may have disconnected */ }
    });
  });
  await new Promise(resolve => floodServer.listen(0, '127.0.0.1', resolve));
  const port = floodServer.address().port;
  const gateway = createGateway({ port: 0, allowedPorts: [port] });
  const url = await gateway.listen();
  t.after(async () => { await gateway.close(); await new Promise(resolve => floodServer.close(resolve)); });
  const ticket = await (await session({ url, origin: url, port })).json();
  const connected = await upgrade({ url, origin: url }, ticket.wsPath);
  t.after(() => connected.socket.destroy());
  assert.equal((await connected.nextFrame()).toString(), 'RFB 003.008\n');
  connected.socket.write(maskedBinary('send'));
  let received = 0;
  while (received < TARGET) {
    const packet = await connected.nextPacket();
    assert.equal(packet.opcode, 2);
    received += packet.body.length;
  }
  assert.equal(received, TARGET);
  assert.equal(connected.socket.destroyed, false);
});

test('a browser that never reads propagates bounded outbound backpressure and times out', async t => {
  const CHUNK = 64 * 1024;
  const MAX_OFFERED = 96 * 1024 * 1024;
  const data = Buffer.alloc(CHUNK, 0x4a);
  let offered = 0;
  let producerBlocked = false;
  const rfb = createTcpServer(socket => {
    socket.on('error', () => {});
    socket.write('RFB 003.008\n');
    socket.once('data', () => {
      function pump() {
        if (socket.destroyed || producerBlocked) return;
        // Yield after a bounded batch; never make the fixture itself an
        // unbounded writable queue when testing the gateway's backpressure.
        for (let i = 0; i < 16 && offered < MAX_OFFERED; i++) {
          offered += data.length;
          if (!socket.write(data)) { producerBlocked = true; return; }
        }
        if (offered < MAX_OFFERED) setImmediate(pump);
      }
      socket.on('drain', () => { producerBlocked = false; setImmediate(pump); });
      pump();
    });
  });
  await new Promise(resolve => rfb.listen(0, '127.0.0.1', resolve));
  const gateway = createGateway({ port: 0, allowedPorts: [rfb.address().port], heartbeatMs: 2000 });
  const url = await gateway.listen();
  const ticket = await (await session({ url, origin: url, port: rfb.address().port })).json();
  const gatewayIncoming = once(gateway.server, 'connection');
  const upstreamIncoming = once(rfb, 'connection');
  const connected = await upgrade({ url, origin: url }, ticket.wsPath);
  const [ws] = await gatewayIncoming;
  const [upstream] = await upstreamIncoming;
  t.after(async () => {
    connected.socket.destroy();
    upstream.destroy();
    await gateway.close();
    await new Promise(resolve => rfb.close(resolve));
  });
  assert.equal((await connected.nextFrame()).toString(), 'RFB 003.008\n');
  connected.socket.pause();
  const initialRss = process.memoryUsage().rss;
  connected.socket.write(maskedBinary('flood'));
  const started = Date.now();
  while (!(ws.writableLength > 0 && producerBlocked) && Date.now() - started < 1500) {
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  assert.ok(ws.writableLength > 0, `WebSocket never backpressured; offered=${offered}`);
  assert.equal(producerBlocked, true, 'upstream writer did not experience propagated TCP backpressure');
  const pausedAt = offered;
  const queueAt = ws.writableLength;
  await new Promise(resolve => setTimeout(resolve, 200));
  const queueAfter = ws.writableLength;
  const offeredDelta = offered - pausedAt;
  const rssGrowth = process.memoryUsage().rss - initialRss;
  t.diagnostic(`slow-reader: offered=${offered}B; after-stall-feed=${offeredDelta}B; wsQueue=${queueAt}/${queueAfter}B; rssGrowth=${rssGrowth}B`);
  assert.ok(offeredDelta <= CHUNK * 2, `upstream continued flooding after stall: ${offeredDelta}B`);
  assert.ok(queueAfter <= CHUNK * 8, `unbounded WebSocket writable queue: ${queueAfter}B`);
  assert.ok(rssGrowth < 32 * 1024 * 1024, `unbounded RSS growth: ${rssGrowth}B`);
  function waitForClose(socket) {
    if (socket.destroyed) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('slow-reader socket not closed after heartbeat timeout')), 5000);
      socket.once('close', () => { clearTimeout(timer); resolve(); });
    });
  }
  const wsClosed = waitForClose(ws);
  const upstreamClosed = waitForClose(upstream);
  await Promise.all([wsClosed, upstreamClosed]);
  // A timed-out reader must relinquish its admission slot. The next ticket
  // must complete a real WebSocket/RFB handshake, not just return HTTP 201.
  const replacement = await (await session({ url, origin: url, port: rfb.address().port })).json();
  const recovered = await upgrade({ url, origin: url }, replacement.wsPath);
  t.after(() => recovered.socket.destroy());
  assert.match(recovered.response, /^HTTP\/1\.1 101/);
  assert.equal((await recovered.nextFrame()).toString(), 'RFB 003.008\n');
});
