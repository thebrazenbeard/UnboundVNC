# Private-tailnet remote route: SOURCE/TEST candidate, not enabled

**Status: REMOTE ROUTING DISABLED / RUNTIME UNKNOWN.** This document and
`tests/security/tailnet/mock-admission.mjs` introduce **no active route,
listener, Tailscale login, ACL/grant, service, firewall change, deployment or
real-device connection**. The JavaScript model uses invented fake WhoIs/TLS
observations. Its `authorizeRealRemoteRoute()` always denies. It proves
only deterministic admission *logic*, never peer identity, TLS, WireGuard
encryption, human consent or functioning remote desktop.

## Exact current boundaries

- `apps/gateway/src/server.mjs` has no remote switch:
  `createGateway` binds **127.0.0.1**, validates loopback
  `Host`/`Origin`, requires a one-use 30-second WebSocket ticket, and
  only forwards to `127.0.0.1` on an explicitly allowed RFB port.
  Its default port is 5900; the attended Windows host is 5901.
- The browser viewer can **save** a hostname/IP, but the gateway
  still rejects non-loopback session targets. The viewer's local
  `view-only` toggle is not a security authorization gate.
- The Windows host remains **attended VIEW-ONLY**, binds
  `127.0.0.1:5901`, and prompts the local operator before sending RFB
  bytes. It does **not** receive a trusted tailnet peer identity or
  bind the approval to that identity. It has no enabled native input.
- RFB 3.8 SecurityType None is permitted only inside this already
  loopback-restricted attended prototype. Never open it on a tailnet
  address, LAN interface, Funnel, public proxy, or wildcard listener.
- No active tailnet route, Tailscale policy, WorkBridge host access or
  application TLS channel has been read back or qualified.

## Candidate architecture (not integrated)

1. **Private authenticated edge:** a deliberately installed, separately
   reviewed **Go `tsnet` adapter** would be its own tailnet node. It
   would listen **only inside the private tailnet** via
   `Server.ListenTLS`, never `ListenFunnel`, Serve-Funnel, wildcard
   LAN ports or a public reverse proxy. Browser HTTPS/WSS must validate
   the adapter's `.ts.net` certificate and origin; fail if the tailnet's
   HTTPS/certificate capability is unavailable. WireGuard protects the
   tailnet leg; TLS authenticates the browser-facing service. Neither
   alone constitutes on-host consent.
2. **Peer identity and local authorization:** for **each** ticket HTTP
   request and **each** upgraded WebSocket connection, the adapter
   would call its trusted `LocalClient.WhoIs(remoteAddr)` and bind the
   returned stable node identity to the connection and ticket. A
   trusted server-side allowlist/capability check must verify that the
   peer may request this *specific* host's **view-only** scope. Never
   trust a browser-provided node ID, source IP, `X-Forwarded-For`,
   `Tailscale-User-Login` header, MagicDNS string or JSON flag as
   a WhoIs/TLS attestation. Serve identity headers are a separate
   option and may be absent for tagged peers; header-only auth is not
   accepted by this design.
3. **Replay/audience/host binding:** issue a high-entropy short-lived
   ticket scoped to the observed peer node, canonical TLS service
   identity, exactly one configured backend host, view-only permission
   and origin. Consume it *once on upgrade even if the peer is wrong*;
   reject a second use, expiry, a changed peer/service/target, or
   excessive outstanding tickets. The actual authenticated adapter
   must own the ticket store; client JavaScript cannot provide
   TLS exporter proof, nor can a bare stored device profile prove
   machine identity.
4. **Consent and revocation:** after peer admission, the host must show
   the **verified remote peer** to its real local operator and bind
   the approval to peer + session + consent epoch. No RFB protocol or
   framebuffer bytes until approval. Stop, window/desktop lock,
   session expiry, peer disconnect and identity change must revoke
   that session before further frames. Current host approval is
   generic loopback approval, so **this binding does not exist**.
   Do not enable a bridge while this is missing.
5. **Local handoff:** a future adapter can connect to an explicit
   same-machine loopback gateway/host backend only after checks.
   The current gateway's local `Host`/`Origin` enforcement must not
   be bypassed by blindly rewriting forwarded headers. Design a
   distinct authenticated in-process or local IPC handoff with
   socket ownership, peer/session metadata integrity, and one
   end-to-end negative test before modifying the gateway. No
   arbitrary target host or port may be accepted from a viewer.

