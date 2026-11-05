// Never use on a workstation: dedicated ephemeral hosted-CI RFB 3.8 fixture.
import { writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRfbFixture } from '../../../tests/interop/rfb-fixture.mjs';

if (process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.RUNNER_ENVIRONMENT !== 'github-hosted' ||
    process.env.RUNNER_OS !== 'Windows' || !process.env.RUNNER_TEMP) {
  throw new Error('Synthetic desktop RFB fixture may run only on hosted Windows Actions.');
}
const fixture = await createRfbFixture().start();
const diagnostic = join(process.env.RUNNER_TEMP, 'unboundvnc-viewer-fixture-protocol.txt');
fixture.events.on('protocolError', (_connection, error) => {
  void appendFile(diagnostic, `PROTOCOL_ERROR ${String(error.message).slice(0, 160)}\n`);
});
fixture.events.on('message', (_connection, message) => {
  void appendFile(diagnostic, `RFB_MESSAGE ${message.type}\n`);
});
await writeFile(join(process.env.RUNNER_TEMP, 'unboundvnc-viewer-fixture-port.txt'), String(fixture.port));
process.stdout.write('CI FIXTURE ONLY: synthetic RFB server started on ephemeral IPv4 loopback.\n');
// Process is owned by the one workflow step, which stops its exact PID in finally.
const hold = setInterval(() => {}, 1000);
process.on('SIGTERM', async () => { clearInterval(hold); await fixture.close(); process.exit(0); });
