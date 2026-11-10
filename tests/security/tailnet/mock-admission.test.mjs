import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REMOTE_ROUTING_ENABLED, authorizeRealRemoteRoute, createFakeTailnetAdmission,
} from './mock-admission.mjs';

const route = Object.freeze({
  hostNodeId: 'node:hostA',
  serviceDns: 'host.tailnet.ts.net',
  upstream: '127.0.0.1:5901',
  role: 'view-only',
  publicExposure: false,
  allowedPeerNodeIds: ['node:viewerA'],
});
const observed = Object.freeze({
  source: 'FAKE_WHOIS_TEST_ONLY',
  whoisVerified: true,
  tlsVerified: true,
  peerNodeId: 'node:viewerA',
  tlsServerName: route.serviceDns,
});

function scenario() {
  let time = 10_000;
  const gate = createFakeTailnetAdmission({ now: () => time });
  const offered = gate.issue({ route, observed });
  assert.equal(offered.ok, true);
  const admitted = gate.consume({ ticketId: offered.ticketId, route, observed });
  assert.equal(admitted.ok, true);
  return {
    gate, sessionId: admitted.sessionId,
    consent: {
      localOperatorApproved: true,
      scope: 'view-only',
      sessionId: admitted.sessionId,
      peerNodeId: observed.peerNodeId,
      hostNodeId: route.hostNodeId,
      approvedEpoch: 8,
      currentEpoch: 8,
      expiresAt: time + 120_000,
    },
    advance: ms => { time += ms; },
  };
}

test('real route unconditionally disabled, even for well-formed fake claims', () => {
  assert.equal(REMOTE_ROUTING_ENABLED, false);
  assert.deepEqual(authorizeRealRemoteRoute({ route, observed }), {
    ok: false, reason: 'NO_VERIFIED_TAILNET_TRANSPORT_OR_HOST_CONSENT_BINDING',
  });
});

test('valid fake WhoIs/TLS peer receives only pending-consent ticket', () => {
  const gate = createFakeTailnetAdmission();
  const issued = gate.issue({ route, observed });
  assert.equal(issued.ok, true);
  assert.match(issued.ticketId, /^[A-Za-z0-9_-]{43}$/);
  const upgraded = gate.consume({ route, observed, ticketId: issued.ticketId });
  assert.deepEqual(Object.keys(upgraded).sort(), ['ok', 'sessionId', 'status']);
  assert.equal(upgraded.status, 'AWAITING_SEPARATE_HOST_CONSENT');
  assert.equal(gate.authorizeViewOnlyFrame({ sessionId: upgraded.sessionId, route, observed }).ok, false);
});

test('test-only fake consent permits read-only frames, never control', () => {
  const s = scenario();
  assert.deepEqual(s.gate.authorizeViewOnlyFrame({
    sessionId: s.sessionId, route, observed, consent: s.consent,
  }), { ok: true, scope: 'view-only' });
  assert.equal(s.gate.authorizeViewOnlyFrame({
    sessionId: s.sessionId, route: { ...route, role: 'control' },
    observed, consent: { ...s.consent, scope: 'control' },
  }).ok, false);
});

test('unverified peer, spoofed header, wrong user or TLS name fail closed', () => {
  const gate = createFakeTailnetAdmission();
  for (const fake of [
    { ...observed, source: 'Tailscale-User-Login' },
    { ...observed, whoisVerified: false },
    { ...observed, tlsVerified: false },
    { ...observed, peerNodeId: 'node:attacker' },
    { ...observed, peerNodeId: '192.0.2.5' },
    { ...observed, tlsServerName: 'attacker.tailnet.ts.net' },
    { ...observed, tlsServerName: undefined },
  ]) {
    assert.equal(gate.issue({ route, observed: fake }).ok, false);
  }
  assert.equal(gate.issue({ route }).ok, false);
});

test('public, arbitrary backend, wildcard, control and malformed route reject', () => {
  const gate = createFakeTailnetAdmission();
  for (const invalid of [
    { ...route, upstream: '0.0.0.0:5901' },
    { ...route, upstream: '100.100.2.3:5901' },
    { ...route, upstream: '127.0.0.1:22' },
    { ...route, publicExposure: true },
    { ...route, role: 'control' },
    { ...route, allowedPeerNodeIds: ['*'] },
    { ...route, allowedPeerNodeIds: ['node:viewerA', 'node:viewerA'] },
    { ...route, allowedPeerNodeIds: [] },
    { ...route, serviceDns: 'https://host.tailnet.ts.net' },
    { ...route, serviceDns: 'localhost' },
  ]) {
    assert.equal(gate.issue({ route: invalid, observed }).ok, false);
  }
});

