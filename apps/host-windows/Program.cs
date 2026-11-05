using System.Buffers.Binary;
using System.Drawing.Imaging;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32;

namespace UnboundVnc.Host.Windows;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();
        Application.Run(new HostWindow());
    }
}

internal sealed class HostWindow : Form
{
    private readonly Button toggle = new() { Text = "Start local preview", Dock = DockStyle.Top, Height = 48 };
    private readonly Label state = new() { Text = "Stopped. No remote access.", Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleCenter };
    private TcpListener? listener;
    private CancellationTokenSource? lifetime;
    private TcpClient? activeClient;
    private Task? acceptWorker;
    private readonly ConsentEffectGate inputEffects = new();

    public HostWindow()
    {
        Text = "UnboundVNC | Attended Host Preview";
        Width = 420;
        Height = 180;
        Controls.Add(state);
        Controls.Add(toggle);
        toggle.Click += (_, _) => { if (listener is null) Start(); else Stop(); };
        SystemEvents.SessionSwitch += OnSessionSwitch;
        FormClosing += (_, _) => { Stop(); SystemEvents.SessionSwitch -= OnSessionSwitch; };
    }

    private void Start()
    {
        // This proof of concept must never expose RFB None authentication to a network.
        var server = new TcpListener(IPAddress.Loopback, 5901);
        try { server.Start(1); }
        catch (SocketException ex)
        {
            server.Stop();
            state.Text = $"Cannot start loopback listener on 127.0.0.1:5901 ({ex.SocketErrorCode}).";
            return;
        }
        listener = server;
        lifetime = new CancellationTokenSource();
        toggle.Text = "Stop and revoke";
        state.Text = "Loopback 127.0.0.1:5901. View only by default; control needs explicit approval.";
        // Never capture screen pixels on the WinForms synchronization context.
        var token = lifetime.Token;
        // Retain the worker task; AcceptLoop catches unexpected failures and always tears down.
        acceptWorker = Task.Run(() => AcceptLoop(server, token));
    }

    private void Stop()
    {
        // Revocation becomes visible to the capture worker before socket shutdown.
        inputEffects.Revoke();
        lifetime?.Cancel();
        activeClient?.Close();
        listener?.Stop();
        lifetime?.Dispose();
        lifetime = null;
        listener = null;
        activeClient = null;
        if (!IsDisposed)
        {
            toggle.Text = "Start local preview";
            state.Text = "Stopped. All connections revoked.";
        }
    }

    private void OnSessionSwitch(object sender, SessionSwitchEventArgs e)
    {
        if (e.Reason is not (SessionSwitchReason.SessionLock or SessionSwitchReason.ConsoleDisconnect or SessionSwitchReason.RemoteDisconnect))
            return;

        // Revoke before UI dispatch: a blocked UI thread must not keep a viewer authorized.
        inputEffects.Revoke();
        Volatile.Read(ref activeClient)?.Close();
        try
        {
            if (IsHandleCreated && !IsDisposed) BeginInvoke((Action)Stop);
        }
        catch (InvalidOperationException) { } // Window handle is closing.
    }

