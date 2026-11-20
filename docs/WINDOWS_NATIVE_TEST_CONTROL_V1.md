# Engineer B V1 — actual RFB to Win32 native effects on an owner-created TEST form

**Source candidate only.** This stacked branch starts from PR #99 f690a8a498474a79c19e45865402d84be899e5c4. Do not merge, install, enable network listeners beyond localhost, or claim permission to operate Firefox/other personal windows merely because synthetic tests pass.

## Genuine Windows native input, bounded scope

The approved local host's existing RFB 3.8 session displays real Windows desktop pixels, with post-view consent proof, a fresh post-test-grant RFB challenge/echo, and a 5-minute session lifetime. Default connection is VIEW ONLY. Local host clicks a separate "Allow TEST input (owned form only)" button to create a disposable WinForms target, then a THIRD on-host button explicitly enables native TEST effects, leaving real Firefox and other windows excluded.

The private NativeOwnedTestFormInput class is the only new Win32 SendInput import permitted by the host test guard. Its methods independently check actual Windows default input desktop, exact top-level foreground HWND, matching host PID, unchanged bounds and current local session. The caller additionally runs under AttendedControlLease.TryApplyWhileCurrent, which verifies fresh UTC+monotonic expiry, epoch, consent, target and sequence under a shared Stop/revoke lock. The controlled TextBox KeyPress and native click handler recheck lease at message consumption time to reject events after Stop.

Effect scope:
- Keyboard: lowercase ASCII a-z only, one paired Unicode key down/up per RFB key-down. No Enter, Tab, shortcuts, control keys, modifiers, clipboard or arbitrary text.
- Mouse: left click only at the exact host-owned named test button rectangle; one bounded OS cursor move, left down and left up batch. No drag, right click, wheel or arbitrary coordinates.
- Partial native batch: attempt matching key-up or mouse-up release if the initial batch inserts only a prefix. Never treat partial injection as success. A failed corrective release remains a residual OS state risk and revokes source permission. Native Windows input is affected by UIPI/secure-desktop/foreground restrictions; an OS send result alone does not prove the right UI target received it.
- No prompt, client text or model message can grant permission or select another target: the only source grant is the visible host-local on-screen buttons.

The browser/viewer RFB path remains gateway-local on 127.0.0.1 with private per-launch host proof. Existing host proof via inherited same-user process environment is NOT independently authenticated Windows principal identity; test-only postgrant clipboard-style challenge is NOT encrypted peer authentication. Both require additional review before any cross-machine control or expanded target scope.

## Real-system qualification

Actual Lappy signed-in interactive Session 2 test (separate from CI) uses a source-matched ephemeral Windows host, local proof-bound gateway and Node WebSocket RFB client. UIAutomation invokes ONLY the source-owned local view/test/native permission buttons and reads disposable form state. Keyboard and mouse effects themselves are RFB packets passed through host lease and actual SendInput. Test observes a in the editable host-owned TextBox, precisely one native RFB pointer button click, rejection of buffered pregrant z/preecho b/Enter, rejection of a same-PID different-HWND key, then Stop/revoke, closed WebSocket, zero TCP5901 listener/host/temporary task. These are automated test grants, not human consent.

Synthetic hosted Windows CI also exercises the approved test-only RFB path; source-level C# negative lease and native import tests protect default off and wrong-target behavior. Tests never capture/publish real user pixels or keyboard text.

## Platform reality and explicit remaining work

Windows: current host is a bounded loopback RFB demonstration, primary-display capture cropped to at most 1280x720, with raw rectangles and up to 10fps update pacing; the default input is view-only and a signed-in default desktop is required. Blank/static desktop is not proof of fresh pixels; a frame-delivery freshness/blank-frame diagnostic and reconnect behavior still need real-system qualification. Secure desktop/UAC/lock must stop capture/input, never silently change to unattended.

Linux X11: standard TigerVNC/x11vnc/x0vncserver interoperability tests can exercise RFB framebuffer transport and X11 input where an owner-launched X session and correct local display authority exist. This Windows-specific native effect class is NOT a Linux input implementation. Linux Wayland compositors generally block X11-style global screen capture/input; use a compositor-approved portal/PipeWire or compositor-specific authenticated remote-desktop path, or explicitly report unsupported; never bypass Wayland security or silently fall back to Xwayland for full-desktop control.

VN1/VN2: live remote terminal calls were unavailable in this turn, so neither host was installed, configured, remotely viewed, or input-tested. Do not infer readiness merely from their Executor device registrations. No new host processes may be started after 13:00 EST 2026-11-20 under Patrick's present one-day grant.

## Release holds

Actual human on-host consent, authenticated/encrypted remote Vera peer, exact signed-in host Windows user/session/process attestation, legitimate external window selection, stale/disconnected/blank-frame handling, native input on VN1/VN2, Linux input path, and per-action exactly-once message receipts remain separate acceptance obligations. One successful disposable-form key and mouse event does not satisfy the full desktop-control product contract. Engineer A must independently falsify this exact head before any privilege expansion.