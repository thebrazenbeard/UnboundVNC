# Future Linux Wayland adapter: protocol and authorization contract

**Evidence:** SOURCE_INSPECTION / upstream protocol documentation, 2026-11-05.
**UnboundVNC checkpoint:** integrated Draft #22 at `a5119b43e3a9cd2fb0e9018335f4486c112473e7`.
**Runtime:** UNQUALIFIED. No compositor, portal, PipeWire stream, virtual device, or real desktop was started. This is a future Linux adapter, not a Windows-host feature or a release prerequisite.

## Key decision

Use a **portal-mediated session first**: XDG RemoteDesktop `CreateSession` → `SelectDevices` (when control requested) → ScreenCast `SelectSources` (when viewing requested) → RemoteDesktop `Start` (user selection/grants) → PipeWire video and, if granted, `ConnectToEIS`/libei input. The compositor/portal owns OS-level authorization; UnboundVNC still owns *separate* viewer identity, host consent, capability gating, transport security, session expiry and revocation. An advertised Wayland global, usable X11 display, RFB password, portal restore token or network connection **does not** grant those UnboundVNC permissions.

Do **not** silently fall back from a denied portal request to a direct screencopy or virtual-input global. Such a fallback would defeat a user-visible denial. A compositor-specific direct-protocol adapter is a separately reviewed, explicitly selected backend that must demonstrate an equivalent local authorization boundary before it can be enabled.

## Protocols are distinct, not interchangeable

