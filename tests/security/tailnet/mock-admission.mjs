import { randomBytes } from 'node:crypto';

// SOURCE/TEST candidate ONLY. No production code imports this module. A
// client-provided JSON object is never real Tailscale WhoIs or TLS proof.
export const REMOTE_ROUTING_ENABLED = false;

export function authorizeRealRemoteRoute() {
  return { ok: false, reason: 'NO_VERIFIED_TAILNET_TRANSPORT_OR_HOST_CONSENT_BINDING' };
}

const TICKET_MS = 15_000;
const SESSION_MS = 5 * 60_000;
const MAX_TICKETS = 32;
const NODE_ID = /^node:[A-Za-z0-9_-]{1,64}$/;
const SERVICE_DNS = /^[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63})+\.ts\.net$/;
const deny = reason => ({ ok: false, reason });

function validRoute(route) {
  return route?.hostNodeId && NODE_ID.test(route.hostNodeId) &&
    typeof route.serviceDns === 'string' && SERVICE_DNS.test(route.serviceDns) &&
    route.upstream === '127.0.0.1:5901' &&
    route.role === 'view-only' && route.publicExposure === false &&
    Array.isArray(route.allowedPeerNodeIds) && route.allowedPeerNodeIds.length >= 1 &&
    route.allowedPeerNodeIds.length <= 16 &&
    route.allowedPeerNodeIds.every(id => typeof id === 'string' && NODE_ID.test(id)) &&
    new Set(route.allowedPeerNodeIds).size === route.allowedPeerNodeIds.length;
}

function validFakeWhoIsAndTls(observed, route) {
  // All booleans are fake, injected solely by this model's unit tests.
  // A real implementation MUST derive them from the trusted socket:
  // tsnet LocalClient.WhoIs(remoteAddr) and verified TLS state, never headers.
  return observed?.source === 'FAKE_WHOIS_TEST_ONLY' &&
    observed.whoisVerified === true && observed.tlsVerified === true &&
    typeof observed.peerNodeId === 'string' && NODE_ID.test(observed.peerNodeId) &&
    observed.tlsServerName === route.serviceDns &&
    route.allowedPeerNodeIds.includes(observed.peerNodeId);
}

/**
 * Fake two-phase admission model for deterministic threat tests, not a route.
 * Ticket -> peer-bound upgrade -> separate on-host view-only consent check.
 * No listener, DNS, Tailscale daemon, TLS handshake or RFB socket is opened.
 */
export function createFakeTailnetAdmission({ now = () => Date.now() } = {}) {
  const tickets = new Map();
  const sessions = new Map();

  function prune() {
    const time = now();
    for (const [key, value] of tickets) if (value.expiresAt <= time) tickets.delete(key);
    for (const [key, value] of sessions) if (value.expiresAt <= time) sessions.delete(key);
  }

  function issue({ route, observed } = {}) {
    prune();
    if (!validRoute(route)) return deny('INVALID_PRIVATE_VIEW_ONLY_ROUTE');
    if (!validFakeWhoIsAndTls(observed, route)) return deny('UNVERIFIED_PEER_OR_TLS');
    if (tickets.size >= MAX_TICKETS) return deny('TICKET_CAPACITY');
    const id = randomBytes(32).toString('base64url');
    const expiresAt = now() + TICKET_MS;
    tickets.set(id, {
      peerNodeId: observed.peerNodeId,
      serviceDns: route.serviceDns,
      hostNodeId: route.hostNodeId,
      expiresAt,
    });
    return { ok: true, ticketId: id, expiresAt };
  }

  function consume({ ticketId, route, observed } = {}) {
    // A guessed/stolen ticket is destroyed on ANY upgrade attempt, including
    // a wrong peer, matching the current gateway's one-use ticket discipline.
    const ticket = tickets.get(ticketId);
    tickets.delete(ticketId);
    if (!ticket) return deny('MISSING_OR_REPLAYED_TICKET');
    if (ticket.expiresAt <= now()) return deny('EXPIRED_TICKET');
    if (!validRoute(route) || !validFakeWhoIsAndTls(observed, route) ||
        ticket.peerNodeId !== observed.peerNodeId ||
        ticket.serviceDns !== route.serviceDns || ticket.hostNodeId !== route.hostNodeId) {
      return deny('TICKET_PEER_TLS_AUDIENCE_MISMATCH');
    }
    prune();
    // The attended host is single-session; do not queue another admitted peer.
    if (sessions.size >= 1) return deny('ACTIVE_SESSION_CAPACITY');
    const sessionId = randomBytes(32).toString('base64url');
    sessions.set(sessionId, {
      peerNodeId: observed.peerNodeId,
      hostNodeId: route.hostNodeId,
      serviceDns: route.serviceDns,
      expiresAt: now() + SESSION_MS,
    });
    return { ok: true, sessionId, status: 'AWAITING_SEPARATE_HOST_CONSENT' };
  }

  function authorizeViewOnlyFrame({ sessionId, route, observed, consent } = {}) {
    const session = sessions.get(sessionId);
    if (!session) return deny('NO_ADMITTED_SESSION');
    if (session.expiresAt <= now()) {
      sessions.delete(sessionId);
      return deny('SESSION_EXPIRED');
    }
    if (!validRoute(route) || !validFakeWhoIsAndTls(observed, route) ||
        session.peerNodeId !== observed.peerNodeId ||
        session.hostNodeId !== route.hostNodeId || session.serviceDns !== route.serviceDns) {
      sessions.delete(sessionId);
      return deny('ACTIVE_PEER_OR_TLS_CHANGED');
    }
    if (Number.isSafeInteger(consent?.approvedEpoch) &&
        Number.isSafeInteger(consent?.currentEpoch) &&
        consent.currentEpoch !== consent.approvedEpoch) {
      sessions.delete(sessionId);
      return deny('CONSENT_EPOCH_REVOKED');
    }
    // A real host must produce consent via its local UI, bound to the remote
    // peer + session + epoch. The current host cannot produce this evidence.
    if (consent?.localOperatorApproved !== true ||
        consent.scope !== 'view-only' || consent.sessionId !== sessionId ||
        consent.peerNodeId !== session.peerNodeId ||
        consent.hostNodeId !== session.hostNodeId ||
        !Number.isSafeInteger(consent.approvedEpoch) ||
        consent.approvedEpoch < 0 || consent.currentEpoch !== consent.approvedEpoch ||
        !Number.isFinite(consent.expiresAt) || consent.expiresAt <= now() ||
        consent.expiresAt > session.expiresAt) {
      return deny('NO_CURRENT_PEER_BOUND_LOCAL_CONSENT');
    }
    return { ok: true, scope: 'view-only' };
  }

  function revoke(sessionId) {
    sessions.delete(sessionId);
  }

  return { issue, consume, authorizeViewOnlyFrame, revoke };
}
