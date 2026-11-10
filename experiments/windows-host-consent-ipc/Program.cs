using System.Buffers.Binary;
using System.Diagnostics;
using System.IO.Pipes;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Win32.SafeHandles;

// ISOLATED TEST EXECUTABLE ONLY. No production host or Go gateway references it.
// It proves a CurrentUserOnly pipe is NOT enough to authenticate a tsnet edge:
// an unrelated child process with the same Windows user can send a forged peer.
if (args.Length == 2 && args[0] == "--same-user-forger")
{
    await SendForgedRequest(args[1]);
    return;
}
if (args.Length != 0 || !OperatingSystem.IsWindows())
    throw new InvalidOperationException("Windows-only isolated falsifier with no supplied arguments.");

var forged = new ConsentRequest("nFAKETAILNETPEER", "nFAKEWINDOWSHOST",
    Convert.ToBase64String(new byte[32]).TrimEnd('=').Replace('+', '-').Replace('/', '_'), "view-only");
var intended = new ConsentRequest("nALLOWEDPEER", "nFAKEWINDOWSHOST",
    Convert.ToBase64String(Enumerable.Repeat((byte)7, 32).ToArray()).TrimEnd('=').Replace('+', '-').Replace('/', '_'), "view-only");
var issued = DateTimeOffset.UtcNow;
var nominalLease = new HypotheticalLease(intended, 42, issued, issued.AddMinutes(5),
    Process.GetCurrentProcess().SessionId, false);
var nominalUi = new UiSnapshot(Process.GetCurrentProcess().SessionId, true, true, false, 42);

Check("positive control: matching hypothetical lease is structurally valid, not an approval",
    LeaseModel.Retains(intended, nominalLease, nominalUi, issued.AddSeconds(5)));
Check("different peer cannot reuse a hypothetical grant",
    !LeaseModel.Retains(intended with { PeerNodeID = forged.PeerNodeID }, nominalLease, nominalUi, issued.AddSeconds(5)));
Check("different host cannot reuse a hypothetical grant",
    !LeaseModel.Retains(intended with { HostNodeID = "nOTHER" }, nominalLease, nominalUi, issued.AddSeconds(5)));
Check("a new nonce rejects replay of an earlier grant",
    !LeaseModel.Retains(intended with { SessionID = forged.SessionID }, nominalLease, nominalUi, issued.AddSeconds(5)));
Check("control scope cannot be promoted from view-only",
    !LeaseModel.Retains(intended with { Scope = "allow-control" }, nominalLease, nominalUi, issued.AddSeconds(5)));
Check("stale consent epoch rejects after Stop",
    !LeaseModel.Retains(intended, nominalLease, nominalUi with { Epoch = 43 }, issued.AddSeconds(5)));
Check("expired and overlong leases reject",
    !LeaseModel.Retains(intended, nominalLease, nominalUi, issued.AddMinutes(5)) &&
    !LeaseModel.Retains(intended, nominalLease with { ExpiresAt = issued.AddMinutes(6) },
        nominalUi, issued.AddSeconds(5)));
Check("revoked lease rejects",
    !LeaseModel.Retains(intended, nominalLease with { Revoked = true }, nominalUi, issued.AddSeconds(5)));
Check("lock, UAC desktop and noninteractive session reject",
    !LeaseModel.Retains(intended, nominalLease, nominalUi with { Locked = true }, issued.AddSeconds(5)) &&
    !LeaseModel.Retains(intended, nominalLease, nominalUi with { DefaultDesktop = false }, issued.AddSeconds(5)) &&
    !LeaseModel.Retains(intended, nominalLease, nominalUi with { UserInteractive = false }, issued.AddSeconds(5)));
Check("Windows user-session switch rejects",
    !LeaseModel.Retains(intended, nominalLease, nominalUi with { UiSessionId = -1 }, issued.AddSeconds(5)));
Check("no trusted route bootstrap means zero grants, even for nominal shape",
    !DisabledIssuer.TryIssue(intended, out _) && !DisabledIssuer.TryIssue(forged, out _));

using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(20));
string pipeName = $"UnboundVncFalsifier-{Guid.NewGuid():N}";
using var server = new NamedPipeServerStream(pipeName, PipeDirection.InOut, 1,
    PipeTransmissionMode.Byte, PipeOptions.CurrentUserOnly | PipeOptions.Asynchronous);
var childCommand = new ProcessStartInfo("dotnet") { UseShellExecute = false, CreateNoWindow = true };
childCommand.ArgumentList.Add(Assembly.GetExecutingAssembly().Location);
childCommand.ArgumentList.Add("--same-user-forger");
childCommand.ArgumentList.Add(pipeName);
using var child = Process.Start(childCommand) ?? throw new InvalidOperationException("Could not launch test-owned forger.");
await server.WaitForConnectionAsync(deadline.Token);
Check("untrusted same-user child connects to CurrentUserOnly pipe", server.IsConnected);

byte[] header = new byte[2];
await server.ReadExactlyAsync(header, deadline.Token);
int length = BinaryPrimitives.ReadUInt16BigEndian(header);
Check("bounded IPC frame", length is > 0 and <= 512);
byte[] data = new byte[length];
await server.ReadExactlyAsync(data, deadline.Token);
var received = JsonSerializer.Deserialize<ConsentRequest>(data)
    ?? throw new InvalidOperationException("Missing forged request.");
