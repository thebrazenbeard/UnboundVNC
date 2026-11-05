using System.Diagnostics;
using System.Globalization;
using System.IO.Pipes;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;

// TEST-ONLY process/anonymous-handle experiment. No Windows host, Go route,
// user consent, RFB, listener or real access grant is constructed here.
if (args.Length > 0)
{
    await RunChild(args);
    return;
}
if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();

// RED counterexample: before DisposeLocalCopyOfClientHandle, an unintended
// subprocess also inherits an anonymous client handle. Pipe secrecy is NOT
// a sufficient origin check when the parent can start another child.
using (var exposed = new AnonymousPipeServerStream(PipeDirection.In, HandleInheritability.Inheritable))
{
    string handle = exposed.GetClientHandleAsString();
    using var unintended = Launch("--unintended-forger", handle);
    exposed.DisposeLocalCopyOfClientHandle();
    using var reader = new StreamReader(exposed, Encoding.UTF8, false, 1024, leaveOpen: true);
    string? forged = await reader.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(10));
    Check("sibling process forged message before handle-local-copy disposal",
        forged == "FORGED_FROM_UNINTENDED_SAME_USER_CHILD");
    await unintended.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
    Check("unsafe sibling experiment completed", unintended.ExitCode == 0);
    Console.WriteLine("PRE_DISPOSAL_SIBLING_HANDLE_LEAK=OBSERVED_UNSAFE");
}

// Candidate bounded ordering: launch only the intended child while handles
// are inheritable, immediately drop parent client copies, THEN launch the
// untrusted same-user sibling with the exact numeric handles disclosed.
using (var fromHonest = new AnonymousPipeServerStream(PipeDirection.In, HandleInheritability.Inheritable))
using (var toHonest = new AnonymousPipeServerStream(PipeDirection.Out, HandleInheritability.Inheritable))
{
    string writeHandle = fromHonest.GetClientHandleAsString();
    string readHandle = toHonest.GetClientHandleAsString();
    using var honest = Launch("--honest", writeHandle, readHandle);
    fromHonest.DisposeLocalCopyOfClientHandle();
    toHonest.DisposeLocalCopyOfClientHandle();

    using var outsider = Launch("--known-handles-no-inheritance", writeHandle, readHandle);
    await outsider.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
    Check("unrelated same-user process knows numbers but lacks both inherited handles",
        outsider.ExitCode == 0);
    Console.WriteLine("POST_DISPOSAL_SAME_USER_OUTSIDER_HANDLES_INVALID=PASS");

    using var from = new StreamReader(fromHonest, Encoding.UTF8, false, 1024, leaveOpen: true);
    using var to = new StreamWriter(toHonest, new UTF8Encoding(false), 1024, leaveOpen: true)
        { AutoFlush = true };
    await to.WriteLineAsync("START_TEST_ONLY_CHANNEL");
    string? hello = await from.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(10));
    Check("honest inherited-handle child authenticated channel possession",
        hello == "HONEST_CHANNEL_HELLO");

    // This receipt has zero product authority and IS NOT human approval.
    var lease = new SyntheticChannelLease();
    Check("synthetic channel lease initially retained", lease.StillCurrent(lease.Epoch));
    await to.WriteLineAsync("CI_CHANNEL_RECEIPT_ONLY_NOT_HOST_APPROVAL");
    string? continuation = await from.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(10));
    Check("honest client requested a second synthetic receipt", continuation == "SECOND_CHANNEL_REQUEST");
    lease.Stop();
    Check("Stop atomically revokes old synthetic channel epoch", !lease.StillCurrent(0));
    toHonest.Dispose();
    fromHonest.Dispose();
    await honest.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
    Check("honest child observes channel EOF after Stop", honest.ExitCode == 0);
    Console.WriteLine("HONEST_INHERITED_CHANNEL_RECEIPT=PASS_TEST_ONLY");
    Console.WriteLine("STOP_REVOKES_PENDING_CHANNEL=PASS");

    using var lateOutsider = Launch("--known-handles-no-inheritance", writeHandle, readHandle);
    await lateOutsider.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
    Check("stopped channel cannot be reused by same-user outsider", lateOutsider.ExitCode == 0);
}

