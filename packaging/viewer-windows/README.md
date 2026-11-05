# Windows desktop viewer — Electron packaged-folder experiment

**This source is not a Windows installer or released viewer.** It builds an
unsigned, unpacked Windows application folder on a public GitHub-hosted runner;
the folder is deliberately **not uploaded or distributed**. CI can attempt an
ephemeral native Electron window/renderer/gateway lifecycle smoke test, but
end-user launch, installation, VNC interoperability, offline first-run behavior,
signing, SmartScreen and uninstall remain separately unverified gates.

## Choice, rejected shortcuts and cost

| Candidate | What works | Why it is not the current installable answer |
| --- | --- | --- |
| PWA | Browser-managed launch icon; offline UI assets are possible | Requires browser installation and a separately owned Node gateway lifecycle. An installable icon alone cannot bridge the current RFB `/api` and `/ws`. |
| WinForms/WebView2 | Small native window; Evergreen WebView2 often present on supported Windows | WebView2 runtime is a client prerequisite or separate licensed/offline runtime; it does **not** include Node 22+ for this gateway. Needs a separate safe backend bundle/lifecycle. |
| Tauri | Leaner executable/NSIS or WiX route | Windows relies on WebView2 plus Rust toolchain; still needs a Node-gateway alternative, with installer behavior not yet verified. |
| Electron (selected prototype) | Bundles Chromium and Node with one JavaScript application; no separate browser or paid relay | Larger footprint and dependency/notice work. `@electron/packager` produces an app **folder**, not an installer. Unsigned binaries face Windows reputation warnings. |

Primary references: [Electron distribution](https://www.electronjs.org/docs/latest/tutorial/application-distribution),
[Electron security](https://www.electronjs.org/docs/latest/tutorial/security),
[WebView2 distribution](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution),
[Tauri Windows prerequisites](https://v2.tauri.app/start/prerequisites/),
[PWA installability](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable).
Electron and its toolchain are MIT-licensed, but bundled Chromium, Node and
transitive components have distinct notices and redistribution obligations.
UnboundVNC original code retains the repository's personal-use/commercial-rights
license. A release needs a complete audited manifest and written redistribution
authorization where required; free tooling does not erase those gates.

## What the prototype source actually does

- The desktop executable would open a sandboxed `BrowserWindow` containing the
  **production Vite build** (saved devices/quick connect/session UI), not a
  developer browser tab or Vite development server.
- It starts the existing reviewed gateway on **random 127.0.0.1 ports**,
  with only RFB TCP ports 5900 and 5901 allowed. It creates a separate loopback
  static-server and same-origin `/api` + `/ws` forwarder because the current
  viewer expects Vite's development proxy. The wrapper enforces exact Host and
  Origin, then rewrites requests to the private gateway's accepted origin.
- The Electron renderer has `nodeIntegration: false`, `contextIsolation: true`,
  `sandbox: true`, disabled permission requests, blocked extra windows and
  navigation, and a restrictive local Content Security Policy. No preload bridge,
  external website, tracking, account, service, or firewall rule is created.
- The user's explicit desktop launch owns both loopback servers. Closing the
  window closes them and all proxy sockets. No auto-start, service, background
  persistence, tunnel or public listener is registered.
- The gateway retains its **loopback-only target restriction**, which means
  this is **not yet a cross-network remote viewer** even if the form accepts
  arbitrary hostnames. Native Windows attended-host port 5901 is admitted;
  real-host interoperability and consent/authentication remain separate gates.

## Build/test steps (isolated developer/CI only)

With Node 24 and Windows, from repository root:

```powershell
npm ci --prefix apps/viewer
npm run build --prefix apps/viewer
npm ci --prefix packaging/viewer-windows
node --test packaging/viewer-windows/tests/local-server.test.mjs
node packaging/viewer-windows/scripts/prepare.mjs
& './packaging/viewer-windows/node_modules/.bin/electron-packager.cmd' packaging/viewer-windows UnboundVNCViewer --platform=win32 --arch=x64 --out="$env:TEMP\viewer-source-check" --asar
```

`prepare.mjs` deliberately requires a fresh absent `runtime/` directory rather
than overwriting stale build content. The GitHub workflow runs from a fresh
checkout and checks the `.exe`/`app.asar` shape. Do not distribute that output.
The source tests exercise the real gateway's local `/api` policy with temporary
assets, host/origin denials, refused untrusted WS upgrades, a successful
synthetic loopback RFB WebSocket greeting, and explicit close. The hosted
Windows workflow additionally launches Electron in a CI-only mode, checks the
real viewer DOM and local gateway health, drives Quick Connect to the packaging
test's synthetic loopback RGBX RFB fixture (matching noVNC pixel format),
requires an actual 2×2 canvas with exact red/green/blue/white RGBA pixels,
disconnects, then requires process exit and both
app-owned listeners closed. It uploads only a credential-free **dashboard PNG**,
not an executable or remote framebuffer. This does not prove a real user-host
session, installed viewer, or secure remote transport.

The separate `windows-viewer-copy-lifecycle.yml` workflow tests a fuller
**disposable app-folder copy**, still only on a GitHub-hosted Windows runner:

1. Build an unsigned Electron app folder under runner temp; copy the entire
   folder into a unique GUID-named, ownership-marked runner-temp sandbox and
   compare SHA256 for **every file**, including hidden/system files, `.exe`
   and `app.asar`; reject descendant symlinks/junctions/reparse points.
2. Launch **the copied executable** using a fresh `userData` profile inside
   that sandbox; start only a synthetic loopback RFB 3.8 fixture. The actual
   Electron renderer submits Quick Connect, receives a 2×2 RGBX framebuffer,
   and must report all 16 exact RGBA bytes (red/green/blue/white); an existing
   canvas element or just a Connected label cannot satisfy this oracle.
3. Exercise explicit Disconnect back to the dashboard, clean Electron exit,
   and closure of both app-owned loopback listeners plus the synthetic RFB
   fixture listener. The sandbox (copied folder, profile, and test receipts) is
   removed in `finally` after killing any surviving **owned child processes**;
   **every** original build file must retain the same SHA256/size manifest.
4. Independently test unsafe cleanup-target rejection and an injected exception
   immediately after the copy to verify bounded cleanup under failure; test a
   nested-junction rejection where hosted Windows permits a test-owned junction.

No app folder/binary, profile or framebuffer is uploaded. The test touches no
user machine, installer registry entries, Windows service, firewall rule,
startup setting, or real VNC host. Copying a folder and deleting it proves a
bounded **install-like / uninstall-like lifecycle harness**, **not** an actual
Windows installer, signed build, clean Win10/11 end-user acceptance, or
application-data migration/rollback contract.

## Missing release and usability gates

1. Clean, nondeveloper Windows 10/11 app-folder **launch and exit**; inspect
   visible display, saved profiles, native window UX and full shutdown. A hosted
   Windows Server CI smoke cannot replace interactive Windows 10/11 review.
2. Windows packaging with legitimate installer/uninstaller, per-user permissions,
   updates/rollback, accurate uninstaller and data retention policy; no silent
   autorun or service startup.
3. Host/gateway signed consent and authentication, actual RFB interoperability,
   secure remote transport, allowed target policy, and abrupt FIN/parser fix.
4. Third-party SBOM and licenses for Electron/Chromium/Node/noVNC/Vite;
   distribution permission, malware scanning, publisher signing and SmartScreen.
5. Reproducible artifact digest, Windows 10/11 clean VM matrix, accessible UI
   review and realistic offline tests before the word **installed** is used.
