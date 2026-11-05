# UnboundVNC viewer browser smoke test

This is an optional **actual Chromium** UI test, not a simulated screenshot.
It exercises the device dashboard, add/search/persist profile, gateway-offline
error handling, and desktop/mobile screenshots. It intentionally mocks the
gateway API to avoid any connection to a real workstation.

From `apps/viewer/`, ensure dependencies and Playwright with its Chromium
browser executable are available locally, then run:

```bash
node e2e/smoke.mjs
```

If needed, install Playwright and its Chromium browser in your own local test
environment before invoking the script. No browser binary is bundled in the
repository; do not confuse a successful Vite build with browser verification.

By default, screenshots are created in a fresh operating-system temporary
directory printed on success. Set `UNBOUNDVNC_SCREENSHOT_DIR` to an explicit
directory to retain them elsewhere. Do not commit real remote-desktop captures.

The `Viewer Chromium smoke (synthetic, loopback)` GitHub Actions workflow runs
the same script in an ephemeral Ubuntu runner. It installs Chromium, opens only
an ephemeral `127.0.0.1` Vite listener, intercepts gateway API requests, and
uploads genuine desktop/mobile screenshots, a Playwright trace, and browser
console/page-error events as a 7-day workflow artifact. On browser-test failure,
it also attempts to capture `failure.png`. No real host, credentials, gateway,
public preview, or privileged repository token is needed.

To interpret a run, inspect the exact workflow job status and attached files.
An absent artifact or a successful source build alone is **not** browser proof.

## Stock TigerVNC framebuffer in actual Chromium (separate qualification)

The `Stock TigerVNC to Chromium framebuffer (loopback)` workflow runs
`node e2e/stock-rfb.mjs` on a disposable Ubuntu runner with an independently
packaged `Xtigervnc` X11 server. It paints a known 480×320 root color via
`xsetroot`, creates a one-port allowlisted *actual* loopback gateway, and uses
the viewer's normal Quick Connect/noVNC path in Playwright Chromium. It verifies
the decoded noVNC **canvas pixel** equals the X11 fixture's RGB bytes, then
captures `stock-rfb-session.png`, `framebuffer-pixel.json`, trace and console
events for readback. This is independent stock RFB server behavior, not
hand-written fixture packets or an image drawn by the test.

The fixture requests `SecurityTypes=None` solely for its explicit IPv4
**loopback-only** test endpoint. It cannot be used as evidence of encrypted,
authenticated, consented or authorized network access to a workstation.
Neither the RFB listener nor the gateway is published or deployed.

The same hosted stock-RFB test additionally checks genuine Chromium canvas
geometry for Fit screen → 1:1 → Fit screen, live resize to a 390px viewport,
and the **accessible name** of the mobile Fit screen control. It then shuts
down the throwaway stock server without the viewer disconnecting, verifies a
persistent unexpected-disconnect banner, starts a new 640×360 stock X11 server
on the same loopback RFB port, and exercises the visible Retry connection
button. The replacement framebuffer pixels, mobile layout, reset view-only
state and absence of stored credentials are asserted and captured as
`stock-rfb-reconnected-mobile.png` and `resize-reconnect-result.json`.
noVNC can report `clean: true` on a server-initiated socket close; that is
**not** proof the user deliberately disconnected. A remote close now always
shows the retry banner, whereas the explicit Disconnect button does not.
No automatic reconnection, host access or encrypted transport is implied.

## Stock VncAuth browser qualification (disposable password)

The separate `Stock TigerVNC VncAuth Chromium (loopback)` job runs
`node e2e/stock-vncauth.mjs`: a throwaway eight-character password is generated
inside the ephemeral CI runner and passed privately to `tigervncpasswd -f`.
The resulting owner-only TigerVNC password file is used by loopback-only stock
`Xtigervnc` and removed after testing. Chromium uses the viewer's real
`Credentials required` modal for a correct-password framebuffer and a wrong-
password rejection before any remote session can establish. It also asserts
browser storage contains no password.

The artifact contains **only credential-free** screenshots taken before the
password is typed or after the authentication form is cleared, plus a result
summary and browser console events. **Playwright tracing is intentionally
disabled** for this test because traces may retain user-entered passwords.
No plaintext password, encoded password file, challenge, response or secret
environment variable is uploaded, committed or logged. This is still only
loopback VncAuth interoperability: VncAuth does not encrypt the transport or
establish server identity/host consent.

Passing this script establishes **UI interaction and rendering only**. It
does not prove noVNC framebuffer display, authentication, secure connectivity,
Windows host support, or RealVNC feature parity.

## Real pointer and keyboard delivery into a disposable stock X11 window

`Stock TigerVNC Chromium input witness (loopback)` runs `node e2e/stock-input.mjs`
on hosted Ubuntu. `Xtigervnc` provides a fresh, test-owned 480×320 X11 display
and loopback RFB endpoint. A separate, independently packaged `xev` X11 window
records actual ButtonPress/KeyPress events, and `xdotool` focuses that window.
Playwright Chromium interacts with the **visible noVNC canvas** via the normal
viewer and one-port-allowlisted loopback gateway; it never injects directly
into X11. Before its positive click and `k` keystroke, it enables the viewer's
**View only** switch and requires that a click and `v` keystroke produce *no*
new X11 input events. Then it disables view-only and requires `xev` to record
button 1 at root coordinate 240,160 and keysym `k`.

The screenshot and `x11-input-result.json` artifact are captured from the
actual hosted browser and X11 event witness, not a mocked event handler.
There are no credentials, user-owned desktops, public ports or real-system
input devices. **View only is a browser preference, not a host authorization
boundary**. A pass proves this Ubuntu/Chromium/stock-RFB input path only, not
Windows native input injection, host consent or transport encryption.
