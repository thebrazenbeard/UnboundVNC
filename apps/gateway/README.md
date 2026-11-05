# UnboundVNC local RFB gateway

This prototype bridges a browser's binary WebSocket stream to an existing RFB/VNC server. It is **not** a VNC server, internet relay, or complete RealVNC replacement.

Requires Node.js 22+. Start with `npm start` inside `apps/gateway`; it listens on `127.0.0.1:6081` by default and only permits targets `127.0.0.1`/`localhost` **on TCP port 5900 only**. The browser viewer can proxy `/api` and `/ws` here from `http://127.0.0.1:5173`. No cloud service, account, or credential is needed.

**Windows host interoperability:** The companion Windows host currently listens on `127.0.0.1:5901`, which differs from the gateway's conservative `5900` default. For a host and gateway running **on the same computer**, explicitly allow the host port before starting the gateway:

```powershell
cd apps/gateway
$env:UNBOUNDVNC_GATEWAY_ALLOWED_PORTS = '5901'
npm start
```

On POSIX shells, use `UNBOUNDVNC_GATEWAY_ALLOWED_PORTS=5901 npm start`. A comma-separated list such as `5900,5901` permits both ports; ranges, wildcards, duplicates and invalid ports are refused. The gateway still binds only to IPv4 loopback, checks the HTTP Host and WebSocket Origin, requires a one-use ticket, and only dials `127.0.0.1`. This setting **does not** connect to a host on another computer or grant unattended access. Point the browser at the local viewer and choose `127.0.0.1:5901` as the RFB target; the gateway's `/api/sessions` ticket request then carries `{"host":"127.0.0.1","port":5901}`.

`POST /api/sessions` accepts `{"host":"127.0.0.1","port":5900}` and returns a single-use, 30-second `wsPath` ticket. Connect a standard noVNC RFB client to the path over WebSocket. Only binary RFB frames are bridged. `GET /api/health` returns basic local health. Programmatic embeddings may supply an explicit `createGateway({ allowedPorts: [5901] })` for an alternate known VNC server, but arbitrary local TCP ports are rejected by default. Before accepting WebSocket, the gateway additionally checks the upstream service's initial RFB protocol-version greeting and rejects connections that do not speak RFB. A greeting can still be impersonated by a malicious service; continue to choose allowlisted ports carefully.

The bind address and target policies intentionally have no remote access switch yet. For remote work, use a separately authenticated and encrypted private network and a security-reviewed configuration rather than exposing this gateway to the public internet.

Sessions do not have a cumulative byte quota or a fixed one-hour expiration: normal framebuffer traffic may exceed 64 MiB across a long-lived session. Each incoming WebSocket frame is capped at 1 MiB; the partial-frame parser uses a fixed 1 MiB + 14-byte sliding receive window, so even thousands of tiny TCP chunks cannot trigger quadratic growing-buffer concatenations. The parser rejects unmasked, reserved, noncanonical-length and malformed control frames, and echoes a valid masked Close frame. The gateway pauses upstream reads when the browser cannot accept more data. To distinguish a quiet desktop from an abandoned socket, it sends a WebSocket ping every 30 seconds and closes after the next interval unless a Pong echoes the exact outstanding random challenge. Unsolicited or stale Pongs cannot satisfy that probe. An embedding can adjust `heartbeatMs` (10–300,000 ms) for controlled testing; real browser clients answer WebSocket ping frames automatically. This is transport liveness, **not** host-side consent, identity, pairing or remote authorization.

Run `npm test` for protocol and security tests.
