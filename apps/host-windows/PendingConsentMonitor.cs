namespace UnboundVnc.Host.Windows;

internal static class PendingConsentMonitor
{
    internal static async Task<bool> ApproveWhileConnected(
        Stream stream, Func<CancellationToken, Task<bool>> approve, CancellationToken lifetime)
    {
        using var pending = CancellationTokenSource.CreateLinkedTokenSource(lifetime);
        var peerLost = ObserveDisconnectOrEarlyData(stream, pending.Token);
        try
        {
            var decision = approve(pending.Token);
            if (await Task.WhenAny(decision, peerLost).ConfigureAwait(false) == peerLost)
                pending.Cancel(); // Reject and dismiss the prompt if the peer has gone away.

            bool accepted = await decision.ConfigureAwait(false);
            pending.Cancel(); // End the read before any RFB handshake begins.
            return accepted && !await peerLost.ConfigureAwait(false);
        }
        finally
        {
            pending.Cancel();
            await peerLost.ConfigureAwait(false); // No read may overlap the RFB session.
        }
    }

    private static async Task<bool> ObserveDisconnectOrEarlyData(Stream stream, CancellationToken cancellation)
    {
        var oneByte = new byte[1];
        try
        {
            // The server emits the first RFB protocol bytes only after local approval.
            // Until then a read can detect EOF, or reject unsolicited client bytes.
            _ = await stream.ReadAsync(oneByte, cancellation).ConfigureAwait(false);
            return true;
        }
        catch (OperationCanceledException) when (cancellation.IsCancellationRequested)
        {
            return false;
        }
        catch (Exception ex) when (ex is IOException or ObjectDisposedException or System.Net.Sockets.SocketException)
        {
            return true; // Broken pending connection is never an authorized connection.
        }
    }
}
