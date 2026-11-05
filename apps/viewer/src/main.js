import RFB from '@novnc/novnc';
import { describeEndpoint, loadDevices, saveDevices, sortedDevices, validateDevice } from './devices.mjs';
import { fingerprintServerKey } from './identity.mjs';
import { compareServerPin, forgetServerPin, readServerPin, rememberServerPin, requirePinnedIdentity, trustedEndpoint } from './trust.mjs';
import { captureFocus, findDeviceAction, isToolbarEscape, restoreFocus } from './focus.mjs';
import './style.css';

const app = document.querySelector('#app');
const state = {
  devices: loadDevices(window.localStorage),
  search: '',
  editId: null,
  connection: null,
  gateway: 'checking',
  sessionReturnFocus: null,
  lastFailure: null,
};

const glyph = {
  monitor: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="14" rx="2"/><path d="M8 22h8M12 18v4"/></svg>',
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 13 0m-6-6 6 6-6 6"/></svg>',
  star: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 2 3.1 6.5 7.2 1-5.2 5.1 1.3 7.2-6.4-3.4-6.4 3.4 1.3-7.2-5.2-5.1 7.2-1L12 2Z"/></svg>',
  sliders: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 17h16M8 4v6M16 14v6"/></svg>',
  trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6M14 11v6"/></svg>',
  maximize: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/></svg>',
  eye: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>',
  expand: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h7M4 4v7M20 20h-7m7 0v-7M20 4l-7 7M4 20l7-7"/></svg>',
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5l14 14M19 5 5 19"/></svg>',
  search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg>',
  shield: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2 4 5v6c0 5.2 3.3 9.2 8 11 4.7-1.8 8-5.8 8-11V5l-8-3Z"/><path d="m8 12 3 3 5-6"/></svg>',
};

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function dateLabel(value) {
  if (!value) return 'Not connected yet';
  const elapsed = Math.max(0, Date.now() - value);
  if (elapsed < 60_000) return 'Just now';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  return new Date(value).toLocaleDateString();
}

function notify(message, tone = 'info') {
  // The persistent failure banner already announces this exact error. Do not
  // duplicate it in a floating toast over narrow-screen connection controls.
  const failure = document.querySelector('#connection-error');
  if (tone === 'error' && failure && !failure.hidden &&
      document.querySelector('#connection-error-message').textContent === message) return;
  const toast = document.createElement('div');
  toast.className = `toast toast-${tone}`;
  toast.setAttribute('role', tone === 'error' ? 'alert' : 'status');
  toast.textContent = message;
  document.querySelector('#toasts').append(toast);
  setTimeout(() => toast.remove(), 5500);
}

