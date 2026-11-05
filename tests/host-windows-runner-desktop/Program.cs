using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;

namespace UnboundVnc.RunnerDesktopProbe;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        int session = Process.GetCurrentProcess().SessionId;
        uint console = WTSGetActiveConsoleSessionId();
        bool userInteractive = Environment.UserInteractive;
        string station = NameOf(GetProcessWindowStation());
        string threadDesktop = NameOf(GetThreadDesktop(GetCurrentThreadId()));
        IntPtr inputHandle = OpenInputDesktop(0, false, 1);
        string inputDesktop = inputHandle == IntPtr.Zero ? "<unavailable>" : NameOf(inputHandle);
        int inputError = inputHandle == IntPtr.Zero ? Marshal.GetLastPInvokeError() : 0;
        if (inputHandle != IntPtr.Zero) CloseDesktop(inputHandle);

        bool hasScreen = false;
        try { hasScreen = Screen.PrimaryScreen?.Bounds is { Width: > 0, Height: > 0 }; }
        catch (Exception ex)
        {
            Console.WriteLine($"SCREEN_METADATA_ERROR={ex.GetType().Name}");
        }

        // Only read public session/desktop metadata; no pixels, windows or
        // credentials are copied, saved or transmitted by this diagnostic.
        Console.WriteLine($"RUNNER_SESSION_ID={session}");
        Console.WriteLine($"ACTIVE_CONSOLE_SESSION_ID={console}");
        Console.WriteLine($"USER_INTERACTIVE={userInteractive}");
        Console.WriteLine($"WINDOW_STATION={station}");
        Console.WriteLine($"THREAD_DESKTOP={threadDesktop}");
        Console.WriteLine($"INPUT_DESKTOP={inputDesktop}");
        Console.WriteLine($"INPUT_DESKTOP_ERROR={inputError}");
        Console.WriteLine($"SCREEN_PRESENT={hasScreen}");

        bool interactiveCandidate = userInteractive && session > 0 &&
            (uint)session == console && station.Equals("WinSta0", StringComparison.OrdinalIgnoreCase) &&
            threadDesktop.Equals("Default", StringComparison.Ordinal) &&
            inputDesktop.Equals("Default", StringComparison.Ordinal) && hasScreen;
        if (!interactiveCandidate)
        {
            Console.WriteLine("HOSTED_GUI_RUNTIME=BLOCKED_NONINTERACTIVE_DESKTOP");
            Console.WriteLine("HOST_LAUNCH=NOT_ATTEMPTED");
            Console.WriteLine("RFB_FRAMEBUFFER=NOT_TESTED_NO_HUMAN_CONSENT");
            Console.WriteLine("::notice title=Windows GUI qualification blocked::Runner lacks a verified interactive Default console desktop; no host was launched or consent simulated.");
            return 0; // Diagnostic step succeeded; host runtime qualification did NOT.
        }

        Console.WriteLine("HOSTED_GUI_RUNTIME=INTERACTIVE_CANDIDATE_NOT_HUMAN_VERIFIED");
        if (args.Length != 1 || !File.Exists(args[0]))
        {
            Console.WriteLine("HOST_LAUNCH=BLOCKED_HOST_BINARY_MISSING");
            return 1;
        }

        // Only if a genuine interactive console is observed: check that the
        // stopped-by-default host creates its own window, without UI input.
        if (CanConnectToHost())
        {
            Console.WriteLine("HOST_LAUNCH=BLOCKED_PORT_ALREADY_LISTENING");
            return 1;
        }

        Process? host = null;
        try
        {
            host = Process.Start(new ProcessStartInfo
            {
                FileName = Path.GetFullPath(args[0]),
                WorkingDirectory = Path.GetDirectoryName(Path.GetFullPath(args[0]))!,
                UseShellExecute = false
            });
            if (host is null) throw new InvalidOperationException("Host process did not start");
            DateTime deadline = DateTime.UtcNow.AddSeconds(8);
            IntPtr handle = IntPtr.Zero;
            while (DateTime.UtcNow < deadline && !host.HasExited)
            {
                host.Refresh();
                handle = host.MainWindowHandle;
                if (handle != IntPtr.Zero) break;
                Thread.Sleep(100);
            }
            if (handle == IntPtr.Zero || CanConnectToHost())
            {
                Console.WriteLine("HOST_LAUNCH=FAILED_WINDOW_OR_STOPPED_DEFAULT");
                return 1;
            }
            var title = new StringBuilder(128);
            _ = GetWindowText(handle, title, title.Capacity);
            bool titleMatched = title.ToString() == "UnboundVNC | Attended Host Preview";
            Console.WriteLine($"HOST_LAUNCH={(titleMatched ? "STOPPED_WINDOW_CREATED" : "WINDOW_TITLE_MISMATCH")}");
            Console.WriteLine("RFB_FRAMEBUFFER=NOT_TESTED_NO_HUMAN_CONSENT");
            return titleMatched ? 0 : 1;
        }
        catch (Exception ex)
        {
            Console.WriteLine($"HOST_LAUNCH=ERROR_{ex.GetType().Name}");
            return 1;
        }
        finally
        {
            // Only the child launched by this test can be stopped here.
            if (host is not null)
            {
                if (!host.HasExited)
                {
                    _ = host.CloseMainWindow();
                    if (!host.WaitForExit(2000))
                    {
                        host.Kill(entireProcessTree: true);
                        host.WaitForExit(2000);
                    }
                }
                host.Dispose();
            }
        }
    }

    private static bool CanConnectToHost()
    {
        using var socket = new TcpClient();
        using var timeout = new CancellationTokenSource(TimeSpan.FromMilliseconds(500));
        try
        {
            socket.ConnectAsync(IPAddress.Loopback, 5901, timeout.Token).GetAwaiter().GetResult();
            return true;
        }
        catch (SocketException ex) when (ex.SocketErrorCode == SocketError.ConnectionRefused) { return false; }
        catch (OperationCanceledException) { return true; } // Unknown port state: fail closed.
    }

    private static string NameOf(IntPtr handle)
    {
        if (handle == IntPtr.Zero) return "<unavailable>";
        var name = new StringBuilder(256);
        return GetUserObjectInformationW(handle, 2, name, (uint)(name.Capacity * sizeof(char)), out _)
            ? name.ToString() : "<unavailable>";
    }

    [DllImport("kernel32.dll")] private static extern uint WTSGetActiveConsoleSessionId();
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] private static extern IntPtr GetProcessWindowStation();
    [DllImport("user32.dll")] private static extern IntPtr GetThreadDesktop(uint threadId);
    [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll")] private static extern bool CloseDesktop(IntPtr handle);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetUserObjectInformationW(IntPtr handle, int index,
        StringBuilder buffer, uint length, out uint required);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr window, StringBuilder text, int maxCount);
}
