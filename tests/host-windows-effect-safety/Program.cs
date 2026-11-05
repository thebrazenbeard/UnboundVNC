using System.Reflection;
using System.Runtime.InteropServices;
using UnboundVnc.Host.Windows;

if (args.Length != 1 || !File.Exists(args[0]))
    throw new ArgumentException("Pass the built Windows host managed DLL for policy inspection.");
var hostDll = Path.GetFullPath(args[0]);
if (!Path.GetFileName(hostDll).Equals("UnboundVnc.Host.Windows.dll", StringComparison.OrdinalIgnoreCase) ||
    !File.Exists(Path.ChangeExtension(hostDll, ".exe")))
    throw new ArgumentException("Expected the host managed DLL beside its built native EXE apphost.");

Check("actual host assembly has no new user32 input-effect import", () =>
{
    var host = Assembly.LoadFrom(hostDll);
    Require(host.GetName().Name == "UnboundVnc.Host.Windows", "inspecting an unexpected managed assembly");
    AssertAllowedNativeImports(host.GetTypes().SelectMany(type => type.GetMethods(
        BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static |
        BindingFlags.Instance | BindingFlags.DeclaredOnly)));
    Require(!NativeInputAdapter.Enabled, "source adapter unexpectedly enabled");
    Require(!NativeInputAdapter.TryInject(new NormalizedKey(true, LocalKeyKind.Printable, 'x'),
        LocalInputConsent.AllowControl, true, true), "source key adapter injected");
    Require(!NativeInputAdapter.TryInject(new NormalizedPointer(20, 30, 1),
        LocalInputConsent.AllowControl, true, true), "source pointer adapter injected");
});

Check("host native import guard rejects test-only forbidden imports", () =>
{
    var fixture = typeof(NativeImportGuardMutationFixture);
    const BindingFlags flags = BindingFlags.NonPublic | BindingFlags.Static;
    foreach (var name in new[]
             {
                 nameof(NativeImportGuardMutationFixture.SendInputAlias),
                 nameof(NativeImportGuardMutationFixture.SetCursorPosAlias),
                 nameof(NativeImportGuardMutationFixture.UnexpectedUser32),
                 nameof(NativeImportGuardMutationFixture.SendInputWrongLibrary)
             })
    {
        var method = fixture.GetMethod(name, flags) ?? throw new InvalidOperationException(name);
        bool rejected = false;
        try { AssertAllowedNativeImports(new[] { method }); }
        catch (InvalidOperationException) { rejected = true; }
        Require(rejected, $"import policy silently accepted fixture {name}");
    }

    var readOnly = fixture.GetMethod(nameof(NativeImportGuardMutationFixture.AllowedDesktopQuery), flags)
        ?? throw new InvalidOperationException("missing read-only fixture");
    AssertAllowedNativeImports(new[] { readOnly });
});

Check("fake default deny, view only, canceled, stale epoch and lock issue zero effects", () =>
{
    var gate = new FakeEffectGate();
    int calls = 0;
    uint Send() { calls++; return 2; }
    bool Attempt(LocalInputConsent consent, bool desktop = true, CancellationToken token = default,
        long? epoch = null) => gate.TryFakeTap(epoch ?? gate.Snapshot, consent, token,
            () => desktop, Send, () => { calls++; return 1; });
    Require(!Attempt(default), "default consent accepted");
    Require(!Attempt(LocalInputConsent.ViewOnly), "view-only accepted");
    using var cancellation = new CancellationTokenSource();
    cancellation.Cancel();
    Require(!Attempt(LocalInputConsent.AllowControl, token: cancellation.Token), "canceled accepted");
    var preLockEpoch = gate.Snapshot;
    Require(!Attempt(LocalInputConsent.AllowControl, desktop: false), "locked or UAC desktop accepted");
    Require(gate.Snapshot != preLockEpoch, "secure desktop did not revoke fake approval");
    Require(!Attempt(LocalInputConsent.AllowControl, epoch: preLockEpoch),
        "old approval revived after returning to Default desktop");
    var oldEpoch = gate.Snapshot;
    gate.Revoke();
    Require(!Attempt(LocalInputConsent.AllowControl, epoch: oldEpoch), "pre-Stop lease accepted");
    Require(calls == 0, "effect callback ran without fake permission");
});

