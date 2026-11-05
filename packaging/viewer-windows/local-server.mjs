// Loopback-only static viewer and same-origin proxy for the existing RFB gateway.
// This is owned by the desktop process, not a system service or public listener.
import { createServer, request as httpRequest } from 'node:http';
import { connect as tcpConnect } from 'node:net';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'], ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'], ['.ico', 'image/x-icon'], ['.woff2', 'font/woff2'],
]);
const LOOPBACK = '127.0.0.1';

function reject(res, status) {
  res.writeHead(status, { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end();
}

export async function startLocalViewer({ staticRoot, createGateway, allowedPorts = [5900, 5901] }) {
  if (typeof createGateway !== 'function') throw new TypeError('A reviewed gateway factory is required');
  const assetRoot = await realpath(staticRoot);
  if (!(await stat(assetRoot)).isDirectory()) throw new Error('Built viewer assets are missing');
  const gateway = createGateway({ host: LOOPBACK, port: 0, allowedPorts });
  const gatewayUrl = new URL(await gateway.listen());
  let viewerPort;
  const bridges = new Set();
  let closing = false;

  const sameHost = req => req.headers.host === `${LOOPBACK}:${viewerPort}`;
  const sameOrigin = req => req.headers.origin === `http://${LOOPBACK}:${viewerPort}`;
  const headers = () => ({
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws://${LOOPBACK}:${viewerPort}; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
  });

  const server = createServer(async (req, res) => {
    if (closing || !sameHost(req)) return reject(res, 403);
    const rawPath = req.url ?? '';
    if ((rawPath === '/api/health' && req.method === 'GET') ||
        (rawPath === '/api/sessions' && req.method === 'POST' && sameOrigin(req))) {
      const outbound = httpRequest(new URL(rawPath, gatewayUrl), {
        method: req.method,
        headers: {
          'host': gatewayUrl.host, 'origin': gatewayUrl.origin,
          'content-type': req.headers['content-type'] ?? '',
        },
        timeout: 10_000,
      }, upstream => {
        res.writeHead(upstream.statusCode ?? 502, { ...headers(), 'content-type': 'application/json; charset=utf-8' });
        upstream.pipe(res);
      });
      outbound.once('timeout', () => outbound.destroy());
      outbound.once('error', () => { if (!res.headersSent) reject(res, 502); else res.destroy(); });
      req.pipe(outbound);
      return;
    }
    if (rawPath.startsWith('/api/') || rawPath.startsWith('/ws/')) return reject(res, 403);
    if (req.method !== 'GET' && req.method !== 'HEAD') return reject(res, 405);
    try {
      const pathname = decodeURIComponent(new URL(rawPath, `http://${LOOPBACK}:${viewerPort}`).pathname);
      if (pathname.includes('\\') || pathname.includes('\0')) return reject(res, 403);
      const candidate = resolve(assetRoot, `.${pathname === '/' ? '/index.html' : pathname}`);
      if (!candidate.startsWith(assetRoot + sep)) return reject(res, 403);
      const actual = await realpath(candidate);
      if (!actual.startsWith(assetRoot + sep) || !(await stat(actual)).isFile()) return reject(res, 403);
      const payload = await readFile(actual);
      res.writeHead(200, { ...headers(), 'content-type': MIME.get(extname(actual)) ?? 'application/octet-stream' });
      res.end(req.method === 'HEAD' ? undefined : payload);
    } catch { reject(res, 404); }
  });

  server.on('upgrade', (req, socket, head) => {
    if (closing || !sameHost(req) || !sameOrigin(req) || req.method !== 'GET' ||
        !/^\/ws\/session\/[A-Za-z0-9_-]{43}$/.test(req.url ?? '') ||
        req.headers.upgrade?.toLowerCase() !== 'websocket' ||
        !/^[A-Za-z0-9+/]{22}==$/.test(req.headers['sec-websocket-key'] ?? '')) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    // Keep all raw WS bytes and framing in the reviewed gateway. Rewrite only
    // the boundary Host/Origin to its private ephemeral loopback endpoint.
    const upstream = tcpConnect({ host: LOOPBACK, port: Number(gatewayUrl.port) });
    bridges.add(socket); bridges.add(upstream);
    const destroy = () => { socket.destroy(); upstream.destroy(); bridges.delete(socket); bridges.delete(upstream); };
    socket.once('close', destroy); upstream.once('close', destroy);
    socket.once('error', destroy); upstream.once('error', destroy);
    upstream.once('connect', () => {
      upstream.write([
        `GET ${req.url} HTTP/1.1`, `Host: ${gatewayUrl.host}`, `Origin: ${gatewayUrl.origin}`,
        'Upgrade: websocket', 'Connection: Upgrade',
        `Sec-WebSocket-Key: ${req.headers['sec-websocket-key']}`,
        `Sec-WebSocket-Version: ${req.headers['sec-websocket-version'] ?? ''}`,
        '', '',
      ].join('\r\n'));
      if (head.length) upstream.write(head);
      socket.pipe(upstream); upstream.pipe(socket);
    });
  });

  try {
    await new Promise((done, fail) => {
      server.once('error', fail);
      server.listen(0, LOOPBACK, done);
    });
    viewerPort = server.address().port;
  } catch (error) {
    await gateway.close();
    throw error;
  }
  return {
    url: `http://${LOOPBACK}:${viewerPort}/`,
    gatewayUrl: gatewayUrl.href,
    async close() {
      if (closing) return;
      closing = true;
      for (const socket of bridges) socket.destroy();
      server.closeAllConnections();
      await Promise.all([
        new Promise((done, fail) => server.close(error => error ? fail(error) : done())),
        gateway.close(),
      ]);
    },
  };
}