    private async Task AcceptLoop(TcpListener server, CancellationToken cancellation)
    {
        bool failed = false;
        try
        {
            while (!cancellation.IsCancellationRequested)
            {
                using var client = await server.AcceptTcpClientAsync(cancellation);
                // One accepted session at a time; Start(1) still has an OS backlog of one.
                if (activeClient is not null) continue;
                activeClient = client;
                try
                {
                    var offeredEpoch = inputEffects.Snapshot;
                    var consent = await PendingConsentMonitor.DecideWhileConnected(
                        client.Client, ApproveConnection, LocalInputConsent.Denied, cancellation)
                        .ConfigureAwait(false);
                    if (consent is not (LocalInputConsent.ViewOnly or LocalInputConsent.AllowControl) ||
                        inputEffects.Snapshot != offeredEpoch) continue;
                    var authorizedEpoch = offeredEpoch;
                    ShowSessionState(server, client, authorizedEpoch, consent == LocalInputConsent.AllowControl
                        ? "CONTROL approved for this session. Stop and revoke at any time."
                        : "View-only session approved. Stop and revoke at any time.");
                    using var session = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
                    session.CancelAfter(TimeSpan.FromMinutes(5));
                    using var expire = session.Token.Register(() =>
                    {
                        inputEffects.Revoke();
                        client.Close();
                    });
                    Func<NormalizedKey, bool>? keyInput = null;
                    Func<NormalizedPointer, byte, bool>? pointerInput = null;
                    if (consent == LocalInputConsent.AllowControl)
                    {
                        keyInput = key => inputEffects.TryEffect(authorizedEpoch, consent,
                            session.Token, RfbSession.IsDefaultInputDesktop,
                            () => NativeInputAdapter.TryInject(key));
                        pointerInput = (pointer, newlyPressed) => inputEffects.TryEffect(authorizedEpoch,
                            consent, session.Token, RfbSession.IsDefaultInputDesktop,
                            () => NativeInputAdapter.TryInject(pointer, newlyPressed));
                    }
                    await RfbSession.Run(client, session.Token,
                        () => !cancellation.IsCancellationRequested &&
                            inputEffects.Snapshot == authorizedEpoch,
                        keyInput, pointerInput).ConfigureAwait(false);
                }
                catch (Exception ex) when (ex is IOException or SocketException or OperationCanceledException or InvalidDataException or ObjectDisposedException or System.ComponentModel.Win32Exception)
                {
                    // Deliberately no frame, credential, clipboard or desktop data is logged.
                }
                finally
                {
                    inputEffects.Revoke();
                    if (ReferenceEquals(activeClient, client)) activeClient = null;
                    ShowSessionState(server, null, inputEffects.Snapshot,
                        "Loopback 127.0.0.1:5901. Waiting for local approval.");
                }
            }
        }
        catch (Exception ex) when (ex is OperationCanceledException or ObjectDisposedException or SocketException) { }
        catch (Exception)
        {
            // Unexpected worker failure: no screen, clipboard or credential data is logged.
            failed = true;
        }
        finally
        {
            server.Stop();
            // Conditional cleanup must not revoke a newer listener started after Stop().
            try
            {
                if (IsHandleCreated && !IsDisposed)
                    BeginInvoke((Action)(() =>
                    {
                        if (!ReferenceEquals(listener, server)) return;
                        Stop();
                        if (failed && !IsDisposed)
                            state.Text = "Local preview stopped after an internal error. Restart to retry.";
                    }));
            }
            catch (Exception ex) when (ex is InvalidOperationException or ObjectDisposedException) { }
        }
    }

    private void ShowSessionState(TcpListener server, TcpClient? client, long epoch, string message)
    {
        try
        {
            if (!IsHandleCreated || IsDisposed) return;
            BeginInvoke((Action)(() =>
            {
                if (IsDisposed || !ReferenceEquals(listener, server) ||
                    inputEffects.Snapshot != epoch || !ReferenceEquals(activeClient, client)) return;
                state.Text = message;
            }));
        }
        catch (InvalidOperationException) { /* Form closing. */ }
    }

