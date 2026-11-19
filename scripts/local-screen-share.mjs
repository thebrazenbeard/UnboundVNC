/**
 * Attended local screen-sharing composition.
 * This starts no sharing consent or network route beyond 127.0.0.1.
 * The Windows host owns local Start, Approve and Stop controls.
 */
import { connect } from 'node:net';
import { randomBytes } from 'node:crypto';
import { createGateway } from '../apps/gateway/src/server.mjs';
import { startLocalViewer } from '../packaging/viewer-windows/local-server.mjs';

async function assertAttendedPortVacant() {
  await new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port: 5901 });
    let finished = false;
    const done = error => {
      if (finished) return;
      finished = true;
      socket.destroy();
      error ? reject(error) : resolve();
    };
    socket.once('connect', () => done(new Error('RFB host port 5901 already listening; refusing another host')));
    socket.once('error', error => error.code === 'ECONNREFUSED'
      ? done() : done(error));
    socket.setTimeout(1500, () => done(new Error('RFB host port 5901 preflight timed out')));
  });
}

export async function startLocalScreenShare({ staticRoot, launchHost } = {}) {
  if (typeof launchHost !== 'function') {
    throw new TypeError('A local attended launchHost callback is required');
  }

  await assertAttendedPortVacant();
  // Fresh private key binds this gateway to the owned host launch.
  const attendedHostKey = randomBytes(32);
  // Deliberately only the Windows attended host's existing RFB port.
  // The desktop HTTP wrapper and RFB gateway both choose ephemeral loopback ports.
  const viewer = await startLocalViewer({
    staticRoot,
    createGateway,
    allowedPorts: [5901],
    // Human approval precedes the host's first RFB banner. One pending
    // session gets a bounded 45 seconds; generic gateway remains five seconds.
    greetingTimeoutMs: 45_000,
    maxSessions: 1,
    attendedHostKey,
  });

  let host;
  try {
    host = await launchHost({ sessionKey: attendedHostKey.toString('base64url') });
    if (!host || typeof host.close !== 'function') {
      throw new TypeError('The attended host must return a close handle');
    }
  } catch (error) {
    await viewer.close();
    attendedHostKey.fill(0);
    throw error;
  }

  let closed = false;
  return {
    url: viewer.url,
    whenHostExited: host.whenExited,
    async close() {
      if (closed) return;
      closed = true;
      const results = await Promise.allSettled([viewer.close(), host.close()]);
      const failed = results.find(result => result.status === 'rejected');
      attendedHostKey.fill(0);
      if (failed) throw failed.reason;
    },
  };
}