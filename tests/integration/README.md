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

## Stock Linux X11 screen-scraper compatibility (opt-in)

The `x11-display-backends.test.mjs` suite exercises **two independent,
unmodified upstream RFB servers** on a private GitHub-hosted Ubuntu runner:
Ubuntu-packaged `x11vnc` and TigerVNC's `X0tigervnc`
(`tigervnc-scraping-server`). Each attaches to an isolated, synthetic `Xvfb`
desktop. The test requests standard RFB SecurityType None on **loopback only**,
verifies the server's RFB version and Raw encoding, and checks every pixel of a
48×32 framebuffer against the X11 root-colour oracle. It then checks that the
gateway releases each upstream TCP session after both graceful WebSocket Close
and abrupt client destruction. The test rejects any IPv4/IPv6 VNC listener
outside 127.0.0.1/::1.

The opt-in command, after installing Ubuntu's `xvfb`, `x11-xserver-utils`,
`x11vnc` and `tigervnc-scraping-server` packages, is:

```bash
RFB_X11_SCRAPERS=1 node --test tests/integration/x11-display-backends.test.mjs
```

Workflow `.github/workflows/x11-display-rfb-interop.yml` runs this on a bounded,
public GitHub-hosted `ubuntu-24.04` job with read-only token permissions and
prints exact installed package versions. It installs packages at test time;
**no GPL-licensed server implementation is copied, linked, or vendored into
UnboundVNC source or distribution.** This is an interoperability test of the
gateway transport and test-only RFB client; it does not exercise the browser
canvas renderer, a Windows host or production authentication. Classic VNC
SecurityType None is not safe beyond this temporary loopback fixture; even
VncAuth alone does not establish encrypted transport.

`xrdp`/`xorgxrdp` speak **RDP**, not RFB, and would require an independent
protocol adapter to qualify. Wayland `xdg-output` and virtual-input protocols
are compositor-facing interfaces, not RFB servers; their support likewise
requires a separate integration path. Neither is covered by this suite.
