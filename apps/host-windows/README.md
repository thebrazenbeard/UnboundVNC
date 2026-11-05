# Windows attended host (experimental)

This is a **view-only attended proof of concept**, not a production remote-access service. It targets .NET 8 WinForms on Windows, serves RFB 3.8 on **127.0.0.1:5901 only**, asks the logged-in local user to approve each connection before any RFB protocol or framebuffer bytes are sent, and limits each approved session to five minutes. The operator can stop sharing. Windows lock/disconnect and nondefault input desktop checks cause the connection to stop. A post-capture desktop/consent-epoch check attempts to prevent sending stale frames after revocation; this is not an atomic guarantee against a transition during network writes.

The attended host has passed hosted Windows .NET 8 Release **build** and source/mocked checks in previous draft work, but no real human-attended Windows RFB session has been performed. Protocol interoperability, actual host framebuffer transfer, consent visibility, native input, crash handling, and lock/UAC behavior remain **runtime-unverified**. A successful build does not establish real remote-desktop behavior.

## Hosted Windows GUI diagnostic (consent not simulated)

The `tests/host-windows-runner-desktop` project is an isolated Windows Actions **diagnostic**, not an attended RFB qualification. It checks whether the ephemeral Windows runner has an active interactive `WinSta0/Default` console desktop; if absent, it reports `BLOCKED_NONINTERACTIVE_DESKTOP`, skips the host, and exits successfully only as a diagnostic (not a runtime PASS). When present, it requires a real one-pixel `CopyFromScreen` match against an intentionally solid-colored **test-owned form**, then launches the actual view-only host WinForms executable as its own child, verifies the stopped-by-default window and **Start local preview** button through read-only metadata, and checks for no newly created port 5901 listener. Capture mismatch fails the diagnostic and prevents launching the host. The probe closes only its own child and never saves/logs pixel values or images.

It never clicks Start or Approve, injects keyboard/pointer input, initiates an RFB handshake, alters runner policy, touches a production host, or claims live screen sharing. The workflow prints `RFB_FRAMEBUFFER=NOT_TESTED_NO_HUMAN_CONSENT`. Neither a GUI-launch PASS nor test-form screen capture proves Win10/11 user-workstation parity, UAC/lock behavior, consent UX, or framebuffer bytes following a real human-approved session.

## Ephemeral Windows runner synthetic-consent RFB check

The separate `tests/host-windows-ci-rfb` test may automate **Start**, **Approve** and **Stop and revoke** only on an ephemeral **GitHub-hosted** Windows runner with the workflow's explicit opt-in variable. It rejects local/non-GitHub/self-hosted environments and noninteractive desktops, checks port 5901 is unused before launching its own view-only host child, and sends bounded native `BM_CLICK` messages only to verified buttons belonging to that child process. **This is synthetic CI automation, never a human approval or an unattended-access feature.** The test does not change production host code, input injection, UAC, services, firewall, sharing configuration or public listener bindings.

After opt-in, the test paints a uniquely colored, solid **test-owned form** on the runner desktop, checks one local screen pixel in memory, confirms no RFB bytes are sent before the synthetic consent click, performs a loopback RFB 3.8 None handshake, verifies the 32bpp format and a single Raw 1×1 rectangle with the known marker's BGR components, then clicks Stop and requires port closure plus session EOF/reset. No frame bytes/images, credentials, clipboard or desktop content are logged or saved. A FAIL on a real interactive hosted runner is a real test failure, not an opt-out skip; the existing non-consent diagnostic remains distinct.

This test-owned pixel and synthetic approval are **hosted runner RUNTIME_PROBE** evidence only. They cannot establish that a Patrick-owned Windows 10/11 host shows consent to a real person, safely revokes during a lock/UAC transition, handles physical multi-monitor capture, or grants secure remote control. RFB None remains strictly loopback-only; native keyboard/mouse control remains disabled.

## Disabled local input policy spike

### Native-effect admission remains blocked

The Windows CI `tests/host-windows-effect-safety` guard reflects the **actual built host managed DLL** (adjacent to its native `.exe` apphost), checks the existing `NativeInputAdapter.Enabled=false`/`TryInject=false` contract, and rejects added `user32.dll` imports except the three existing read-only desktop probes (`OpenInputDesktop`, `GetUserObjectInformationW`, `CloseDesktop`). The guard also rejects the common native input-effect entry points. This is a *bounded P/Invoke regression check*, not exhaustive proof against dynamic native loading or any other unsafe implementation.

The same Windows job injects fake paired SendInput return counts, failed or throwing release callbacks, mid-effect cancellation, simulated desktop/UAC changes and a deterministic Stop/effect scheduling barrier into a **test-only** `FakeEffectGate`. A partial insertion attempts release once but is always denied and revokes; if release fails, an actual key/button might remain held. These tests deliberately make **no** native input calls and cannot qualify Windows UIPI, secure-desktop transitions, physical pointer/key state or real-machine Stop timing. Importing the native `SendInput`/`SetCursorPos` path from Draft #27 remains **NO-GO** until independent machine-level failure injection and interactive human consent are qualified.