app.innerHTML = `
  <div class="ambient ambient-one"></div><div class="ambient ambient-two"></div>
  <div class="application">
    <aside class="sidebar">
      <div class="brand"><div class="brand-mark" aria-hidden="true"><span></span><span></span><span></span></div>
        <div><strong>unbound<span>VNC</span></strong><small>REMOTE WITHOUT LIMITS</small></div></div>
      <div class="side-label">WORKSPACE</div>
      <nav aria-label="Main navigation">
        <a class="nav-item active" href="#devices" aria-current="page">${glyph.monitor}<span>My devices</span></a>
        <button id="nav-add" class="nav-item" type="button">${glyph.plus}<span>Add a device</span></button>
      </nav>
      <div class="sidebar-spacer"></div>
      <div class="privacy-note">${glyph.shield}<div><strong>Your network. Your keys.</strong><p>Saved devices stay in this browser. Passwords aren't stored.</p></div></div>
      <div class="gateway-status"><span id="gateway-dot" class="status-dot checking"></span><span id="gateway-text">Checking local gateway</span></div>
    </aside>
    <main class="workspace" id="devices">
      <header class="topbar"><div class="eyebrow"><span class="live-spark"></span> CONTROL CENTER <span class="slash">/</span> DEVICE FLEET</div><span class="top-pill">LOCAL FIRST <span>◈</span> NO SUBSCRIPTION</span></header>
      <section id="connection-error" class="connection-error" role="alert" aria-labelledby="connection-error-title" hidden>
        <div><strong id="connection-error-title">Connection unsuccessful</strong><p id="connection-error-message"></p></div>
        <div class="connection-error-actions"><button id="connection-retry" class="btn btn-quiet" type="button">Retry connection</button><button id="connection-error-dismiss" class="btn btn-quiet" type="button">Dismiss</button></div>
      </section>
      <section class="hero"><div><p class="eyebrow hero-eyebrow">ACCESS WITHOUT ASKING PERMISSION FROM A PLATFORM</p><h1>Your machines.<br/><em>Your rules.</em></h1><p class="hero-copy">Every desktop you own, one clean place to reach it. Standard VNC underneath. Freedom on top.</p>
        <div class="hero-actions"><button id="hero-add" class="btn btn-primary" type="button">${glyph.plus} Add device</button><a href="#quick-connect" class="btn btn-quiet">Quick connect ${glyph.arrow}</a></div></div>
        <div class="hero-art" aria-hidden="true"><div class="orbit orbit-one"></div><div class="orbit orbit-two"></div><div class="orbit orbit-three"></div><div class="core-device">${glyph.monitor}</div><span class="node node-a"></span><span class="node node-b"></span><span class="node node-c"></span></div>
      </section>
      <section class="device-section" aria-labelledby="device-heading"><div class="section-heading"><div><div class="section-kicker">YOUR NETWORK</div><h2 id="device-heading">My devices <span id="device-count" class="count-pill">0</span></h2><p>Your saved connection profiles. Reachability is checked only when you connect.</p></div>
        <div class="section-tools"><label class="search-field">${glyph.search}<span class="sr-only">Search devices</span><input id="device-search" type="search" placeholder="Search devices…" autocomplete="off"/></label><button class="icon-btn" id="list-add" type="button" aria-label="Add a device" title="Add a device">${glyph.plus}</button></div></div>
        <div id="devices-grid" class="device-grid"></div>
      </section>
      <section class="quick-panel" id="quick-connect"><div class="quick-symbol" aria-hidden="true">↗</div><div><div class="section-kicker">NO PROFILE NEEDED</div><h2>Quick connect</h2><p>Already have a VNC address? Connect directly over your own network.</p></div>
        <form id="quick-form" class="quick-form"><label class="sr-only" for="quick-host">Hostname or IP</label><input id="quick-host" name="host" placeholder="Hostname or IP address" required autocomplete="off"/><label class="sr-only" for="quick-port">Port</label><input id="quick-port" name="port" type="number" value="5900" min="1" max="65535" required/><button class="btn btn-primary" type="submit">Connect ${glyph.arrow}</button></form></section>
      <footer class="footer"><span>UNBOUNDVNC // ALPHA</span><span>VNC-NATIVE · SELF-HOSTED · USER-OWNED</span></footer>
    </main>
  </div>
  <section id="session-view" class="session-view" aria-label="Remote desktop session" hidden>
    <div class="session-topbar"><div class="session-identity"><span class="session-online-dot"></span><div><strong id="session-name">Remote session</strong><small id="session-address"></small></div></div>
      <span id="session-status" class="session-status" role="status" aria-live="polite">Connecting…</span>
      <div class="session-actions"><button id="session-viewonly" class="session-action" type="button" aria-label="View only" aria-pressed="false" title="Disable local keyboard and mouse input">${glyph.eye}<span>View only</span></button><button id="session-scale" class="session-action active" type="button" aria-label="Fit screen" aria-pressed="true" title="Fit remote display to window">${glyph.expand}<span>Fit screen</span></button><button id="session-fullscreen" class="session-action" type="button" title="Fullscreen">${glyph.maximize}<span>Fullscreen</span></button><button id="session-disconnect" class="session-action disconnect" type="button" aria-label="Disconnect">${glyph.close}<span>Disconnect</span></button><button id="session-focus-remote" class="session-action" type="button" aria-label="Focus remote desktop" title="Return keyboard to remote desktop" disabled>${glyph.monitor}<span>Focus remote</span></button></div>
    </div><div id="session-stage" class="session-stage"><div id="remote-screen" aria-label="Remote desktop framebuffer"></div></div>
    <div class="session-footnote">Ctrl+Alt+Shift+Escape returns keyboard focus from the remote canvas to session controls. View-only is a viewer control, not host-side authorization. Gateway-to-host traffic may not be encrypted.</div>
  </section>
  <dialog id="device-dialog" class="modal" aria-labelledby="device-modal-title"><form id="device-form" method="dialog"><div class="modal-header"><div><p class="section-kicker">DEVICE PROFILE</p><h2 id="device-modal-title">Add a device</h2></div><button class="modal-x" type="button" data-close="device-dialog" aria-label="Close">${glyph.close}</button></div>
    <label>Device name <input name="name" maxlength="64" required placeholder="e.g. Lappy"/></label>
    <label>Hostname or IP <input name="host" maxlength="253" required placeholder="192.168.1.25"/></label>
    <label>RFB port <input name="port" type="number" min="1" max="65535" required value="5900"/></label>
    <p class="modal-hint">The target must already run a VNC-compatible server. Saved profiles never contain passwords.</p>
    <div id="device-form-error" class="form-error" role="alert" hidden></div>
    <div class="modal-footer"><button class="btn btn-quiet" type="button" data-close="device-dialog">Cancel</button><button class="btn btn-primary" type="submit">Save device</button></div>
  </form></dialog>
  <dialog id="credentials-dialog" class="modal" aria-labelledby="credentials-title"><form id="credentials-form" method="dialog"><div class="modal-header"><div><p class="section-kicker">VNC AUTHENTICATION</p><h2 id="credentials-title">Credentials required</h2></div></div>
    <p class="modal-hint">The VNC server requested credentials. They are used for this session only. A VNC password does not establish encrypted transport or server identity; the gateway-to-host connection may be unencrypted.</p><label>Username <input name="username" autocomplete="username" placeholder="If required"/></label><label>Password <input name="password" type="password" autocomplete="off" autofocus placeholder="VNC password"/></label>
    <div class="modal-footer"><button id="credentials-cancel" class="btn btn-quiet" type="button">Disconnect</button><button class="btn btn-primary" type="submit">Authenticate ${glyph.arrow}</button></div>
  </form></dialog>
  <dialog id="identity-dialog" class="modal" aria-labelledby="identity-title"><div class="modal-header"><div><p class="section-kicker">VERIFY YOUR DESTINATION</p><h2 id="identity-title">Confirm server identity</h2></div></div><p id="identity-detail" class="modal-hint">Compare this key fingerprint with one obtained through a trusted, separate channel. Do not approve an unknown or changed fingerprint.</p>
    <p class="modal-hint">SHA-256 server key fingerprint:</p><code id="identity-fingerprint" class="identity-fingerprint" aria-live="polite">Calculating…</code>
    <div class="modal-footer"><button class="btn btn-quiet" id="identity-reject" type="button">Disconnect</button><button class="btn btn-quiet" id="identity-reset" type="button" hidden>Forget old key and disconnect</button><button class="btn btn-primary" id="identity-approve" type="button" disabled>I verified this key</button></div></dialog>
  <div id="toasts" class="toast-stack" aria-live="polite"></div>
`;

