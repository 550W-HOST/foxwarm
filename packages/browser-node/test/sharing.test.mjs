import test from 'node:test';
import assert from 'node:assert/strict';
const event = () => ({ addListener() {} });
const area = () => {
  const state = {};
  return {
    get: async (key) => ({ [key]: structuredClone(state[key]) }),
    set: async (values) => Object.assign(state, structuredClone(values)),
  };
};
test('sharing derives window membership and browser-session origin grants; Ask expires and revalidates', async () => {
  const tabs = new Map([[1, { id: 1, windowId: 10, url: 'https://one.example.org/a' }]]);
  globalThis.chrome = {
    storage: { local: area(), session: area() },
    tabs: { get: async (id) => ({ ...tabs.get(id) }) },
    windows: { get: async (id) => ({ id }) },
    runtime: { getURL: (value) => value, sendMessage: async () => {} },
    action: {},
    notifications: {
      create: async () => {},
      clear: async () => {},
      onClicked: event(),
      onClosed: event(),
    },
  };
  const storage = await import('../background/storage.js'),
    permissions = await import('../background/permissions.js');
  try {
    assert.equal(await permissions.resolvePermission(1), 'off');
    await storage.setWindowPermission(10, 'auto');
    assert.equal(await permissions.resolvePermission(1), 'auto');
    await storage.setDomainPermission('example.org', 'ask');
    assert.equal(await permissions.resolvePermission(1), 'ask');
    await storage.setTabPermission(1, 'off');
    assert.equal(await permissions.resolvePermission(1), 'off');
    await storage.removeTabPermission(1);
    assert.equal(await permissions.resolvePermission(1), 'ask');
    await storage.setTabPermission(1, 'auto');
    tabs.get(1).windowId = 20;
    assert.equal(await permissions.resolvePermission(1), 'auto');
    tabs.get(1).url = 'https://elsewhere.invalid/';
    assert.equal(await permissions.resolvePermission(1), 'off');
    tabs.get(1).windowId = 10;
    assert.equal(await permissions.resolvePermission(1), 'auto');
    await storage.setTabPermission(1, 'off');
    tabs.get(1).url = 'https://third.invalid/';
    assert.equal(await permissions.resolvePermission(1), 'off');
    await storage.removeTabPermission(1);
    tabs.get(1).url = 'chrome://settings/';
    assert.equal(await permissions.resolvePermission(1), 'off');
    // No live tab/window identifiers are persisted in local settings.
    assert.equal((await chrome.storage.local.get('sharing')).sharing, undefined);
    const signal = new AbortController();
    const expired = permissions.requestConfirmation(
      { toolName: 'fill', args: { text: '[hidden]' }, tabId: 1 },
      async () => {},
      signal.signal,
      10,
    );
    assert.equal(await expired, false);
    assert.equal(permissions.getPendingConfirmations().length, 0);
    const stale = permissions.requestConfirmation(
      { toolName: 'click', tabId: 1 },
      async () => {
        throw new Error('Page changed');
      },
      signal.signal,
      1000,
    );
    const id = permissions.getPendingConfirmations()[0].requestId;
    assert.equal(await permissions.respondToConfirmation(id, true), false);
    assert.equal(await stale, false);
    const canceled = permissions.requestConfirmation(
      { toolName: 'click', tabId: 1 },
      async () => {},
      signal.signal,
      1000,
    );
    signal.abort();
    assert.equal(await canceled, false);
    assert.equal(permissions.getPendingConfirmations().length, 0);
  } finally {
    delete globalThis.chrome;
  }
});
