# Authenticated bridge simulation — test-only, not remote access

**Status: SOURCE/TEST CANDIDATE, DEFAULT DISABLED, NO TAILNET TRANSPORT.**
`test-only-mtls-bridge.mjs` has no production imports or CLI, requires an
explicit `testOnlyEnabled: true` argument, and can bind only an ephemeral
`127.0.0.1` port. Do not distribute or turn this fixture into a user-facing
listener. It uses a disposable test CA and client certificates generated
inside the isolated test process. **mTLS certificate identity in this test is
not Tailscale `WhoIs` identity** and this test makes no real tailnet connection.

## Trust boundaries and attack cases

1. The simulated peer must complete genuine Node/OpenSSL client-certificate
   TLS verification. A *server-owned test callback* maps its verified
   certificate fingerprint to one allowlisted `node:*` principal. Malicious
   `Tailscale-User-Login`, `Tailscale-App-Capabilities`, `X-Forwarded-For` and
   fake node ID HTTP headers do not select the principal. A different CA-valid
   peer cannot borrow those headers or the fixed `/ws/view` path to enter.
2. A separate **test-owned host approval callback**, not request JSON, must
   approve the exact peer + host + fresh random session ID + view-only scope
   + consent epoch, return an unexpired bounded deadline and an abort signal.
   Missing/mismatched/stale approvals deny before touching the local gateway.
   Revocation destroys the admitted TLS and upstream sockets. This callback
   does **not** represent a real attended Windows host UI or trusted IPC.
3. Only after both test identities and approval does the bridge privately
   request a one-use WebSocket ticket from the existing gateway at an exact
   `http://127.0.0.1:<port>/` URL for one explicit local RFB port. It performs
   its own **local** Host/Origin upgrade; it never forwards an untrusted remote
   Host/Origin or exports the internal ticket to the peer. The binary WS/RFB
   stream is relayed on that one approved mTLS session. Concurrent admissions
   deny, and Stop/expiry/close destroys the proxy. No public or Funnel bind.
4. A stolen test certificate/private key or malicious trusted test callback
   can impersonate an allowed peer: no real key rotation, hardware protection,
   independent host identity, local-process authorization, network policy or
   incident response is implemented. The local gateway itself remains
   accessible to other same-machine processes by its existing policy.

> **Hostile falsifier:** The simulated callback currently *can fabricate*
> certificate-to-node identity and host approval. Therefore a passing test
> proves only the exercised local TLS/WS/gateway data path and its rejection
> logic. It does not prove authoritative `tsnet` WhoIs, encrypted tailnet
> connectivity, real operator approval, secure cross-machine Windows control,
> resilience to key theft, or RealVNC-style unattended support.

## Actual private-tailnet adapter gate (not implemented)

- A separate, explicitly installed Go adapter would use Tailscale
  [`Server.ListenTLS`](https://tailscale.com/docs/reference/tsnet-server-api)
  (private tailnet only), never `ListenFunnel` or a wildcard/public listener.
  For each accepted ticket/WS request it must obtain an authoritative
  `LocalClient.WhoIs(r.RemoteAddr)` result from that socket; fail closed on
  lookup error, changed peer identity, unapproved peer, wrong service TLS
  identity or missing/private-network policy. Never infer trust from Serve
  headers, `.ts.net` text, a browser-provided ID or the current simulation.
- A peer-specific on-host consent IPC channel must be separately designed,
  authenticated and tested. Today's Windows host has only generic attended
  local consent and cannot issue the required peer/session grant. Keep remote
  routing OFF until this gap is closed, including on host Stop/lock/exit and
  changed consent epoch; do not bypass current gateway Host/Origin checks.
- Browser HTTPS/WSS identity, tailnet grants, shared/tagged devices, DERP vs
  direct path, cert transparency, session limits and replay/DoS require real
  test-tailnet qualification. The free Personal plan is optional/vendor-run,
  not a guarantee of direct-only networking or hosted-service independence.

## Reproduce the bounded simulation

```sh
node --test tests/security/tailnet/test-only-mtls-bridge.test.mjs
```

The test generates and deletes its own OpenSSL CA/keys under the temporary
directory, opens exactly test-owned loopback TLS, WebSocket gateway and TCP RFB
listeners, checks one actual RFB banner after mTLS/approval, and asserts
negative paths for peer headers, wrong/expired approvals, unavailable fake
WhoIs, foreign Host/Origin, concurrency and revocation. It never captures a
real desktop or injects native input. `tailnet-admission-contract.yml` executes
it via `tests/security/tailnet/*.test.mjs` on a standard free Linux runner.

Existing real-route policy remains `REMOTE_ROUTING_ENABLED=false` and
`authorizeRealRemoteRoute()` unconditionally denies. **Rollback:** close the
unmerged Draft or revert only these isolated test/doc additions; no machine,
tailnet policy, credentials or listener outside the test has been changed.
