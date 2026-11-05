using UnboundVnc.Host.Windows;

var now = new DateTimeOffset(2026, 11, 5, 12, 0, 0, TimeSpan.Zero);
var sessionId = new string('A', 43);
var peer = new FakePeerObservation(
    "node:viewerA", "node:hostA", sessionId, "host.tailnet.ts.net",
    "view-only", FakeWhoIsVerified: true, FakeTlsServiceVerified: true);

FakeLocalApproval Approved(HostRevocationEpoch revocation) => new(
    peer.NodeId, peer.HostNodeId, peer.SessionId, peer.TlsServiceName,
    "view-only", revocation.Current, now.AddSeconds(-1), now.AddMinutes(2),
    FakeHumanOperatorApproved: true);

bool WouldAllow(FakePeerObservation p, FakeLocalApproval a, HostRevocationEpoch r,
    bool desktop = true, bool connected = true, DateTimeOffset? at = null) =>
    PeerBoundConsentDraft.EvaluateFakeViewOnlyForTests(
        p, a, r, at ?? now, desktop, connected);

Check("real remote authorization remains unconditionally disabled", () =>
{
    var revocation = new HostRevocationEpoch();
    var approved = Approved(revocation);
    Require(!PeerBoundConsentDraft.RemoteRouteEnabled, "remote route enabled");
    Require(!PeerBoundConsentDraft.TryAuthorizeRealRemote(peer, approved, revocation),
        "fake identity authorized real remote access");
    Require(WouldAllow(peer, approved, revocation),
        "model positive control rejected; negative tests could be vacuous");
});

Check("fake model needs verified peer WhoIs and TLS service identity", () =>
{
    var revocation = new HostRevocationEpoch();
    var approved = Approved(revocation);
    Require(!WouldAllow(peer with { FakeWhoIsVerified = false }, approved, revocation),
        "unverified fake WhoIs accepted");
    Require(!WouldAllow(peer with { FakeTlsServiceVerified = false }, approved, revocation),
        "unverified fake TLS accepted");
    Require(!WouldAllow(peer with { TlsServiceName = "other.tailnet.ts.net" }, approved, revocation),
        "different TLS audience accepted");
});

Check("session, peer and host must match local approval exactly", () =>
{
    var revocation = new HostRevocationEpoch();
    var approved = Approved(revocation);
    Require(!WouldAllow(peer with { NodeId = "node:attacker" }, approved, revocation),
        "wrong peer accepted");
    Require(!WouldAllow(peer with { HostNodeId = "node:other" }, approved, revocation),
        "wrong host accepted");
    Require(!WouldAllow(peer with { SessionId = new string('B', 43) }, approved, revocation),
        "wrong session accepted");
    Require(!WouldAllow(peer, approved with { SessionId = new string('B', 43) }, revocation),
        "replayed approval accepted");
});

Check("remote control and unauthenticated local approval cannot authorize", () =>
{
    var revocation = new HostRevocationEpoch();
    var approved = Approved(revocation);
    Require(!WouldAllow(peer with { Scope = "control" }, approved, revocation),
        "control request accepted");
    Require(!WouldAllow(peer, approved with { Scope = "control" }, revocation),
        "control approval accepted");
    Require(!WouldAllow(peer, approved with { FakeHumanOperatorApproved = false }, revocation),
        "missing host decision accepted");
});

Check("malformed peer, session and service names fail closed", () =>
{
    var revocation = new HostRevocationEpoch();
    var approved = Approved(revocation);
    foreach (string bad in new[] { "", "node:", "node:with space", "https://viewer" })
        Require(!WouldAllow(peer with { NodeId = bad }, approved, revocation),
            "malformed node accepted");
    foreach (string bad in new[] { "", "short", new string('A', 44) })
        Require(!WouldAllow(peer with { SessionId = bad }, approved, revocation),
            "malformed session accepted");
    foreach (string bad in new[] { "", "example.com", "host..ts.net", "https://host.tailnet.ts.net" })
        Require(!WouldAllow(peer with { TlsServiceName = bad }, approved, revocation),
            "malformed TLS name accepted");
});

Check("approval is capped to five minutes and must already exist", () =>
{
    var revocation = new HostRevocationEpoch();
    var approved = Approved(revocation);
    Require(!WouldAllow(peer, approved with { ExpiresAt = now.AddMinutes(6) }, revocation),
        "overlong approval accepted");
    Require(!WouldAllow(peer, approved with { ApprovedAt = now.AddMinutes(1) }, revocation),
        "future approval accepted");
    Require(!WouldAllow(peer, approved with { ExpiresAt = now }, revocation),
        "expired approval accepted");
    Require(!WouldAllow(peer, approved with { ExpiresAt = now.AddSeconds(-2) }, revocation),
        "reversed approval time accepted");
});

Check("Stop revokes old epoch and cannot be reset", () =>
{
    var revocation = new HostRevocationEpoch();
    var approved = Approved(revocation);
    Require(WouldAllow(peer, approved, revocation), "valid fake lease not initially allowed");
    Require(revocation.Revoke() == 1, "first Stop epoch did not advance");
    Require(!WouldAllow(peer, approved, revocation), "old approval survived Stop");
    Require(revocation.Revoke() == 2, "second Stop epoch not monotonic");
    Require(!WouldAllow(peer, approved, revocation), "old approval revived");
});

Check("simulated lock and secure desktop deny stale frame", () =>
{
    var revocation = new HostRevocationEpoch();
    var approved = Approved(revocation);
    Require(!WouldAllow(peer, approved, revocation, desktop: false),
        "secure input desktop accepted");
    revocation.Revoke(); // Model a lock event; no real workstation is locked.
    Require(!WouldAllow(peer, approved, revocation, desktop: true),
        "pre-lock lease survived lock epoch");
});

Check("peer disconnect denies, even with a valid fake approval", () =>
{
    var revocation = new HostRevocationEpoch();
    Require(!WouldAllow(peer, Approved(revocation), revocation, connected: false),
        "disconnected peer authorized");
});

Check("late approval cannot cross revocation gap", () =>
{
    var revocation = new HostRevocationEpoch();
    var before = Approved(revocation);
    using var release = new ManualResetEventSlim();
    var evaluator = Task.Run(() =>
    {
        release.Wait();
        return WouldAllow(peer, before, revocation);
    });
    revocation.Revoke(); // Deterministic test barrier, not a real lock/UAC event.
    release.Set();
    Require(!evaluator.GetAwaiter().GetResult(), "in-flight stale approval passed after revoke");
});

Console.WriteLine("PASS: 10 fake peer/host consent negative checks; real remote authorization always OFF");

static void Check(string name, Action work)
{
    work();
    Console.WriteLine($"PASS: {name}");
}

static void Require(bool condition, string message)
{
    if (!condition) throw new InvalidOperationException(message);
}
