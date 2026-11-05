import test from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createGateway } from '../../apps/gateway/src/server.mjs';
import { createRfbFixture, fixtureProtocol } from '../interop/rfb-fixture.mjs';

const TIMEOUT_MS = 3000;

// This is a deliberately small, real masked WebSocket client, not a mocked
// gateway transport. It exercises the gateway's actual HTTP upgrade and
// binary WebSocket framing over an ephemeral loopback TCP connection.
async function openWs(address, path) {
  const endpoint = new URL(address);
  const socket = connect({ host: '127.0.0.1', port: Number(endpoint.port) });
  await once(socket, 'connect', { signal: AbortSignal.timeout(TIMEOUT_MS) });
  const client = {
    socket,
    buffer: Buffer.alloc(0),
    rfbBytes: Buffer.alloc(0),
    httpResult: null,
    waiters: new Set(),
  };
  const wake = () => {
    for (const fn of [...client.waiters]) fn();
  };
  const ingest = chunk => {
    client.buffer = Buffer.concat([client.buffer, chunk]);
    if (!client.httpResult) {
      const end = client.buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      client.httpResult = client.buffer.subarray(0, end + 4).toString('ascii');
      client.buffer = client.buffer.subarray(end + 4);
    }
    if (client.httpResult.startsWith('HTTP/1.1 101')) {
      while (client.buffer.length >= 2) {
        const first = client.buffer[0];
        let length = client.buffer[1] & 0x7f;
        let header = 2;
        if (length === 126) {
          if (client.buffer.length < 4) break;
          length = client.buffer.readUInt16BE(2);
          header = 4;
        } else if (length === 127) {
          if (client.buffer.length < 10) break;
          length = Number(client.buffer.readBigUInt64BE(2));
          header = 10;
        }
        if (length > 1024 * 1024) throw new Error('unexpected oversized fixture frame');
        if (client.buffer.length < header + length) break;
        const payload = client.buffer.subarray(header, header + length);
        client.buffer = client.buffer.subarray(header + length);
        if ((first & 0x0f) === 8) throw new Error('gateway closed WebSocket');
        if ((first & 0x0f) !== 2 && (first & 0x0f) !== 0) continue;
        client.rfbBytes = Buffer.concat([client.rfbBytes, payload]);
      }
    }
    wake();
  };
  socket.on('data', ingest);
  const key = randomBytes(16).toString('base64');
  socket.write(
    'GET ' + path + ' HTTP/1.1\r\n' +
    'Host: 127.0.0.1:' + endpoint.port + '\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ' + key + '\r\n' +
    'Origin: ' + address + '\r\n\r\n'
  );
  async function waitFor(predicate, reason) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        client.waiters.delete(check);
        reject(new Error(reason + ' timed out'));
      }, TIMEOUT_MS);
      function check() {
        const value = predicate();
        if (value === null || value === undefined) return;
        clearTimeout(timer);
        client.waiters.delete(check);
        resolve(value);
      }
      client.waiters.add(check);
      check();
    });
  }
  client.headers = () => waitFor(() => client.httpResult, 'HTTP upgrade');
  client.read = size => waitFor(() => {
    if (client.rfbBytes.length < size) return null;
    const bytes = Buffer.from(client.rfbBytes.subarray(0, size));
    client.rfbBytes = client.rfbBytes.subarray(size);
    return bytes;
  }, 'RFB bytes');
  client.write = payload => {
    const data = Buffer.from(payload);
    const mask = randomBytes(4);
    const prefix = data.length < 126
      ? Buffer.from([0x82, 0x80 | data.length])
      : Buffer.from([0x82, 0xfe, data.length >> 8, data.length & 0xff]);
    const masked = Buffer.from(data);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
    socket.write(Buffer.concat([prefix, mask, masked]));
  };
  return client;
}

test('RFB bytes traverse local gateway to a synthetic RFB server', async t => {
  const rfb = await createRfbFixture().start();
  const gateway = createGateway({ port: 0 });
  const origin = await gateway.listen();
  const clients = [];
  t.after(async () => {
    for (const client of clients) client.socket.destroy();
    await gateway.close();
    await rfb.close();
  });
  const issued = await fetch(origin + '/api/sessions', {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ host: '127.0.0.1', port: rfb.port }),
  });
  assert.equal(issued.status, 201);
  const session = await issued.json();
  const client = await openWs(origin, session.wsPath);
  clients.push(client);
  assert.match(await client.headers(), /^HTTP\/1\.1 101 Switching Protocols/);
  assert.equal((await client.read(12)).toString('ascii'), fixtureProtocol.VERSION);

  // Complete RFB 3.8 SecurityType None, expressly for this local fixture.
  client.write(Buffer.from(fixtureProtocol.VERSION, 'ascii'));
  assert.deepEqual(await client.read(2), Buffer.from([1, 1]));
  client.write(Buffer.from([1]));
  assert.deepEqual(await client.read(4), Buffer.alloc(4));
  client.write(Buffer.from([1]));
  const init = await client.read(24);
  assert.equal(init.readUInt16BE(0), 2);
  assert.equal(init.readUInt16BE(2), 2);
  assert.equal(init[4], 32);
  assert.equal((await client.read(init.readUInt32BE(20))).toString(), fixtureProtocol.DESKTOP_NAME);

  const request = Buffer.alloc(10);
  request[0] = 3;
  request.writeUInt16BE(2, 6);
  request.writeUInt16BE(2, 8);
  client.write(request);
  const update = await client.read(16);
  assert.equal(update[0], 0);
  assert.equal(update.readUInt16BE(2), 1);
  assert.equal(update.readUInt16BE(8), 2);
  assert.equal(update.readUInt16BE(10), 2);
  assert.equal(update.readInt32BE(12), 0);
  assert.deepEqual(await client.read(16), fixtureProtocol.PIXELS);

  const keyEvent = once(rfb.events, 'message', { signal: AbortSignal.timeout(TIMEOUT_MS) });
  const key = Buffer.alloc(8);
  key[0] = 4;
  key[1] = 1;
  key.writeUInt32BE(0x61, 4);
  client.write(key);
  const connection = [...rfb.connections][0];
  const [keyConnection, keyMessage] = await keyEvent;
  assert.equal(keyConnection, connection);
  assert.deepEqual(keyMessage, { type: 'key', down: true, key: 0x61 });

  const pointerEvent = once(rfb.events, 'message', { signal: AbortSignal.timeout(TIMEOUT_MS) });
  client.write(Buffer.from([5, 1, 0, 1, 0, 1]));
  const [pointerConnection, pointerMessage] = await pointerEvent;
  assert.equal(pointerConnection, connection);
  assert.deepEqual(pointerMessage, { type: 'pointer', mask: 1, x: 1, y: 1 });

  const replay = await openWs(origin, session.wsPath);
  clients.push(replay);
  assert.match(await replay.headers(), /^HTTP\/1\.1 403/);
});
