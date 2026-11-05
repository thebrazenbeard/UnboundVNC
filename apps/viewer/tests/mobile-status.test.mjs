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
