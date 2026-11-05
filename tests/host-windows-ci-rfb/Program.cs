using System.Buffers.Binary;
using System.Diagnostics;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;

namespace UnboundVnc.HostedRfbSyntheticConsent;

// This opt-in integration test is restricted to an ephemeral GitHub-hosted
// Windows runner. BM_CLICK is deliberate CI automation, NEVER human consent.
internal static class Program
{
    private const string HostTitle = "UnboundVNC | Attended Host Preview";
    private const string ApprovalTitle = "UnboundVNC | Approve local screen sharing";
    private static readonly byte[] Version = Encoding.ASCII.GetBytes("RFB 003.008\n");
    private const int OracleWidth = 32;
    private const int OracleHeight = 24;
    private static readonly Color[] Pattern =
    {
        Color.FromArgb(14, 171, 219), Color.FromArgb(219, 46, 88),
        Color.FromArgb(73, 210, 45), Color.FromArgb(189, 83, 222)
    };

    [STAThread]
    private static int Main(string[] args)
    {
        Console.WriteLine("CONSENT_EVIDENCE=SYNTHETIC_CI_AUTOMATION_NOT_HUMAN_APPROVAL");
        Console.WriteLine("RFB_BINDING=127.0.0.1_ONLY");
        if (!IsExplicitHostedCi())
        {
            Console.WriteLine("HOSTED_RFB=BLOCKED_NOT_EXPLICIT_GITHUB_HOSTED_CI");
            return 1;
        }

        try
        {
            Require(args.Length == 1 && File.Exists(args[0]), "HOST_BINARY_MISSING");
            Require(IsInteractiveDefaultConsole(), "NONINTERACTIVE_DESKTOP");
            Require(!IsPort5901Listening(), "PREEXISTING_PORT_5901_LISTENER");
            var bounds = Screen.PrimaryScreen!.Bounds;
            int frameWidth = Math.Min(1280, bounds.Width);
            int frameHeight = Math.Min(720, bounds.Height);
            Require(frameWidth >= 300 && frameHeight >= 240, "INSUFFICIENT_TEST_SCREEN");

            int x = Math.Min(frameWidth / 3, frameWidth - 80);
            int y = Math.Min(frameHeight / 3, frameHeight - 70);
            using var marker = new Form
            {
                FormBorderStyle = FormBorderStyle.None,
                ShowInTaskbar = false,
                TopMost = true,
                BackColor = Color.FromArgb(14, 171, 219),
                StartPosition = FormStartPosition.Manual,
                Location = new Point(bounds.Left + x - 50, bounds.Top + y - 40),
                Size = new Size(100, 80)
            };
            marker.Paint += (_, e) => PaintFourColorWindow(e.Graphics, marker.ClientSize);
            marker.Show();
            marker.Activate();
            Application.DoEvents();
            Thread.Sleep(350);
            // The oracle is an independently captured 32x24 desktop rectangle
            // from a runner-owned WinForms window, not bytes manufactured by RFB.
            byte[]? oracle = null;
            Require(WaitUntil(() =>
            {
                try
                {
                    oracle = CaptureAndValidatePattern(bounds.Left + x - OracleWidth / 2,
                        bounds.Top + y - OracleHeight / 2);
                    return true;
                }
                catch { return false; }
            }, TimeSpan.FromSeconds(3)) && oracle is not null, "TEST_OWNED_WINDOW_PATTERN_ORACLE_MISMATCH");
            Console.WriteLine("TEST_OWNED_32x24_MULTICOLOR_WINDOW_ORACLE=PASS");

            Process? host = null;
            try
            {
                host = Process.Start(new ProcessStartInfo
                {
                    FileName = Path.GetFullPath(args[0]),
                    WorkingDirectory = Path.GetDirectoryName(Path.GetFullPath(args[0]))!,
                    UseShellExecute = false
                });
                Require(host is not null, "HOST_PROCESS_NOT_CREATED");
                IntPtr window = WaitForMainWindow(host!, TimeSpan.FromSeconds(8));
                Require(window != IntPtr.Zero && Caption(window) == HostTitle, "HOST_WINDOW_NOT_FOUND");
                ClickOwnedButton(host!, window, "Start local preview");
                Require(WaitUntil(IsPort5901BoundOnlyToIpv4Loopback, TimeSpan.FromSeconds(5)),
                    "PORT_5901_NOT_EXCLUSIVELY_LOOPBACK");
                Console.WriteLine("HOST_START_LOOPBACK_ONLY=PASS");

                using var client = new TcpClient { ReceiveTimeout = 5000, SendTimeout = 5000 };
                client.Connect(IPAddress.Loopback, 5901);
                using var stream = client.GetStream();
                Thread.Sleep(200);
                // A protocol byte or EOF before approval is a hard failure.
                Require(!client.Client.Poll(0, SelectMode.SelectRead), "RFB_BYTES_OR_EOF_BEFORE_APPROVAL");
                Console.WriteLine("PRECONSENT_RFB_BYTES=NONE");
                IntPtr dialog = WaitForOwnedWindow(host!, ApprovalTitle, TimeSpan.FromSeconds(8));
                Require(dialog != IntPtr.Zero, "CONSENT_DIALOG_NOT_FOUND");
                ClickOwnedButton(host!, dialog, "Approve");
                Console.WriteLine("CONSENT_CLICK=SYNTHETIC_CI_APPROVE");

                ValidateRawPattern(stream, x - OracleWidth / 2, y - OracleHeight / 2,
                    frameWidth, frameHeight, oracle!);
                Console.WriteLine("RFB_3_8_RAW_TEST_OWNED_32x24_WINDOW=PASS");

                ClickOwnedButton(host!, window, "Stop and revoke");
                Require(WaitUntil(() => !IsPort5901Listening(), TimeSpan.FromSeconds(5)),
                    "LISTENER_STILL_OPEN_AFTER_STOP");
                Require(PeerClosedAfterStop(stream), "RFB_PEER_STILL_OPEN_AFTER_STOP");
                Console.WriteLine("STOP_REVOKES_SESSION_AND_LISTENER=PASS");
                Console.WriteLine("HOSTED_RFB=PASS_SYNTHETIC_CI_VIEW_ONLY");
                return 0;
            }
            finally
            {
                // Only the process created by this test may be terminated.
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
                marker.Close();
            }
        }
        catch (ProbeFailure ex)
        {
            // Only fixed diagnostic codes authored below are emitted.
            Console.WriteLine($"HOSTED_RFB=FAIL_{ex.Code}");
            return 1;
        }
        catch (Exception ex)
        {
            // Exception type only. Never log clipboard, pixel bytes or desktop data.
            Console.WriteLine($"HOSTED_RFB=FAIL_{ex.GetType().Name}");
            return 1;
        }
    }

