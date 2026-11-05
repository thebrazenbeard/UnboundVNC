package admission

import (
	"context"
	"crypto/tls"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"tailscale.com/client/tailscale/apitype"
	"tailscale.com/tailcfg"
)

type fakeWhoIs struct {
	response *apitype.WhoIsResponse
	err      error
	calls    int
	remote   string
}

func (f *fakeWhoIs) WhoIs(_ context.Context, remote string) (*apitype.WhoIsResponse, error) {
	f.calls++
	f.remote = remote
	return f.response, f.err
}

type fakeHostIPC struct {
	approveFunc func(ConsentRequest) (Grant, error)
	calls       int
}

func (*fakeHostIPC) trustedHostIPC() {}
func (f *fakeHostIPC) approve(_ context.Context, request ConsentRequest) (Grant, error) {
	f.calls++
	return f.approveFunc(request)
}

func whois(node string) *apitype.WhoIsResponse {
	return &apitype.WhoIsResponse{Node: &tailcfg.Node{StableID: tailcfg.StableNodeID(node)}}
}

func validFixture() (*candidate, *fakeWhoIs, *fakeHostIPC) {
	identity := &fakeWhoIs{response: whois("n5SUKe8CNTRL")}
	host := &fakeHostIPC{}
	host.approveFunc = func(req ConsentRequest) (Grant, error) {
		return Grant{PeerNodeID: req.PeerNodeID, HostNodeID: req.HostNodeID,
			SessionID: req.SessionID, Scope: viewOnly, Epoch: 3, CurrentEpoch: 3,
			ExpiresAt: time.Unix(2_000, 0), Revoked: make(chan struct{})}, nil
	}
	a, err := newCandidate(Config{Enabled: true, ServiceDNS: "host.test-tailnet.ts.net",
		HostNodeID: "nPbn3DgCaT11CNTRL", AllowedPeer: []string{"n5SUKe8CNTRL"}}, identity, host)
	if err != nil {
		panic(err)
	}
	a.now = func() time.Time { return time.Unix(1_900, 0) }
	return a, identity, host
}

func request() *http.Request {
	r := httptest.NewRequest(http.MethodPost, "https://host.test-tailnet.ts.net/private/view", nil)
	r.Host = "host.test-tailnet.ts.net"
	r.Header.Set("Origin", "https://host.test-tailnet.ts.net")
	r.Header.Set("Content-Type", "application/json")
	r.RemoteAddr = "100.101.102.103:49332"
	r.TLS = &tls.ConnectionState{}
	return r
}

func execute(a *candidate, r *http.Request) int {
	w := httptest.NewRecorder()
	a.ServeHTTP(w, r)
	return w.Code
}

func TestNoProductionEnableOrListenerWithoutTrustedWindowsIPC(t *testing.T) {
	if _, err := newCandidate(Config{}, nil, nil); !errors.Is(err, ErrDisabled) {
		t.Fatalf("default-off expected, got %v", err)
	}
	cfg := Config{Enabled: true, ServiceDNS: "host.test-tailnet.ts.net",
		HostNodeID: "nPbn3DgCaT11CNTRL", AllowedPeer: []string{"n5SUKe8CNTRL"}}
	if _, err := newCandidate(cfg, &fakeWhoIs{}, nil); !errors.Is(err, ErrNoHostIPC) {
		t.Fatalf("no host IPC must deny before listener, got %v", err)
	}
	if _, err := newCandidate(cfg, nil, &fakeHostIPC{}); !errors.Is(err, ErrNoTailnet) {
		t.Fatalf("no real WhoIs must deny, got %v", err)
	}
	a, _, _ := validFixture()
	if err := a.servePrivate(nil); !errors.Is(err, ErrNoTailnet) {
		t.Fatalf("no tsnet server must not open a listener: %v", err)
	}
	server := boundedServer(a)
	if server.ReadHeaderTimeout != 5*time.Second || server.ReadTimeout != 15*time.Second ||
		server.WriteTimeout != 15*time.Second || server.IdleTimeout != 5*time.Second ||
		server.MaxHeaderBytes != 8<<10 {
		t.Fatal("private source candidate lost bounded HTTP request budgets")
	}
}

func TestNoWildcardPublicOrArbitraryRouteConfig(t *testing.T) {
	a, identity, host := validFixture()
	for _, cfg := range []Config{
		{Enabled: true, ServiceDNS: "https://evil.example", HostNodeID: a.cfg.HostNodeID, AllowedPeer: []string{"n5SUKe8CNTRL"}},
		{Enabled: true, ServiceDNS: "0.0.0.0", HostNodeID: a.cfg.HostNodeID, AllowedPeer: []string{"n5SUKe8CNTRL"}},
		{Enabled: true, ServiceDNS: a.cfg.ServiceDNS, HostNodeID: "*", AllowedPeer: []string{"n5SUKe8CNTRL"}},
		{Enabled: true, ServiceDNS: a.cfg.ServiceDNS, HostNodeID: a.cfg.HostNodeID, AllowedPeer: []string{"*"}},
		{Enabled: true, ServiceDNS: a.cfg.ServiceDNS, HostNodeID: a.cfg.HostNodeID, AllowedPeer: []string{"n5SUKe8CNTRL", "n5SUKe8CNTRL"}},
	} {
		if _, err := newCandidate(cfg, identity, host); !errors.Is(err, ErrBadConfig) {
			t.Errorf("bad route accepted %#v: %v", cfg, err)
		}
	}
}

