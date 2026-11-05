# Windows attended-host packaging — source-only prototype

This folder is **not a shipped installer**, MSI, signed executable, or verified
Windows release. The PowerShell scripts are a reversible, explicit-consent
per-user staging experiment for a separately produced attended-host binary.
No installer toolchain (NSIS/WiX), binary dependency license, signing identity,
or Windows execution environment has been qualified here.

## UX and safety boundary

The intended eventual experience is a simple RealVNC Lite-like attended host:
download, inspect publisher/permissions, install per-user, launch on demand,
share a short-lived attended session, and uninstall cleanly. **Only the
file-staging/uninstall source prototype exists here**. No start-menu shortcut,
automatic launch, tray UI, service, firewall exception, unattended access,
elevation, persistence, or consent dialog is supplied by these scripts.

## Invocation (trusted Windows test VM only, not a release recipe)

1. Independently build and review the attended-host artifact, its source and
   transitive licenses. Record the exact executable SHA-256 and provenance.
   **Ordinary `dotnet build` output is not suitable:** a framework-dependent
   WinForms apphost requires its companion DLL, runtimeconfig, deps manifest and
   installed runtime, while this prototype stages exactly one `.exe`. For a
   build-only `win-x64` candidate, from the repository root use a trusted
   Windows .NET 8 SDK:

   ```powershell
   dotnet publish apps/host-windows/UnboundVnc.Host.Windows.csproj --configuration Release --runtime win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true --output "$env:TEMP\unboundvnc-publish-check"
   ```

   Verify the output is exactly one `.exe` plus optional nonruntime debug
   symbols, with no loose `.dll`, `.deps.json`, or `.runtimeconfig.json`.
   A Windows Actions build gate checks this shape on ephemeral CI only. It does
   **not** run or install the build, prove startup on clean Windows, establish
   third-party distribution rights, or make the output a release artifact.
2. Review both PowerShell scripts before invocation. In PowerShell 5.1, preview:

   `./Install-AttendedHost.ps1 -ExePath 'C:\staging\host.exe' -ExpectedSha256 '<64-digit-SHA256>'`

3. Only if license/dependency review passes, use the same arguments plus
   `-LicenseAcknowledged -Apply`. This copies into
   `%LOCALAPPDATA%\UnboundVNC\AttendedHost` and writes a receipt. It does not
   start anything. Existing targets are refused; this is not an updater.
4. Preview uninstall: `./Uninstall-AttendedHost.ps1`. Apply with `-Apply`
   only when the binary still matches the receipt, the directory has exactly
   the two owned files, and the host process is not running. Edited/extra files
   require manual review rather than deletion.

## Release gates (all currently unmet here)

- SOURCE: correlate executable with reviewed attended-host source/head and
  reproduce build plus SBOM/license analysis; resolve redistributable rights.
- BUILD: select and license-check a real packager and toolchain, then produce
  reproducible artifacts in a clean Windows environment. None is bundled.
- TRUST: signing certificate, signature verification, publisher/reputation,
  download integrity and malware scanning. Do not label unsigned files trusted.
- UX: visible consent, on-demand launch, accessibility, clear permission
  notices and explicit refusal of unattended persistence unless separately designed.
- TEST: Windows 10/11 clean user install, default preview no-op, hash mismatch,
  existing-target rejection, interrupted copy rollback, second-run refusal,
  running-process uninstall refusal, extra/edited file refusal, successful
  uninstall, and post-uninstall account/service/firewall/registry diff.
- REVIEW: security/privacy and independent human acceptance before release.

Static contract checks in `tests/test_contract.py` are a source inspection
guard only. The separate GitHub-hosted Windows runner workflow executes the
PowerShell scripts against inert dummy bytes under a unique `RUNNER_TEMP`
sandbox; it checks preview/apply/uninstall, refusal of modified/extra files,
orphaned partial staging, and unsafe paths. It must not run on self-hosted
runners or real user workstations. Even a green CI run is not a clean-machine
installer qualification, native host run, or release gate pass.
