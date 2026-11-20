using System.Drawing;

namespace UnboundVnc.Host.Windows;

/// <summary>
/// A bounded, test-owned-window control gate. This is a gate, not an injector.
/// Actual user chat windows must NOT use the synthetic test window scope.
/// </summary>
internal readonly record struct ControlTarget(
    nint WindowHandle, int ProcessId, Rectangle Bounds, string Kind);

internal readonly record struct ControlObservation
{
    internal long SessionEpoch { get; init; }
    internal nint ForegroundRoot { get; init; }
    internal int ForegroundOwnerPid { get; init; }
    internal Rectangle TargetBounds { get; init; }
    internal bool DefaultDesktop { get; init; }
    internal bool SessionCurrent { get; init; }
    internal DateTimeOffset Now { get; init; }

    internal ControlObservation(
        long sessionEpoch, nint foregroundRoot, int foregroundOwnerPid,
        Rectangle targetBounds, bool defaultDesktop, bool sessionCurrent,
        DateTimeOffset now)
    {
        SessionEpoch = sessionEpoch;
        ForegroundRoot = foregroundRoot;
        ForegroundOwnerPid = foregroundOwnerPid;
        TargetBounds = targetBounds;
        DefaultDesktop = defaultDesktop;
        SessionCurrent = sessionCurrent;
        Now = now;
    }
}

/// <summary>
/// An on-host, one-session, one-target scope that rejects input after Stop,
/// desktop lock, target movement, wrong focus, expiration and event replay.
/// Exactly one new approval per epoch is possible; silence never grants.
/// </summary>
internal sealed class AttendedControlLease
{
    private readonly object sync = new();
    private ControlTarget? allowedTarget;
    private long allowedEpoch;
    private long lastGrantedEpoch = long.MinValue;
    private long lastSequence;
    private DateTimeOffset expiresAt;

    internal bool Grant(
        LocalInputConsent consent, ControlTarget target,
        long sessionEpoch, DateTimeOffset expires)
    {
        lock (sync)
        {
            // No general Firefox or desktop capability is authorized by this
            // synthetic test-only phase. A distinct attended UI and independent
            // real-window qualification are required to expand target policy.
            if (consent != LocalInputConsent.AllowControl ||
                target.Kind != "SYNTHETIC_TEST_OWNED_WINDOW" ||
                target.WindowHandle == 0 || target.ProcessId < 1 ||
                target.Bounds.Width is < 1 or > 1280 ||
                target.Bounds.Height is < 1 or > 720 ||
                sessionEpoch <= lastGrantedEpoch ||
                expires <= DateTimeOffset.UtcNow ||
                expires > DateTimeOffset.UtcNow.AddMinutes(5))
                return false;
            allowedTarget = target;
            allowedEpoch = lastGrantedEpoch = sessionEpoch;
            expiresAt = expires;
            lastSequence = 0;
            return true;
        }
    }

    internal bool TryConsumeKey(NormalizedKey key, ControlObservation observed, long sequence)
    {
        lock (sync)
        {
            // No Enter/Tab/Escape/Backspace: a mere control grant cannot submit,
            // navigate across windows, or delete existing user drafts.
            if (key.Kind != LocalKeyKind.Printable ||
                key.Character is < (char)0x20 or > (char)0x7e)
                return false;
            return TryAdmit(observed, sequence);
        }
    }

    internal bool TryConsumePointer(NormalizedPointer pointer, ControlObservation observed, long sequence)
    {
        lock (sync)
        {
            if (allowedTarget is not ControlTarget target ||
                (pointer.Buttons & ~1) != 0 ||
                !target.Bounds.Contains(pointer.ScreenX, pointer.ScreenY))
                return false;
            return TryAdmit(observed, sequence);
        }
    }

    // Used by the host-owned GUI consumer BEFORE applying queued test-only
    // events; revocation is checked again on the actual UI thread.
    internal bool IsCurrent(ControlObservation observed)
    {
        lock (sync)
        {
            return allowedTarget is ControlTarget target &&
                observed.DefaultDesktop && observed.SessionCurrent &&
                observed.SessionEpoch == allowedEpoch &&
                observed.ForegroundRoot == target.WindowHandle &&
                observed.ForegroundOwnerPid == target.ProcessId &&
                observed.TargetBounds == target.Bounds &&
                observed.Now < expiresAt;
        }
    }
    // Re-check AND apply a queued test-only UI effect under the same lock used
    // by Stop/Revoke. No UI update may happen after revocation returns, even
    // when the foreground HWND changes between queue and timer callbacks.
    internal bool TryApplyWhileCurrent(ControlObservation observed, Action apply)
    {
        ArgumentNullException.ThrowIfNull(apply);
        lock (sync)
        {
            if (!IsCurrent(observed)) return false;
            apply(); // MUST be bounded, nonblocking and local test-form only.
            return true;
        }
    }
    private bool TryAdmit(ControlObservation observed, long sequence)
    {
        if (allowedTarget is not ControlTarget target ||
            !observed.DefaultDesktop || !observed.SessionCurrent ||
            observed.SessionEpoch != allowedEpoch ||
            observed.ForegroundRoot != target.WindowHandle ||
            observed.ForegroundOwnerPid != target.ProcessId ||
            observed.TargetBounds != target.Bounds ||
            observed.Now >= expiresAt ||
            sequence <= lastSequence || sequence < 1)
            return false;
        lastSequence = sequence;
        return true;
    }

    // The effect callback is synchronous, bounded and must never UI-Invoke.
    // Revoke takes the SAME lock, so no native effect can begin after Stop
    // acknowledges revocation, including between admission and delivery.
    internal bool TryDeliverKey(
        NormalizedKey key, ControlObservation observed, long sequence,
        Func<NormalizedKey, bool> effect)
    {
        ArgumentNullException.ThrowIfNull(effect);
        lock (sync)
        {
            if (key.Kind != LocalKeyKind.Printable ||
                key.Character is < (char)0x20 or > (char)0x7e ||
                !TryAdmit(observed, sequence)) return false;
            return effect(key);
        }
    }

    internal bool TryDeliverPointer(
        NormalizedPointer pointer, ControlObservation observed, long sequence,
        Func<NormalizedPointer, bool> effect)
    {
        ArgumentNullException.ThrowIfNull(effect);
        lock (sync)
        {
            if (allowedTarget is not ControlTarget target ||
                (pointer.Buttons & ~1) != 0 ||
                !target.Bounds.Contains(pointer.ScreenX, pointer.ScreenY) ||
                !TryAdmit(observed, sequence)) return false;
            return effect(pointer);
        }
    }
    internal void Revoke()
    {
        lock (sync)
        {
            allowedTarget = null;
            // Prevent silent re-arm on the prior approved session epoch.
            lastGrantedEpoch = Math.Max(lastGrantedEpoch, allowedEpoch);
            lastSequence = 0;
        }
    }
}