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
const RECONNECTED_RGB = [0xab, 0x45, 0x67];

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

async function waitForMetrics(page, predicate, label) {
  const handle = await page.waitForFunction(check => {
    const canvas = document.querySelector('#remote-screen canvas');
    const stage = document.querySelector('#session-stage');
    if (!canvas || !stage) return false;
    const rect = canvas.getBoundingClientRect();
    const bounds = stage.getBoundingClientRect();
    const m = { width: canvas.width, height: canvas.height,
      renderedWidth: rect.width, renderedHeight: rect.height,
      stageWidth: bounds.width, stageHeight: bounds.height };
    const good = check === 'desktop-fit'
      ? m.width === 480 && m.height === 320 && m.renderedWidth > 480 && m.renderedHeight > 320
      : check === 'unscaled'
        ? Math.abs(m.renderedWidth - 480) < 2 && Math.abs(m.renderedHeight - 320) < 2
        : check === 'mobile-fit'
          ? m.width === 480 && m.height === 320 && m.renderedWidth <= 391
            && m.renderedHeight <= m.stageHeight + 1 && m.renderedWidth < 480
          : check === 'reconnected'
            ? m.width === 640 && m.height === 360 && m.renderedWidth <= m.stageWidth + 1
              && m.renderedHeight <= m.stageHeight + 1
            : false;
    return good ? m : false;
  }, predicate, { timeout: 10_000 });
  const value = await handle.jsonValue();
  assert.ok(value, `${label} canvas dimensions missing`);
  return value;
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
    const sessionRequests = [];
    page.on('request', request => {
      if (new URL(request.url()).pathname === '/api/sessions') sessionRequests.push(request.url());
    });

    await page.goto('http://127.0.0.1:5173', { waitUntil: 'networkidle' });
    await page.getByText('Local gateway available').waitFor({ timeout: 10_000 });
    // This is a real Chromium interaction with the actual gateway online.
    // A remote IP must be rejected in the viewer before an RFB ticket request,
    // while the following gateway-local stock RFB connection still succeeds.
    await page.locator('#quick-host').fill('192.0.2.77');
    await page.locator('#quick-form button[type="submit"]').click();
    await page.locator('#connection-error-message').waitFor({ timeout: 5000 });
    assert.match(await page.locator('#connection-error-message').textContent(),
      /computer running the gateway/i);
    assert.equal(sessionRequests.length, 0, 'remote address caused a gateway ticket request');
    assert.equal(await page.locator('#session-view').isVisible(), false,
      'rejected remote route should not open a session');
    await page.locator('#connection-error-dismiss').click();
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

    // Genuine CSS canvas geometry, not just raw RFB framebuffer dimensions.
    const desktopFit = await waitForMetrics(page, 'desktop-fit', 'initial fit');
    await page.locator('#session-scale').click();
    assert.equal(await page.locator('#session-scale').getAttribute('aria-pressed'), 'false');
    const unscaled = await waitForMetrics(page, 'unscaled', '1:1 scaling');
    await page.locator('#session-scale').click();
    assert.equal(await page.locator('#session-scale').getAttribute('aria-pressed'), 'true');
    await waitForMetrics(page, 'desktop-fit', 'restored fit');
    const mobileToolbarNames = [
      { id: 'session-viewonly', name: 'View only' },
      { id: 'session-fullscreen', name: 'Fullscreen' },
      { id: 'session-disconnect', name: 'Disconnect' },
    ];
    const desktopToolbar = await Promise.all(mobileToolbarNames.map(async control => ({
      ...control, accessibilitySnapshot: await page.locator(`#${control.id}`).ariaSnapshot(),
    })));

    // At mobile widths the text span inside toolbar buttons is display:none.
    // A nameless Fit screen button is a real accessibility/resize defect.
    await page.setViewportSize({ width: 390, height: 844 });
    const mobileFit = await waitForMetrics(page, 'mobile-fit', 'responsive fit');
    assert.equal(await page.getByRole('button', { name: 'Fit screen' }).isVisible(), true,
      'Fit screen must retain an accessible button name when text is hidden on mobile');
    const mobileToolbar = await Promise.all(mobileToolbarNames.map(async control => ({
      ...control, accessibilitySnapshot: await page.locator(`#${control.id}`).ariaSnapshot(),
      stableAccessibleName: await page.getByRole('button', { name: control.name, exact: true }).count() === 1,
    })));
    await writeFile(path.join(evidenceDir, 'mobile-toolbar-accessibility.json'),
      JSON.stringify({ desktopToolbar, mobileToolbar }, null, 2));
    assert.deepEqual(mobileToolbar.map(control => control.stableAccessibleName), [true, true, true],
      'View only, Fullscreen and Disconnect must retain their exact desktop accessible names on mobile');
    await page.getByRole('button', { name: 'View only', exact: true }).click();
    assert.equal(await page.locator('#session-viewonly').getAttribute('aria-pressed'), 'true',
      'mobile accessible-name fix must preserve View only activation');
    await page.getByRole('button', { name: 'View only', exact: true }).click();
    assert.equal(await page.locator('#session-viewonly').getAttribute('aria-pressed'), 'false',
      'scaling and viewport resize must not switch input into view-only');

    // A fixed session view must be captured at viewport size; fullPage would
    // stitch dashboard content outside the visible remote-session viewport.
    await page.waitForFunction(() => document.querySelectorAll('#toasts .toast').length === 0,
      null, { timeout: 7_000 });
    await page.screenshot({ path: path.join(evidenceDir, 'stock-rfb-session.png') });
    await writeFile(path.join(evidenceDir, 'framebuffer-pixel.json'),
      JSON.stringify({ fixture: 'stock Ubuntu Xtigervnc X11 root', rfbSecurity: 'None (loopback only)',
        expectedRgb: RGB, ...framebuffer, browser: browser.version() }, null, 2));

    // A deliberate local View only choice must survive the *same endpoint's*
    // Retry after an unexpected remote close. It must not silently switch to
    // sending pointer/keyboard input because a new noVNC instance was made.
    await page.getByRole('button', { name: 'View only', exact: true }).click();
    assert.equal(await page.locator('#session-viewonly').getAttribute('aria-pressed'), 'true');

    // An abrupt server disappearance should restore the dashboard's retry UI.
    // Reconnect is a new session and never reuses a VNC password.
    await stopTiger(tiger);
    await page.locator('#connection-error').waitFor({ state: 'visible', timeout: 15_000 });
    assert.match(await page.locator('#connection-error-message').textContent(), /Remote connection ended unexpectedly/);
    assert.equal(await page.locator('#session-view').isVisible(), false);

    const secondDisplay = `:${191 + (process.pid % 60)}`;
    tiger = spawn('Xtigervnc', [secondDisplay, '-geometry', '640x360', '-depth', '24',
      '-rfbport', String(rfbPort), '-SecurityTypes', 'None', '-localhost', 'yes',
      '-interface', '127.0.0.1', '-nolisten', 'tcp', '-ac'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
    tiger.on('error', error => { tigerLog += `\n${error.message}`; });
    for (const stream of [tiger.stdout, tiger.stderr]) {
      stream.on('data', bytes => { tigerLog = (tigerLog + bytes.toString()).slice(-8_000); });
    }
    await waitForPort(rfbPort, tiger, () => tigerLog);
    await assertLoopbackRfb(rfbPort);
    const secondPaint = spawnSync('xsetroot', ['-display', secondDisplay, '-solid', '#ab4567'],
      { encoding: 'utf8', timeout: 3000 });
    assert.equal(secondPaint.status, 0, `replacement X11 screen paint failed: ${secondPaint.stderr}`);
    await page.locator('#connection-retry').click();
    await page.getByText('Connected · identity unverified').waitFor({ timeout: 15_000 });
    const mobileReconnected = await waitForMetrics(page, 'reconnected', 'retried 640x360');
    const secondPixel = await page.waitForFunction(expected => {
      const canvas = document.querySelector('#remote-screen canvas');
      if (!canvas || canvas.width !== 640 || canvas.height !== 360) return false;
      const pixel = canvas.getContext('2d')?.getImageData(320, 180, 1, 1)?.data;
      if (!pixel) return false;
      return Array.from(pixel.subarray(0, 3)).every((value, i) => value === expected[i]);
    }, RECONNECTED_RGB, { timeout: 15_000 });
    assert.ok(await secondPixel.jsonValue(), 'replacement independent framebuffer color missing');
    assert.equal(await page.locator('#session-viewonly').getAttribute('aria-pressed'), 'true',
      'Retry of the same endpoint must preserve the previous View only preference');
    assert.equal(await page.locator('#session-scale').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#credentials-dialog').isVisible(), false);
    assert.equal(await page.evaluate(() => /password|credentials|token/i.test(JSON.stringify(localStorage))), false);
    await page.waitForFunction(() => document.querySelectorAll('#toasts .toast').length === 0,
      null, { timeout: 7_000 });
    await page.screenshot({ path: path.join(evidenceDir, 'stock-rfb-reconnected-mobile.png') });
    await writeFile(path.join(evidenceDir, 'resize-reconnect-result.json'), JSON.stringify({
      outcome: 'PASS', browser: browser.version(), desktopFit, unscaled, mobileFit,
      mobileReconnected, originalScreen: { width: 480, height: 320, rgb: RGB },
      replacementScreen: { width: 640, height: 360, rgb: RECONNECTED_RGB },
      unexpectedDisconnectBanner: true, retryConnected: true,
      noCredentialLikeBrowserStorage: true, viewOnlyPreserved: true,
    }, null, 2));
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
    assert.equal(await page.locator('#session-view').isVisible(), false, 'disconnect returns to dashboard');
    assert.equal(await page.locator('#connection-error').isVisible(), false,
      'explicit user Disconnect must not be misclassified as remote session failure');
    // Starting a fresh connection intentionally differs from pressing Retry.
    await page.locator('#quick-form button[type="submit"]').click();
    await page.getByText('Connected · identity unverified').waitFor({ timeout: 15_000 });
    assert.equal(await page.locator('#session-viewonly').getAttribute('aria-pressed'), 'false',
      'a new connection should retain its documented default input behavior');
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();

    // Two saved profiles use the same test-owned stock RFB endpoint, but are
    // distinct directory entries. One session at a time; View only is not a
    // persistent device preference and must not leak into the next profile.
    for (const name of ['Stock Alpha', 'Stock Beta']) {
      // At 390px the sidebar nav is hidden; the directory Add action remains.
      await page.locator('#list-add').click();
      await page.locator('#device-form input[name="name"]').fill(name);
      await page.locator('#device-form input[name="host"]').fill('127.0.0.1');
      await page.locator('#device-form input[name="port"]').fill(String(rfbPort));
      await page.locator('#device-form button[type="submit"]').click();
    }
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(await page.locator('.device-card').count(), 2,
      'saved stock connection profiles must survive a genuine Chromium reload');
    await page.locator('.device-card').filter({ hasText: 'Stock Alpha' })
      .locator('[data-action="connect"]').click();
    await page.getByText('Connected · identity unverified').waitFor({ timeout: 15_000 });
    assert.equal(await page.locator('#session-name').textContent(), 'Stock Alpha');
    assert.equal(await page.locator('#remote-screen canvas').count(), 1);
    await page.getByRole('button', { name: 'View only', exact: true }).click();
    assert.equal(await page.locator('#session-viewonly').getAttribute('aria-pressed'), 'true');
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
    assert.equal(await page.locator('#session-view').isVisible(), false);
    await page.locator('.device-card').filter({ hasText: 'Stock Beta' })
      .locator('[data-action="connect"]').click();
    await page.getByText('Connected · identity unverified').waitFor({ timeout: 15_000 });
    assert.equal(await page.locator('#session-name').textContent(), 'Stock Beta');
    assert.equal(await page.locator('#remote-screen canvas').count(), 1,
      'switching saved profiles must create one active remote canvas, not stack sessions');
    assert.equal(await page.locator('#session-viewonly').getAttribute('aria-pressed'), 'false',
      'a previous saved profile View only choice must not leak into a different profile');
    await page.waitForFunction(() => document.querySelectorAll('#toasts .toast').length === 0,
      null, { timeout: 7_000 });
    await page.screenshot({ path: path.join(evidenceDir, 'stock-rfb-saved-profile-sequential.png') });
    await writeFile(path.join(evidenceDir, 'saved-profile-session-result.json'), JSON.stringify({
      profilesSurvivedReload: 2, firstProfile: 'Stock Alpha', secondProfile: 'Stock Beta',
      sequentialActiveCanvas: 1, viewOnlyLeakedToSecondProfile: false,
    }, null, 2));
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
    succeeded = true;
    console.log(JSON.stringify({ outcome: 'PASS', browser: browser.version(), gatewayOrigin,
      rfbPort, framebuffer, desktopFit, mobileFit, mobileReconnected,
      screenshot: path.join(evidenceDir, 'stock-rfb-reconnected-mobile.png') }));
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