function persist() {
  try { saveDevices(window.localStorage, state.devices); }
  catch { notify('Could not save devices in browser storage.', 'error'); }
}

function renderDevices() {
  const match = state.search.toLocaleLowerCase();
  const shown = sortedDevices(state.devices).filter(d =>
    d.name.toLocaleLowerCase().includes(match) || describeEndpoint(d).toLocaleLowerCase().includes(match)
  );
  document.querySelector('#device-count').textContent = String(state.devices.length);
  const grid = document.querySelector('#devices-grid');
  if (!shown.length) {
    grid.innerHTML = `<div class="empty-state"><div class="empty-icon">${glyph.monitor}</div><h3>${state.devices.length ? 'No matching devices' : 'Your fleet starts here'}</h3><p>${state.devices.length ? 'Try another name or address.' : 'Save a VNC address to make your next connection one click away.'}</p><button class="btn btn-primary" type="button" data-action="add">${glyph.plus} Add a device</button></div>`;
    return;
  }
  grid.innerHTML = shown.map((device, index) => `
    <article class="device-card" style="--order:${index}" data-device-id="${escapeHtml(device.id)}">
      <div class="device-top"><div class="device-icon">${glyph.monitor}</div><button class="favorite-btn ${device.favorite ? 'is-favorite' : ''}" type="button" data-action="favorite" data-id="${escapeHtml(device.id)}" aria-label="${device.favorite ? 'Remove from favorites' : 'Add to favorites'}" title="Toggle favorite">${glyph.star}</button></div>
      <h3>${escapeHtml(device.name)}</h3><div class="device-endpoint">${escapeHtml(describeEndpoint(device))}</div>
      <div class="device-meta"><span class="saved-indicator"></span> Saved profile <span class="device-time">${escapeHtml(dateLabel(device.lastConnectedAt))}</span></div>
      <div class="device-bottom"><button class="btn btn-connect" type="button" data-action="connect" data-id="${escapeHtml(device.id)}">Connect ${glyph.arrow}</button><button class="icon-btn small" type="button" data-action="edit" data-id="${escapeHtml(device.id)}" title="Edit profile" aria-label="Edit ${escapeHtml(device.name)}">${glyph.sliders}</button><button class="icon-btn small delete-btn" type="button" data-action="delete" data-id="${escapeHtml(device.id)}" title="Remove profile" aria-label="Remove ${escapeHtml(device.name)}">${glyph.trash}</button></div>
    </article>`).join('');
}

