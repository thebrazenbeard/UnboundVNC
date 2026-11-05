# Gateway ↔ synthetic RFB integration

Run from repository root using Node.js 22+:

```bash
node --test tests/integration/*.test.mjs
```

This is an ephemeral **loopback-only** integration test. It starts the real
UnboundVNC HTTP/WebSocket gateway and the separate test-only RFB 3.8 fixture,
opens a masked WebSocket through the actual HTTP upgrade endpoint, negotiates
RFB bytes, receives a 2×2 Raw framebuffer, sends keyboard and pointer input,
and verifies that a session ticket cannot be reused.

It depends on the gateway and fixture source under the separate draft PRs.
No browser rendering, Windows host, authentication to an actual workstation,
remote networking, or production security is proven. The RFB SecurityType None
used here must remain confined to isolated protocol tests.
