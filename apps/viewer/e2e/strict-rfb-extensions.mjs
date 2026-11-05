import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import { createGateway } from '../../gateway/src/server.mjs';
import { createRfbFixture, fixtureProtocol } from '../../../tests/interop/rfb-fixture.mjs';

// A test-owned, RFC 6143 RFB 3.8 server. All sockets bind only IPv4 loopback.
// Pixel assertions below read Chromium's decoded canvas, not packet metadata.
const require = createRequire(import.meta.url);
const viewerRoot = fileURLToPath(new URL('../', import.meta.url));
const RAW = 0;
const HEXTILE = 5;
const TIGHT = 7;
const DESKTOP_SIZE = -223;
const CURSOR = -239;
const WIDTH = 4;
const HEIGHT = 3;

function rectangle(encoding, width, height, payload = Buffer.alloc(0)) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(width, 4);
  header.writeUInt16BE(height, 6);
  header.writeInt32BE(encoding, 8);
  return Buffer.concat([header, payload]);
}

function framebufferUpdate(...rectangles) {
  const header = Buffer.alloc(4);
  header.writeUInt16BE(rectangles.length, 2);
  return Buffer.concat([header, ...rectangles]);
}

function pixels(width, height, red, green, blue) {
  const value = Buffer.from([red, green, blue, 0]); // noVNC requests RGBX via SetPixelFormat
  const bytes = Buffer.alloc(width * height * 4);
  for (let offset = 0; offset < bytes.length; offset += 4) value.copy(bytes, offset);
  return bytes;
}

async function waitForCanvas(page, width, height, rgb, label) {
  const handle = await page.waitForFunction(({ width: w, height: h, rgb: expected }) => {
    const canvas = document.querySelector('#remote-screen canvas');
    if (!canvas || canvas.width !== w || canvas.height !== h) return false;
    const data = canvas.getContext('2d').getImageData(0, 0, w, h).data;
    for (let offset = 0; offset < data.length; offset += 4) {
      if (!expected.every((value, i) => data[offset + i] === value)) return false;
    }
    return { width: canvas.width, height: canvas.height, pixelCount: w * h, rgb: expected };
  }, { width, height, rgb }, { timeout: 10_000 });
  const actual = await handle.jsonValue();
  assert.ok(actual, `${label} pixel oracle failed`);
  return { label, ...actual };
}

