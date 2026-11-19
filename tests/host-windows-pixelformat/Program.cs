namespace UnboundVnc.Host.Windows;

// Exercises exactly the source file linked into the actual host build.
internal static class Program
{
    private static int checks;

    static void Check(bool result, string label)
    {
        if (!result) throw new Exception("PIXEL_POLICY_FAIL_" + label);
        checks++;
    }

    static void Main()
    {
        var native = new byte[] { 32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0 };
        var noVnc = new byte[] { 32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 0, 8, 16, 0, 0, 0 };
        Check(RfbPixelFormatPolicy.TrySelect(native, out var nativeSwap) && !nativeSwap,
            "advertised_native");
        Check(RfbPixelFormatPolicy.TrySelect(noVnc, out var noVncSwap) && noVncSwap,
            "novnc_requested_rgb");

        var pixels = new byte[] { 220, 150, 30, 255, 90, 40, 200, 255 };
        var unchanged = (byte[])pixels.Clone();
        RfbPixelFormatPolicy.ConvertInPlace(unchanged, nativeSwap);
        Check(unchanged.AsSpan().SequenceEqual(pixels), "native_unchanged");
        var swapped = (byte[])pixels.Clone();
        RfbPixelFormatPolicy.ConvertInPlace(swapped, noVncSwap);
        Check(swapped.AsSpan().SequenceEqual(new byte[] { 30, 150, 220, 255, 200, 40, 90, 255 }),
            "novnc_color_channels");

        var invalid = (byte[])noVnc.Clone();
        invalid[0] = 16;
        Check(!RfbPixelFormatPolicy.TrySelect(invalid, out _), "reject_16bpp");
        invalid = (byte[])noVnc.Clone();
        invalid[2] = 1;
        Check(!RfbPixelFormatPolicy.TrySelect(invalid, out _), "reject_big_endian");
        invalid = (byte[])noVnc.Clone();
        invalid[11] = 12;
        Check(!RfbPixelFormatPolicy.TrySelect(invalid, out _), "reject_unknown_shift");
        invalid = (byte[])noVnc.Clone();
        invalid[5] = 127;
        Check(!RfbPixelFormatPolicy.TrySelect(invalid, out _), "reject_non_255_max");
        Check(!RfbPixelFormatPolicy.TrySelect(noVnc.AsSpan(0, 15), out _),
            "reject_short_payload");
        Console.WriteLine("PIXEL_FORMAT_POLICY_PASS=" + checks);
    }
}