### Illustrative policy only — not applied

The recommended *new* Tailscale access-control syntax is a **grant**.
This snippet is a placeholder, not a policy for Patrick's actual tailnet.
Tailnets may initially permit all members, so tailnet membership alone
must never grant a remote desktop session.

```json
{
  "grants": [{
    "src": ["group:approved-viewers"],
    "dst": ["tag:unboundvnc-private-adapter"],
    "ip": ["tcp:443"]
  }]
}
```

Any real policy would also need defined group/tag ownership, a reviewed
exact target identity and positive/negative policy tests before changes.
**Do not copy/apply this snippet to a live tailnet without authority.**

## Threats and executable mock checks

| Attack or failure | Required response | Present evidence |
| --- | --- | --- |
| Public/Funnel route or arbitrary upstream | Deny; no product listener changes | Fake policy checks |
| Spoofed identity header or client JSON WhoIs | Deny; authoritative socket WhoIs missing | Fake negative tests |
| Missing TLS/changed service name | Deny; TLS runtime not present | Fake negative tests |
| Ticket replay, wrong peer/host, expired ticket | Consume once and deny | Fake ticket tests |
| Tailnet peer admitted but operator has not approved | Await host consent; send no RFB | Fake frame gate only |
| Stop/relock/peer or consent epoch changes | Deny further view-only frames | Fake revocation tests |
| Key/mouse/control request | Deny; host remains view-only | Fake role tests + existing host checks |
| WorkBridge disabled or no Tailscale credentials | Do not query host, guess keys or deploy | This source-only branch |

The test-only `createFakeTailnetAdmission()` intentionally accepts
`source: "FAKE_WHOIS_TEST_ONLY"` and booleans about TLS/consent. These
objects can be **fabricated** and therefore must never authorize real
network traffic. The candidate is not imported by the product gateway.
`REMOTE_ROUTING_ENABLED=false` and the real authorization entry
always deny, including if such fake data is passed.

## Qualification gates before any separate enabled prototype

1. Decide an approved, exact peer/host identity and dedicated tailnet
   grant with Patrick's authority. Read it back from both ends;
   review default allow-all/share/posture implications. No current
   tailnet state was examined here.
2. Implement and test a real private TLS `tsnet` socket adapter, per
   connection `WhoIs` lookup, cert/origin verification and
   short-lived peer-scoped one-use tickets. Test failed/changed identity,
   DNS/cert mismatch, replay, reconnect, shared/tagged devices and
   privilege boundary; never expose Funnel.
3. Introduce a trusted local adapter-to-host identity handoff and
   **human-visible peer-specific on-host consent**, with Stop/lock/
   disconnect/expiry revocation under adversarial timing.
4. Verify actual encrypted peer-to-peer/DERP tailnet transport,
   browser WSS, and end-to-end RFB pixels on an isolated consenting
   test pair. Do not infer E2EE from a fake WhoIs object, a green
   unit test, or the overlay's general encryption documentation.
5. Independently review the precise enabled source head, Tailscale
   policy and actual runtime; retain a default-OFF rollback. No
   Windows 10/11 physical host claim follows from ephemeral CI.

## Reproducible scope and references

```sh
node --test tests/security/tailnet/mock-admission.test.mjs
npm test --prefix apps/gateway
```

No auth key, secret, node join, Tailscale daemon, device lookup or
network listener is used by the new tests. GitHub Actions runs only
those source checks on a standard free hosted runner with
`permissions: contents: read`.

Primary references:

- [Tailscale tsnet Server LocalClient/WhoIs](https://tailscale.com/docs/reference/tsnet-server-api)
- [Tailscale tsnet](https://tailscale.com/docs/features/tsnet)
- [Tailscale grants vs ACLs](https://tailscale.com/docs/reference/grants-vs-acls)
- [Tailscale Serve private identity headers and limitations](https://tailscale.com/docs/features/tailscale-serve)
- [Tailscale private connectivity](https://tailscale.com/docs/reference/connection-types)

**Rollback:** leave the runtime feature disabled; close the unmerged
Draft PR or revert only its test/docs/workflow commit if later
included. No actual tailnet or device state exists to undo.
