# Host-owned anonymous-handle IPC — test-only capability experiment

**Default OFF.** This experiment is not an UnboundVNC host implementation. It
has no app caller, RFB, service, network listener, tailnet login, user prompt,
real consent grant, input adapter or installed component. It uses only ephemeral
Windows Actions **test-owned** child processes and anonymous local pipes.

It tests one narrower proposition than the [named-pipe falsifier in PR #82](https://github.com/thebrazenbeard/UnboundVNC/pull/82):

> Possession of an OS handle inherited during a *host-owned child launch* is a
> stronger local channel credential than an advertised pipe name plus matching
> user SID/PID. A numeric handle **value** by itself is not a bearer token.

But this is not proof of process integrity, human permission, or remote
Tailscale `WhoIs` identity. A same-user attacker with process-handle duplication
or code-injection rights, a compromised child, or a concurrent process launch
may invalidate the model. Those remain **security blockers**.

## Hosted adversarial tests

1. **Deliberately unsafe sibling inheritance:** The parent creates one
   inheritable anonymous pipe and starts an unrelated same-user child while
   the client handle still exists in the parent. The child transmits
   `FORGED_FROM_UNINTENDED_SAME_USER_CHILD`; the parent observes it. This
   positive attack baseline must pass: inheritable handles are not automatically
   restricted to the *intended* child. Do not call this red a product exploit.
2. **Bounded local-copy disposal:** The parent creates a separate bidirectional
   channel, starts one intended child, immediately calls
   `DisposeLocalCopyOfClientHandle()` on both pipes, **then** launches another
   same-user child that knows *both numeric handle values*. The outsider checks
   its own handle table with read-only `GetHandleInformation` and must find
   neither valid. The intended child must have both handles and exchange one
   **synthetic CI-only channel receipt**, which grants zero desktop access.
   The outsider is launched only after local-copy disposal; this does **not**
   prove safety under concurrent process creation before disposal.
3. **Stop:** The intended child requests a second receipt. Parent increments a
   test epoch, marks Stop, closes both private channels. The child must see EOF
   before any further receipt; a new same-user outsider cannot reuse the stale
   numeric values. An already-written receipt is not retroactively revocable.
4. **Forced child termination:** A test-owned child writes a ready marker then
   is terminated by its parent (specific PID only). The server must observe
   EOF within a bound. This is a simulated crash, not a product service test.

There is **no real grant issuer**. `CI_CHANNEL_RECEIPT_ONLY_NOT_HOST_APPROVAL`
is deliberately non-authorizing test data. The isolated test process cannot
connect to the actual RFB host or tsnet gateway.

## Missing gates before any real use

- **Handle inheritance confinement:** `AnonymousPipeServerStream` plus
  `DisposeLocalCopyOfClientHandle` is insufficient for concurrent launches.
  Windows recommends `STARTUPINFOEX` with
  `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` to constrain inherited handles.
  Implement and adversarially qualify it if later using a native launcher.
- **Same-user attacker model:** Windows `PROCESS_DUP_HANDLE`, process
  injection/debug rights, inherited handle leaks and child compromise require
  rigorous process token/DACL/integrity and executable provenance review.
  Neither PID, path, Authenticode signature, pipe name nor a token echo alone
  proves code integrity. A hostile process that acquires the *actual* OS
  handle can still impersonate the child; test isolation does not rule that out.
- **Trusted remote assertion:** The launched Go edge would still need to prove
  `WhoIs(ctx,acceptedSocket.RemoteAddr)` from its own tsnet node to the exact
  opaque `PeerNodeID`/`HostNodeID`/fresh 256-bit session nonce/view-only scope,
  with replay protection. This experiment does not run Go, tsnet or any route.
- **Human and Windows authority:** The attended host UI must be visibly used
  by the active interactive Windows user, bind the user's SID/logon session,
  check `WinSta0/Default` and lock/UAC, and issue no grant without a real local
  choice. An OS handle does not replace consent. Stop/session switch/expiry
  must also close active RFB streams, not just discard future tickets.
- **Authenticated gateway handoff:** #80 continues to deny requests with HTTP
  503 because no trusted host-to-gateway bridge exists. Nothing here alters it.

## Run / rollback

On standard ephemeral Windows Actions:

`dotnet run --project experiments/windows-inherited-ipc/WindowsInheritedIpcFalsifier.csproj --configuration Release`

The [Windows workflow](../../.github/workflows/windows-inherited-ipc-falsifier.yml)
has `contents: read`, uses only .NET 8, no user devices, secrets or services,
and terminates only children it created. Session/UI parity with Patrick's
Windows machines is **UNKNOWN**. Remove this entire experiment and workflow to
roll back; no production binary references it.

Primary references:

- [Microsoft anonymous-pipe parent/child example](https://learn.microsoft.com/en-us/dotnet/standard/io/how-to-use-anonymous-pipes-for-local-interprocess-communication)
- [Microsoft handle inheritance guidance](https://learn.microsoft.com/en-us/windows/win32/procthread/inheritance)
- [CreateProcess handle-list guidance](https://learn.microsoft.com/en-us/windows/win32/procthread/creating-processes)
- [Windows process duplication security](https://learn.microsoft.com/en-us/windows/win32/procthread/process-security-and-access-rights)
