# Windows viewer dependency and redistribution gates (source audit)

Status: **SOURCE_INSPECTION + DEP_METADATA + focused TEST**, 2026-11-05.
This is a release blocker checklist, not a legal opinion, permission to ship,
Windows installer test, or signed-distribution qualification.

## Exact source baseline

The opt-in Windows preview uses `@novnc/novnc@1.7.0` in the viewer lockfile;
`electron@45.2.1` and `@electron/packager@20.3.0` in the wrapper lockfile.
The two npm package-lock v3 graphs contain **65 + 51 = 116** installed-entry
records, including optional/platform-specific and build-time dependencies.
All 116 declare a license expression and HTTPS npm registry URL with SHA-512
integrity metadata. Their declared license distributions at this checkpoint:

| Graph | Declared expressions and entry counts |
| --- | --- |
| Viewer (65) | MIT 62, MPL-2.0 1, ISC 1, BSD-3-Clause 1 |
| Windows packager (51) | MIT 36, BSD-2-Clause 3, Apache-2.0 2, BlueOak-1.0.0 5, ISC 5 |

The five BlueOak-1.0.0 entries are `glob`, `lru-cache`, `minimatch`,
`minipass`, and `path-scurry`; their actual files/notices require inspection
before release. The lockfile **does not tell which files were copied into the
Vite bundle, `app.asar`, Electron native runtime or final Windows folder**.
An npm package's license field is metadata, not the full license text or
evidence that every file and transitive native library has that license.

The exact, pure-Node checker can be run without installing dependencies:

```bash
node --test packaging/viewer-windows/tests/license-inventory.test.mjs
node packaging/viewer-windows/scripts/license-inventory.mjs --check
node packaging/viewer-windows/scripts/license-inventory.mjs --json
```

`--json` emits a stable **lockfile license-metadata inventory**, retaining
install paths (including nested versions), origin URLs, integrity strings,
declared SPDX expressions, development/optional flags and source lockfile
SHA-256 digests. This is **not** a complete SPDX/CycloneDX SBOM or generated
redistribution notice. The checker fails on changes to three designated direct versions,
missing license/integrity, non-registry resolution, unsupported schema and any
new (including GPL) license expression until explicit human source review.
Its known-expression list is a change detector, **never legal approval**.

The direct-version assertion covers **only three designated packages**:
`@novnc/novnc@1.7.0`, `electron@45.2.1` and
`@electron/packager@20.3.0`. The emitted SHA-256 hashes are informative;
the checker **does not compare them with an independently approved baseline**.
An unchanged package count and known license expression can therefore mask
substitutions among other dependencies. A future release gate must compare
the full graph/hash to a separately reviewed, signed/approved manifest.

## Notable upstream license evidence

- [noVNC tag v1.7.0 `LICENSE.txt`](https://github.com/novnc/noVNC/blob/v1.7.0/LICENSE.txt)
  assigns JavaScript core to **MPL-2.0** and separately describes HTML,
  stylesheet, font and image licenses (BSD-2-Clause, SIL OFL 1.1 and
  CC BY-SA 3.0). Determine *exactly which files* are in the Vite output.
  For MPL-covered files actually distributed in executable form, preserve
  notices and satisfy the applicable source-form availability requirements,
  including changes to those files; do not impose the proprietary application
  license on independent MPL-covered material.
- [Electron tag v45.2.1 `LICENSE`](https://github.com/electron/electron/blob/v45.2.1/LICENSE)
  is MIT, but its **downloaded Windows executable payload includes Chromium,
  Node and native libraries** with additional third-party notices that the
  `electron` npm wrapper metadata does not enumerate. Inspect the actual
  binary package and preserve its required license material.
- [`@electron/packager` tag v20.3.0 `LICENSE`](https://github.com/electron/packager/blob/v20.3.0/LICENSE)
  is **BSD-2-Clause**, not MIT, as independently reflected in the npm lockfile.
  It is a development tool; whether any of its files ship requires an actual
  packaged-folder inventory. NoVNC's and Electron's license grants remain
  distinct from the UnboundVNC original-code license.
- [npm package-lock v3](https://docs.npmjs.com/cli/v11/configuring-npm/package-lock-json/)
  records the resolved npm graph; it is not a binary-composition or notice
  attestation. [Electron packaging](https://www.electronjs.org/docs/latest/tutorial/application-distribution)
  explicitly includes a separate prebuilt Electron runtime when distributing
  the app, outside these npm package-lock declarations.

## Required release-manifest/notice pipeline (NOT IMPLEMENTED)

1. Build the actual Windows application folder in a clean, locked environment;
   hash the Electron ZIP, final EXE/DLLs, renderer output and `app.asar`.
   Export an exhaustive **shipped-file** list, not only dev-time npm packages.
2. Associate shipped bytes with component name/version/upstream source commit,
   supplier, exact license expression and *verified license file*, copyright
   attribution, patches, build flags and any source-offer location. Resolve
   duplicate/versioned packages and Electron/Chromium/Node nested notices.
3. Generate and manually approve SPDX 2.3 or CycloneDX inventory plus a
   `THIRD_PARTY_LICENSES` notice/text bundle from reviewed source files;
   distinguish build-only packages from distributed material. Include MPL
   obligations and separately licensed noVNC assets **only if present**.
4. Copy validated full license texts/attributions and any required source
   availability information into a user-accessible release location. The
   current `prepare.mjs` copies `THIRD_PARTY_NOTICES.md` (candidate table)
   and UnboundVNC's own license, **not** the full verified third-party texts.
5. Add a fail-closed Windows artifact test that scans every final-file digest,
   checks legal-review approval for newly shipped components, checks notices
   are retrievable after packaging, and prevents upload on unresolved entries.

The stock Linux `x11vnc` and TigerVNC `X0tigervnc` servers are installed by
ephemeral Ubuntu interop workflows and are **not copied, linked or vendored by
this Windows packager's reviewed `prepare.mjs` source**. That narrow source
finding is not a whole-repository binary provenance or GPL-clearance opinion.
If a future Windows release includes a GPL/LGPL codec, server, executable or
shared library, review exact obligations and integration form separately.

## Shipping gates — unsigned and signed are different

- **Unsigned folder:** the current workflow produces an unpacked folder,
  not an installer, updater or proven clean Windows 10/11 deployment. Electron
  [strongly recommends code signing](https://www.electronjs.org/docs/latest/tutorial/code-signing)
  because unsigned programs face OS warning/manual trust steps. Unsigned
  software is not categorically impossible to distribute, but it fails a
  frictionless trustworthy end-user release gate. The CI folder is deliberately
  never uploaded.
- **Signed build:** procure/authorize a publisher identity/certificate or
  signing service (cost and availability **unknown**, not assumed $0); securely
  protect signing credentials, sign all applicable binaries and the eventual
  installer, timestamp, then independently verify signature chain and file
  digests on clean Windows machines. Signing by itself does not establish
  SmartScreen reputation, absence of malware, safe auto-update or functional
  RFB authentication.
- **Both paths:** install/uninstall/rollback, offline startup, accessible
  license notice UI, no surprise auto-start/service, package antivirus scan,
  Windows 10/11 clean-machine testing, consent/host identity, encrypted remote
  transport, and accurate personal-versus-commercial rights remain unpassed
  deployment/security gates.

These are source/design and metadata findings; no release artifact was
inspected, signed, shipped, installed or legally cleared by this audit.
