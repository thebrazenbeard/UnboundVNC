namespace UnboundVnc.Host.Windows;

/// <summary>
/// Parses a constrained RFB KeyEvent/PointerEvent and calls a DI callback
/// ONLY if an on-host session/window/epoch lease admits this exact sequence.
/// No native effect imports are present; callbacks are test-only until a
/// separately reviewed Windows target-bound injector is approved.
/// </summary>
internal static class RfbInputDispatch
{
    internal static bool TryKey(
        AttendedControlLease lease, ReadOnlySpan<byte> rfbPayload,
        ControlObservation trustedHostObservation, long eventSequence,
        Func<NormalizedKey, bool> effect)
    {
        ArgumentNullException.ThrowIfNull(lease);
        ArgumentNullException.ThrowIfNull(effect);
        if (!ExperimentalInputPolicy.TryParseKey(rfbPayload, out var key))
            return false;
        return lease.TryDeliverKey(key, trustedHostObservation, eventSequence, effect);
    }

    internal static bool TryPointer(
        AttendedControlLease lease, ReadOnlySpan<byte> rfbPayload,
        int width, int height, int desktopLeft, int desktopTop,
        ControlObservation trustedHostObservation, long eventSequence,
        Func<NormalizedPointer, bool> effect)
    {
        ArgumentNullException.ThrowIfNull(lease);
        ArgumentNullException.ThrowIfNull(effect);
        if (!ExperimentalInputPolicy.TryParsePointer(
                rfbPayload, width, height, desktopLeft, desktopTop, out var pointer))
            return false;
        return lease.TryDeliverPointer(pointer, trustedHostObservation, eventSequence, effect);
    }
}