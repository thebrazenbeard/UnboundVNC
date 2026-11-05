// Stock, independently implemented RFB screen scrapers against a synthetic
// Xvfb desktop. Opt-in only: None authentication is safe here solely because
// the runner and VNC listeners are ephemeral and loopback-only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway } from '../../apps/gateway/src/server.mjs';

const ENABLED = process.env.RFB_X11_SCRAPERS === '1';
const WIDTH = 48;
const HEIGHT = 32;
const COLOUR = [0x28, 0x91, 0x4c];
const TIMEOUT = 12_000;
let displayNumber = 80 + (process.pid % 150);

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

function launch(t, command, args) {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let tail = '';
  let prefix = '';
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', chunk => {
      const content = chunk.toString();
      prefix = (prefix + content).slice(0, 800);
      tail = (tail + content).slice(-1600);
    });
  }
  child.on('error', error => { tail = `spawn error: ${error.message}`; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await Promise.race([once(child, 'exit'), delay(2000)]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });
  return { child, logTail: () => `${prefix}\n[tail]\n${tail}` };
}

// Independently check the X11 server's real pixels, not merely xsetroot's
// successful exit code. XWD is supplied by Ubuntu's unmodified x11-apps.
function assertX11RootPixels(display) {
  const capture = spawnSync('xwd', ['-root', '-silent', '-display', display],
    { timeout: 3000, maxBuffer: 1024 * 1024 });
  assert.equal(capture.status, 0, 'independent XWD root capture failed');
  const image = capture.stdout;
  assert.ok(image.length >= 100, 'XWD header absent');
  const u32 = index => image.readUInt32BE(index * 4);
  const [headerSize, width, height, byteOrder, bpp, stride, colourCount] =
    [0, 4, 5, 7, 11, 12, 19].map(u32);
  assert.deepEqual([width, height, bpp], [WIDTH, HEIGHT, 32], 'XWD root geometry/format');
  assert.ok(byteOrder === 0 || byteOrder === 1);
  assert.ok(headerSize >= 100 && colourCount < 1024);
  const channels = [u32(14), u32(15), u32(16)].map(mask => {
    assert.ok(mask > 0, 'XWD true-colour channel mask');
    const shift = Math.log2(mask & -mask);
    return { mask, shift, max: mask >>> shift };
  });
  const start = headerSize + colourCount * 12;
  assert.ok(image.length >= start + stride * height, 'XWD pixel data truncated');
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = start + y * stride + x * 4;
      const pixel = byteOrder === 0 ? image.readUInt32LE(offset) : image.readUInt32BE(offset);
      const actual = channels.map(({ mask, shift, max }) => Math.round(((pixel & mask) >>> shift) * 255 / max));
      assert.ok(actual.every((value, i) => value === COLOUR[i]),
        `XWD oracle root pixel failed at (${x},${y}); no screen content logged`);
    }
  }
  console.log(`independent XWD oracle: ${width * height} X11 root pixels verified`);
}

async function awaitPort(port, processInfo) {
  const deadline = Date.now() + TIMEOUT;
  while (Date.now() < deadline) {
    if (processInfo.child.exitCode !== null || processInfo.child.signalCode !== null)
      throw new Error(`RFB process exited before ready: ${processInfo.logTail()}`);
    try {
      const socket = connect({ host: '127.0.0.1', port });
      await once(socket, 'connect', { signal: AbortSignal.timeout(500) });
      socket.destroy();
      return;
    } catch { await delay(100); }
  }
  throw new Error(`RFB listener did not start: ${processInfo.logTail()}`);
}

async function listenerAndConnections(port) {
  const hex = port.toString(16).toUpperCase().padStart(4, '0');
  const tables = await Promise.all(['/proc/net/tcp', '/proc/net/tcp6'].map(path => readFile(path, 'utf8')));
  const records = tables.flatMap((table, index) => table.split('\n').slice(1)
    .map(line => ({ family: index, fields: line.trim().split(/\s+/) }))
    .filter(({ fields }) => fields[1]?.endsWith(`:${hex}`) || fields[2]?.endsWith(`:${hex}`)));
  const listeners = records.filter(({ fields }) => fields[3] === '0A');
  assert.ok(listeners.length > 0, 'expected an RFB listener');
  for (const { family, fields } of listeners) {
    const loopback = family === 0 ? `0100007F:${hex}` : `00000000000000000000000001000000:${hex}`;
    assert.equal(fields[1], loopback, 'RFB listening outside loopback is forbidden');
  }
  return records.filter(({ fields }) => fields[3] === '01').map(({ fields }) => [fields[1], fields[2]]);
}

