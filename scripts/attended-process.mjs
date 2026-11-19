/** Own only the child process this launcher creates; never attach to other hosts. */
import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';

export async function launchAttendedProcess({ executable, args = [], sessionKey } = {}) {
  if (process.platform !== 'win32') {
    throw new Error('Windows interactive attended host only');
  }
  if (typeof executable !== 'string' || !isAbsolute(executable) ||
      !executable.toLowerCase().endsWith('.exe') ||
      !Array.isArray(args) || args.some(item => typeof item !== 'string')) {
    throw new TypeError('Expected an absolute Windows executable and string args');
  }
  if (!(await stat(executable)).isFile()) {
    throw new Error('Windows attended executable not found');
  }

  if (typeof sessionKey !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(sessionKey)) {
    throw new Error('An exact per-launch host proof key is required');
  }
  const child = spawn(executable, args, {
    env: { ...process.env, UNBOUNDVNC_ATTENDED_SESSION_KEY: sessionKey },
    cwd: dirname(executable),
    windowsHide: false,
    shell: false,
    stdio: 'ignore',
  });
  let exited = false;
  let closePending;
  const whenExited = new Promise(resolve => {
    child.once('exit', (code, signal) => {
      exited = true;
      resolve({ code, signal });
    });
  });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });

  // A successful OS spawn is not GUI readiness. Reject obvious startup crashes.
  await new Promise(resolve => setTimeout(resolve, 250));
  if (exited) {
    const result = await whenExited;
    throw new Error('Windows host exited during startup (code=' + result.code + ')');
  }

  return {
    pid: child.pid,
    get exited() { return exited; },
    whenExited,
    close() {
      if (closePending) return closePending;
      closePending = (async () => {
        if (exited) return;
        if (!child.kill()) throw new Error('Could not stop owned Windows host process');
        await new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error('Owned Windows host did not exit after stop')), 3000,
          );
          whenExited.then(() => { clearTimeout(timer); resolve(); });
        });
      })();
      return closePending;
    },
  };
}