import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TRUST_STORAGE_KEY, compareServerPin, forgetServerPin, readServerPin, rememberServerPin, requirePinnedIdentity, trustedEndpoint,
} from '../src/trust.mjs';

const A = Array.from({ length: 32 }, () => 'AA').join(':');
const B = Array.from({ length: 32 }, () => 'BB').join(':');

function storage(initial = null) {
  const data = new Map(initial === null ? [] : [[TRUST_STORAGE_KEY, initial]]);
  return {
    getItem(key) { return data.has(key) ? data.get(key) : null; },
    setItem(key, value) { data.set(key, value); },
  };
}

test('pins are endpoint-bound; the same host with another port never inherits trust', () => {
  const local = storage();
  const endpoint = trustedEndpoint({ host: 'LAPPY.Local', port: 5900 });
  rememberServerPin(local, endpoint, A);
  assert.equal(endpoint, 'lappy.local:5900');
  assert.equal(readServerPin(local, 'lappy.local:5900'), A);
  assert.equal(readServerPin(local, 'lappy.local:5901'), null);
  assert.equal(readServerPin(local, 'vn1.local:5900'), null);
});

test('a matching trusted identity is retained, but replacement fails closed', () => {
  const local = storage();
  rememberServerPin(local, 'vn1.local:5900', A);
  rememberServerPin(local, 'vn1.local:5900', A);
  assert.throws(() => rememberServerPin(local, 'vn1.local:5900', B), /identity changed/);
  assert.equal(readServerPin(local, 'vn1.local:5900'), A);
  assert.equal(compareServerPin(A, A), 'matching');
  assert.equal(compareServerPin(A, B), 'changed');
  assert.equal(compareServerPin(null, B), 'first-use');
  assert.throws(() => compareServerPin('invalid', A));
});

test('tampered and malformed storage cannot be promoted into trusted identity', () => {
  const bad = storage('{bad json');
  assert.throws(() => readServerPin(bad, 'lappy:5900'));
  assert.throws(() => rememberServerPin(bad, 'lappy:5900', A));
  for (const payload of ['[]', 'null', JSON.stringify({ 'lappy:5900': 'not-a-fingerprint' })]) {
    const local = storage(payload);
    assert.throws(() => readServerPin(local, 'lappy:5900'));
    assert.throws(() => rememberServerPin(local, 'lappy:5900', B));
  }
  assert.throws(() => rememberServerPin(storage(), 'lappy:5900', 'garbage'), /invalid fingerprint/);
});

test('forgotten identity requires a new explicit approval before a different key may be pinned', () => {
  const local = storage();
  rememberServerPin(local, 'vn2:5900', A);
  forgetServerPin(local, 'vn2:5900');
  assert.equal(readServerPin(local, 'vn2:5900'), null);
  rememberServerPin(local, 'vn2:5900', B);
  assert.equal(readServerPin(local, 'vn2:5900'), B);
});

test('an already pinned endpoint rejects a security downgrade without an RSA key challenge', () => {
  assert.doesNotThrow(() => requirePinnedIdentity(null, null)); // Legacy first-use endpoint.
  assert.doesNotThrow(() => requirePinnedIdentity(A, A));
  assert.throws(() => requirePinnedIdentity(A, null), /Possible downgrade/);
  assert.throws(() => requirePinnedIdentity(A, B), /changed key/);
});
