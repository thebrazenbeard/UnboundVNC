using System.Collections.Concurrent;
using System.Drawing;

namespace UnboundVnc.Host.Windows;

/// <summary>
/// Temporary test-owned target for end-to-end RFB input plumbing. This creates its
/// OWN temporary WinForms window; no browser, Firefox, desktop, or foreign
/// window input is supported. No SendInput/PostMessage/native injection.
/// </summary>
internal sealed partial class HostWindow
{
    private readonly AttendedControlLease testLease = new();
    private readonly Button testInputButton = new()
    {
        Text = "Allow TEST input (owned form only)",
        Dock = DockStyle.Top,
        Height = 42,
        Enabled = false
    };
    private readonly ConcurrentQueue<NormalizedKey> testKeyQueue = new();
    private readonly ConcurrentQueue<NormalizedPointer> testPointerQueue = new();
    private readonly System.Windows.Forms.Timer testInputTimer = new() { Interval = 65 };
    private Form? testInputWindow;
    private TextBox? testOutput;
    private Label? testPointerLabel;
    private long controlSessionEpoch;
    private long activeTestEpoch = long.MinValue;
    private readonly object testQueueSync = new();

    private void InitializeTestInput()
    {
        Width = 520;
        Height = 240;
        Controls.Add(testInputButton);
        Controls.SetChildIndex(toggle, 0);
        testInputButton.Click += (_, _) => ArmTestInputForOwnedWindow();
        testInputTimer.Tick += (_, _) => DrainTestInput();
        testInputTimer.Start();
        FormClosing += (_, _) =>
        {
            testInputTimer.Stop();
            testInputTimer.Dispose();
        };
    }

    // Called on WinForms UI thread ONLY after the original view-only approval.
    private void SetTestInputAvailable(long controlEpoch)
    {
        if (IsDisposed || listener is null || Volatile.Read(ref activeClient) is null)
            return;
        Interlocked.Exchange(ref activeTestEpoch, controlEpoch);
        testInputButton.Enabled = true;
        state.Text = "VIEW ONLY active. Separate TEST input approval is available locally.";
    }

    // An explicit second on-host click; never called by the RFB peer.
    private void ArmTestInputForOwnedWindow()
    {
        long epoch = Interlocked.Read(ref activeTestEpoch);
        if (epoch < 1 || listener is null || Volatile.Read(ref activeClient) is null ||
            testInputWindow is not null || IsDisposed)
            return;

        var test = new Form
        {
            Text = "UnboundVNC | Synthetic input target",
            Width = 480,
            Height = 215,
            StartPosition = FormStartPosition.Manual,
            Location = new Point(90, 90),
            FormBorderStyle = FormBorderStyle.FixedSingle,
            MaximizeBox = false
        };
        var typed = new TextBox
        {
            Dock = DockStyle.Top,
            ReadOnly = true,
            MaxLength = 64,
            AccessibleName = "Synthetic received RFB key events"
        };
        var info = new Label
        {
            Dock = DockStyle.Fill,
            TextAlign = ContentAlignment.MiddleCenter,
            Text = "TEST-OWNED WINDOW ONLY. No OS/native keyboard or mouse injection.\n" +
                   "This form shows accepted RFB events; it cannot edit any Firefox chat."
        };
        var pointer = new Label
        {
            Dock = DockStyle.Bottom,
            Height = 27,
            Text = "No synthetic pointer events."
        };
        // Separate host-owned HWND with the SAME PID for the wrong-window test.
        // It receives no input permission. Source-matched test UI may focus it;
        // this is NOT a way to select arbitrary Firefox windows.
        var wrongTarget = new Button
        {
            Text = "Focus alternate synthetic window",
            Dock = DockStyle.Bottom,
            Height = 31
        };
        wrongTarget.Click += (_, _) =>
        {
            var alternative = new Form
            {
                Text = "UnboundVNC | Alternate synthetic target",
                Width = 330,
                Height = 150,
                StartPosition = FormStartPosition.Manual,
                Location = new Point(750, 95),
                ShowInTaskbar = false,
                FormBorderStyle = FormBorderStyle.FixedSingle,
                MaximizeBox = false
            };
            alternative.Controls.Add(new Label
            {
                Dock = DockStyle.Fill,
                Text = "Wrong-window negative control. This window has NO RFB input lease.",
                TextAlign = ContentAlignment.MiddleCenter
            });
            alternative.Show(test);
            alternative.Activate();
        };
        test.Controls.Add(wrongTarget);
        test.Controls.Add(info);
        test.Controls.Add(pointer);
        test.Controls.Add(typed);
        testInputWindow = test;
        testOutput = typed;
        testPointerLabel = pointer;
        test.FormClosed += (_, _) =>
        {
            testLease.Revoke();
            ClearTestQueue();
            testInputWindow = null;
            testOutput = null;
            testPointerLabel = null;
        };
        test.Show(this);
        var target = new ControlTarget(test.Handle, Environment.ProcessId,
            test.Bounds, "SYNTHETIC_TEST_OWNED_WINDOW");
        if (!testLease.Grant(LocalInputConsent.AllowControl, target,
                epoch, DateTimeOffset.UtcNow.AddMinutes(2)))
        {
            test.Close();
            state.Text = "TEST input grant refused; view-only remains.";
            return;
        }

        testInputButton.Enabled = false;
        state.Text = "TEST WINDOW ONLY input armed for <= 2 min. Stop immediately revokes.";
        test.Activate();
        typed.Focus();
    }

