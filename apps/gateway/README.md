# UnboundVNC local RFB gateway

This prototype bridges a browser's binary WebSocket stream to an existing RFB/VNC server. It is **not** a VNC server, internet relay, or complete RealVNC replacement.

Requires Node.js 22+. Start with `npm start` inside `apps/gateway`; it listens on `127.0.0.1:6081` by default and only permits targets `127.0.0.1`/`localhost` **on TCP port 5900 only**. The browser viewer can proxy `/api` and `/ws` here from `http://127.0.0.1:5173`. No cloud service, account, or credential is needed.

`POST /api/sessions` accepts `{"host":"127.0.0.1","port":5900}` and returns a single-use, 30-second `wsPath` ticket. Connect a standard noVNC RFB client to the path over WebSocket. Only binary RFB frames are bridged. `GET /api/health` returns basic local health. Programmatic embeddings may supply an explicit `createGateway({ allowedPorts: [5901] })` for an alternate known VNC server, but arbitrary local TCP ports are rejected by default. Before accepting WebSocket, the gateway additionally checks the upstream service's initial RFB protocol-version greeting and rejects connections that do not speak RFB. A greeting can still be impersonated by a malicious service; continue to choose allowlisted ports carefully.

The bind address and target policies intentionally have no remote access switch yet. For remote work, use a separately authenticated and encrypted private network and a security-reviewed configuration rather than exposing this gateway to the public internet.

Run `npm test` for protocol and security tests.
