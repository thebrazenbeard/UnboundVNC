// Metadata-only npm lockfile inventory. This deliberately does NOT authorize
// redistribution or replace complete per-file and native-binary notices.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const LOCK_SOURCES = Object.freeze([
  { label: 'viewer', path: 'apps/viewer/package-lock.json', required: { '@novnc/novnc': '1.7.0' } },
  { label: 'windows-packager', path: 'packaging/viewer-windows/package-lock.json',
    required: { electron: '45.2.1', '@electron/packager': '20.3.0' } },
]);

// This is the set observed and manually triaged for *metadata inventory* at
// the initial source checkpoint, not an automatic legal approval list.
export const REVIEWED_METADATA_EXPRESSIONS = Object.freeze([
  'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'BlueOak-1.0.0',
  'ISC', 'MIT', 'MPL-2.0',
]);

function fail(message) { throw new Error(`Lockfile license metadata requires review: ${message}`); }

export function analyzeLockfile(lock, source, rawContent) {
  if (lock?.lockfileVersion !== 3 || !lock.packages || typeof lock.packages !== 'object')
    fail(`${source.path}: expected npm package-lock v3 packages object`);
  if (!lock.packages[''] || typeof lock.packages[''] !== 'object')
    fail(`${source.path}: no root package metadata`);
  const components = [];
  for (const [location, entry] of Object.entries(lock.packages)) {
    if (!location) continue;
    if (!location.startsWith('node_modules/') || !entry || typeof entry !== 'object')
      fail(`${source.path}: unexpected package location ${location}`);
    const name = location.split('node_modules/').at(-1);
    if (!name || !entry.version || typeof entry.version !== 'string')
      fail(`${source.path}: missing name/version at ${location}`);
    if (typeof entry.license !== 'string' || !entry.license.trim())
      fail(`${source.path}: missing license declaration at ${location}`);
    if (!REVIEWED_METADATA_EXPRESSIONS.includes(entry.license))
      fail(`${source.path}: new/unreviewed license expression ${entry.license} at ${location}`);
    if (typeof entry.resolved !== 'string' || !entry.resolved.startsWith('https://registry.npmjs.org/'))
      fail(`${source.path}: non-registry/unreviewed resolved URL at ${location}`);
    if (typeof entry.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/=]+$/.test(entry.integrity))
      fail(`${source.path}: missing/unexpected integrity at ${location}`);
    components.push({
      scope: source.label, location, name, version: entry.version,
      declaredLicense: entry.license, resolved: entry.resolved,
      integrity: entry.integrity, dev: entry.dev === true,
      optional: entry.optional === true,
      licenseTextChecked: false, includedInWindowsArtifact: 'unverified',
    });
  }
  components.sort((a, b) => a.location.localeCompare(b.location, 'en'));
  for (const [name, version] of Object.entries(source.required)) {
    const exact = components.find(x => x.location === `node_modules/${name}`);
    if (!exact || exact.version !== version)
      fail(`${source.path}: required ${name}@${version} changed/missing; repeat upstream license review`);
  }
  if (!components.length) fail(`${source.path}: dependency graph empty`);
  return {
    source: source.path, rootName: lock.packages[''].name,
    lockfileSha256: createHash('sha256').update(rawContent).digest('hex'),
    componentCount: components.length, components,
  };
}

export async function buildInventory(base = repository) {
  const inventories = [];
  for (const source of LOCK_SOURCES) {
    const raw = await readFile(join(base, source.path), 'utf8');
    inventories.push(analyzeLockfile(JSON.parse(raw), source, raw));
  }
  const components = inventories.flatMap(x => x.components);
  const expressions = {};
  for (const { declaredLicense } of components)
    expressions[declaredLicense] = (expressions[declaredLicense] ?? 0) + 1;
  return {
    schema: 'unboundvnc-lockfile-license-metadata/v1',
    classification: 'DEP_METADATA_ONLY_NOT_A_REDISTRIBUTION_CLEARANCE_OR_FULL_SBOM',
    checkpoint: inventories.map(({ source, lockfileSha256, componentCount }) =>
      ({ source, lockfileSha256, componentCount })),
    totalLockfileEntries: components.length,
    declaredLicenseCounts: Object.fromEntries(Object.entries(expressions).sort(([a], [b]) => a.localeCompare(b))),
    components,
    unresolvedPayload: [
      'Electron 45.2.1 native Chromium/Node binaries and their embedded notices',
      'noVNC 1.7.0 MPL-covered source-form availability and file-level notices',
      'Vite output and app.asar/Windows executable actual included-file inventory',
      'exact transitive license text and copyright review (including assets)',
      'Windows installer, signature, certificate identity, SmartScreen and release provenance',
    ],
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  if (mode !== '--check' && mode !== '--json') {
    console.error('Usage: node license-inventory.mjs --check|--json');
    process.exitCode = 2;
  } else {
    try {
      const report = await buildInventory();
      if (mode === '--json') process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      else process.stdout.write(`LOCKFILE METADATA ONLY: ${report.totalLockfileEntries} entries, ${report.checkpoint.length} exact lockfiles; ${report.unresolvedPayload.length} binary/notices/release gates remain. NO REDISTRIBUTION CLEARANCE.\n`);
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
