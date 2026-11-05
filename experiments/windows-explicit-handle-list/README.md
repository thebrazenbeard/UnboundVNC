# STARTUPINFOEX handle-list inheritance — Windows test-only falsifier

**Default OFF / source and hosted CI only.** No production Windows host,
tsnet Go route, gateway, visible consent UI, RFB, service, public listener,
credential, install or input effect consumes this code. The test-owned child
processes send synthetic fixed markers over local anonymous pipes only.

The exact distinction under test is **per-child inheritance**, not full
same-user process attestation. Microsoft's `CreateProcessW` documentation
explicitly warns that setting `bInheritHandles=TRUE` makes *all inheritable*
handles available to the child, which is dangerous during overlapping launches.
`STARTUPINFOEX` plus `UpdateProcThreadAttribute` with
`PROC_THREAD_ATTRIBUTE_HANDLE_LIST` specifies exactly which inherited handles
are passed to that **particular** process; the handles still need to be marked
inheritable and `bInheritHandles=TRUE` remains required.

## Adversarial hosted Windows cases

1. **Red/unsafe policy:** Parent creates one inheritable secret anonymous pipe.
   It starts the *intended* child with `STARTUPINFOEX` restricted to that pipe,
   then an **unrestricted sibling** via `CreateProcessW` with broad inheritance,
   while the parent client handle is still open. Both children send a message
   to the same pipe. Expected `...SIBLING=OBSERVED_UNSAFE`. This proves a
   restricted intended launch cannot by itself defend against a *different*
   concurrent, unsafe launcher in the same parent process.
2. **Green/qualified narrow policy:** Parent creates a secret and a dummy pipe,
   both inheritable. It launches overlapping children with *separate explicit
   handle lists*: intended child gets only secret; sibling gets only dummy.
   Each child checks both numeric handle values with `GetHandleInformation`,
   refuses an unexpected handle, and writes only to its intended pipe. Parent
   checks both independent markers. This demonstrates kernel filtering under
   these exact launch conditions, not resistance to arbitrary same-user code.

The test wrapper uses the real `InitializeProcThreadAttributeList` two-call
allocation protocol, `UpdateProcThreadAttribute(0x00020002)`, Unicode
`CreateProcessW` with `EXTENDED_STARTUPINFO_PRESENT`, and closes all attribute,
thread and process handles. On failure it can terminate **only a child it
created**, using that exact process handle. No system settings change.

## Activation remains NO-GO

- A sibling launched with `bInheritHandles=TRUE` **without** its own restricted
  list can still inherit the secret while that parent handle remains
  inheritable. Other launchers/threads must be serialized or required to use
  the same process-wide safe inheritance policy. This experiment explicitly
  demonstrates the unsafe counterexample; it doesn't close that window.
- A malicious same-user process with `PROCESS_DUP_HANDLE`, debugger/injection,
  or an already-compromised honest child may acquire the actual kernel handle.
  Passing only the numeric handle value without inheritance does not grant
  access, but a process holding the actual duplicated handle is different.
  Code signing, PID, path, SID, a secret pipe name or token echo alone is not
  sufficient proof of the running code's trustworthiness.
- Before real peer grants, the attended host must own and verify the Go tsnet
  edge process, bind `WhoIs(acceptedSocket.RemoteAddr)` and local host identity
  to a fresh random session nonce/view-only scope, require visible approval
  from the active Windows user on `WinSta0/Default`, and revoke immediately on
  Stop/lock/UAC/session switch/expiry/disconnect with active RFB teardown.
  There is **no** such IPC bridge or authenticated gateway handoff here.
- No actual human approval is simulated; the test uses only static process
  markers. No real Windows workstation or tailnet device is accessed.

## Run and rollback

`dotnet run --project experiments/windows-explicit-handle-list/WindowsExplicitHandleListFalsifier.csproj --configuration Release`

GitHub workflow `.github/workflows/windows-explicit-handle-list.yml` uses a
standard ephemeral Windows hosted runner and `contents: read`; no secrets.
No runtime consumer exists, so rollback removes only this experiment and
workflow. Real Windows 10/11 human-attended parity remains **UNKNOWN**.

Primary Microsoft sources:

- [CreateProcessW](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessw)
- [InitializeProcThreadAttributeList](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-initializeprocthreadattributelist)
- [UpdateProcThreadAttribute](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)
- [Process handle inheritance](https://learn.microsoft.com/en-us/windows/win32/procthread/inheritance)
- [Windows process rights including PROCESS_DUP_HANDLE](https://learn.microsoft.com/en-us/windows/win32/procthread/process-security-and-access-rights)
