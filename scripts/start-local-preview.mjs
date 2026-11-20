#!/usr/bin/env node
// Explicitly local and attended Windows preview. No service install or remote route.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { startLocalScreenShare } from './local-screen-share.mjs';
import { launchAttendedProcess } from './attended-process.mjs';

const usage = [
  'UnboundVNC local screen sharing preview (Windows).',
  'Usage: node scripts/start-local-preview.mjs [--open-browser] [--help]',
  'Requires built viewer and Windows attended host. Connect only on 127.0.0.1.',
  'The Windows host starts STOPPED: click Start local preview on the host.',
  'When the viewer connects, Approve or Reject each view-only session locally.',
  'Use Stop and revoke on the host to end sharing immediately.',
  'Closing the host or stopping this launcher closes local gateway/viewer.',
  'Remote access is not enabled. Native input and unattended control are disabled.',
].join('\n');

async function main(args) {
  if (args.includes('--help')) {
    process.stdout.write(usage + '\n');
    return;
  }
  if (args.some(option => option !== '--open-browser')) {
    throw new Error('Unknown option. Use --help for safe local-preview usage.');
  }
  const root = fileURLToPath(new URL('../', import.meta.url));
  const staticRoot = resolve(root, 'apps/viewer/dist');
  const executable = resolve(root, 'apps/host-windows/bin/Release/net8.0-windows/UnboundVnc.Host.Windows.exe');
  const session = await startLocalScreenShare({
    staticRoot,
    launchHost: ({ sessionKey }) => launchAttendedProcess({ executable, sessionKey }),
  });
  let closing = false;
  async function close() {
    if (closing) return;
    closing = true;
    try {
      await session.close();
    } catch (error) {
      process.stderr.write('Local preview shutdown incomplete: ' + error.message + '\n');
      process.exitCode = 1;
    }
  }
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  process.stdout.write('LOCAL_ONLY_VIEWER=' + session.url + '\n');
  process.stdout.write('Local Windows host launched, but sharing is OFF until Start and per-session Approve.\n');
  process.stdout.write('Press Ctrl+C to close this preview. Remote access is not enabled.\n');

  if (args.includes('--open-browser')) {
    // OS browser handoff with a fixed loopback URL, no shell or external destination.
    const browser = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', session.url], {
      detached: true, windowsHide: false, stdio: 'ignore', shell: false,
    });
    browser.once('error', error => {
      process.stderr.write('Browser open failed; use local URL above: ' + error.message + '\n');
    });
    browser.unref();
  }
  // A closed host must not leave a gateway waiting for a replacement process on 5901.
  if (session.whenHostExited) {
    await session.whenHostExited;
    await close();
  } else {
    await new Promise(() => {});
  }
}

main(process.argv.slice(2)).catch(error => {
  process.stderr.write('UnboundVNC local preview refused: ' + error.message + '\n');
  process.exitCode = 1;
});