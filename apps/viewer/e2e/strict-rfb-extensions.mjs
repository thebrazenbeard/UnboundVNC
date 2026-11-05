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
  const value = Buffer.from([blue, green, red, 0]); // 32bpp little-endian BGRX
  const bytes = Buffer.alloc(width * height * 4);
  for (let offset = 0; offset < bytes.length; offset += 4) value.copy(bytes, offset);
  return bytes;
}

async function waitForCanvas(page, width, height, rgb, label) {
  const handle = await page.waitForFunction(({ width: w, height: h, rgb: expected }) => {
    const canvas = document.querySelector('#remote-screen canvas');
    if (!canvas || canvas.width !== w || canvas.height !== h) return false;
    const samples = [[0, 0], [Math.floor(w / 2), Math.floor(h / 2)], [w - 1, h - 1]];
    const values = samples.map(([x, y]) => Array.from(canvas.getContext('2d').getImageData(x, y, 1, 1).data.slice(0, 3)));
    return values.every(color => color.every((value, i) => value === expected[i]))
      ? { width: canvas.width, height: canvas.height, samples: values } : false;
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
        connection.socket.write(framebufferUpdate(rectangle(RAW, 2, 2, fixtureProtocol.PIXELS)));
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

    // DesktopSize must be followed by a real 4x3 Raw rectangle, not merely a
    // canvas resize. The fixture now accepts the client's new request bounds.
    fixture.resize(WIDTH, HEIGHT);
    connection.socket.write(framebufferUpdate(
      rectangle(DESKTOP_SIZE, WIDTH, HEIGHT),
      rectangle(RAW, WIDTH, HEIGHT, pixels(WIDTH, HEIGHT, 0xcc, 0x44, 0x88))));
    samples.push(await waitForCanvas(page, WIDTH, HEIGHT, [0xcc, 0x44, 0x88], 'DesktopSize + Raw'));
    connection.socket.write(framebufferUpdate(rectangle(HEXTILE, WIDTH, HEIGHT,
      Buffer.concat([Buffer.from([1]), pixels(WIDTH, HEIGHT, 0x19, 0x87, 0xde)]))));
    samples.push(await waitForCanvas(page, WIDTH, HEIGHT, [0x19, 0x87, 0xde], 'Hextile Raw tile'));
    connection.socket.write(framebufferUpdate(rectangle(TIGHT, WIDTH, HEIGHT,
      Buffer.from([0x80, 0x11, 0xb4, 0x66]))));
    samples.push(await waitForCanvas(page, WIDTH, HEIGHT, [0x11, 0xb4, 0x66], 'Tight Fill'));

    // Pointer and keyboard must remain usable at the *new* framebuffer size.
    const canvas = page.locator('#remote-screen canvas');
    await canvas.click({ position: { x: 2, y: 2 } });
    await page.keyboard.press('a');
    await eventually(() => connection.messages.some(message => message.type === 'pointer' &&
      message.x < WIDTH && message.y < HEIGHT && message.mask === 1), 'resized pointer down');
    await eventually(() => connection.messages.some(message => message.type === 'key' && message.down), 'keyboard after resize');
    assert.deepEqual(errors, [], `strict RFB fixture or browser reported errors: ${errors.join(', ')}`);
    assert.equal(await page.locator('#session-view').isVisible(), true);
    console.log(JSON.stringify({ outcome: 'PASS', browser: browser.version(), rfbVersion: '3.8',
      loopback: true, encodings: [RAW, HEXTILE, TIGHT, DESKTOP_SIZE, CURSOR], samples,
      resizedInput: connection.messages.filter(message => ['pointer', 'key'].includes(message.type)).slice(-8),
    }));
  } finally {
    await browser?.close();
    await vite?.close();
    await gateway?.close();
    await fixture?.close();
  }
}

run().catch(error => { console.error(`Strict RFB extension browser regression failed: ${error.stack ?? error}`); process.exitCode = 1; });
