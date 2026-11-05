import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { connect, createServer as createTcpServer } from 'node:net';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import { createGateway } from '../../gateway/src/server.mjs';

const require = createRequire(import.meta.url);
const viewerRoot = fileURLToPath(new URL('../', import.meta.url));
const COLOR = '#28914c';
const RGB = [0x28, 0x91, 0x4c];
const RFB_WIDTH = 480;
const RFB_HEIGHT = 320;

async function vacantPort() {
  const server = createTcpServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function waitForPort(port, child, log) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Xtigervnc exited ${child.exitCode}: ${log()}`);
    try {
      await new Promise((resolve, reject) => {
        const socket = connect({ host: '127.0.0.1', port });
        socket.once('connect', () => { socket.destroy(); resolve(); });
        socket.once('error', reject);
        socket.setTimeout(500, () => { socket.destroy(); reject(new Error('connect timeout')); });
      });
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  throw new Error(`Xtigervnc did not start on IPv4 loopback: ${log()}`);
}

async function assertLoopbackRfb(port) {
  const hexPort = port.toString(16).toUpperCase().padStart(4, '0');
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    const rows = (await readFile(file, 'utf8')).split('\n').slice(1)
      .map(line => line.trim().split(/\s+/))
      .filter(fields => fields[1]?.endsWith(`:${hexPort}`) && fields[3] === '0A');
    if (file.endsWith('tcp')) assert.ok(rows.length > 0, 'missing RFB IPv4 listener');
    assert.ok(rows.every(fields => fields[1] === (file.endsWith('tcp')
      ? `0100007F:${hexPort}` : `00000000000000000000000001000000:${hexPort}`)),
      `RFB listening on a non-loopback address in ${file}`);
  }
}

async function stopTiger(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    new Promise(resolve => setTimeout(resolve, 2000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function run() {
  if (process.platform !== 'linux') throw new Error('Stock TigerVNC fixture requires Linux');
  const { chromium } = require('playwright');
  let tiger;
  let gateway;
  let vite;
  let browser;
  let context;
  let page;
  let succeeded = false;
  let evidenceDir;
  let tigerLog = '';
  const browserEvents = [];
  try {
    // A fresh X11 display on an ephemeral CI runner, never a real workstation.
    const rfbPort = await vacantPort();
    const display = `:${70 + (process.pid % 120)}`;
    tiger = spawn('Xtigervnc', [display, '-geometry', `${RFB_WIDTH}x${RFB_HEIGHT}`,
      '-depth', '24', '-rfbport', String(rfbPort), '-SecurityTypes', 'None',
      '-localhost', 'yes', '-interface', '127.0.0.1', '-nolisten', 'tcp', '-ac'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
    tiger.on('error', error => { tigerLog = `${tigerLog}\n${error.message}`; });
    for (const stream of [tiger.stdout, tiger.stderr]) {
      stream.on('data', bytes => { tigerLog = (tigerLog + bytes.toString()).slice(-8_000); });
    }
    await waitForPort(rfbPort, tiger, () => tigerLog);
    await assertLoopbackRfb(rfbPort);
    const paint = spawnSync('xsetroot', ['-display', display, '-solid', COLOR],
      { encoding: 'utf8', timeout: 3000 });
    assert.equal(paint.status, 0, `xsetroot did not paint the independent X11 root: ${paint.stderr ?? paint.error?.message}`);

    gateway = createGateway({ port: 0, allowedPorts: [rfbPort] });
    const gatewayOrigin = await gateway.listen();
    vite = await createViteServer({
      configFile: path.join(viewerRoot, 'vite.config.js'), root: viewerRoot,
      server: {
        host: '127.0.0.1', port: 5173, strictPort: true,
        proxy: {
          '/api': { target: gatewayOrigin, changeOrigin: false },
          '/ws': { target: gatewayOrigin.replace(/^http/, 'ws'), ws: true, changeOrigin: false },
        },
      },
    });
    await vite.listen();

    // Browser automation is unavailable locally in some sandboxes, but hosted
    // CI installs an actual Chromium executable. No screenshot is synthesized.
    browser = await chromium.launch({ headless: true });
    evidenceDir = process.env.UNBOUNDVNC_STOCK_SCREENSHOT_DIR
      ? path.resolve(process.env.UNBOUNDVNC_STOCK_SCREENSHOT_DIR)
      : await mkdtemp(path.join(os.tmpdir(), 'unboundvnc-stock-chromium-'));
    await mkdir(evidenceDir, { recursive: true });
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    page = await context.newPage();
    page.on('console', message => browserEvents.push({ type: `console.${message.type()}`, text: message.text() }));
    page.on('pageerror', error => browserEvents.push({ type: 'pageerror', text: error.message }));

    await page.goto('http://127.0.0.1:5173', { waitUntil: 'networkidle' });
    await page.getByText('Local gateway available').waitFor({ timeout: 10_000 });
    await page.locator('#quick-host').fill('127.0.0.1');
    await page.locator('#quick-port').fill(String(rfbPort));
    await page.locator('#quick-form button[type="submit"]').click();
    await page.getByText('Connected · identity unverified').waitFor({ timeout: 15_000 });

    // This is a *browser canvas pixel* produced by noVNC from the real stock
    // TigerVNC RFB framebuffer, not a mocked RFB packet or DOM color.
    const pixel = await page.waitForFunction(expected => {
      const canvas = document.querySelector('#remote-screen canvas');
      if (!canvas || canvas.width < 1 || canvas.height < 1) return null;
      const pixels = canvas.getContext('2d')?.getImageData(
        Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1)?.data;
      if (!pixels) return null;
      const rgb = Array.from(pixels.subarray(0, 3));
      return rgb.every((value, index) => value === expected[index])
        ? { rgb, width: canvas.width, height: canvas.height } : null;
    }, RGB, { timeout: 15_000 });
    const framebuffer = await pixel.jsonValue();
    assert.deepEqual(framebuffer.rgb, RGB);
    assert.equal(framebuffer.width, RFB_WIDTH);
    assert.equal(framebuffer.height, RFB_HEIGHT);
    assert.equal(await page.locator('#session-view').isVisible(), true);
    assert.equal(browserEvents.filter(event => event.type === 'pageerror').length, 0,
      'no uncaught errors during real stock RFB browser render');

    await page.screenshot({ path: path.join(evidenceDir, 'stock-rfb-session.png'), fullPage: true });
    await writeFile(path.join(evidenceDir, 'framebuffer-pixel.json'),
      JSON.stringify({ fixture: 'stock Ubuntu Xtigervnc X11 root', rfbSecurity: 'None (loopback only)',
        expectedRgb: RGB, ...framebuffer, browser: browser.version() }, null, 2));
    await page.locator('#session-disconnect').click();
    assert.equal(await page.locator('#session-view').isVisible(), false, 'disconnect returns to dashboard');
    succeeded = true;
    console.log(JSON.stringify({ outcome: 'PASS', browser: browser.version(), gatewayOrigin,
      rfbPort, framebuffer, screenshot: path.join(evidenceDir, 'stock-rfb-session.png') }));
  } finally {
    if (!succeeded && page && evidenceDir && !page.isClosed()) {
      await page.screenshot({ path: path.join(evidenceDir, 'failure.png'), fullPage: true }).catch(() => {});
    }
    if (context && evidenceDir) {
      await context.tracing.stop({ path: path.join(evidenceDir, 'trace.zip') }).catch(() => {});
      await writeFile(path.join(evidenceDir, 'browser-events.json'), JSON.stringify(browserEvents, null, 2));
      console.log(`Stock RFB browser evidence directory: ${evidenceDir}`);
    }
    await context?.close();
    await browser?.close();
    await vite?.close();
    await gateway?.close();
    await stopTiger(tiger);
    console.log(`Stock TigerVNC process exit=${tiger?.exitCode ?? tiger?.signalCode}; log tail=${JSON.stringify(tigerLog.slice(-700))}`);
  }
}

run().catch(error => { console.error(`Stock RFB Chromium smoke failed: ${error.stack ?? error}`); process.exitCode = 1; });
