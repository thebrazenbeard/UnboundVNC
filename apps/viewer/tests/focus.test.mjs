import assert from 'node:assert/strict';
import test from 'node:test';
import { captureFocus, findDeviceAction, isToolbarEscape, restoreFocus } from '../src/focus.mjs';

function button(action, id, connected = true, hidden = false) {
  return {
    dataset: { action, id }, isConnected: connected, focused: false, hidden,
    focus(options) { assert.deepEqual(options, { preventScroll: true }); this.focused = true; },
    closest(selector) { return selector === '[hidden], [inert]' ? (this.hidden ? this : null) : this; },
  };
}

function grid(...buttons) {
  return { querySelectorAll() { return buttons; } };
}

test('session return focus survives a saved-device list rerender', () => {
  const oldConnect = button('connect', 'device-a');
  const saved = captureFocus(oldConnect);
  oldConnect.isConnected = false;
  const replacement = button('connect', 'device-a');
  const other = button('connect', 'device-b');
  assert.equal(restoreFocus(saved, grid(other, replacement), null), replacement);
  assert.equal(replacement.focused, true);
  assert.equal(other.focused, false);
});

test('preserves an existing quick-connect focus target and falls back if missing', () => {
  const quickHost = button(null, null);
  assert.equal(restoreFocus(captureFocus(quickHost), grid(), null), quickHost);
  const fallback = button(null, null);
  assert.equal(restoreFocus(captureFocus(null), grid(), fallback), fallback);
  assert.equal(fallback.focused, true);
});

test('does not attempt to restore focus into the now-hidden retry failure banner', () => {
  const retry = button(null, null);
  const saved = captureFocus(retry);
  retry.hidden = true; // Ancestor panel becomes hidden when connection starts.
  const quickHost = button(null, null);
  assert.equal(restoreFocus(saved, grid(), quickHost), quickHost);
  assert.equal(retry.focused, false);
  assert.equal(quickHost.focused, true);
});

test('favorite rerender focuses only matching device and action', () => {
  const edit = button('edit', 'a');
  const favorite = button('favorite', 'a');
  assert.equal(findDeviceAction(grid(edit, favorite), 'favorite', 'a'), favorite);
  assert.equal(findDeviceAction(grid(edit, favorite), 'favorite', 'b'), null);
});

test('local keyboard escape requires a deliberate chord, preserving ordinary remote Escape', () => {
  const chord = { key: 'Escape', ctrlKey: true, altKey: true, shiftKey: true, metaKey: false };
  assert.equal(isToolbarEscape(chord), true);
  assert.equal(isToolbarEscape({ ...chord, shiftKey: false }), false);
  assert.equal(isToolbarEscape({ ...chord, ctrlKey: false }), false);
  assert.equal(isToolbarEscape({ ...chord, key: 'Tab' }), false);
});
