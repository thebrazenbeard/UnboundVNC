using System.Net;
using System.Net.Sockets;
using UnboundVnc.Host.Windows;

await Check("peer closes before consent", async () =>
{
    var pair = await LoopbackPair();
    using var peer = pair.peer;
    using var host = pair.host;
    var canceled = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
    var result = PendingConsentMonitor.ApproveWhileConnected(host.Client,
        token => AwaitApprovalOrCancel(token, canceled), CancellationToken.None);
    peer.Close();
    Require(!await result.WaitAsync(TimeSpan.FromSeconds(5)), "closed peer was approved");
    Require(await canceled.Task.WaitAsync(TimeSpan.FromSeconds(5)), "prompt cancellation was not delivered");
});

await Check("unsolicited pre-approval data", async () =>
{
    var pair = await LoopbackPair();
    using var peer = pair.peer;
    using var host = pair.host;
    var canceled = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
    var result = PendingConsentMonitor.ApproveWhileConnected(host.Client,
        token => AwaitApprovalOrCancel(token, canceled), CancellationToken.None);
    await peer.GetStream().WriteAsync(new byte[] { 0x42 });
    Require(!await result.WaitAsync(TimeSpan.FromSeconds(5)), "pre-approval bytes were accepted");
    Require(await canceled.Task.WaitAsync(TimeSpan.FromSeconds(5)), "prompt cancellation was not delivered");
});

await Check("approval keeps subsequent RFB bytes intact", async () =>
{
    var pair = await LoopbackPair();
    using var peer = pair.peer;
    using var host = pair.host;
    var approval = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
    var result = PendingConsentMonitor.ApproveWhileConnected(host.Client,
        _ => approval.Task, CancellationToken.None);
    approval.SetResult(true);
    Require(await result.WaitAsync(TimeSpan.FromSeconds(5)), "connected peer was rejected");
    var bytes = System.Text.Encoding.ASCII.GetBytes("RFB 003.008\n");
    await peer.GetStream().WriteAsync(bytes);
    var received = new byte[bytes.Length];
    await host.GetStream().ReadExactlyAsync(received).AsTask().WaitAsync(TimeSpan.FromSeconds(5));
    Require(received.SequenceEqual(bytes), "pending monitor consumed handshake bytes");
});

await Check("late pre-approval bytes during poll gap", async () =>
{
    await LateArrivalDuringPollGap(closePeer: false);
});

await Check("late FIN during poll gap", async () =>
{
    await LateArrivalDuringPollGap(closePeer: true);
});

await Check("host revokes pending consent", async () =>
{
    var pair = await LoopbackPair();
    using var peer = pair.peer;
    using var host = pair.host;
    using var lifetime = new CancellationTokenSource();
    var canceled = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
    var result = PendingConsentMonitor.ApproveWhileConnected(host.Client,
        token => AwaitApprovalOrCancel(token, canceled), lifetime.Token);
    lifetime.Cancel();
    Require(!await result.WaitAsync(TimeSpan.FromSeconds(5)), "host revocation was ignored");
    Require(await canceled.Task.WaitAsync(TimeSpan.FromSeconds(5)), "prompt cancellation was not delivered");
});

await Check("silent connected peer cannot hold pending consent indefinitely", async () =>
{
    var pair = await LoopbackPair();
    using var peer = pair.peer;
    using var host = pair.host;
    var canceled = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
    var result = PendingConsentMonitor.ApproveWhileConnected(host.Client,
        token => AwaitApprovalOrCancel(token, canceled), CancellationToken.None,
        TimeSpan.FromMilliseconds(150));
    Require(!await result.WaitAsync(TimeSpan.FromSeconds(5)), "silent peer outlived pending consent deadline");
    Require(await canceled.Task.WaitAsync(TimeSpan.FromSeconds(5)), "timed-out prompt was not canceled");
});

