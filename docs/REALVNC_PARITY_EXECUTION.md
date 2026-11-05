# UnboundVNC: personal remote-desktop parity execution contract

**Status:** DRAFT for architecture, security, implementation, and owner review. This document does not certify a build or authorize deployment.

**Reviewed source checkpoints (2026-11-05):** `thebrazenbeard/UnboundVNC` `main@1c141afe3976b31d54d491d7b3a585c60d535cd1`; viewer draft PR #1 initially `cb842ebb326fdf6967186f2e11b260d181901bdf`, subsequently `dbd194abc132679052986b428df61ad1f35a84dc`; synthetic RFB fixture draft PR #5 `4ec41f5f572a06a2c970e13b9c7e8b7b237654eb`; local gateway draft PR #6 `ad9658fde0b0469d481c86956bc76773d5039257`. Recheck before implementation because parallel PRs can change.

## Outcome, not imitation

The first release goal is a **genuinely working Windows-to-Windows, RealVNC-Lite-like personal workflow**, using standards-compatible RFB where possible:

1. Install a host and viewer on two different Windows computers.
2. Locally approve and pair a trusted controller; see the named host in a saved-device dashboard.
3. Connect, view real framebuffer pixels, control permitted keyboard/mouse input, switch scaling/fullscreen/view-only, and disconnect.
4. Deny, revoke, or expire any session from the host; no screen content or input authority survives revocation.
5. Repeat over a private, authenticated, encrypted LAN/overlay path without a mandatory vendor account or paid relay.
6. Later, explicitly arm and revoke unattended access across a restart.

This is workflow parity, **not** copied RealVNC code, branding, artwork, closed extensions, or promises of subscription-dependent features. RealVNC Lite currently has a free noncommercial one-user/three-device/one-connection plan. UnboundVNC's original material remains under its own source-available free-personal/separate-commercial license, subject to owner/legal review; third-party licenses are independent.

## Observed baseline and evidence ceiling

At the reviewed `main` commit, there is no application, gateway, Windows host, installer, service, or runtime test suite. **Separate unmerged draft branches now exist:** PR #1 adds the noVNC viewer; PR #5 adds a loopback-only synthetic RFB 3.8 fixture (six tests reported passing); PR #6 adds a loopback-only WebSocket/RFB gateway (five tests reported passing). A separate BT2 review reports independently rerunning those source-level tests and the newer viewer's nine profile tests/build; this document's author did not personally execute them. These branches are **not integrated**, do not serve remote LAN endpoints, and are not real Windows host tests.

PR #1's newer `dbd194...` head adds a fail-closed RSA key fingerprint display and manual verification flow. This is a meaningful partial correction to the originally observed `cb842...` omission. It does **not yet establish** trusted out-of-band comparison, persistent pinning/re-pairing, or an authenticated gateway-to-server path; its credentials dialog still contains an unconditional `SECURE CONNECTION` heading. Treat the prior blocker as **partially addressed at a newer source head**, not unchanged or fully resolved.

Never label a feature implemented or secure on the strength of a specification, green profile tests, or a review alone. Follow `docs/RELEASE_GATES.md` and `docs/SECURITY_BOUNDARIES.md` as governing requirements.

## Architecture and trust boundaries

The implementation should keep these separable interfaces even if the first slice uses one process:

| Boundary | Responsibility | Authority invariant |
| --- | --- | --- |
| `Viewer` | Saved nonsecret profiles, remote canvas, input/UI intent | Never grants privileges; `viewOnly` is UX only |
| `SessionGateway` | Local authenticated API, bounded WebSocket-to-RFB bridge, target admission | Default loopback; reject arbitrary destinations, origins, and replay |
| `HostIdentity/Pairing` | OS-protected host key, controller enrollment, trusted verification | VPN membership or VNC password is not unattended consent |
| `SessionPolicy` | Host-local approval, session capabilities, expiry, revocation | Enforce view, control, clipboard, transfer, unattended separately |
| `WindowsCapture` | Selected interactive session, frames, cursor, damage, displays | No capture before consent or from unsupported secure desktop |
| `WindowsInput` | RFB key/pointer translation, modifiers, released-state cleanup | No injected input without current host `control` grant |
| `RfbServer` | RFB 3.x negotiation/encodings and compatibility | Reject unsupported/downgraded security paths off isolated tests |
| `Transport` | Authenticated encryption, identity, private routing | A relay cannot read frames if E2EE is claimed |
| `HostService` (later) | Startup/lifecycle of per-user helper and unattended policy | No interactive UI in Session 0; least-privilege authenticated IPC |

### Two distinct connection classes

