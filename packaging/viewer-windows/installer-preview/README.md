# Windows viewer per-user installer preview — source/test only

**Not an installer, uninstaller, distributable download or install command for a user machine.** These PowerShell files explicitly refuse anything except an ephemeral GitHub-hosted **Windows** Actions runner (`GITHUB_ACTIONS`, `RUNNER_OS`, `RUNNER_ENVIRONMENT`). They create no registry keys, shortcuts, services, firewall changes, startup tasks or signed binaries.

The workflow builds the current unsigned Electron **folder** from pinned source, then exercises a per-user-**shaped** destination under a new GUID-only `$env:RUNNER_TEMP` child:

`<runner-temp>/unboundvnc-viewer-preview-<guid>/User/LocalAppData/Programs/UnboundVNCViewer/`

This is not the actual Windows user's `%LOCALAPPDATA%`, and it intentionally does not claim to be. It avoids altering even the runner account's real program install or profile. Electron `userData` is also redirected into that unique sandbox during the hosted run.

| Command mode | Bounded effect |
| --- | --- |
| `PreviewInstall` | Read/validate the unsigned source-folder manifest and print intended test destination. No filesystem write. |
| `ApplyTest` | Refuse existing destination; create owner marker, copy into hidden pending sibling, compare complete file/directory inventory (including hidden/system files and SHA256), then rename into destination and write versioned receipt. Injected copy failure removes the newly created test root. |
| `PreviewUninstall` | Read owner marker and receipt, require exact inventory, no unknown/modified files, symlinks/junctions or locked file handles. Prints read-only plan. |
| `RemoveTest` | Same strict preflight; copy SHA256-verified recovery folder; rename installed folder, then remove test app files. Injection before deletion restores app from recovery and keeps installed receipt. Successful removal changes receipt to `removed`, retains separate profile/data for inspection and refuses repeat removal. |

The hosted acceptance performs both negative and positive paths, including an actual Electron EXE launch from the staged destination: synthetic loopback RFB 3.8 RGBX 2×2 renderer canvas must match all 16 RGBA bytes red/green/blue/white, explicit Disconnect, app and gateway exit, and all three known loopback ports closed. It then exercises unknown-file, exclusive file-handle, nested junction, ownership and rollback guards. The test harness alone finally deletes the GUID-owned ephemeral sandbox and retained synthetic profile; `RemoveTest` itself intentionally **does not** delete profile/data or arbitrary unknown files.

Windows Electron child processes or background file scanners may briefly retain
EXE mappings after the top-level viewer PID exits. The hosted acceptance now
waits at most 45 seconds for three consecutive samples showing no matching
app-path Electron descendants, no inaccessible same-name PIDs, no exclusively
locked installed files, and no known loopback listeners. It does **not** kill
unknown processes or weaken the transaction's independent locked-file refusal;
if quiescence cannot be demonstrated, uninstall and locked-root cleanup fail
closed. Negative cases also require their *exact expected refusal reason*, so
an incidental EXE lock cannot masquerade as an unknown-file or app.asar guard.
The hosted test also acquires an exclusive handle on its own staged viewer EXE
for three seconds in a bounded background thread: the transaction must refuse
that exact EXE lock, and the passive quiescence check must wait for the handle
to be released before proceeding. Final sandbox teardown independently checks
every file handle; a locked file is preserved, even inside a disposable runner.

The separate hosted concurrency acceptance (Draft #55) first demonstrated a
real defect: `RecoverTest` could delete a **still-running** `ApplyTest` journal
sandbox. All preview operations now acquire a **nonblocking named Windows OS
mutex** keyed to the validated ephemeral root GUID before touching it; an
active competing Apply/Recover/Remove operation is rejected without mutation.
The kernel mutex is released on normal exit or process termination; recovery
after a killed owner still must pass the existing marker/journal/hash guards.
Hosted tests exercise both live Apply and live Remove contention. This is a
CI coordination mechanism, not protection against malicious same-user code,
kernel compromise, arbitrary filesystem swaps or power loss.

Important limits:

- Environment-based CI gating is a test safeguard, **not a Windows security boundary** against someone controlling a local process and its environment. These scripts are **not supported for real user installation**.
- The rollback test covers copy failure and pre-delete uninstall interruption, plus a recovery copy. It does not yet establish power-loss safety, atomic multi-file rollback under an arbitrary disk failure, malware-resistant manifests, or concurrent mutation/TOCTOU safety. Receipt integrity is not cryptographically authenticated.
- The hosted runner is Windows Server, not a clean, nondeveloper Windows 10/11 user VM. No installer UX, Start Menu registration, Add/Remove Programs integration, elevation handling, updates, app signing/SmartScreen, offline first run, or real VNC-host consent/authentication is qualified.
- There is no distributable binary upload. A future real MSI/NSIS/WiX installer requires third-party notice/license and signing decisions, explicit authorization, Windows user testing and a proven uninstall/data policy. Free source tooling does not supply those permissions or qualifications.
