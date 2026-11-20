# BT2 source candidate: post-grant RFB test-input epoch fence

Status: SOURCE-ONLY ISOLATED CANDIDATE, NOT PRODUCTION REMOTE CONTROL.
Base: exact UnboundVNC Draft PR98 @286f475bfdfd3a077353b386012e2569755b8fb6.
Branch: bt2/pregrant-lease-falsifier-20261120, isolated worktree separate from Engineer B current dirty branch. No merge or deployment from test success.

## Two source faults addressed

1. Engineer A stale ControlObservation.Now falsifier: cached timestamp before expiry could authorize after real expiry. Candidate checks fresh host UTC and monotonic elapsed duration inside the same lease lock, in addition to existing observation fields.
2. Independently reproduced buffered preapproval KeyEvent: a z sent while VIEW ONLY could be processed after a local AllowControl grant. This is a temporal epoch violation that cannot be fixed by sleeping, flushing buffers, or incrementing an RFB packet sequence.

## Test-owned fence: NOT a general control protocol

Host remains view-only until distinct on-host approval of its temporary synthetic WinForms target. Control client requests a reserved ClientCutText test marker. Host must observe current authorized test lease and only then creates a fresh 32-byte cryptographic nonce. It sends a reserved ServerCutText challenge. The client replies with exact bounded canonical base64url nonce through ClientCutText. Only after exact constant-time match can that RFB session's test-owned KeyEvent/PointerEvent dispatch proceed. Wrong/replayed/foreign/noncanonical tokens and unconfirmed sessions stay denied; Stop revokes the underlying test lease.

Because TCP is ordered, any old z key buffered before challenge/echo is processed while the fence is not Ready. Hosted synthetic CI now inserts z before grant and b after challenge issuance but before reply; only a after reply may be accepted. Ordinary clipboard payloads remain discarded.

Security ceiling: ServerCutText is a temporary test signaling channel, not encrypted peer authentication. Stock noVNC viewers may treat it as clipboard, and production cannot rely on it for private remote control. The endpoint is still local-only. Secure authenticated remote transport, replay-safe per-action nonce, real host principal/Session2 attestation, human control consent, Firefox window/tab/composer qualification, OS input adapter and exactly-once message receipt remain HOLD. No SendInput/OS mouse-keyboard injection is enabled.

## Evidence classes

SOURCE RED then GREEN: stale observation reused after expiry; additional protocol fence pure tests covering view-only denial, pre-echo buffered key denial, fresh nonce, wrong and foreign reply, malformed canonical representation, replay and Stop. .NET Windows Release host and hosted CI fixture compile with zero warnings/errors. Hosted synthetic CI is still required to run and show only post-echo a; compilation does not prove its live result. Ordinary host native-effect denial tests must continue to pass.

Why isolated: Engineer B PR98 advanced concurrently at 286f475 and its shared worktree has uncommitted author files. BT2 did not overwrite that writer, run VSCode startup hooks or modify live host permissions; independent review and owner adoption are required before integration.