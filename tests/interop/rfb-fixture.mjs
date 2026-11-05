import net from 'node:net';
import { EventEmitter } from 'node:events';

// RFC 6143 RFB 3.3/3.7/3.8 synthetic, loopback-only server. SecurityType None
// is deliberately supported for byte-level interoperability tests ONLY.
const VERSION = Buffer.from('RFB 003.008\n', 'ascii');
const VERSIONS = Object.freeze({
  '3.3': Buffer.from('RFB 003.003\n', 'ascii'),
  '3.7': Buffer.from('RFB 003.007\n', 'ascii'),
  '3.8': VERSION,
});
const MAX_BUFFER = 1024 * 1024;
const MAX_ENCODINGS = 128;
const MAX_CUT_TEXT = 4096;
const DESKTOP_NAME = 'UnboundVNC synthetic framebuffer';
const PIXELS = Buffer.from([
  0x00, 0x00, 0xff, 0x00, // red (little endian BGRX)
  0x00, 0xff, 0x00, 0x00, // green
  0xff, 0x00, 0x00, 0x00, // blue
  0xff, 0xff, 0xff, 0x00, // white
]);

function serverInit() {
  const name = Buffer.from(DESKTOP_NAME, 'utf8');
  const init = Buffer.alloc(24);
  init.writeUInt16BE(2, 0);
  init.writeUInt16BE(2, 2);
  init[4] = 32; // bits per pixel
  init[5] = 24; // color depth
  init[6] = 0; // little endian
  init[7] = 1; // true color
  for (const offset of [8, 10, 12]) init.writeUInt16BE(255, offset);
  init[14] = 16; // red shift
  init[15] = 8;  // green shift
  init[16] = 0;  // blue shift
  init.writeUInt32BE(name.length, 20);
  return Buffer.concat([init, name]);
}

function rawFramebufferUpdate() {
  const header = Buffer.alloc(16);
  header[0] = 0; // FramebufferUpdate
  header.writeUInt16BE(1, 2); // one rectangle
  header.writeUInt16BE(2, 8); // rect width
  header.writeUInt16BE(2, 10); // rect height
  header.writeInt32BE(0, 12); // Raw encoding
  return Buffer.concat([header, PIXELS]);
}

