package admission

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"net/http"
	"regexp"
	"time"

	"tailscale.com/client/tailscale/apitype"
	"tailscale.com/tsnet"
)

// SOURCE CANDIDATE ONLY. No production application imports this package.
// There is deliberately no CLI, enabled default or host-approval IPC provider.
// A configured gateway is NEVER contacted, even after fake unit-test consent.

var (
	ErrDisabled     = errors.New("private adapter is default-off")
	ErrNoHostIPC    = errors.New("trusted Windows peer-specific consent IPC is unavailable")
	ErrNoTailnet    = errors.New("no tsnet identity service")
	ErrBadConfig    = errors.New("invalid private service identity or peer allowlist")
	ErrNoHandoff   = errors.New("authenticated gateway handoff is not implemented")
)

const viewOnly = "view-only"

var serviceNamePattern = regexp.MustCompile(`^[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63})+\.ts\.net$`)
// StableNodeID is opaque, not an invented "node:" namespace. Actual Tailscale
// values include e.g. "n5SUKe8CNTRL"; other control planes may differ. Only
// exact configured matches grant admission; reject wildcard/control chars.
var nodeIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`)

type Config struct {
	Enabled     bool
	ServiceDNS  string
	HostNodeID  string
	AllowedPeer []string
}

// SocketWhoIs is the exact SDK method signature. The real implementation is
// local.Client.WhoIs, obtained from the SAME tsnet.Server's LocalClient().
type SocketWhoIs interface {
	WhoIs(context.Context, string) (*apitype.WhoIsResponse, error)
}

type ConsentRequest struct {
	PeerNodeID string
	HostNodeID string
	SessionID  string
	Scope      string
}

type Grant struct {
	PeerNodeID   string
	HostNodeID   string
	SessionID    string
	Scope        string
	Epoch        uint64
	CurrentEpoch uint64
	ExpiresAt    time.Time
	Revoked      <-chan struct{}
}

// TrustedHostConsent has an unexported method, deliberately preventing a
// caller outside THIS package from injecting a made-up approval. No real
// implementation exists. The same-package tests use a fake but no product
// binary can supply this missing runtime capability.
type TrustedHostConsent interface {
	approve(context.Context, ConsentRequest) (Grant, error)
	trustedHostIPC()
}

type candidate struct {
	cfg     Config
	whois   SocketWhoIs
	consent TrustedHostConsent
	peers   map[string]struct{}
	now     func() time.Time
}

func newCandidate(cfg Config, identity SocketWhoIs, consent TrustedHostConsent) (*candidate, error) {
	if !cfg.Enabled {
		return nil, ErrDisabled
	}
	if consent == nil {
		return nil, ErrNoHostIPC
	}
	if identity == nil {
		return nil, ErrNoTailnet
	}
	if !serviceNamePattern.MatchString(cfg.ServiceDNS) || !nodeIDPattern.MatchString(cfg.HostNodeID) ||
		len(cfg.AllowedPeer) == 0 || len(cfg.AllowedPeer) > 16 {
		return nil, ErrBadConfig
	}
	peers := make(map[string]struct{}, len(cfg.AllowedPeer))
	for _, id := range cfg.AllowedPeer {
		if !nodeIDPattern.MatchString(id) {
			return nil, ErrBadConfig
		}
		if _, exists := peers[id]; exists {
			return nil, ErrBadConfig
		}
		peers[id] = struct{}{}
	}
	return &candidate{cfg: cfg, whois: identity, consent: consent, peers: peers, now: time.Now}, nil
}

func validGrant(req ConsentRequest, grant Grant, now time.Time) bool {
	if grant.PeerNodeID != req.PeerNodeID || grant.HostNodeID != req.HostNodeID ||
		grant.SessionID != req.SessionID || grant.Scope != viewOnly ||
		grant.Epoch != grant.CurrentEpoch || grant.ExpiresAt.IsZero() ||
		!grant.ExpiresAt.After(now) || grant.ExpiresAt.After(now.Add(5*time.Minute)) ||
		grant.Revoked == nil {
		return false
	}
	select {
	case <-grant.Revoked:
		return false
	default:
		return true
	}
}

func (a *candidate) authorize(ctx context.Context, remoteAddr string) (Grant, error) {
	if a == nil || a.whois == nil || a.consent == nil {
		return Grant{}, ErrNoHostIPC
	}
	// Identity comes solely from the trusted accepted socket's remote address,
	// never Serve/X-Forwarded headers or JSON. This call must be repeated for
	// every future HTTP ticket and WebSocket upgrade independently.
	who, err := a.whois.WhoIs(ctx, remoteAddr)
	if err != nil || who == nil || who.Node == nil || who.Node.StableID == "" {
		return Grant{}, ErrNoTailnet
	}
	peer := string(who.Node.StableID)
	if _, ok := a.peers[peer]; !ok {
		return Grant{}, ErrNoTailnet
	}
	session := make([]byte, 32)
	if _, err := rand.Read(session); err != nil {
		return Grant{}, err
	}
	req := ConsentRequest{PeerNodeID: peer, HostNodeID: a.cfg.HostNodeID,
		SessionID: base64.RawURLEncoding.EncodeToString(session), Scope: viewOnly}
	grant, err := a.consent.approve(ctx, req)
	if err != nil || !validGrant(req, grant, a.now()) {
		return Grant{}, ErrNoHostIPC
	}
	return grant, nil
}

func deny(w http.ResponseWriter, code int) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(code)
}

func (a *candidate) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if a == nil || !a.cfg.Enabled || a.consent == nil || a.whois == nil {
		deny(w, http.StatusServiceUnavailable)
		return
	}
	// A browser's service identity must match the exact certificate hostname.
	// TLS verification by the browser and real tailnet policy are still
	// unqualified; no forwarding path exists in this candidate.
	if r.TLS == nil || r.Method != http.MethodPost || r.URL.Path != "/private/view" ||
		r.URL.RawQuery != "" || r.Host != a.cfg.ServiceDNS ||
		r.Header.Get("Origin") != "https://"+a.cfg.ServiceDNS ||
		r.Header.Get("Content-Type") != "application/json" || r.ContentLength > 0 {
		deny(w, http.StatusForbidden)
		return
	}
	_, err := a.authorize(r.Context(), r.RemoteAddr)
	if err != nil {
		deny(w, http.StatusForbidden)
		return
	}
	// Fail CLOSED even with a valid WhoIs and simulated grant: Windows host
	// does not expose a trusted signed/peer-bound IPC consent service and the
	// localhost gateway has no such authenticated handoff. No ticket, RFB or
	// framebuffer byte can be forwarded here.
	_ = ErrNoHandoff
	deny(w, http.StatusServiceUnavailable)
}

// servePrivate is intentionally unexported and has NO product caller.
// It compiles against genuine tsnet.Server.ListenTLS/LocalClient, but can
// never run without a TrustedHostConsent implementation within this package.
// Do not add ListenFunnel or bind a public/raw TCP listener here.
func (a *candidate) servePrivate(server *tsnet.Server) error {
	if a == nil || !a.cfg.Enabled {
		return ErrDisabled
	}
	if a.consent == nil {
		return ErrNoHostIPC
	}
	if server == nil {
		return ErrNoTailnet
	}
	identity, err := server.LocalClient()
	if err != nil {
		return err
	}
	a.whois = identity
	listener, err := server.ListenTLS("tcp", ":443")
	if err != nil {
		return err
	}
	defer listener.Close()
	return http.Serve(listener, a)
}