**External RFB interoperability:** A viewer/gateway reaches an existing third-party VNC server. Its own server controls authentication, host approval, input/clipboard permissions and revocation. UnboundVNC can enforce **gateway admission**, viewer behavior, its local proxy teardown and its own transport policy, but cannot honestly promise remote host-local consent, zero pixels before that external server's approval, or revocation of other controllers. UI must label the external server's independent trust policy and actual negotiated security.

**Managed UnboundVNC host:** Our native host owns pairing, visible local consent, frame/input gating, per-capability grants, expiration and active revocation. Only this mode can claim the guarantees below after real-host qualification. A common RFB wire protocol does not erase this trust-boundary distinction.

Managed-host state transition invariant: `unpaired → requested → host-approved → active → expired/revoked/closed`. An expired or revoked session cannot return to `active` without a *new* authorized admission. On revoke/disconnect, close transport, drop pending frames, increment a session authorization epoch so delayed input is rejected, release held keys/buttons, and invalidate one-time tickets.

## Implementation slices and merge gates

### Slice 0 — Complete, test, and accurately label server identity (PR #1 partial fix)

At PR #1's original `cb842...` head, `serververification` displayed `event.detail.type` but **not `event.detail.publickey`** while allowing `rfb.approveServer()`. PR #1's newer `dbd194...` source now computes and displays a SHA-256 RSA key fingerprint and keeps approval disabled until it can do so. This corrects the specific display omission, but the remaining requirements are not thereby proven.

- For security methods exposing a public key, compute/display a stable SHA-256 fingerprint, require a trusted comparison on first use, store only nonsecret per-host pin metadata, and hard-fail changed keys unless the user deliberately re-pairs through an authenticated flow. Do not automatically approve.
- Correctly distinguish RSA public-key verification from security methods that supply no verifiable server identity; require a separate authenticated encrypted channel for legacy RFB beyond isolated loopback testing.
- Do not label an unverified connection `SECURE CONNECTION`; display an evidence-based state, and avoid teaching users to click through identity warnings.
- Specify a canonical RSA public-key fingerprint byte encoding (including algorithm/format), pin scope and rotation protocol; test that reordering/formatting cannot create false equivalence. Keep `approveServer()` gated on the verified live connection, not stale async dialog state.
- Add success and negative tests: first trusted key, mismatched key, missing key, rejected approval, reconnection, downgrade, and no secret leakage to logs/storage.

Gate: reviewer confirms the exact key bytes used for fingerprinting, the pin scope, rejection semantics, and security state against the pinned noVNC API. Full browser and server identity tests must execute before claiming this fixed.

### Slice 1 — Local-only gateway and standard RFB interoperability

- Integrate and hostile-review **draft PR #6** against the viewer's declared `POST /api/sessions {host, port}` and opaque `{id, wsPath, expiresAt}` contract. Its source currently binds only to loopback and dials loopback endpoints; it reports five gateway tests. Confirm one-time/short-lived WebSocket admission bound to local identity, strict Origin/Host and CSRF checks, bounded concurrency/size/time, no raw credentials, ticket cleanup and disconnect semantics.
- Resolve and authorize targets safely: explicit host/port rules, DNS resolution/rebinding checks, no arbitrary HTTP/metadata/loopback pivot proxy, rejection of unexpected local or private targets according to policy.
- Default listeners to `127.0.0.1`; do not add a firewall exception or public WebSocket/RFB listener by default.
- Integrate **draft PR #5**'s synthetic RFB fixture as a test-only dependency, then execute against **two independent maintained RFB server implementations**. Cover RFB versions and supported security types, valid/invalid credentials, encodings, framebuffer, cursor, pointer/keyboard, disconnect, timeouts, and failure cleanup. None-auth synthetic tests must stay loopback-only.
- Explicitly verify the **entire transport path**: browser→gateway `wss://` says nothing about gateway→RFB server encryption. With noVNC 1.7 and TigerVNC `x0vncserver` defaults (`TLSVnc,VncAuth`), upstream source suggests VeNCrypt can still select classic unencrypted VNC authentication. Capture negotiated security type/subtype and negative-test downgrade; do not infer TLS merely from the VeNCrypt umbrella or an encrypted WebSocket leg.

Gate: combined viewer→gateway→fixture success **and** actual local framebuffer + permitted input + disconnect against independent servers, plus origin/target/ticket/replay/timeout/security-subtype negative tests. Treat `None`/classic VNC auth as isolated interoperability only, not Internet security. The predicted TigerVNC downgrade remains SOURCE_INSPECTION/UNKNOWN pending captured wire evidence.

### Slice 2 — Real attended Windows host