Check("different-process forged stable peer reaches pipe transport", received == forged);
Check("client PID is separate from host test process",
    NativePipeEvidence.GetNamedPipeClientProcessId(server.SafePipeHandle, out uint peerPid) &&
    peerPid == (uint)child.Id && peerPid != (uint)Environment.ProcessId);

string? serverUserSid = WindowsIdentity.GetCurrent().User?.Value;
string? connectedUserSid = null;
server.RunAsClient(() => connectedUserSid = WindowsIdentity.GetCurrent().User?.Value);
Check("OS identifies forged caller as same Windows user",
    !string.IsNullOrEmpty(serverUserSid) && connectedUserSid == serverUserSid);
Check("forged peer never obtains a consent grant", !DisabledIssuer.TryIssue(received, out _));
await server.WriteAsync(new byte[] { 0 }); // Explicit denial; keep client connected through SID inspection.
await server.FlushAsync(deadline.Token);
await child.WaitForExitAsync(deadline.Token);
Check("test-owned child exits normally", child.ExitCode == 0);

// READ-ONLY diagnostic; a hosted runner's UI state is not proof of a live
// human-attended Windows 10/11 host. No UI is shown or approved here.
Console.WriteLine($"WINDOWS_SESSION_DIAGNOSTIC_NONZERO={Process.GetCurrentProcess().SessionId > 0}");
Console.WriteLine($"WINDOWS_SESSION_DIAGNOSTIC_USER_INTERACTIVE={Environment.UserInteractive}");
Console.WriteLine("SAME_USER_PIPE_FORGED_ID_ACCEPTED_AT_TRANSPORT=PASS");
Console.WriteLine("TRUSTED_HOST_GRANTS=0");
Console.WriteLine("PASS: default-OFF Windows named-pipe caller-authentication falsifier");

static async Task SendForgedRequest(string pipeName)
{
    using var client = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut,
        PipeOptions.Asynchronous, TokenImpersonationLevel.Impersonation);
    await client.ConnectAsync(5000);
    var payload = new ConsentRequest("nFAKETAILNETPEER", "nFAKEWINDOWSHOST",
        Convert.ToBase64String(new byte[32]).TrimEnd('=').Replace('+', '-').Replace('/', '_'), "view-only");
    byte[] json = JsonSerializer.SerializeToUtf8Bytes(payload);
    if (json.Length is < 1 or > 512) throw new InvalidOperationException("Oversized test fixture.");
    byte[] header = new byte[2];
    BinaryPrimitives.WriteUInt16BigEndian(header, checked((ushort)json.Length));
    await client.WriteAsync(header);
    await client.WriteAsync(json);
    await client.FlushAsync();
    byte[] decision = new byte[1];
    await client.ReadExactlyAsync(decision);
    if (decision[0] != 0) throw new InvalidOperationException("Unexpected grant from disabled server.");
}

static void Check(string name, bool condition)
{
    if (!condition) throw new InvalidOperationException("FAIL: " + name);
    Console.WriteLine("PASS: " + name);
}

internal sealed record ConsentRequest(string PeerNodeID, string HostNodeID, string SessionID, string Scope);
internal sealed record HypotheticalLease(ConsentRequest Request, long Epoch, DateTimeOffset IssuedAt,
    DateTimeOffset ExpiresAt, int UiSessionId, bool Revoked);
internal sealed record UiSnapshot(int UiSessionId, bool UserInteractive, bool DefaultDesktop, bool Locked, long Epoch);

// Retention predicate ONLY, assuming a grant somehow came from a separately
// authenticated human UI issuer. No issuer exists in this experiment.
internal static class LeaseModel
{
    private static readonly Regex StableId = new("^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$", RegexOptions.CultureInvariant);
    internal static bool Retains(ConsentRequest request, HypotheticalLease lease, UiSnapshot ui,
        DateTimeOffset now)
    {
        if (request != lease.Request || request.Scope != "view-only" ||
            !StableId.IsMatch(request.PeerNodeID) || !StableId.IsMatch(request.HostNodeID) ||
            !ValidNonce(request.SessionID) || lease.Revoked ||
            !ui.UserInteractive || !ui.DefaultDesktop || ui.Locked || ui.UiSessionId < 1 ||
            ui.UiSessionId != lease.UiSessionId || ui.Epoch != lease.Epoch ||
            lease.ExpiresAt <= now || lease.IssuedAt > now ||
            lease.ExpiresAt > lease.IssuedAt.AddMinutes(5)) return false;
        return true;
    }

    private static bool ValidNonce(string text)
    {
        if (text.Length != 43 || text.Any(c => !(char.IsAsciiLetterOrDigit(c) || c is '-' or '_')))
            return false;
        try { return Convert.FromBase64String(text.Replace('-', '+').Replace('_', '/') + "=").Length == 32; }
        catch (FormatException) { return false; }
    }
}

internal static class DisabledIssuer
{
    // Do not add an "Enabled" toggle here. The trusted route process identity,
    // Windows UI approval and authenticated gateway handoff do not exist.
    internal static bool TryIssue(ConsentRequest request, out HypotheticalLease? lease)
    {
        lease = null;
        return false;
    }
}

internal static class NativePipeEvidence
{
    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe, out uint clientProcessId);
}