function openDeviceDialog(device = null) {
  state.editId = device?.id ?? null;
  const form = document.querySelector('#device-form');
  form.elements.name.value = device?.name ?? '';
  form.elements.host.value = device?.host ?? '';
  form.elements.port.value = String(device?.port ?? 5900);
  document.querySelector('#device-modal-title').textContent = device ? 'Edit device' : 'Add a device';
  document.querySelector('#device-form-error').hidden = true;
  document.querySelector('#device-dialog').showModal();
  form.elements.name.focus();
}

function closeDialog(id) {
  const dialog = document.getElementById(id);
  if (dialog.open) dialog.close();
}

function renderConnectionError() {
  const panel = document.getElementById('connection-error');
  document.getElementById('connection-error-message').textContent = state.lastFailure?.message ?? '';
  panel.hidden = !state.lastFailure;
}

function showConnectionFailure(device, message, viewOnly = false) {
  // Retry state is in memory only; saved device profiles never include it.
  state.lastFailure = { device, message, viewOnly };
  renderConnectionError();
}

function clearConnectionFailure() {
  state.lastFailure = null;
  renderConnectionError();
}

function showSession(device, viewOnly = false) {
  state.sessionReturnFocus = captureFocus(document.activeElement);
  clearConnectionFailure();
  document.querySelector('#session-name').textContent = device.name;
  document.querySelector('#session-address').textContent = describeEndpoint(device);
  document.querySelector('#session-status').textContent = 'Connecting…';
  document.querySelector('#session-view').hidden = false;
  document.querySelector('.application').inert = true;
  document.body.classList.add('session-active');
  document.querySelector('#session-disconnect').focus({ preventScroll: true });
  document.querySelector('#session-viewonly').classList.toggle('active', viewOnly);
  document.querySelector('#session-focus-remote').disabled = true;
  document.querySelector('#session-viewonly').setAttribute('aria-pressed', String(viewOnly));
  document.querySelector('#session-scale').classList.add('active');
  document.querySelector('#session-scale').setAttribute('aria-pressed', 'true');
}

function hideSession() {
  const view = document.querySelector('#session-view');
  const wasActive = !view.hidden;
  view.hidden = true;
  document.querySelector('.application').inert = false;
  document.body.classList.remove('session-active');
  document.querySelector('#remote-screen').replaceChildren();
  document.querySelector('#session-focus-remote').disabled = true;
  closeDialog('credentials-dialog');
  closeDialog('identity-dialog');
  document.querySelector('#identity-approve').disabled = true;
  document.querySelector('#identity-approve').hidden = false;
  document.querySelector('#identity-reset').hidden = true;
  document.querySelector('#identity-fingerprint').textContent = 'Calculating…';
  if (wasActive) {
    restoreFocus(state.sessionReturnFocus, document.querySelector('#devices-grid'), document.querySelector('#quick-host'));
  }
  state.sessionReturnFocus = null;
}

function disconnect() {
  const previous = state.connection;
  if (!previous) { hideSession(); return; }
  state.connection = null;
  previous.manual = true;
  previous.abortController?.abort();
  try { previous.rfb?.disconnect(); } catch { /* session may already be closed */ }
  hideSession();
}

