import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('mobile CSS retains visible session status and the live-region markup', () => {
  // Source-level regression, not a computed-style/browser/screen-reader test.
  const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');
  const js = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const mobileStart = css.indexOf('@media (max-width: 600px)');
  assert.notEqual(mobileStart, -1);
  const mobileRule = css.slice(mobileStart, css.indexOf('@media (prefers-reduced-motion:', mobileStart));
  assert.match(mobileRule, /\.session-status\s*\{[^}]*display:\s*block/);
  assert.doesNotMatch(mobileRule, /\.session-status[^}]*display:\s*none/);
  assert.match(js, /id="session-status"[^>]*role="status"[^>]*aria-live="polite"/);
});

test('source offers persistent connection failure, retry and dismiss controls', () => {
  const js = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.match(js, /id="connection-error"[^>]*role="alert"/);
  assert.match(js, /id="connection-retry"[^>]*type="button"/);
  assert.match(js, /id="connection-error-dismiss"[^>]*type="button"/);
});

test('source offers a keyboard-reachable way back to the noVNC canvas after focusing toolbar', () => {
  const js = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.match(js, /id="session-focus-remote"[^>]*aria-label="Focus remote desktop"/);
  assert.match(js, /getElementById\('session-focus-remote'\)\.addEventListener\('click'/);
  assert.match(js, /state\.connection\?\.rfb\?\.focus\(\{ preventScroll: true \}\)/);
});

test('Fit screen retains an accessible name when responsive toolbar text is hidden', () => {
  const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');
  const js = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.match(css, /\.session-action span\s*\{\s*display:\s*none/);
  assert.match(js, /id="session-scale"[^>]*aria-label="Fit screen"/);
});

test('other mobile session controls retain stable names without changing view-only state', () => {
  const js = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.match(js, /id="session-viewonly"[^>]*aria-label="View only"[^>]*aria-pressed="false"/);
  assert.match(js, /id="session-fullscreen"[^>]*title="Fullscreen"/);
  assert.match(js, /id="session-disconnect"[^>]*aria-label="Disconnect"/);
  assert.match(js, /rfb\.viewOnly = !rfb\.viewOnly/);
});

test('Retry carries a View only choice in memory without changing fresh connection defaults', () => {
  // Source-level seam assertions; the stock-TigerVNC Chromium test separately
  // proves the UI state across a real remote close, Retry, and fresh connect.
  const js = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.match(js, /state\.lastFailure = \{ device, message, viewOnly \}/);
  assert.match(js, /async function connectTo\(device, viewOnly = false\)/);
  assert.match(js, /rfb\.viewOnly = connection\.viewOnly/);
  assert.match(js, /state\.connection\.viewOnly = rfb\.viewOnly/);
  assert.match(js, /connectTo\(failed\.device, failed\.viewOnly\)/);
  assert.match(js, /connectTo\(\{ \.\.\.data, name: data\.host \}\)/);
});
