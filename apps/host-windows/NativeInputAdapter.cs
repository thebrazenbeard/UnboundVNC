using System.Runtime.InteropServices;

namespace UnboundVnc.Host.Windows;

// Experimental user32 effects. Callers MUST hold the consent/revocation gate
// and prove the input desktop is Default before any call. No UAC bypass,
// desktop switching, key holds, drag, clipboard or elevated input is supported.
internal static class NativeInputAdapter
{
    private const uint Keyboard = 1;
    private const uint Mouse = 0;
    private const uint Unicode = 0x0004;
    private const uint KeyUp = 0x0002;
    internal static int InputStructSize => Marshal.SizeOf<Input>();
    internal static bool HasExpectedInputLayout => InputStructSize == (IntPtr.Size == 8 ? 40 : 28);

    internal static bool TryInject(NormalizedKey key)
    {
        if (!HasExpectedInputLayout) return false;
        if (!key.Down) return true; // Keyup is not retained: all injections are taps.

        ushort vk = key.Kind switch
        {
            LocalKeyKind.Backspace => 0x08,
            LocalKeyKind.Tab => 0x09,
            LocalKeyKind.Enter => 0x0d,
            LocalKeyKind.Escape => 0x1b,
            LocalKeyKind.Left => 0x25,
            LocalKeyKind.Up => 0x26,
            LocalKeyKind.Right => 0x27,
            LocalKeyKind.Down => 0x28,
            LocalKeyKind.Printable => 0,
            _ => ushort.MaxValue
        };
        if (vk == ushort.MaxValue || (key.Kind == LocalKeyKind.Printable &&
            key.Character is < ' ' or > '~')) return false;

        bool printable = key.Kind == LocalKeyKind.Printable;
        var down = new Input { Type = Keyboard, Data = new InputUnion {
            Keyboard = new KeyboardInput { VirtualKey = vk,
                Scan = printable ? (ushort)key.Character : (ushort)0, Flags = printable ? Unicode : 0 }
        } };
        var up = new Input { Type = Keyboard, Data = new InputUnion {
            Keyboard = new KeyboardInput { VirtualKey = vk,
                Scan = printable ? (ushort)key.Character : (ushort)0, Flags = (printable ? Unicode : 0) | KeyUp }
        } };
        return SendPaired(down, up);
    }

    internal static bool TryInject(NormalizedPointer pointer, byte newlyPressed)
    {
        if (!HasExpectedInputLayout) return false;
        if ((pointer.Buttons & ~0x07) != 0 || (newlyPressed & ~0x07) != 0 ||
            (newlyPressed & ~pointer.Buttons) != 0) return false;
        if (!SetCursorPos(pointer.ScreenX, pointer.ScreenY)) return false;
        if ((newlyPressed & 0x01) != 0 && !SendMouseClick(0x0002, 0x0004)) return false;
        if ((newlyPressed & 0x02) != 0 && !SendMouseClick(0x0020, 0x0040)) return false;
        if ((newlyPressed & 0x04) != 0 && !SendMouseClick(0x0008, 0x0010)) return false;
        return true;
    }

    private static bool SendMouseClick(uint down, uint up)
        => SendPaired(new Input { Type = Mouse, Data = new InputUnion {
            Mouse = new MouseInput { Flags = down }
        } }, new Input { Type = Mouse, Data = new InputUnion {
            Mouse = new MouseInput { Flags = up }
        } });

    private static bool SendPaired(Input down, Input up)
    {
        var pair = new[] { down, up };
        int size = Marshal.SizeOf<Input>();
        uint sent = SendInput((uint)pair.Length, pair, size);
        return PairCompleted(sent, () => SendInput(1, new[] { up }, size));
    }

    // Pure seam for failure injection: tests never call user32 or affect a desktop.
    internal static bool PairCompleted(uint sent, Func<uint> tryRelease)
    {
        if (sent == 2) return true;
        // Partial insertion could leave a synthetic key/button held. Attempt only
        // its release; either way fail the session, never retry the press.
        if (sent == 1) _ = tryRelease();
        return false;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Input { public uint Type; public InputUnion Data; }

    [StructLayout(LayoutKind.Explicit)]
    private struct InputUnion
    {
        [FieldOffset(0)] public MouseInput Mouse;
        [FieldOffset(0)] public KeyboardInput Keyboard;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MouseInput
    {
        public int X, Y;
        public uint MouseData, Flags, Time;
        public UIntPtr ExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KeyboardInput
    {
        public ushort VirtualKey, Scan;
        public uint Flags, Time;
        public UIntPtr ExtraInfo;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint count, [In] Input[] inputs, int size);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetCursorPos(int x, int y);
}
