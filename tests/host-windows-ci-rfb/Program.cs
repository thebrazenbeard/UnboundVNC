using System.Buffers.Binary;
using System.Diagnostics;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;

namespace UnboundVnc.HostedRfbSyntheticConsent;

// This opt-in integration test is restricted to an ephemeral GitHub-hosted
// Windows runner. BM_CLICK is deliberate CI automation, NEVER human consent.
internal static class Program
{
    private static void VerifyPostConsentHostProof(NetworkStream stream, byte[] key)
    {
        byte[] marker = ReadExact(stream, 5);
        Require(Encoding.ASCII.GetString(marker) == "UVNC1", "WRONG_HOST_PROOF_MARKER");
        byte[] challenge = RandomNumberGenerator.GetBytes(32);
        stream.Write(challenge);
        byte[] answer = ReadExact(stream, 32);
        byte[] expected = HMACSHA256.HashData(key,
            Encoding.ASCII.GetBytes("UNBOUNDVNC-ATTENDED-RFB-PROOF-v1:")
                .Concat(challenge).ToArray());
        Require(CryptographicOperations.FixedTimeEquals(answer, expected),
            "WRONG_HOST_PROOF_RESPONSE");
        CryptographicOperations.ZeroMemory(challenge);
        CryptographicOperations.ZeroMemory(expected);
        CryptographicOperations.ZeroMemory(answer);
    }

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