Check("nominal fake pair is a nonvacuous positive control", () =>
{
    var gate = new FakeEffectGate();
    int sent = 0, released = 0;
    Require(gate.TryFakeTap(gate.Snapshot, LocalInputConsent.AllowControl,
        CancellationToken.None, () => true, () => { sent++; return 2; },
        () => { released++; return 1; }), "nominal fake pair rejected");
    Require(sent == 1 && released == 0, "fake pair or release count incorrect");
});

Check("partial inserted fake key demands release and permanently revokes", () =>
{
    var gate = new FakeEffectGate();
    var epoch = gate.Snapshot;
    int releases = 0;
    Require(!gate.TryFakeTap(epoch, LocalInputConsent.AllowControl, CancellationToken.None,
        () => true, () => 1, () => { releases++; return 1; }), "partial press authorized");
    Require(releases == 1 && gate.Snapshot != epoch, "partial press did not release-attempt/revoke");
    Require(!gate.TryFakeTap(epoch, LocalInputConsent.AllowControl, CancellationToken.None,
        () => true, () => throw new Exception("stale effect called"), () => 1),
        "stale lease regained input permission");
});

Check("partial release failure is denied, not called safe or successful", () =>
{
    var gate = new FakeEffectGate();
    long epoch = gate.Snapshot;
    int attempts = 0;
    Require(!gate.TryFakeTap(epoch, LocalInputConsent.AllowControl, CancellationToken.None,
        () => true, () => 1, () => { attempts++; return 0; }), "failed release authorized");
    Require(attempts == 1 && gate.Snapshot != epoch, "release failure ignored");
    // A real key/button may remain down. This does NOT establish safe Win32 release.
});

Check("zero or invalid insertion counts revoke without a false release", () =>
{
    foreach (uint count in new uint[] { 0, 3, uint.MaxValue })
    {
        var gate = new FakeEffectGate();
        int releases = 0;
        var before = gate.Snapshot;
        Require(!gate.TryFakeTap(before, LocalInputConsent.AllowControl, CancellationToken.None,
            () => true, () => count, () => { releases++; return 1; }), "invalid count accepted");
        Require(releases == 0 && gate.Snapshot != before, "invalid count not fail closed");
    }
});

Check("post-insertion UAC/desktop transition denies and revokes", () =>
{
    var gate = new FakeEffectGate();
    var before = gate.Snapshot;
    int check = 0;
    Require(!gate.TryFakeTap(before, LocalInputConsent.AllowControl, CancellationToken.None,
        () => ++check == 1, () => 2, () => 1), "post-effect secure desktop accepted");
    Require(check == 2 && gate.Snapshot != before, "desktop transition did not revoke");
    // An already executed effect cannot be rolled back by this check.
});

Check("mid-effect cancellation and callback exceptions revoke", () =>
{
    using var cancellation = new CancellationTokenSource();
    var gate = new FakeEffectGate();
    var before = gate.Snapshot;
    Require(!gate.TryFakeTap(before, LocalInputConsent.AllowControl, cancellation.Token,
        () => true, () => { cancellation.Cancel(); return 2; }, () => 1),
        "mid-effect cancellation accepted");
    Require(gate.Snapshot != before, "mid-effect cancellation failed to revoke");
    gate = new FakeEffectGate(); before = gate.Snapshot;
    Require(!gate.TryFakeTap(before, LocalInputConsent.AllowControl, CancellationToken.None,
        () => true, () => throw new InvalidOperationException("fake send failed"), () => 1),
        "effect exception accepted");
    Require(gate.Snapshot != before, "effect exception failed to revoke");
    gate = new FakeEffectGate(); before = gate.Snapshot;
    Require(!gate.TryFakeTap(before, LocalInputConsent.AllowControl, CancellationToken.None,
        () => true, () => 1, () => throw new InvalidOperationException("fake release failed")),
        "release exception accepted");
    Require(gate.Snapshot != before, "release exception failed to revoke");
});

