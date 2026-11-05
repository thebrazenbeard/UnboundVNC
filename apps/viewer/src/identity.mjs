// noVNC RA2 supplies the raw RSA public key bytes to its serververification
// event. Hash all bytes exactly as received. This is display-only evidence:
// the owner must compare it against a trusted, independently obtained value.
export async function fingerprintServerKey(publickey, subtle = globalThis.crypto?.subtle) {
  if (!(publickey instanceof Uint8Array) || publickey.length < 4 || publickey.length > 4096) {
    throw new Error('The server did not provide a valid public key.');
  }
  if (!subtle?.digest) throw new Error('SHA-256 fingerprinting is unavailable in this browser.');

  const bytes = await subtle.digest('SHA-256', publickey);
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0').toUpperCase()).join(':');
}
