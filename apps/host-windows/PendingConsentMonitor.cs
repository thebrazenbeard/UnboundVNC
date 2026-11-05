using System.Net.Sockets;

namespace UnboundVnc.Host.Windows;

internal static class PendingConsentMonitor
{
    internal static Task<bool> ApproveWhileConnected(
        Socket socket, Func<CancellationToken, Task<bool>> approve, CancellationToken lifetime)
        => DecideWhileConnected(socket, approve, false, lifetime);

    internal static Task<T> DecideWhileConnected<T>(Socket socket,
        Func<CancellationToken, Task<T>> decide, T denied, CancellationToken lifetime)
        => DecideWhileConnected(socket, decide, denied, lifetime,
            static cancellation => Task.Delay(50, cancellation));

    // The injected delay lets the loopback harness hold an exact gap after a clear poll.
    internal static async Task<bool> ApproveWhileConnected(
        Socket socket, Func<CancellationToken, Task<bool>> approve, CancellationToken lifetime,
        Func<CancellationToken, Task> pauseAfterIdlePoll)
        => await DecideWhileConnected(socket, approve, false, lifetime, pauseAfterIdlePoll)
            .ConfigureAwait(false);

    internal static async Task<T> DecideWhileConnected<T>(Socket socket,
        Func<CancellationToken, Task<T>> decide, T denied, CancellationToken lifetime,
        Func<CancellationToken, Task> pauseAfterIdlePoll)
    {
        using var pending = CancellationTokenSource.CreateLinkedTokenSource(lifetime);
        var peerLost = ObserveDisconnectOrEarlyData(socket, pending.Token, pauseAfterIdlePoll);
        try
        {
            var decision = decide(pending.Token);
            if (await Task.WhenAny(decision, peerLost).ConfigureAwait(false) == peerLost)
                pending.Cancel(); // Reject and dismiss the prompt if the peer has gone away.

            T choice = await decision.ConfigureAwait(false);
            pending.Cancel(); // End monitoring before any RFB handshake begins.
            if (EqualityComparer<T>.Default.Equals(choice, denied) ||
                await peerLost.ConfigureAwait(false)) return denied;
            // Recheck after the canceled poll gap. This is a boundary snapshot;
            // subsequent disconnects are handled by the RFB socket operations.
            return HasEarlyDataOrClosed(socket) ? denied : choice;
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
