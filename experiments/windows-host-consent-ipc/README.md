# Attended Windows peer-bound consent IPC — security falsifier (default OFF)

**Status: test-only, no host integration, no trusted caller, zero grants.** This
experiment does not create a product pipe, approve any remote peer, start tsnet,
expose RFB, install a service, or invoke native input. It is intentionally
incompatible with enabling remote access until the missing trust bootstrap is
proven on a real controlled Windows system.

## Why a same-user named pipe is not authentication of the tsnet edge

The future [tsnet source candidate in PR #80](https://github.com/thebrazenbeard/UnboundVNC/pull/80)
would identify a remote accepted socket with `LocalClient.WhoIs(ctx, remoteAddr)`.
The attended Windows host currently has only an unrelated **loopback** RFB
approval prompt (not remote peer-specific). An unauthenticated pipe carrying a
JSON `PeerNodeID` cannot bridge those trust domains: any process allowed to
connect can type another device's ID, hostname and nonce.

Microsoft documents that `PipeOptions.CurrentUserOnly` on Windows constrains
connections to the same **account and elevation**; it does *not* identify the
specific trusted route executable. `GetNamedPipeClientProcessId` provides a
process identifier, not code integrity, trusted route ownership or proof that
the peer value came from `WhoIs`. PID-only checks have process-lifetime and
same-user tampering hazards. A background service in Session 0 also cannot be
mistaken for the interactive `WinSta0/Default` UI. Do not use `WTSQueryUserToken`
from this unelevated UI; that API requires LocalSystem with `SeTcbPrivilege`.

The hosted probe opens a **random, one-off test-owned pipe** restricted with
`CurrentUserOnly`, launches its own separate child under the same Windows user,
and proves the child can submit a forged, syntactically plausible stable node
ID over that pipe. It reads its client PID and impersonated caller SID, but
logs neither identity nor private data. **It never grants**. This is a genuine
transport-level counterexample to pipe-ACL-only identity, not a test of a
production IPC server. The companion pure lease-retention checks are
*hypothetical models*, not validation of a human approval or trust bootstrap.

## Proposed later trust contract (all requirements, no issued grant today)

1. The attended host UI is launched by the active interactive user. It must
   verify its own Windows logon SID, session ID, `WinSta0/Default` desktop and
   fresh lock/session-switch epoch immediately before displaying approval and
   before any frame. A service or noninteractive desktop must **deny**.
2. The trusted route edge must be launched/owned by the attended host or
   otherwise authenticated through an equivalent protected channel. A possible
   candidate is a host-generated ephemeral per-start capability delivered only
   over a **private inherited OS handle**, never a public file, command-line,
   environment variable, fixed pipe name or localhost bearer header. This is
   not yet implemented and must survive same-user adversarial tests, process
   swap/injection, privilege/elevation changes and restart. A PID, executable
   path or Authenticode signature alone is insufficient.
3. The route must attest the actual socket `WhoIs` result **on that connection**
   and bind the exact opaque `PeerNodeID`, `HostNodeID`, fresh 32-byte random
   URL-base64 `SessionID` and **view-only** scope to the authenticated local
   channel. Caller-supplied headers, process command lines and UI labels are
   not proof. Host identity must match the actual local tsnet node, not merely
   an unverified string supplied by Go. A signed replayable JSON document is
   insufficient without freshness and channel binding.
4. The visible host prompt must name the exact initiator and **scope**, and a
   real local human must choose. No silent default, unattended timeout-accept,
   background session approval or CI synthetic approval may satisfy release.
5. One lease binds peer/host/nonce/scope, interactive user SID + Windows
   session ID, current consent epoch, issuance time and at most five-minute
   expiry. Each Stop, lock, switch, secure desktop, process loss, peer removal,
   disconnect or expiry increments epoch/cancels and closes **active streams**.
   Revalidating only the *next* connection is insufficient. Already-buffered
   bytes may remain in OS/TCP queues and cannot be clawed back.
6. A **separate authenticated handoff** must bind the same grant to the current
   loopback gateway/host instance. PR #80 returns HTTP 503 after fake approval
   precisely because this handoff is missing. The `127.0.0.1` of the gateway
   process is not a remote Windows host. Existing listener and `None` RFB
   boundaries stay unchanged.

## Hosted Windows evidence and nonclaims

Workflow: `.github/workflows/windows-host-consent-ipc-falsifier.yml`,
`dotnet run --project experiments/windows-host-consent-ipc/WindowsHostConsentIpcFalsifier.csproj -c Release`.
It uses an ephemeral standard public Windows runner, no credentials or actual
tailnet, no user device, no UI click, no port and no host executable. The
session ID / `Environment.UserInteractive` readback is diagnostic only, not
Windows 10/11 or secure-desktop qualification. The model tests exact peer,
host, nonce, scope, epoch, expiry, revocation, locked/default desktop and
session replacement; the sole grant issuer returns false for every request.

Primary Windows references:

- [PipeOptions.CurrentUserOnly](https://learn.microsoft.com/en-us/dotnet/api/system.io.pipes.pipeoptions)
- [Named-pipe client process ID](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-getnamedpipeclientprocessid)
- [Named-pipe impersonation](https://learn.microsoft.com/en-us/windows/win32/ipc/impersonating-a-named-pipe-client)
- [Windows interactive stations](https://learn.microsoft.com/en-us/windows/win32/winstation/window-stations)
- [Windows session IDs](https://learn.microsoft.com/en-us/windows/desktop/api/processthreadsapi/nf-processthreadsapi-processidtosessionid)
- [WTSQueryUserToken privilege boundary](https://learn.microsoft.com/en-us/windows/win32/api/wtsapi32/nf-wtsapi32-wtsqueryusertoken)

**Rollback:** remove this entirely isolated experiment and its workflow; no
runtime component consumes it.