async function awaitConnectionsGone(port) {
  const deadline = Date.now() + TIMEOUT;
  while (Date.now() < deadline) {
    if ((await listenerAndConnections(port)).length === 0) return;
    await delay(100);
  }
  throw new Error(`gateway leaked upstream ESTABLISHED RFB endpoints: ${JSON.stringify(await listenerAndConnections(port))}`);
}

async function startBackend(t, backend) {
  assert.equal(process.platform, 'linux');
  const display = `:${displayNumber++}`;
  const xvfb = launch(t, 'Xvfb', [display, '-screen', '0', `${WIDTH}x${HEIGHT}x24`, '-nolisten', 'tcp', '-ac']);
  const deadline = Date.now() + TIMEOUT;
  let painted = false;
  while (Date.now() < deadline) {
    if (xvfb.child.exitCode !== null || xvfb.child.signalCode !== null)
      throw new Error(`Xvfb exited early: ${xvfb.logTail()}`);
    const root = spawnSync('xsetroot', ['-display', display, '-solid', '#28914c'],
      { encoding: 'utf8', timeout: 1500 });
    if (root.status === 0) { painted = true; break; }
    await delay(100);
  }
  assert.ok(painted, `Xvfb did not accept synthetic root colour: ${xvfb.logTail()}`);
  // RFB scraping servers often composite the *software pointer* into Raw
  // pixels. XWD omits that pointer. Xvfb starts it at the exact framebuffer
  // centre (24,16), which caused reproducible cross-server mismatches there.
  // An original 16x16 fully transparent XBM cursor makes the oracles identical.
  const cursorDir = await mkdtemp(join(tmpdir(), 'unboundvnc-x11-cursor-'));
  const cursor = join(cursorDir, 'transparent.xbm');
  const transparentXbm = '#define transparent_width 16\n#define transparent_height 16\n' +
    '#define transparent_x_hot 0\n#define transparent_y_hot 0\n' +
    'static unsigned char transparent_bits[] = {\n' +
    Array.from({ length: 4 }, () => '  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00').join(',\n') + '\n};\n';
  await writeFile(cursor, transparentXbm,
    { mode: 0o600, flag: 'wx' });
  t.after(async () => { await unlink(cursor); await rmdir(cursorDir); });
  const port = await unusedPort();
  let command;
  let args;
  if (backend === 'x11vnc') {
    command = 'x11vnc';
    args = ['-norc', '-display', display, '-localhost', '-rfbport', String(port),
      '-nopw', '-forever', '-shared', '-quiet', '-noxdamage', '-nocursor'];
  } else {
    command = 'X0tigervnc';
    // Direct X0tigervnc (unlike its wrapper) uses -Parameter=value syntax;
    // a bare `yes` following `-localhost` is an invalid extra parameter.
    args = [`-display=${display}`, `-rfbport=${port}`, '-SecurityTypes=None',
      '-localhost', '-interface=127.0.0.1', '-AlwaysShared'];
  }
  const scraper = launch(t, command, args);
  await awaitPort(port, scraper);
  assert.deepEqual(await listenerAndConnections(port), [], 'RFB readiness probe did not disconnect');
  // Repaint with a transparent pointer after the scraper subscribes to the
  // display. Without this, XWD excludes the central cursor while scrapers
  // paint it directly into RFB Raw pixels, falsifying the full-frame oracle.
  const repaint = spawnSync('xsetroot', ['-display', display, '-solid', '#28914c'],
    { encoding: 'utf8', timeout: 3000 });
  assert.equal(repaint.status, 0, `Xvfb repaint failed: ${repaint.stderr}`);
  const hidePointer = spawnSync('xsetroot', ['-display', display, '-cursor', cursor, cursor],
    { encoding: 'utf8', timeout: 3000 });
  assert.equal(hidePointer.status, 0, `Xvfb cursor hiding failed: ${hidePointer.stderr}`);
  await delay(1200);
  assertX11RootPixels(display);
  return port;
}

