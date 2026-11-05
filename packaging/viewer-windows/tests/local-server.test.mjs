import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer, request as httpRequest } from 'node:http';
import { connect as connectTcp } from 'node:net';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createGateway } from '../../../apps/gateway/src/server.mjs';
import { startLocalViewer } from '../local-server.mjs';
const require = createRequire(import.meta.url);
const { isTrustedResource, isTrustedNavigation } = require('../resource-policy.cjs');

let scratch;
let wrapper;

before(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'unboundvnc-desktop-contract-'));
  await mkdir(join(scratch, 'assets'));
  await writeFile(join(scratch, 'index.html'), '<!doctype html><title>Local desktop fixture</title>');
  await writeFile(join(scratch, 'assets/viewer.js'), 'export const loaded = true;');
  wrapper = await startLocalViewer({ staticRoot: scratch, createGateway });
});
after(async () => {
  await wrapper?.close();
  if (scratch && scratch.startsWith(join(tmpdir(), 'unboundvnc-desktop-contract-'))) {
    await rm(scratch, { recursive: true, force: true });
  }
});

function call(path, { method = 'GET', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(new URL(path, wrapper.url), { method, headers, timeout: 3000 }, res => {
      const parts = [];
      res.on('data', part => parts.push(part));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts).toString('utf8') }));
    });
    req.once('error', reject);
    req.end(body);
  });
}

test('viewer assets are served on a random loopback port with restrictive CSP', async () => {
  const endpoint = new URL(wrapper.url);
  assert.equal(endpoint.hostname, '127.0.0.1');
  assert.notEqual(Number(endpoint.port), 5173);
  const page = await call('/');
  assert.equal(page.status, 200);
  assert.match(page.body, /Local desktop fixture/);
  assert.match(page.headers['content-security-policy'], /default-src 'none'/);
  assert.equal((await call('/assets/viewer.js')).status, 200);
  assert.equal((await call('/does-not-exist')).status, 404);
});

test('HTTP host spoof and unsafe API origin cannot access local session issuance', async () => {
  assert.equal((await call('/', { headers: { Host: 'evil.example' } })).status, 403);
  assert.equal((await call('/api/sessions', { method: 'POST', headers: { Origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{"host":"127.0.0.1","port":5900}' })).status, 403);
  assert.equal((await call('/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"host":"127.0.0.1","port":5900}' })).status, 403);
  assert.equal((await call('/api/sessions', { method: 'POST', headers: { Origin: wrapper.url.slice(0, -1), 'content-type': 'application/json' }, body: '{"host":"192.168.1.9","port":5900}' })).status, 400);
});

test('gateway is alive only through wrapper and still enforces allowed RFB ports', async () => {
  const health = await call('/api/health');
  assert.equal(health.status, 200);
  assert.equal(JSON.parse(health.body).remoteAccess, false);
  const headers = { Origin: wrapper.url.slice(0, -1), 'content-type': 'application/json' };
  const badPort = await call('/api/sessions', { method: 'POST', headers, body: '{"host":"127.0.0.1","port":23456}' });
  assert.equal(badPort.status, 403);
  const ticket = await call('/api/sessions', { method: 'POST', headers, body: '{"host":"127.0.0.1","port":5901}' });
  assert.equal(ticket.status, 201);
  assert.match(JSON.parse(ticket.body).wsPath, /^\/ws\/session\/[A-Za-z0-9_-]{43}$/);
});

test('untrusted WebSocket origin is rejected before reaching gateway', async () => {
  const url = new URL(wrapper.url);
  const reply = await new Promise((resolve, reject) => {
    const socket = connectTcp(Number(url.port), '127.0.0.1');
    let data = '';
    socket.setTimeout(3000, () => socket.destroy(new Error('upgrade timeout')));
    socket.once('error', reject);
    socket.on('data', chunk => { data += chunk.toString('ascii'); if (data.includes('\r\n\r\n')) { resolve(data); socket.destroy(); } });
    socket.once('connect', () => socket.write([
      `GET /ws/session/${'A'.repeat(43)} HTTP/1.1`, `Host: ${url.host}`,
      'Origin: https://evil.example', 'Upgrade: websocket', 'Connection: Upgrade',
      'Sec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==', 'Sec-WebSocket-Version: 13', '', '',
    ].join('\r\n')));
  });
  assert.match(reply, /^HTTP\/1\.1 403 Forbidden/);
});

test('source desktop entry has sandboxed renderer and no background service registration', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../main.cjs', import.meta.url), 'utf8');
  for (const part of ['nodeIntegration: false', 'contextIsolation: true', 'sandbox: true', 'webSecurity: true', "action: 'deny'", 'setPermissionRequestHandler', "app.on('before-quit'"]) {
    assert.ok(source.includes(part), part);
  }
  assert.doesNotMatch(source, /New-Service|Start-Service|New-NetFirewallRule|app\.setLoginItemSettings|autoUpdater/);
});

test('Electron resource policy permits only matching HTTP and WebSocket loopback authority', () => {
  const trust = 'http://127.0.0.1:49123';
  assert.equal(isTrustedResource('http://127.0.0.1:49123/assets/viewer.js', trust), true);
  assert.equal(isTrustedResource('ws://127.0.0.1:49123/ws/session/token', trust), true);
  for (const unsafe of [
    'ws://127.0.0.1:49124/ws/session/token',
    'ws://evil.example:49123/ws/session/token',
    'wss://127.0.0.1:49123/ws/session/token',
    'http://127.0.0.1:49124/',
    'https://127.0.0.1:49123/',
    'http://127.0.0.1:49123.evil.example/',
    'file:///C:/sensitive.txt',
    'data:text/html,evil',
  ]) assert.equal(isTrustedResource(unsafe, trust), false, unsafe);
  assert.equal(isTrustedNavigation('http://127.0.0.1:49123/#devices', trust), true);
  assert.equal(isTrustedNavigation('http://127.0.0.1:49123/other-page', trust), false);
  assert.equal(isTrustedNavigation('http://127.0.0.1:49123.evil.example/', trust), false);
  assert.equal(isTrustedNavigation('ws://127.0.0.1:49123/', trust), false);
});
