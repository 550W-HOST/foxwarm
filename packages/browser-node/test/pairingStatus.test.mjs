import test from 'node:test';
import assert from 'node:assert/strict';

function area() {
  const values = {};
  return {
    get: async (key) =>
      key == null
        ? { ...values }
        : Object.fromEntries(
            (Array.isArray(key) ? key : [key]).map((name) => [name, values[name]]),
          ),
    set: async (data) => Object.assign(values, structuredClone(data)),
  };
}
const event = () => ({ addListener() {} });
test('connection intent, target-bound credentials and stale pairing use the current Main only', async () => {
  const sockets = [],
    broadcasts = [];
  globalThis.chrome = {
    storage: { local: area(), session: area() },
    runtime: {
      sendMessage: async (message) => {
        broadcasts.push(message);
      },
    },
    debugger: { onDetach: event(), onEvent: event() },
    notifications: { onClicked: event(), onClosed: event() },
  };
  globalThis.WebSocket = class {
    static OPEN = 1;
    constructor(url) {
      this.url = url;
      this.readyState = 1;
      this.sent = [];
      sockets.push(this);
    }
    send(text) {
      this.sent.push(JSON.parse(text));
    }
    close() {
      this.readyState = 3;
    }
  };
  const storage = await import('../background/storage.js');
  const ws = await import('../background/websocket.js');
  try {
    await storage.saveConnectionConfig(
      'http://example.invalid/first/',
      'bootstrap-first',
      'browser',
    );
    await ws.connect();
    const first = sockets.at(-1);
    first.onopen();
    await first.onmessage({
      data: JSON.stringify({ type: 'pair_pending', pendingId: 'pending-full-id' }),
    });
    assert.equal(ws.getState().pendingId, 'pending-full-id');
    await first.onmessage({
      data: JSON.stringify({
        type: 'pair_approved',
        nodeId: 'browser',
        authToken: 'first-only-secret',
      }),
    });
    assert.equal((await storage.getConnection()).pairingToken, '');
    await ws.disconnect();
    assert.equal((await storage.getConnection()).enabled, false);
    const stoppedCount = sockets.length;
    await ws.connect();
    assert.equal(sockets.length, stoppedCount);
    await storage.saveConnectionConfig(
      'http://example.invalid/second',
      'bootstrap-second',
      'browser',
    );
    assert.equal((await storage.getConnection()).authToken, undefined);
    await ws.connect();
    const second = sockets.at(-1);
    second.onopen();
    assert(second.url.includes('/second/node_ws?token=bootstrap-second'));
    assert(!second.url.includes('first-only-secret'));
    // A late approval from a retired socket cannot write into the new connection.
    await first.onmessage({
      data: JSON.stringify({
        type: 'pair_approved',
        nodeId: 'old-browser',
        authToken: 'late-secret',
      }),
    });
    assert.equal((await storage.getConnection()).authToken, undefined);
    await ws.resetAndDisconnect();
    const forgottenCount = sockets.length;
    await ws.connect();
    assert.equal(sockets.length, forgottenCount);
    assert.equal((await storage.getConnection()).pairingToken, undefined);
    await assert.rejects(
      storage.saveCredentials('http://example.invalid/second', 'late', 'late-secret'),
    );
    assert(!JSON.stringify(broadcasts).includes('first-only-secret'));
  } finally {
    await ws.disconnect();
    delete globalThis.chrome;
    delete globalThis.WebSocket;
  }
});

test('completed sharing revocation cancels a targetless listing across an independent settings read', async () => {
  let handler, socket, response;
  const tab = { id: 1, windowId: 10, url: 'https://page.invalid/shared', title: 'Shared' };
  globalThis.chrome = {
    storage: { local: area(), session: area() },
    runtime: {
      onMessage: {
        addListener(listener) {
          handler = listener;
        },
      },
      onStartup: event(),
      sendMessage: async () => {},
    },
    alarms: { create() {}, onAlarm: event() },
    debugger: { onDetach: event(), onEvent: event() },
    notifications: { onClicked: event(), onClosed: event() },
    tabs: {
      get: async () => ({ ...tab }),
      query: async () => [{ ...tab }],
      onUpdated: event(),
      onDetached: event(),
      onAttached: event(),
      onRemoved: event(),
    },
    windows: { onRemoved: event() },
  };
  globalThis.WebSocket = class {
    static OPEN = 1;
    constructor() {
      socket = this;
      this.readyState = 1;
    }
    send(text) {
      const message = JSON.parse(text);
      if (message.callId) response(message);
    }
    close() {
      this.readyState = 3;
    }
  };
  const storage = await import('../background/storage.js');
  const ws = await import('../background/websocket.js');
  await import('../background/main.js');
  const popup = (message) => new Promise((resolve) => handler(message, {}, resolve));
  let release;
  try {
    await storage.saveConnectionConfig('https://main.invalid', 'synthetic-bootstrap', 'browser');
    await storage.saveCredentials('https://main.invalid', 'browser', 'synthetic-credential');
    await ws.connect();
    socket.onopen();
    await socket.onmessage({ data: JSON.stringify({ type: 'registered', nodeId: 'browser' }) });
    assert.equal(
      (await popup({ type: 'set_tab_permission', tabId: tab.id, level: 'auto' })).success,
      true,
    );

    // Capture real mock storage values without changing them, then hold only
    // the independent local response while the earlier session read completes.
    const localGet = chrome.storage.local.get.bind(chrome.storage.local);
    const sessionGet = chrome.storage.session.get.bind(chrome.storage.session);
    let held, captured;
    const readHeld = new Promise((resolve) => {
      held = resolve;
    });
    const sharingCaptured = new Promise((resolve) => {
      captured = resolve;
    });
    const blocked = new Promise((resolve) => {
      release = resolve;
    });
    chrome.storage.local.get = async (key) => {
      if (key !== 'sites') return localGet(key);
      chrome.storage.local.get = localGet;
      const value = structuredClone(await localGet(key));
      held();
      await blocked;
      return value;
    };
    chrome.storage.session.get = async (key) => {
      if (key !== 'sharing') return sessionGet(key);
      chrome.storage.session.get = sessionGet;
      const value = structuredClone(await sessionGet(key));
      captured();
      return value;
    };
    const listing = new Promise((resolve) => {
      response = resolve;
    });
    await socket.onmessage({
      data: JSON.stringify({
        type: 'tool_call',
        callId: 'listing',
        tool: 'list_tabs',
        args: {},
        sessionId: 'synthetic-session',
        agentName: 'synthetic-agent',
        timeoutMs: 5000,
      }),
    });
    await Promise.all([readHeld, sharingCaptured]);
    assert.equal(
      (await popup({ type: 'set_tab_permission', tabId: tab.id, level: 'off' })).success,
      true,
    );
    assert.equal((await popup({ type: 'resolve_permission', tabId: tab.id })).level, 'off');
    // This private metadata exists only after the completed revoke.
    tab.url = 'https://page.invalid/private?secret=AFTER-REVOCATION';
    tab.title = 'AFTER-REVOCATION';
    release();
    const result = await listing;
    assert.equal(result.type, 'tool_call_error');
    assert(!JSON.stringify(result).includes('AFTER-REVOCATION'));
    assert.equal(ws.getState().state, 'registered');
  } finally {
    release?.();
    await ws.disconnect();
    delete globalThis.chrome;
    delete globalThis.WebSocket;
  }
});