test('one-use ticket cannot replay; hostile peer burns stolen ticket', () => {
  const gate = createFakeTailnetAdmission();
  const first = gate.issue({ route, observed });
  const stolen = gate.consume({
    ticketId: first.ticketId, route,
    observed: { ...observed, peerNodeId: 'node:attacker' },
  });
  assert.equal(stolen.ok, false);
  assert.equal(gate.consume({ ticketId: first.ticketId, route, observed }).reason,
    'MISSING_OR_REPLAYED_TICKET');
  const next = gate.issue({ route, observed });
  assert.equal(gate.consume({ ticketId: next.ticketId, route, observed }).ok, true);
  assert.equal(gate.consume({ ticketId: next.ticketId, route, observed }).ok, false);
});

test('TLS audience or destination changed between ticket and upgrade consumes ticket', () => {
  for (const changed of [
    { route: { ...route, serviceDns: 'other.tailnet.ts.net' }, observed },
    { route: { ...route, hostNodeId: 'node:other' }, observed },
    { route, observed: { ...observed, tlsServerName: 'other.tailnet.ts.net' } },
  ]) {
    const gate = createFakeTailnetAdmission();
    const issued = gate.issue({ route, observed });
    assert.equal(gate.consume({ ticketId: issued.ticketId, ...changed }).ok, false);
    assert.equal(gate.consume({ ticketId: issued.ticketId, route, observed }).ok, false);
  }
});

test('expired ticket, bounded capacity and session expiry fail closed', () => {
  let time = 1_000;
  const gate = createFakeTailnetAdmission({ now: () => time });
  const issued = gate.issue({ route, observed });
  time += 15_000;
  assert.equal(gate.consume({ ticketId: issued.ticketId, route, observed }).reason, 'EXPIRED_TICKET');
  for (let i = 0; i < 32; i++) assert.equal(gate.issue({ route, observed }).ok, true);
  assert.equal(gate.issue({ route, observed }).reason, 'TICKET_CAPACITY');

  const s = scenario();
  s.advance(300_000);
  assert.equal(s.gate.authorizeViewOnlyFrame({
    sessionId: s.sessionId, route, observed, consent: s.consent,
  }).reason, 'SESSION_EXPIRED');
});

test('host consent must be local, view-only, peer/session/epoch-bound, current', () => {
  const s = scenario();
  for (const invalid of [
    { ...s.consent, localOperatorApproved: false },
    { ...s.consent, sessionId: 'replay' },
    { ...s.consent, peerNodeId: 'node:attacker' },
    { ...s.consent, hostNodeId: 'node:other' },
    { ...s.consent, currentEpoch: 9 },
    { ...s.consent, scope: 'control' },
    { ...s.consent, approvedEpoch: -1 },
    { ...s.consent, expiresAt: 10_000 },
    { ...s.consent, expiresAt: 999_999 },
  ]) {
    assert.equal(s.gate.authorizeViewOnlyFrame({
      sessionId: s.sessionId, route, observed, consent: invalid,
    }).ok, false);
  }
  s.gate.revoke(s.sessionId);
  assert.equal(s.gate.authorizeViewOnlyFrame({
    sessionId: s.sessionId, route, observed, consent: s.consent,
  }).reason, 'NO_ADMITTED_SESSION');
});

test('epoch revocation and peer change kill session permanently, not transiently', () => {
  const epoch = scenario();
  assert.equal(epoch.gate.authorizeViewOnlyFrame({
    sessionId: epoch.sessionId, route, observed,
    consent: { ...epoch.consent, currentEpoch: 9 },
  }).reason, 'CONSENT_EPOCH_REVOKED');
  assert.equal(epoch.gate.authorizeViewOnlyFrame({
    sessionId: epoch.sessionId, route, observed, consent: epoch.consent,
  }).reason, 'NO_ADMITTED_SESSION');

  const peer = scenario();
  assert.equal(peer.gate.authorizeViewOnlyFrame({
    sessionId: peer.sessionId, route, observed: { ...observed, tlsVerified: false },
    consent: peer.consent,
  }).reason, 'ACTIVE_PEER_OR_TLS_CHANGED');
  assert.equal(peer.gate.authorizeViewOnlyFrame({
    sessionId: peer.sessionId, route, observed, consent: peer.consent,
  }).reason, 'NO_ADMITTED_SESSION');
});

test('single active session rejects queue, separate ticket still one-use', () => {
  const s = scenario();
  const issued = s.gate.issue({ route, observed });
  assert.equal(s.gate.consume({ ticketId: issued.ticketId, route, observed }).reason,
    'ACTIVE_SESSION_CAPACITY');
  assert.equal(s.gate.consume({ ticketId: issued.ticketId, route, observed }).ok, false);
  s.gate.revoke(s.sessionId);
  const again = s.gate.issue({ route, observed });
  assert.equal(s.gate.consume({ ticketId: again.ticketId, route, observed }).ok, true);
});
