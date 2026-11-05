using System.Net.Sockets;

namespace UnboundVnc.Host.Windows;

internal static class PendingConsentMonitor
{
    internal static async Task<bool> ApproveWhileConnected(
        Socket socket, Func<CancellationToken, Task<bool>> approve, CancellationToken lifetime)
    {
        using var pending = CancellationTokenSource.CreateLinkedTokenSource(lifetime);
        var peerLost = ObserveDisconnectOrEarlyData(socket, pending.Token);
        try
        {
            var decision = approve(pending.Token);
            if (await Task.WhenAny(decision, peerLost).ConfigureAwait(false) == peerLost)
                pending.Cancel(); // Reject and dismiss the prompt if the peer has gone away.

            bool accepted = await decision.ConfigureAwait(false);
            pending.Cancel(); // End monitoring before any RFB handshake begins.
            return accepted && !await peerLost.ConfigureAwait(false);
        }
        finally
        {
            pending.Cancel();
            await peerLost.ConfigureAwait(false); // No monitor may overlap the RFB session.
        }
    }

    private static async Task<bool> ObserveDisconnectOrEarlyData(Socket socket, CancellationToken cancellation)
    {
        try
        {
            // SelectRead signals early data, FIN or connection failure. Never read the
            // socket here: canceling a pending NetworkStream.ReadAsync can disconnect
            // an otherwise valid TCP peer on Windows.
            while (!cancellation.IsCancellationRequested)
            {
                if (socket.Poll(0, SelectMode.SelectRead)) return true;
                await Task.Delay(50, cancellation).ConfigureAwait(false);
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
}