async function connectTo(device, viewOnly = false) {
  if (state.connection) disconnect();
  let target;
  try { target = validateDevice(device); }
  catch (error) { notify(error.message, 'error'); return; }
  showSession(target, viewOnly);
  const connection = {
    device, target, rfb: null, manual: false, viewOnly, abortController: new AbortController(),
    verificationReady: false, pendingFingerprint: null, verifiedFingerprint: null,
    identityChanged: false, verificationAttempt: 0,
  };
  state.connection = connection;
  try {
    // Check storage before a network connection is started. A corrupt pin store
    // cannot be bypassed by negotiating a weaker VNC security type.
    readServerPin(window.localStorage, trustedEndpoint(target));
    const response = await fetch('/api/sessions', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host: target.host, port: target.port }),
      signal: AbortSignal.any([connection.abortController.signal, AbortSignal.timeout(10000)]),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || data.message || `Gateway rejected connection (${response.status}).`);
    if (!data.wsPath || typeof data.wsPath !== 'string') throw new Error('Gateway did not provide a connection endpoint.');
    if (state.connection !== connection) return;
    const url = new URL(data.wsPath, window.location.origin);
    if (url.origin !== window.location.origin) throw new Error('Gateway returned an unexpected WebSocket origin.');
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const rfb = new RFB(document.querySelector('#remote-screen'), url.href);
    connection.rfb = rfb;
    rfb.scaleViewport = true;
    rfb.viewOnly = connection.viewOnly;
    rfb.addEventListener('connect', () => {
      if (state.connection !== connection) return;
      try {
        requirePinnedIdentity(readServerPin(window.localStorage, trustedEndpoint(target)), connection.verifiedFingerprint);
      } catch (error) {
        disconnect();
        showConnectionFailure(device, error.message, connection.viewOnly);
        notify(error.message, 'error');
        return;
      }
      document.querySelector('#session-status').textContent = connection.verifiedFingerprint
        ? 'Connected · RSA key verified' : 'Connected · identity unverified';
      document.querySelector('#session-focus-remote').disabled = false;
      rfb.focus({ preventScroll: true });
      if (device.id) {
        const stored = state.devices.find(d => d.id === device.id);
        if (stored) { stored.lastConnectedAt = Date.now(); persist(); renderDevices(); }
      }
      notify(`Connected to ${target.name}`, 'success');
    });
    rfb.addEventListener('credentialsrequired', () => {
      if (state.connection !== connection) return;
      try {
        requirePinnedIdentity(readServerPin(window.localStorage, trustedEndpoint(target)), connection.verifiedFingerprint);
      } catch (error) {
        disconnect();
        showConnectionFailure(device, error.message, connection.viewOnly);
        notify(error.message, 'error');
        return;
      }
      document.querySelector('#credentials-dialog').showModal();
    });
    rfb.addEventListener('serververification', async event => {
      if (state.connection !== connection) return;
      const attempt = ++connection.verificationAttempt;
      connection.verificationReady = false;
      connection.pendingFingerprint = null;
      connection.identityChanged = false;
      document.querySelector('#identity-approve').disabled = true;
      document.querySelector('#identity-approve').hidden = false;
      document.querySelector('#identity-reset').hidden = true;
      document.querySelector('#identity-fingerprint').textContent = 'Calculating…';
      try {
        if (event.detail?.type !== 'RSA') throw new Error('Unsupported server verification method.');
        const fingerprint = await fingerprintServerKey(event.detail.publickey);
        if (state.connection !== connection || connection.verificationAttempt !== attempt) return;
        const endpoint = trustedEndpoint(target);
        const decision = compareServerPin(readServerPin(window.localStorage, endpoint), fingerprint);
        // No user interaction is required for a key already independently verified.
        if (decision === 'matching') {
          connection.verifiedFingerprint = fingerprint;
          rfb.approveServer();
          return;
        }
        connection.pendingFingerprint = fingerprint;
        connection.identityChanged = decision === 'changed';
        document.querySelector('#identity-fingerprint').textContent = fingerprint;
        document.querySelector('#identity-detail').textContent = connection.identityChanged
          ? `WARNING: The RSA server key for ${endpoint} differs from the previously trusted key. This connection is blocked. If the owner confirms a legitimate key rotation through another channel, forget the old key, disconnect, then reconnect and verify the new fingerprint.`
          : `First connection to ${endpoint}: compare this RSA fingerprint against one obtained independently from the server owner. Only approve if they match. A VNC password does not prove server identity.`;
        connection.verificationReady = !connection.identityChanged;
        document.querySelector('#identity-approve').disabled = connection.identityChanged;
        document.querySelector('#identity-approve').hidden = connection.identityChanged;
        document.querySelector('#identity-reset').hidden = !connection.identityChanged;
        document.querySelector('#identity-dialog').showModal();
      } catch (error) {
        if (state.connection !== connection || connection.verificationAttempt !== attempt) return;
        disconnect();
        showConnectionFailure(device, `Could not verify server identity: ${error.message}`, connection.viewOnly);
        notify(`Could not verify server identity: ${error.message}`, 'error');
      }
    });
    rfb.addEventListener('securityfailure', event => {
      if (state.connection !== connection) return;
      connection.failureMessage = `VNC authentication failed${event.detail?.reason ? ': ' + event.detail.reason : '.'}`;
      notify(connection.failureMessage, 'error');
    });
    rfb.addEventListener('disconnect', () => {
      if (state.connection !== connection) return;
      state.connection = null;
      hideSession();
      // noVNC's `clean` flag means no protocol failure; even a remote-initiated
      // WebSocket close may be `clean`. Only our explicit Disconnect path is
      // user-initiated, and it clears state.connection before this event.
      const message = connection.failureMessage || 'Remote connection ended unexpectedly.';
      showConnectionFailure(device, message, connection.viewOnly);
      notify(message, 'error');
    });
  } catch (error) {
    if (state.connection !== connection) return;
    state.connection = null;
    hideSession();
    showConnectionFailure(device, error?.message || 'Connection failed.', connection.viewOnly);
    notify(error?.message || 'Connection failed.', 'error');
  }
}

