// Copy only audited source and production viewer assets into a fresh package.
import { copyFile, cp, mkdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repository = resolve(packageRoot, '../..');
const output = join(packageRoot, 'runtime');
const viewer = join(repository, 'apps/viewer/dist');
const gateway = join(repository, 'apps/gateway/src/server.mjs');

if (!(await stat(viewer)).isDirectory() || !(await stat(gateway)).isFile()) {
  throw new Error('Run npm ci + npm run build in apps/viewer before preparing desktop assets.');
}
// Fail closed rather than mixing stale files or overwriting an existing tree.
await mkdir(output);
await mkdir(join(output, 'gateway'));
await mkdir(join(output, 'notices'));
await cp(viewer, join(output, 'viewer'), { recursive: true, force: false, errorOnExist: true });
await copyFile(gateway, join(output, 'gateway/server.mjs'));
await copyFile(join(repository, 'LICENSE'), join(output, 'notices/UNBOUNDVNC_LICENSE.txt'));
await copyFile(join(repository, 'THIRD_PARTY_NOTICES.md'), join(output, 'notices/THIRD_PARTY_NOTICES.md'));
process.stdout.write('PREPARED ONLY: production viewer assets and gateway source; no app launched or installed.\n');