// Minimal real masked WebSocket client: it reads bytes from the actual gateway,
// not from a mocked RFB fixture. All client-to-server frames are masked.
async function openWebSocket(origin, path, t) {
  const { port } = new URL(origin);
  const socket = connect({ host: '127.0.0.1', port: Number(port) });
  socket.on('error', () => {});
  t.after(() => socket.destroy());
  await once(socket, 'connect', { signal: AbortSignal.timeout(TIMEOUT) });
  let data = Buffer.alloc(0);
  let rfb = Buffer.alloc(0);
  let status = null;
  let closed = false;
  const callbacks = new Set();
  const wake = () => { for (const cb of [...callbacks]) cb(); };
  socket.on('close', () => { closed = true; wake(); });
  socket.on('data', bytes => {
    data = Buffer.concat([data, bytes]);
    if (status === null) {
      const headerEnd = data.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      status = data.subarray(0, headerEnd + 4).toString('ascii');
      data = data.subarray(headerEnd + 4);
    }
    if (!status.startsWith('HTTP/1.1 101')) { wake(); return; }
    while (data.length >= 2) {
      const opcode = data[0] & 15;
      assert.equal(data[1] & 0x80, 0, 'server WebSocket must not mask frames');
      let length = data[1] & 127;
      let header = 2;
      if (length === 126) {
        if (data.length < 4) break;
        length = data.readUInt16BE(2); header = 4;
      } else if (length === 127) {
        if (data.length < 10) break;
        length = Number(data.readBigUInt64BE(2)); header = 10;
      }
      assert.ok(length <= 1024 * 1024, 'excessive WS frame');
      if (data.length < header + length) break;
      const payload = data.subarray(header, header + length);
      data = data.subarray(header + length);
      if (opcode === 2 || opcode === 0) rfb = Buffer.concat([rfb, payload]);
      if (opcode === 8) socket.destroy();
    }
    wake();
  });
  socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
    'Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n' +
    `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nOrigin: ${origin}\r\n\r\n`);
  const awaitValue = (fn, label) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { callbacks.delete(check); reject(new Error(`${label} timeout`)); }, TIMEOUT);
    function check() {
      const value = fn();
      if (value !== null) { clearTimeout(timer); callbacks.delete(check); resolve(value); }
      else if (closed) { clearTimeout(timer); callbacks.delete(check); reject(new Error(`${label} socket closed`)); }
    }
    callbacks.add(check);
    check();
  });
  return {
    socket,
    headers: () => awaitValue(() => status, 'WS upgrade'),
    read: length => awaitValue(() => {
      if (rfb.length < length) return null;
      const bytes = Buffer.from(rfb.subarray(0, length));
      rfb = rfb.subarray(length);
      return bytes;
    }, `RFB read ${length}`),
    write: bytes => {
      const payload = Buffer.from(bytes);
      assert.ok(payload.length < 65536);
      const prefix = payload.length < 126 ? Buffer.from([0x82, 0x80 | payload.length])
        : Buffer.from([0x82, 0xfe, payload.length >> 8, payload.length & 255]);
      const mask = randomBytes(4);
      const encoded = Buffer.from(payload);
      for (let i = 0; i < encoded.length; i++) encoded[i] ^= mask[i % 4];
      socket.write(Buffer.concat([prefix, mask, encoded]));
    },
    close: () => socket.write(Buffer.concat([Buffer.from([0x88, 0x80]), randomBytes(4)])),
  };
}

