# UnboundVNC attended screen-share vertical slice

Status: DRAFT / LOCAL WINDOWS SCREEN SHARE PREVIEW. Based on composite Draft PR #22 at 058c14172383143d4ee140a7591a3c180938cda2. No modification of existing viewer, host, gateway, native input or tailnet code.

## Interactive Windows use

From a checked-out copy in the user's logged-in desktop, run:

    & .\scripts\Start-LocalScreenShare.ps1

This installs lockfile-selected viewer packages without dependency lifecycle scripts, builds the viewer and .NET 8 host, composes a loopback browser viewer and RFB gateway, and launches the WinForms attended host. The default browser opens the local viewer. Use -NoBrowser to avoid opening the browser.

The Windows host starts with sharing OFF. A local human must press Start local preview, then Approve or Reject every view-only connection. Stop and revoke closes the host's listener. The gateway accepts only the attended-host port 5901 and connects to 127.0.0.1; other RFB ports and all remote targets are refused.

## Remote execution from noninteractive Session 0

Executor and similar remote terminal tools may start WinForms invisibly in Session 0. On an authorized user workstation run:

    & .\scripts\Start-InteractiveFromExecutor.ps1

This requires exactly one current-account Explorer desktop. It checks for a running UnboundVNC host and an occupied RFB 5901 listener, then registers a temporary, least-privilege Interactive Task Scheduler action to launch the local preview on the actual logged-in desktop session. It verifies an ephemeral loopback URL and that the gateway reports remoteAccess=false, unregisters the task, and deletes the temporary receipt. It does not persist an autostart task, start an unattended service, change firewall/Tailscale, or bypass on-host human approval.

## Verified 2026-11-19 local results

- Local Windows source candidate: 10/10 focused launcher tests pass. Gateway 47/47, browser viewer 26/26, desktop HTTP wrapper 7/7. Windows host Release build zero warnings/errors; PowerShell parsers zero errors.
- Executor Session 0 direct-host startup: real process launched but MainWindowHandle zero. This was not a working attended GUI and its owned test process was stopped.
- Temporary interactive task: source-matched GUI host launched in logged-in Session 2, and a separate Session 2 inspection observed a nonzero host window handle and intended title. Temporary task registration removed; task-lifetime behavior independently tested.
- Assembled local host/browser run: Windows host in Session 2; browser viewer bound only to loopback and served compiled HTML (HTTP 200), gateway health ok=true and remoteAccess=false; a foreign RFB target returned HTTP 400. No TCP 5901 listener while sharing OFF. No screen pixels/private content were read.
- Separate Linux peer reached Lappy SSH TCP 22; its scanned ED25519 host fingerprint matched the authoritative host public key. Existing noninteractive SSH authentication was denied. No authorized_keys, SSH keys, known_hosts persistence, credentials, remote exposure or Tailscale configuration were changed.

## What this does not claim

This fixes a usable LOCAL composition and a real attended-host GUI launch from Session 0. It is not yet a qualified remote share or remote controller. No physical RFB screen-pixel stream was observed: a human-approved session and independent frame oracle are still needed. Native keyboard/pointer control remains disabled. The Windows host uses RFB SecurityType None strictly inside local loopback: never expose its raw RFB endpoint on LAN, tailnet or public Internet. Peer-authenticated encrypted remote delivery, host peer-specific consent, tested revocation, device discovery, and release packaging remain separate.

## Engineer A continuation

1. Independently review the interactive-task lifecycle, session matching, unexpected host exit, and real Window UI, then prove local human-approved changing desktop pixels and Stop/revoke via an actual browser viewer.
2. Add an encrypted and authenticated peer route without making the existing loopback gateway accept arbitrary Host, Origin, or remote targets. Any SSH tunnel requires preexisting approved authentication and verified host keys; this test did not grant such access.
3. Integrate separately reviewed strict RFB banner and pending-consent security fixes before release; preserve ownership of existing branches.
4. Keep this candidate Draft until real consumer-machine screen sharing and negative security tests are independently verified.

No merge, public listener, credential enrollment, or installed consumer runtime was performed by this draft.