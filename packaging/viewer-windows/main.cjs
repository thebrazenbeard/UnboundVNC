// Electron desktop entry: the app owns its loopback gateway for one window lifetime.
const { app, BrowserWindow, session } = require('electron');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { isTrustedResource, isTrustedNavigation } = require('./resource-policy.cjs');

let window;
let local;
let stopping = false;

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
      local = await startLocalViewer({
        staticRoot: join(__dirname, 'runtime/viewer'), createGateway,
        allowedPorts: [5900, 5901],
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
        if (process.env.GITHUB_ACTIONS !== 'true' ||
            process.env.RUNNER_ENVIRONMENT !== 'github-hosted' || !process.env.RUNNER_TEMP) {
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
        await writeFile(join(process.env.RUNNER_TEMP, 'unboundvnc-viewer-desktop-smoke.json'), JSON.stringify({
          renderer: 'loaded', url: local.url, gatewayUrl: local.gatewayUrl,
        }));
        await stop();
      }
    } catch (error) {
      console.error('Unable to initialize local viewer:', error.message);
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
