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
    private long consentEpoch;

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
        state.Text = "Loopback 127.0.0.1:5901 only. Each connection requires your approval.";
        // Never capture screen pixels on the WinForms synchronization context.
        var token = lifetime.Token;
        // Retain the worker task; AcceptLoop catches unexpected failures and always tears down.
        acceptWorker = Task.Run(() => AcceptLoop(server, token));
    }

    private void Stop()
    {
        // Revocation becomes visible to the capture worker before socket shutdown.
        Interlocked.Increment(ref consentEpoch);
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
        Interlocked.Increment(ref consentEpoch);
        Volatile.Read(ref activeClient)?.Close();
        try
        {
            if (IsHandleCreated && !IsDisposed) BeginInvoke((Action)Stop);
        }
        catch (InvalidOperationException) { } // Window handle is closing.
        catch (ObjectDisposedException) { } // Window was disposed during dispatch.
    }

    private async Task AcceptLoop(TcpListener server, CancellationToken cancellation)
    {
        bool failed = false;
        try
        {
            while (!cancellation.IsCancellationRequested)
            {
                using var client = await server.AcceptTcpClientAsync(cancellation);
                // A single controller at a time, with no pending-session queue.
                if (activeClient is not null) continue;
                activeClient = client;
                try
                {
                    var offeredEpoch = Volatile.Read(ref consentEpoch);
                    if (!await ApproveConnection(cancellation).ConfigureAwait(false) ||
                        Volatile.Read(ref consentEpoch) != offeredEpoch) continue;
                    var authorizedEpoch = offeredEpoch;
                    using var session = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
                    session.CancelAfter(TimeSpan.FromMinutes(5));
                    await RfbSession.Run(client, session.Token,
                        () => !cancellation.IsCancellationRequested &&
                            Volatile.Read(ref consentEpoch) == authorizedEpoch).ConfigureAwait(false);
                }
                catch (Exception ex) when (ex is IOException or SocketException or OperationCanceledException or InvalidDataException or ObjectDisposedException or System.ComponentModel.Win32Exception)
                {
                    // Deliberately no frame, credential, clipboard or desktop data is logged.
                }
                finally { if (ReferenceEquals(activeClient, client)) activeClient = null; }
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

    private async Task<bool> ApproveConnection(CancellationToken token)
    {
        var result = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        Form? prompt = null;
        using var registration = token.Register(() =>
        {
            result.TrySetResult(false);
            try
            {
                if (IsHandleCreated && !IsDisposed)
                    BeginInvoke((Action)(() => { if (prompt is { IsDisposed: false }) prompt.Close(); }));
            }
            catch (InvalidOperationException) { /* Form closed while revoking. */ }
        });
        if (token.IsCancellationRequested || IsDisposed || !IsHandleCreated) return false;
        try
        {
            BeginInvoke((Action)(() =>
            {
                if (token.IsCancellationRequested || IsDisposed) { result.TrySetResult(false); return; }
                // Non-modal: the local Stop and revoke button remains operational.
                var dialog = new Form {
                    Text = "UnboundVNC | Approve local screen sharing",
                    Width = 510, Height = 190, StartPosition = FormStartPosition.CenterParent,
                    ShowInTaskbar = false, MinimizeBox = false, MaximizeBox = false
                };
                prompt = dialog;
                var warning = new Label {
                    Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleCenter,
                    Text = "Allow one view-only RFB session for at most five minutes?\n" +
                           "A listener is active on 127.0.0.1:5901 (loopback only).\n" +
                           "No keyboard, mouse, clipboard or unattended control is enabled."
                };
                var buttons = new FlowLayoutPanel {
                    Dock = DockStyle.Bottom, Height = 45, FlowDirection = FlowDirection.RightToLeft
                };
                var reject = new Button { Text = "Reject", Width = 110 };
                var approve = new Button { Text = "Approve", Width = 110 };
                reject.Click += (_, _) => { result.TrySetResult(false); dialog.Close(); };
                approve.Click += (_, _) => { result.TrySetResult(!token.IsCancellationRequested); dialog.Close(); };
                dialog.FormClosed += (_, _) => result.TrySetResult(false);
                buttons.Controls.Add(reject);
                buttons.Controls.Add(approve);
                dialog.Controls.Add(warning);
                dialog.Controls.Add(buttons);
                dialog.Show(this);
            }));
        }
        catch (InvalidOperationException) { result.TrySetResult(false); }
        return await result.Task.ConfigureAwait(false);
    }
}

internal static class RfbSession
{
    private static readonly byte[] Version = Encoding.ASCII.GetBytes("RFB 003.008\n");
    private static readonly byte[] PixelFormat = { 32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0 };
    private const int MaxWidth = 1280;
    private const int MaxHeight = 720;

    public static async Task Run(TcpClient client, CancellationToken token, Func<bool> stillAuthorized)
    {
        // Approval happens before this method, so no protocol or screen bytes are sent first.
        if (!stillAuthorized()) throw new OperationCanceledException("Local consent revoked");
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
        var name = Encoding.UTF8.GetBytes("UnboundVNC attended local preview (view only)");
        await WriteU32(stream, (uint)name.Length, token);
        await stream.WriteAsync(name, token);
        var scratch = new byte[20];
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
                case 4: // KeyEvent deliberately discarded; no unattended input.
                    await stream.ReadExactlyAsync(scratch.AsMemory(0, 7), token);
                    break;
                case 5: // PointerEvent deliberately discarded.
                    await stream.ReadExactlyAsync(scratch.AsMemory(0, 5), token);
                    break;
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
    private static bool IsDefaultInputDesktop()
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