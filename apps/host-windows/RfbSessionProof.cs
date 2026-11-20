using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace UnboundVnc.Host.Windows;

/// <summary>
/// Per-launch local-viewer proof: only after the WinForms consent dialog
/// approves may the host emit its UVNC1 marker, receive a fresh 32-byte
/// gateway challenge, and prove the ephemeral launcher-owned key.
/// The marker and proof are gateway-local and never forwarded to noVNC.
/// </summary>
internal static class RfbSessionProof
{
    internal const string EnvironmentKey = "UNBOUNDVNC_ATTENDED_SESSION_KEY";
    internal const string Domain = "UNBOUNDVNC-ATTENDED-RFB-PROOF-v1:";
    private static readonly byte[] Marker = Encoding.ASCII.GetBytes("UVNC1");
    private static readonly byte[] DomainBytes = Encoding.ASCII.GetBytes(Domain);

    internal static string EncodeKey(ReadOnlySpan<byte> key)
    {
        if (key.Length != 32) throw new FormatException("Session key must be 32 random bytes");
        return Convert.ToBase64String(key).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    }

    internal static byte[] ParseKey(string? encoded)
    {
        if (encoded is null || encoded.Length != 43 ||
            !Regex.IsMatch(encoded, @"\A[A-Za-z0-9_-]{43}\z", RegexOptions.CultureInvariant))
            throw new FormatException("Invalid attended key encoding");
        try
        {
            var key = Convert.FromBase64String(
                encoded.Replace('-', '+').Replace('_', '/') + "=");
            if (key.Length != 32 || EncodeKey(key) != encoded)
                throw new FormatException("Noncanonical attended key");
            return key;
        }
        catch (FormatException)
        {
            throw new FormatException("Invalid attended key encoding");
        }
    }

    internal static byte[] ComputeResponse(byte[] key, byte[] challenge)
    {
        if (key is null || key.Length != 32 || challenge is null || challenge.Length != 32)
            throw new ArgumentException("Attended proof requires exact key and challenge");
        var message = new byte[DomainBytes.Length + challenge.Length];
        DomainBytes.CopyTo(message, 0);
        challenge.CopyTo(message, DomainBytes.Length);
        try { return HMACSHA256.HashData(key, message); }
        finally { CryptographicOperations.ZeroMemory(message); }
    }

    internal static async Task ProveAsync(Stream stream, byte[] key, CancellationToken token)
    {
        if (key is null || key.Length != 32)
            throw new InvalidDataException("Missing attended session proof key");
        // Called only after the host's explicit per-connection approval.
        await stream.WriteAsync(Marker, token);
        var challenge = new byte[32];
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token);
        timeout.CancelAfter(TimeSpan.FromSeconds(15));
        try
        {
            await stream.ReadExactlyAsync(challenge, timeout.Token);
            var response = ComputeResponse(key, challenge);
            try { await stream.WriteAsync(response, token); }
            finally { CryptographicOperations.ZeroMemory(response); }
        }
        finally { CryptographicOperations.ZeroMemory(challenge); }
    }
}