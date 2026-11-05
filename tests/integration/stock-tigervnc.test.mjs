import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import { createGateway } from '../../apps/gateway/src/server.mjs';

const RUN = process.env.RFB_STOCK_INTEROP === '1';
const TIMEOUT_MS = 10_000;
const WIDTH = 48;
const HEIGHT = 32;
const BACKGROUND = '#28914c';

async function vacantPort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function waitForPort(port, child) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Xtigervnc exited early (${child.exitCode})`);
    try {
      const socket = connect({ host: '127.0.0.1', port });
      await once(socket, 'connect', { signal: AbortSignal.timeout(500) });
      socket.destroy();
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  throw new Error('Xtigervnc did not listen on loopback before timeout');
}

async function assertLoopbackListener(port) {
  const hexPort = port.toString(16).toUpperCase().padStart(4, '0');
  const tcp = await readFile('/proc/net/tcp', 'utf8');
  const listeners = tcp.split('\n').slice(1).map(line => line.trim().split(/\s+/))
    .filter(fields => fields[1]?.endsWith(`:${hexPort}`) && fields[3] === '0A');
  assert.ok(listeners.length > 0, `expected a TCP listener on port ${port}`);
  assert.ok(listeners.every(fields => fields[1] === `0100007F:${hexPort}`),
    `RFB port ${port} is not exclusively bound to IPv4 loopback`);
  const tcp6 = await readFile('/proc/net/tcp6', 'utf8');
  assert.equal(tcp6.split('\n').slice(1).filter(line => line.trim().split(/\s+/)[1]?.endsWith(`:${hexPort}`) && line.trim().split(/\s+/)[3] === '0A').length, 0,
    'unexpected IPv6 RFB listener (loopback-only boundary unverified)');
}

async function startTiger(t) {
  const port = await vacantPort();
  // Isolated Linux CI runner, ephemeral display; no real workstation, no public RFB listener.
  const display = `:${70 + (process.pid % 120)}`;
  const args = [display, '-geometry', `${WIDTH}x${HEIGHT}`, '-depth', '24',
    '-rfbport', String(port), '-SecurityTypes', 'None', '-localhost', 'yes',
    '-interface', '127.0.0.1', '-nolisten', 'tcp', '-ac'];
  const tiger = spawn('Xtigervnc', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let serverLog = '';
  for (const stream of [tiger.stdout, tiger.stderr]) {
    stream.on('data', bytes => { serverLog = (serverLog + bytes.toString()).slice(-12_000); });
  }
  tiger.on('error', () => {}); // Spawn failures surface from waitForPort below.
  t.after(async () => {
    if (tiger.exitCode === null) {
      tiger.kill('SIGTERM');
      await Promise.race([once(tiger, 'exit'), new Promise(resolve => setTimeout(resolve, 2000))]);
      if (tiger.exitCode === null) tiger.kill('SIGKILL');
    }
    console.log(`TigerVNC process exit=${tiger.exitCode ?? tiger.signalCode}; stderr tail=${JSON.stringify(serverLog.slice(-1200))}`);
  });
  try {
    await waitForPort(port, tiger);
    await assertLoopbackListener(port);
    const paint = spawnSync('xsetroot', ['-display', display, '-solid', BACKGROUND], {
      encoding: 'utf8', timeout: 3000,
    });
    assert.equal(paint.status, 0, `xsetroot failed: ${paint.stderr ?? paint.error?.message}`);
  } catch (error) {
    throw new Error(`${error.message}; TigerVNC log tail: ${serverLog.slice(-1500)}`, { cause: error });
  }
  return { port, display };
}

// Real WebSocket masked client, borrowed in design from the separate gateway/RFB
// integration test: no mocked calls or implementation-supplied RFB server bytes.
async function openSession(origin, path, t) {
  const endpoint = new URL(origin);
  const socket = connect({ host: '127.0.0.1', port: Number(endpoint.port) });
  socket.on('error', () => {});
  t.after(() => socket.destroy());
  await once(socket, 'connect', { signal: AbortSignal.timeout(TIMEOUT_MS) });
  let pending = Buffer.alloc(0);
  let rfb = Buffer.alloc(0);
  let status = null;
  let closed = false;
  const waiters = new Set();
  const wake = () => { for (const callback of [...waiters]) callback(); };
  socket.on('close', () => { closed = true; wake(); });
  socket.on('data', bytes => {
    pending = Buffer.concat([pending, bytes]);
    if (status === null) {
      const end = pending.indexOf('\r\n\r\n');
      if (end < 0) return;
      status = pending.subarray(0, end + 4).toString('ascii');
      pending = pending.subarray(end + 4);
    }
    while (status.startsWith('HTTP/1.1 101') && pending.length >= 2) {
      const opcode = pending[0] & 15;
      let length = pending[1] & 127;
      let header = 2;
      if (length === 126) {
        if (pending.length < 4) break;
        length = pending.readUInt16BE(2); header = 4;
      } else if (length === 127) {
        if (pending.length < 10) break;
        length = Number(pending.readBigUInt64BE(2)); header = 10;
      }
      if (length > 1024 * 1024) { socket.destroy(new Error('oversized WS frame')); return; }
      if (pending.length < header + length) break;
      const payload = pending.subarray(header, header + length);
      pending = pending.subarray(header + length);
      if (opcode === 2 || opcode === 0) rfb = Buffer.concat([rfb, payload]);
      if (opcode === 8) socket.destroy();
    }
    wake();
  });
  socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${endpoint.port}\r\n` +
    'Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n' +
    `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nOrigin: ${origin}\r\n\r\n`);

  async function waitFor(selector, label) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiters.delete(check); reject(new Error(`${label} timed out`)); }, TIMEOUT_MS);
      function check() {
        if (closed && selector() === null) { clearTimeout(timer); waiters.delete(check); reject(new Error(`${label}: socket closed`)); return; }
        const result = selector();
        if (result === null) return;
        clearTimeout(timer); waiters.delete(check); resolve(result);
      }
      waiters.add(check);
      check();
    });
  }
  return {
    socket,
    headers: () => waitFor(() => status, 'WebSocket upgrade'),
    read: size => waitFor(() => {
      if (rfb.length < size) return null;
      const bytes = Buffer.from(rfb.subarray(0, size));
      rfb = rfb.subarray(size);
      return bytes;
    }, `RFB read of ${size} bytes`),
    write: bytes => {
      const payload = Buffer.from(bytes);
      assert.ok(payload.length <= 65535);
      const prefix = payload.length < 126 ? Buffer.from([0x82, 0x80 | payload.length])
        : Buffer.from([0x82, 0xfe, payload.length >> 8, payload.length & 255]);
      const mask = randomBytes(4);
      const masked = Buffer.from(payload);
      for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
      socket.write(Buffer.concat([prefix, mask, masked]));
    },
  };
}