func TestTrustedSocketWhoIsAndHostConsentStillCannotForward(t *testing.T) {
	a, identity, host := validFixture()
	r := request()
	r.Header.Set("Tailscale-User-Login", "attacker@example.invalid")
	r.Header.Set("X-Tailscale-Node-ID", "node:attacker")
	r.Header.Set("X-Forwarded-For", "198.51.100.11")
	if status := execute(a, r); status != http.StatusServiceUnavailable {
		t.Fatalf("even authorized fake inputs cannot bypass missing handoff: %d", status)
	}
	if identity.remote != r.RemoteAddr || identity.calls != 1 || host.calls != 1 {
		t.Fatalf("authority must come from accepted RemoteAddr, not headers; identity=%+v hostcalls=%d", identity, host.calls)
	}
	if status := execute(a, request()); status != http.StatusServiceUnavailable {
		t.Fatalf("second fake consent cannot enable route: %d", status)
	}
	if host.calls != 2 { t.Fatal("per-session host approval must be requested afresh") }
}

func TestMissingWrongOrUnavailableWhoIsDeniesBeforeConsent(t *testing.T) {
	for _, response := range []*apitype.WhoIsResponse{nil, {}, whois("nAttackerCNTRL")} {
		a, identity, host := validFixture()
		identity.response = response
		if status := execute(a, request()); status != http.StatusForbidden {
			t.Errorf("unverified caller got %d", status)
		}
		if host.calls != 0 { t.Fatal("unverified WhoIs reached host IPC") }
	}
	a, identity, host := validFixture()
	identity.err = errors.New("tailscale local API unavailable")
	if execute(a, request()) != http.StatusForbidden || host.calls != 0 {
		t.Fatal("WhoIs lookup failure must fail closed")
	}
}

func TestHostConsentStaleMismatchedRevokedAndAbsentDenies(t *testing.T) {
	for _, mutate := range []func(ConsentRequest, Grant) Grant{
		func(_ ConsentRequest, g Grant) Grant { g.PeerNodeID = "nAttackerCNTRL"; return g },
		func(_ ConsentRequest, g Grant) Grant { g.HostNodeID = "nOtherCNTRL"; return g },
		func(_ ConsentRequest, g Grant) Grant { g.SessionID = "replay"; return g },
		func(_ ConsentRequest, g Grant) Grant { g.Scope = "control"; return g },
		func(_ ConsentRequest, g Grant) Grant { g.CurrentEpoch++; return g },
		func(_ ConsentRequest, g Grant) Grant { g.ExpiresAt = time.Unix(1_899, 0); return g },
		func(_ ConsentRequest, g Grant) Grant { g.ExpiresAt = time.Unix(20_000, 0); return g },
		func(_ ConsentRequest, g Grant) Grant { g.Revoked = nil; return g },
		func(_ ConsentRequest, g Grant) Grant { ch := make(chan struct{}); close(ch); g.Revoked = ch; return g },
	} {
		a, _, host := validFixture()
		orig := host.approveFunc
		host.approveFunc = func(req ConsentRequest) (Grant, error) {
			g, _ := orig(req)
			return mutate(req, g), nil
		}
		if status := execute(a, request()); status != http.StatusForbidden {
			t.Errorf("bad host grant got %d", status)
		}
	}
}

func TestWrongOriginHostOrNonTLSBeforeIdentity(t *testing.T) {
	for _, modify := range []func(*http.Request){
		func(r *http.Request) { r.TLS = nil },
		func(r *http.Request) { r.Host = "evil.ts.net" },
		func(r *http.Request) { r.Header.Set("Origin", "https://evil.ts.net") },
		func(r *http.Request) { r.Header.Del("Origin") },
		func(r *http.Request) { r.Method = http.MethodGet },
		func(r *http.Request) { r.URL.Path = "/public" },
		func(r *http.Request) { r.URL.RawQuery = "target=8.8.8.8" },
		func(r *http.Request) { r.Header.Set("Content-Type", "text/plain") },
	} {
		a, identity, _ := validFixture()
		r := request()
		modify(r)
		if status := execute(a, r); status != http.StatusForbidden || identity.calls != 0 {
			t.Errorf("request should fail before WhoIs: status=%d calls=%d", status, identity.calls)
		}
	}
}
