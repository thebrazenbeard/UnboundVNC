using System.Net;
using System.Net.Sockets;
using UnboundVnc.Host.Windows;

await Check("peer closes before consent", async () =>
{
    var pair = await LoopbackPair();
    using var peer = pair.peer;
    using var host = pair.host;
    var canceled = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
    var result = PendingConsentMonitor.ApproveWhileConnected(host.GetStream(),
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
    var result = PendingConsentMonitor.ApproveWhileConnected(host.GetStream(),
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
    var result = PendingConsentMonitor.ApproveWhileConnected(host.GetStream(),
        _ => approval.Task, CancellationToken.None);
    approval.SetResult(true);
    Require(await result.WaitAsync(TimeSpan.FromSeconds(5)), "connected peer was rejected");
    var bytes = new byte[] { 0x52, 0x46, 0x42 };
    await peer.GetStream().WriteAsync(bytes);
    var received = new byte[bytes.Length];
    await host.GetStream().ReadExactlyAsync(received).AsTask().WaitAsync(TimeSpan.FromSeconds(5));
    Require(received.SequenceEqual(bytes), "pending monitor consumed handshake bytes");
});

await Check("host revokes pending consent", async () =>
{
    var pair = await LoopbackPair();
    using var peer = pair.peer;
    using var host = pair.host;
    using var lifetime = new CancellationTokenSource();
    var canceled = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
    var result = PendingConsentMonitor.ApproveWhileConnected(host.GetStream(),
        token => AwaitApprovalOrCancel(token, canceled), lifetime.Token);
    lifetime.Cancel();
    Require(!await result.WaitAsync(TimeSpan.FromSeconds(5)), "host revocation was ignored");
    Require(await canceled.Task.WaitAsync(TimeSpan.FromSeconds(5)), "prompt cancellation was not delivered");
});

Console.WriteLine("PASS: 4 pending-consent checks");

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
