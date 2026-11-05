import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const require = createRequire(import.meta.url);
const viewerRoot = fileURLToPath(new URL('../', import.meta.url));

function loadPlaywright() {
  try {
    return require('playwright');
  } catch (error) {
    if (error.code === 'MODULE_NOT_FOUND') {
      throw new Error('Playwright is not installed. Install it locally before running this optional browser test.');
    }
    throw error;
  }
}

async function run() {
  const { chromium } = loadPlaywright();
  let browser;
  let server;
  try {
    // Launch first so a missing browser binary cannot leave a dev server behind.
    browser = await chromium.launch({ headless: true });
    server = await createServer({
      configFile: path.join(viewerRoot, 'vite.config.js'),
      root: viewerRoot,
      server: { host: '127.0.0.1', port: 0, strictPort: true },
    });
    await server.listen();
    const { port } = server.httpServer.address();
    const baseUrl = `http://127.0.0.1:${port}`;
    const screenshotDir = process.env.UNBOUNDVNC_SCREENSHOT_DIR
      ? path.resolve(process.env.UNBOUNDVNC_SCREENSHOT_DIR)
      : await mkdtemp(path.join(os.tmpdir(), 'unboundvnc-browser-'));
    await mkdir(screenshotDir, { recursive: true });

    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    // This tests viewer UI behavior, not a remote server. Keep all session traffic mocked.
    await page.route('**/api/health', route => route.fulfill({
      status: 503, contentType: 'application/json', body: '{"ok":false}',
    }));
    await page.route('**/api/sessions', route => route.fulfill({
      status: 503, contentType: 'application/json', body: '{"error":"Gateway intentionally disabled for UI smoke test"}',
    }));

    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    assert.match(await page.locator('h1').textContent(), /Your machines/);
    await page.getByText('Local gateway offline').waitFor();
    assert.equal(await page.locator('.device-card').count(), 0);

    await page.locator('#nav-add').click();
    await page.locator('#device-form input[name="name"]').fill('Synthetic Test PC');
    await page.locator('#device-form input[name="host"]').fill('127.0.0.1');
    await page.locator('#device-form input[name="port"]').fill('5900');
    await page.locator('#device-form button[type="submit"]').click();
    assert.equal(await page.locator('.device-card').count(), 1);
    assert.match(await page.locator('.device-card h3').textContent(), /Synthetic Test PC/);

    await page.locator('#device-search').fill('not-present');
    assert.equal(await page.locator('.device-card').count(), 0);
    await page.locator('#device-search').fill('Synthetic');
    assert.equal(await page.locator('.device-card').count(), 1);
    await page.locator('#device-search').fill('');
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(await page.locator('.device-card').count(), 1, 'browser-local device profile survives reload');
    const devices = await page.evaluate(() => localStorage.getItem('unboundvnc.devices.v1'));
    assert.ok(devices && !/password|token/i.test(devices), 'saved devices do not contain credentials');

    const desktopImage = path.join(screenshotDir, 'dashboard-desktop.png');
    await page.screenshot({ path: desktopImage, fullPage: true });

    await page.locator('.device-card [data-action="connect"]').click();
    await page.getByText('Gateway intentionally disabled for UI smoke test').waitFor();
    assert.equal(await page.locator('#session-view').isVisible(), false);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#quick-host').waitFor();
    const mobileImage = path.join(screenshotDir, 'dashboard-mobile.png');
    await page.screenshot({ path: mobileImage, fullPage: true });
    console.log(JSON.stringify({ outcome: 'PASS', browser: browser.version(), baseUrl, desktopImage, mobileImage }));
  } finally {
    await browser?.close();
    await server?.close();
  }
}

run().catch(error => {
  console.error(`Browser smoke test unavailable or failed: ${error.message}`);
  process.exitCode = 1;
});