- Build a per-user interactive host with selected-display capture (compare DXGI Desktop Duplication and Windows Graphics Capture), frame/damage/cursor tracking, RFB encoding, and bounded input translation using the Windows APIs under the actual session's security constraints.
- Host-local consent dialog defaults to deny; include `allow view`, separately `allow control`, expiry, visible active-session indicator, and immediate disconnect/revoke control. A denied request must release **zero frames** and accept **zero input**.
- No implicit access to Windows logon, locked/secure desktop, UAC, other user's RDP session, or higher-integrity windows. Handle unsupported transitions by stopping capture/control and clearly reporting why, without weakening Windows protections.
- Record a capture-API/OS-version decision (DXGI vs WGC) and explicitly bind each worker/grant to a Windows session ID and controller ID. Invalidate capture and input epochs on WTS session switch, lock/logoff, loss of capture, or revocation; never replay queued input into a new desktop.
- Test keyboard layout/IME/modifier state, mouse/button release, multiple screens at mixed DPI, session switches, sleep/resume, GPU reset, capture loss, and crash cleanup.

Gate: two physically distinct Windows machines prove both directions of host/viewer operation, recorded under exact binary SHAs and host conditions. **Planned testbed (not accessed or probed here):** inventory Lappy, VN1 and VN2 for OS edition, logged-in sessions, rights, GPU/displays, current workload and tunnel readiness; then rotate Lappy→VN1, VN1→VN2, VN2→Lappy, reverse each direction, and separately test denied sessions, lock/UAC, multi-monitor hotplug and restart. Use only user-authorized real-host sessions after live readiness checks. Synthetic X11/WSL GUI success **does not** count as Windows desktop control.

### Slice 3 — Trusted identity and private remote connectivity

- Assign unique host/controller keys and store private material through Windows-protected facilities. Pair from a visible host-local flow; never infer trust from a LAN, VPN, password, or saved profile.
- Authenticated encrypted endpoint transport is mandatory off loopback. Validate key change, MITM, rejected consent, expired/replayed tickets, unauthorized input and clipboard, and active-session revocation.
- First connectivity target: direct LAN and optional operator-configured private Tailscale tailnet. Keep it optional and avoid public Funnel exposure. Do not claim Tailscale is self-hosted, or that two restrictive NATs can connect without reachable coordination/relay infrastructure.
- Possible future independent path: operator-hosted Headscale/DERP where a reachable server and actual $0 resources exist. Custom STUN/ICE/TURN and public vendor relay are not release-1 requirements.

Gate: two hosts connect across real private network paths; wrong peer, dropped/replayed traffic, changed keys, rejected consent, and controller removal all fail closed. Confirm the endpoint encryption claim against the actual path, not UI labels.

### Slice 4 — Attended packaging, then explicit unattended Windows service

- First package the working **attended per-user host** in a reversible $0 user-scoped installer/uninstaller with opt-in autostart. Do not demand LocalSystem or an always-on privileged service to deliver the first functional demo.
- Only after attended access and identity/revocation qualify: add a Windows service for lifecycle with an interactive per-user helper, authenticated ACL-restricted IPC, and no Session 0 UI. Require explicit *per-controller* unattended arming, expiry and local revoke/kill control.
- Specify the IPC peer identity (user SID/session ID), ACL, allowed commands, privilege boundary and crash/restart behavior; the service must not accept arbitrary controller-supplied process/file operations. Explicitly test stale helper and session-switch races.
- Treat login screen, UAC/secure desktop and secure attention sequence as individually gated platform features; `SendInput` and running as SYSTEM are not substitutes for a security design.
- Prefer a reversible $0 installer/uninstaller (NSIS is one candidate), startup modes, diagnostic logging without payloads, bounded recovery, rollback, and no unsolicited public network rule. Unsigned binaries may trigger SmartScreen warnings and enterprise policy blocks; a self-signed certificate is not public publisher trust. Do not claim code signing exists at $0.
- Updates should be opt-in initially and eventually verified by independently trusted **pinned publisher keys on signed manifests**, authenticated downloads and recoverable staging; this is not identical to Windows Authenticode trust. A bare checksum served beside an untrusted binary does not authenticate updates.

Gate: clean install → attended pairing → explicit unattended arm → reboot → allowed connection → revoke → denied reconnect → clean uninstall, witnessed on real Windows hosts.

### Slice 5 — Daily usability, performance, and later platforms

After real control works: monitor selection, reconnect, text clipboard in each separately authorized direction, Ctrl+Alt+Del only where platform-authorized, keyboard shortcuts, accessibility, detailed errors, display/hotplug behavior, frame-rate/latency/performance baselines, and saved-profile import/export without secrets.

General file transfer, drag/drop, printing, chat, audio, and recording are **not portable baseline RFC 6143 features**. Build separately negotiated and host-authorized capabilities; do not claim they work with arbitrary VNC servers. Future optional Linux X11/Wayland and RDP backends follow `docs/UPSTREAM_BACKEND_DECISIONS.md`, not before the Windows-first core. Mobile/macOS/Linux viewers and host support are separate platform gates.

## Mandatory negative tests and evidence record

