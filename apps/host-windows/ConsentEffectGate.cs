namespace UnboundVnc.Host.Windows;

// Serializes native input effects with Stop/session-lock revocation.
// No new effect may begin after Revoke() returns; an in-flight Win32 call
// may complete before the revocation acquires this lock.
internal sealed class ConsentEffectGate
{
    private readonly object sync = new();
    private long epoch;

    internal long Snapshot => Interlocked.Read(ref epoch);

    internal void Revoke()
    {
        Interlocked.Increment(ref epoch); // Immediately invalidate new authorization checks.
        lock (sync) { } // Fence any native call that began before revocation.
    }

    internal bool TryEffect(long expectedEpoch, LocalInputConsent consent,
        CancellationToken token, Func<bool> defaultInputDesktop, Func<bool> effect)
    {
        lock (sync)
        {
            if (consent != LocalInputConsent.AllowControl || token.IsCancellationRequested ||
                Volatile.Read(ref epoch) != expectedEpoch || !defaultInputDesktop()) return false;

            if (!effect())
            {
                Interlocked.Increment(ref epoch); // Native failure permanently revokes this session.
                return false;
            }
            // Desktop changes and timeouts occurring during a native call cannot be
            // undone; detect them before permitting any subsequent input message.
            if (!token.IsCancellationRequested && Volatile.Read(ref epoch) == expectedEpoch && defaultInputDesktop())
                return true;
            Interlocked.Increment(ref epoch);
            return false;
        }
    }
}
