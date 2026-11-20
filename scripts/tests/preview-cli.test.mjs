import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(new URL('../start-local-preview.mjs', import.meta.url));

test('preview help clearly describes local-only attended use and stop', () => {
  const output = spawnSync(process.execPath, [runner, '--help'], { encoding: 'utf8', timeout: 3000 });
  assert.equal(output.status, 0);
  assert.match(output.stdout, /127\.0\.0\.1/);
  assert.match(output.stdout, /Approve/i);
  assert.match(output.stdout, /Stop/i);
  assert.match(output.stdout, /view.only/i);
  assert.match(output.stdout, /remote access.*not enabled/i);
});

test('unrecognized flag exits before launching any process', () => {
  const output = spawnSync(process.execPath, [runner, '--unknown-option'], { encoding: 'utf8', timeout: 3000 });
  assert.notEqual(output.status, 0);
  assert.match(output.stderr, /Unknown option/);
});