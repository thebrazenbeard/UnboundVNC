import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { startLocalScreenShare } from '../local-screen-share.mjs';

async function withFixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'uvnc-local-share-'));
  try {
    await writeFile(join(root, 'index.html'), '<!doctype html><title>Private local view</title>');
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('real loopback viewer and gateway target only Windows attended host port 5901', async () => {
  await withFixture(async (staticRoot) => {
    let launches = 0, closures = 0;
    let observedKey = null;
    const session = await startLocalScreenShare({ staticRoot, launchHost: async ({ sessionKey }) => {
      observedKey = sessionKey;
      launches++;
      return { close: async () => { closures++; } };
    } });
    try {
      const url = new URL(session.url);
      assert.equal(url.hostname, '127.0.0.1');
      assert.equal(launches, 1);
      assert.match(observedKey, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(session.url.includes(observedKey), false);
      const page = await fetch(session.url);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /Private local view/);
      const health = await fetch(new URL('/api/health', session.url));
      assert.equal((await health.json()).remoteAccess, false);
      const ticket = (host, port) => fetch(new URL('/api/sessions', session.url), {
        method: 'POST',
        headers: { Origin: url.origin, 'content-type': 'application/json' },
        body: JSON.stringify({ host, port }),
      });
      assert.equal((await ticket('127.0.0.1', 5901)).status, 201);
      assert.equal((await ticket('127.0.0.1', 5900)).status, 403);
      assert.equal((await ticket('192.0.2.44', 5901)).status, 400);
    } finally {
      await session.close();
      await session.close();
    }
    assert.equal(closures, 1);
    await assert.rejects(fetch(session.url));
  });
});

test('failed host launch closes previously created local viewer', async () => {
  await withFixture(async (staticRoot) => {
    await assert.rejects(startLocalScreenShare({
      staticRoot,
      launchHost: async () => { throw new Error('synthetic host unavailable'); },
    }), /synthetic host unavailable/);
  });
});

test('missing build assets cannot launch any host process', async () => {
  let launches = 0;
  await assert.rejects(startLocalScreenShare({
    staticRoot: join(tmpdir(), 'uvnc-nonexistent-assets-3dc417c6'),
    launchHost: async () => { launches++; return { close: async () => {} }; },
  }));
  assert.equal(launches, 0);
});

test('a local host handle is mandatory and cannot be silently omitted', async () => {
  await withFixture(async (staticRoot) => {
    await assert.rejects(startLocalScreenShare({ staticRoot }), /launchHost/);
  });
});
test('rejects an occupied host port rather than proxying another service', async (t) => {
  const blocker = createServer();
  try {
    await new Promise((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen(5901, '127.0.0.1', resolve);
    });
  } catch (error) {
    if (error.code === 'EADDRINUSE') {
      t.skip('5901 already in use by a local service');
      return;
    }
    throw error;
  }
  try {
    await withFixture(async (staticRoot) => {
      let launches = 0;
      await assert.rejects(startLocalScreenShare({
        staticRoot,
        launchHost: async () => { launches++; return { close: async () => {} }; },
      }), /5901|occupied|listening/i);
      assert.equal(launches, 0);
    });
  } finally {
    await new Promise(resolve => blocker.close(resolve));
  }
});