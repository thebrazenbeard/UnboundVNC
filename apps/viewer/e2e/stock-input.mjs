import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { connect, createServer as createTcpServer } from 'node:net';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import { createGateway } from '../../gateway/src/server.mjs';

const require = createRequire(import.meta.url);
const viewerRoot = fileURLToPath(new URL('../', import.meta.url));
const WIDTH = 480;
const HEIGHT = 320;
const CENTER = { x: WIDTH / 2, y: HEIGHT / 2 };
const WITNESS_NAME = 'unboundvnc-test-owned-x11-witness';

async function port() {
  const server = createTcpServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const selected = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return selected;
}

async function until(check, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { const result = await check(); if (result) return result; }
    catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for fixture: ${last?.message ?? 'condition unsatisfied'}`);
}

async function assertLoopback(portNumber) {
  const hex = portNumber.toString(16).toUpperCase().padStart(4, '0');
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    const rows = (await readFile(file, 'utf8')).split('\n').slice(1)
      .map(line => line.trim().split(/\s+/))
      .filter(fields => fields[1]?.endsWith(`:${hex}`) && fields[3] === '0A');
    if (file.endsWith('tcp')) assert.ok(rows.length > 0, 'missing RFB IPv4 loopback listener');
    assert.ok(rows.every(fields => fields[1] === (file.endsWith('tcp')
      ? `0100007F:${hex}` : `00000000000000000000000001000000:${hex}`)),
    `RFB has a non-loopback listener in ${file}`);
  }
}

function xcommand(binary, args, display) {
  const command = spawnSync(binary, args, { encoding: 'utf8', timeout: 3000,
    env: { ...process.env, DISPLAY: display } });
  assert.equal(command.status, 0, `${binary} ${args[0]} failed: ${command.stderr ?? command.error?.message}`);
  return command.stdout.trim();
}

function setDisposableClipboard(display, value) {
  const result = spawnSync('xclip', ['-selection', 'clipboard', '-in'], {
    input: value, encoding: 'utf8', timeout: 3000,
    env: { ...process.env, DISPLAY: display },
  });
  assert.equal(result.status, 0, 'test-owned X11 clipboard fixture could not accept text');
}

function clipboardMatches(display, expected) {
  const result = spawnSync('xclip', ['-selection', 'clipboard', '-out'], {
    encoding: 'utf8', timeout: 3000, env: { ...process.env, DISPLAY: display },
  });
  // Compare in memory only: never log or upload clipboard contents.
  return result.status === 0 && result.stdout === expected;
}

function inputEvents(output) {
  return output.split(/\n\s*\n/).filter(block => /^(?:ButtonPress|KeyPress) event,/.test(block))
    .map(block => ({
      type: block.startsWith('ButtonPress') ? 'button' : 'key',
      button: Number(block.match(/\bbutton (\d+)\b/)?.[1] ?? 0),
      keysym: block.match(/\bkeysym 0x[0-9a-fA-F]+, ([^)]*)\)/)?.[1] ?? null,
      root: (block.match(/\broot:\((\d+),(\d+)\)/)?.slice(1).map(Number)) ?? null,
    }));
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    new Promise(resolve => setTimeout(resolve, 2000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function run() {
  if (process.platform !== 'linux') throw new Error('Isolated Xtigervnc X11 input fixture requires Linux');
  const { chromium } = require('playwright');
  let tiger, witness, gateway, vite, browser, context, page;
  let tigerLog = '', witnessLog = '', evidenceDir, success = false;
  const browserEvents = [];
  try {
    // Xtigervnc is both the test-owned X11 display and the stock RFB server.
    // No real workstation X display, keyboard, or mouse is involved.
    const rfbPort = await port();
    const display = `:${70 + (process.pid % 120)}`;
    tiger = spawn('Xtigervnc', [display, '-geometry', `${WIDTH}x${HEIGHT}`,
      '-depth', '24', '-rfbport', String(rfbPort), '-SecurityTypes', 'None',
      '-localhost', 'yes', '-interface', '127.0.0.1', '-nolisten', 'tcp', '-ac'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
    tiger.on('error', error => { tigerLog += error.message; });
    for (const stream of [tiger.stdout, tiger.stderr]) {
      stream.on('data', bytes => { tigerLog = (tigerLog + bytes.toString()).slice(-8000); });
    }
    await until(async () => {
      if (tiger.exitCode !== null) throw new Error(`Xtigervnc exited: ${tigerLog}`);
      return await new Promise(resolve => {
        const socket = connect({ host: '127.0.0.1', port: rfbPort });
        socket.once('connect', () => { socket.destroy(); resolve(true); });
        socket.once('error', () => resolve(false));
        socket.setTimeout(300, () => { socket.destroy(); resolve(false); });
      });
    });
    await assertLoopback(rfbPort);
    xcommand('xsetroot', ['-solid', '#245d43'], display);

    // xev's C stdio is otherwise block-buffered when piped in CI.
    witness = spawn('stdbuf', ['-oL', '-eL', 'xev', '-name', WITNESS_NAME,
      '-geometry', '240x160+120+80', '-event', 'keyboard', '-event', 'mouse'],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DISPLAY: display } });
    witness.on('error', error => { witnessLog += error.message; });
    witness.stdout.on('data', bytes => { witnessLog = (witnessLog + bytes.toString()).slice(-200_000); });
    witness.stderr.on('data', bytes => { witnessLog = (witnessLog + bytes.toString()).slice(-200_000); });
    const windowId = await until(() => {
      const search = spawnSync('xdotool', ['search', '--onlyvisible', '--name', `^${WITNESS_NAME}$`],
        { encoding: 'utf8', timeout: 2000, env: { ...process.env, DISPLAY: display } });
      return search.status === 0 ? search.stdout.trim().split('\n')[0] : false;
    });
    xcommand('xdotool', ['windowfocus', '--sync', windowId], display);
    assert.equal(xcommand('xdotool', ['getwindowfocus'], display), windowId,
      'X11 input focus must be on the disposable witness window');

    gateway = createGateway({ port: 0, allowedPorts: [rfbPort] });
    const gatewayOrigin = await gateway.listen();
    vite = await createViteServer({
      configFile: path.join(viewerRoot, 'vite.config.js'), root: viewerRoot,
      server: { host: '127.0.0.1', port: 5173, strictPort: true,
        proxy: { '/api': { target: gatewayOrigin, changeOrigin: false },
          '/ws': { target: gatewayOrigin.replace(/^http/, 'ws'), ws: true, changeOrigin: false } } },
    });
    await vite.listen();
    browser = await chromium.launch({ headless: true });
    evidenceDir = process.env.UNBOUNDVNC_INPUT_SCREENSHOT_DIR
      ? path.resolve(process.env.UNBOUNDVNC_INPUT_SCREENSHOT_DIR)
      : await mkdtemp(path.join(os.tmpdir(), 'unboundvnc-input-'));
    await mkdir(evidenceDir, { recursive: true });
    context = await browser.newContext({ viewport: { width: 1280, height: 900 },
      permissions: ['clipboard-read', 'clipboard-write'] });
    page = await context.newPage();
    // Deliberately omit console/error bodies: clipboard text may appear in an
    // unexpected browser error, and the uploaded evidence must stay content-free.
    page.on('console', message => browserEvents.push({ type: `console.${message.type()}` }));
    page.on('pageerror', error => browserEvents.push({ type: 'pageerror', name: error.name }));
    await page.goto('http://127.0.0.1:5173', { waitUntil: 'networkidle' });
    await page.getByText('Local gateway available').waitFor({ timeout: 10_000 });
    await page.locator('#quick-host').fill('127.0.0.1');
    await page.locator('#quick-port').fill(String(rfbPort));
    await page.locator('#quick-form button[type="submit"]').click();
    await page.getByText('Connected · identity unverified').waitFor({ timeout: 15_000 });
    assert.equal(await page.locator('#session-viewonly').getAttribute('aria-pressed'), 'false');

    // Canvas mapping comes from the actual rendered browser box. Assert the
    // full remote viewport is visible before calculating a physical input point.
    const canvas = page.locator('#remote-screen canvas');
    await until(async () => {
      const dimensions = await canvas.evaluate(node => ({ width: node.width, height: node.height }));
      return dimensions.width === WIDTH && dimensions.height === HEIGHT;
    });
    const box = await canvas.boundingBox();
    assert.ok(box && box.width > 0 && box.height > 0, 'noVNC canvas must be displayed');
    const clickAt = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

    // Negative control: UI view-only must suppress real RFB input. This is
    // deliberately not treated as a host-side access-control boundary.
    await page.locator('#session-viewonly').click();
    assert.equal(await page.locator('#session-viewonly').getAttribute('aria-pressed'), 'true');
    const before = inputEvents(witnessLog);
    await page.mouse.click(clickAt.x, clickAt.y);
    await page.keyboard.press('v');
    await new Promise(resolve => setTimeout(resolve, 750));
    assert.deepEqual(inputEvents(witnessLog), before,
      'view-only click and keyboard input unexpectedly reached the independent X11 witness');

    // Positive control: reenable input with the visible UI, then send a real
    // Chromium pointer click and key through noVNC, gateway, and stock RFB.
    await page.locator('#session-viewonly').click();
    assert.equal(await page.locator('#session-viewonly').getAttribute('aria-pressed'), 'false');
    await page.mouse.click(clickAt.x, clickAt.y);
    await page.keyboard.press('k');
    const delivered = await until(() => {
      const events = inputEvents(witnessLog).slice(before.length);
      const button = events.find(event => event.type === 'button' && event.button === 1
        && event.root && Math.abs(event.root[0] - CENTER.x) <= 3
        && Math.abs(event.root[1] - CENTER.y) <= 3);
      const key = events.find(event => event.type === 'key' && event.keysym === 'k');
      return button && key ? { button, key } : false;
    }, 5000);

    // User-visible clipboard is absent in the baseline viewer. This browser
    // journey must prove both RFB CutText directions against independent X11,
    // not merely click a control or dispatch a synthetic noVNC event.
    const clipboardOpen = page.locator('#session-clipboard-open');
    assert.equal(await clipboardOpen.count(), 1,
      'connected browser viewer needs a real user-accessible clipboard control');
    assert.equal(await page.getByRole('button', { name: 'Text clipboard' }).count(), 1,
      'clipboard toolbar control needs an accessible name even at mobile widths');
    const browserText = `local-${randomUUID()}`;
    const remoteText = `remote-${randomUUID()}`;
    await page.locator('#session-viewonly').click();
    assert.equal(await clipboardOpen.isDisabled(), true,
      'viewer view-only must block clipboard exchange');
    await page.locator('#session-viewonly').click();
    await clipboardOpen.click();
    await page.getByRole('dialog', { name: 'Text clipboard' }).waitFor();
    await page.locator('#session-clipboard-text').fill(browserText);
    await page.locator('#session-clipboard-send').click();
    await until(() => clipboardMatches(display, browserText), 7000);
    assert.equal((await page.locator('#session-clipboard-text').inputValue()).length === 0, true,
      'sent clipboard text must not remain in the viewer textarea');
    await page.locator('#session-clipboard-close').click();

    setDisposableClipboard(display, remoteText);
    await clipboardOpen.click();
    await until(async () => !await page.locator('#session-clipboard-copy').isDisabled(), 7000);
    await page.locator('#session-clipboard-copy').click();
    assert.equal(await page.evaluate(async () => (await navigator.clipboard.readText()).length > 0), true,
      'browser clipboard should contain copied remote text');
    const actualMatches = await page.evaluate(async expected =>
      (await navigator.clipboard.readText()) === expected, remoteText);
    assert.equal(actualMatches, true,
      'stock Xtigervnc clipboard event must reach actual browser clipboard');
    await page.locator('#session-clipboard-close').click();
    assert.equal(JSON.stringify(browserEvents).includes(browserText) ||
      JSON.stringify(browserEvents).includes(remoteText), false,
    'browser event evidence must never contain clipboard values');
    await page.setViewportSize({ width: 390, height: 844 });
    await clipboardOpen.click();
    await page.screenshot({ path: path.join(evidenceDir, 'clipboard-dialog-mobile.png') });
    await page.locator('#session-clipboard-close').click();
    await page.setViewportSize({ width: 1280, height: 900 });
    assert.equal(browserEvents.filter(event => event.type === 'pageerror').length, 0);
    await page.waitForFunction(() => document.querySelectorAll('#toasts .toast').length === 0,
      null, { timeout: 7000 });
    await page.screenshot({ path: path.join(evidenceDir, 'input-witness-session.png') });
    await writeFile(path.join(evidenceDir, 'x11-input-result.json'), JSON.stringify({
      outcome: 'PASS', fixture: 'test-owned Xtigervnc X11 window observed by stock xev',
      security: 'RFB None; IPv4 loopback only', browser: browser.version(),
      remoteSize: { width: WIDTH, height: HEIGHT }, expectedClickRoot: CENTER,
      viewOnlySuppressed: true, delivered,
      clipboard: { viewOnlyBlocked: true, browserToX11: true, x11ToBrowser: true,
        valuesPersistedInEvidence: false },
      evidenceClass: 'real Chromium→noVNC→UnboundVNC gateway→stock Xtigervnc→X11 event',
    }, null, 2));
    await page.locator('#session-disconnect').click();
    assert.equal((await page.locator('#session-clipboard-text').inputValue()).length === 0, true,
      'disconnect must clear clipboard textarea');
    assert.equal(await page.locator('#session-clipboard-copy').isDisabled(), true,
      'disconnect must clear pending remote clipboard text');
    success = true;
    console.log(`PASS independent X11 button/key events ${JSON.stringify(delivered)} browser=${browser.version()}`);
  } finally {
    if (!success && page && evidenceDir && !page.isClosed()) {
      // A failed clipboard assertion must never upload typed clipboard text.
      await page.locator('#session-clipboard-text').evaluate(node => { node.value = ''; }).catch(() => {});
      await page.screenshot({ path: path.join(evidenceDir, 'failure.png') }).catch(() => {});
      await writeFile(path.join(evidenceDir, 'failure-witness-events.json'),
        JSON.stringify(inputEvents(witnessLog), null, 2)).catch(() => {});
    }
    if (evidenceDir) await writeFile(path.join(evidenceDir, 'browser-events.json'),
      JSON.stringify(browserEvents, null, 2));
    await context?.close();
    await browser?.close();
    await vite?.close();
    await gateway?.close();
    await stop(witness);
    await stop(tiger);
    console.log(`Stock input fixture teardown: tiger=${tiger?.exitCode ?? tiger?.signalCode}, witness=${witness?.exitCode ?? witness?.signalCode}; tiger log tail=${JSON.stringify(tigerLog.slice(-400))}`);
  }
}

run().catch(error => { console.error(`Stock input Chromium qualification FAILED: ${error.stack ?? error}`); process.exitCode = 1; });
