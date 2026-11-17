# Upstream remote-desktop backend decision record

**Status:** DRAFT/source-reviewed on 2026-11-05. No upstream binary was run, packaged, or qualified on a real host. Initial product contract: Windows host/viewer, standard RFB first, $0 mandatory-service baseline, independent third-party licenses.

## Decisions from six separate investigations

| Technology | Actual upstream role | Potential UnboundVNC role | Current decision |
| --- | --- | --- | --- |
| [TigerVNC `x0vncserver`](https://tigervnc.org/doc/x0vncserver.html) | Shares an **existing X11** session via RFB | Optional Linux X11 host adapter; RFB interoperability fixture | **Later/conditional**: external process/socket, strict permissions; not Windows |
| [`x11vnc`](https://github.com/LibVNC/x11vnc) | Shares a real X11 display via RFB | Additional compatibility fixture/optional external host | **Test-only initially**: GPL, unmaintained warning and reported auth flaw |
| [`xrdp`](https://github.com/neutrinolabs/xrdp) | **RDP server** for Linux; its `libvnc` is an outbound VNC client/proxy | Separate future RDP tests/Linux hosting | **Defer**: it is not an RFB server for our viewer |
| [`xorgxrdp`](https://github.com/neutrinolabs/xorgxrdp) | X.Org modules used **with xrdp**, not standalone | Future Linux RDP login sessions | **Defer**: does not share the native Windows console |
| [`xdg-output`](https://wayland.app/protocols/xdg-output-unstable-v1) | Wayland *logical output geometry/name* | Future Linux monitor topology/coordinate adapter | **Later/conditional**: no capture, input, or RFB |
| `virtual-input` family | Wayland input emulation protocols, not a single standard | Future Linux Wayland input adapter | **Later/conditional**: prefer [RemoteDesktop portal](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.RemoteDesktop.html) + [libei](https://libinput.pages.freedesktop.org/libei/api/); wlroots pointer/keyboard only for supported authorized compositors |

**Additional candidate:** TigerVNC [`w0vncserver`](https://tigervnc.org/doc/w0vncserver.html) shares a supported existing Wayland session as RFB via wlroots/portal mechanisms; evaluate before inventing a complete Wayland host. It is not a Windows host.

## License/provenance boundaries

- TigerVNC `x0vncserver` and `x11vnc` source are GPL-covered; do not paste or link them into the source-available proprietary UnboundVNC core without a separately reviewed redistribution/legal strategy. An optional independently installed executable communicating across the standard RFB protocol is the preferred initial boundary. A distributed bundle can still trigger GPL compliance obligations.
- `xrdp` core is Apache-2.0; `xorgxrdp` uses a permissive X11 license. Preserve all upstream and per-file notices, check transitive dependencies, and keep them in a future optional adapter—not a primary Windows/RFB dependency.
- The `xdg-output` and identified wlroots virtual-input protocol XML carry permissive notices. These protocol definitions do not confer compositor authorization.
- UnboundVNC's personal/commercial license governs only original UnboundVNC material. It cannot supersede third-party grants. Record exact upstream commits, license files, patches, build modes, and delivered artifacts before release.

## Security and semantics that block naive integration

1. `x0vncserver` commonly listens on TCP 5900/all interfaces with broad input options unless configured. Limit to a Unix-domain socket or loopback, explicitly select security types and permissions, and enforce UnboundVNC's own consent/revocation lifecycle **only when UnboundVNC owns a managed host wrapper**. An arbitrary external RFB server keeps authority over its own policies. Source review predicts a possible noVNC 1.7 VeNCrypt→classic VNCAuth selection with TigerVNC `TLSVnc,VncAuth` defaults; require actual negotiated subtype capture and downgrade rejection, not just a successful WebSocket or VeNCrypt handshake.
2. `x11vnc` upstream states it lacks a maintainer. [Reported issue #278](https://github.com/LibVNC/x11vnc/issues/278) concerns a possible pre-auth denial-of-service in TLS Plain/`-unixpw`. Treat as an unresolved source-level risk; exploitability was not independently demonstrated in this review.
3. `xrdp`'s inbound RDP traffic and its VNC-proxy leg are different security paths. A secure RDP connection does not itself secure outbound classic VNC auth. Use current patched releases; [v0.10.6.1 release](https://github.com/neutrinolabs/xrdp/releases/tag/v0.10.6.1) addresses multiple vulnerabilities.
4. `xorgxrdp` creates a remotely accessible **Linux Xorg login/session**, not RealVNC-style sharing of Windows' current console. WSLg/Linux GUI tests are not Windows capture qualification.
5. `xdg-output` does not identify which captured PipeWire stream belongs to a monitor without additional trustworthy mapping. **Portal ScreenCast stream metadata is authoritative for a portal capture session**; do not treat PipeWire node IDs as persistent device identity. Where supported, inspect portal `mapping_id` (newer RemoteDesktop versions) and `pipewire-serial` (ScreenCast v6) rather than inventing an xdg-output-only correlation. Account for xdg-output v1/v2/v3 `done` semantics, scaling, rotation, negative origins, hotplug, and absence.
6. `virtual-input` does not capture pixels, and the existence of a Wayland virtual-input global is **not** a user's consent. Prefer portal-mediated input authorization and separately authorized PipeWire ScreenCast; ensure revoked sessions flush queued input and release keys.

## Future adapter acceptance, not a release-1 prerequisite

- **Linux X11**: x0vncserver and x11vnc independently installed, confined to loopback/Unix socket, tested against viewer/gateway; negative access, input, clipboard and session teardown tests.
- **Linux Wayland**: compositor capability detection; portal rejection; versioned portal stream metadata and stable-session mapping; output-to-stream mapping; monitor scaling/hotplug; no input before consent; permission revocation; optional `w0vncserver` compatibility. Do not assume any compositor or portal advertises a particular protocol version or stream identifier.
  The separate [Wayland adapter security contract](WAYLAND_ADAPTER_SECURITY_REVIEW.md) details portal-versus-privileged-protocol selection, libei region mapping, session generations, negative tests and runtime qualification blockers.
- **RDP**: a **separate RDP client** adapter (e.g. evaluate FreeRDP if needed) to reach xrdp; xrdp/xorgxrdp installation and TLS, session resizing, reconnect, deny tests. Do not assume an RFB viewer connects directly to xrdp.

## Source checkpoints reviewed by the specialists

| Component | Upstream checkpoint |
| --- | --- |
| TigerVNC | [`009df04af8fe3843176636da5ea297cf6b7c7a98`](https://github.com/TigerVNC/tigervnc/tree/009df04af8fe3843176636da5ea297cf6b7c7a98) |
| x11vnc | [`e2b726a8c0464051afda01648072af6835aaa5f7`](https://github.com/LibVNC/x11vnc/tree/e2b726a8c0464051afda01648072af6835aaa5f7) |
| xrdp | [`5e7deccfe10770d3bef867f819d7a66434faf074`](https://github.com/neutrinolabs/xrdp/tree/5e7deccfe10770d3bef867f819d7a66434faf074) |
| xorgxrdp | [`59d0735c4321b5baff3feaa980a01f78a1c1e96f`](https://github.com/neutrinolabs/xorgxrdp/tree/59d0735c4321b5baff3feaa980a01f78a1c1e96f) |
| Wayland | Protocol definitions linked above; different compositor support and versions remain runtime-UNKNOWN |

These findings are `SOURCE_INSPECTION`/documentation, not builds or host probes. The RFB-first Windows release remains the first priority.
