import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createTcpServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { connect as connectTls } from 'node:tls';
import { X509Certificate, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway } from '../../../apps/gateway/src/server.mjs';
import { createTestOnlyMtlsBridge } from './test-only-mtls-bridge.mjs';

// Ephemeral test CA/keys only, never committed or reused. All sockets below
// bind 127.0.0.1:0. This is mTLS, NOT a Tailscale tsnet/WhoIs runtime test.
function fixtureCertificates() {
  const dir = mkdtempSync(join(tmpdir(), 'unboundvnc-mtls-fixture-'));
  const run = (...args) => execFileSync('openssl', args, { cwd: dir, stdio: 'ignore', timeout: 10_000 });
  run('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key',
    '-out', 'ca.crt', '-subj', '/CN=UnboundVNC disposable test CA', '-days', '1');
  for (const name of ['server', 'viewerA', 'viewerB']) {
    run('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${name}.key`,
      '-out', `${name}.csr`, '-subj', `/CN=${name === 'server' ? 'bridge.test.invalid' : name}`);
    writeFileSync(join(dir, `${name}.ext`), name === 'server'
      ? 'subjectAltName=DNS:bridge.test.invalid\nextendedKeyUsage=serverAuth\n'
      : 'extendedKeyUsage=clientAuth\n');
    run('x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.crt', '-CAkey', 'ca.key',
      '-CAcreateserial', '-out', `${name}.crt`, '-days', '1', '-extfile', `${name}.ext`);
  }
  const load = name => readFileSync(join(dir, name));
  return {
    ca: load('ca.crt'),
    server: { key: load('server.key'), cert: load('server.crt') },
    viewerA: { key: load('viewerA.key'), cert: load('viewerA.crt') },
    viewerB: { key: load('viewerB.key'), cert: load('viewerB.crt') },
    fingerprintA: new X509Certificate(load('viewerA.crt')).fingerprint256,
    fingerprintB: new X509Certificate(load('viewerB.crt')).fingerprint256,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function client({ port, certificates, peer = certificates.viewerA, origin, host, allowHalfOpen = false }) {
  const socket = connectTls({
    host: '127.0.0.1', port, servername: 'bridge.test.invalid', ca: certificates.ca,
    ...peer, rejectUnauthorized: true, allowHalfOpen,
  });
  const key = randomBytes(16).toString('base64');
  const httpHost = host ?? `bridge.test.invalid:${port}`;
  const httpOrigin = origin ?? `https://bridge.test.invalid:${port}`;
  socket.once('secureConnect', () => socket.write(`GET /ws/view HTTP/1.1\r\nHost: ${httpHost}\r\n` +
    'Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\n' +
    `Sec-WebSocket-Key: ${key}\r\nOrigin: ${httpOrigin}\r\n` +
    'Tailscale-User-Login: viewerA@example.invalid\r\n' +
    'X-Tailscale-Node-ID: node:viewerA\r\nX-Forwarded-For: 100.101.102.103\r\n\r\n'));
  return socket;
}

function until(socket, predicate, timeoutMs = 2_500) {
  return new Promise((resolve, reject) => {
    let data = Buffer.alloc(0);
    const timer = setTimeout(() => finish(new Error('response deadline')), timeoutMs);
    function finish(error) {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
      if (error) reject(error); else resolve(data);
    }
    function onData(chunk) { data = Buffer.concat([data, chunk]); if (predicate(data)) finish(); }
    function onError(error) { finish(error); }
    function onClose() { finish(new Error('socket closed before expected response')); }
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

async function waitUntil(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('test-owned mTLS peer + per-session approval bridges only local gateway RFB', async t => {
  const certificates = fixtureCertificates();
  t.after(certificates.cleanup);
  let upstreamAccepts = 0;
  const rfb = createTcpServer(socket => { upstreamAccepts++; socket.write('RFB 003.008\n'); });
  await new Promise(resolve => rfb.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => rfb.close(resolve)));
  const port = rfb.address().port;
  const gateway = createGateway({ port: 0, allowedPorts: [port] });
  const gatewayUrl = await gateway.listen();
  t.after(() => gateway.close());

  let whoisMode = 'trusted';
  const option = {
    tlsOptions: { ...certificates.server, ca: certificates.ca },
    gatewayUrl, upstreamPort: port, allowedPeerIds: ['node:viewerA'],
    testWhoIs: async ({ certificate }) => whoisMode === 'unavailable' ? null : ({ source: 'TEST_TLS_CERT',
      peerNodeId: certificate.fingerprint256 === certificates.fingerprintA ? 'node:viewerA' : 'node:viewerB',
      certFingerprint: certificate.fingerprint256 }),
  };
  assert.throws(() => createTestOnlyMtlsBridge(option), /disabled/);
  assert.throws(() => createTestOnlyMtlsBridge({ ...option, testOnlyEnabled: true,
    gatewayUrl: 'http://192.168.1.88:6081' }), /loopback/);
  assert.throws(() => createTestOnlyMtlsBridge({ ...option, testOnlyEnabled: true,
    gatewayUrl: 'http://127.0.0.1:6081/', testWhoIs: undefined }), /attestor/);

  let approvalMode = 'deny';
  let revoked;
  let approvals = 0;
  const bridge = createTestOnlyMtlsBridge({ ...option, testOnlyEnabled: true,
    testHostConsent: async request => {
      approvals++;
      revoked = new AbortController();
      const expiry = approvalMode === 'stale' ? -1 : 5_000;
      return { approved: approvalMode !== 'deny', scope: 'view-only',
        peerNodeId: approvalMode === 'wrong-peer' ? 'node:viewerB' : request.peerNodeId,
        hostId: request.hostId,
        sessionId: approvalMode === 'wrong-session' ? 'replay' : request.sessionId,
        epoch: 1, currentEpoch: approvalMode === 'wrong-epoch' ? 2 : 1,
        expiresAt: Date.now() + expiry, signal: revoked.signal };
    },
  });
  const edgePort = await bridge.listen();
  t.after(() => bridge.close());
  const open = (options = {}) => {
    const socket = client({ port: edgePort, certificates, ...options });
    t.after(() => socket.destroy());
    return socket;
  };
  const responseCode = socket => until(socket, value => value.includes('\r\n\r\n'));

  // No host approval: valid peer mTLS does not contact the RFB server.
  assert.match((await responseCode(open())).toString('latin1'), /^HTTP\/1\.1 403/);
  assert.equal(upstreamAccepts, 0);

  approvalMode = 'stale';
  assert.match((await responseCode(open())).toString('latin1'), /^HTTP\/1\.1 403/);
  assert.equal(upstreamAccepts, 0);

  for (const mode of ['wrong-peer', 'wrong-session', 'wrong-epoch']) {
    approvalMode = mode;
    assert.match((await responseCode(open())).toString('latin1'), /^HTTP\/1\.1 403/);
    assert.equal(upstreamAccepts, 0);
  }

  approvalMode = 'allow';
  whoisMode = 'unavailable';
  assert.match((await responseCode(open())).toString('latin1'), /^HTTP\/1\.1 403/);
  assert.equal(upstreamAccepts, 0, 'WhoIs unavailable must fail before any RFB connection');
  whoisMode = 'trusted';

  // Without a client certificate the mTLS layer rejects the connection.
  const anonymous = connectTls({ host: '127.0.0.1', port: edgePort,
    servername: 'bridge.test.invalid', ca: certificates.ca, rejectUnauthorized: true });
  t.after(() => anonymous.destroy());
  const anonymousOutcome = await new Promise(resolve => {
    const deadline = setTimeout(() => resolve('timeout'), 1500);
    let sawData = false;
    anonymous.on('data', () => { sawData = true; });
    anonymous.once('error', () => { clearTimeout(deadline); resolve(sawData ? 'data' : 'rejected'); });
    anonymous.once('close', () => { clearTimeout(deadline); resolve(sawData ? 'data' : 'rejected'); });
  });
  assert.equal(anonymousOutcome, 'rejected');
  assert.equal(upstreamAccepts, 0);

  // A different CA-valid client cannot borrow viewerA's spoofed HTTP identity.
  assert.match((await responseCode(open({ peer: certificates.viewerB }))).toString('latin1'), /^HTTP\/1\.1 403/);
  assert.equal(upstreamAccepts, 0);
  assert.equal(approvals, 5, 'denied peer/WhoIs never reached host consent callback');

  assert.match((await responseCode(open({ origin: 'https://foreign.test.invalid' }))).toString('latin1'), /^HTTP\/1\.1 403/);
  assert.match((await responseCode(open({ host: 'foreign.test.invalid' }))).toString('latin1'), /^HTTP\/1\.1 403/);
  assert.equal(upstreamAccepts, 0);

  const good = open();
  const actual = await until(good, value => value.includes('RFB 003.008\n'));
  assert.match(actual.toString('latin1'), /^HTTP\/1\.1 101 Switching Protocols/);
  assert.equal(upstreamAccepts, 1);
  assert.equal(bridge.activeSessions(), 1);
  assert.doesNotMatch(actual.toString('latin1'), /\/ws\/session\//,
    'private gateway bearer ticket must never reach peer TLS response');

  // Approved session must block a second authenticated peer/upgrade.
  assert.match((await responseCode(open())).toString('latin1'), /^HTTP\/1\.1 429/);
  revoked.abort();
  await new Promise(resolve => good.once('close', resolve));
  assert.equal(bridge.activeSessions(), 0);
  assert.equal(upstreamAccepts, 1);

  // Reuse the same external path is NOT a bearer: requires new peer auth and
  // a new host-local approval, while old session is irrevocably closed.
  approvalMode = 'deny';
  assert.match((await responseCode(open())).toString('latin1'), /^HTTP\/1\.1 403/);
  assert.equal(upstreamAccepts, 1);
});

test('malformed held-open internal 101 destroys upstream and frees admission slot', async t => {
  const certificates = fixtureCertificates();
  t.after(certificates.cleanup);
  let upstream;
  let upstreamEnd = false;
  const fakeGatewaySockets = new Set();
  const fakeGateway = createHttpServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/api/sessions') {
      res.writeHead(404); res.end(); return;
    }
    req.resume();
    req.on('end', () => {
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ wsPath: `/ws/session/${'A'.repeat(43)}` }));
    });
  });
  fakeGateway.on('connection', socket => {
    fakeGatewaySockets.add(socket);
    socket.once('close', () => fakeGatewaySockets.delete(socket));
  });
  fakeGateway.on('upgrade', (req, socket) => {
    upstream = socket;
    socket.resume(); // Observe peer FIN/RST; Node leaves raw upgraded sockets paused.
    socket.once('end', () => { upstreamEnd = true; });
    // Valid-looking 101 but wrong challenge response; deliberately DO NOT
    // terminate this TCP socket. A rejected edge must tear it down itself.
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n' +
      'Connection: Upgrade\r\nSec-WebSocket-Accept: WRONG\r\n\r\n');
  });
  await new Promise(resolve => fakeGateway.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of fakeGatewaySockets) socket.destroy();
    await new Promise(resolve => fakeGateway.close(resolve));
  });
  const bridge = createTestOnlyMtlsBridge({
    testOnlyEnabled: true,
    tlsOptions: { ...certificates.server, ca: certificates.ca },
    gatewayUrl: `http://127.0.0.1:${fakeGateway.address().port}`,
    upstreamPort: 5901, allowedPeerIds: ['node:viewerA'],
    testWhoIs: async ({ certificate }) => ({ source: 'TEST_TLS_CERT',
      certFingerprint: certificate.fingerprint256, peerNodeId: 'node:viewerA' }),
    testHostConsent: async request => ({ approved: true, scope: 'view-only',
      peerNodeId: request.peerNodeId, hostId: request.hostId,
      sessionId: request.sessionId, epoch: 1, currentEpoch: 1,
      expiresAt: Date.now() + 5_000, signal: new AbortController().signal }),
  });
  const edgePort = await bridge.listen();
  t.after(() => bridge.close());
  const open = () => {
    const socket = client({ port: edgePort, certificates, allowHalfOpen: true });
    t.after(() => socket.destroy());
    return socket;
  };
  const first = open();
  assert.match((await until(first, data => data.includes('\r\n\r\n'))).toString('latin1'), /^HTTP\/1\.1 403/);
  assert.ok(upstream, 'malformed 101 actually came from test-owned gateway TCP socket');
  await waitUntil(() => bridge.activeSessions() === 0 &&
    bridge.activeGatewaySockets() === 0 && upstreamEnd);
  assert.equal(bridge.activeSessions(), 0, 'failed internal upgrade must release capacity');
  assert.equal(bridge.activeGatewaySockets(), 0, 'bridge-owned upstream TCP handle must close');
  assert.equal(upstreamEnd, true, 'malformed gateway peer observes bridge-side FIN');
  // Its deliberately half-open *server-side* socket may stay writeOnly; the
  // bridge cannot force an adversary to close the adversary-owned write half.
  const second = open();
  assert.match((await until(second, data => data.includes('\r\n\r\n'))).toString('latin1'), /^HTTP\/1\.1 403/,
    'next request must attempt admission, not receive a retained 429');
});