| Surface | What upstream actually provides | What it **does not** grant | Adapter consequence |
| --- | --- | --- | --- |
| [`xdg-output-unstable-v1`](https://cgit.freedesktop.org/wayland/wayland-protocols/tree/unstable/xdg-output/xdg-output-unstable-v1.xml?id=f01202f4b73aaf0b9c2c58673d9a932e5a24f054) | Logical output position/size, names, descriptions; version 3 uses `wl_output.done` for atomic batches | Pixels, another client's surfaces, pointer control, consent, reliable physical connector identity | Display catalog only; version-aware snapshot with hotplug/scale/rotation and topology epoch |
| [XDG ScreenCast](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.ScreenCast.html) + PipeWire | User-selected stream(s) and metadata scoped to portal session | General desktop input, permanent monitor identity, remote viewer authorization | Capture grant; associate each stream with session epoch and source metadata |
| [XDG RemoteDesktop](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.RemoteDesktop.html) + [libei](https://libinput.pages.freedesktop.org/libei/api/) | User-selected pointer/keyboard/touch grants; EI input via `ConnectToEIS` after `Start`, or portal `Notify*` methods | A blanket input permission, automatic capture, unconditional unattended control | Input grant separate from capture; check *returned* device mask, select exactly one input transport |
| [wlroots virtual pointer](https://github.com/swaywm/wlr-protocols/blob/master/unstable/wlr-virtual-pointer-unstable-v1.xml) | Compositor virtual-pointer emulation; optional seat/output binding in protocol v2 | User permission simply because manager global is visible; capture | Conditional trusted-compositor input backend only |
| [wlroots virtual keyboard](https://github.com/swaywm/wlroots/blob/master/protocol/virtual-keyboard-unstable-v1.xml) | Virtual key events and keymap FD; `unauthorized` manager error for disallowed clients | Generic permission to inject keystrokes; safety of unvalidated keymap | Never bypass compositor rejection or inject through privileged globals from gateway/browser |
| [`ext-image-copy-capture-v1`](https://gitlab.freedesktop.org/wayland/wayland-protocols/-/blob/main/staging/ext-image-copy-capture/ext-image-copy-capture-v1.xml) | Compositor capture from supported image sources, staging/test-phase protocol | Universal implementation or a portable user-consent UI | Optional capture backend only after compositor-specific trust review; portal preferred |
| [wlroots screencopy](https://github.com/swaywm/wlr-protocols/blob/master/unstable/wlr-screencopy-unstable-v1.xml) | Legacy compositor output copy interface | General availability/authorization | Legacy compatibility only: upstream XML marks it deprecated in favor of `ext-image-copy-capture-v1` |
| [RFB RFC 6143](https://www.rfc-editor.org/rfc/rfc6143.html) and existing X11 fixture | Client-requested framebuffer updates and KeyEvent/PointerEvent wire format | Host consent, compositor capture rights, authenticated encrypted transport | Keep RFB as wire boundary; translate on an authorized host side, not in the browser |

### Monitor and input mapping invariants

1. `xdg-output` logical coordinates may differ from physical pixels (fractional scaling, rotation and negative origins). Its name is not guaranteed to be a DRM connector or durable hardware identity. On v3, use `wl_output.done`, not deprecated `zxdg_output_v1.done`, to commit snapshots; on older versions apply their documented ordering. Increment a topology epoch on hotplug/change; discard stale transforms and any queued absolute events.
2. ScreenCast stream node IDs may be reused. Where available, use `pipewire-serial` (ScreenCast v6) for stream targeting; `mapping_id` (v5) correlates a portal stream with a *libei device region*, not with a guessed xdg-output name. If either metadata field is absent, use session-scoped explicit mapping and fail closed for ambiguous absolute input. Never persist a node ID as an output identity.
3. A libei device can have one or multiple absolute regions, each with its own geometry; [the official region API](https://libinput.pages.freedesktop.org/libei/api/structei__region.html) explicitly warns that logical regions may not match physical pixels. Map RFB coordinates through the selected *captured stream* and authorized region; reject out-of-bounds/NaN/overflow and a changed epoch.
4. `ConnectToEIS` and D-Bus `Notify*` are alternative input transports: the portal says `Notify*` must no longer be used once EIS is connected. Never mix them as a fallback on a failed keystroke. The legacy `NotifyPointerMotionAbsolute` stream/node argument is session-scoped, not a persistent stream identity.

## Proposed host-side ownership boundaries

| Component | Owner and input | Output / fail-closed behavior |
| --- | --- | --- |
| `WaylandCapabilities` | Local host process; compositor globals + portal versions | Capability matrix only; absence means feature unavailable, not permission to force enable |
| `WaylandPortalSession` | Host-side D-Bus request/response and visible user choice | Session-bound `captureGrant` and `inputGrant` with separate flags; denial/revoke cancels both pending and active actions |
| `WaylandDisplayMap` | Portal stream metadata, libei regions, optional xdg-output topology | Immutable generation-tagged transforms; ambiguous mapping disables **absolute** input but may keep authorized view |
| `WaylandCapture` | Portal-granted PipeWire streams | Bounded frame queue, negotiated RFB framebuffer updates; no frames before host/portal approval or after revoke |
| `WaylandInput` | RFB input *after* UnboundVNC controller authorization | Portal EIS or Notify path only when granted; release held keys/buttons, abort queued events and close EIS on revoke |
| `RfbHostAdapter` | Local RFB 3.8 server behind an authenticated, consent-gated host | Loopback/Unix socket initially; no raw public listener, no automatic unattended pairing; never treat gateway origin checks as OS authorization |

**Session state:** `idle → requesting → selected → view-granted [→ control-granted] → revoked/closed`. Each transition carries a monotonically increasing generation. Capture and input callbacks must compare their generation immediately before doing work. A portal or host-side revoke invalidates the generation, destroys the local RFB session, flushes buffered frames/events, releases synthetic pressed keys/buttons and closes PipeWire/EIS handles. A regrant requires a fresh explicit session; no queue replay.

**Persistence:** RemoteDesktop portal v2 offers `persist_mode=2` (until revoked) and single-use `restore_token`s. These are *portal* permission semantics, not an UnboundVNC unattended-access grant. Default to `persist_mode=0`, do not record restore tokens or promote them to viewer identity, and require separate later product authorization/revocation design before enabling restoration.

## Security falsifiers and test gates

> **FAILS** if an advertised `zwlr_virtual_pointer_manager_v1` or `zwp_virtual_keyboard_manager_v1` is treated as permission to inject, or if the implementation bypasses a rejected/expired portal grant through direct compositor protocols.

> **FAILS** if screen capture begins before a grant, persists after revoke, or a stale PipeWire node ID/xdg-output name can route pointer input to a different monitor after hotplug.

> **FAILS** if an old controller's queued keystroke is delivered after host revoke, a failed EIS call falls back to D-Bus Notify without a new grant, or an RFB network ticket silently enables input.

Required evidence before a Wayland support claim:

1. **SOURCE/BUILD:** Pin exact portal, compositor, Wayland-protocol XML, PipeWire and libei versions; compile the chosen adapter without copying incompatible third-party implementation code.
2. **TEST:** Mock portal denial, partial grants, cancellation, restore-token rejection, EIS unavailability, stream/node-ID reuse, xdg-output v1/v2/v3 atomic updates, fractional scaling, rotation, negative origin, hotplug and stale topology epochs. Require view-only with no input delivery on partial grants.
3. **COMPOSITOR PROBE:** On *separately authorized*, isolated Wayland test sessions for representative wlroots and non-wlroots compositors, record advertised globals, portal backend and versions, selected streams, `mapping_id`/`pipewire-serial`, EIS device regions, user denial/revoke/lock and absent-protocol behavior. Do not imply universal support from one compositor's build.
4. **RFB INTEGRATION:** Confirm real compositor pixels through an independently instrumented RFB viewer; test held-key release, no post-revoke capture/input, bounded queues, transport disconnect and loopback-only access. Do not call Xvfb/x11vnc or a Wayland proxy test a native Windows qualification.

**Current disposition:** architecture and falsifiers are **SOURCE-REVIEWED**; implementation, installed portal availability, mapping correctness, compositor authorization and real runtime effects are **UNKNOWN**. This is an optional future Linux backend; the current Windows-first product remains RFB-first and does not gain Wayland input authority from this document.
