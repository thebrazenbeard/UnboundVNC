import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
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
  let context;
  let page;
  let server;
  let screenshotDir;
  let succeeded = false;
  const browserEvents = [];
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
    screenshotDir = process.env.UNBOUNDVNC_SCREENSHOT_DIR
      ? path.resolve(process.env.UNBOUNDVNC_SCREENSHOT_DIR)
      : await mkdtemp(path.join(os.tmpdir(), 'unboundvnc-browser-'));
    await mkdir(screenshotDir, { recursive: true });

    context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    page = await context.newPage();
    page.on('console', event => browserEvents.push({ type: `console.${event.type()}`, text: event.text() }));
    page.on('pageerror', error => browserEvents.push({ type: 'pageerror', text: error.message }));
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
    assert.equal(await page.getByRole('dialog', { name: 'Add a device' }).isVisible(), true,
      'device dialog has an accessible name');
    assert.equal(await page.locator('#device-form input[name="name"]').evaluate(element => element === document.activeElement), true,
      'initial dialog focus moves to the device name');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#device-dialog').isVisible(), false, 'Escape closes add-device dialog');
    assert.equal(await page.locator('#nav-add').evaluate(element => element === document.activeElement), true,
      'closing the dialog returns focus to its trigger');
    await page.locator('#nav-add').click();
    await page.locator('#device-form input[name="name"]').fill('Synthetic Test PC');
    await page.locator('#device-form input[name="host"]').fill('127.0.0.1');
    await page.locator('#device-form input[name="port"]').fill('5900');
    await page.locator('#device-form button[type="submit"]').click();
    assert.equal(await page.locator('.device-card').count(), 1);
    assert.match(await page.locator('.device-card h3').textContent(), /Synthetic Test PC/);

    // An everyday directory should retain several independent saved profiles.
    // These synthetic entries never attempt a real host connection.
    for (const name of ['Bravo Test PC', 'Charlie Test PC']) {
      await page.locator('#nav-add').click();
      await page.locator('#device-form input[name="name"]').fill(name);
      await page.locator('#device-form input[name="host"]').fill('127.0.0.1');
      await page.locator('#device-form input[name="port"]').fill('5900');
      await page.locator('#device-form button[type="submit"]').click();
    }
    assert.equal(await page.locator('.device-card').count(), 3);

    await page.locator('#device-search').fill('not-present');
    assert.equal(await page.locator('.device-card').count(), 0);
    await page.locator('#device-search').fill('Synthetic');
    assert.equal(await page.locator('.device-card').count(), 1);
    await page.locator('#device-search').fill('');
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(await page.locator('.device-card').count(), 3,
      'all three browser-local device profiles survive reload');
    assert.deepEqual(await page.locator('.device-card h3').allTextContents(),
      ['Bravo Test PC', 'Charlie Test PC', 'Synthetic Test PC']);
    const devices = await page.evaluate(() => localStorage.getItem('unboundvnc.devices.v1'));
    assert.ok(devices && !/password|token/i.test(devices), 'saved devices do not contain credentials');

    // Keyboard-only directory mutation: after a card is removed, focus should
    // stay on the corresponding action of the next surviving card, not body.
    await page.getByRole('button', { name: 'Remove Bravo Test PC' }).focus();
    page.once('dialog', dialog => dialog.accept());
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('.device-card').count(), 2);
    assert.equal(await page.getByRole('button', { name: 'Remove Charlie Test PC' })
      .evaluate(element => element === document.activeElement), true,
    'deleting a saved device must preserve keyboard focus in the surviving directory');

    // Renaming changes the card's DOM identity/position. Restored focus must
    // target the replacement Edit action, not a detached dialog trigger.
    await page.getByRole('button', { name: 'Edit Synthetic Test PC' }).focus();
    await page.keyboard.press('Enter');
    await page.locator('#device-form input[name="name"]').fill('Alpha Renamed PC');
    await page.locator('#device-form button[type="submit"]').click();
    assert.deepEqual(await page.locator('.device-card h3').allTextContents(),
      ['Alpha Renamed PC', 'Charlie Test PC']);
    assert.equal(await page.getByRole('button', { name: 'Edit Alpha Renamed PC' })
      .evaluate(element => element === document.activeElement), true,
    'renaming a saved device must restore focus to its replacement Edit button');

    await page.locator('.device-card').first().locator('[data-action="favorite"]').focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.getByRole('button', { name: 'Remove from favorites' })
      .evaluate(element => element === document.activeElement), true,
    'keyboard favorite toggles should retain focused control after rerender');
    await writeFile(path.join(screenshotDir, 'directory-result.json'), JSON.stringify({
      initialProfilesSurvivedReload: 3, afterDeleteAndRename: ['Alpha Renamed PC', 'Charlie Test PC'],
      keyboardFocusDelete: true, keyboardFocusRename: true, keyboardFocusFavorite: true,
    }, null, 2));

    const desktopImage = path.join(screenshotDir, 'dashboard-desktop.png');
    // Card entrance animations stagger by index; capture the settled layout.
    await page.screenshot({ path: desktopImage, fullPage: true, animations: 'disabled' });

    // The directory now has two saved profiles; target one by its saved name.
    await page.locator('.device-card').filter({ hasText: 'Alpha Renamed PC' })
      .locator('[data-action="connect"]').click();
    await page.locator('#connection-error-message').waitFor();
    assert.equal(await page.locator('#connection-error-message').textContent(),
      'Gateway intentionally disabled for UI smoke test');
    assert.equal(await page.locator('#toasts .toast-error').count(), 0,
      'the persistent failure banner is not duplicated by a mobile-obscuring toast');
    assert.equal(await page.locator('#session-view').isVisible(), false);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#quick-host').waitFor();
    const mobileImage = path.join(screenshotDir, 'dashboard-mobile.png');
    await page.screenshot({ path: mobileImage, fullPage: true, animations: 'disabled' });

    // A rename can cause its card to disappear from the active search filter.
    // The Edit button is replaced/hidden, so keyboard focus must return to
    // the Search field instead of falling into the document body.
    await page.locator('#connection-error-dismiss').click();
    await page.locator('#device-search').fill('Charlie');
    assert.equal(await page.locator('.device-card').count(), 1);
    await page.getByRole('button', { name: 'Edit Charlie Test PC' }).focus();
    await page.keyboard.press('Enter');
    await page.locator('#device-form input[name="name"]').fill('Delta Filtered PC');
    await page.locator('#device-form button[type="submit"]').click();
    assert.equal(await page.locator('.device-card').count(), 0,
      'renamed profile must disappear when it no longer matches the search');
    assert.equal(await page.locator('#device-search').evaluate(el => el === document.activeElement), true,
      'excluded rename must return keyboard focus to the search field');
    await page.locator('#device-search').fill('');
    assert.deepEqual(await page.locator('.device-card h3').allTextContents(),
      ['Alpha Renamed PC', 'Delta Filtered PC']);

    // Deleting the last card exercises the empty-state Add fallback. It must
    // be keyboard-reachable immediately after the final removal.
    await page.getByRole('button', { name: 'Remove Alpha Renamed PC' }).focus();
    page.once('dialog', dialog => dialog.accept());
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('.device-card').count(), 1);
    assert.equal(await page.getByRole('button', { name: 'Remove Delta Filtered PC' })
      .evaluate(el => el === document.activeElement), true,
    'deleting the first of two cards should focus the surviving Remove action');
    page.once('dialog', dialog => dialog.accept());
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('.device-card').count(), 0);
    assert.equal(await page.locator('#devices-grid [data-action="add"]')
      .evaluate(el => el === document.activeElement), true,
    'deleting the final profile should focus Add in the empty state');
    await page.waitForFunction(() => !document.querySelector('#toasts .toast'),
      null, { timeout: 7_000 });
    await page.screenshot({ path: path.join(screenshotDir, 'directory-empty-mobile.png'),
      fullPage: true, animations: 'disabled' });
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(await page.locator('.device-card').count(), 0,
      'deleting the final saved profile persists an empty directory across reload');
    await writeFile(path.join(screenshotDir, 'directory-edge-focus-result.json'), JSON.stringify({
      filteredRenameRemovedCard: true, focusReturnedToSearch: true,
      lastDeviceRemoved: true, focusMovedToEmptyAdd: true, emptyDirectorySurvivedReload: true,
    }, null, 2));

    // At mobile width Quick Connect lives well below the persistent error
    // banner. Test the *viewport* after a failed attempt, not a fullPage
    // stitched screenshot that hides an offscreen-feedback defect.
    await page.locator('#quick-host').fill('127.0.0.1');
    await page.locator('#quick-form button[type="submit"]').click();
    await page.locator('#connection-error').waitFor({ state: 'visible', timeout: 12_000 });
    const quickFailure = await page.evaluate(() => {
      const error = document.getElementById('connection-error').getBoundingClientRect();
      const retry = document.getElementById('connection-retry').getBoundingClientRect();
      const submit = document.querySelector('#quick-form button[type="submit"]').getBoundingClientRect();
      const inside = rect => rect.top >= 0 && rect.bottom <= window.innerHeight;
      return {
        viewportHeight: window.innerHeight, scrollY: window.scrollY,
        errorTop: error.top, errorBottom: error.bottom, retryTop: retry.top,
        submitTop: submit.top, errorInViewport: inside(error),
        retryInViewport: inside(retry), focusedControl: document.activeElement?.id ?? '',
      };
    });
    await writeFile(path.join(screenshotDir, 'quick-failure-viewport-result.json'),
      JSON.stringify(quickFailure, null, 2));
    await page.screenshot({ path: path.join(screenshotDir, 'quick-failure-viewport.png'),
      animations: 'disabled' });
    assert.equal(quickFailure.errorInViewport, true,
      'failed mobile Quick Connect must show its error without requiring the user to scroll to the top');
    assert.equal(quickFailure.retryInViewport, true,
      'failed mobile Quick Connect must visibly offer the actionable Retry button');
    assert.equal(quickFailure.focusedControl, 'connection-retry',
      'keyboard focus after a failed connection should move to Retry');
    assert.equal(browserEvents.filter(event => event.type === 'pageerror').length, 0,
      'viewer has no uncaught browser exceptions');
    succeeded = true;
    console.log(JSON.stringify({ outcome: 'PASS', browser: browser.version(), baseUrl, desktopImage, mobileImage }));
  } finally {
    if (page && screenshotDir && !page.isClosed() && !succeeded) {
      await page.screenshot({ path: path.join(screenshotDir, 'failure.png'), fullPage: true }).catch(() => {});
    }
    if (context && screenshotDir) {
      await context.tracing.stop({ path: path.join(screenshotDir, 'trace.zip') }).catch(error => {
        browserEvents.push({ type: 'trace.error', text: error.message });
      });
      await writeFile(path.join(screenshotDir, 'browser-events.json'), JSON.stringify(browserEvents, null, 2));
      console.log(`Browser evidence directory: ${screenshotDir}`);
    }
    await context?.close();
    await browser?.close();
    await server?.close();
  }
}

run().catch(error => {
  console.error(`Browser smoke test unavailable or failed: ${error.message}`);
  process.exitCode = 1;
});