for (const id of ['nav-add', 'hero-add', 'list-add']) {
  document.getElementById(id).addEventListener('click', () => openDeviceDialog());
}
document.getElementById('device-search').addEventListener('input', event => {
  state.search = event.target.value;
  renderDevices();
});
document.getElementById('devices-grid').addEventListener('click', event => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  if (button.dataset.action === 'add') { openDeviceDialog(); return; }
  const device = state.devices.find(d => d.id === button.dataset.id);
  if (!device) return;
  switch (button.dataset.action) {
    case 'favorite': {
      const retainFocus = document.activeElement === button;
      device.favorite = !device.favorite;
      persist(); renderDevices();
      if (retainFocus) findDeviceAction(document.querySelector('#devices-grid'), 'favorite', device.id)
        ?.focus({ preventScroll: true });
      break;
    }
    case 'edit': openDeviceDialog(device); break;
    case 'delete':
      if (!window.confirm(`Remove ${device.name} from your saved devices? This does not change the remote computer.`)) return;
      state.devices = state.devices.filter(d => d.id !== device.id);
      persist(); renderDevices(); break;
    case 'connect': connectTo(device); break;
  }
});
document.getElementById('device-form').addEventListener('submit', event => {
  event.preventDefault();
  const form = event.currentTarget;
  const errorPanel = document.querySelector('#device-form-error');
  try {
    const value = validateDevice(Object.fromEntries(new FormData(form)));
    if (state.editId) {
      const index = state.devices.findIndex(d => d.id === state.editId);
      if (index >= 0) state.devices[index] = { ...state.devices[index], ...value };
    } else {
      state.devices.push({ id: crypto.randomUUID(), ...value, favorite: false, lastConnectedAt: null });
    }
    persist();
    renderDevices();
    closeDialog('device-dialog');
    notify('Device saved.', 'success');
  } catch (error) {
    errorPanel.textContent = error.message;
    errorPanel.hidden = false;
  }
});
document.querySelectorAll('[data-close]').forEach(button =>
  button.addEventListener('click', () => closeDialog(button.dataset.close)));
