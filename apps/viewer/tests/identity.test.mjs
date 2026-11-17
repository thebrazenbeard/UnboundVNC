import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, webcrypto } from 'node:crypto';
import { fingerprintServerKey } from '../src/identity.mjs';

test('shows SHA-256 of the exact raw RA2 RSA public key bytes received from noVNC', async () => {
  const publickey = Uint8Array.from({ length: 264 }, (_, index) => index % 256);
  const expected = createHash('sha256').update(publickey).digest('hex').toUpperCase().match(/../g).join(':');
  assert.equal(await fingerprintServerKey(publickey, webcrypto.subtle), expected);
  assert.equal(expected.split(':').length, 32);
});

test('refuses missing or malformed verification material rather than displaying false identity', async () => {
  for (const bytes of [undefined, null, [], new Uint8Array(0), new Uint8Array(3), new Uint8Array(4097)]) {
    await assert.rejects(() => fingerprintServerKey(bytes, webcrypto.subtle), /valid public key/);
  }
  await assert.rejects(() => fingerprintServerKey(new Uint8Array(4), null), /unavailable/);
});

test('rejects hashing failures without creating a fingerprint', async () => {
  const subtle = { digest() { throw new Error('digest failed'); } };
  await assert.rejects(() => fingerprintServerKey(new Uint8Array(4), subtle), /digest failed/);
});
