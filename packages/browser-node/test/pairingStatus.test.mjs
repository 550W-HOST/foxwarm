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
