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

Passing this script establishes **UI interaction and rendering only**. It
does not prove noVNC framebuffer display, authentication, secure connectivity,
Windows host support, or RealVNC feature parity.
