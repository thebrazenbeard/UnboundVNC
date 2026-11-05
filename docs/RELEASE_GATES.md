# UnboundVNC release gates

These are observable outcomes; checking in source files does not satisfy
them. A missing result is **UNVERIFIED**, never silently PASS.

| Gate | Acceptance behavior | Current evidence ceiling |
| --- | --- | --- |
| 0 — Provenance | Explicit original-code license, third-party manifest, pinned source/dependencies, and product-name/trademark clearance | Source preparation only |
| 1 — Local viewer | Connect to standard loopback RFB server, display pixels, send allowed input, disconnect | Requires executed test |
| 2 — Compatibility | Established third-party VNC clients and servers negotiate RFB 3.3/3.7/3.8 as supported | Requires cross-implementation tests |
| 3 — Local security | Denied origins, targets, expired tickets, absent credentials and malformed packets cannot start control | Requires negative tests |
| 4 — Windows host | A freshly installed Windows agent serves real screen and input with attended consent | Requires two-host Windows probe |
| 5 — Private remote | Trusted host-to-host session over LAN/tailnet with authenticated encrypted transport | Requires network/identity probe |
| 6 — Unattended | Explicitly armed per-controller access, visible audit, immediate revocation and failure recovery | Requires adversarial real-host tests |
| 7 — Packaging | Reproducible Windows install/uninstall, no paid service dependency, rollback and update policy | Requires clean-machine qualification |

## Functional parity priorities

The intended experience resembles a personal remote desktop viewer in
workflow, **not** source code, branding, or visual design:

1. Add/save/rename computers, current status and connect.
2. Credentials prompt, remote framebuffer, mouse/keyboard control.
3. Scaling, view-only, full-screen, connection status, disconnect.
4. Reconnect, multiple displays, clipboard and separately authorized transfer.
5. Host pairing, consent, optional unattended access and device revocation.
6. Private cross-network access and optional operator-owned relay.

Feature order does not imply that a listed feature has shipped. RealVNC is a
third-party trademark; UnboundVNC does not claim RealVNC endorsement.
The use of `VNC` in the product name also needs trademark review before
distribution; standards compatibility does not itself grant brand rights.