    private static bool IsExplicitHostedCi() =>
        Environment.GetEnvironmentVariable("GITHUB_ACTIONS") == "true" &&
        Environment.GetEnvironmentVariable("RUNNER_OS") == "Windows" &&
        Environment.GetEnvironmentVariable("RUNNER_ENVIRONMENT") == "github-hosted" &&
        Environment.GetEnvironmentVariable("GITHUB_REPOSITORY") == "thebrazenbeard/UnboundVNC" &&
        Environment.GetEnvironmentVariable("UNBOUNDVNC_CI_SYNTHETIC_CONSENT") == "explicit-runner-only";

    private static bool IsInteractiveDefaultConsole()
    {
        int session = Process.GetCurrentProcess().SessionId;
        uint console = WTSGetActiveConsoleSessionId();
        string station = ObjectName(GetProcessWindowStation());
        string desktop = ObjectName(GetThreadDesktop(GetCurrentThreadId()));
        IntPtr input = OpenInputDesktop(0, false, 1);
        string inputName = input == IntPtr.Zero ? "<unavailable>" : ObjectName(input);
        if (input != IntPtr.Zero) CloseDesktop(input);
        bool screen = Screen.PrimaryScreen?.Bounds is { Width: > 0, Height: > 0 };
        bool okay = Environment.UserInteractive && session > 0 && (uint)session == console &&
            station.Equals("WinSta0", StringComparison.OrdinalIgnoreCase) &&
            desktop == "Default" && inputName == "Default" && screen;
        Console.WriteLine($"RUNNER_INTERACTIVE_DEFAULT_CONSOLE={okay}");
        Console.WriteLine($"RUNNER_SESSION_ID={session}");
        Console.WriteLine($"ACTIVE_CONSOLE_SESSION_ID={console}");
        Console.WriteLine($"WINDOW_STATION={station}");
        Console.WriteLine($"INPUT_DESKTOP={inputName}");
        return okay;
    }

    private static void PaintFourColorWindow(Graphics graphics, Size size)
    {
        int halfWidth = size.Width / 2, halfHeight = size.Height / 2;
        var quadrants = new[]
        {
            new Rectangle(0, 0, halfWidth, halfHeight),
            new Rectangle(halfWidth, 0, size.Width - halfWidth, halfHeight),
            new Rectangle(0, halfHeight, halfWidth, size.Height - halfHeight),
            new Rectangle(halfWidth, halfHeight, size.Width - halfWidth, size.Height - halfHeight)
        };
        for (int i = 0; i < Pattern.Length; i++)
        {
            using var brush = new SolidBrush(Pattern[i]);
            graphics.FillRectangle(brush, quadrants[i]);
        }
    }

