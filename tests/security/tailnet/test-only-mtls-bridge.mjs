import { createServer as createHttpsServer } from 'node:https';
import { connect as connectTcp } from 'node:net';
import { randomBytes, createHash } from 'node:crypto';

// EXPERIMENTAL TEST FIXTURE, NOT a product listener or a Tailscale adapter.
// A real tsnet adapter would use Server.ListenTLS and trusted
// LocalClient.WhoIs(req.RemoteAddr); neither exists in the JS runtime here.
// Nothing in apps/ imports this module. No CLI or environment enable switch.
const DEADLINE_MS = 2_000;
const MAX_CONSENT_MS = 30_000;

function localGateway(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('gateway must be explicit loopback HTTP URL'); }
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' ||
      !parsed.port || parsed.username || parsed.password || parsed.pathname !== '/' ||
      parsed.search || parsed.hash) {
    throw new Error('gateway must be explicit loopback HTTP URL');
  }
  return parsed;
}

function validWsKey(key) {
  return typeof key === 'string' && /^[A-Za-z0-9+/]{22}==$/.test(key) &&
    Buffer.from(key, 'base64').length === 16;
}

function deny(socket, code = 403) {
  if (!socket.destroyed) socket.end(`HTTP/1.1 ${code} Denied\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
}

/**
 * Test-owned mTLS -> internal localhost-gateway WS transport simulation.
 * `testWhoIs` stands in for a trustworthy per-accepted-socket WhoIs result;
 * `testHostConsent` stands in for host-local peer/session approval. Both are
 * impossible to instantiate from today's Windows host, so do not ship this.
 */
export function createTestOnlyMtlsBridge({
  testOnlyEnabled = false, tlsOptions, gatewayUrl, upstreamPort,
  serviceName = 'bridge.test.invalid', hostId = 'test-host',
  allowedPeerIds = [], testWhoIs, testHostConsent,
} = {}) {
  if (testOnlyEnabled !== true) throw new Error('test-only bridge disabled');
  const gateway = localGateway(gatewayUrl);
  if (!Number.isInteger(upstreamPort) || upstreamPort < 1 || upstreamPort > 65535 ||
      !/^[a-z0-9.-]+\.invalid$/.test(serviceName) ||
      typeof hostId !== 'string' || !hostId ||
      !Array.isArray(allowedPeerIds) || !allowedPeerIds.length ||
      !allowedPeerIds.every(x => typeof x === 'string' && /^node:[A-Za-z0-9_-]{1,64}$/.test(x)) ||
      typeof testWhoIs !== 'function' || typeof testHostConsent !== 'function' ||
      !tlsOptions?.key || !tlsOptions?.cert || !tlsOptions?.ca) {
    throw new Error('test-only bridge requires exact private route, mTLS, trusted test attestor and host consent');
  }
  const allowed = new Set(allowedPeerIds);
  if (allowed.size !== allowedPeerIds.length) throw new Error('duplicate peer ID');
  const server = createHttpsServer({ ...tlsOptions, requestCert: true, rejectUnauthorized: true },
    (req, res) => { res.writeHead(404); res.end(); });
  const sockets = new Set();
  let active = false;
  let edgePort = null;

  server.on('secureConnection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('upgrade', async (req, socket, head) => {
    socket.pause();
    if (active) return deny(socket, 429);
    const expectedHost = `${serviceName}:${edgePort}`;
    if (req.method !== 'GET' || req.url !== '/ws/view' ||
        req.headers.host !== expectedHost ||
        req.headers.origin !== `https://${expectedHost}` ||
        req.headers['sec-websocket-version'] !== '13' ||
        req.headers.upgrade?.toLowerCase() !== 'websocket' ||
        !req.headers.connection?.toLowerCase().split(',').map(x => x.trim()).includes('upgrade') ||
        !validWsKey(req.headers['sec-websocket-key']) || head.length > 4096 ||
        socket.authorized !== true) return deny(socket);

    active = true; // One pending or active host session, including identity wait.
    let upstream;
    let expiryTimer;
    let stopped = false;
    let abortListener;
    let consentSignal;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearTimeout(expiryTimer);
      consentSignal?.removeEventListener('abort', abortListener);
      upstream?.destroy();
      socket.destroy();
      active = false;
    };
    socket.once('close', stop);
    socket.once('error', stop);
    const deadline = AbortSignal.timeout(DEADLINE_MS);
    try {
      const certificate = socket.getPeerCertificate();
      if (!certificate?.fingerprint256) return deny(socket);
      const identity = await Promise.race([
        testWhoIs({ socket, certificate }),
        new Promise((_, reject) => deadline.addEventListener('abort', () => reject(new Error('identity deadline')), { once: true })),
      ]);
      if (stopped || identity?.source !== 'TEST_TLS_CERT' ||
          identity.certFingerprint !== certificate.fingerprint256 ||
          !allowed.has(identity.peerNodeId)) return deny(socket);
      const sessionId = randomBytes(32).toString('base64url');
      const consent = await Promise.race([
        testHostConsent({ peerNodeId: identity.peerNodeId, hostId, sessionId, scope: 'view-only' }),
        new Promise((_, reject) => deadline.addEventListener('abort', () => reject(new Error('consent deadline')), { once: true })),
      ]);
      const now = Date.now();
      if (stopped || consent?.approved !== true || consent.scope !== 'view-only' ||
          consent.peerNodeId !== identity.peerNodeId || consent.hostId !== hostId ||
          consent.sessionId !== sessionId || !Number.isSafeInteger(consent.epoch) ||
          consent.epoch < 0 || !Number.isSafeInteger(consent.currentEpoch) ||
          consent.currentEpoch !== consent.epoch || !Number.isFinite(consent.expiresAt) ||
          consent.expiresAt <= now || consent.expiresAt > now + MAX_CONSENT_MS ||
          !(consent.signal instanceof AbortSignal) || consent.signal.aborted) return deny(socket);
      consentSignal = consent.signal;
      abortListener = stop;
      consentSignal.addEventListener('abort', stop, { once: true });
      expiryTimer = setTimeout(stop, consent.expiresAt - now);

      // Server-side gateway ticket only: never returned in client HTTP bytes.
      const issued = await fetch(`${gateway.origin}/api/sessions`, {
        method: 'POST',
        headers: { Origin: gateway.origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ host: '127.0.0.1', port: upstreamPort }),
        signal: deadline,
      });
      if (issued.status !== 201) return deny(socket);
      const ticket = await issued.json();
      if (!/^\/ws\/session\/[A-Za-z0-9_-]{43}$/.test(ticket.wsPath)) return deny(socket);
      if (stopped || consentSignal.aborted) return stop();

      upstream = connectTcp({ host: '127.0.0.1', port: Number(gateway.port) });
      upstream.once('close', stop);
      upstream.once('error', stop);
      await new Promise((resolve, reject) => {
        upstream.once('connect', resolve);
        upstream.once('error', reject);
        deadline.addEventListener('abort', () => reject(new Error('gateway deadline')), { once: true });
      });
      if (stopped || consentSignal.aborted) return stop();
      upstream.write(`GET ${ticket.wsPath} HTTP/1.1\r\nHost: ${gateway.host}\r\n` +
        'Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\n' +
        `Sec-WebSocket-Key: ${req.headers['sec-websocket-key']}\r\nOrigin: ${gateway.origin}\r\n\r\n`);
      let response = Buffer.alloc(0);
      await new Promise((resolve, reject) => {
        const onData = chunk => {
          response = Buffer.concat([response, chunk]);
          const end = response.indexOf('\r\n\r\n');
          if (response.length > 8192) return reject(new Error('oversize gateway response'));
          if (end < 0) return;
          upstream.off('data', onData);
          const lines = response.subarray(0, end).toString('latin1').split('\r\n');
          const expectedAccept = createHash('sha1').update(
            `${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`,
          ).digest('base64');
          const accepts = lines.filter(line => /^sec-websocket-accept:/i.test(line));
          if (lines[0] !== 'HTTP/1.1 101 Switching Protocols' ||
              accepts.length !== 1 || accepts[0].split(':').slice(1).join(':').trim() !== expectedAccept) {
            return reject(new Error('gateway denied internal WS'));
          }
          resolve();
        };
        upstream.on('data', onData);
        deadline.addEventListener('abort', () => reject(new Error('WS deadline')), { once: true });
        upstream.once('close', () => reject(new Error('gateway closed')), { once: true });
      });
      if (stopped || consentSignal.aborted) return stop();
      socket.write(response); // includes legitimate 101 and any initial WS frames
      if (head.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
      socket.resume();
    } catch {
      if (!stopped) deny(socket);
    } finally {
      // A rejected upgrade must not retain the single-session slot.
      if (!upstream || upstream.destroyed) { active = false; }
    }
  });

  return {
    async listen() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      edgePort = server.address().port;
      return edgePort;
    },
    activeSessions: () => Number(active),
    async close() {
      for (const socket of sockets) socket.destroy();
      if (!server.listening) return;
      await new Promise(resolve => server.close(resolve));
    },
  };
}
