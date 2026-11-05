// Electron desktop entry: the app owns its loopback gateway for one window lifetime.
const { app, BrowserWindow, session } = require('electron');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { isTrustedResource, isTrustedNavigation } = require('./resource-policy.cjs');

let window;
let local;
let stopping = false;

if (process.env.UNBOUNDVNC_DESKTOP_CI_SMOKE === '1') {
  if (process.env.GITHUB_ACTIONS !== 'true' ||
      process.env.RUNNER_ENVIRONMENT !== 'github-hosted' ||
      process.env.RUNNER_OS !== 'Windows' || !process.env.RUNNER_TEMP) {
    throw new Error('CI smoke and screenshots are forbidden outside hosted Windows Actions');
  }
  const { mkdirSync } = require('node:fs');
  const isolatedProfile = join(process.env.RUNNER_TEMP, 'unboundvnc-viewer-ci-empty-profile');
  mkdirSync(isolatedProfile);
  app.setPath('userData', isolatedProfile);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (window) { window.restore(); window.focus(); } });
  app.whenReady().then(async () => {
    try {
      const moduleAt = name => import(pathToFileURL(join(__dirname, name)).href);
      const [{ startLocalViewer }, { createGateway }] = await Promise.all([
        moduleAt('local-server.mjs'), moduleAt('runtime/gateway/server.mjs'),
      ]);
      const isHostedSmoke = process.env.UNBOUNDVNC_DESKTOP_CI_SMOKE === '1' &&
        process.env.GITHUB_ACTIONS === 'true' &&
        process.env.RUNNER_ENVIRONMENT === 'github-hosted' &&
        process.env.RUNNER_OS === 'Windows' && Boolean(process.env.RUNNER_TEMP);
      const fixturePort = isHostedSmoke ? Number(process.env.UNBOUNDVNC_CI_FIXTURE_PORT) : null;
      if (isHostedSmoke && (!Number.isInteger(fixturePort) || fixturePort < 1 || fixturePort > 65535)) {
        throw new Error('Hosted desktop smoke requires a valid synthetic fixture port.');
      }
      local = await startLocalViewer({
        staticRoot: join(__dirname, 'runtime/viewer'), createGateway,
        allowedPorts: isHostedSmoke ? [5900, 5901, fixturePort] : [5900, 5901],
      });
      const trustedOrigin = new URL(local.url).origin;
      session.defaultSession.setPermissionRequestHandler((_wc, _permission, done) => done(false));
      session.defaultSession.webRequest.onBeforeRequest((details, done) => {
        done({ cancel: !isTrustedResource(details.url, trustedOrigin) });
      });
      window = new BrowserWindow({
        title: 'UnboundVNC Viewer — Preview', width: 1180, height: 800,
        minWidth: 780, minHeight: 540, show: false,
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
      });
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', (event, url) => {
        if (!isTrustedNavigation(url, trustedOrigin)) event.preventDefault();
      });
      window.webContents.on('will-attach-webview', event => event.preventDefault());
      await window.loadURL(local.url);
      window.show();
      window.on('closed', () => { window = null; void stop(); });
      if (process.env.UNBOUNDVNC_DESKTOP_CI_SMOKE === '1') {
        if (!isHostedSmoke) {
          throw new Error('Desktop smoke mode is limited to an ephemeral GitHub-hosted runner');
        }
        const deadline = Date.now() + 15_000;
        let rendered = false;
        while (Date.now() < deadline && !rendered) {
          rendered = await window.webContents.executeJavaScript(
            "Boolean(document.querySelector('#quick-form') && document.querySelector('#devices-grid'))"
          );
          if (!rendered) await new Promise(done => setTimeout(done, 100));
        }
        if (!rendered) throw new Error('Desktop renderer failed to display the actual viewer');
        const health = await fetch(new URL('/api/health', local.url));
        if (!health.ok || !(await health.json()).ok) throw new Error('Desktop gateway was not reachable');
        const { writeFile } = require('node:fs/promises');
        const screenshot = await window.webContents.capturePage();
        await writeFile(join(process.env.RUNNER_TEMP, 'unboundvnc-viewer-dashboard.png'), screenshot.toPNG());
        await window.webContents.executeJavaScript(`
          (() => {
            const form = document.querySelector('#quick-form');
            form.elements.host.value = '127.0.0.1';
            form.elements.port.value = '${fixturePort}';
            form.requestSubmit();
          })()
        `);
        const sessionDeadline = Date.now() + 15_000;
        let sessionReady = false;
        let lastView = null;
        const expectedPixels = [
          255, 0, 0, 255, 0, 255, 0, 255,
          0, 0, 255, 255, 255, 255, 255, 255,
        ];
        while (Date.now() < sessionDeadline && !sessionReady) {
          const view = await window.webContents.executeJavaScript(`(() => {
            const canvas = document.querySelector('#remote-screen canvas');
            const sized = canvas && canvas.width >= 2 && canvas.height >= 2;
            let pixels = null;
            if (sized) {
              try { pixels = Array.from(canvas.getContext('2d').getImageData(0, 0, 2, 2).data); }
              catch { /* A failed canvas read never counts as verified framebuffer. */ }
            }
            return {
              status: document.querySelector('#session-status')?.textContent ?? '',
              canvasWidth: canvas?.width ?? 0, canvasHeight: canvas?.height ?? 0,
              pixels,
              error: document.querySelector('#connection-error-message')?.textContent ?? '',
              sessionHidden: document.querySelector('#session-view')?.hidden,
              toast: document.querySelector('#toasts')?.lastElementChild?.textContent ?? ''
            };
          })()`);
          lastView = view;
          if (view.error) throw new Error(`Synthetic loopback viewer connection failed: ${view.error}`);
          sessionReady = view.status.startsWith('Connected') && !view.sessionHidden &&
            view.canvasWidth >= 2 && view.canvasHeight >= 2 &&
            Array.isArray(view.pixels) && view.pixels.length === 16 &&
            view.pixels.every((byte, index) => byte === expectedPixels[index]);
          if (!sessionReady) await new Promise(done => setTimeout(done, 100));
        }
        if (!sessionReady) throw new Error(`Desktop synthetic RFB 2x2 RGBA pixel oracle failed: ${JSON.stringify(lastView)}`);
        // Explicit user-visible session disconnect; no screenshot of framebuffer.
        const disconnected = await window.webContents.executeJavaScript(`(() => {
          document.querySelector('#session-disconnect').click();
          return document.querySelector('#session-view').hidden &&
            document.querySelector('#quick-form') !== null;
        })()`);
        if (!disconnected) throw new Error('Synthetic session did not return to dashboard after explicit disconnect');
        await writeFile(join(process.env.RUNNER_TEMP, 'unboundvnc-viewer-desktop-smoke.json'), JSON.stringify({
          renderer: 'loaded', session: 'synthetic-rfb-connected', url: local.url, gatewayUrl: local.gatewayUrl,
        }));
        await stop();
      }
    } catch (error) {
      console.error('Unable to initialize local viewer:', error.message);
      if (process.env.UNBOUNDVNC_DESKTOP_CI_SMOKE === '1' &&
          process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_TEMP) {
        const { writeFile } = require('node:fs/promises');
        await writeFile(join(process.env.RUNNER_TEMP, 'unboundvnc-viewer-smoke-error.txt'), String(error.message).slice(0, 500));
        process.exitCode = 1;
      }
      await stop();
    }
  });
}

async function stop() {
  if (stopping) return;
  stopping = true;
  try { await local?.close(); } catch (error) { console.error('Viewer shutdown:', error.message); }
  app.quit();
}

app.on('before-quit', () => { if (!stopping) void stop(); });