function attachConnection(socket, fixture) {
  const connection = { socket, messages: [], stage: 'version', buffer: Buffer.alloc(0), width: 2, height: 2 };
  fixture.connections.add(connection);
  socket.on('close', () => fixture.connections.delete(connection));

  const fail = (message) => {
    fixture.events.emit('protocolError', connection, new Error(message));
    socket.destroy();
  };
  const publish = (message) => {
    connection.messages.push(message);
    fixture.events.emit('message', connection, message);
  };
  socket.write(fixture.versionGreeting);
  socket.on('data', (chunk) => {
    if (connection.buffer.length + chunk.length > MAX_BUFFER) {
      fail('input buffer exceeded');
      return;
    }
    connection.buffer = Buffer.concat([connection.buffer, chunk]);
    while (connection.buffer.length) {
      const b = connection.buffer;
      let consumed = 0;
      if (connection.stage === 'version') {
        if (b.length < 12) return;
        if (!b.subarray(0, 12).equals(fixture.versionGreeting)) {
          fail('unsupported RFB protocol version');
          return;
        }
        if (fixture.version === '3.3') {
          // RFB 3.3 server-selected U32 security type 1; no selection byte
          // and no SecurityResult for None (RFC 6143 Appendix A.1).
          socket.write(Buffer.from([0, 0, 0, 1]));
          connection.stage = 'client-init';
        } else {
          socket.write(Buffer.from([1, 1])); // 1 security type: None
          connection.stage = 'security';
        }
        consumed = 12;
      } else if (connection.stage === 'security') {
        if (b.length < 1) return;
        consumed = 1;
        if (b[0] !== 1) {
          const reason = Buffer.from('Unsupported security type', 'utf8');
          const result = Buffer.alloc(8);
          result.writeUInt32BE(1, 0);
          result.writeUInt32BE(reason.length, 4);
          socket.end(Buffer.concat([result, reason]));
          connection.stage = 'closing';
        } else {
          // RFB 3.7 None omits SecurityResult; 3.8 includes it.
          if (fixture.version === '3.8') socket.write(Buffer.alloc(4));
          connection.stage = 'client-init';
        }
      } else if (connection.stage === 'client-init') {
        if (b.length < 1) return;
        if (b[0] !== 0 && b[0] !== 1) {
          fail('invalid ClientInit shared flag');
          return;
        }
        connection.shared = Boolean(b[0]);
        socket.write(serverInit());
        connection.stage = 'ready';
        consumed = 1;
      } else if (connection.stage === 'ready') {
        const type = b[0];
        if (type === 0) {
          if (b.length < 20) return;
          if (b[1] !== 0 || b[2] !== 0 || b[3] !== 0) {
            fail('invalid SetPixelFormat padding');
            return;
          }
          const pf = b.subarray(4, 20);
          // Fixture only sends one fixed 32bpp pixel format; allow clients to
          // repeat it, but reject format changes we cannot faithfully encode.
          if (pf[0] !== 32 || pf[1] !== 24 || pf[2] !== 0 || pf[3] !== 1 ||
              pf.readUInt16BE(4) !== 255 || pf.readUInt16BE(6) !== 255 ||
              pf.readUInt16BE(8) !== 255 || pf[10] !== 16 || pf[11] !== 8 || pf[12] !== 0) {
            fail('unsupported pixel format');
            return;
          }
          consumed = 20;
          publish({ type: 'pixel-format' });
        } else if (type === 2) {
          if (b.length < 4) return;
          const count = b.readUInt16BE(2);
          if (count > MAX_ENCODINGS) {
            fail('too many encodings');
            return;
          }
          const length = 4 + 4 * count;
          if (b.length < length) return;
          const encodings = [];
          for (let i = 0; i < count; i++) encodings.push(b.readInt32BE(4 + 4 * i));
          consumed = length;
          publish({ type: 'encodings', encodings });
        } else if (type === 3) {
          if (b.length < 10) return;
          const request = {
            type: 'framebuffer-request', incremental: Boolean(b[1]),
            x: b.readUInt16BE(2), y: b.readUInt16BE(4),
            width: b.readUInt16BE(6), height: b.readUInt16BE(8),
          };
          if (!request.width || !request.height || request.x + request.width > connection.width || request.y + request.height > connection.height) {
            fail('invalid framebuffer bounds');
            return;
          }
          consumed = 10;
          publish(request);
          // A full-screen Raw rectangle is sent regardless of requested
          // subrectangle, so consumers should request the full 2x2 screen.
          if (fixture.autoRespond) socket.write(rawFramebufferUpdate());
        } else if (type === 4) {
          if (b.length < 8) return;
          consumed = 8;
          if (b[1] !== 0 && b[1] !== 1) {
            fail('invalid key-down flag');
            return;
          }
          publish({ type: 'key', down: Boolean(b[1]), key: b.readUInt32BE(4) });
        } else if (type === 5) {
          if (b.length < 6) return;
          consumed = 6;
          publish({ type: 'pointer', mask: b[1], x: b.readUInt16BE(2), y: b.readUInt16BE(4) });
        } else if (type === 6) {
          if (b.length < 8) return;
          const size = b.readUInt32BE(4);
          if (size > MAX_CUT_TEXT) {
            fail('cut text too large');
            return;
          }
          if (b.length < 8 + size) return;
          consumed = 8 + size;
          publish({ type: 'cut-text', text: b.subarray(8, consumed).toString('latin1') });
        } else {
          fail(`unsupported client message type ${type}`);
          return;
        }
      } else {
        return; // Closing
      }
      connection.buffer = connection.buffer.subarray(consumed);
    }
  });
  socket.on('error', () => {}); // Client disconnects should not crash tests
  return connection;
}

export function createRfbFixture({ version = '3.8', autoRespond = true } = {}) {
  if (!Object.hasOwn(VERSIONS, version)) throw new Error('unsupported synthetic RFB version');
  const events = new EventEmitter();
  const connections = new Set();
  const server = net.createServer((socket) => attachConnection(socket, fixture));
  let listening = false;
  const fixture = {
    events,
    connections,
    version,
    autoRespond,
    versionGreeting: VERSIONS[version],
    resize(width, height) {
      if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 4096 || height > 4096) {
        throw new Error('invalid synthetic framebuffer size');
      }
      for (const connection of connections) {
        connection.width = width;
        connection.height = height;
      }
    },
    get host() { return '127.0.0.1'; },
    get port() { return server.address()?.port ?? null; },
    async start() {
      if (listening) throw new Error('fixture already started');
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      });
      listening = true;
      return fixture;
    },
    async close() {
      for (const connection of connections) connection.socket.destroy();
      if (listening) {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        listening = false;
      }
    },
  };
  return fixture;
}

export const fixtureProtocol = Object.freeze({ VERSION: VERSION.toString('ascii'), DESKTOP_NAME, PIXELS });
