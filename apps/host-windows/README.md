# Windows attended host (experimental)

This is a **source-only, view-only proof of concept**, not a production remote-access service. It targets .NET 8 WinForms on Windows, serves RFB 3.8 on **127.0.0.1:5901 only**, asks the logged-in local user to approve each connection before any RFB protocol or framebuffer bytes are sent, and limits each approved session to five minutes. The operator can stop sharing. Windows lock/disconnect and nondefault input desktop checks cause the connection to stop. A post-capture desktop/consent-epoch check attempts to prevent sending stale frames after revocation; this is not an atomic guarantee against a transition during network writes.

No source here has been compiled or run on Windows in this PR. The authoring environment lacked a Windows runtime and .NET compiler. Building, protocol interoperability, capture, consent visibility, crash handling, and lock/UAC behavior are **unverified**. Static source review changes do not constitute a Windows build or runtime test.

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
- No remote keyboard/mouse injection, clipboard, file transfer, multi-monitor management, reconnect credentials, or RealVNC feature parity.
- No UAC, Winlogon, locked desktop, pre-login, Session 0, or elevated-control support.
- No end-to-end automation, native Windows build artifact, signed installer, or physical-host validation.

Do **not** tunnel or expose this unauthenticated loopback service publicly. A production service needs authenticated/encrypted transport and threat-modelled consent binding before accepting remote connections.

The implementation is intentionally limited to a local security and protocol exploration for the UnboundVNC standard-RFB interoperability roadmap. Keep this PR as a draft until independent hostile review and real Windows tests pass.