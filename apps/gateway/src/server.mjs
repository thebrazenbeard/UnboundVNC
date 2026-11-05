import { createServer } from 'node:http';
import { connect } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const MAX_BODY = 1024;
const MAX_FRAME = 1024 * 1024;
const MAX_BUFFERED = MAX_FRAME + 14;
const TICKET_MS = 30_000;
const HEARTBEAT_MS = 30_000;
const MAX_SOCKETS = 8;
const CLOSE_GRACE_MS = 500;
const utf8 = new TextDecoder('utf-8', { fatal: true });

/** Optional CLI allowlist: comma-separated TCP ports, with no wildcard or range syntax. */
export function parseAllowedPorts(value) {
  if (value === undefined) return [5900];
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,4}(,[1-9][0-9]{0,4})*$/.test(value)) {
    throw new Error('UNBOUNDVNC_GATEWAY_ALLOWED_PORTS must be comma-separated TCP ports');
  }
  const ports = value.split(',').map(Number);
  if (ports.length > 32 || ports.some(port => port > 65535) || new Set(ports).size !== ports.length) {
    throw new Error('UNBOUNDVNC_GATEWAY_ALLOWED_PORTS requires 1-32 unique valid TCP ports');
  }
  return ports;
}

function validClosePayload(payload) {
  if (payload.length === 0) return true;
  if (payload.length === 1) return false;
  const code = payload.readUInt16BE(0);
  if (!((code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) || (code >= 3000 && code <= 4999))) return false;
  try { utf8.decode(payload.subarray(2)); return true; } catch { return false; }
}

function sendJson(res, status, value) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  });
  res.end(JSON.stringify(value));
}

