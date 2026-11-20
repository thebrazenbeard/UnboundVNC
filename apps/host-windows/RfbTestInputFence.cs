using System.Security.Cryptography;

namespace UnboundVnc.Host.Windows;

/// <summary>
/// Test-owned, loopback-only control epoch barrier. A Key/PointerEvent from
/// an already-approved view-only TCP connection must never become authorized
/// merely because the host processed it after a later local control grant.
///
/// Only a challenge REQUEST processed after grant can issue a fresh nonce.
/// While waiting for its postgrant echo, ALL Key/Pointer packets are denied.
/// TCP order makes any buffered pregrant packet precede the new echo.
/// This is NOT authorization, authentication, native OS injection or a
/// general Firefox control protocol.
/// </summary>
internal sealed class RfbTestInputFence : IDisposable
{
    internal const string Request = "UNBOUNDVNC_TEST_CONTROL_REQUEST_V1";
    internal const string ChallengePrefix = "UNBOUNDVNC_TEST_CONTROL_CHALLENGE_V1:";
    internal const string ResponsePrefix = "UNBOUNDVNC_TEST_CONTROL_RESPONSE_V1:";

    private byte[]? challenge;
    private bool issued;
    private bool ready;
    private bool invalidated;

    internal bool Ready => ready && !invalidated;

    internal bool TryIssueChallenge(bool hostGrantCurrent, out string issuedChallenge)
    {
        issuedChallenge = "";
        if (!hostGrantCurrent || issued || invalidated) return false;
        challenge = RandomNumberGenerator.GetBytes(32);
        issued = true;
        issuedChallenge = ChallengePrefix +
            Convert.ToBase64String(challenge).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        return true;
    }

    internal bool TryConfirm(bool hostGrantCurrent, string response)
    {
        if (ready) return false; // duplicates grant nothing
        if (invalidated || !issued || challenge is null || !hostGrantCurrent)
        {
            Invalidate();
            return false;
        }
        if (!response.StartsWith(ResponsePrefix, StringComparison.Ordinal))
        {
            Invalidate();
            return false;
        }
        var encoded = response[ResponsePrefix.Length..];
        if (encoded.Length != 43 || !AllCanonicalBase64Url(encoded))
        {
            Invalidate();
            return false;
        }

        byte[] provided;
        try { provided = Convert.FromBase64String(
            encoded.Replace('-', '+').Replace('_', '/') + "="); }
        catch (FormatException)
        {
            Invalidate();
            return false;
        }
        var roundtrip = Convert.ToBase64String(provided)
            .TrimEnd('=').Replace('+', '-').Replace('/', '_');
        bool valid = provided.Length == 32 &&
            StringComparer.Ordinal.Equals(roundtrip, encoded) &&
            CryptographicOperations.FixedTimeEquals(provided, challenge);
        CryptographicOperations.ZeroMemory(provided);
        if (!valid)
        {
            Invalidate();
            return false;
        }
        CryptographicOperations.ZeroMemory(challenge);
        challenge = null;
        ready = true;
        return true;
    }

    private static bool AllCanonicalBase64Url(string value)
    {
        foreach (var ch in value)
        {
            if (!((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') ||
                  (ch >= '0' && ch <= '9') || ch is '-' or '_'))
                return false;
        }
        return true;
    }

    internal void Invalidate()
    {
        invalidated = true;
        ready = false;
        if (challenge is not null) CryptographicOperations.ZeroMemory(challenge);
        challenge = null;
    }

    public void Dispose() => Invalidate();
}