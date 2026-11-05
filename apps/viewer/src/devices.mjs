export const STORAGE_KEY = 'unboundvnc.devices.v1';

const HOST_PATTERN = /^(?=.{1,253}$)[a-zA-Z0-9_.:\-[\]]+$/;

export function validateDevice(input) {
  const name = String(input?.name ?? '').trim();
  const host = String(input?.host ?? '').trim();
  const port = Number(input?.port ?? 5900);

  if (!name || name.length > 64) throw new Error('Name must contain 1–64 characters.');
  if (!HOST_PATTERN.test(host) || host.includes('..')) {
    throw new Error('Enter a hostname or IP address without a scheme or path.');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Port must be between 1 and 65535.');
  }
  return { name, host, port };
}

export function normalizeDevice(input) {
  if (!input || typeof input !== 'object' || typeof input.id !== 'string') return null;
  try {
    const valid = validateDevice(input);
    return {
      id: input.id,
      ...valid,
      favorite: input.favorite === true,
      lastConnectedAt: Number.isFinite(input.lastConnectedAt) && input.lastConnectedAt >= 0
        ? input.lastConnectedAt : null,
    };
  } catch {
    return null;
  }
}

export function loadDevices(storage) {
  try {
    const parsed = JSON.parse(storage.getItem(STORAGE_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    const seen = new Set();
    return parsed.map(normalizeDevice).filter(device => {
      if (!device || seen.has(device.id)) return false;
      seen.add(device.id);
      return true;
    }).slice(0, 1000);
  } catch {
    return [];
  }
}

export function saveDevices(storage, devices) {
  // Only persist the approved profile schema, never accidental credentials.
  storage.setItem(STORAGE_KEY, JSON.stringify(devices.map(normalizeDevice).filter(Boolean)));
}

export function sortedDevices(devices) {
  return [...devices].sort((a, b) =>
    Number(b.favorite) - Number(a.favorite)
    || (b.lastConnectedAt ?? 0) - (a.lastConnectedAt ?? 0)
    || a.name.localeCompare(b.name)
  );
}

export function describeEndpoint(device) {
  return `${device.host}:${device.port}`;
}
