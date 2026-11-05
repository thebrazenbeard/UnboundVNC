using System.Buffers.Binary;
using UnboundVnc.Host.Windows;

Check("default and view-only never authorize effects", () =>
{
    Require(default(LocalInputConsent) == LocalInputConsent.Denied, "missing consent must deny");
    var gate = new ConsentEffectGate();
    int effects = 0;
    var epoch = gate.Snapshot;
    Require(!gate.TryEffect(epoch, LocalInputConsent.Denied, CancellationToken.None,
        () => true, () => { effects++; return true; }), "no-consent effect was allowed");
    Require(!gate.TryEffect(epoch, LocalInputConsent.ViewOnly, CancellationToken.None,
        () => true, () => { effects++; return true; }), "view-only effect was allowed");
    Require(effects == 0, "native effect callback ran without control permission");
});

Check("explicit control permits one tested effect", () =>
{
    var gate = new ConsentEffectGate();
    int effects = 0;
    Require(gate.TryEffect(gate.Snapshot, LocalInputConsent.AllowControl, CancellationToken.None,
        () => true, () => { effects++; return true; }), "explicit control did not reach effect");
    Require(effects == 1, "effect called unexpected number of times");
});

Check("Stop/lock revoke and expired token deny", () =>
{
    var gate = new ConsentEffectGate();
    long epoch = gate.Snapshot;
    gate.Revoke(); // Same source method used by Stop and SessionLock.
    Require(!gate.TryEffect(epoch, LocalInputConsent.AllowControl, CancellationToken.None,
        () => true, () => true), "revoked epoch allowed effect");
    using var expired = new CancellationTokenSource();
    expired.Cancel();
    Require(!gate.TryEffect(gate.Snapshot, LocalInputConsent.AllowControl, expired.Token,
        () => true, () => true), "expired session allowed effect");
});

Check("secure desktop rejects before and after mock injection", () =>
{
    var gate = new ConsentEffectGate();
    int effects = 0;
    Require(!gate.TryEffect(gate.Snapshot, LocalInputConsent.AllowControl, CancellationToken.None,
        () => false, () => { effects++; return true; }), "secure desktop effect was allowed");
    Require(effects == 0, "mock Win32 injection was invoked on nondefault desktop");
    bool defaultDesktop = true;
    long epoch = gate.Snapshot;
    Require(!gate.TryEffect(epoch, LocalInputConsent.AllowControl, CancellationToken.None,
        () => defaultDesktop, () => { defaultDesktop = false; return true; }),
        "desktop transition during effect was not rejected afterward");
    Require(!gate.TryEffect(epoch, LocalInputConsent.AllowControl, CancellationToken.None,
        () => true, () => true), "desktop transition did not revoke session");
});

Check("failed mock Win32 injection revokes control", () =>
{
    var gate = new ConsentEffectGate();
    long epoch = gate.Snapshot;
    Require(!gate.TryEffect(epoch, LocalInputConsent.AllowControl, CancellationToken.None,
        () => true, () => false), "failed effect was treated as success");
    Require(gate.Snapshot != epoch, "failed effect did not revoke epoch");
    Require(!gate.TryEffect(epoch, LocalInputConsent.AllowControl, CancellationToken.None,
        () => true, () => true), "failed effect retained control");
});

Check("revocation fences an in-flight mock effect", () =>
{
    var gate = new ConsentEffectGate();
    long epoch = gate.Snapshot;
    using var entered = new ManualResetEventSlim(false);
    using var release = new ManualResetEventSlim(false);
    var effect = Task.Run(() => gate.TryEffect(epoch, LocalInputConsent.AllowControl,
        CancellationToken.None, () => true, () =>
        {
            entered.Set();
            return release.Wait(TimeSpan.FromSeconds(5));
        }));
    try
    {
        Require(entered.Wait(TimeSpan.FromSeconds(5)), "mock effect did not start");
        var revoke = Task.Run(gate.Revoke);
        Require(SpinWait.SpinUntil(() => gate.Snapshot != epoch, TimeSpan.FromSeconds(5)),
            "revocation did not invalidate epoch promptly");
        release.Set();
        Task.WaitAll(effect, revoke);
        Require(!effect.Result, "effect was accepted after overlapping revoke");
        Require(!gate.TryEffect(epoch, LocalInputConsent.AllowControl, CancellationToken.None,
            () => true, () => true), "effect admitted after revoke returned");
    }
    finally { release.Set(); }
});

Check("native INPUT layout matches target pointer width (no API calls)", () =>
{
    Require(NativeInputAdapter.HasExpectedInputLayout, "SendInput INPUT interop has wrong size");
});

Check("native partial/failed pair injection is rejected with release attempt", () =>
{
    int releases = 0;
    Require(NativeInputAdapter.PairCompleted(2, () => { releases++; return 1; }),
        "two inserted events were not accepted");
    Require(releases == 0, "successful pair invoked redundant release");
    Require(!NativeInputAdapter.PairCompleted(1, () => { releases++; return 0; }),
        "partial input pair was accepted");
    Require(releases == 1, "partial input did not attempt release");
    Require(!NativeInputAdapter.PairCompleted(0, () => { releases++; return 1; }),
        "blocked Win32 input pair was accepted");
    Require(releases == 1, "failed pair unexpectedly injected a release");
});

Check("ASCII key mapping and release", () =>
{
    Require(ExperimentalInputPolicy.TryParseKey(Key(0x41), out var down), "A was rejected");
    Require(down == new NormalizedKey(true, LocalKeyKind.Printable, 'A'), "A mapped incorrectly");
    Require(ExperimentalInputPolicy.TryParseKey(Key(0x61, 0), out var up), "a release was rejected");
    Require(up == new NormalizedKey(false, LocalKeyKind.Printable, 'a'), "a release mapped incorrectly");
});