    private static byte[] CaptureAndValidatePattern(int screenX, int screenY)
    {
        using var bitmap = new Bitmap(OracleWidth, OracleHeight);
        using (var graphics = Graphics.FromImage(bitmap))
            graphics.CopyFromScreen(screenX, screenY, 0, 0, new Size(OracleWidth, OracleHeight));
        var oracle = new byte[OracleWidth * OracleHeight * 3];
        for (int y = 0; y < OracleHeight; y++)
        for (int x = 0; x < OracleWidth; x++)
        {
            Color expected = Pattern[(y < OracleHeight / 2 ? 0 : 2) +
                (x < OracleWidth / 2 ? 0 : 1)];
            Color actual = bitmap.GetPixel(x, y);
            Require(actual.R == expected.R && actual.G == expected.G && actual.B == expected.B,
                "WINDOW_PATTERN_PIXEL_MISMATCH");
            int offset = (y * OracleWidth + x) * 3;
            oracle[offset] = actual.B;
            oracle[offset + 1] = actual.G;
            oracle[offset + 2] = actual.R;
        }
        return oracle;
    }

    private static void ValidateRawPattern(NetworkStream stream, int x, int y,
        int maximumWidth, int maximumHeight, byte[] oracle)
    {
        Require(oracle.Length == OracleWidth * OracleHeight * 3, "BAD_TEST_ORACLE_LENGTH");
        var version = ReadExact(stream, 12);
        Require(version.SequenceEqual(Version), "WRONG_RFB_VERSION");
        stream.Write(Version);
        Require(ReadExact(stream, 2).SequenceEqual(new byte[] { 1, 1 }), "WRONG_SECURITY_OFFER");
        stream.WriteByte(1);
        Require(BinaryPrimitives.ReadUInt32BigEndian(ReadExact(stream, 4)) == 0, "SECURITY_NOT_ACCEPTED");
        stream.WriteByte(1); // ClientInit shared; the host remains single-client regardless.

        var size = ReadExact(stream, 4);
        int width = BinaryPrimitives.ReadUInt16BigEndian(size.AsSpan(0, 2));
        int height = BinaryPrimitives.ReadUInt16BigEndian(size.AsSpan(2, 2));
        Require(width == maximumWidth && height == maximumHeight, "WRONG_FRAMEBUFFER_BOUNDS");
        var format = ReadExact(stream, 16);
        Require(format.SequenceEqual(new byte[] { 32, 24, 0, 1, 0, 255, 0, 255,
            0, 255, 16, 8, 0, 0, 0, 0 }), "WRONG_PIXEL_FORMAT");
        uint nameLength = BinaryPrimitives.ReadUInt32BigEndian(ReadExact(stream, 4));
        Require(nameLength <= 512, "UNBOUNDED_RFB_NAME");
        _ = ReadExact(stream, (int)nameLength);

        byte[] request = { 3, 0, (byte)(x >> 8), (byte)x, (byte)(y >> 8), (byte)y,
            0, OracleWidth, 0, OracleHeight };
        stream.Write(request);
        Require(ReadExact(stream, 4).SequenceEqual(new byte[] { 0, 0, 0, 1 }),
            "INVALID_FRAMEBUFFER_UPDATE_HEADER");
        var rectangle = ReadExact(stream, 12);
        Require(BinaryPrimitives.ReadUInt16BigEndian(rectangle.AsSpan(0, 2)) == x &&
            BinaryPrimitives.ReadUInt16BigEndian(rectangle.AsSpan(2, 2)) == y &&
            BinaryPrimitives.ReadUInt16BigEndian(rectangle.AsSpan(4, 2)) == OracleWidth &&
            BinaryPrimitives.ReadUInt16BigEndian(rectangle.AsSpan(6, 2)) == OracleHeight &&
            BinaryPrimitives.ReadUInt32BigEndian(rectangle.AsSpan(8, 4)) == 0, "INVALID_RAW_RECTANGLE");
        var pixels = ReadExact(stream, OracleWidth * OracleHeight * 4);
        // Advertised 32bpp/24 depth little-endian true color: B,G,R,X.
        // Compare every one of 768 pixels with the independently captured
        // on-screen window oracle. Never log or persist either pixel buffer.
        for (int i = 0; i < OracleWidth * OracleHeight; i++)
            Require(pixels[i * 4] == oracle[i * 3] &&
                pixels[i * 4 + 1] == oracle[i * 3 + 1] &&
                pixels[i * 4 + 2] == oracle[i * 3 + 2], "RFB_WINDOW_PATTERN_MISMATCH");
    }

    private static byte[] ReadExact(Stream stream, int count)
    {
        var bytes = new byte[count];
        stream.ReadExactly(bytes);
        return bytes;
    }

