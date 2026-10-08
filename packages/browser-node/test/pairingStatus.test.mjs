import test from 'node:test';
import assert from 'node:assert/strict';

test('browser node pending state exposes the full approval ID to a reopened popup', async () => {
  const connection = { host: 'http://example.invalid', pairingToken: 'fixture-global', nodeName: 'browser-fixture' };
  const sent = [];
  const messages = [];
  let socket;
  globalThis.chrome = {
    storage: { local: { get: async () => connection } },
    runtime: { sendMessage: async data => { messages.push(data); } },
    notifications: {
      onClicked: { addListener() {} },
      onClosed: { addListener() {} },
    },
  };
  globalThis.WebSocket = class FakeWebSocket {
    static OPEN = 1;
    constructor(url) { this.url = url; this.readyState = 1; socket = this; }
    send(value) { sent.push(JSON.parse(value)); }
    close() { this.readyState = 3; }
  };
  const wsManager = await import('../background/websocket.js');
  try {
    await wsManager.connect();
    socket.onopen();
    assert.equal(sent[0].type, 'pair_request');
    await socket.onmessage({ data: JSON.stringify({ type: 'pair_pending', pendingId: 'pair_fixture_id' }) });
    assert.deepEqual(wsManager.getState(), { state: 'pair_pending', nodeId: null, pendingId: 'pair_fixture_id' });
    assert.equal(messages.at(-1).detail.pendingId, 'pair_fixture_id');
    assert.equal('pairCode' in messages.at(-1).detail, false);
  } finally {
    wsManager.disconnect();
    delete globalThis.chrome;
    delete globalThis.WebSocket;
  }
});