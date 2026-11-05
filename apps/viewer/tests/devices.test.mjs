import assert from 'node:assert/strict';
import test from 'node:test';
import { assertGatewayLocalTarget, describeEndpoint, loadDevices, saveDevices, sortedDevices, validateDevice } from '../src/devices.mjs';

function memoryStorage(initial = new Map()) {
  const entries = new Map(initial);
  return {
    getItem(key) { return entries.has(key) ? entries.get(key) : null; },
    setItem(key, value) { entries.set(key, value); },
  };
}

test('validates a normal RFB connection profile', () => {
  assert.deepEqual(validateDevice({ name: ' Lappy ', host: '192.168.1.23', port: '5900' }), {
    name: 'Lappy', host: '192.168.1.23', port: 5900,
  });
  assert.deepEqual(validateDevice({ name: 'Home', host: '[::1]' }), {
    name: 'Home', host: '[::1]', port: 5900,
  });
});

test('connection routing accepts only the gateway machine, not another device or IPv6 loopback', () => {
  for (const host of ['127.0.0.1', 'localhost']) {
    assert.doesNotThrow(() => assertGatewayLocalTarget(host), host);
  }
  for (const host of ['192.168.1.23', '10.0.0.8', 'example.com', 'lappy.local', '[::1]', 'LOCALHOST']) {
    assert.throws(() => assertGatewayLocalTarget(host), /computer running the gateway/i, host);
  }
  // Saved profile parsing must stay backward compatible: do not silently
  // discard remote profiles merely because this preview cannot dial them yet.
  assert.equal(validateDevice({ name: 'Future remote', host: 'lappy.local', port: 5900 }).host, 'lappy.local');
});

test('rejects URL schemes, paths, empty names, and invalid ports', () => {
  for (const value of [
    { name: '', host: 'localhost', port: 5900 },
    { name: 'Test', host: 'https://localhost', port: 5900 },
    { name: 'Test', host: 'host/path', port: 5900 },
    { name: 'Test', host: 'example..com', port: 5900 },
    { name: 'Test', host: 'localhost', port: 0 },
    { name: 'Test', host: 'localhost', port: 65536 },
    { name: 'Test', host: 'localhost', port: 5900.1 },
  ]) assert.throws(() => validateDevice(value));
});

test('loads only supported unique saved device records', () => {
  const storage = memoryStorage(new Map([
    ['unboundvnc.devices.v1', JSON.stringify([
      { id: 'a', name: 'Lappy', host: 'lappy.local', port: 5900, favorite: true },
      { id: 'a', name: 'Duplicate', host: 'example.com', port: 5900 },
      { id: 'b', name: 'Bad', host: 'http://invalid', port: 5900 },
      { id: 'c', name: 'VN1', host: 'vn1.local', port: 5901, favorite: false, lastConnectedAt: 101 },
    ])],
  ]));
  assert.deepEqual(loadDevices(storage), [
    { id: 'a', name: 'Lappy', host: 'lappy.local', port: 5900, favorite: true, lastConnectedAt: null },
    { id: 'c', name: 'VN1', host: 'vn1.local', port: 5901, favorite: false, lastConnectedAt: 101 },
  ]);
});

test('corrupt browser storage is treated as an empty list', () => {
  assert.deepEqual(loadDevices(memoryStorage(new Map([['unboundvnc.devices.v1', 'not-json']]))), []);
  assert.deepEqual(loadDevices(memoryStorage(new Map([['unboundvnc.devices.v1', '{}']]))), []);
});

test('saves devices without inventing or persisting a password property', () => {
  const storage = memoryStorage();
  const device = { id: 'a', name: 'Test', host: 'test.local', port: 5900, favorite: false, lastConnectedAt: null };
  saveDevices(storage, [{ ...device, password: 'must-not-persist', sessionToken: 'sensitive' }]);
  assert.deepEqual(loadDevices(storage), [device]);
  assert.equal(storage.getItem('unboundvnc.devices.v1').includes('password'), false);
  assert.equal(storage.getItem('unboundvnc.devices.v1').includes('sensitive'), false);
});

test('sorts favorites first, then most recent, then name, without mutating input', () => {
  const originals = [
    { name: 'Charlie', favorite: false, lastConnectedAt: 100 },
    { name: 'Alpha', favorite: true, lastConnectedAt: null },
    { name: 'Bravo', favorite: false, lastConnectedAt: 200 },
  ];
  assert.deepEqual(sortedDevices(originals).map(d => d.name), ['Alpha', 'Bravo', 'Charlie']);
  assert.equal(originals[0].name, 'Charlie');
  assert.equal(describeEndpoint({ host: 'host.local', port: 5903 }), 'host.local:5903');
});
