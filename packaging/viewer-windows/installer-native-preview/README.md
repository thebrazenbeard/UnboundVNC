# Hosted native Inno engine experiment — CI only

**Boundary:** This source compiles a real unsigned Inno Setup EXE on a standard
GitHub-hosted Windows 2025 runner and exercises its *actual setup and uninstall
executables* in a fresh GUID-named subfolder of `RUNNER_TEMP`. It is **not a
consumer installer**, is **not installed on Patrick's or any other user's PC**,
does not write to actual `%LOCALAPPDATA%`, has no Start Menu/desktop shortcut,
service, firewall rule, updater, shell registration, or uninstall registry entry,
and uploads no binary. The entire app folder is test-owned and removed.

The native setup uses Inno's documented `PrivilegesRequired=lowest`, no
privilege override, `CreateUninstallRegKey=no`, `UsePreviousAppDir=no`, and
strictly embeds the one runner-specific destination. Setup's `PrepareToInstall`
rejects `/DIR` redirection and an existing destination. Its uninstaller requires
the compiled GUID marker, an embedded-SHA256-bound file manifest, every recorded
payload hash and an exact recursively enumerated directory/file inventory
without symlinks/junctions before proceeding. The CI harness separately refuses
unknown, modified, locked, or symlink/reparse content. Both layers are
test-only; the unsigned native EXE and manifest are **not** a tamper-resistant
distribution security boundary and no crash-recovery guarantee follows.

`Invoke-HostedInnoAcceptance.ps1` fails closed off a GitHub-hosted Windows
runner. On CI it:

1. Hash-inventories **all files**, including hidden content, in the unsigned
   Electron app folder and records current-user Add/Remove Programs key names.
2. Compiles test-owned unsigned setup with Inno's installed compiler; verifies
   signature absence and hashes the setup; rejects hostile `/DIR` override.
3. Runs native setup silently and verifies every installed app file's size and
   SHA256, one native uninstaller, exact owner marker, no unexpected files,
   unlocked payload, and no HKCU Add/Remove Programs key delta. A second setup
   attempt must reject the occupied destination without modifying the payload.
4. Launches the **installed** Electron EXE against a synthetic local RFB 3.8
   server. Its renderer tests the 2×2 raw RGBX framebuffer **16 RGBA bytes**
   (red, green, blue, white), disconnect, process exit, and closed loopback ports.
5. Falsifies harness guards with an unknown file, exclusive lock and junction.
   Then invokes the **native uninstaller directly** against altered/missing
   ownership marker, extra installed file, a junction, and the native Inno
   `unins000.dat` deletion-plan log when its middle byte is changed, it is
   truncated, or it is missing. Each must return a nonzero refusal (bounded
   25 seconds) without changing any app SHA256 or a test-owned decoy. The
   log fixtures restore its original SHA256 from outside the installed tree
   before the next case. After removing only those fixtures, native uninstall
   must remove the app folder, retain separate profile/decoy and preserve
   every original source hash and the HKCU key inventory.
6. Deletes only the GUID marker-owned test root after rejecting reparse content.
   No executable artifact is uploaded by this workflow.

## $0 tooling decision and license boundaries

