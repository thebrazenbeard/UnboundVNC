// Synthetic RFB 3.8-only fixture matching noVNC's RGBX SetPixelFormat.
// Unlike tests/interop/rfb-fixture.mjs (BGRX only), this accepts RGB 0/8/16
// client shifts. It must never be used as a real VNC host.
import { createServer } from 'node:net';
import { writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';

if (process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.RUNNER_ENVIRONMENT !== 'github-hosted' ||
    process.env.RUNNER_OS !== 'Windows' || !process.env.RUNNER_TEMP) {
  throw new Error('Synthetic desktop RFB fixture may run only on hosted Windows Actions.');
}

const diagnostic = join(process.env.RUNNER_TEMP, 'unboundvnc-viewer-fixture-protocol.txt');
const sockets = new Set();
const serverName = Buffer.from('UnboundVNC CI-only synthetic desktop');
const init = Buffer.alloc(24);
init.writeUInt16BE(2, 0); init.writeUInt16BE(2, 2);
init[4] = 32; init[5] = 24; init[6] = 0; init[7] = 1;
for (const offset of [8, 10, 12]) init.writeUInt16BE(255, offset);
init[14] = 0; init[15] = 8; init[16] = 16;
init.writeUInt32BE(serverName.length, 20);
const frame = Buffer.alloc(16 + 16);
frame.writeUInt16BE(1, 2); frame.writeUInt16BE(2, 8); frame.writeUInt16BE(2, 10);
// Raw 2×2 RGBX pixels: red, green, blue, white.
Buffer.from([255, 0, 0, 0, 0, 255, 0, 0, 0, 0, 255, 0, 255, 255, 255, 0]).copy(frame, 16);

const server = createServer(socket => {
  sockets.add(socket);
  socket.once('close', () => sockets.delete(socket));
  socket.write('RFB 003.008\n');
  let stage = 'version';
  let bytes = Buffer.alloc(0);
  const fail = reason => {
    void appendFile(diagnostic, `PROTOCOL_ERROR ${reason}\n`);
    socket.destroy();
  };
  const log = name => void appendFile(diagnostic, `RFB_MESSAGE ${name}\n`);
  socket.on('data', chunk => {
    bytes = Buffer.concat([bytes, chunk]);
    if (bytes.length > 4096) return fail('buffer limit');
    while (bytes.length) {
      let consumed = 0;
      if (stage === 'version') {
        if (bytes.length < 12) return;
        if (bytes.subarray(0, 12).toString() !== 'RFB 003.008\n') return fail('version');
        consumed = 12; socket.write(Buffer.from([1, 1])); stage = 'security';
      } else if (stage === 'security') {
        if (bytes.length < 1) return;
        if (bytes[0] !== 1) return fail('security type');
        consumed = 1; socket.write(Buffer.alloc(4)); stage = 'client-init';
      } else if (stage === 'client-init') {
        if (bytes.length < 1) return;
        consumed = 1; socket.write(Buffer.concat([init, serverName])); stage = 'ready';
      } else if (stage === 'ready') {
        const type = bytes[0];
        if (type === 0) {
          if (bytes.length < 20) return;
          const pf = bytes.subarray(4, 20);
          if (pf[0] !== 32 || pf[1] !== 24 || pf[2] !== 0 || pf[3] !== 1 ||
              pf.readUInt16BE(4) !== 255 || pf.readUInt16BE(6) !== 255 ||
              pf.readUInt16BE(8) !== 255 || pf[10] !== 0 || pf[11] !== 8 || pf[12] !== 16) {
            return fail('unexpected pixel format');
          }
          consumed = 20; log('pixel-format-rgbx');
        } else if (type === 2) {
          if (bytes.length < 4) return;
          const count = bytes.readUInt16BE(2);
          if (count > 128) return fail('too many encodings');
          consumed = 4 + count * 4;
          if (bytes.length < consumed) return;
          log('encodings');
        } else if (type === 3) {
          if (bytes.length < 10) return;
          consumed = 10; log('framebuffer-request'); socket.write(frame);
        } else if (type === 4) {
          if (bytes.length < 8) return;
          consumed = 8; log('key');
        } else if (type === 5) {
          if (bytes.length < 6) return;
          consumed = 6; log('pointer');
        } else if (type === 6) {
          if (bytes.length < 8) return;
          const length = bytes.readUInt32BE(4);
          if (length > 1024) return fail('cut text limit');
          consumed = 8 + length;
          if (bytes.length < consumed) return;
          log('cut-text');
        } else if (type === 150) {
          if (bytes.length < 10) return;
          consumed = 10; log('continuous-updates');
        } else return fail(`message ${type}`);
      } else return fail('invalid stage');
      bytes = bytes.subarray(consumed);
    }
  });
  socket.on('error', () => {});
});
await new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done); });
await writeFile(join(process.env.RUNNER_TEMP, 'unboundvnc-viewer-fixture-port.txt'), String(server.address().port));
process.stdout.write('CI FIXTURE ONLY: RGBX RFB 3.8 on ephemeral IPv4 loopback.\n');
const hold = setInterval(() => {}, 1000);
process.on('SIGTERM', async () => {
  clearInterval(hold);
  for (const socket of sockets) socket.destroy();
  await new Promise(done => server.close(done));
  process.exit(0);
});
