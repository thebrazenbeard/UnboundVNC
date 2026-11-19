# Engineer B — attended input gate, test-window candidate V1

Status: source-only policy+dispatch candidate stacked on already-green local view-only UnboundVNC Draft PR #97 at 489f8dd32b9f1ed062a3865f2944e851474b40be. NOT enabled in the host RFB session; NO native input effects. PR #97's real changing test-owned framebuffer and Reject/Stop test witnesses are separate evidence. This gate makes no claim to have controlled Firefox or delivered a ChatGPT message.

## Input authorization design

The RFB host still discards KeyEvent (type 4) and PointerEvent (type 5). The independently approved control grant and actual effect route do not yet exist. The newly source-linked AttendedControlLease / RfbInputDispatch modules provide a test-only fail-closed admission component for a future on-host controller. Source code must not be interpreted as an installed or active runtime.

AttendedControlLease has NO DEFAULT CONTROL. ViewOnly cannot grant; only an explicit AllowControl transition for a bounded SYNTHETIC_TEST_OWNED_WINDOW target (HWND, process ID, exact rectangle), new session epoch and at most 5-minute expiry may grant one test lease. A Firefox window is intentionally refused. A real authenticated owner-selected Firefox window must have a separate, independently reviewed consent+target registration design rather than changing the synthetic discriminator.

Each proposed event is checked against trusted ON-HOST observed session epoch, current default desktop, session validity, foreground root window+owner PID, unchanged bounds, expiry, monotonic sequence, syntactically parsed bounded RFB payload and target rectangle. A pointer can use left button only; keys limited to printable ASCII. Enter, Tab, Escape, Backspace and shortcuts remain denied: neither generic control grant nor synthetic key sequences authorize sending a message, discarding a draft or switching target. Clipboard not forwarded.

Source-only dispatcher callbacks must be synchronous, bounded, non-UI-blocking and exception-safe. The lease holds a lock across BOTH decision and callback delivery, so Stop/revoke cannot acknowledge completion while an admitted effect callback is still executing. This was a directly observed RED failure before the atomic change; positive, wrong-window, replay, lock, stale, expired and post-revoke tests are GREEN. The TryConsume methods without callbacks are ONLY policy probes, not evidence of an actual input effect.

Important model limits: these tests take host-observation values from synthetic fixtures; production MUST create those values from trusted Win32 foreground/HWND/PID/rect/desktop calls, not RFB-originated data or client claims. Gate does not prove selected chat identity, tab, composer, draft or active generation. A host-minted sequence counts packets but does not defeat malicious repeated browser input: real exactly-once submission needs an authenticated replay-resistant per-action nonce/idempotency protocol above stock RFB. An OS input queue can outlive synchronous delivery; qualify revocation semantics against a real test-owned form before any real target is permitted. Synthetic tests cannot prove human consent.

## Mandatory follow-on (HOLD)

1. Engineer B: qualify a DISTINCT visible human on-host CONTROL approval for a single bound target, separate from view-only approval; one temporary test-owned form, real RFB key/pointer through reviewed Win32 effect adapter, independently verified effect/no-effect/revoke. View-only stays default; do not disable existing effect-safety tests to make code pass. No UIAutomation one-shot substitute.
2. Engineer A: review OS Session2 owner/process/window identity, secure peer route and any privilege/UIAccess boundaries; pin actual controller. RFB None on TCP5901 may never be exposed beyond loopback.
3. BT2: independently challenge inherited session proof, wrong process/window, stale bounds/desktop lock, concurrent Stop during delivery, wrong chat tab and replay at this exact new source head.
4. After a real human-approved test-owned input effect: qualify one explicitly approved Vera-attributed benign message targeting the exact intended chat's bottom composer, active-draft/generation refusals, independently observed recipient and exactly-once idempotent delivery. Keep private conversation content, pixels, credentials and excerpts off GitHub/Bus.

No merge, service installation, startup task, authentication bypass, private screenshot, login, message send, native input or canonical data mutation has been performed by this source-only branch.