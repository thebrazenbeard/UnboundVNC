import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TRUST_STORAGE_KEY, trustedEndpoint, readServerPin, rememberServerPin,
  forgetServerPin, requirePinnedIdentity,
} from '../src/trust.mjs';

const A = Array(32).fill('AA').join(':');
const B = Array(32).fill('BB').join(':');
function fakeStorage(initial = null) {
  const values = new Map(initial === null ? [] : [[TRUST_STORAGE_KEY, initial]]);
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, value); },
  };
}

test('both allowed loopback host spellings resolve to one actual gateway peer identity', () => {
  assert.equal(trustedEndpoint({ host: 'localhost', port: 5900 }), '127.0.0.1:5900');
  assert.equal(trustedEndpoint({ host: 'LOCALHOST', port: 5900 }), '127.0.0.1:5900');
  assert.equal(trustedEndpoint({ host: '127.0.0.1', port: 5900 }), '127.0.0.1:5900');
  assert.equal(trustedEndpoint({ host: 'vn1.example', port: 5900 }), 'vn1.example:5900',
    'other DNS names must not be silently remapped');
});

test('legacy localhost pin must prevent fresh 127.0.0.1/VncAuth downgrade', () => {
  const legacy = fakeStorage(JSON.stringify({ 'localhost:5900': A }));
  const alias = trustedEndpoint({ host: '127.0.0.1', port: 5900 });
  assert.equal(readServerPin(legacy, alias), A);
  assert.throws(() => requirePinnedIdentity(readServerPin(legacy, alias), null), /downgrade/);
  assert.throws(() => rememberServerPin(legacy, alias, B), /identity changed/);
});

test('legacy 127.0.0.1 pin must prevent fresh localhost/VncAuth downgrade', () => {
  const legacy = fakeStorage(JSON.stringify({ '127.0.0.1:5900': A }));
  const alias = trustedEndpoint({ host: 'localhost', port: 5900 });
  assert.equal(readServerPin(legacy, alias), A);
  assert.throws(() => requirePinnedIdentity(readServerPin(legacy, alias), null), /downgrade/);
  assert.throws(() => rememberServerPin(legacy, alias, B), /identity changed/);
});

test('matching legacy alias safely migrates to single canonical key only after validated equality', () => {
  const legacy = fakeStorage(JSON.stringify({ 'localhost:5900': A }));
  rememberServerPin(legacy, '127.0.0.1:5900', A);
  assert.deepEqual(JSON.parse(legacy.getItem(TRUST_STORAGE_KEY)), { '127.0.0.1:5900': A });
  const both = fakeStorage(JSON.stringify({ 'localhost:5900': A, '127.0.0.1:5900': A }));
  rememberServerPin(both, 'localhost:5900', A);
  assert.deepEqual(JSON.parse(both.getItem(TRUST_STORAGE_KEY)), { '127.0.0.1:5900': A });
});

test('conflicting stored loopback aliases fail closed without overwriting either pin', () => {
  const raw = JSON.stringify({ 'localhost:5900': A, '127.0.0.1:5900': B });
  const store = fakeStorage(raw);
  for (const endpoint of ['localhost:5900', '127.0.0.1:5900']) {
    assert.throws(() => readServerPin(store, endpoint), /Conflicting/);
    assert.throws(() => rememberServerPin(store, endpoint, A), /Conflicting/);
    assert.throws(() => forgetServerPin(store, endpoint), /Conflicting/);
  }
  assert.equal(store.getItem(TRUST_STORAGE_KEY), raw, 'conflicting identities must remain quarantined');
});

test('explicit forget revokes both spellings only if stored identities agree', () => {
  const store = fakeStorage(JSON.stringify({ 'localhost:5901': A, '127.0.0.1:5901': A }));
  forgetServerPin(store, 'localhost:5901');
  assert.deepEqual(JSON.parse(store.getItem(TRUST_STORAGE_KEY)), {});
});

test('malformed legacy alias fails closed even when canonical pin itself is valid', () => {
  const store = fakeStorage(JSON.stringify({ 'localhost:5900': 'bad', '127.0.0.1:5900': A }));
  assert.throws(() => readServerPin(store, '127.0.0.1:5900'), /invalid/);
  assert.throws(() => rememberServerPin(store, '127.0.0.1:5900', A), /invalid/);
});
