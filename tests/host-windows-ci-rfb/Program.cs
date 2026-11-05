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
    private static readonly Color[][] VisualStates =
    {
        new[] { Color.FromArgb(14, 171, 219), Color.FromArgb(219, 46, 88),
            Color.FromArgb(73, 210, 45), Color.FromArgb(189, 83, 222) },
        new[] { Color.FromArgb(248, 169, 44), Color.FromArgb(54, 93, 236),
            Color.FromArgb(20, 194, 172), Color.FromArgb(240, 55, 125) }
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
            int paintCallbacks = 0;
            Color[] activePattern = VisualStates[0];
            marker.Paint += (_, e) =>
            {
                paintCallbacks++;
                PaintFourColorWindow(e.Graphics, marker.ClientSize, activePattern);
            };
            marker.Show();
            marker.Activate();
            marker.Refresh(); // Force our Paint callback before the independent screen oracle.
            Application.DoEvents();
            Thread.Sleep(350);
            // Windows may enforce a minimum Form client width (136 on the
            // hosted runner despite Size=100). Use the *actual* painted client
            // center, not the requested geometry, for screen and RFB sampling.
            Point center = marker.PointToScreen(new Point(
                marker.ClientSize.Width / 2, marker.ClientSize.Height / 2));
            x = center.X - bounds.Left;
            y = center.Y - bounds.Top;
            Require(x >= OracleWidth / 2 && y >= OracleHeight / 2 &&
                x + OracleWidth / 2 <= frameWidth &&
                y + OracleHeight / 2 <= frameHeight, "TEST_OWNED_WINDOW_OUTSIDE_FRAMEBUFFER");
            // The oracle is an independently captured 32x24 desktop rectangle
            // from a runner-owned WinForms window, not bytes manufactured by RFB.
            byte[]? oracle = null;
            int[] quadrantMatches = new int[4];
            string captureFailureType = "NONE";
            bool oracleReady = WaitUntil(() =>
            {
                try
                {
                    marker.Refresh(); // No WinForms message pump runs while this STA polls.
                    oracle = CaptureAndValidatePattern(bounds.Left + x - OracleWidth / 2,
                        bounds.Top + y - OracleHeight / 2, quadrantMatches, activePattern);
                    return true;
                }
                catch (Exception ex) { captureFailureType = ex.GetType().Name; return false; }
            }, TimeSpan.FromSeconds(3));
            if (!oracleReady || oracle is null)
            {
                // Test-owned metadata only; never emit actual desktop pixels.
                Point actualCenter = marker.PointToScreen(new Point(
                    marker.ClientSize.Width / 2, marker.ClientSize.Height / 2));
                Console.WriteLine($"OWNED_WINDOW_PAINT_CALLBACKS={paintCallbacks}");
                Console.WriteLine($"OWNED_WINDOW_CLIENT_SIZE={marker.ClientSize.Width}x{marker.ClientSize.Height}");
                Console.WriteLine($"OWNED_WINDOW_CENTER_OFFSET={actualCenter.X - (bounds.Left + x)},{actualCenter.Y - (bounds.Top + y)}");
                Console.WriteLine($"OWNED_WINDOW_QUADRANT_MATCH_COUNTS={string.Join(",", quadrantMatches)}");
                Console.WriteLine($"OWNED_WINDOW_CAPTURE_FAILURE_TYPE={captureFailureType}");
            }
            Require(oracleReady && oracle is not null, "TEST_OWNED_WINDOW_PATTERN_ORACLE_MISMATCH");
            byte[] firstOracle = oracle!;
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

                // Keep the receive window small for a later bounded 3.6 MB
                // unconsumed Raw update; never expose the listener externally.
                using var client = new TcpClient { ReceiveTimeout = 5000,
                    SendTimeout = 5000, ReceiveBufferSize = 4096 };
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

                NegotiateRfbViewOnly(stream, frameWidth, frameHeight);
                int regionX = x - OracleWidth / 2, regionY = y - OracleHeight / 2;
                ValidateRawPatternRequest(stream, regionX, regionY, firstOracle);
                Console.WriteLine("RFB_3_8_RAW_TEST_OWNED_32x24_WINDOW_STATE_A=PASS");

                // Same host process, same approved RFB session, same rectangle.
                // A real test-owned window repaints; no client reconnect occurs.
                activePattern = VisualStates[1];
                marker.Refresh();
                byte[]? secondOracle = null;
                bool secondReady = WaitUntil(() =>
                {
                    try
                    {
                        marker.Refresh();
                        secondOracle = CaptureAndValidatePattern(bounds.Left + regionX,
                            bounds.Top + regionY, quadrantMatches, activePattern);
                        return true;
                    }
                    catch { return false; }
                }, TimeSpan.FromSeconds(3));
                Require(secondReady && secondOracle is not null, "SECOND_WINDOW_STATE_ORACLE_MISMATCH");
                byte[] second = secondOracle!;
                int changedPixels = 0;
                for (int i = 0; i < OracleWidth * OracleHeight; i++)
                    if (firstOracle[i * 3] != second[i * 3] ||
                        firstOracle[i * 3 + 1] != second[i * 3 + 1] ||
                        firstOracle[i * 3 + 2] != second[i * 3 + 2]) changedPixels++;
                Require(changedPixels == OracleWidth * OracleHeight, "SECOND_WINDOW_STATE_NOT_CHANGED");
                Console.WriteLine("SECOND_TEST_OWNED_32x24_MULTICOLOR_WINDOW_ORACLE=PASS");

                ValidateRawPatternRequest(stream, regionX, regionY, second);
                Console.WriteLine("SAME_RFB_SESSION_SECOND_RAW_32x24_CHANGED_PIXELS=PASS");

                // Exercise Stop while a larger framebuffer update is already
                // visible on the wire. Cover the *whole* requested frame with
                // our test-owned opaque window before allowing screen capture.
                marker.Bounds = new Rectangle(bounds.Left, bounds.Top, frameWidth, frameHeight);
                marker.BringToFront();
                marker.Refresh();
                int[] frameOwnershipMatches = new int[4];
                int framePaintAttempts = 0;
                // A WinForms Bounds setter can update ClientSize before DWM
                // presents the larger surface. The prior 1024px runner still
                // displayed the OLD 136x80 image: 2720=68*40 TL pixels matched.
                // Pump our own test window's paint/resize events and only
                // proceed once the ENTIRE actual on-screen image is ours.
                bool frameOwned = WaitUntil(() =>
                {
                    framePaintAttempts++;
                    Application.DoEvents();
                    marker.Invalidate(true);
                    marker.Update();
                    return TestOwnedWindowCoversFrame(marker, bounds, frameWidth,
                        frameHeight, activePattern, frameOwnershipMatches);
                }, TimeSpan.FromSeconds(4));
                if (!frameOwned)
                {
                    // Geometry and color-match counts only, never screen pixels.
                    Point origin = marker.PointToScreen(Point.Empty);
                    Console.WriteLine($"OWNED_FULL_FRAME_CLIENT_SIZE={marker.ClientSize.Width}x{marker.ClientSize.Height}");
                    Console.WriteLine($"OWNED_FULL_FRAME_ORIGIN_DELTA={origin.X - bounds.Left},{origin.Y - bounds.Top}");
                    Console.WriteLine($"OWNED_FULL_FRAME_QUADRANT_MATCH_COUNTS={string.Join(",", frameOwnershipMatches)}");
                    Console.WriteLine($"OWNED_FULL_FRAME_PAINT_ATTEMPTS={framePaintAttempts}");
                }
                Require(frameOwned, "FULL_FRAME_NOT_OWNED_BY_TEST_WINDOW");
                Console.WriteLine("OWNED_FULL_FRAME_EVERY_PIXEL=PASS");
                SendFullFrameUpdateRequest(stream, frameWidth, frameHeight);
                Require(ReadExact(stream, 4).SequenceEqual(new byte[] { 0, 0, 0, 1 }),
                    "LARGE_UPDATE_HEADER_INVALID");
                var largeRectangle = ReadExact(stream, 12);
                Require(BinaryPrimitives.ReadUInt16BigEndian(largeRectangle.AsSpan(0, 2)) == 0 &&
                    BinaryPrimitives.ReadUInt16BigEndian(largeRectangle.AsSpan(2, 2)) == 0 &&
                    BinaryPrimitives.ReadUInt16BigEndian(largeRectangle.AsSpan(4, 2)) == frameWidth &&
                    BinaryPrimitives.ReadUInt16BigEndian(largeRectangle.AsSpan(6, 2)) == frameHeight &&
                    BinaryPrimitives.ReadUInt32BigEndian(largeRectangle.AsSpan(8, 4)) == 0,
                    "LARGE_RAW_RECTANGLE_INVALID");
                Require(WaitUntil(() => client.Available > 0, TimeSpan.FromSeconds(3)),
                    "LARGE_RAW_PAYLOAD_NOT_IN_RECEIVE_BUFFER");
                Console.WriteLine("ACTIVE_LARGE_TEST_OWNED_RAW_UPDATE=OBSERVED_BEFORE_STOP");

                var stopTimer = Stopwatch.StartNew();
                ClickOwnedButton(host!, window, "Stop and revoke");
                Require(WaitUntil(() => !IsPort5901Listening(), TimeSpan.FromSeconds(3)),
                    "LISTENER_STILL_OPEN_AFTER_STOP");
                Require(stopTimer.Elapsed < TimeSpan.FromSeconds(4), "STOP_BLOCKED_BY_LARGE_SEND");
                Require(OnlyPriorFrameBufferThenClosed(stream, client, frameWidth, frameHeight),
                    "POST_STOP_NEW_FRAME_OR_UNBOUNDED_PEER");
                Console.WriteLine("POST_STOP_FRAMEBUFFER_REQUEST_DENIED=PASS");
                Console.WriteLine("STOP_DURING_LARGE_UNCONSUMED_FRAME=BOUNDED_TEARDOWN_PASS");
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

    private static void PaintFourColorWindow(Graphics graphics, Size size, Color[] pattern)
    {
        int halfWidth = size.Width / 2, halfHeight = size.Height / 2;
        var quadrants = new[]
        {
            new Rectangle(0, 0, halfWidth, halfHeight),
            new Rectangle(halfWidth, 0, size.Width - halfWidth, halfHeight),
            new Rectangle(0, halfHeight, halfWidth, size.Height - halfHeight),
            new Rectangle(halfWidth, halfHeight, size.Width - halfWidth, size.Height - halfHeight)
        };
        for (int i = 0; i < pattern.Length; i++)
        {
            using var brush = new SolidBrush(pattern[i]);
            graphics.FillRectangle(brush, quadrants[i]);
        }
    }

    private static byte[] CaptureAndValidatePattern(int screenX, int screenY,
        int[] quadrantMatches, Color[] pattern)
    {
        Array.Clear(quadrantMatches);
        using var bitmap = new Bitmap(OracleWidth, OracleHeight);
        using (var graphics = Graphics.FromImage(bitmap))
            graphics.CopyFromScreen(screenX, screenY, 0, 0, new Size(OracleWidth, OracleHeight));
        var oracle = new byte[OracleWidth * OracleHeight * 3];
        bool allExpected = true;
        for (int y = 0; y < OracleHeight; y++)
        for (int x = 0; x < OracleWidth; x++)
        {
            int quadrant = (y < OracleHeight / 2 ? 0 : 2) +
                (x < OracleWidth / 2 ? 0 : 1);
            Color expected = pattern[quadrant];
            Color actual = bitmap.GetPixel(x, y);
            if (actual.R == expected.R && actual.G == expected.G && actual.B == expected.B)
                quadrantMatches[quadrant]++;
            else allExpected = false;
            int offset = (y * OracleWidth + x) * 3;
            oracle[offset] = actual.B;
            oracle[offset + 1] = actual.G;
            oracle[offset + 2] = actual.R;
        }
        Require(allExpected, "WINDOW_PATTERN_PIXEL_MISMATCH");
        return oracle;
    }

    private static void NegotiateRfbViewOnly(NetworkStream stream,
        int maximumWidth, int maximumHeight)
    {
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
    }

    private static void ValidateRawPatternRequest(NetworkStream stream, int x, int y, byte[] oracle)
    {
        Require(oracle.Length == OracleWidth * OracleHeight * 3, "BAD_TEST_ORACLE_LENGTH");
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

    private static void SendFullFrameUpdateRequest(NetworkStream stream, int width, int height)
    {
        byte[] request = { 3, 0, 0, 0, 0, 0,
            (byte)(width >> 8), (byte)width, (byte)(height >> 8), (byte)height };
        stream.Write(request);
    }

    private static bool TestOwnedWindowCoversFrame(Form marker, Rectangle screen,
        int width, int height, Color[] pattern, int[] matches)
    {
        Array.Clear(matches);
        Point origin = marker.PointToScreen(Point.Empty);
        if (origin.X != screen.Left || origin.Y != screen.Top ||
            marker.ClientSize.Width < width || marker.ClientSize.Height < height) return false;
        // A four-point check could miss an unrelated overlay between samples.
        // Before ANY large RFB request, inspect EVERY on-screen pixel and
        // require only the known four test-owned colors, without logging them.
        using var bitmap = new Bitmap(width, height);
        using (var graphics = Graphics.FromImage(bitmap))
            graphics.CopyFromScreen(screen.Left, screen.Top, 0, 0, new Size(width, height));
        bool owned = true;
        for (int y = 0; y < height; y++)
        for (int x = 0; x < width; x++)
        {
            int quadrant = (y < marker.ClientSize.Height / 2 ? 0 : 2) +
                (x < marker.ClientSize.Width / 2 ? 0 : 1);
            Color actual = bitmap.GetPixel(x, y);
            Color expected = pattern[quadrant];
            if (actual.R == expected.R && actual.G == expected.G && actual.B == expected.B)
                matches[quadrant]++;
            else owned = false;
        }
        return owned;
    }

    private static bool OnlyPriorFrameBufferThenClosed(NetworkStream stream, TcpClient client,
        int width, int height)
    {
        // A partially sent Raw frame can already be in TCP buffers when Stop
        // wins. We can bound/drain those bytes, not retroactively erase them.
        // A new full update is requested AFTER Stop; no extra rectangle may
        // follow the at-most width*height*4 pending bytes of the prior frame.
        try { SendFullFrameUpdateRequest(stream, width, height); }
        catch (IOException) { return true; }
        catch (ObjectDisposedException) { return true; }
        int maximumPriorBytes = checked(width * height * 4);
        int observed = 0;
        var buffer = new byte[16 * 1024];
        var end = Stopwatch.StartNew();
        client.ReceiveTimeout = 500;
        while (end.Elapsed < TimeSpan.FromSeconds(8))
        {
            try
            {
                int count = stream.Read(buffer);
                if (count == 0) return true;
                observed += count;
                if (observed > maximumPriorBytes) return false;
            }
            catch (IOException ex) when (ex.InnerException is SocketException socket &&
                socket.SocketErrorCode == SocketError.TimedOut) { }
            catch (IOException ex) when (ex.InnerException is SocketException socket &&
                socket.SocketErrorCode is SocketError.ConnectionReset or SocketError.ConnectionAborted or SocketError.Shutdown)
            { return true; }
        }
        return false;
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
