namespace UnboundVnc.Host.Windows;

/// <summary>
/// Only the two exact 32bpp little-endian TrueColor layouts required by the
/// attended local host and the stock noVNC client are accepted. Never infer
/// an arbitrary, attacker-selected pixel conversion from an RFB message.
/// </summary>
internal static class RfbPixelFormatPolicy
{
    // B,G,R,pad bytes from GDI 32bpp ARGB; RFB red shift 16.
    internal static readonly byte[] Advertised =
        { 32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0 };

    // noVNC 1.7 sends depth=24, bpp=32, little endian, R,G,B,pad.
    internal static readonly byte[] NoVnc =
        { 32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 0, 8, 16, 0, 0, 0 };

    internal static bool TrySelect(ReadOnlySpan<byte> requested, out bool redFirst)
    {
        redFirst = false;
        if (requested.SequenceEqual(Advertised)) return true;
        if (!requested.SequenceEqual(NoVnc)) return false;
        redFirst = true;
        return true;
    }

    /// <summary>
    /// Rewrite captured B,G,R,pad into R,G,B,pad only when noVNC requests it.
    /// No copying outside the owned bounded framebuffer byte array.
    /// </summary>
    internal static void ConvertInPlace(Span<byte> rawPixels, bool redFirst)
    {
        if (rawPixels.Length % 4 != 0)
            throw new ArgumentException("Raw framebuffer is not complete 32-bit pixels");
        if (!redFirst) return;
        for (var offset = 0; offset < rawPixels.Length; offset += 4)
        {
            (rawPixels[offset], rawPixels[offset + 2]) =
                (rawPixels[offset + 2], rawPixels[offset]);
        }
    }
}