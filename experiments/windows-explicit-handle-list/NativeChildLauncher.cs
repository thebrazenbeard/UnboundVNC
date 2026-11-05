using System.ComponentModel;
using System.Globalization;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;

// TEST-ONLY PInvoke. Do not reuse as a production service/tsnet launcher.
// It intentionally supports both unsafe inherit-all and per-child handle list
// so hosted Windows can falsify the difference with real kernel behavior.
internal static class NativeChildLauncher
{
    private const uint CreateNoWindow = 0x08000000;
    private const uint ExtendedStartupInfoPresent = 0x00080000;
    private static readonly IntPtr HandleListAttribute = new(0x00020002);

    internal static IntPtr ParseHandle(string text)
    {
        if (!long.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out long value) || value <= 0)
            throw new InvalidOperationException("Test anonymous client handle is not numeric.");
        return new IntPtr(value);
    }

    internal static bool IsLive(string text)
        => GetHandleInformation(ParseHandle(text), out _);

    internal static NativeTestChild StartInheritAll(params string[] arguments)
    {
        var start = new StartupInfoEx { StartupInfo = new StartupInfo { cb = Marshal.SizeOf<StartupInfo>() } };
        return CreateChild(ref start, CreateNoWindow, arguments);
    }

    internal static NativeTestChild StartRestricted(IntPtr[] handles, params string[] arguments)
    {
        if (handles.Length < 1 || handles.Any(h => h == IntPtr.Zero))
            throw new ArgumentException("Explicit test handle list cannot be empty/invalid.");
        IntPtr size = IntPtr.Zero;
        _ = InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size); // probe required allocation
        if (size == IntPtr.Zero) throw LastError("attribute-list sizing");

        IntPtr list = Marshal.AllocHGlobal(size);
        IntPtr array = Marshal.AllocHGlobal(checked(handles.Length * IntPtr.Size));
        bool initialized = false;
        try
        {
            for (int i = 0; i < handles.Length; i++)
                Marshal.WriteIntPtr(array, i * IntPtr.Size, handles[i]);
            if (!InitializeProcThreadAttributeList(list, 1, 0, ref size))
                throw LastError("attribute-list initialization");
            initialized = true;
            if (!UpdateProcThreadAttribute(list, 0, HandleListAttribute, array,
                    new IntPtr(handles.Length * IntPtr.Size), IntPtr.Zero, IntPtr.Zero))
                throw LastError("explicit inherited-handle list");
            var start = new StartupInfoEx
            {
                StartupInfo = new StartupInfo { cb = Marshal.SizeOf<StartupInfoEx>() },
                AttributeList = list
            };
            return CreateChild(ref start, CreateNoWindow | ExtendedStartupInfoPresent, arguments);
        }
        finally
        {
            if (initialized) DeleteProcThreadAttributeList(list);
            Marshal.FreeHGlobal(array);
            Marshal.FreeHGlobal(list);
        }
    }

    private static NativeTestChild CreateChild(ref StartupInfoEx startup, uint flags, string[] arguments)
    {
        string executable = Environment.ProcessPath
            ?? throw new InvalidOperationException("No current executable path.");
        var parts = new List<string> { executable };
        if (Path.GetFileName(executable).Equals("dotnet.exe", StringComparison.OrdinalIgnoreCase))
            parts.Add(Assembly.GetExecutingAssembly().Location);
        parts.AddRange(arguments);
        // Paths cannot contain a double-quote on Windows; test arguments are
        // fixed ASCII mode names and decimal handles, never user data.
        var command = new StringBuilder(string.Join(" ", parts.Select(a => $"\"{a}\"")));
        if (!CreateProcessW(executable, command, IntPtr.Zero, IntPtr.Zero,
                true, flags, IntPtr.Zero, null, ref startup, out var info))
            throw LastError("CreateProcessW test child");
        CloseHandle(info.ThreadHandle);
        return new NativeTestChild(info.ProcessHandle, info.ProcessId);
    }

    private static Win32Exception LastError(string phase)
        => new(Marshal.GetLastWin32Error(), "Win32 " + phase + " failed");

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo
    {
        public int cb;
        [MarshalAs(UnmanagedType.LPWStr)] public string? Reserved;
        [MarshalAs(UnmanagedType.LPWStr)] public string? Desktop;
        [MarshalAs(UnmanagedType.LPWStr)] public string? Title;
        public int X, Y, XSize, YSize, XCountChars, YCountChars, FillAttribute, Flags;
        public ushort ShowWindow, Reserved2;
        public IntPtr Reserved2Ptr;
        public IntPtr StdInput, StdOutput, StdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfoEx
    {
        public StartupInfo StartupInfo;
        public IntPtr AttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInfo
    {
        public IntPtr ProcessHandle, ThreadHandle;
        public uint ProcessId, ThreadId;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute,
        IntPtr value, IntPtr valueSize, IntPtr previousValue, IntPtr returnSize);

    [DllImport("kernel32.dll")]
    private static extern void DeleteProcThreadAttributeList(IntPtr list);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "CreateProcessW")]
    private static extern bool CreateProcessW(string application, StringBuilder commandLine,
        IntPtr processAttributes, IntPtr threadAttributes, [MarshalAs(UnmanagedType.Bool)] bool inheritHandles,
        uint creationFlags, IntPtr environment, string? currentDirectory,
        ref StartupInfoEx startup, out ProcessInfo info);

    [DllImport("kernel32.dll")]
    internal static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetHandleInformation(IntPtr handle, out uint flags);
}

internal sealed class NativeTestChild : IDisposable
{
    private readonly IntPtr process;
    internal readonly uint Pid;
    internal NativeTestChild(IntPtr process, uint pid) { this.process = process; Pid = pid; }

    internal uint WaitExit()
    {
        uint wait = WaitForSingleObject(process, 10000);
        if (wait != 0 || !GetExitCodeProcess(process, out uint code))
            throw new Win32Exception(Marshal.GetLastWin32Error(), $"Test child {Pid} did not exit within bound; wait={wait}");
        return code;
    }

    public void Dispose()
    {
        // Only this experiment's exact created process handle can be stopped.
        if (GetExitCodeProcess(process, out uint code) && code == 259)
        {
            _ = TerminateProcess(process, 99);
            _ = WaitForSingleObject(process, 2000);
        }
        _ = NativeChildLauncher.CloseHandle(process);
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint timeoutMs);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr handle, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr handle, uint code);
}
