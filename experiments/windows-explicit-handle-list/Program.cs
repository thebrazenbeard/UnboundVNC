using System.IO.Pipes;
using System.Text;

// Test process only: these subprocesses never speak to UnboundVNC, Go, a
// desktop, a network port or an actual human consent issuer.
if (args.Length != 0)
{
    Environment.ExitCode = RunTestChild(args);
    return;
}
if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();

// CONTROL: restricting the INTENDED child alone does not protect against a
// second child launched with CreateProcess(bInheritHandles=true) while the
// client handle remains inheritable in the parent. Both can write to the
// same anonymous pipe. This intentionally demonstrates an unsafe launch policy.
using (var secret = new AnonymousPipeServerStream(PipeDirection.In, HandleInheritability.Inheritable))
{
    string secretValue = secret.GetClientHandleAsString();
    using var honest = NativeChildLauncher.StartRestricted(
        new[] { NativeChildLauncher.ParseHandle(secretValue) }, "--trusted-all-inherit-control", secretValue);
    using var sibling = NativeChildLauncher.StartInheritAll("--unsafe-sibling", secretValue);
    secret.DisposeLocalCopyOfClientHandle();
    using var reader = new StreamReader(secret, Encoding.UTF8, false, 1024, leaveOpen: true);
    var lines = new[]
    {
        await ReadBounded(reader),
        await ReadBounded(reader)
    }.OrderBy(x => x, StringComparer.Ordinal).ToArray();
    Require(lines.SequenceEqual(new[] { "FORGED_FROM_UNRESTRICTED_SIBLING", "TRUSTED_FROM_RESTRICTED_CHILD" }),
        "unrestricted sibling was not observed inheriting intended child's pipe");
    Require(honest.WaitExit() == 0 && sibling.WaitExit() == 0, "unsafe control child exit");
    Console.WriteLine("STARTUPINFOEX_ALONE_DOES_NOT_PROTECT_BROAD_SIBLING=OBSERVED_UNSAFE");
}

// CONTROLLED POLICY: both overlapping test-child launches use explicit
// STARTUPINFOEX handle lists. The intended child gets only the secret pipe;
// the sibling gets only a dummy pipe. Both client handles remain inheritable
// until both launches finish, so this actually exercises the per-child filter.
using (var secret = new AnonymousPipeServerStream(PipeDirection.In, HandleInheritability.Inheritable))
using (var dummy = new AnonymousPipeServerStream(PipeDirection.In, HandleInheritability.Inheritable))
{
    string secretValue = secret.GetClientHandleAsString();
    string dummyValue = dummy.GetClientHandleAsString();
    var secretHandle = NativeChildLauncher.ParseHandle(secretValue);
    var dummyHandle = NativeChildLauncher.ParseHandle(dummyValue);
    using var honest = NativeChildLauncher.StartRestricted(
        new[] { secretHandle }, "--restricted-honest", secretValue, dummyValue);
    using var sibling = NativeChildLauncher.StartRestricted(
        new[] { dummyHandle }, "--restricted-sibling", secretValue, dummyValue);
    secret.DisposeLocalCopyOfClientHandle();
    dummy.DisposeLocalCopyOfClientHandle();
    using var honestReader = new StreamReader(secret, Encoding.UTF8, false, 1024, leaveOpen: true);
    using var siblingReader = new StreamReader(dummy, Encoding.UTF8, false, 1024, leaveOpen: true);
    Require(await ReadBounded(honestReader) == "TRUSTED_HANDLE_LIST_ONLY_SECRET",
        "intended child did not use sole allowed secret handle");
    Require(await ReadBounded(siblingReader) == "UNRELATED_HANDLE_LIST_ONLY_DUMMY",
        "sibling did not use sole allowed dummy handle");
    Require(honest.WaitExit() == 0 && sibling.WaitExit() == 0, "restricted children exit");
    Console.WriteLine("EXPLICIT_HANDLE_LIST_TRUSTED_CHILD_SECRET_ONLY=PASS");
    Console.WriteLine("EXPLICIT_HANDLE_LIST_UNRELATED_SIBLING_NO_SECRET=PASS");
}

Console.WriteLine("REAL_WINDOWS_HOST_CONSENT_GRANTS=0");
Console.WriteLine("PASS: hosted Windows STARTUPINFOEX handle-list falsifier (test-only)");

static async Task<string> ReadBounded(StreamReader reader)
    => await reader.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(10))
       ?? throw new InvalidOperationException("Unexpected pipe EOF before adversarial marker.");

static int RunTestChild(string[] args)
{
    if (args.Length < 2) return 11;
    switch (args[0])
    {
        case "--trusted-all-inherit-control" when args.Length == 2:
            if (!NativeChildLauncher.IsLive(args[1])) return 12;
            Send(args[1], "TRUSTED_FROM_RESTRICTED_CHILD");
            return 0;
        case "--unsafe-sibling" when args.Length == 2:
            if (!NativeChildLauncher.IsLive(args[1])) return 13;
            Send(args[1], "FORGED_FROM_UNRESTRICTED_SIBLING");
            return 0;
        case "--restricted-honest" when args.Length == 3:
            if (!NativeChildLauncher.IsLive(args[1]) || NativeChildLauncher.IsLive(args[2])) return 14;
            Send(args[1], "TRUSTED_HANDLE_LIST_ONLY_SECRET");
            return 0;
        case "--restricted-sibling" when args.Length == 3:
            if (NativeChildLauncher.IsLive(args[1]) || !NativeChildLauncher.IsLive(args[2])) return 15;
            Send(args[2], "UNRELATED_HANDLE_LIST_ONLY_DUMMY");
            return 0;
        default:
            return 16;
    }
}

static void Send(string numericHandle, string marker)
{
    using var pipe = new AnonymousPipeClientStream(PipeDirection.Out, numericHandle);
    using var writer = new StreamWriter(pipe, new UTF8Encoding(false)) { AutoFlush = true };
    writer.WriteLine(marker);
}

static void Require(bool condition, string failure)
{
    if (!condition) throw new InvalidOperationException("FAIL: " + failure);
    Console.WriteLine("PASS: " + failure.Replace("not ", ""));
}
