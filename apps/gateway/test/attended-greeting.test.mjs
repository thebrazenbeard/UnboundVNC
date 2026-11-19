import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, connect } from 'node:net';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createGateway } from '../src/server.mjs';

async function ticket(url, port) {
  const res = await fetch(new URL('/api/sessions', url), {
    method: 'POST',
    headers: { Origin: url, 'content-type': 'application/json' },
    body: JSON.stringify({ host: '127.0.0.1', port }),
  });
  assert.equal(res.status, 201);
  return (await res.json()).wsPath;
}

async function open(url, path, maxMs) {
  const target = new URL(url);
  const socket = connect({ host: '127.0.0.1', port: Number(target.port) });
  socket.on('error', () => {});
  const key = randomBytes(16).toString('base64');
  const request = [
    'GET ' + path + ' HTTP/1.1',
    'Host: ' + target.host,
    'Origin: ' + target.origin,
    'Connection: Upgrade',
    'Upgrade: websocket',
    'Sec-WebSocket-Key: ' + key,
    'Sec-WebSocket-Version: 13',
    '', '',
  ].join('\r\n');
  socket.write(request);
  try {
    const response = await new Promise((resolve,reject) => {
      let received = '';
      const timer = setTimeout(() => reject(new Error('WAIT_FOR_ATTENDED_GREETING_TIMEOUT')), maxMs);
      socket.on('data', chunk => {
        received += chunk.toString('binary');
        if (received.includes('\r\n\r\n')) {
          clearTimeout(timer);
          resolve(received);
        }
      });
      socket.once('close', () => {
        clearTimeout(timer);
        reject(new Error('WEBSOCKET_UPGRADE_FAILED_BEFORE_CONSENT'));
      });
    });
    if (!response.startsWith('HTTP/1.1 101 Switching Protocols')) {
      throw new Error('UPGRADE_STATUS_NOT_101');
    }
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  }
}
test('explicit single-session attended mode allows a bounded slow local approval greeting', { timeout: 11000 }, async t => {
  const upstream = createServer(socket => {
    socket.on('error', () => {});
    const timer = setTimeout(() => { if (!socket.destroyed) socket.write('RFB 003.008\n'); }, 5400);
    socket.on('close', () => clearTimeout(timer));
  });
  const sockets = new Set();
  upstream.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const gateway = createGateway({
    port: 0, allowedPorts: [upstream.address().port],
    greetingTimeoutMs: 8000, maxSessions: 1,
  });
  const url = await gateway.listen();
  let ws;
  t.after(async () => {
    ws?.destroy();
    for (const sock of sockets) sock.destroy();
    await gateway.close();
    await new Promise(resolve => upstream.close(resolve));
  });
  const path = await ticket(url, upstream.address().port);
  ws = await open(url, path, 7100);
  assert.equal(ws.destroyed, false);
});

test('attended greeting extension refuses unsafe unlimited slots or timeouts', () => {
  assert.throws(() => createGateway({ port: 0, greetingTimeoutMs: 60001, maxSessions: 1 }), /greeting|timeout/i);
  assert.throws(() => createGateway({ port: 0, greetingTimeoutMs: 45000, maxSessions: 8 }), /attended|single.session/i);
  assert.throws(() => createGateway({ port: 0, maxSessions: 0 }), /sessions/i);
  assert.throws(() => createGateway({ port: 0, greetingTimeoutMs: 45000, maxSessions: 1, allowedPorts: [5900,5901] }), /single.target/i);
});
test('bounded attended approval uses only one pending upstream slot', { timeout: 9000 }, async t => {
  const upstream = createServer(socket => socket.on('error', () => {}));
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const sockets = new Set();
  upstream.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  const gateway = createGateway({
    port: 0, allowedPorts: [upstream.address().port],
    greetingTimeoutMs: 8000, maxSessions: 1,
  });
  const url = await gateway.listen();
  let first, second;
  t.after(async () => {
    first?.destroy(); second?.destroy();
    for (const sock of sockets) sock.destroy();
    await gateway.close();
    await new Promise(resolve => upstream.close(resolve));
  });
  function sendUpgrade(path) {
    const address = new URL(url);
    const socket = connect({ host: address.hostname, port: Number(address.port) });
    socket.on('error', () => {});
    socket.write([
      'GET ' + path + ' HTTP/1.1',
      'Host: ' + address.host,
      'Origin: ' + address.origin,
      'Connection: Upgrade', 'Upgrade: websocket',
      'Sec-WebSocket-Key: ' + randomBytes(16).toString('base64'),
      'Sec-WebSocket-Version: 13', '', '',
    ].join('\r\n'));
    return socket;
  }
  const upstreamAccepted = once(upstream, 'connection');
  first = sendUpgrade(await ticket(url, upstream.address().port));
  await upstreamAccepted;
  second = sendUpgrade(await ticket(url, upstream.address().port));
  const response = await Promise.race([
    new Promise((resolve,reject) => {
      let data = '';
      second.on('data', chunk => {
        data += chunk.toString('ascii');
        if (data.includes('\r\n\r\n')) resolve(data);
      });
      second.once('close', () => {
        if (!data.includes('\r\n\r\n')) reject(new Error('second admission closed without HTTP reply'));
      });
    }),
    new Promise((_,reject) => setTimeout(() => reject(new Error('single slot not enforced')), 1500)),
  ]);
  assert.match(response, /^HTTP\/1\.1 429 Too Many Requests/);
  assert.equal(first.destroyed, false);
});