async function eventually(predicate, label, timeoutMs = 10_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function framebufferRequests(connection) {
  return connection.messages.filter(message => message.type === 'framebuffer-request');
}

async function expectNextRequest(connection, previousCount, label) {
  await eventually(() => framebufferRequests(connection).length > previousCount, label);
  const request = framebufferRequests(connection).at(-1);
  assert.deepEqual({ width: request.width, height: request.height, x: request.x, y: request.y },
    { width: WIDTH, height: HEIGHT, x: 0, y: 0 }, `${label} requested stale framebuffer bounds`);
  assert.equal(request.incremental, true, `${label} did not request an incremental update`);
}

async function run() {
  let fixture;
  let gateway;
  let vite;
  let browser;
  const errors = [];
  const samples = [];
  try {
    fixture = await createRfbFixture({ autoRespond: false }).start();
    fixture.events.on('protocolError', (_connection, error) => errors.push(error.message));
    fixture.events.on('message', (connection, message) => {
      if (message.type === 'framebuffer-request' && !connection.initialFrameSent) {
        connection.initialFrameSent = true;
        // The fixture's exported example is BGRX for its default ServerInit;
        // noVNC explicitly requests RGBX, so swap red and blue per pixel.
        const initial = Buffer.from(fixtureProtocol.PIXELS);
        for (let i = 0; i < initial.length; i += 4) [initial[i], initial[i + 2]] = [initial[i + 2], initial[i]];
        connection.socket.write(framebufferUpdate(rectangle(RAW, 2, 2, initial)));
      }
    });
    gateway = createGateway({ port: 0, allowedPorts: [fixture.port] });
    const gatewayOrigin = await gateway.listen();
    vite = await createViteServer({
      configFile: path.join(viewerRoot, 'vite.config.js'), root: viewerRoot,
      server: { host: '127.0.0.1', port: 0, strictPort: true, proxy: {
        '/api': { target: gatewayOrigin, changeOrigin: false },
        '/ws': { target: gatewayOrigin.replace(/^http/, 'ws'), ws: true, changeOrigin: false },
      } },
    });
    await vite.listen();
    const browserPort = vite.httpServer.address().port;
    const { chromium } = require('playwright');
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on('pageerror', error => errors.push(`browser: ${error.message}`));
    await page.goto(`http://127.0.0.1:${browserPort}/`, { waitUntil: 'networkidle' });
    await page.getByText('Local gateway available').waitFor({ timeout: 10_000 });
    await page.locator('#quick-host').fill('127.0.0.1');
    await page.locator('#quick-port').fill(String(fixture.port));
    await page.locator('#quick-form button[type="submit"]').click();
    await page.getByText('Connected · identity unverified').waitFor({ timeout: 10_000 });
    await eventually(() => [...fixture.connections].some(connection => connection.initialFrameSent), 'initial framebuffer request');
    const connection = [...fixture.connections].find(candidate => candidate.initialFrameSent);
    await eventually(() => connection.messages.some(message => message.type === 'encodings'), 'SetEncodings');
    const encodings = connection.messages.find(message => message.type === 'encodings').encodings;
    for (const encoding of [RAW, HEXTILE, TIGHT, DESKTOP_SIZE, CURSOR]) {
      assert.ok(encodings.includes(encoding), `noVNC did not negotiate RFB encoding ${encoding}`);
    }
    // Real initial 2x2 fixture pixels are red, green, blue, white. Assert a
    // single red canvas pixel before the dynamic resize sequence.
    await page.waitForFunction(() => {
      const canvas = document.querySelector('#remote-screen canvas');
      if (canvas?.width !== 2 || canvas.height !== 2) return false;
      const pixel = canvas.getContext('2d').getImageData(0, 0, 1, 1).data;
      return pixel[0] === 255 && pixel[1] === 0 && pixel[2] === 0;
    }, null, { timeout: 10_000 });

    // RFC 6143 §7.8.2 requires DesktopSize to be the LAST rectangle in a
    // FramebufferUpdate. Only after noVNC requests the new 4x3 framebuffer
    // may this strict fixture send an independent full Raw update.
    await eventually(() => framebufferRequests(connection).length >= 2,
      'initial incremental framebuffer request');
    fixture.resize(WIDTH, HEIGHT);
    const oldRequests = framebufferRequests(connection).length;
    connection.socket.write(framebufferUpdate(rectangle(DESKTOP_SIZE, WIDTH, HEIGHT)));
    await expectNextRequest(connection, oldRequests, 'after terminal DesktopSize');
    const postResizeRequests = framebufferRequests(connection).length;
    connection.socket.write(framebufferUpdate(rectangle(RAW, WIDTH, HEIGHT,
      pixels(WIDTH, HEIGHT, 0xcc, 0x44, 0x88))));
    samples.push(await waitForCanvas(page, WIDTH, HEIGHT, [0xcc, 0x44, 0x88], 'DesktopSize then Raw'));
    await expectNextRequest(connection, postResizeRequests, 'after Raw on resized desktop');
    const postRawRequests = framebufferRequests(connection).length;
    connection.socket.write(framebufferUpdate(rectangle(HEXTILE, WIDTH, HEIGHT,
      Buffer.concat([Buffer.from([1]), pixels(WIDTH, HEIGHT, 0x19, 0x87, 0xde)]))));
    samples.push(await waitForCanvas(page, WIDTH, HEIGHT, [0x19, 0x87, 0xde], 'Hextile Raw tile'));
    await expectNextRequest(connection, postRawRequests, 'after Hextile');
    const postHextileRequests = framebufferRequests(connection).length;
    connection.socket.write(framebufferUpdate(rectangle(TIGHT, WIDTH, HEIGHT,
      Buffer.from([0x80, 0x11, 0xb4, 0x66]))));
    samples.push(await waitForCanvas(page, WIDTH, HEIGHT, [0x11, 0xb4, 0x66], 'Tight Fill'));
    await expectNextRequest(connection, postHextileRequests, 'after Tight');

    // Pointer and keyboard must remain usable at the *new* framebuffer size.
    const canvas = page.locator('#remote-screen canvas');
    const inputStart = connection.messages.length;
    await canvas.click({ position: { x: 2, y: 2 } });
    await page.keyboard.press('a');
    const subsequentInput = () => connection.messages.slice(inputStart);
    await eventually(() => subsequentInput().some(message => message.type === 'pointer' &&
      message.x < WIDTH && message.y < HEIGHT && message.mask === 1), 'resized pointer down');
    await eventually(() => subsequentInput().some(message => message.type === 'key' &&
      message.down && message.key === 0x61), 'resized keyboard a keydown');
    assert.deepEqual(errors, [], `strict RFB fixture or browser reported errors: ${errors.join(', ')}`);
    assert.equal(await page.locator('#session-view').isVisible(), true);
    console.log(JSON.stringify({ outcome: 'PASS', browser: browser.version(), rfbVersion: '3.8',
      loopback: true, encodings: [RAW, HEXTILE, TIGHT, DESKTOP_SIZE, CURSOR], samples,
      resizedInput: subsequentInput().filter(message => ['pointer', 'key'].includes(message.type)),
    }));
  } finally {
    await browser?.close();
    await vite?.close();
    await gateway?.close();
    await fixture?.close();
  }
}

run().catch(error => { console.error(`Strict RFB extension browser regression failed: ${error.stack ?? error}`); process.exitCode = 1; });
