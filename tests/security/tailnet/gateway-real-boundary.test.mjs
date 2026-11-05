import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createGateway } from '../../../apps/gateway/src/server.mjs';

// Unlike mock-admission.test.mjs this exercises the actual HTTP gateway.
// The only listener is an ephemeral IPv4 loopback port. Header values here are
// attacker-controlled strings, NOT trusted Tailscale WhoIs or TLS evidence.
test('forged tailnet identity cannot open a remote route through the real gateway', async t => {
  assert.throws(() => createGateway({ host: '100.101.102.103', port: 0 }), /loopback/);

  const gateway = createGateway({ port: 0, allowedPorts: [5901] });
  const url = await gateway.listen();
  t.after(() => gateway.close());

  const claims = {
    'Tailscale-User-Login': 'pretend-operator@example.invalid',
    'Tailscale-App-Capabilities': '{"remote-desktop":[{"role":"admin"}]}',
    'X-Tailscale-Node-ID': 'node:pretendAuthorizedViewer',
    'X-Forwarded-For': '100.101.102.103',
    'X-Forwarded-Proto': 'https',
  };
  const health = await fetch(`${url}/api/health`, { headers: claims });
  assert.equal(health.status, 200);
  assert.equal((await health.json()).remoteAccess, false);

  const requestTicket = (target, extraHeaders = {}) => fetch(`${url}/api/sessions`, {
    method: 'POST',
    headers: { Origin: url, 'Content-Type': 'application/json', ...claims, ...extraHeaders },
    body: JSON.stringify(target),
  });

  for (const host of ['100.101.102.103', '192.168.1.42', 'host.tailnet.ts.net']) {
    const response = await requestTicket({ host, port: 5901 });
    assert.equal(response.status, 400, `forged identity must not authorize target ${host}`);
    assert.deepEqual(await response.json(), { error: 'target_must_be_loopback' });
  }

  const invalidOrigin = await requestTicket({ host: '127.0.0.1', port: 5901 }, {
    Origin: 'https://host.tailnet.ts.net',
  });
  assert.equal(invalidOrigin.status, 403);
  assert.deepEqual(await invalidOrigin.json(), { error: 'origin_or_content_type' });

  // Explicit raw HTTP client: fetch may normalize a supplied Host header.
  const badHostStatus = await new Promise((resolve, reject) => {
    const endpoint = new URL(url);
    const body = JSON.stringify({ host: '127.0.0.1', port: 5901 });
    const req = request({
      hostname: endpoint.hostname, port: Number(endpoint.port), path: '/api/sessions', method: 'POST',
      headers: { ...claims, Host: 'host.tailnet.ts.net', Origin: url,
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => { res.resume(); res.once('end', () => resolve(res.statusCode)); });
    req.once('error', reject);
    req.end(body);
  });
  assert.equal(badHostStatus, 403);

  // Local RFB remains a valid target. Accepting a local ticket is not proof
  // of real remote identity, encryption, host consent or RFB connectivity.
  const local = await requestTicket({ host: '127.0.0.1', port: 5901 });
  assert.equal(local.status, 201);
  assert.match((await local.json()).wsPath, /^\/ws\/session\/[A-Za-z0-9_-]{43}$/);
});
