using System.Drawing;
using System.Runtime.InteropServices;
using System.Text;

namespace UnboundVnc.Host.Windows;

/// <summary>
/// Read-only OS witness for the candidate control gate. No remote-client
/// fields may be used to assert focus, owner, target bounds or desktop state.
/// A caller still MUST supply its own authenticated local session epoch and
/// current consent state; this class never grants a control lease.
/// </summary>
internal static class TrustedControlObservation
{
    private const uint GaRoot = 2;
    private const uint DesktopReadObjects = 0x0001;

    [StructLayout(LayoutKind.Sequential)]
    private struct WinRect
    {
        internal int Left;
        internal int Top;
        internal int Right;
        internal int Bottom;
    }

    [DllImport("user32.dll", EntryPoint = "GetForegroundWindow")]
    private static extern nint GetForegroundWindow();

    [DllImport("user32.dll", EntryPoint = "GetAncestor")]
    private static extern nint GetAncestor(nint hwnd, uint flags);

    [DllImport("user32.dll", EntryPoint = "GetWindowThreadProcessId")]
    private static extern uint GetWindowThreadProcessId(nint hwnd, out uint pid);

    [DllImport("user32.dll", EntryPoint = "GetWindowRect")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetWindowRect(nint hwnd, out WinRect rectangle);

    [DllImport("user32.dll", EntryPoint = "OpenInputDesktop", SetLastError = true)]
    private static extern nint OpenInputDesktop(uint flags, bool inherit, uint desiredAccess);

    [DllImport("user32.dll", EntryPoint = "GetUserObjectInformationW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetUserObjectInformationW(nint handle, int index, StringBuilder buffer, uint length, out uint required);

    [DllImport("user32.dll", EntryPoint = "CloseDesktop")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseDesktop(nint handle);

    internal static ControlObservation Capture(long hostSessionEpoch, bool sessionCurrent)
    {
        // The host supplies these two values from its own session owner; only
        // Windows APIs supply focus/root/PID/rect/desktop/current time.
        var foreground = GetForegroundWindow();
        var root = foreground == 0 ? 0 : GetAncestor(foreground, GaRoot);
        if (root == 0) root = foreground;
        int pid = 0;
        Rectangle bounds = Rectangle.Empty;
        if (root != 0)
        {
            _ = GetWindowThreadProcessId(root, out uint observedPid);
            if (observedPid <= int.MaxValue) pid = (int)observedPid;
            if (GetWindowRect(root, out var raw) &&
                raw.Right > raw.Left && raw.Bottom > raw.Top)
            {
                try
                {
                    bounds = new Rectangle(raw.Left, raw.Top,
                        checked(raw.Right - raw.Left), checked(raw.Bottom - raw.Top));
                }
                catch (OverflowException) { bounds = Rectangle.Empty; }
            }
        }

        return new ControlObservation(
            hostSessionEpoch, root, pid, bounds,
            defaultDesktop: IsDefaultInputDesktop(), sessionCurrent: sessionCurrent,
            now: DateTimeOffset.UtcNow);
    }

    private static bool IsDefaultInputDesktop()
    {
        var desktop = OpenInputDesktop(0, false, DesktopReadObjects);
        if (desktop == 0) return false;
        try
        {
            var name = new StringBuilder(128);
            return GetUserObjectInformationW(desktop, 2, name,
                checked((uint)(name.Capacity * sizeof(char))), out _) &&
                StringComparer.Ordinal.Equals(name.ToString(), "Default");
        }
        finally { CloseDesktop(desktop); }
    }
}