            // Disposable CI-only key; the real host still requires a per-launch binding.
            byte[] hostProofKey = RandomNumberGenerator.GetBytes(32);
            string hostProofEncoded = Convert.ToBase64String(hostProofKey)
                .TrimEnd('=').Replace('+', '-').Replace('/', '_');
            Process? host = null;
            try
            {
                host = Process.Start(new ProcessStartInfo
                {
                    FileName = Path.GetFullPath(args[0]),
                    WorkingDirectory = Path.GetDirectoryName(Path.GetFullPath(args[0]))!,
                    UseShellExecute = false,
                    Environment = { ["UNBOUNDVNC_ATTENDED_SESSION_KEY"] = hostProofEncoded }
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

                VerifyPostConsentHostProof(stream, hostProofKey);
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
                // The earlier TOPMOST framebuffer test marker overlaps part
                // of the later native input target on hosted runner geometry.
                // Hide only this disposable CI-owned window for pointer tests.
                marker.TopMost = false;
                marker.Hide();
                // Two separate source-matched synthetic CI clicks are TEST automation,
                // never evidence of a human granting OS input rights.
                // Unarmed key event 'z' must have NO GUI effect.
                stream.Write(new byte[] { 4, 1, 0, 0, 0, 0, 0, 122 });
                ClickOwnedButton(host!, window, "Allow TEST input (owned form only)");
                IntPtr testInput = WaitForOwnedWindow(host!,
                    "UnboundVNC | Synthetic input target", TimeSpan.FromSeconds(5));
                Require(testInput != IntPtr.Zero, "HOST_OWNED_TEST_INPUT_FORM_MISSING");
                Console.WriteLine("SECOND_SYNTHETIC_CI_CONTROL_CLICK=NOT_HUMAN");

                // The old view-only connection may already contain z. The
                // source-matched host MUST NOT upgrade buffered KeyEvents.
                // Instead only a fresh nonce received AFTER the local test
                // grant can establish this test-owned input epoch.
                WriteClientCutText(stream, "UNBOUNDVNC_TEST_CONTROL_REQUEST_V1");
                string challengeText = ReadServerCutText(stream);
                const string challengePrefix="UNBOUNDVNC_TEST_CONTROL_CHALLENGE_V1:";
                Require(challengeText.StartsWith(challengePrefix, StringComparison.Ordinal) &&
                    challengeText.Length == challengePrefix.Length + 43,
                    "CONTROL_CHALLENGE_NOT_POSTGRANT");
                // Postchallenge but pre-echo b must also stay blocked.
                stream.Write(new byte[] { 4, 1, 0, 0, 0, 0, 0, 98 });
                WriteClientCutText(stream, "UNBOUNDVNC_TEST_CONTROL_RESPONSE_V1:"+
                    challengeText[challengePrefix.Length..]);
                Console.WriteLine("POSTGRANT_CONTROL_FENCE_CHALLENGE_CONFIRMED=TEST_ONLY");
                // Enter must remain prohibited. Only lower-case a may append to
                // the exact local test form. This is NOT global/native injection.
                stream.Write(new byte[] { 4, 1, 0, 0, 0, 0, 0xff, 0x0d });
                stream.Write(new byte[] { 4, 1, 0, 0, 0, 0, 0, 97 });
                stream.Write(new byte[] { 4, 0, 0, 0, 0, 0, 0, 97 });
                bool matchedSyntheticInput = WaitUntil(
                    () => ReadOnlyOwnedTestEdit(host!, testInput) == "a",
                    TimeSpan.FromSeconds(6));
                if (!matchedSyntheticInput)
                {
                    // Only disposable host-test metadata, no private pixels or text.
                    var syntheticText = ReadOnlyOwnedTestEdit(host!, testInput);
                    IntPtr actualForeground = GetForegroundWindow();
                    GetWindowThreadProcessId(actualForeground, out uint foregroundPid);
                    Console.WriteLine($"SYNTHETIC_FORM_FOREGROUND_MATCH={actualForeground == testInput}");
                    Console.WriteLine($"SYNTHETIC_FOREGROUND_OWNED_BY_TEST_HOST={foregroundPid == (uint)host!.Id}");
                    Console.WriteLine($"SYNTHETIC_TEST_EDIT_FOUND={syntheticText is not null}");
                    Console.WriteLine($"SYNTHETIC_TEST_EDIT_LENGTH={syntheticText?.Length ?? -1}");
                }
                Require(matchedSyntheticInput,
                    "RFBCONTROL_TEST_OWNED_TEXTBOX_DID_NOT_EQUAL_A");
                Console.WriteLine("RFB_TEST_OWNED_FORM_KEY_A_ONLY=PASS");

                // THIRD, separate automation-only TEST-form approval activates
                // the *actual* Windows SendInput adapter. Synthetic AppendText
                // is disabled in this mode, so only a real OS key event can
                // update the host-owned editable TextBox.
                ClickOwnedButton(host!, testInput,
                    "Enable NATIVE input (OWNED TEST FORM ONLY)");
                Require(ReadOnlyOwnedTestEdit(host!, testInput) == "",
                    "NATIVE_TEST_FIELD_NOT_CLEARED_ON_APPROVAL");
                stream.Write(new byte[] { 4, 1, 0, 0, 0, 0, 0, 97 }); // 'a' down
                var nativeRelease = new byte[] { 4, 0, 0, 0, 0, 0, 0, 97 }; // RFB KeyEvent: 8 bytes
                Require(nativeRelease.Length == 8, "RFB_KEY_RELEASE_WRONG_LENGTH");
                stream.Write(nativeRelease);
                bool typedNative = WaitUntil(
                    () => ReadOnlyOwnedTestEdit(host!, testInput) == "a",
                    TimeSpan.FromSeconds(6));
                Require(typedNative, "WIN32_NATIVE_RFB_KEY_NOT_OBSERVED");
                Console.WriteLine("RFB_WIN32_SENDINPUT_KEY_A=PASS_TEST_FORM_ONLY");

                // A real RFB pointer event must arrive at a separate
                // host-owned button; BM_CLICK is used only for approval, not
                // for this effect. Exact target and dimensions are observed
                // from Windows HWND state, not the remote client's assertions.
                IntPtr nativeButton = FindOwnedChildButton(host!, testInput,
                    "NATIVE RFB pointer click target");
                Require(GetWindowRect(nativeButton, out var nativeBounds),
                    "NATIVE_POINTER_BUTTON_BOUNDS_MISSING");
                int px = (nativeBounds.Left + nativeBounds.Right) / 2 - bounds.Left;
                int py = (nativeBounds.Top + nativeBounds.Bottom) / 2 - bounds.Top;
                Require(px is >= 1 and < 1280 && py is >= 1 and < 720,
                    "NATIVE_POINTER_OUTSIDE_TEST_FRAME");
                // Independent BEFORE-input Windows hit-test prevents treating
                // a misplaced or occluded target as an injection failure.
                var intendedScreenPoint = new Point(bounds.Left + px, bounds.Top + py);
                Console.WriteLine($"NATIVE_POINTER_PREFLIGHT_HWND_VALID={IsWindow(nativeButton)}");
                Console.WriteLine($"NATIVE_POINTER_PREFLIGHT_ENABLED={IsWindowEnabled(nativeButton)}");
                Console.WriteLine($"NATIVE_POINTER_PREFLIGHT_HIT={WindowFromPoint(intendedScreenPoint) == nativeButton}");
                Console.WriteLine($"NATIVE_POINTER_PREFLIGHT_FOREGROUND={GetForegroundWindow() == testInput}");
                Require(IsWindow(nativeButton) && IsWindowEnabled(nativeButton) &&
                    WindowFromPoint(intendedScreenPoint) == nativeButton &&
                    GetForegroundWindow() == testInput, "NATIVE_POINTER_PREFLIGHT_NOT_OWNED");
                Require(!HasOwnedChildText(host!, testInput, "NATIVE_RFB_CLICK_COUNT=1"),
                    "NATIVE_POINTER_EFFECT_PREEXISTED_BEFORE_RFB");
                stream.Write(new byte[] { 5, 1, (byte)(px>>8), (byte)px,
                    (byte)(py>>8), (byte)py });
                stream.Write(new byte[] { 5, 0, (byte)(px>>8), (byte)px,
                    (byte)(py>>8), (byte)py });
                // Diagnostic only, on disposable runner: determine if the
                // native cursor moved to the intended owned point at all.
                Thread.Sleep(180);
                _ = GetCursorPos(out var immediateCursor);
                Console.WriteLine($"NATIVE_POINTER_180MS_DELTA={immediateCursor.X - intendedScreenPoint.X},{immediateCursor.Y - intendedScreenPoint.Y}");
                Console.WriteLine($"NATIVE_POINTER_180MS_TEST_FORM_ALIVE={IsWindow(testInput)}");
                Console.WriteLine($"NATIVE_POINTER_180MS_TARGET_ALIVE={IsWindow(nativeButton)}");
                Console.WriteLine($"NATIVE_POINTER_180MS_FOREGROUND_IS_TEST={GetForegroundWindow() == testInput}");
                // Only exact source-defined test status labels can be read.
                foreach (int stage in new[] {0,1,2,3,4,10,11,12,13})
                    if (HasOwnedChildText(host!, window, "TEST_NATIVE_POINTER_REVOKED_STAGE="+stage))
                        Console.WriteLine($"NATIVE_POINTER_HOST_REVOKED_STAGE={stage}");
                Console.WriteLine($"NATIVE_POINTER_HOST_STOPPED={HasOwnedChildText(host!, window, "Stopped. All connections revoked.")}");
                Console.WriteLine($"NATIVE_POINTER_HOST_INTERNAL_ERROR={HasOwnedChildText(host!, window, "Local preview stopped after an internal error. Restart to retry.")}");
                Console.WriteLine($"NATIVE_POINTER_HOST_ACTIVE_STATE={HasOwnedChildText(host!, window, "NATIVE TEST INPUT ONLY (owned form). Stop immediately revokes. No Firefox permission.")}");
                Console.WriteLine($"NATIVE_POINTER_PORT_5901={IsPort5901Listening()}");
                Console.WriteLine($"NATIVE_POINTER_CLIENT_CAN_READ={client.Client.Poll(0, SelectMode.SelectRead)}");
                Console.WriteLine($"NATIVE_POINTER_CLIENT_AVAILABLE={client.Available}");
                foreach (string exitKind in new[] { "IOException", "SocketException",
                    "OperationCanceledException", "InvalidDataException", "INVALID_TYPE",
                    "UNSAFE_FRAME", "PIXEL_FORMAT", "CLIPBOARD_SIZE", "ENCODING_COUNT", "OTHER_INVALID_DATA",
                    "ObjectDisposedException", "Win32Exception", "NONE",
                    "UNEXPECTED_InvalidOperationException", "UNEXPECTED_ArgumentException" })
                    if (HasOwnedChildText(host!, window, "TEST_RFB_EXIT="+exitKind))
                        Console.WriteLine($"NATIVE_POINTER_RFB_EXIT={exitKind}");
                for (int type = 0; type < 256; type++)
                    for (int preceding = -1; preceding <= 6; preceding++)
                        if (HasOwnedChildText(host!, window,
                                "TEST_RFB_EXIT=CI_UNKNOWN_TYPE_"+type+"_AFTER_"+preceding))
                            Console.WriteLine($"NATIVE_POINTER_UNKNOWN_RFB_TYPE={type};PREVIOUS_TYPE={preceding}");
                // A WinForms button may recreate its HWND when disabled.
                // A stale pre-click HWND is NOT a valid native-effect receipt.
                // Instead independently inspect the TEST FORM OWNED, visible
                // click-handler label. The only path to this label in the host
                // is the real WinForms button Click handler, not BM_CLICK or
                // a model-asserted result.
                bool clickedNative = WaitUntil(
                    () => HasOwnedChildText(host!, testInput, "NATIVE_RFB_CLICK_COUNT=1"),
                    TimeSpan.FromSeconds(6));
                if (!clickedNative)
                {
                    var screenPoint = new Point(bounds.Left + px, bounds.Top + py);
                    var hitWindow = WindowFromPoint(screenPoint);
                    var foreground = GetForegroundWindow();
                    _ = GetCursorPos(out var cursorPosition);
                    Console.WriteLine($"NATIVE_POINTER_HIT_EQUALS_TARGET={hitWindow == nativeButton}");
                    Console.WriteLine($"NATIVE_POINTER_FOREGROUND_EQUALS_TEST_FORM={foreground == testInput}");
                    Console.WriteLine($"NATIVE_POINTER_CURSOR_EQUALS_TARGET={Math.Abs(cursorPosition.X - screenPoint.X) <= 2 && Math.Abs(cursorPosition.Y - screenPoint.Y) <= 2}");
                    Console.WriteLine($"NATIVE_POINTER_BUTTON_HWND_VALID={IsWindow(nativeButton)}");
                    Console.WriteLine($"NATIVE_POINTER_BUTTON_ENABLED={IsWindowEnabled(nativeButton)}");
                    Console.WriteLine($"NATIVE_POINTER_BUTTON_SPAN={nativeBounds.Right-nativeBounds.Left}x{nativeBounds.Bottom-nativeBounds.Top}");
                    Console.WriteLine($"NATIVE_POINTER_HOST_EXITED={host!.HasExited}");
                }
                Require(clickedNative, "WIN32_NATIVE_RFB_POINTER_NOT_OBSERVED");
                Console.WriteLine("RFB_WIN32_SENDINPUT_POINTER_CLICK=PASS_TEST_FORM_ONLY");


                // The alternative is a same-PID but DIFFERENT HWND. Its RFB
                // input is not within the approved target and cannot modify a.
                ClickOwnedButton(host!, testInput, "Focus alternate synthetic window");
                IntPtr otherInput = WaitForOwnedWindow(host!,
                    "UnboundVNC | Alternate synthetic target", TimeSpan.FromSeconds(5));
                Require(otherInput != IntPtr.Zero, "TEST_OTHER_OWNED_WINDOW_MISSING");
                stream.Write(new byte[] { 4, 1, 0, 0, 0, 0, 0, 98 });
                Thread.Sleep(350);
                Require(ReadOnlyOwnedTestEdit(host!, testInput) == "a",
                    "RFB_WRONG_WINDOW_KEY_CHANGED_OWNED_TEXTBOX");
                Console.WriteLine("RFB_SAME_PID_WRONG_HWND_INPUT_REFUSED=PASS");


                // Exercise Stop while a larger framebuffer update is already
                // visible on the wire. Cover the *whole* requested frame with
                // our test-owned opaque window before allowing screen capture.
                marker.Show();
                marker.TopMost = true;
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

    private static void WriteClientCutText(NetworkStream stream, string command)
    {
        var contents = Encoding.ASCII.GetBytes(command);
        Require(contents.Length <= 128, "UNBOUNDED_TEST_CONTROL_PAYLOAD");
        var packet = new byte[8 + contents.Length];
        packet[0] = 6; // ordinary ClientCutText, reserved test-only payload
        BinaryPrimitives.WriteUInt32BigEndian(packet.AsSpan(4, 4), (uint)contents.Length);
        contents.CopyTo(packet.AsSpan(8));
        stream.Write(packet);
    }

    private static string ReadServerCutText(NetworkStream stream)
    {
        byte[] header = ReadExact(stream, 8);
        Require(header[0] == 3 && header[1] == 0 && header[2] == 0 &&
            header[3] == 0, "UNEXPECTED_CONTROL_SERVER_MESSAGE");
        uint count = BinaryPrimitives.ReadUInt32BigEndian(header.AsSpan(4, 4));
        Require(count is > 0 and <= 128, "INVALID_CONTROL_CHALLENGE_SIZE");
        return Encoding.ASCII.GetString(ReadExact(stream, (int)count));
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


    private static IntPtr FindOwnedChildButton(Process host, IntPtr parent, string exactCaption)
    {
        Require(!host.HasExited, "HOST_EXITED_BEFORE_NATIVE_CHILD_LOOKUP");
        GetWindowThreadProcessId(parent, out uint owner);
        Require(owner == (uint)host.Id, "FOREIGN_NATIVE_PARENT_DENIED");
        IntPtr selected = IntPtr.Zero;
        _ = EnumChildWindows(parent, (candidate, _) =>
        {
            if (Caption(candidate) == exactCaption)
            {
                GetWindowThreadProcessId(candidate, out uint candidateOwner);
                if (candidateOwner == owner)
                {
                    selected = candidate;
                    return false;
                }
            }
            return true;
        }, IntPtr.Zero);
        Require(selected != IntPtr.Zero, "NATIVE_TARGET_NOT_SOURCE_OWNED");
        return selected;
    }

    private static bool HasOwnedChildText(Process host, IntPtr parent, string exactCaption)
    {
        if (host.HasExited) return false;
        GetWindowThreadProcessId(parent, out uint owner);
        if (owner != (uint)host.Id) return false;
        bool found = false;
        _ = EnumChildWindows(parent, (candidate, _) =>
        {
            GetWindowThreadProcessId(candidate, out uint pid);
            if (pid == owner && Caption(candidate) == exactCaption)
            {
                found = true;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return found;
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

    private static string? ReadOnlyOwnedTestEdit(Process host, IntPtr parent)
    {
        // This source-owned test HWND and PID must match our disposable host.
        // This helper never reads any real desktop/browser input or text.
        GetWindowThreadProcessId(parent, out uint owner);
        Require(owner == (uint)host.Id && Caption(parent) == "UnboundVNC | Synthetic input target",
            "TEST_CONTROL_READ_TARGET_MISMATCH");
        IntPtr edit = IntPtr.Zero;
        _ = EnumChildWindows(parent, (candidate, _) =>
        {
            GetWindowThreadProcessId(candidate, out uint pid);
            var className = new StringBuilder(120);
            _ = GetClassName(candidate, className, className.Capacity);
            if (pid == owner && className.ToString().Contains("EDIT", StringComparison.OrdinalIgnoreCase))
            {
                edit = candidate;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        if (edit == IntPtr.Zero) return null;
        var result = new StringBuilder(100);
        return SendMessageTimeoutText(edit, 0x000D, (IntPtr)result.Capacity,
            result, 0x0002, 1000, out _) == IntPtr.Zero ? null : result.ToString();
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


    [StructLayout(LayoutKind.Sequential)]
    private struct WinRect
    {
        public int Left, Top, Right, Bottom;
    }

    [DllImport("user32.dll", EntryPoint = "GetWindowRect")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetWindowRect(IntPtr hwnd, out WinRect rect);

    [StructLayout(LayoutKind.Sequential)]
    private struct WinPoint
    {
        public int X, Y;
    }

    [DllImport("user32.dll", EntryPoint = "IsWindow")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll", EntryPoint = "IsWindowEnabled")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindowEnabled(IntPtr hwnd);
    [DllImport("user32.dll", EntryPoint = "WindowFromPoint")]
    private static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll", EntryPoint = "GetCursorPos")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetCursorPos(out WinPoint point);
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
    [DllImport("user32.dll", EntryPoint = "GetClassNameW", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hwnd, StringBuilder text, int maxCount);
    [DllImport("user32.dll", EntryPoint = "SendMessageTimeoutW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr SendMessageTimeoutText(IntPtr hwnd, uint message, IntPtr wparam,
        StringBuilder lparam, uint flags, uint timeoutMs, out IntPtr result);
    [DllImport("user32.dll", EntryPoint = "GetForegroundWindow")]
    private static extern IntPtr GetForegroundWindow();
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