    // Fast bounded callbacks run under the lease's same Stop/revoke lock.
    // They queue only in-process SYNTHETIC data, not OS/native input.
    private bool EnqueueTestKey(NormalizedKey key)
    {
        lock (testQueueSync)
        {
            if (testKeyQueue.Count + testPointerQueue.Count >= 32) return false;
            testKeyQueue.Enqueue(key);
            return true;
        }
    }

    private bool EnqueueTestPointer(NormalizedPointer pointer)
    {
        lock (testQueueSync)
        {
            if (testKeyQueue.Count + testPointerQueue.Count >= 32) return false;
            testPointerQueue.Enqueue(pointer);
            return true;
        }
    }

    private bool TryTakeTestKey(out NormalizedKey key)
    {
        lock (testQueueSync) return testKeyQueue.TryDequeue(out key);
    }

    private bool TryTakeTestPointer(out NormalizedPointer pointer)
    {
        lock (testQueueSync) return testPointerQueue.TryDequeue(out pointer);
    }

    // Timer and Stop both execute on the SAME WinForms UI thread. Stop revokes
    // before clearing queued events. No UI effect may be applied after Stop ACK.
    private void DrainTestInput()
    {
        if (testInputWindow is not { IsDisposed: false } ||
            testOutput is not { IsDisposed: false } ||
            testPointerLabel is not { IsDisposed: false })
        {
            ClearTestQueue();
            return;
        }
        long epoch = Interlocked.Read(ref activeTestEpoch);
        if (!testLease.IsCurrent(TrustedControlObservation.Capture(
                epoch, listener is not null && Volatile.Read(ref activeClient) is not null)))
        {
            ClearTestQueue();
            return;
        }

        for (int i = 0; i < 32; i++)
        {
            if (!TryTakeTestKey(out var key)) break;
            // Atomic currentness+application: Revoke cannot return between
            // this check and the WinForms text update on the host UI thread.
            if (!testLease.TryApplyWhileCurrent(
                    TrustedControlObservation.Capture(
                        epoch, listener is not null && Volatile.Read(ref activeClient) is not null),
                    () =>
                    {
                        if (key.Down && testOutput.TextLength < 64)
                            testOutput.AppendText(key.Character.ToString());
                    }))
            {
                ClearTestQueue();
                break;
            }
        }
        for (int i = 0; i < 32; i++)
        {
            if (!TryTakeTestPointer(out var pointer)) break;
            if (!testLease.TryApplyWhileCurrent(
                    TrustedControlObservation.Capture(
                        epoch, listener is not null && Volatile.Read(ref activeClient) is not null),
                    () => testPointerLabel.Text =
                        $"Synthetic RFB pointer: {pointer.ScreenX},{pointer.ScreenY} buttons={pointer.Buttons}"))
            {
                ClearTestQueue();
                break;
            }
        }
    }

    private void ClearTestQueue()
    {
        lock (testQueueSync)
        {
            while (testKeyQueue.TryDequeue(out _)) { }
            while (testPointerQueue.TryDequeue(out _)) { }
        }
    }

    private void RevokeTestInput()
    {
        testLease.Revoke();
        Interlocked.Exchange(ref activeTestEpoch, long.MinValue);
        ClearTestQueue();
        try
        {
            if (IsHandleCreated && !IsDisposed)
                BeginInvoke((Action)(() =>
                {
                    testInputButton.Enabled = false;
                    if (testInputWindow is { IsDisposed: false })
                        testInputWindow.Close();
                }));
        }
        catch (InvalidOperationException) { }
    }
}