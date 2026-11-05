# Windows attended host (experimental)

This is an **attended experimental local host**, not a production remote-access service. It targets .NET 8 WinForms on Windows and serves RFB 3.8 on **127.0.0.1:5901 only**. The local user must explicitly choose **Approve view only** (default) or **Allow control** for each connection, before any RFB protocol or framebuffer bytes are sent. Approved sessions expire after five minutes. The operator can Stop and revoke. Windows lock/disconnect and nondefault input desktop checks cause the connection to stop. A post-capture desktop/consent-epoch check attempts to prevent sending stale frames after revocation; this is not an atomic guarantee against a transition during network writes.

The attended host is built and checked on Windows .NET 8 in pull-request CI; inspect the exact-head run before treating a result as current. No real interactive host session has been performed. Protocol interoperability, capture, consent visibility, native input effectiveness, crash handling, and lock/UAC behavior remain **runtime-unverified**. Windows compilation and mocked effect-gate tests cannot prove physical input behavior.

## Restricted attended local control prototype

`ExperimentalInputPolicy` validates bytes *after* RFB KeyEvent (7 bytes) and PointerEvent (5 bytes) message types, with exact-length, range, key mapping and coordinate checks. The limited keyboard set is ASCII printable characters, Backspace, Tab, Enter, Escape and arrow keys. It rejects modifier keys, unsupported X11 keysyms, noncanonical down flags, nonzero padding, oversized payloads, out-of-frame coordinates, arithmetic overflow and unsupported pointer button bits (wheel/extended buttons). This deliberately incomplete mapping is **not** suitable for generic RFB viewer input interoperability.

In default **view-only** mode, the RFB session still discards all keyboard and pointer messages. Only a separate, explicitly clicked host-side **Allow control** decision creates native input callbacks. That choice is bound to the approved session's epoch. `ConsentEffectGate` fences each effect against Stop, lock/disconnect, cancellation/timeout and the Default input desktop; failures revoke the epoch and terminate the session. This gate is source-implemented and mock-tested, **not** real-machine qualified.

`NativeInputAdapter` sends synthetic one-shot key and button **press/release pairs** via Win32 `SendInput`, with limited printable text through `KEYEVENTF_UNICODE`; it uses `SetCursorPos` for bounded primary-screen pointer movement. A failed/partial SendInput returns failure and makes a best-effort key/button release; it cannot guarantee physical release if Windows rejects both calls. RFB keyup messages do not hold a remote key, and pointer buttons click only on rising edges. **No drag, modifier combinations, key holds, wheel, clipboard, elevated input or desktop switching.** Input messages are handled at no more than approximately 50/s; the normal view stream remains bounded separately.

The following gates must pass on a consenting, isolated Windows machine **before describing this as a safe working control feature**:

1. Inspect the **Allow control** vs **Approve view only** UI and verify view-only is selected on Enter, denial is the default on dismissal, and a client cannot choose its own permission. Verify no RFB protocol bytes precede local approval.
2. Confirm `SendInput`/`SetCursorPos` interop, correct pointer coordinates at non-100% DPI, key/button press-release behavior and no synthetic keys left held after failures. Check the **Default** desktop before every effect and never switch to, inject on or capture secure/UAC/Winlogon desktops.
3. Exercise regular app typing and pointer movement, real viewer keyup/button-up traces, lock/UAC/Winlogon desktop transitions, partial Win32 insertion, UI failures, rapid Stop/approve races, timeout and disconnect; capture exact failure evidence. A race between desktop transition and native call cannot be proven atomic by source review.
4. Obtain independent hostile review and actual machine test receipts for the exact input-enabled head. Do not change loopback binding, RFB None security scope, firewall or listener exposure. If a release/revocation guarantee cannot be met, disable control again.

Sources: [RFC 6143 KeyEvent/PointerEvent](https://www.rfc-editor.org/rfc/rfc6143.html), [Microsoft SendInput/UIPI restrictions](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput), [Microsoft SetCursorPos desktop requirement](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setcursorpos).

## GitHub-hosted Windows desktop diagnostic (not consent qualification)

`tests/host-windows-runner-desktop` is run only on the ephemeral Windows Actions VM. It reads process/console session IDs, `UserInteractive`, window station, thread/input desktop names and screen-presence metadata. It never captures or logs screen pixels, sends keyboard/pointer input, changes Windows services or policy, or invokes a consent button. If a normal interactive **WinSta0/Default** console cannot be established, it logs `HOSTED_GUI_RUNTIME=BLOCKED_NONINTERACTIVE_DESKTOP` and skips launching the host. A successful diagnostic step is **not** a successful GUI/RFB runtime qualification.

Only if all session checks indicate a genuine interactive console does it render a test-owned solid-color form and check a **single in-memory pixel** via CopyFromScreen (without logging/saving image content). **A pixel mismatch fails the diagnostic before host launch.** After a match, it launches a temporary copy of the host, reads its window title and **Start local preview** child-caption without pressing it, observes port 5901 through read-only TCP metadata even if another process already owns it, then closes **only its own child**. It still does not approve sharing or claim RFB framebuffer output: automating the local approval would be synthetic consent, not proof of an attended human authorization boundary. Real RFB pixel tests remain gated on a specifically authorized interactive test machine with a real user present. This probe does not establish Windows 10/11 personal machine parity.

## Windows-only manual qualification

1. On a consenting test PC with the .NET 8 SDK and a normal interactive desktop, run `dotnet run --project apps/host-windows/UnboundVnc.Host.Windows.csproj`.
2. Confirm the host UI is stopped by default. Start it intentionally.
3. Use a local RFB viewer to connect to `127.0.0.1:5901` and reject the prompt. Verify no RFB data or image is received.
4. Reconnect, choose **Approve view only**, and verify keyboard, pointer and clipboard attempts do not affect the host. In a separate approved session deliberately choose **Allow control** and verify only the small mapped key/pointer subset affects a normal non-elevated test app; unsupported keysyms must end the session.
5. Stop sharing, lock the workstation, switch to a secure desktop, and disconnect/reconnect Windows sessions in separate tests. Confirm capture/control does not continue and no stale image is transmitted.
6. Exercise multiple connections, abnormal disconnection, and rapid start/stop. Start a second host on the same port: the second should display a port error without crashing. While a nonmodal approval prompt is open, press **Stop and revoke** and ensure the prompt closes. Record failures and exact versions before declaring compatibility.
7. Use a high-rate framebuffer requester to check that capture is limited to approximately 10 FPS, while verifying normal client request/response compatibility.
8. In a disposable debug copy, inject an exception in the approval or capture worker (never in production). Confirm the listener is closed, the host UI reports an internal stop, and the user can start again. No automatic fault-injection test or live Windows test has run.

## Explicitly absent

- No LAN/Internet listener, TLS, authentication, unattended access, service install, firewall changes, or cloud relay.
- No unattended input, modifier combinations, held keyboard keys, pointer dragging/wheel, clipboard, file transfer, multi-monitor management, reconnect credentials, or RealVNC feature parity.
- No UAC, Winlogon, locked desktop, pre-login, Session 0, or elevated-control support.
- No end-to-end automation, native Windows build artifact, signed installer, or physical-host validation.

Do **not** tunnel or expose this unauthenticated loopback service publicly. A production service needs authenticated/encrypted transport and threat-modelled consent binding before accepting remote connections.

The implementation is intentionally limited to a local security and protocol exploration for the UnboundVNC standard-RFB interoperability roadmap. Keep this PR as a draft until independent hostile review and real Windows tests pass.