function rejectUpgrade(socket, code = 403) {
  const reason = { 400: 'Bad Request', 403: 'Forbidden', 404: 'Not Found', 429: 'Too Many Requests' }[code] ?? 'Forbidden';
  socket.end(`HTTP/1.1 ${code} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function frame(opcode, payload = Buffer.alloc(0)) {
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x80 | opcode, n]) : n <= 65535
    ? Buffer.from([0x80 | opcode, 126, n >> 8, n & 255])
    : Buffer.from([0x80 | opcode, 127, 0, 0, 0, 0, (n / 2 ** 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
  return Buffer.concat([head, payload]);
}

function validHostHeader(req, localPort) {
  return [`127.0.0.1:${localPort}`, `localhost:${localPort}`, '127.0.0.1:5173', 'localhost:5173'].includes(req.headers.host);
}

function validOrigin(req, localPort) {
  return [`http://127.0.0.1:${localPort}`, `http://localhost:${localPort}`, 'http://127.0.0.1:5173', 'http://localhost:5173'].includes(req.headers.origin);
}

/** Local-only WebSocket/RFB bridge. Call gateway.listen() before using it. */
export function createGateway({ port = 6081, host = '127.0.0.1', allowedPorts = [5900], heartbeatMs = HEARTBEAT_MS } = {}) {
  if (host !== '127.0.0.1' || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('Gateway must bind to IPv4 loopback on a valid port');
  }
  if (!Array.isArray(allowedPorts) || allowedPorts.length === 0 || allowedPorts.length > 32 ||
      allowedPorts.some(p => !Number.isInteger(p) || p < 1 || p > 65535)) {
    throw new Error('Gateway requires a nonempty explicit allowlist of valid RFB TCP ports');
  }
  if (!Number.isInteger(heartbeatMs) || heartbeatMs < 10 || heartbeatMs > 300_000) {
    throw new Error('Gateway requires a bounded WebSocket heartbeat interval');
  }
  const permittedPorts = new Set(allowedPorts);
  const tickets = new Map();
  const connections = new Set();
  let localPort = port;

  const server = createServer(async (req, res) => {
    if (!validHostHeader(req, localPort)) return sendJson(res, 403, { error: 'invalid_host' });
    if (req.url === '/api/health' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, transport: 'local-rfb-websocket', remoteAccess: false });
    }
    if (req.url !== '/api/sessions' || req.method !== 'POST') return sendJson(res, 404, { error: 'not_found' });
    // The browser is the intended caller. Require an exact allowed Origin to prevent CSRF.
    if (!validOrigin(req, localPort) || req.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
      return sendJson(res, 403, { error: 'origin_or_content_type' });
    }
    let chunks = [];
    let size = 0;
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY) return sendJson(res, 413, { error: 'too_large' });
        chunks.push(chunk);
      }
      const target = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!target || !['localhost', '127.0.0.1'].includes(target.host) || !Number.isInteger(target.port) || target.port < 1 || target.port > 65535) {
        return sendJson(res, 400, { error: 'target_must_be_loopback' });
      }
      if (!permittedPorts.has(target.port)) return sendJson(res, 403, { error: 'target_port_not_allowed' });
      for (const [key, ticket] of tickets) if (ticket.expires < Date.now()) tickets.delete(key);
      if (tickets.size >= 64) return sendJson(res, 429, { error: 'too_many_tickets' });
      const id = randomBytes(32).toString('base64url');
      const expiresAt = new Date(Date.now() + TICKET_MS).toISOString();
      tickets.set(id, { port: target.port, expires: Date.now() + TICKET_MS });
      return sendJson(res, 201, { id, wsPath: `/ws/session/${id}`, expiresAt });
    } catch {
      return sendJson(res, 400, { error: 'invalid_json' });
    }
  });

  server.on('upgrade', (req, ws, head) => {
    if (!validHostHeader(req, localPort) || !validOrigin(req, localPort)) return rejectUpgrade(ws);
    const match = /^\/ws\/session\/([A-Za-z0-9_-]{43})$/.exec(req.url ?? '');
    if (!match) return rejectUpgrade(ws, 404);
    const ticket = tickets.get(match[1]);
    // Consume regardless of failure, preventing replay, including during TCP connect.
    tickets.delete(match[1]);
    if (!ticket || ticket.expires < Date.now()) return rejectUpgrade(ws);
    if (connections.size >= MAX_SOCKETS) return rejectUpgrade(ws, 429);
    const key = req.headers['sec-websocket-key'];
    const decoded = typeof key === 'string' ? Buffer.from(key, 'base64') : Buffer.alloc(0);
    if (req.headers.upgrade?.toLowerCase() !== 'websocket' || !req.headers.connection?.toLowerCase().split(',').map(s => s.trim()).includes('upgrade') || req.headers['sec-websocket-version'] !== '13' || decoded.length !== 16 || Buffer.from(decoded).toString('base64') !== key) {
      return rejectUpgrade(ws, 400);
    }

    const rfb = connect({ host: '127.0.0.1', port: ticket.port });
    let upgraded = false;
    let closed = false;
    let rejecting = false;
    // Never repeatedly concatenate a nearly complete 1 MiB frame when a
    // peer feeds us tiny TCP reads. A frame is copied at most when appended
    // and, if necessary, once when compacting the bounded receive window.
    const greeting = Buffer.allocUnsafe(12);
    let greetingLength = 0;
    const buffered = Buffer.allocUnsafe(MAX_BUFFERED);
    let bufferStart = 0;
    let bufferEnd = 0;
    let fragment = false;
    let heartbeatTimer;
    let expectedPong = null;
    let closeTimer;
    // net.Socket#setTimeout is an *idle* timeout, which a peer can reset by
    // slowly dripping a partial RFB banner. Reserve scarce admission slots
    // for at most five seconds of total upstream handshake time instead.
    const greetingDeadline = setTimeout(forceCleanup, 5_000);
    greetingDeadline.unref();
    function scheduleCloseDeadline() {
      // ws.end() sends our Close+FIN but does not require the peer to send
      // its own FIN. Keep the connection counted until the socket closes,
      // with a bounded deadline for a peer that deliberately half-opens TCP.
      closeTimer = setTimeout(() => ws.destroy(), CLOSE_GRACE_MS);
      closeTimer.unref();
    }
    function cleanup(closePayload) {
      if (closed) return;
      closed = true;
      clearTimeout(greetingDeadline);
      clearInterval(heartbeatTimer);
      rfb.destroy();
      if (!rejecting) {
        // A valid masked Close deserves a matching Close reply before TCP FIN.
        // Error/timeout/abrupt transport teardown still destroys immediately.
        if (Buffer.isBuffer(closePayload)) {
          ws.end(frame(8, closePayload));
          scheduleCloseDeadline();
        }
        else ws.destroy();
      } else scheduleCloseDeadline();
    }
    function forceCleanup() {
      cleanup();
      clearTimeout(closeTimer);
      ws.destroy();
    }
    connections.add(forceCleanup);
    ws.on('error', forceCleanup);
    // An upgraded HTTP socket can receive FIN without reaching 'close' yet.
    // Release its RFB peer on the readable half-close as well.
    ws.on('end', forceCleanup);
    ws.on('close', () => {
      clearTimeout(closeTimer);
      connections.delete(forceCleanup);
      cleanup();
    });
    // rfb.destroy() during a valid WS Close asynchronously emits 'close'.
    // It must not preempt the outbound WebSocket Close echo.
    rfb.on('error', () => { if (!closed) forceCleanup(); });
    rfb.on('close', () => { if (!closed) forceCleanup(); });
    function acceptRfb() {
      clearTimeout(greetingDeadline);
      const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
      ws.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      upgraded = true;
      // A quiet remote desktop is still an active session. Probe the browser
      // instead of disconnecting solely because no framebuffer changed.
      heartbeatTimer = setInterval(() => {
        if (expectedPong) return cleanup();
        expectedPong = randomBytes(8);
        ws.write(frame(9, expectedPong));
      }, heartbeatMs);
      heartbeatTimer.unref();
      if (head.length) ingest(head);
    }
    rfb.on('data', data => {
      if (closed) return;
      if (!upgraded) {
        const length = Math.min(12 - greetingLength, data.length);
        data.copy(greeting, greetingLength, 0, length);
        greetingLength += length;
        if (greetingLength < 12) return;
        if (!/^RFB [0-9]{3}\.[0-9]{3}\n$/.test(greeting.toString('ascii'))) {
          rejecting = true;
          rejectUpgrade(ws, 403);
          return cleanup();
        }
        acceptRfb();
        if (closed) return;
        // Preserve the exact RFB byte stream if the greeting and next protocol
        // bytes arrived in one TCP read, without buffering that whole read.
        if (!ws.write(frame(2, greeting))) rfb.pause();
        data = data.subarray(length);
        if (!data.length) return;
      }
      if (!ws.write(frame(2, data))) rfb.pause();
    });
    ws.on('drain', () => rfb.resume());
    rfb.on('drain', () => ws.resume());
    ws.on('data', data => { if (upgraded && !closed) ingest(data); });
    function ingest(data) {
      // A TCP read may contain many frames, or one frame may arrive one byte
      // at a time. A fixed sliding window bounds memory and total copying.
      let offset = 0;
      while (offset < data.length && !closed) {
        if (bufferEnd === MAX_BUFFERED) {
          if (bufferStart === 0) return cleanup();
          buffered.copyWithin(0, bufferStart, bufferEnd);
          bufferEnd -= bufferStart;
          bufferStart = 0;
        }
        const count = Math.min(MAX_BUFFERED - bufferEnd, data.length - offset);
        data.copy(buffered, bufferEnd, offset, offset + count);
        bufferEnd += count;
        offset += count;
        parseBuffered();
      }
    }
    function parseBuffered() {
      while (bufferEnd - bufferStart >= 2) {
        const available = bufferEnd - bufferStart;
        const first = buffered[bufferStart];
        const second = buffered[bufferStart + 1];
        const opcode = first & 15;
        const fin = Boolean(first & 0x80);
        const masked = Boolean(second & 0x80);
        if (!masked || (first & 0x70) || ![0, 2, 8, 9, 10].includes(opcode)) return cleanup();
        // Control frames must be unfragmented and contain at most 125 bytes;
        // reject their invalid length markers before waiting for the payload.
        if (opcode >= 8 && (!fin || (second & 127) > 125)) return cleanup();
        let payloadSize = second & 127;
        let header = 2;
        if (payloadSize === 126) {
          if (available < 4) return;
          payloadSize = buffered.readUInt16BE(bufferStart + 2); header = 4;
          if (payloadSize < 126) return cleanup();
        } else if (payloadSize === 127) {
          if (available < 10) return;
          const big = buffered.readBigUInt64BE(bufferStart + 2);
          if (big <= 65535n) return cleanup();
          if (big > BigInt(MAX_FRAME)) return cleanup();
          payloadSize = Number(big); header = 10;
        }
        if (payloadSize > MAX_FRAME) return cleanup();
        if (available < header + 4 + payloadSize) return;
        const mask = buffered.subarray(bufferStart + header, bufferStart + header + 4);
        const payload = Buffer.from(buffered.subarray(bufferStart + header + 4, bufferStart + header + 4 + payloadSize));
        bufferStart += header + 4 + payloadSize;
        if (bufferStart === bufferEnd) bufferStart = bufferEnd = 0;
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        if (opcode === 8) {
          if (!validClosePayload(payload)) return cleanup();
          return cleanup(payload);
        }
        if (opcode === 9) { ws.write(frame(10, payload)); continue; }
        if (opcode === 10) {
          // RFC 6455 permits unsolicited Pong. Only the matching outstanding
          // challenge proves that this peer read our most recent Ping.
          if (expectedPong?.equals(payload)) expectedPong = null;
          continue;
        }
        if (opcode === 0 && !fragment || opcode === 2 && fragment) return cleanup();
        fragment = !fin;
        if (!rfb.write(payload)) ws.pause();
      }
    }
  });

  return {
    server,
    async listen() {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
      localPort = server.address().port;
      return `http://127.0.0.1:${localPort}`;
    },
    async close() {
      for (const c of connections) c();
      await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const gateway = createGateway({
    port: Number(process.env.UNBOUNDVNC_GATEWAY_PORT ?? 6081),
    allowedPorts: parseAllowedPorts(process.env.UNBOUNDVNC_GATEWAY_ALLOWED_PORTS),
  });
  gateway.listen().then(url => process.stdout.write(`UnboundVNC local RFB gateway: ${url}\n`)).catch(error => { console.error(error); process.exitCode = 1; });
}
