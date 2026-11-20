import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { analyzeLockfile, buildInventory, LOCK_SOURCES } from '../scripts/license-inventory.mjs';

async function fixture() {
  const source = LOCK_SOURCES[0];
  const raw = await readFile(new URL('../../../apps/viewer/package-lock.json', import.meta.url), 'utf8');
  return { source, raw, lock: JSON.parse(raw) };
}

test('both exact npm lockfile graphs yield deterministic metadata-only inventory', async () => {
  const first = await buildInventory();
  const second = await buildInventory();
  assert.deepEqual(first, second, 'lockfile digest and ordered components must be deterministic');
  assert.equal(first.totalLockfileEntries, 116, 'source baseline should be reviewed after lockfile changes');
  assert.deepEqual(first.checkpoint.map(x => x.componentCount), [65, 51]);
  assert.equal(first.components.filter(x => x.name === '@novnc/novnc').length, 1);
  assert.equal(first.components.find(x => x.name === '@novnc/novnc').declaredLicense, 'MPL-2.0');
  assert.equal(first.components.find(x => x.name === '@electron/packager').declaredLicense, 'BSD-2-Clause');
  assert.equal(first.components.find(x => x.name === 'electron').declaredLicense, 'MIT');
  assert.ok(first.components.every(x => !x.licenseTextChecked && x.includedInWindowsArtifact === 'unverified'));
  assert.match(first.classification, /NOT_A_REDISTRIBUTION_CLEARANCE/);
  assert.ok(first.unresolvedPayload.some(x => x.includes('Chromium/Node')));
  assert.ok(first.unresolvedPayload.some(x => x.includes('MPL-covered')));
});

test('missing package license declaration fails closed', async () => {
  const { source, raw, lock } = await fixture();
  delete lock.packages['node_modules/@novnc/novnc'].license;
  assert.throws(() => analyzeLockfile(lock, source, raw), /missing license declaration/);
});

test('new GPL or unknown SPDX expression cannot be silently marked reviewed', async () => {
  const { source, raw, lock } = await fixture();
  lock.packages['node_modules/@novnc/novnc'].license = 'GPL-3.0-only';
  assert.throws(() => analyzeLockfile(lock, source, raw), /new\/unreviewed license expression GPL-3.0-only/);
});

test('untrusted package origin or absent integrity fails closed', async () => {
  const { source, raw, lock } = await fixture();
  const entry = lock.packages['node_modules/@novnc/novnc'];
  entry.resolved = 'http://127.0.0.1/novnc.tgz';
  assert.throws(() => analyzeLockfile(lock, source, raw), /non-registry\/unreviewed resolved URL/);
  entry.resolved = 'https://registry.npmjs.org/@novnc/novnc/-/novnc-1.7.0.tgz';
  delete entry.integrity;
  assert.throws(() => analyzeLockfile(lock, source, raw), /missing\/unexpected integrity/);
});

test('outdated schema and changed security-sensitive direct versions require review', async () => {
  const { source, raw, lock } = await fixture();
  lock.lockfileVersion = 2;
  assert.throws(() => analyzeLockfile(lock, source, raw), /expected npm package-lock v3/);
  lock.lockfileVersion = 3;
  lock.packages['node_modules/@novnc/novnc'].version = '1.7.1';
  assert.throws(() => analyzeLockfile(lock, source, raw), /required @novnc\/novnc@1.7.0 changed/);
});