| Test area | Required failure/success probes |
| --- | --- |
| Gateway | Wrong Origin; blocked target; DNS rebinding; expired/used ticket; malformed WebSocket/RFB; exhaustion; disconnect cleanup |
| Identity | Wrong key; changed key; no verifiable key; VeNCrypt subtype downgrade; both encrypted transport legs; unpaired controller; bad password; re-pair and revoke |
| Consent | **Managed host:** host rejects; timeout denies; viewer-only grant receives no forged input; revocation interrupts active frames/input. **External server:** verify gateway admission and teardown only; do not claim remote server-owned policy. |
| Host | Logoff, lock, UAC, remote RDP, dual monitors/mixed DPI, hotplug, GPU/device loss, sleep/resume, crash/restart |
| Installation | Fresh Windows machine, rollback, uninstall, stale service/port/token absence, explicit startup mode |
| Interoperability | Two independent VNC servers and clients; protocol versions, encodings, clipboard text, cursor, input and reconnect |
| Network | LAN and tailnet direct/relayed behavior, packet-path privacy, server identity, no unintended public listener |

Every claim should record exact Git head, dependency versions, host OS/session, command or action, observed output, and evidence class: `DOC`, `SOURCE_INSPECTION`, `TEST`, `BUILD`, `INSTALL`, `REAL_SYSTEM_PROBE`, or `REVIEW`. Unit tests or agent consensus never elevate a claim to Windows runtime proof.

## Design challenges deliberately unresolved

> **FAILS:** A browser UI plus X11 server binaries is a Windows RealVNC substitute. There is no native Windows host.

> **FAILS:** Viewer-side `viewOnly`, a VNC password, or tailnet membership is host authorization.

> **FAILS:** Promising managed-host consent or revocation on a third-party RFB server through a generic proxy.

> **FAILS:** A privileged service can simply inject through UAC/logon/secure desktop. Session 0, UIPI, and SAS have separate constraints.

> **FAILS:** Universal unattended Internet access can be guaranteed with $0 infrastructure and no reachable broker/relay under restrictive NAT.

> **UNKNOWN:** Performance parity, cross-platform support, secure unattended mode, and host-to-host readiness until specific live tests exist.

## Independent specialist review disposition (reviewed PR head `30e4f6ae...`)

Six native specialists posted source-level comments on [Draft PR #4](https://github.com/thebrazenbeard/UnboundVNC/pull/4): [RFB/TigerVNC](https://github.com/thebrazenbeard/UnboundVNC/pull/4#issuecomment-6656800378), [Windows/x11vnc](https://github.com/thebrazenbeard/UnboundVNC/pull/4#issuecomment-6656773815), [security/connectivity](https://github.com/thebrazenbeard/UnboundVNC/pull/4#issuecomment-6656790656), [packaging/reliability](https://github.com/thebrazenbeard/UnboundVNC/pull/4#issuecomment-6656786136), [Wayland output](https://github.com/thebrazenbeard/UnboundVNC/pull/4#issuecomment-6656785057), and [input/viewer](https://github.com/thebrazenbeard/UnboundVNC/pull/4#issuecomment-6656778684). Their exact reviewed head was the first two-doc version, not this revised head. Material accepted corrections: external/managed connection classes, two-leg transport security/VeNCrypt subtype testing, session identity/epoch, named three-host test rotation, attended installer before service, and bounded Wayland mapping. Runtime test and legal review questions remain **UNKNOWN**, not passed by model agreement.

## Primary references and linked work

- [UnboundVNC release gates](RELEASE_GATES.md); [security boundaries](SECURITY_BOUNDARIES.md); [draft viewer PR #1](https://github.com/thebrazenbeard/UnboundVNC/pull/1).
- [RFC 6143 — RFB](https://www.rfc-editor.org/rfc/rfc6143.html); [noVNC API, serververification and approveServer](https://github.com/novnc/noVNC/blob/master/docs/API.md).
- [RealVNC Lite baseline](https://www.realvnc.com/en/connect/plan/lite/); [RealVNC server/viewer connection model](https://help.realvnc.com/hc/en-us/articles/38538874117533-RealVNC-Viewer-and-Server-Basics).
- [Microsoft DXGI Desktop Duplication](https://learn.microsoft.com/en-us/windows/win32/direct3ddxgi/desktop-dup-api); [SendInput/UIPI](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput); [interactive services](https://learn.microsoft.com/en-us/windows/win32/services/interactive-services).
- [Tailscale connection types](https://tailscale.com/docs/reference/connection-types); [Headscale requirements](https://headscale.net/stable/setup/requirements/).
- Third-party dependency and license inventory remains mandatory; see `THIRD_PARTY_NOTICES.md` in repo root.

**This draft is a prioritized engineering contract, not an assertion that any of the named slices has been implemented or tested.**
