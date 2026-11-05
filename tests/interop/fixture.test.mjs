import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { createRfbFixture, fixtureProtocol } from './rfb-fixture.mjs';

// Byte-stream reader: TCP messages can arrive fragmented or coalesced.
async function connect(t) {
  const fixture = await createRfbFixture().start();
  t.after(async () => fixture.close());
  const socket = net.connect({ host: fixture.host, port: fixture.port });
  t.after(() => socket.destroy());
  socket.on('error', () => {});
  let pending = Buffer.alloc(0);
  let wake = () => {};
  let closed = false;
  socket.on('data', (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    wake();
  });
  socket.on('close', () => {
    closed = true;
    wake();
  });
  await once(socket, 'connect');
  const read = async (size) => {
    const deadline = Date.now() + 2000;
    while (pending.length < size) {
      if (closed) throw new Error(`socket closed before ${size} bytes arrived`);
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`timed out reading ${size} bytes`);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          wake = () => {};
          reject(new Error(`timed out reading ${size} bytes`));
        }, remaining);
        wake = () => {
          clearTimeout(timer);
          wake = () => {};
          resolve();
        };
      });
    }
    const result = pending.subarray(0, size);
    pending = pending.subarray(size);
    return result;
  };
  return { fixture, socket, read };
}

async function initialize(t) {
  const c = await connect(t);
  assert.equal((await c.read(12)).toString('ascii'), fixtureProtocol.VERSION);
  c.socket.write(fixtureProtocol.VERSION);
  assert.deepEqual(await c.read(2), Buffer.from([1, 1]));
  c.socket.write(Buffer.from([1]));
  assert.equal((await c.read(4)).readUInt32BE(), 0);
  c.socket.write(Buffer.from([1]));
  const init = await c.read(24);
  assert.equal(init.readUInt16BE(0), 2);
  assert.equal(init.readUInt16BE(2), 2);
  assert.deepEqual([...init.subarray(4, 8)], [32, 24, 0, 1]);
  assert.deepEqual([init.readUInt16BE(8), init.readUInt16BE(10), init.readUInt16BE(12)], [255, 255, 255]);
  assert.deepEqual([...init.subarray(14, 17)], [16, 8, 0]);
  const name = await c.read(init.readUInt32BE(20));
  assert.equal(name.toString('utf8'), fixtureProtocol.DESKTOP_NAME);
  return c;
}

test('RFB 3.8 greeting, None handshake, ServerInit and raw 2x2 framebuffer', async (t) => {
  const c = await initialize(t);
  const request = Buffer.from([3, 0, 0, 0, 0, 0, 0, 2, 0, 2]);
  const next = once(c.fixture.events, 'message');
  c.socket.write(request);
  const [, message] = await next;
  assert.deepEqual(message, { type: 'framebuffer-request', incremental: false, x: 0, y: 0, width: 2, height: 2 });
  const rect = await c.read(16);
  assert.equal(rect[0], 0); // FramebufferUpdate
  assert.equal(rect.readUInt16BE(2), 1);
  assert.deepEqual([rect.readUInt16BE(4), rect.readUInt16BE(6), rect.readUInt16BE(8), rect.readUInt16BE(10)], [0, 0, 2, 2]);
  assert.equal(rect.readInt32BE(12), 0); // Raw encoding
  assert.deepEqual(await c.read(16), fixtureProtocol.PIXELS);
});

test('key, pointer and clipboard events are decoded from real client bytes', async (t) => {
  const c = await initialize(t);
  let next = once(c.fixture.events, 'message');
  c.socket.write(Buffer.from([4, 1, 0, 0, 0, 0, 0, 0x61]));
  assert.deepEqual((await next)[1], { type: 'key', down: true, key: 97 });

  next = once(c.fixture.events, 'message');
  c.socket.write(Buffer.from([5, 1, 0, 1, 0, 0]));
  assert.deepEqual((await next)[1], { type: 'pointer', mask: 1, x: 1, y: 0 });

  next = once(c.fixture.events, 'message');
  c.socket.write(Buffer.from([6, 0, 0, 0, 0, 0, 0, 3, 0x61, 0x62, 0x63]));
  assert.deepEqual((await next)[1], { type: 'cut-text', text: 'abc' });
});

test('unsupported security type is rejected with RFB 3.8 failure reason', async (t) => {
  const c = await connect(t);
  assert.equal((await c.read(12)).toString('ascii'), fixtureProtocol.VERSION);
  c.socket.write(fixtureProtocol.VERSION);
  assert.deepEqual(await c.read(2), Buffer.from([1, 1]));
  c.socket.write(Buffer.from([2]));
  const result = await c.read(8);
  assert.equal(result.readUInt32BE(0), 1);
  assert.match((await c.read(result.readUInt32BE(4))).toString(), /Unsupported security type/);
});

test('malformed RFB client version is rejected, connection closed', async (t) => {
  const c = await connect(t);
  await c.read(12);
  const error = once(c.fixture.events, 'protocolError');
  c.socket.write('RFB 003.007\n');
  assert.match((await error)[1].message, /unsupported RFB protocol version/);
  await once(c.socket, 'close');
});

test('out-of-bounds framebuffer request is rejected', async (t) => {
  const c = await initialize(t);
  const error = once(c.fixture.events, 'protocolError');
  c.socket.write(Buffer.from([3, 0, 0, 0, 0, 0, 0, 3, 0, 2]));
  assert.match((await error)[1].message, /invalid framebuffer bounds/);
});

test('excessive SetEncodings count is rejected without buffer allocation', async (t) => {
  const c = await initialize(t);
  const error = once(c.fixture.events, 'protocolError');
  c.socket.write(Buffer.from([2, 0, 0, 129]));
  assert.match((await error)[1].message, /too many encodings/);
});

test('RFB 3.3 downgrade is rejected before security negotiation', async (t) => {
  const c = await connect(t);
  assert.equal((await c.read(12)).toString('ascii'), fixtureProtocol.VERSION);
  const error = once(c.fixture.events, 'protocolError');
  const closed = once(c.socket, 'close');
  c.socket.write('RFB 003.003\n');
  assert.match((await error)[1].message, /unsupported RFB protocol version/);
  await closed;
});

test('reserved security selection zero receives RFB 3.8 failure reason', async (t) => {
  const c = await connect(t);
  await c.read(12);
  c.socket.write(fixtureProtocol.VERSION);
  assert.deepEqual(await c.read(2), Buffer.from([1, 1]));
  c.socket.write(Buffer.from([0]));
  const result = await c.read(8);
  assert.equal(result.readUInt32BE(0), 1);
  const reasonLength = result.readUInt32BE(4);
  assert.equal((await c.read(reasonLength)).toString(), 'Unsupported security type');
});

test('invalid ClientInit shared byte closes before ServerInit', async (t) => {
  const c = await connect(t);
  await c.read(12);
  c.socket.write(fixtureProtocol.VERSION);
  assert.deepEqual(await c.read(2), Buffer.from([1, 1]));
  c.socket.write(Buffer.from([1]));
  assert.equal((await c.read(4)).readUInt32BE(0), 0);
  const error = once(c.fixture.events, 'protocolError');
  const closed = once(c.socket, 'close');
  c.socket.write(Buffer.from([2]));
  assert.match((await error)[1].message, /invalid ClientInit shared flag/);
  await closed;
});