Check("deliberately bounded special keys", () =>
{
    var expected = new (uint sym, LocalKeyKind kind)[]
    {
        (0xff08, LocalKeyKind.Backspace), (0xff09, LocalKeyKind.Tab),
        (0xff0d, LocalKeyKind.Enter), (0xff1b, LocalKeyKind.Escape),
        (0xff51, LocalKeyKind.Left), (0xff52, LocalKeyKind.Up),
        (0xff53, LocalKeyKind.Right), (0xff54, LocalKeyKind.Down)
    };
    foreach (var (sym, kind) in expected)
    {
        Require(ExperimentalInputPolicy.TryParseKey(Key(sym), out var key), "supported special key was rejected");
        Require(key.Kind == kind && key.Character == '\0' && key.Down, "special key mapped incorrectly");
    }
});

Check("unknown, modifier and Unicode keysyms fail closed", () =>
{
    foreach (uint sym in new uint[] { 0, 0x1f, 0x7f, 0xffe1, 0xffe3, 0xffe9, 0xffeb, 0x10020ac, uint.MaxValue })
        Require(!ExperimentalInputPolicy.TryParseKey(Key(sym), out _), "unmapped keysym was accepted");
});

Check("malformed key flags, padding and length fail closed", () =>
{
    Require(!ExperimentalInputPolicy.TryParseKey(Key(0x61, 2), out _), "noncanonical down flag was accepted");
    var badPad = Key(0x61); badPad[1] = 1;
    Require(!ExperimentalInputPolicy.TryParseKey(badPad, out _), "nonzero padding was accepted");
    Require(!ExperimentalInputPolicy.TryParseKey(new byte[6], out _), "truncated key payload was accepted");
    Require(!ExperimentalInputPolicy.TryParseKey(new byte[8], out _), "oversized key payload was accepted");
    Require(!ExperimentalInputPolicy.TryParseKey(new byte[1 << 20], out _), "large payload was accepted");
});

Check("pointer offsets and 16-bit framing", () =>
{
    Require(ExperimentalInputPolicy.TryParsePointer(Pointer(7, 1279, 719),
        1280, 720, -1920, 0, out var p), "edge pointer was rejected");
    Require(p == new NormalizedPointer(-641, 719, 7), "pointer location or mask changed");
    Require(ExperimentalInputPolicy.TryParsePointer(Pointer(0, 0, 0),
        1, 1, 50, -20, out var q) && q == new NormalizedPointer(50, -20, 0),
        "origin pointer mapped incorrectly");
});

Check("out-of-frame coordinates and dimensions fail closed", () =>
{
    Require(!ExperimentalInputPolicy.TryParsePointer(Pointer(0, 1280, 0), 1280, 720, 0, 0, out _), "x overflow accepted");
    Require(!ExperimentalInputPolicy.TryParsePointer(Pointer(0, 0, 720), 1280, 720, 0, 0, out _), "y overflow accepted");
    Require(!ExperimentalInputPolicy.TryParsePointer(Pointer(0, 0, 0), 0, 720, 0, 0, out _), "zero width accepted");
    Require(!ExperimentalInputPolicy.TryParsePointer(Pointer(0, 0, 0), 1281, 720, 0, 0, out _), "oversized width accepted");
    Require(!ExperimentalInputPolicy.TryParsePointer(Pointer(0, 0, 0), 1280, 721, 0, 0, out _), "oversized height accepted");
    Require(!ExperimentalInputPolicy.TryParsePointer(Pointer(0, 2, 0), 2, 2, 0, 0, out _), "x == width accepted");
});

Check("unsupported buttons, malformed lengths and arithmetic overflow fail closed", () =>
{
    for (int mask = 8; mask <= 255; mask++)
        Require(!ExperimentalInputPolicy.TryParsePointer(Pointer((byte)mask, 0, 0), 1280, 720, 0, 0, out _),
            "unsupported pointer button mask accepted");
    Require(!ExperimentalInputPolicy.TryParsePointer(new byte[4], 1280, 720, 0, 0, out _), "truncated pointer accepted");
    Require(!ExperimentalInputPolicy.TryParsePointer(new byte[6], 1280, 720, 0, 0, out _), "oversized pointer accepted");
    Require(!ExperimentalInputPolicy.TryParsePointer(new byte[1 << 20], 1280, 720, 0, 0, out _), "large pointer accepted");
    Require(!ExperimentalInputPolicy.TryParsePointer(Pointer(0, 1, 0), 1280, 720, int.MaxValue, 0, out _), "x arithmetic overflow accepted");
    Require(!ExperimentalInputPolicy.TryParsePointer(Pointer(0, 0, 1), 1280, 720, 0, int.MaxValue, out _), "y arithmetic overflow accepted");
});

Console.WriteLine("PASS: 15 input policy/effect-gate checks; native effects mocked only");

static void Check(string label, Action action)
{
    action();
    Console.WriteLine($"PASS: {label}");
}

static byte[] Key(uint keysym, byte down = 1)
{
    var payload = new byte[7];
    payload[0] = down;
    BinaryPrimitives.WriteUInt32BigEndian(payload.AsSpan(3, 4), keysym);
    return payload;
}

static byte[] Pointer(byte buttons, ushort x, ushort y)
{
    var payload = new byte[5];
    payload[0] = buttons;
    BinaryPrimitives.WriteUInt16BigEndian(payload.AsSpan(1, 2), x);
    BinaryPrimitives.WriteUInt16BigEndian(payload.AsSpan(3, 2), y);
    return payload;
}

static void Require(bool condition, string error)
{
    if (!condition) throw new InvalidOperationException(error);
}