    private async Task<LocalInputConsent> ApproveConnection(CancellationToken token)
    {
        var result = new TaskCompletionSource<LocalInputConsent>(TaskCreationOptions.RunContinuationsAsynchronously);
        Form? prompt = null;
        using var registration = token.Register(() =>
        {
            result.TrySetResult(LocalInputConsent.Denied);
            try
            {
                if (IsHandleCreated && !IsDisposed)
                    BeginInvoke((Action)(() => { if (prompt is { IsDisposed: false }) prompt.Close(); }));
            }
            catch (InvalidOperationException) { /* Form closed while revoking. */ }
        });
        if (token.IsCancellationRequested || IsDisposed || !IsHandleCreated) return LocalInputConsent.Denied;
        try
        {
            BeginInvoke((Action)(() =>
            {
                if (token.IsCancellationRequested || IsDisposed) { result.TrySetResult(LocalInputConsent.Denied); return; }
                // Non-modal: the local Stop and revoke button remains operational.
                var dialog = new Form {
                    Text = "UnboundVNC | Choose local sharing permission",
                    Width = 610, Height = 225, StartPosition = FormStartPosition.CenterParent,
                    ShowInTaskbar = false, MinimizeBox = false, MaximizeBox = false
                };
                prompt = dialog;
                var warning = new Label {
                    Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleCenter,
                    Text = "One attended session, at most five minutes. View only is the default.\n" +
                           "Allow control also permits basic typing and pointer movement/clicks.\n" +
                           "RFB None authentication is used ONLY on 127.0.0.1:5901.\n" +
                           "Never tunnel or expose this prototype. Stop and revoke remains available."
                };
                var buttons = new FlowLayoutPanel {
                    Dock = DockStyle.Bottom, Height = 50, FlowDirection = FlowDirection.RightToLeft
                };
                var reject = new Button { Text = "Reject", Width = 110 };
                var approve = new Button { Text = "Approve view only", Width = 140 };
                var control = new Button { Text = "Allow control", Width = 140 };
                reject.Click += (_, _) => { result.TrySetResult(LocalInputConsent.Denied); dialog.Close(); };
                approve.Click += (_, _) => { result.TrySetResult(token.IsCancellationRequested ?
                    LocalInputConsent.Denied : LocalInputConsent.ViewOnly); dialog.Close(); };
                control.Click += (_, _) => { result.TrySetResult(token.IsCancellationRequested ?
                    LocalInputConsent.Denied : LocalInputConsent.AllowControl); dialog.Close(); };
                dialog.FormClosed += (_, _) => result.TrySetResult(LocalInputConsent.Denied);
                buttons.Controls.Add(reject);
                buttons.Controls.Add(approve);
                buttons.Controls.Add(control);
                dialog.Controls.Add(warning);
                dialog.Controls.Add(buttons);
                dialog.AcceptButton = approve;
                dialog.Show(this);
            }));
        }
        catch (InvalidOperationException) { result.TrySetResult(LocalInputConsent.Denied); }
        return await result.Task.ConfigureAwait(false);
    }
}

internal static class RfbSession
{
    private static readonly byte[] Version = Encoding.ASCII.GetBytes("RFB 003.008\n");
    private static readonly byte[] PixelFormat = { 32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0 };
    private const int MaxWidth = 1280;
    private const int MaxHeight = 720;

