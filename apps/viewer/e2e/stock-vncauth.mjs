import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { connect, createServer as createTcpServer } from 'node:net';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import { createGateway } from '../../gateway/src/server.mjs';

const require = createRequire(import.meta.url);
const viewerRoot = fileURLToPath(new URL('../', import.meta.url));
const RFB_WIDTH = 480;
const RFB_HEIGHT = 320;
const RGB = [0x9a, 0x3c, 0x6f];

async function vacantPort() {
  const server = createTcpServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function waitForPort(port, child) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Xtigervnc exited before listening (${child.exitCode})`);
    try {
      await new Promise((resolve, reject) => {
        const socket = connect({ host: '127.0.0.1', port });
        socket.once('connect', () => { socket.destroy(); resolve(); });
        socket.once('error', reject);
        socket.setTimeout(500, () => { socket.destroy(); reject(new Error('timeout')); });
      });
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  throw new Error('Xtigervnc failed to start on loopback');
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
      `RFB listened on non-loopback address in ${file}`);
  }
}

async function temporaryTigerPassword() {
  // Deliberately generate inside the ephemeral test runner. Never echo, commit,
  // record in a Playwright trace, or pass a plaintext password as a CLI arg.
  const password = randomBytes(6).toString('base64url'); // 8 ASCII chars, VNC's limit.
  const dir = await mkdtemp(path.join(os.tmpdir(), 'unboundvnc-browser-auth-'));
  const passwordFile = path.join(dir, 'passwd');
  const encryptor = spawn('tigervncpasswd', ['-f'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let encoded = Buffer.alloc(0);
  encryptor.stdout.on('data', bytes => { encoded = Buffer.concat([encoded, bytes]); });
  encryptor.stderr.resume(); // Do not risk logging secret-handling diagnostics.
  encryptor.stdin.end(`${password}\n`);
  const [status] = await once(encryptor, 'close', { signal: AbortSignal.timeout(10_000) });
  assert.equal(status, 0, 'tigervncpasswd -f failed');
  assert.equal(encoded.length, 8, 'unexpected TigerVNC password file format');
  await writeFile(passwordFile, encoded, { mode: 0o600, flag: 'wx' });
  encoded.fill(0);
  return { password, passwordFile, dir };
}

async function stopTiger(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([new Promise(resolve => child.once('exit', resolve)),
    new Promise(resolve => setTimeout(resolve, 2000))]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function run() {
  if (process.platform !== 'linux') throw new Error('Stock TigerVNC fixture requires Linux');
  const { chromium } = require('playwright');
  let credentials;
  let tiger;
  let gateway;
  let vite;
  let browser;
  let context;
  let page;
  let evidenceDir;
  let wrongPassword;
  const browserEvents = [];
  try {
    credentials = await temporaryTigerPassword();
    const rfbPort = await vacantPort();
    const display = `:${70 + (process.pid % 120)}`;
    tiger = spawn('Xtigervnc', [display, '-geometry', `${RFB_WIDTH}x${RFB_HEIGHT}`,
      '-depth', '24', '-rfbport', String(rfbPort), '-SecurityTypes', 'VncAuth',
      '-PasswordFile', credentials.passwordFile, '-localhost', 'yes',
      '-interface', '127.0.0.1', '-nolisten', 'tcp', '-ac'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
    // Server logs can describe password negotiation. Drain, but never save.
    tiger.stdout.resume();
    tiger.stderr.resume();
    tiger.on('error', () => {});
    await waitForPort(rfbPort, tiger);
    await assertLoopbackRfb(rfbPort);
    const paint = spawnSync('xsetroot', ['-display', display, '-solid', '#9a3c6f'],
      { encoding: 'utf8', timeout: 3000 });
    assert.equal(paint.status, 0, 'xsetroot did not paint test fixture');

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
    evidenceDir = process.env.UNBOUNDVNC_VNCAUTH_SCREENSHOT_DIR
      ? path.resolve(process.env.UNBOUNDVNC_VNCAUTH_SCREENSHOT_DIR)
      : await mkdtemp(path.join(os.tmpdir(), 'unboundvnc-vncauth-chromium-'));
    await mkdir(evidenceDir, { recursive: true });

    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    // Important: NO Playwright tracing. Trace snapshots/input records may
    // contain password values and must never become a CI artifact.
    page = await context.newPage();
    page.on('console', message => browserEvents.push({ type: `console.${message.type()}`, text: message.text() }));
    page.on('pageerror', error => browserEvents.push({ type: 'pageerror', text: error.message }));
    await page.goto('http://127.0.0.1:5173', { waitUntil: 'networkidle' });
    await page.getByText('Local gateway available').waitFor({ timeout: 10_000 });

    async function quickConnect() {
      await page.locator('#quick-host').fill('127.0.0.1');
      await page.locator('#quick-port').fill(String(rfbPort));
      await page.locator('#quick-form button[type="submit"]').click();
      await page.getByRole('dialog', { name: 'Credentials required' }).waitFor({ timeout: 12_000 });
      assert.doesNotMatch(await page.locator('#session-status').textContent(), /Connected/,
        'VncAuth requires credentials before the remote session connects');
    }

    // Cancellation is not submission. A previously typed VNC password must not
    // linger in a hidden form or reappear on the next credential prompt. Never
    // screenshot or trace a filled password field, including on test failure.
    const blankPasswordControl = () => page.evaluate(() =>
      document.querySelector('#credentials-form input[name="password"]').value.length === 0);
    await quickConnect();
    await page.locator('#credentials-form input[name="password"]').fill(credentials.password);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#session-view').isVisible(), false,
      'Escape from the credential modal must cancel the pending session');
    assert.ok(await blankPasswordControl(), 'Escape cancel must erase the unsubmitted password from the DOM');

    await quickConnect();
    assert.ok(await blankPasswordControl(), 'a fresh VncAuth prompt must never show an abandoned password');
    await page.locator('#credentials-form input[name="password"]').fill(credentials.password);
    await page.locator('#credentials-cancel').click();
    assert.equal(await page.locator('#session-view').isVisible(), false,
      'explicit credential Disconnect must cancel the pending session');
    assert.ok(await blankPasswordControl(), 'credential Disconnect must erase the unsubmitted password from the DOM');

    // Correct password path: real noVNC VncAuth, then independent stock RFB pixels.
    await quickConnect();
    assert.ok(await blankPasswordControl(), 'credential input starts empty after both cancellation paths');
    await page.screenshot({ path: path.join(evidenceDir, 'preauth-prompt-blank.png') });
    await page.locator('#credentials-form input[name="password"]').fill(credentials.password);
    await page.locator('#credentials-form button[type="submit"]').click();
    await page.getByText('Connected · identity unverified').waitFor({ timeout: 15_000 });
    const handle = await page.waitForFunction(expected => {
      const canvas = document.querySelector('#remote-screen canvas');
      if (!canvas || canvas.width < 1 || canvas.height < 1) return null;
      const pixels = canvas.getContext('2d')?.getImageData(
        Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1)?.data;
      if (!pixels) return null;
      const rgb = Array.from(pixels.subarray(0, 3));
      return rgb.every((value, index) => value === expected[index])
        ? { rgb, width: canvas.width, height: canvas.height } : null;
    }, RGB, { timeout: 15_000 });
    const framebuffer = await handle.jsonValue();
    assert.deepEqual(framebuffer.rgb, RGB);
    assert.deepEqual([framebuffer.width, framebuffer.height], [RFB_WIDTH, RFB_HEIGHT]);
    await page.locator('#toasts .toast').waitFor({ state: 'hidden', timeout: 7_000 });
    await page.screenshot({ path: path.join(evidenceDir, 'authenticated-session.png') });
    await page.locator('#session-disconnect').click();
    assert.equal(await page.locator('#session-view').isVisible(), false);

    // Wrong password path: failure occurs before any authenticated framebuffer.
    await quickConnect();
    wrongPassword = (credentials.password[0] === 'A' ? 'B' : 'A') + credentials.password.slice(1);
    await page.locator('#credentials-form input[name="password"]').fill(wrongPassword);
    await page.locator('#credentials-form button[type="submit"]').click();
    await page.locator('#connection-error-message').waitFor({ timeout: 15_000 });
    const failureMessage = await page.locator('#connection-error-message').textContent();
    assert.match(failureMessage, /VNC authentication failed/i);
    assert.equal(await page.locator('#session-view').isVisible(), false,
      'wrong password never yields a connected session');
    assert.equal(await page.locator('#credentials-form input[name="password"]').inputValue(), '',
      'authentication form resets password value before sending credentials');
    const storedSecret = await page.evaluate(secret =>
      Object.values(localStorage).some(value => value.includes(secret)), credentials.password);
    assert.equal(storedSecret, false, 'VNC password must not be in browser localStorage');
    assert.equal(browserEvents.filter(event => event.type === 'pageerror').length, 0);
    assert.equal(JSON.stringify(browserEvents).includes(credentials.password), false,
      'browser event log must not reveal the ephemeral VNC secret');
    assert.equal(JSON.stringify(browserEvents).includes(wrongPassword), false,
      'browser event log must not reveal the invalid credential either');
    // The Quick Connect form may have scrolled before the failed session;
    // capture the persistent failure banner in the actual viewport, unobscured
    // by temporary disconnect/authentication notifications.
    await page.locator('#connection-error').scrollIntoViewIfNeeded();
    await page.waitForFunction(() => !document.querySelector('#toasts .toast'),
      null, { timeout: 7_000 });
    await page.screenshot({ path: path.join(evidenceDir, 'rejected-password.png') });
    await writeFile(path.join(evidenceDir, 'authentication-result.json'), JSON.stringify({
      fixture: 'independent stock Ubuntu Xtigervnc', securityType: 'VncAuth (loopback only)',
      correctPassword: 'authenticated + framebuffer rendered',
      wrongPassword: 'rejected before connected session',
      storageContainsPassword: false, pixel: framebuffer, browser: browser.version(),
    }, null, 2));

    // Real same-origin document navigation fires pagehide. Verify the OLD
    // document discarded an unsubmitted credential before Chromium leaves it
    // (which may otherwise retain a DOM snapshot in the back/forward cache).
    // The marker tests navigation cleanup, not browser password-manager behavior.
    // Only a Boolean-like marker crosses documents via window.name; never the
    // password, its length, a filled-input screenshot, or a Playwright trace.
    await quickConnect();
    await page.locator('#credentials-form input[name="password"]').fill(credentials.password);
    await page.evaluate(() => {
      window.name = 'wave10-pagehide-unobserved';
      window.addEventListener('pagehide', () => {
        const hasSecret = Boolean(document.querySelector('#credentials-form input[name="password"]')?.value);
        window.name = hasSecret ? 'wave10-pagehide-retained' : 'wave10-pagehide-erased';
      }, { once: true });
    });
    await page.goto('http://127.0.0.1:5173/?wave10-pagehide=1', { waitUntil: 'domcontentloaded' });
    const pagehideResult = await page.evaluate(() => {
      const result = window.name;
      window.name = '';
      return result;
    });
    assert.equal(pagehideResult, 'wave10-pagehide-erased',
      'real pagehide navigation must clear an unsubmitted VNC password in the old document');
    await writeFile(path.join(evidenceDir, 'credential-pagehide-result.json'),
      JSON.stringify({ navigation: 'actual same-origin document load',
        oldDocumentCredentialCleared: true }, null, 2));
    console.log(JSON.stringify({ outcome: 'PASS', browser: browser.version(),
      correctPassword: 'authenticated framebuffer', wrongPassword: 'rejected pre-session',
      framebuffer, evidenceDir }));
  } catch (error) {
    // Only the error message is printed; redact either credential if a future
    // Playwright/library error unexpectedly includes an input value.
    if (credentials?.password) error.message = String(error.message).replaceAll(credentials.password, '[REDACTED]');
    if (wrongPassword) error.message = String(error.message).replaceAll(wrongPassword, '[REDACTED]');
    throw error;
  } finally {
    // Do not take a general failure screenshot or trace: an unexpected failure
    // could leave a still-filled password control visible/in the DOM snapshot.
    await context?.close();
    await browser?.close();
    await vite?.close();
    await gateway?.close();
    await stopTiger(tiger);
    if (credentials) await rm(credentials.dir, { recursive: true, force: true });
    if (evidenceDir) {
      // Only redact-safe, locally collected browser events are retained.
      const serialized = JSON.stringify(browserEvents);
      if (!serialized.includes(credentials?.password ?? 'NEVER_MATCH') &&
          !serialized.includes(wrongPassword ?? 'NEVER_MATCH')) {
        await writeFile(path.join(evidenceDir, 'browser-events.json'), JSON.stringify(browserEvents, null, 2));
      }
      console.log(`VncAuth browser evidence directory: ${evidenceDir}`);
    }
  }
}

run().catch(error => { console.error(`VncAuth browser smoke failed: ${error.message}`); process.exitCode = 1; });
