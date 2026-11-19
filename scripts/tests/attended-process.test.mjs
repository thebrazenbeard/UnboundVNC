import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { launchAttendedProcess } from '../attended-process.mjs';

test('launches an owned GUI-capable Windows child and shuts it down on request', async () => {
  const processHandle = await launchAttendedProcess({
    executable: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
  });
  assert.ok(processHandle.pid > 0);
  assert.equal(processHandle.exited, false);
  await processHandle.close();
  await processHandle.close();
  assert.equal(processHandle.exited, true);
});

test('a missing executable cannot create a child', async () => {
  await assert.rejects(
    launchAttendedProcess({ executable: join(tmpdir(), 'never-exists-unboundvnc-host.exe') }),
    /not found|missing|ENOENT/i,
  );
});

test('a child that exits immediately cannot be reported as ready', async () => {
  await assert.rejects(launchAttendedProcess({
    executable: process.execPath,
    args: ['-e', 'process.exit(13)'],
  }), /exited|failed/i);
});