`ExperimentalInputPolicy` models the bytes *after* RFB KeyEvent (7 bytes) and PointerEvent (5 bytes) message types, with exact-length, range, key mapping and coordinate checks. The limited keyboard set is ASCII printable characters, Backspace, Tab, Enter, Escape and arrow keys. It rejects modifier keys, unsupported X11 keysyms, noncanonical down flags, nonzero padding, oversized payloads, out-of-frame coordinates, arithmetic overflow and unsupported pointer button bits (wheel/extended buttons). This deliberately incomplete mapping is not yet suitable for generic RFB viewer input interoperability.

**No control path is enabled.** `NativeInputAdapter.Enabled` is false, both adapter methods always return false, no Win32 input API is imported, and the actual RFB session still discards KeyEvent and PointerEvent. There is deliberately no operational **Allow control** button: showing it before injection has been separately qualified would misrepresent what is available. The existing local approval continues to authorize view-only access exclusively.

An independent future integration must satisfy all of these gates before enabling a local control prototype:

1. Add an explicit per-connection **Allow control** button distinct from **Approve view only**, with view-only as the default; bind the selected mode immutably to that session and its consent epoch. No client RFB bytes alone authorize input.
2. Build a Windows-native input adapter with verified `SendInput`/`SetCursorPos` interop, button/key release behavior, error handling and serialization with immediate Stop/lock revocation. Check the **Default** input desktop before each effect and never switch to or inject on secure/UAC/Winlogon desktops. Reject unmapped keys and invalid coordinates before any native call.
3. On an isolated, consenting Windows test machine, verify regular app typing and pointer movement, real viewer keyup/button-up traces, nondefault desktop/lock/UAC transitions, failed/partial Win32 injection, UI failures, rapid Stop/approve races, timeout and disconnect. Any failure must stop the input session without leaving remote-held keys or buttons. Review whether shared keyboard state and UIPI prevent safe bounds; an impossible guarantee blocks enablement.
4. Obtain independent hostile review and actual machine test receipts for the exact input-enabled head. Do not change loopback binding, RFB None security scope, firewall or listener exposure as part of this spike.

Sources: [RFC 6143 KeyEvent/PointerEvent](https://www.rfc-editor.org/rfc/rfc6143.html), [Microsoft SendInput/UIPI restrictions](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput), [Microsoft SetCursorPos desktop requirement](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setcursorpos).

## Windows-only manual qualification

1. On a consenting test PC with the .NET 8 SDK and a normal interactive desktop, run `dotnet run --project apps/host-windows/UnboundVnc.Host.Windows.csproj`.
2. Confirm the host UI is stopped by default. Start it intentionally.
3. Use a local RFB viewer to connect to `127.0.0.1:5901` and reject the prompt. Verify no RFB data or image is received.
4. Reconnect, approve the local consent prompt, and verify a bounded view-only desktop image. Attempt keyboard, pointer, and clipboard operations; none should affect the host.
5. Stop sharing, lock the workstation, switch to a secure desktop, and disconnect/reconnect Windows sessions in separate tests. Confirm capture/control does not continue and no stale image is transmitted.
6. Exercise multiple connections, abnormal disconnection, and rapid start/stop. Start a second host on the same port: the second should display a port error without crashing. While a nonmodal approval prompt is open, press **Stop and revoke** and ensure the prompt closes. Record failures and exact versions before declaring compatibility.
7. Use a high-rate framebuffer requester to check that capture is limited to approximately 10 FPS, while verifying normal client request/response compatibility.
8. In a disposable debug copy, inject an exception in the approval or capture worker (never in production). Confirm the listener is closed, the host UI reports an internal stop, and the user can start again. No automatic fault-injection test or live Windows test has run.

## Explicitly absent

- No LAN/Internet listener, TLS, authentication, unattended access, service install, firewall changes, or cloud relay.
- No enabled remote keyboard/mouse injection (only the disabled parsing spike above), clipboard, file transfer, multi-monitor management, reconnect credentials, or RealVNC feature parity.
- No UAC, Winlogon, locked desktop, pre-login, Session 0, or elevated-control support.
- No end-to-end automation, native Windows build artifact, signed installer, or physical-host validation.

Do **not** tunnel or expose this unauthenticated loopback service publicly. A production service needs authenticated/encrypted transport and threat-modelled consent binding before accepting remote connections.

The implementation is intentionally limited to a local security and protocol exploration for the UnboundVNC standard-RFB interoperability roadmap. Keep this PR as a draft until independent hostile review and real Windows tests pass.