    public static async Task Run(TcpClient client, CancellationToken token, Func<bool> stillAuthorized,
        Func<NormalizedKey, bool>? keyInput, Func<NormalizedPointer, byte, bool>? pointerInput)
    {
        // Approval happens before this method, so no protocol or screen bytes are sent first.
        if (!stillAuthorized()) throw new OperationCanceledException("Local consent revoked");
        if ((keyInput is null) != (pointerInput is null))
            throw new InvalidDataException("Inconsistent input consent");
        using var stream = client.GetStream();
        var desktop = Screen.PrimaryScreen?.Bounds ?? throw new InvalidDataException("No primary screen");
        int width = Math.Min(desktop.Width, MaxWidth), height = Math.Min(desktop.Height, MaxHeight);
        if (width < 1 || height < 1 || !IsDefaultInputDesktop()) throw new InvalidDataException("Desktop not shareable");
        await stream.WriteAsync(Version, token);
        var version = new byte[12];
        await stream.ReadExactlyAsync(version, token);
        if (!version.SequenceEqual(Version)) throw new InvalidDataException("Unsupported RFB version");
        await stream.WriteAsync(new byte[] { 1, 1 }, token); // None, safe only because TcpListener binds loopback.
        if (await ReadByte(stream, token) != 1) throw new InvalidDataException("Unsupported security choice");
        await WriteU32(stream, 0, token);
        _ = await ReadByte(stream, token); // ClientInit: shared flag; single-client mode regardless.
        await WriteU16(stream, (ushort)width, token);
        await WriteU16(stream, (ushort)height, token);
        await stream.WriteAsync(PixelFormat, token);
        var name = Encoding.UTF8.GetBytes(keyInput is null
            ? "UnboundVNC attended local preview (view only)"
            : "UnboundVNC attended local preview (basic local control)");
        await WriteU32(stream, (uint)name.Length, token);
        await stream.WriteAsync(name, token);
        var scratch = new byte[20];
        byte previousButtons = 0;
        while (true)
        {
            token.ThrowIfCancellationRequested();
            if (!stillAuthorized() || !IsDefaultInputDesktop())
                throw new OperationCanceledException("Consent revoked or desktop switched");
            switch (await ReadByte(stream, token))
            {
                case 0: // SetPixelFormat: only the advertised 32bpp little-endian truecolor format.
                    await stream.ReadExactlyAsync(scratch.AsMemory(0, 3), token);
                    await stream.ReadExactlyAsync(scratch.AsMemory(0, 16), token);
                    if (!scratch.AsSpan(0, 16).SequenceEqual(PixelFormat)) throw new InvalidDataException("Unsupported pixel format");
                    break;
                case 2: // SetEncodings: raw encoding is always available.
                    await stream.ReadExactlyAsync(scratch.AsMemory(0, 3), token);
                    int count = BinaryPrimitives.ReadUInt16BigEndian(scratch.AsSpan(1, 2));
                    if (count > 128) throw new InvalidDataException("Too many encodings");
                    for (int i = 0; i < count; i++) await stream.ReadExactlyAsync(scratch.AsMemory(0, 4), token);
                    break;
                case 3: // FramebufferUpdateRequest
                    await stream.ReadExactlyAsync(scratch.AsMemory(0, 9), token);
                    int x = BinaryPrimitives.ReadUInt16BigEndian(scratch.AsSpan(1, 2));
                    int y = BinaryPrimitives.ReadUInt16BigEndian(scratch.AsSpan(3, 2));
                    int w = BinaryPrimitives.ReadUInt16BigEndian(scratch.AsSpan(5, 2));
                    int h = BinaryPrimitives.ReadUInt16BigEndian(scratch.AsSpan(7, 2));
                    if (w < 1 || h < 1 || x + w > width || y + h > height || !IsDefaultInputDesktop())
                        throw new InvalidDataException("Unsafe framebuffer request or desktop switch");
                    await SendRawRectangle(stream, desktop.Left + x, desktop.Top + y, x, y, w, h, token, stillAuthorized);
                    await Task.Delay(100, token).ConfigureAwait(false); // Bound client-driven capture to at most 10 frames/s.
                    break;
                case 4: // KeyEvent: default view-only; control requires explicit host approval.
                {
                    await stream.ReadExactlyAsync(scratch.AsMemory(0, 7), token);
                    if (keyInput is not null)
                    {
                        if (!ExperimentalInputPolicy.TryParseKey(scratch.AsSpan(0, 7), out var key))
                            throw new InvalidDataException("Unsupported or malformed keyboard event");
                        // One-shot press/release; never retain a remote-held key.
                        if (key.Down && !keyInput(key))
                            throw new OperationCanceledException("Input permission revoked or injection failed");
                        if (key.Down) await Task.Delay(20, token).ConfigureAwait(false); // <=50 taps/s.
                    }
                    break;
                }
                case 5: // PointerEvent: default view-only; control is bounded to preview.
                {
                    await stream.ReadExactlyAsync(scratch.AsMemory(0, 5), token);
                    if (pointerInput is not null)
                    {
                        if (!ExperimentalInputPolicy.TryParsePointer(scratch.AsSpan(0, 5), width, height,
                                desktop.Left, desktop.Top, out var pointer))
                            throw new InvalidDataException("Unsupported or unsafe pointer event");
                        byte newlyPressed = (byte)(pointer.Buttons & ~previousButtons);
                        // Click on rising edge only; no drag or persistent remote button hold.
                        if (!pointerInput(pointer, newlyPressed))
                            throw new OperationCanceledException("Input permission revoked or injection failed");
                        previousButtons = pointer.Buttons;
                        await Task.Delay(20, token).ConfigureAwait(false); // <=50 pointer events/s.
                    }
                    break;
                }
                case 6: // ClientCutText deliberately discarded with bounded size.
                    await stream.ReadExactlyAsync(scratch.AsMemory(0, 7), token);
                    uint length = BinaryPrimitives.ReadUInt32BigEndian(scratch.AsSpan(3, 4));
                    if (length > 65536) throw new InvalidDataException("Clipboard payload too large");
                    while (length > 0)
                    {
                        int chunk = (int)Math.Min(length, (uint)scratch.Length);
                        await stream.ReadExactlyAsync(scratch.AsMemory(0, chunk), token);
                        length -= (uint)chunk;
                    }
                    break;
                default: throw new InvalidDataException("Unknown RFB client message");
            }
        }
    }