The [official Windows 2025 GitHub runner image inventory](https://github.com/actions/runner-images/blob/main/images/windows/Windows2025-Readme.md)
lists Inno Setup 6.7.1 already installed. This test uses it without fetching a
binary. [Inno's license](https://github.com/jrsoftware/issrc/blob/main/license.txt)
permits commercial use, while its [publisher explicitly asks commercial users
to purchase a license](https://jrsoftware.org/isinfo.php); that request must be
resolved before commercial distribution. The project's own source-available
license is a **separate** distribution constraint. The current
[WiX repository](https://github.com/wixtoolset/wix) requires an Open Source
Maintenance Fee for revenue-generating uses. [NSIS](https://nsis.sourceforge.io/License)
has zlib/libpng licensing (some optional compression modules differ) but is not
listed in the pinned runner's preinstalled software. Inno was chosen for this
ephemeral real-engine test; no claim is made that it is the final distribution
technology.

## Explicitly unqualified

- No Windows 10/11 end-user installation, attended wizard UX, real normal-user
  profile/ACL test, upgrading, migration, filesystem crash recovery, disk-full
  behavior, or full registry write audit; there is no Add/Remove Programs entry.
- No code-signing certificate, reputation, SmartScreen/Smart App Control
  clearance, antivirus false-positive qualification, binary release, user
  consent flow, or third-party commercial redistribution clearance.
- CI's separate source app folder and synthetic RFB fixture are not a real
  remote host. The gateway stays on `127.0.0.1` and exits with Electron.

Only a reviewed separate release plan should graduate this deliberately
test-owned compiler script into a per-user consumer installer.

The native file manifest is generated under the unique CI root at compile time,
copied into the installed app, and its SHA256 is embedded in the unsigned Inno
script. This detects accidental or test-injected changes, not malicious
same-user alteration of the unsigned executable, replacement of its compiled
guard, path-swap races, all alternate data streams or arbitrarily interrupted
uninstall. A test-first hosted red run confirmed that the previous owner-only
native script partially deleted installed payload when an unknown file existed;
the current native guard must pass fresh hosted negative fixtures before import.
Unlike the 73 application hashes, `unins000.dat` is generated by the Inno
engine during installation and **is not bound to the compiled SHA256 manifest**.
Native deletion-plan tamper cases test whether the current engine itself fails
closed for these bounded corruptions. Even a green test does not authenticate
arbitrary changes to this log or establish that its contents are protected
from a same-user adversary.

### Deliberately valid, foreign deletion-plan falsifier (CI-only)

The next hostile fixture compiles a **second unsigned Inno setup** for an
entirely separate install folder under the **same** GUID-owned `RUNNER_TEMP`
root and the same test `AppId`. Only that compile passes `CI_ProbeDelete`,
adding one `[UninstallDelete]` entry for a precisely named synthetic sibling
decoy **inside the same test root**, never an actual workstation path. Inno
itself generates the second `unins000.dat` with valid format/CRC. The harness
copies that log before running the second native uninstaller: that positive
control must remove only its own installed app and the test-owned decoy.
After restoring the exact decoy hash, the harness replaces the original
install's `unins000.dat` with those engine-generated bytes and runs the
**original native uninstaller**. A safe outcome requires nonzero refusal,
preservation of all 73 installed application hashes and the decoy, and a
subsequent clean uninstall after pristine log restoration. Any change to
those files is **RED** even if the attacker-supplied plan itself has a valid
engine CRC. This is deliberate test-owned data loss only, never a release
feature, and does not authorize a real-user installer or hostile log parsing
outside the disposable runner root.

### Same-install-root valid log substitution (separate follow-up experiment)

A different-root log may be refused because its recorded setup location does
not match the original. To isolate that confounder, an additional **CI-only**
fixture compiles a third unsigned Inno setup with the *identical* AppId and
the *identical* original installation path, plus the same single synthetic
decoy deletion. Only after the original app's entire installed file inventory
passes SHA256 and exclusive-read checks is its folder **renamed intact** into
a sibling backup under the same test-owned GUID root. The probe setup may now
run at the vacated exact path. Its actual uninstaller must positively delete
the probe app and the synthetic decoy. The original app is always restored in
a `finally` block from the complete, verified backup, never overwritten by
probe remnants. Any remnants are moved intact into a fresh in-root quarantine
before original restoration, and an ambiguous probe owner marker fails the
test. All 73 app hashes, owner marker, native metadata hashes and reparse
boundaries are checked after restoration.

Only then is the Inno-generated valid **same-root** probe log substituted for
the original app's log. The original native uninstaller must return a nonzero
refusal **and** preserve every installed payload hash and the non-owned decoy;
the pristine original log is restored afterward. A failure of the positive
control is a fixture failure, **not** exploit evidence. If the original
uninstaller changes the app/decoy after accepting the same-root probe log,
that is a substantive test-owned **RED**. The test does not exercise arbitrary
binary log forgery or prove an integrity/TOCTOU boundary against same-user
malicious writes; no real machine, external path or binary release is in scope.