// Forced child termination is a bounded approximation of a process crash.
// It proves pipe EOF/cleanup, not the behavior of a Windows service or tsnet.
using (var crashPipe = new AnonymousPipeServerStream(PipeDirection.In, HandleInheritability.Inheritable))
{
    string childHandle = crashPipe.GetClientHandleAsString();
    using var doomed = Launch("--wait-to-be-killed", childHandle);
    crashPipe.DisposeLocalCopyOfClientHandle();
    using var reader = new StreamReader(crashPipe, Encoding.UTF8, false, 1024, leaveOpen: true);
    string? ready = await reader.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(10));
    Check("test child reached crash simulation", ready == "READY_FOR_FORCED_EXIT");
    doomed.Kill(entireProcessTree: true); // Only the specific test-owned child PID.
    await doomed.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
    string? eof = await reader.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(10));
    Check("forced child termination closes inherited pipe", eof is null);
    Console.WriteLine("KILLED_CHILD_PIPE_EOF=PASS");
}

Console.WriteLine("REAL_WINDOWS_HOST_CONSENT_GRANTS=0");
Console.WriteLine("PASS: isolated inherited-handle capability and adversarial sibling falsifier");

static Process Launch(params string[] arguments)
{
    var start = new ProcessStartInfo("dotnet") { UseShellExecute = false, CreateNoWindow = true };
    start.ArgumentList.Add(Assembly.GetExecutingAssembly().Location);
    foreach (string argument in arguments) start.ArgumentList.Add(argument);
    return Process.Start(start) ?? throw new InvalidOperationException("Failed to launch test-owned child.");
}

static async Task RunChild(string[] args)
{
    switch (args[0])
    {
        case "--unintended-forger" when args.Length == 2:
        {
            using var output = new AnonymousPipeClientStream(PipeDirection.Out, args[1]);
            using var writer = new StreamWriter(output, new UTF8Encoding(false)) { AutoFlush = true };
            await writer.WriteLineAsync("FORGED_FROM_UNINTENDED_SAME_USER_CHILD");
            return;
        }
        case "--known-handles-no-inheritance" when args.Length == 3:
        {
            // A numeric handle string is not a bearer credential: absent OS
            // inheritance, it must not refer to either of the private pipes.
            bool writeValid = NativeHandles.IsLive(args[1]);
            bool readValid = NativeHandles.IsLive(args[2]);
            if (writeValid || readValid) throw new InvalidOperationException(
                "Same-user outsider unexpectedly inherited a private channel handle.");
            return;
        }
        case "--honest" when args.Length == 3:
        {
            if (!NativeHandles.IsLive(args[1]) || !NativeHandles.IsLive(args[2]))
                throw new InvalidOperationException("Intended child did not inherit both private handles.");
            using var output = new AnonymousPipeClientStream(PipeDirection.Out, args[1]);
            using var input = new AnonymousPipeClientStream(PipeDirection.In, args[2]);
            using var reader = new StreamReader(input, Encoding.UTF8);
            using var writer = new StreamWriter(output, new UTF8Encoding(false)) { AutoFlush = true };
            if (await reader.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(10)) != "START_TEST_ONLY_CHANNEL")
                throw new InvalidOperationException("No test-only channel start.");
            await writer.WriteLineAsync("HONEST_CHANNEL_HELLO");
            if (await reader.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(10)) !=
                "CI_CHANNEL_RECEIPT_ONLY_NOT_HOST_APPROVAL")
                throw new InvalidOperationException("Honest child did not receive test channel receipt.");
            await writer.WriteLineAsync("SECOND_CHANNEL_REQUEST");
            if (await reader.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(10)) is not null)
                throw new InvalidOperationException("Stop did not close channel before another receipt.");
            return;
        }
        case "--wait-to-be-killed" when args.Length == 2:
        {
            using var output = new AnonymousPipeClientStream(PipeDirection.Out, args[1]);
            using var writer = new StreamWriter(output, new UTF8Encoding(false)) { AutoFlush = true };
            await writer.WriteLineAsync("READY_FOR_FORCED_EXIT");
            await Task.Delay(Timeout.InfiniteTimeSpan);
            return;
        }
    }
    throw new ArgumentException("Unexpected test child arguments.");
}

static void Check(string reason, bool condition)
{
    if (!condition) throw new InvalidOperationException("FAIL: " + reason);
    Console.WriteLine("PASS: " + reason);
}

internal sealed class SyntheticChannelLease
{
    private long epoch;
    private bool stopped;
    internal long Epoch => Interlocked.Read(ref epoch);
    internal bool StillCurrent(long expected) => !Volatile.Read(ref stopped) && Epoch == expected;
    internal void Stop()
    {
        Interlocked.Increment(ref epoch);
        Volatile.Write(ref stopped, true);
    }
}

internal static class NativeHandles
{
    internal static bool IsLive(string numeric)
    {
        if (!long.TryParse(numeric, NumberStyles.Integer, CultureInfo.InvariantCulture, out long raw))
            return false;
        return GetHandleInformation(new IntPtr(raw), out _);
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetHandleInformation(IntPtr handle, out uint flags);
}
