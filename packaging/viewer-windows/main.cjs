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