async function qualifyRfb(origin, port, t, backend) {
  const response = await fetch(`${origin}/api/sessions`, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ host: '127.0.0.1', port }), signal: AbortSignal.timeout(TIMEOUT),
  });
  assert.equal(response.status, 201);
  const ticket = await response.json();
  const ws = await openWebSocket(origin, ticket.wsPath, t);
  assert.match(await ws.headers(), /^HTTP\/1\.1 101 /);
  const version = (await ws.read(12)).toString('ascii');
  assert.match(version, /^RFB 003\.(003|007|008)\n$/);
  ws.write(Buffer.from(version === 'RFB 003.003\n' ? version : 'RFB 003.008\n'));
  if (version === 'RFB 003.003\n') {
    assert.equal((await ws.read(4)).readUInt32BE(), 1, 'RFB 3.3 None on loopback');
  } else {
    const count = (await ws.read(1))[0];
    assert.ok(count > 0 && count < 32);
    const types = await ws.read(count);
    assert.ok(types.includes(1), 'RFB server must offer None on private test loopback');
    ws.write(Buffer.from([1]));
    assert.equal((await ws.read(4)).readUInt32BE(), 0, 'RFB SecurityResult');
  }
  ws.write(Buffer.from([1])); // ClientInit shared desktop.
  const init = await ws.read(24);
  const width = init.readUInt16BE(0);
  const height = init.readUInt16BE(2);
  assert.deepEqual([width, height], [WIDTH, HEIGHT]);
  assert.equal(init[4], 32, 'expected 32 bits per pixel on Xvfb depth 24');
  // RFC 6143 defines true-colour as a nonzero flag, not necessarily byte 1.
  // libvncserver/x11vnc reports 255 here; verify the full pixel masks below.
  assert.notEqual(init[7], 0, 'expected true-colour pixels');
  assert.deepEqual([init.readUInt16BE(8), init.readUInt16BE(10), init.readUInt16BE(12)], [255, 255, 255]);
  const nameLength = init.readUInt32BE(20);
  assert.ok(nameLength > 0 && nameLength <= 4096);
  await ws.read(nameLength);
  ws.write(Buffer.from([2, 0, 0, 1, 0, 0, 0, 0])); // Raw encoding only.
  const request = Buffer.alloc(10);
  request[0] = 3;
  request.writeUInt16BE(width, 6);
  request.writeUInt16BE(height, 8);
  ws.write(request);
  const header = await ws.read(4);
  assert.equal(header[0], 0, 'expected FramebufferUpdate');
  const rectangles = header.readUInt16BE(2);
  assert.ok(rectangles > 0 && rectangles <= 32);
  const coverage = new Uint8Array(width * height);
  for (let i = 0; i < rectangles; i++) {
    const rect = await ws.read(12);
    const [x, y, w, h] = [0, 2, 4, 6].map(offset => rect.readUInt16BE(offset));
    assert.equal(rect.readInt32BE(8), 0, 'expected stock server Raw encoding');
    assert.ok(w && h && x + w <= width && y + h <= height);
    const pixels = await ws.read(w * h * 4);
    for (let p = 0; p < w * h; p++) {
      const word = init[6] ? pixels.readUInt32BE(p * 4) : pixels.readUInt32LE(p * 4);
      const actual = [init[14], init[15], init[16]].map(shift => (word >>> shift) & 255);
      assert.ok(actual.every((value, channel) => value === COLOUR[channel]),
        `${backend} root pixel mismatch at rect ${i}, pixel ${p}; screen content not logged`);
      const index = (y + Math.floor(p / w)) * width + x + (p % w);
      assert.equal(coverage[index], 0, 'overlapping Raw rectangle');
      coverage[index] = 1;
    }
  }
  assert.ok(coverage.every(value => value === 1), 'every framebuffer pixel must be covered');
  console.log(`${backend}: ${version.trim()}, Raw ${width}x${height}, ${rectangles} rect(s), ${coverage.length} verified pixels`);
  return ws;
}

for (const backend of ['x11vnc', 'x0tigervnc']) {
  test(`stock ${backend} Xvfb → gateway: Raw framebuffer, graceful and abrupt disconnect`,
    { skip: !ENABLED, timeout: 70_000 }, async t => {
      const port = await startBackend(t, backend);
      const gateway = createGateway({ port: 0, allowedPorts: [port] });
      const origin = await gateway.listen();
      t.after(() => gateway.close());
      const first = await qualifyRfb(origin, port, t, backend);
      const firstClosed = once(first.socket, 'close', { signal: AbortSignal.timeout(TIMEOUT) });
      first.close();
      await firstClosed;
      await awaitConnectionsGone(port);
      const second = await qualifyRfb(origin, port, t, backend);
      const secondClosed = once(second.socket, 'close', { signal: AbortSignal.timeout(TIMEOUT) });
      second.socket.destroy();
      await secondClosed;
      await awaitConnectionsGone(port);
      console.log(`${backend}: graceful WS Close and abrupt TCP teardown both released upstream RFB`);
    });
}