Check("concurrent Stop revokes in-flight fake effect before returning", () =>
{
    var gate = new FakeEffectGate();
    var before = gate.Snapshot;
    using var entered = new ManualResetEventSlim();
    using var resume = new ManualResetEventSlim();
    var effect = Task.Run(() => gate.TryFakeTap(before, LocalInputConsent.AllowControl,
        CancellationToken.None, () => true, () =>
        {
            entered.Set();
            if (!resume.Wait(TimeSpan.FromSeconds(10))) throw new TimeoutException("fake effect timed out");
            return 2;
        }, () => 1));
    try
    {
        Require(entered.Wait(TimeSpan.FromSeconds(10)), "fake effect never started");
        var stop = Task.Run(gate.Revoke);
        Require(SpinWait.SpinUntil(() => gate.Snapshot != before, TimeSpan.FromSeconds(10)),
            "Stop did not atomically invalidate epoch");
        Require(!stop.IsCompleted, "Stop returned while fake effect still running");
        resume.Set();
        Require(!effect.GetAwaiter().GetResult(), "effect passed after concurrent Stop");
        stop.GetAwaiter().GetResult();
        Require(!gate.TryFakeTap(before, LocalInputConsent.AllowControl, CancellationToken.None,
            () => true, () => throw new Exception("post-stop effect executed"), () => 1),
            "post-Stop old epoch revived");
    }
    finally { resume.Set(); }
});

Console.WriteLine("PASS: 10 hosted Windows native-effect negative groups; real native input remains OFF");

static void AssertAllowedNativeImports(IEnumerable<MethodInfo> methods)
{
    var allowedUser32 = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        { "OpenInputDesktop", "GetUserObjectInformationW", "CloseDesktop" };
    var prohibited = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        { "SendInput", "SetCursorPos", "mouse_event", "keybd_event", "SendMessageW", "PostMessageW" };
    foreach (var method in methods)
    {
        var import = method.GetCustomAttribute<DllImportAttribute>();
        if (import is null) continue;
        var entryPoint = import.EntryPoint ?? method.Name;
        Require(!prohibited.Contains(entryPoint), $"native input entry point present: {entryPoint}");
        if (import.Value.Equals("user32.dll", StringComparison.OrdinalIgnoreCase))
            Require(allowedUser32.Contains(entryPoint), $"unexpected user32 import: {entryPoint}");
    }
}

static void Check(string label, Action work)
{
    work();
    Console.WriteLine($"PASS: {label}");
}

static void Require(bool condition, string reason)
{
    if (!condition) throw new InvalidOperationException(reason);
}

// TEST-ONLY simulation of PR #27's ordering, not an adapter or production gate.
// It cannot prove the OS released a partially inserted key or button.
internal sealed class FakeEffectGate
{
    private readonly object sync = new();
    private long epoch;
    internal long Snapshot => Interlocked.Read(ref epoch);

    internal void Revoke()
    {
        Interlocked.Increment(ref epoch);
        lock (sync) { }
    }

    internal bool TryFakeTap(long expectedEpoch, LocalInputConsent consent,
        CancellationToken token, Func<bool> defaultDesktop, Func<uint> sendPair,
        Func<uint> releaseAfterPartial)
    {
        lock (sync)
        {
            try
            {
                if (consent != LocalInputConsent.AllowControl || token.IsCancellationRequested ||
                    Snapshot != expectedEpoch) return false;
                if (!defaultDesktop())
                {
                    Interlocked.Increment(ref epoch); // No reuse if a secure desktop later closes.
                    return false;
                }

                uint inserted = sendPair();
                if (inserted != 2)
                {
                    if (inserted == 1)
                    {
                        try { _ = releaseAfterPartial(); }
                        catch { /* Release is best effort: deny, never report success. */ }
                    }
                    Interlocked.Increment(ref epoch);
                    return false;
                }

                if (token.IsCancellationRequested || Snapshot != expectedEpoch || !defaultDesktop())
                {
                    Interlocked.Increment(ref epoch);
                    return false;
                }
                return true;
            }
            catch
            {
                Interlocked.Increment(ref epoch);
                return false;
            }
        }
    }
}

// Test-only metadata probes. These extern methods must never be invoked; the
// reflection guard inspects their DllImport declarations without loading Win32.
internal static class NativeImportGuardMutationFixture
{
    [DllImport("user32.dll", EntryPoint = "SendInput")]
    internal static extern uint SendInputAlias();

    [DllImport("user32.dll", EntryPoint = "SetCursorPos")]
    internal static extern bool SetCursorPosAlias();

    [DllImport("user32.dll", EntryPoint = "GetCursorPos")]
    internal static extern bool UnexpectedUser32();

    [DllImport("other.dll", EntryPoint = "SendInput")]
    internal static extern uint SendInputWrongLibrary();

    [DllImport("user32.dll", EntryPoint = "OpenInputDesktop")]
    internal static extern IntPtr AllowedDesktopQuery();
}
