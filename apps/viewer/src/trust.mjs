// These are RSA key fingerprints explicitly accepted by the operator after
// comparison with a trusted independent source. This is not certificate PKI.
export const TRUST_STORAGE_KEY = 'unboundvnc.server-pins.v1';

const FINGERPRINT_PATTERN = /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/;
const LOOPBACK_IP = '127.0.0.1';
const LOOPBACK_NAME = 'localhost';
// The preview gateway routes BOTH allowed host spellings to IPv4 127.0.0.1.
// Bind identity to the actual route, never the user-entered spelling.
function canonicalEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || !endpoint) {
    throw new Error('Invalid server identity endpoint.');
  }
  const normalized = endpoint.toLowerCase(); // DNS hostnames are case-insensitive.
  return normalized.startsWith(LOOPBACK_NAME + ':')
    ? LOOPBACK_IP + normalized.slice(LOOPBACK_NAME.length)
    : normalized;
}

function legacyLoopbackAlias(endpoint) {
  return endpoint.startsWith(LOOPBACK_IP + ':')
    ? LOOPBACK_NAME + endpoint.slice(LOOPBACK_IP.length)
    : null;
}

export function trustedEndpoint(device) {
  return canonicalEndpoint(`${device.host.toLowerCase()}:${device.port}`);
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
  const canonical = canonicalEndpoint(endpoint);
  const raw = storage.getItem(TRUST_STORAGE_KEY);
  if (raw === null) return null;
  const pins = JSON.parse(raw);
  if (!pins || typeof pins !== 'object' || Array.isArray(pins)) {
    throw new Error('Stored server identities are damaged.');
  }
  const alias = legacyLoopbackAlias(canonical);
  const hasPin = Object.hasOwn(pins, canonical);
  const hasLegacy = alias !== null && Object.hasOwn(pins, alias);
  const pin = hasPin ? pins[canonical] : null;
  const legacy = hasLegacy ? pins[alias] : null;
  if ((hasPin && !validFingerprint(pin)) ||
      (hasLegacy && !validFingerprint(legacy))) {
    throw new Error('Stored server identity is invalid.');
  }
  // Existing installations may have separately pinned both spellings. Never
  // silently choose one if their identities conflict; manual review is needed.
  if (pin !== null && legacy !== null && pin !== legacy) {
    throw new Error('Conflicting remembered loopback server identities; manual recovery required.');
  }
  return pin ?? legacy;
}

export function rememberServerPin(storage, endpoint, fingerprint) {
  if (!validFingerprint(fingerprint)) throw new Error('Refusing to remember an invalid fingerprint.');
  const canonical = canonicalEndpoint(endpoint);
  const alias = legacyLoopbackAlias(canonical);
  // Refuse to overwrite a previously approved identity silently.
  const existing = readServerPin(storage, canonical);
  if (existing !== null && existing !== fingerprint) {
    throw new Error('Server identity changed; forget the old key before pairing again.');
  }
  const pins = storage.getItem(TRUST_STORAGE_KEY);
  const parsed = pins === null ? {} : JSON.parse(pins);
  const next = { ...parsed, [canonical]: fingerprint };
  if (alias !== null) delete next[alias]; // Safe only after no-conflict check.
  storage.setItem(TRUST_STORAGE_KEY, JSON.stringify(next));
}

export function forgetServerPin(storage, endpoint) {
  // Even the explicit reset flow must not silently overwrite malformed data.
  readServerPin(storage, endpoint);
  const raw = storage.getItem(TRUST_STORAGE_KEY);
  if (raw === null) return;
  const pins = JSON.parse(raw);
  const canonical = canonicalEndpoint(endpoint);
  delete pins[canonical];
  const alias = legacyLoopbackAlias(canonical);
  if (alias !== null) delete pins[alias];
  storage.setItem(TRUST_STORAGE_KEY, JSON.stringify(pins));
}