    private static async Task SendRawRectangle(NetworkStream stream, int sourceX, int sourceY, int x, int y, int w, int h, CancellationToken token, Func<bool> stillAuthorized)
    {
        using var frame = new Bitmap(w, h, PixelFormat32bppArgb);
        using (var graphics = Graphics.FromImage(frame)) graphics.CopyFromScreen(sourceX, sourceY, 0, 0, new Size(w, h));
        var bytes = new byte[checked(w * h * 4)];
        var locked = frame.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat32bppArgb);
        try
        {
            for (int row = 0; row < h; row++)
                Marshal.Copy(IntPtr.Add(locked.Scan0, row * locked.Stride), bytes, row * w * 4, w * 4);
        }
        finally { frame.UnlockBits(locked); }
        // Never transmit a captured frame after revocation or an input-desktop change.
        token.ThrowIfCancellationRequested();
        if (!stillAuthorized() || !IsDefaultInputDesktop())
            throw new OperationCanceledException("Consent revoked or desktop switched during capture");
        // Header: one raw-encoded rectangle; bytes in little-endian B,G,R,A order.
        await stream.WriteAsync(new byte[] { 0, 0, 0, 1 }, token);
        await WriteU16(stream, (ushort)x, token);
        await WriteU16(stream, (ushort)y, token);
        await WriteU16(stream, (ushort)w, token);
        await WriteU16(stream, (ushort)h, token);
        await WriteU32(stream, 0, token);
        await stream.WriteAsync(bytes, token);
    }

    private const PixelFormat PixelFormat32bppArgb = System.Drawing.Imaging.PixelFormat.Format32bppArgb;
    private static async Task<int> ReadByte(NetworkStream s, CancellationToken ct)
    {
        var one = new byte[1];
        await s.ReadExactlyAsync(one, ct);
        return one[0];
    }
    private static async Task WriteU16(NetworkStream s, ushort v, CancellationToken ct)
    {
        var bytes = new byte[2]; BinaryPrimitives.WriteUInt16BigEndian(bytes, v); await s.WriteAsync(bytes, ct);
    }
    private static async Task WriteU32(NetworkStream s, uint v, CancellationToken ct)
    {
        var bytes = new byte[4]; BinaryPrimitives.WriteUInt32BigEndian(bytes, v); await s.WriteAsync(bytes, ct);
    }

    // Winlogon, lock and UAC secure desktops must never be treated as ordinary capture targets.
    [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll", EntryPoint = "GetUserObjectInformationW", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool GetUserObjectInformationW(IntPtr obj, int index, StringBuilder? buffer, uint length, out uint required);
    [DllImport("user32.dll")] private static extern bool CloseDesktop(IntPtr handle);
    internal static bool IsDefaultInputDesktop()
    {
        const uint DesktopReadObjects = 0x0001;
        var handle = OpenInputDesktop(0, false, DesktopReadObjects);
        if (handle == IntPtr.Zero) return false;
        try
        {
            var name = new StringBuilder(128);
            return GetUserObjectInformationW(handle, 2, name, 128 * sizeof(char), out _) && name.ToString() == "Default";
        }
        finally { CloseDesktop(handle); }
    }
}
