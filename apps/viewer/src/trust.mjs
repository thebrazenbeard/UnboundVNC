// These are RSA key fingerprints explicitly accepted by the operator after
// comparison with a trusted independent source. This is not certificate PKI.
export const TRUST_STORAGE_KEY = 'unboundvnc.server-pins.v1';

const FINGERPRINT_PATTERN = /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/;

export function trustedEndpoint(device) {
  return `${device.host.toLowerCase()}:${device.port}`;
}

function validFingerprint(value) {
  return typeof value === 'string' && FINGERPRINT_PATTERN.test(value);
}

export function compareServerPin(pinned, observed) {
  if (!validFingerprint(observed)) throw new Error('Invalid observed server fingerprint.');
  if (pinned === null) return 'first-use';
  if (!validFingerprint(pinned)) throw new Error('Invalid pinned server fingerprint.');
  return pinned === observed ? 'matching' : 'changed';
}

// A previously pinned RA2 endpoint must not silently downgrade to VncAuth,
// None, or any security mode that omits the pinned server-key challenge.
export function requirePinnedIdentity(pinned, verified) {
  if (pinned === null) return;
  if (!validFingerprint(pinned) || pinned !== verified) {
    throw new Error('This endpoint has a remembered RSA key, but the server did not prove that identity. Possible downgrade or changed key.');
  }
}

export function readServerPin(storage, endpoint) {
  const raw = storage.getItem(TRUST_STORAGE_KEY);
  if (raw === null) return null;
  const pins = JSON.parse(raw);
  if (!pins || typeof pins !== 'object' || Array.isArray(pins)) {
    throw new Error('Stored server identities are damaged.');
  }
  const pin = Object.hasOwn(pins, endpoint) ? pins[endpoint] : null;
  if (pin !== null && !validFingerprint(pin)) {
    throw new Error('Stored server identity is invalid.');
  }
  return pin;
}

export function rememberServerPin(storage, endpoint, fingerprint) {
  if (!validFingerprint(fingerprint)) throw new Error('Refusing to remember an invalid fingerprint.');
  // Refuse to overwrite a previously approved identity silently.
  const existing = readServerPin(storage, endpoint);
  if (existing !== null && existing !== fingerprint) {
    throw new Error('Server identity changed; forget the old key before pairing again.');
  }
  const pins = storage.getItem(TRUST_STORAGE_KEY);
  const parsed = pins === null ? {} : JSON.parse(pins);
  storage.setItem(TRUST_STORAGE_KEY, JSON.stringify({ ...parsed, [endpoint]: fingerprint }));
}

export function forgetServerPin(storage, endpoint) {
  // Even the explicit reset flow must not silently overwrite malformed data.
  readServerPin(storage, endpoint);
  const raw = storage.getItem(TRUST_STORAGE_KEY);
  if (raw === null) return;
  const pins = JSON.parse(raw);
  delete pins[endpoint];
  storage.setItem(TRUST_STORAGE_KEY, JSON.stringify(pins));
}
