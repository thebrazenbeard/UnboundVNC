namespace UnboundVnc.Host.Windows;

// A source-only design seam; no production host session invokes this type.
// The real remote authorization entry always DENIES until a verified peer
// transport and human-visible peer-specific on-host approval are integrated.
internal static class PeerBoundConsentDraft
{
    internal const bool RemoteRouteEnabled = false;

    internal static bool TryAuthorizeRealRemote(
        FakePeerObservation _, FakeLocalApproval __, HostRevocationEpoch ___) => false;

    // MODEL/TEST ONLY: all identity and approval objects can be forged by the
    // caller. They are NOT evidence from a Tailscale socket or Windows UI.
    internal static bool EvaluateFakeViewOnlyForTests(
        FakePeerObservation peer, FakeLocalApproval approval,
        HostRevocationEpoch revocation, DateTimeOffset now,
        bool isDefaultInputDesktop, bool peerConnected)
    {
        if (!isDefaultInputDesktop || !peerConnected ||
            !peer.FakeWhoIsVerified || !peer.FakeTlsServiceVerified ||
            !ValidNode(peer.NodeId) || !ValidNode(peer.HostNodeId) ||
            !ValidSession(peer.SessionId) || !ValidService(peer.TlsServiceName) ||
            peer.Scope != "view-only") return false;

        if (!approval.FakeHumanOperatorApproved || approval.Scope != "view-only" ||
            approval.NodeId != peer.NodeId || approval.HostNodeId != peer.HostNodeId ||
            approval.SessionId != peer.SessionId ||
            approval.TlsServiceName != peer.TlsServiceName ||
            approval.Epoch < 0 || revocation.Current != approval.Epoch) return false;

        if (approval.ApprovedAt > now || approval.ExpiresAt <= now ||
            approval.ExpiresAt <= approval.ApprovedAt ||
            approval.ExpiresAt - approval.ApprovedAt > TimeSpan.FromMinutes(5))
            return false;

        return true;
    }

    private static bool ValidNode(string? value) =>
        value is { Length: >= 6 and <= 69 } &&
        value.StartsWith("node:", StringComparison.Ordinal) &&
        value.AsSpan(5).IndexOfAnyExcept(
            "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-") < 0;

    private static bool ValidSession(string? value) =>
        value is { Length: 43 } &&
        value.AsSpan().IndexOfAnyExcept(
            "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-") < 0;

    private static bool ValidService(string? value) =>
        value is { Length: >= 12 and <= 253 } &&
        value.EndsWith(".ts.net", StringComparison.Ordinal) &&
        !value.Contains("..", StringComparison.Ordinal) &&
        value.All(c => c is >= 'a' and <= 'z' or >= '0' and <= '9' or '.' or '-');
}

internal sealed class HostRevocationEpoch
{
    private long epoch;
    internal long Current => Interlocked.Read(ref epoch);

    // Stop, lock, secure-desktop transition, session disconnect, expiration
    // and fault handlers must advance this BEFORE any further frame delivery.
    // This model is not wired to HostWindow's real session events.
    internal long Revoke() => Interlocked.Increment(ref epoch);
}

internal readonly record struct FakePeerObservation(
    string NodeId, string HostNodeId, string SessionId, string TlsServiceName,
    string Scope, bool FakeWhoIsVerified, bool FakeTlsServiceVerified);

internal readonly record struct FakeLocalApproval(
    string NodeId, string HostNodeId, string SessionId, string TlsServiceName,
    string Scope, long Epoch, DateTimeOffset ApprovedAt, DateTimeOffset ExpiresAt,
    bool FakeHumanOperatorApproved);
