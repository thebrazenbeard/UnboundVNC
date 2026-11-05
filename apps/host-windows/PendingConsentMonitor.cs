using System.Net.Sockets;

namespace UnboundVnc.Host.Windows;

internal static class PendingConsentMonitor
{
    // A silent local peer must not monopolize the host's sole consent slot.
    private static readonly TimeSpan DefaultPendingConsentTimeout = TimeSpan.FromSeconds(30);

    internal static Task<bool> ApproveWhileConnected(
        Socket socket, Func<CancellationToken, Task<bool>> approve, CancellationToken lifetime)
        => ApproveWhileConnected(socket, approve, lifetime, DefaultPendingConsentTimeout,
            static cancellation => Task.Delay(50, cancellation));

    // The timeout overload permits short, deterministic loopback regression tests.
    internal static Task<bool> ApproveWhileConnected(
        Socket socket, Func<CancellationToken, Task<bool>> approve, CancellationToken lifetime,
        TimeSpan pendingConsentTimeout)
        => ApproveWhileConnected(socket, approve, lifetime, pendingConsentTimeout,
            static cancellation => Task.Delay(50, cancellation));

    // The injected delay lets the loopback harness hold an exact gap after a clear poll.
    internal static Task<bool> ApproveWhileConnected(
        Socket socket, Func<CancellationToken, Task<bool>> approve, CancellationToken lifetime,
        Func<CancellationToken, Task> pauseAfterIdlePoll)
        => ApproveWhileConnected(socket, approve, lifetime, DefaultPendingConsentTimeout,
            pauseAfterIdlePoll);

    private static async Task<bool> ApproveWhileConnected(
        Socket socket, Func<CancellationToken, Task<bool>> approve, CancellationToken lifetime,
        TimeSpan pendingConsentTimeout, Func<CancellationToken, Task> pauseAfterIdlePoll)
    {
        if (pendingConsentTimeout <= TimeSpan.Zero)
            throw new ArgumentOutOfRangeException(nameof(pendingConsentTimeout));
        using var pending = CancellationTokenSource.CreateLinkedTokenSource(lifetime);
        pending.CancelAfter(pendingConsentTimeout);
        var peerLost = ObserveDisconnectOrEarlyData(socket, pending.Token, pauseAfterIdlePoll);
        try
        {
            var decision = approve(pending.Token);
            if (await Task.WhenAny(decision, peerLost).ConfigureAwait(false) == peerLost)
                return false; // Disconnect, early bytes or deadline: no approval can survive.

            bool accepted = await decision.ConfigureAwait(false);
            bool pendingCurrent = !pending.IsCancellationRequested;
            pending.Cancel(); // End monitoring before any RFB handshake begins.
            if (!accepted || !pendingCurrent || await peerLost.ConfigureAwait(false)) return false;
            // Recheck after the canceled poll gap. This is a boundary snapshot;
            // subsequent disconnects are handled by the RFB socket operations.
            return !HasEarlyDataOrClosed(socket);
        }
        finally
        {
            pending.Cancel();
            await peerLost.ConfigureAwait(false); // No monitor may overlap the RFB session.
        }
    }

    private static async Task<bool> ObserveDisconnectOrEarlyData(
        Socket socket, CancellationToken cancellation, Func<CancellationToken, Task> pauseAfterIdlePoll)
    {
        try
        {
            // SelectRead signals early data, FIN or connection failure. Never read the
            // socket here: canceling a pending NetworkStream.ReadAsync can disconnect
            // an otherwise valid TCP peer on Windows.
            while (!cancellation.IsCancellationRequested)
            {
                if (HasEarlyDataOrClosed(socket)) return true;
                await pauseAfterIdlePoll(cancellation).ConfigureAwait(false);
            }
            return false;
        }
        catch (OperationCanceledException) when (cancellation.IsCancellationRequested)
        {
            return false;
        }
        catch (Exception ex) when (ex is ObjectDisposedException or SocketException)
        {
            return true; // Broken pending connection is never an authorized connection.
        }
    }

    private static bool HasEarlyDataOrClosed(Socket socket)
    {
        try { return socket.Poll(0, SelectMode.SelectRead); }
        catch (Exception ex) when (ex is ObjectDisposedException or SocketException)
        {
            return true;
        }
    }
}
