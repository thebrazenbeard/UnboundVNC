using System.Buffers.Binary;
using UnboundVnc.Host.Windows;

Check("source adapter always disabled", () =>
{
    Require(!NativeInputAdapter.Enabled, "native input unexpectedly enabled");
    Require(default(LocalInputConsent) == LocalInputConsent.Denied, "missing consent must deny");
    Require(!NativeInputAdapter.TryInject(new NormalizedKey(true, LocalKeyKind.Printable, 'a'),
        LocalInputConsent.AllowControl, true, true), "key was injected without qualification");
    Require(!NativeInputAdapter.TryInject(new NormalizedPointer(100, 100, 1),
        LocalInputConsent.AllowControl, true, true), "pointer was injected without qualification");
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

Console.WriteLine("PASS: 8 input policy checks; no native input path enabled");

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