    private static bool PeerClosedAfterStop(NetworkStream stream)
    {
        try { return stream.ReadByte() == -1; }
        catch (IOException ex) when (ex.InnerException is SocketException socket &&
            socket.SocketErrorCode is SocketError.ConnectionReset or SocketError.ConnectionAborted)
        { return true; }
    }

    private static bool IsPort5901Listening() =>
        IPGlobalProperties.GetIPGlobalProperties().GetActiveTcpListeners()
            .Any(endpoint => endpoint.Port == 5901);

    private static bool IsPort5901BoundOnlyToIpv4Loopback()
    {
        var listeners = IPGlobalProperties.GetIPGlobalProperties().GetActiveTcpListeners()
            .Where(endpoint => endpoint.Port == 5901).ToArray();
        return listeners.Length == 1 && listeners[0].Address.Equals(IPAddress.Loopback);
    }

    private static bool WaitUntil(Func<bool> predicate, TimeSpan maximum)
    {
        var end = DateTime.UtcNow + maximum;
        while (DateTime.UtcNow < end)
        {
            if (predicate()) return true;
            Thread.Sleep(75);
        }
        return predicate();
    }

    private static IntPtr WaitForMainWindow(Process host, TimeSpan timeout)
    {
        IntPtr result = IntPtr.Zero;
        _ = WaitUntil(() =>
        {
            if (host.HasExited) return false;
            host.Refresh();
            result = host.MainWindowHandle;
            return result != IntPtr.Zero;
        }, timeout);
        return result;
    }

    private static IntPtr WaitForOwnedWindow(Process host, string expected, TimeSpan timeout)
    {
        IntPtr window = IntPtr.Zero;
        _ = WaitUntil(() =>
        {
            if (host.HasExited) return false;
            _ = EnumWindows((candidate, _) =>
            {
                GetWindowThreadProcessId(candidate, out uint pid);
                if (pid == (uint)host.Id && Caption(candidate) == expected)
                {
                    window = candidate;
                    return false;
                }
                return true;
            }, IntPtr.Zero);
            return window != IntPtr.Zero;
        }, timeout);
        return window;
    }

    private static void ClickOwnedButton(Process host, IntPtr parent, string buttonCaption)
    {
        Require(!host.HasExited, "HOST_EXITED_BEFORE_BUTTON");
        GetWindowThreadProcessId(parent, out uint parentPid);
        Require(parentPid == (uint)host.Id, "UI_PARENT_NOT_TEST_CHILD");
        IntPtr button = IntPtr.Zero;
        _ = EnumChildWindows(parent, (candidate, _) =>
        {
            if (Caption(candidate) == buttonCaption)
            {
                button = candidate;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        Require(button != IntPtr.Zero, "EXPECTED_BUTTON_NOT_FOUND");
        GetWindowThreadProcessId(button, out uint buttonPid);
        Require(buttonPid == (uint)host.Id, "UI_BUTTON_NOT_TEST_CHILD");
        // BM_CLICK on a verified button owned by this test's own host child.
        // This is explicit synthetic CI approval, not SendInput/native RFB control.
        Require(SendMessageTimeout(button, 0x00F5, IntPtr.Zero, IntPtr.Zero,
            0x0002, 2000, out _) != IntPtr.Zero, "BUTTON_CLICK_TIMED_OUT");
    }

    private static string Caption(IntPtr hwnd)
    {
        var title = new StringBuilder(256);
        _ = GetWindowText(hwnd, title, title.Capacity);
        return title.ToString();
    }

    private static string ObjectName(IntPtr handle)
    {
        if (handle == IntPtr.Zero) return "<unavailable>";
        var name = new StringBuilder(128);
        return GetUserObjectInformationW(handle, 2, name,
            (uint)(name.Capacity * sizeof(char)), out _) ? name.ToString() : "<unavailable>";
    }

    private static void Require(bool condition, string message)
    {
        if (!condition) throw new ProbeFailure(message);
    }

    private sealed class ProbeFailure(string code) : Exception
    {
        internal string Code { get; } = code;
    }

    private delegate bool EnumWindowCallback(IntPtr hwnd, IntPtr state);
    [DllImport("kernel32.dll")] private static extern uint WTSGetActiveConsoleSessionId();
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] private static extern IntPtr GetProcessWindowStation();
    [DllImport("user32.dll")] private static extern IntPtr GetThreadDesktop(uint thread);
    [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll")] private static extern bool CloseDesktop(IntPtr handle);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetUserObjectInformationW(IntPtr handle, int index,
        StringBuilder buffer, uint length, out uint required);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int maxCount);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EnumWindows(EnumWindowCallback callback, IntPtr state);
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EnumChildWindows(IntPtr parent, EnumWindowCallback callback, IntPtr state);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint message, IntPtr wparam,
        IntPtr lparam, uint flags, uint timeoutMs, out IntPtr result);
}