async function rfbSession(gatewayOrigin, rfbPort, t) {
  const ticket = await fetch(`${gatewayOrigin}/api/sessions`, {
    method: 'POST', headers: { Origin: gatewayOrigin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ host: '127.0.0.1', port: rfbPort }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  assert.equal(ticket.status, 201);
  const session = await ticket.json();
  const ws = await openSession(gatewayOrigin, session.wsPath, t);
  assert.match(await ws.headers(), /^HTTP\/1\.1 101 /);
  const greeting = (await ws.read(12)).toString('ascii');
  assert.match(greeting, /^RFB 003\.(003|007|008)\n$/);
  ws.write(Buffer.from('RFB 003.008\n', 'ascii'));
  const number = (await ws.read(1))[0];
  assert.ok(number > 0 && number < 32, `unexpected security type count ${number}`);
  const types = await ws.read(number);
  assert.ok(types.includes(1), `stock TigerVNC did not offer loopback-only SecurityType None: ${types}`);
  ws.write(Buffer.from([1]));
  assert.equal((await ws.read(4)).readUInt32BE(), 0, 'stock TigerVNC security result');
  ws.write(Buffer.from([1]));
  const init = await ws.read(24);
  const width = init.readUInt16BE(0);
  const height = init.readUInt16BE(2);
  const nameLength = init.readUInt32BE(20);
  assert.equal(width, WIDTH);
  assert.equal(height, HEIGHT);
  assert.equal(init[4], 32, '32 bpp expected for TigerVNC depth 24');
  assert.equal(init[7], 1, 'true colour expected');
  assert.deepEqual([init.readUInt16BE(8), init.readUInt16BE(10), init.readUInt16BE(12)], [255, 255, 255]);
  assert.ok(nameLength > 0 && nameLength <= 1024);
  const desktop = (await ws.read(nameLength)).toString('utf8');
  console.log(`RFB stock server version=${greeting.trim()} security=${[...types]} dimensions=${width}x${height} bpp=${init[4]} desktopNameLength=${nameLength}`);
  assert.ok(desktop.length > 0);

  // Ask a real upstream server for Raw rather than accepting its compressed default.
  ws.write(Buffer.from([2, 0, 0, 1, 0, 0, 0, 0]));
  const request = Buffer.alloc(10);
  request[0] = 3;
  request.writeUInt16BE(width, 6);
  request.writeUInt16BE(height, 8);
  ws.write(request);
  const update = await ws.read(4);
  assert.equal(update[0], 0, 'expected FramebufferUpdate');
  const rectangles = update.readUInt16BE(2);
  assert.ok(rectangles > 0 && rectangles < 16, `unexpected rectangles=${rectangles}`);
  let pixels = 0;
  let firstPixel = null;
  for (let index = 0; index < rectangles; index++) {
    const rect = await ws.read(12);
    const x = rect.readUInt16BE(0);
    const y = rect.readUInt16BE(2);
    const w = rect.readUInt16BE(4);
    const h = rect.readUInt16BE(6);
    assert.equal(rect.readInt32BE(8), 0, 'expected Raw encoding');
    assert.ok(w && h && x + w <= width && y + h <= height);
    const bytes = await ws.read(w * h * 4);
    assert.equal(bytes.length, w * h * 4);
    if (x === 0 && y === 0) {
      const word = init[6] ? bytes.readUInt32BE() : bytes.readUInt32LE();
      firstPixel = [init[14], init[15], init[16]].map(shift => (word >>> shift) & 255);
    }
    pixels += w * h;
  }
  assert.equal(pixels, width * height, 'complete stock-server framebuffer');
  assert.deepEqual(firstPixel, [0x28, 0x91, 0x4c], 'real X11 root colour reached client through gateway');
  console.log(`RFB stock framebuffer update rectangles=${rectangles} rawPixels=${pixels} topLeftRGB=${firstPixel}`);
  return ws;
}

test('stock TigerVNC → actual loopback gateway: RFB framebuffer and disconnect/reconnect', { skip: !RUN, timeout: 45_000 }, async t => {
  assert.equal(process.platform, 'linux', 'stock TigerVNC runner requires Linux');
  const tiger = await startTiger(t);
  const gateway = createGateway({ port: 0, allowedPorts: [tiger.port] });
  const origin = await gateway.listen();
  t.after(() => gateway.close());
  const first = await rfbSession(origin, tiger.port, t);
  first.socket.destroy();
  await once(first.socket, 'close', { signal: AbortSignal.timeout(TIMEOUT_MS) });
  const second = await rfbSession(origin, tiger.port, t);
  second.socket.destroy();
  await once(second.socket, 'close', { signal: AbortSignal.timeout(TIMEOUT_MS) });
  console.log('RFB stock lifecycle: first session closed; second independent ticket and framebuffer passed; second session closed');
});
