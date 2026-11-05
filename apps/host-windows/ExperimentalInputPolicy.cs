using System.Buffers.Binary;

namespace UnboundVnc.Host.Windows;

// Deliberately bounded mapping: unsupported keysyms and coordinates fail closed.
internal enum LocalInputConsent { Denied = 0, ViewOnly = 1, AllowControl = 2 }

internal enum LocalKeyKind
{
    Printable,
    Backspace,
    Tab,
    Enter,
    Escape,
    Left,
    Up,
    Right,
    Down
}
internal readonly record struct NormalizedKey(bool Down, LocalKeyKind Kind, char Character);
internal readonly record struct NormalizedPointer(int ScreenX, int ScreenY, byte Buttons);

internal static class ExperimentalInputPolicy
{
    private const int MaxWidth = 1280;
    private const int MaxHeight = 720;

    // Input bytes are the RFB KeyEvent payload AFTER message type 4.
    internal static bool TryParseKey(ReadOnlySpan<byte> payload, out NormalizedKey key)
    {
        key = default;
        if (payload.Length != 7 || payload[0] > 1 || payload[1] != 0 || payload[2] != 0)
            return false;

        bool down = payload[0] == 1;
        uint keysym = BinaryPrimitives.ReadUInt32BigEndian(payload[3..]);
        if (keysym is >= 0x20 and <= 0x7e)
        {
            key = new NormalizedKey(down, LocalKeyKind.Printable, (char)keysym);
            return true;
        }

        LocalKeyKind? kind = keysym switch
        {
            0xff08 => LocalKeyKind.Backspace,
            0xff09 => LocalKeyKind.Tab,
            0xff0d => LocalKeyKind.Enter,
            0xff1b => LocalKeyKind.Escape,
            0xff51 => LocalKeyKind.Left,
            0xff52 => LocalKeyKind.Up,
            0xff53 => LocalKeyKind.Right,
            0xff54 => LocalKeyKind.Down,
            _ => null
        };
        if (kind is null) return false; // No guessed X11-to-Windows key mapping.
        key = new NormalizedKey(down, kind.Value, '\0');
        return true;
    }

    // Input bytes are the RFB PointerEvent payload AFTER message type 5.
    // The 1280x720 preview crops rather than scales the primary screen.
    internal static bool TryParsePointer(ReadOnlySpan<byte> payload, int width, int height,
        int desktopLeft, int desktopTop, out NormalizedPointer pointer)
    {
        pointer = default;
        if (payload.Length != 5 || width is < 1 or > MaxWidth || height is < 1 or > MaxHeight)
            return false;
        byte buttons = payload[0];
        if ((buttons & ~0x07) != 0) return false; // Wheel/extended buttons not mapped.

        int x = BinaryPrimitives.ReadUInt16BigEndian(payload[1..3]);
        int y = BinaryPrimitives.ReadUInt16BigEndian(payload[3..5]);
        if (x >= width || y >= height) return false;
        try
        {
            pointer = new NormalizedPointer(checked(desktopLeft + x),
                checked(desktopTop + y), buttons);
            return true;
        }
        catch (OverflowException) { return false; }
    }
}