document.getElementById('quick-form').addEventListener('submit', event => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.currentTarget));
  connectTo({ ...data, name: data.host });
});
document.getElementById('connection-retry').addEventListener('click', () => {
  const failed = state.lastFailure;
  if (failed) connectTo(failed.device, failed.viewOnly);
});
document.getElementById('connection-error-dismiss').addEventListener('click', clearConnectionFailure);
document.addEventListener('keydown', event => {
  if (!state.connection || !isToolbarEscape(event)
      || document.querySelector('#credentials-dialog').open
      || document.querySelector('#identity-dialog').open) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  document.getElementById('session-disconnect').focus({ preventScroll: true });
}, true);
document.getElementById('session-disconnect').addEventListener('click', () => { disconnect(); notify('Disconnected.'); });
document.getElementById('session-focus-remote').addEventListener('click', () => {
  state.connection?.rfb?.focus({ preventScroll: true });
});
document.getElementById('session-viewonly').addEventListener('click', event => {
  const rfb = state.connection?.rfb;
  if (!rfb) return;
  rfb.viewOnly = !rfb.viewOnly;
  state.connection.viewOnly = rfb.viewOnly;
  event.currentTarget.classList.toggle('active', rfb.viewOnly);
  event.currentTarget.setAttribute('aria-pressed', String(rfb.viewOnly));
  notify(rfb.viewOnly ? 'View-only enabled in this viewer.' : 'Mouse and keyboard enabled in this viewer.');
});
document.getElementById('session-scale').addEventListener('click', event => {
  const rfb = state.connection?.rfb;
  if (!rfb) return;
  rfb.scaleViewport = !rfb.scaleViewport;
  event.currentTarget.classList.toggle('active', rfb.scaleViewport);
  event.currentTarget.setAttribute('aria-pressed', String(rfb.scaleViewport));
});
document.getElementById('session-fullscreen').addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.querySelector('#session-stage').requestFullscreen();
  } catch { notify('Fullscreen is unavailable in this browser.', 'error'); }
});
document.getElementById('credentials-form').addEventListener('submit', event => {
  event.preventDefault();
  const rfb = state.connection?.rfb;
  if (!rfb) return;
  const form = event.currentTarget;
  const credentials = { username: form.elements.username.value, password: form.elements.password.value };
  form.reset();
  closeDialog('credentials-dialog');
  rfb.sendCredentials(credentials);
});
document.getElementById('credentials-cancel').addEventListener('click', disconnect);
document.getElementById('identity-reject').addEventListener('click', disconnect);
for (const id of ['credentials-dialog', 'identity-dialog']) {
  document.getElementById(id).addEventListener('cancel', event => {
    event.preventDefault();
    disconnect();
  });
}
document.getElementById('identity-approve').addEventListener('click', () => {
  const connection = state.connection;
  if (!connection?.verificationReady || connection.identityChanged || !connection.pendingFingerprint) return;
  connection.verificationReady = false;
  try {
    rememberServerPin(window.localStorage, trustedEndpoint(connection.target), connection.pendingFingerprint);
  } catch (error) {
    // A storage failure may be a concurrent change to an existing pin. Do not
    // allow a successful user click to bypass an unresolved mismatch.
    disconnect();
    showConnectionFailure(connection.device, `Cannot establish remembered server identity: ${error.message}`, connection.viewOnly);
    notify(`Cannot establish remembered server identity: ${error.message}`, 'error');
    return;
  }
  connection.verifiedFingerprint = connection.pendingFingerprint;
  closeDialog('identity-dialog');
  connection.rfb?.approveServer();
});
document.getElementById('identity-reset').addEventListener('click', () => {
  const connection = state.connection;
  if (!connection?.identityChanged) return;
  const endpoint = trustedEndpoint(connection.target);
  if (!window.confirm(`Forget the previously trusted RSA key for ${endpoint}? This does not prove that the new key is safe. The session will disconnect and you must independently verify it on the next connection.`)) return;
  try {
    forgetServerPin(window.localStorage, endpoint);
    disconnect();
    notify('Old server key forgotten. Reconnect and verify the new key with the owner.');
  } catch (error) {
    notify(`Could not forget server key: ${error.message}`, 'error');
  }
});

async function checkGateway() {
  try {
    const response = await fetch('/api/health', { signal: AbortSignal.timeout(3000), cache: 'no-store' });
    if (!response.ok) throw new Error();
    state.gateway = 'available';
    document.querySelector('#gateway-dot').className = 'status-dot available';
    document.querySelector('#gateway-text').textContent = 'Local gateway available';
  } catch {
    state.gateway = 'unavailable';
    document.querySelector('#gateway-dot').className = 'status-dot unavailable';
    document.querySelector('#gateway-text').textContent = 'Local gateway offline';
  }
}

renderDevices();
checkGateway();