await Check("timeout cannot turn cancellation into a stale positive approval", async () =>
{
    var pair = await LoopbackPair();
    using var peer = pair.peer;
    using var host = pair.host;
    var canceled = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
    // Deliberately adversarial approval delegate: it reports true *after* cancellation.
    var result = PendingConsentMonitor.ApproveWhileConnected(host.Client,
        token =>
        {
            var decision = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            token.Register(() => { canceled.TrySetResult(true); decision.TrySetResult(true); });
            return decision.Task;
        }, CancellationToken.None, TimeSpan.FromMilliseconds(150));
    Require(!await result.WaitAsync(TimeSpan.FromSeconds(5)), "expired pending consent accepted late positive decision");
    Require(await canceled.Task.WaitAsync(TimeSpan.FromSeconds(5)), "timeout cancellation not observed");
});

await Check("new local peer remains admissible after prior pending timeout", async () =>
{
    var listener = new TcpListener(IPAddress.Loopback, 0);
    listener.Start(2);
    try
    {
        using (var firstPeer = new TcpClient())
        {
            await firstPeer.ConnectAsync((IPEndPoint)listener.LocalEndpoint);
            using var firstHost = await listener.AcceptTcpClientAsync();
            var refused = PendingConsentMonitor.ApproveWhileConnected(firstHost.Client,
                token => AwaitApprovalOrCancel(token,
                    new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously)),
                CancellationToken.None, TimeSpan.FromMilliseconds(150));
            Require(!await refused.WaitAsync(TimeSpan.FromSeconds(5)), "first silent peer was not refused");
        }
        using var secondPeer = new TcpClient();
        await secondPeer.ConnectAsync((IPEndPoint)listener.LocalEndpoint);
        using var secondHost = await listener.AcceptTcpClientAsync();
        Require(await PendingConsentMonitor.ApproveWhileConnected(secondHost.Client,
            _ => Task.FromResult(true), CancellationToken.None, TimeSpan.FromSeconds(2))
                .WaitAsync(TimeSpan.FromSeconds(5)), "new healthy peer was refused after timeout");
    }
    finally { listener.Stop(); }
});

Console.WriteLine("PASS: 9 pending-consent checks");

static async Task Check(string name, Func<Task> check)
{
    await check();
    Console.WriteLine($"PASS: {name}");
}

static Task<bool> AwaitApprovalOrCancel(CancellationToken token, TaskCompletionSource<bool> canceled)
{
    token.Register(() => canceled.TrySetResult(true));
    var pendingApproval = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
    token.Register(() => pendingApproval.TrySetResult(false));
    return pendingApproval.Task;
}

static async Task LateArrivalDuringPollGap(bool closePeer)
{
    var pair = await LoopbackPair();
    using var peer = pair.peer;
    using var host = pair.host;
    var afterClearPoll = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
    var approval = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
    var result = PendingConsentMonitor.ApproveWhileConnected(host.Client, _ => approval.Task,
        CancellationToken.None, cancellation =>
        {
            afterClearPoll.TrySetResult(true);
            // This pause cannot resume until approval cancels it: adversarial timing is fixed.
            return Task.Delay(Timeout.InfiniteTimeSpan, cancellation);
        });
    await afterClearPoll.Task.WaitAsync(TimeSpan.FromSeconds(5));
    if (closePeer) peer.Close();
    else await peer.GetStream().WriteAsync(new byte[] { 0x42 });
    // Establish OS readiness before approving; the monitor remains held idle.
    using var readyTimeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
    while (!host.Client.Poll(0, SelectMode.SelectRead))
        await Task.Delay(1, readyTimeout.Token);
    approval.SetResult(true);
    Require(!await result.WaitAsync(TimeSpan.FromSeconds(5)), "late arrival bypassed consent boundary check");
}

static async Task<(TcpClient peer, TcpClient host)> LoopbackPair()
{
    var listener = new TcpListener(IPAddress.Loopback, 0);
    listener.Start(1);
    try
    {
        var peer = new TcpClient();
        try
        {
            await peer.ConnectAsync((IPEndPoint)listener.LocalEndpoint);
            return (peer, await listener.AcceptTcpClientAsync());
        }
        catch
        {
            peer.Dispose();
            throw;
        }
    }
    finally { listener.Stop(); }
}

static void Require(bool condition, string error)
{
    if (!condition) throw new InvalidOperationException(error);
}
