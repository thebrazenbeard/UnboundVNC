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

Passing this script establishes **UI interaction and rendering only**. It
does not prove noVNC framebuffer display, authentication, secure connectivity,
Windows host support, or RealVNC feature parity.
