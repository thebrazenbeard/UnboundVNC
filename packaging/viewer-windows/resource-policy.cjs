// Electron renderer requests require the exact random loopback app authority.
// WebSocket URL origins are ws:// (not http://), so match host/port explicitly.
function isTrustedResource(value, trustedOrigin) {
  try {
    const url = new URL(value);
    const trusted = new URL(trustedOrigin);
    return trusted.protocol === 'http:' && trusted.hostname === '127.0.0.1' &&
      trusted.port !== '' && url.hostname === trusted.hostname &&
      url.port === trusted.port && url.username === '' && url.password === '' &&
      (url.protocol === 'http:' || url.protocol === 'ws:');
  } catch { return false; }
}

function isTrustedNavigation(value, trustedOrigin) {
  try {
    const url = new URL(value);
    return isTrustedResource(value, trustedOrigin) && url.protocol === 'http:' &&
      url.origin === trustedOrigin && url.pathname === '/' && url.search === '';
  } catch { return false; }
}

module.exports = { isTrustedResource, isTrustedNavigation };
