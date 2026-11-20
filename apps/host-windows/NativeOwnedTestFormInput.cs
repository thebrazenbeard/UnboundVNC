using System.Drawing;
using System.Runtime.InteropServices;

namespace UnboundVnc.Host.Windows;

/// <summary>
/// Narrow actual Win32 SendInput effect adapter for a host-created TEST form.
/// The RFB client never supplies the target handle/owner/lease. This adapter
/// cannot be used for a real Firefox or foreign window; the host's explicit
/// second on-screen approval and test lease are prerequisite.
/// </summary>
internal static class NativeOwnedTestFormInput
{
    private const uint InputMouse = 0, InputKeyboard = 1;
    private const uint KeyUnicode = 0x0004, KeyUp = 0x0002;
    private const uint MouseMove = 0x0001, MouseLeftDown = 0x0002,
        MouseLeftUp = 0x0004, MouseVirtualDesktop = 0x4000,
        MouseAbsolute = 0x8000;

    [StructLayout(LayoutKind.Sequential)]
    private struct KeyData
    {
        public ushort Vk;
        public ushort Scan;
        public uint Flags;
        public uint Time;
        public nuint Extra;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MouseData
    {
        public int X;
        public int Y;
        public uint Buttons;
        public uint Flags;
        public uint Time;
        public nuint Extra;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct Payload
    {
        [FieldOffset(0)] public KeyData Keyboard;
        [FieldOffset(0)] public MouseData Mouse;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct InputRecord
    {
        public uint Type;
        public Payload Data;
    }

    [DllImport("user32.dll", EntryPoint = "SendInput", SetLastError = true)]
    private static extern uint SendInputNative(uint count,
        [In] InputRecord[] records, int recordBytes);

    [DllImport("user32.dll", EntryPoint = "GetSystemMetrics")]
    private static extern int GetSystemMetrics(int index);

    private static bool IsHostOwnedCurrentTarget(nint exactTestHwnd,
        Rectangle exactTestBounds, long epoch, bool sessionCurrent)
    {
        if (!OperatingSystem.IsWindows() || exactTestHwnd == 0 || !sessionCurrent ||
            epoch <= 0 || exactTestBounds.Width is < 1 or > 1280 ||
            exactTestBounds.Height is < 1 or > 720)
            return false;
        var observed = TrustedControlObservation.Capture(epoch, sessionCurrent);
        return observed.DefaultDesktop &&
            observed.ForegroundRoot == exactTestHwnd &&
            observed.ForegroundOwnerPid == Environment.ProcessId &&
            observed.TargetBounds == exactTestBounds;
    }

    internal static bool TryTypeTestChar(NormalizedKey key, nint exactTestHwnd,
        Rectangle exactTestBounds, bool ownedTextBoxFocused,
        long epoch, bool sessionCurrent)
    {
        // Very narrow effect class: printable lowercase ASCII only, no
        // Return/Tab/shortcuts, no key repeat or held modifier state.
        if (!key.Down || key.Kind != LocalKeyKind.Printable ||
            key.Character is < 'a' or > 'z' || !ownedTextBoxFocused ||
            !IsHostOwnedCurrentTarget(exactTestHwnd, exactTestBounds, epoch, sessionCurrent))
            return false;

        var input = new[]
        {
            new InputRecord {
                Type = InputKeyboard,
                Data = new Payload {
                    Keyboard = new KeyData {
                        Vk = 0, Scan = key.Character, Flags = KeyUnicode
                    }
                }
            },
            new InputRecord {
                Type = InputKeyboard,
                Data = new Payload {
                    Keyboard = new KeyData {
                        Vk = 0, Scan = key.Character, Flags = KeyUnicode | KeyUp
                    }
                }
            }
        };
        uint written = SendInputNative((uint)input.Length, input,
            Marshal.SizeOf<InputRecord>());
        if (written == (uint)input.Length) return true;
        // If press was inserted but release was not, attempt a matching
        // release before reporting failure. Never report partial success.
        if (written == 1)
            _ = SendInputNative(1, new[] { input[1] },
                Marshal.SizeOf<InputRecord>());
        return false;
    }

    internal static bool TryClickTestButton(NormalizedPointer pointer,
        nint exactTestHwnd, Rectangle exactTestBounds,
        Rectangle exactButtonBounds, long epoch, bool sessionCurrent)
    {
        if (pointer.Buttons != 1 ||
            !exactButtonBounds.Contains(pointer.ScreenX, pointer.ScreenY) ||
            !exactTestBounds.Contains(pointer.ScreenX, pointer.ScreenY) ||
            !IsHostOwnedCurrentTarget(exactTestHwnd, exactTestBounds, epoch, sessionCurrent))
            return false;

        int left = GetSystemMetrics(76), top = GetSystemMetrics(77);
        int width = GetSystemMetrics(78), height = GetSystemMetrics(79);
        if (width < 2 || height < 2 ||
            pointer.ScreenX < left || pointer.ScreenX >= (long)left + width ||
            pointer.ScreenY < top || pointer.ScreenY >= (long)top + height)
            return false;

        // MOVE+LEFTDOWN+LEFTUP is one bounded native batch. No holds,
        // scrolling, right click, drag, clipboard, or remote target selection.
        int x = checked((int)(((long)pointer.ScreenX - left) * 65535 / (width - 1)));
        int y = checked((int)(((long)pointer.ScreenY - top) * 65535 / (height - 1)));
        var pair = new[]
        {
            new InputRecord {
                Type = InputMouse,
                Data = new Payload {
                    Mouse = new MouseData { X=x, Y=y,
                        Flags=MouseMove|MouseAbsolute|MouseVirtualDesktop }
                }
            },
            new InputRecord {
                Type = InputMouse,
                Data = new Payload {
                    Mouse = new MouseData { Flags=MouseLeftDown }
                }
            },
            new InputRecord {
                Type = InputMouse,
                Data = new Payload {
                    Mouse = new MouseData { Flags=MouseLeftUp }
                }
            }
        };
        uint written = SendInputNative((uint)pair.Length, pair,
            Marshal.SizeOf<InputRecord>());
        if (written == (uint)pair.Length) return true;
        // A partial batch after MOVE and LEFTDOWN can leave the button
        // pressed. Best-effort LEFTUP, then fail closed (not a success).
        if (written == 2)
            _ = SendInputNative(1, new[] { pair[2] },
                Marshal.SizeOf<InputRecord>());
        return false;
    }
}