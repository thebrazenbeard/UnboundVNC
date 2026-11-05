# UnboundVNC security boundaries

Status: **design invariants and acceptance tests, not a runtime certification**.

Remote desktop can expose everything visible on a user's screen and exercise
powerful input authority. An RFB wire connection, valid password, network
membership, or successful screenshot is not sufficient authorization.

## Default boundaries

1. **No public VNC endpoint by default.** Prototype bridges and synthetic
   servers bind to loopback only. Raw RFB must not be exposed directly to
   untrusted networks. Remote access over LAN or private overlay requires a
   separately evaluated transport and host policy.
2. **Authenticated transport.** Classic VNC password negotiation does not
   itself encrypt screen contents or input. Off-loopback use requires
   authenticated encryption with explicit server identity verification.
   Reject unauthenticated security selections and downgrade unless a clearly
   isolated loopback-only test knowingly enables them.
3. **Host consent.** Attended access must require visible local approval and
   a working host-local terminate control. Refusal produces no framebuffer
   data or input authority. Consent cannot be inferred from possession of an
   IP address or VPN membership.
4. **Unattended access.** Off by default. Future persistent access must be
   explicitly armed per trusted controller, revocable locally, and separately
   gated from ordinary attended sessions.
5. **Distinct capabilities.** View, control, clipboard, file transfer,
   recording, automation, and process/file access have separate grants.
   A viewer's `viewOnly` flag is presentation behavior, not server-side
   enforcement. No desktop grant silently becomes OS administrator or
   VeraMesh process authority.
6. **Credential custody.** Do not persist VNC passwords, session secrets, or
   private keys in browser localStorage, logs, source, or test fixtures. Saved
   device metadata should contain only nonsecret connection hints.
7. **Network abuse resistance.** Any WebSocket proxy must authenticate
   admission, validate Origin and target allowlists, enforce bounded
   connections, reject arbitrary cross-origin proxying, and clean up both
   sides after disconnect/timeout.
8. **OS privilege boundaries.** Windows input injection and capture must
   operate with minimal privileges. Unsupported lock-screen, secure desktop,
   UAC, multi-user, or session-switch behavior must fail closed; never weaken
   UAC as a workaround.
9. **Recoverable revocation.** Revoking a controller terminates active
   sessions and prevents reconnect. Dropped/replayed input and stale tickets
   cannot regain authorization.
10. **No sensitive telemetry by default.** Screen frames, keystrokes,
    clipboard, credentials, and file contents must not be logged.

## Tests required before claims

| Claim | Required evidence |
| --- | --- |
| Browser viewer works | Real RFB framebuffer and input test against a distinct maintained VNC server |
| RFB interoperability | Version, encoding, security, clipboard and reconnect matrix against at least two independent clients/servers |
| Gateway is private | Loopback binding and negative origin/target/ticket tests |
| Encrypted remote access | Tested handshake and server identity rejection over actual private-network path |
| Windows host works | Two physical Windows machines exercise capture, input, displays, lock/UAC and clean shutdown |
| Unattended access is safe | Denial, expiration, revocation, session theft, replay and recovery tests on real host |

No earlier source unit test or model review substitutes for a later live-system
qualification gate.
