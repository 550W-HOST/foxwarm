import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { once } from 'node:events';
import net from 'node:net';
import type http from 'node:http';
import { WebSocket } from 'ws';
import { HttpServer } from '../httpServer';
import { WEBUI_REALTIME_PATH, WebUiRealtimeHub, type WebUiRealtimeEnvelope } from './webuiRealtime';

class FakeSocket extends EventEmitter {
  readyState = 1;
  sent: WebUiRealtimeEnvelope[] = [];
  closes: Array<{ code?: number; reason?: string }> = [];
  pingCount = 0;

  send(value: string): void {
    this.sent.push(JSON.parse(value));
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
    this.readyState = 3;
    this.emit('close');
  }

  ping(): void {
    this.pingCount += 1;
  }

  receive(payload: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(payload)));
  }
}

function flush(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

async function getFreePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

function makeHub(options: { authorized?: boolean; stateGate?: Promise<void> } = {}) {
  const subscriptionChanges: string[] = [];
  const hub = new WebUiRealtimeHub({
    checkToken: () => options.authorized !== false,
    resolveIds: ids => ({
      canonicalIds: ids.filter(id => id !== 'missing').map(id => id === 'alias' ? 'agent/main' : id),
      missingIds: ids.filter(id => id === 'missing'),
      requestedToCanonical: Object.fromEntries(ids.filter(id => id !== 'missing').map(id => [id, id === 'alias' ? 'agent/main' : id])),
    }),
    loadSessionState: async sessionId => {
      await options.stateGate;
      return { type: 'session-state', sessionId, session: { id: sessionId } };
    },
    loadSessionList: async requestedIds => ({
      type: 'session-list-delta',
      sessions: requestedIds.filter(id => id !== 'missing').map(id => ({ id: id === 'alias' ? 'agent/main' : id })),
      deletedIds: requestedIds.filter(id => id === 'missing'),
    }),
    onSessionSubscriptionChanged: sessionId => { subscriptionChanges.push(sessionId); },
    keepaliveIntervalMs: 60_000,
  });
  return { hub, subscriptionChanges };
}

test('WebUiRealtimeHub rejects unauthorized sockets', async () => {
  const { hub } = makeHub({ authorized: false });
  const socket = new FakeSocket();
  await hub.handleConnection(socket as any, {} as http.IncomingMessage);
  assert.deepEqual(socket.closes, [{ code: 1008, reason: 'Unauthorized' }]);
  assert.equal(hub.getConnectionCount(), 0);
});

test('WebUiRealtimeHub multiplexes list and session subscriptions on one socket', async () => {
  const { hub, subscriptionChanges } = makeHub();
  const socket = new FakeSocket();
  await hub.handleConnection(socket as any, {} as http.IncomingMessage);
  assert.deepEqual(socket.sent, [{ type: 'connected' }]);

  socket.receive({
    type: 'set-subscriptions',
    revision: 1,
    sessionListActive: true,
    sessionListIds: ['alias', 'missing'],
    sessionIds: ['alias'],
  });
  await flush();

  assert.equal(hub.getConnectionCount(), 1);
  assert.equal(hub.hasSessionSubscribers('agent/main'), true);
  assert.deepEqual(subscriptionChanges, ['agent/main']);
  assert.deepEqual(socket.sent.slice(1), [
    { type: 'subscriptions-accepted', revision: 1, sessionListResolutions: { alias: 'agent/main' }, sessionResolutions: { alias: 'agent/main' } },
    { type: 'session-list-delta', sessions: [{ id: 'agent/main' }], deletedIds: ['missing'] },
    { type: 'session-state', sessionId: 'agent/main', session: { id: 'agent/main' } },
    { type: 'subscriptions-applied', revision: 1 },
  ]);

  hub.broadcastSession('agent/main', { type: 'message', message: { role: 'model' } });
  hub.broadcastSessionListDelta('agent/main', { type: 'session-list-delta', sessions: [{ id: 'agent/main', busy: true }], deletedIds: [] });
  hub.broadcastSessionListInvalidation({ type: 'sessions-updated', eventId: 4 });
  assert.deepEqual(socket.sent.slice(-3), [
    { type: 'message', message: { role: 'model' }, sessionId: 'agent/main' },
    { type: 'session-list-delta', sessions: [{ id: 'agent/main', busy: true }], deletedIds: [] },
    { type: 'sessions-updated', eventId: 4 },
  ]);

  socket.receive({ type: 'set-subscriptions', revision: 2, sessionListActive: false, sessionListIds: [], sessionIds: [] });
  await flush();
  assert.equal(hub.hasSessionSubscribers('agent/main'), false);
  assert.deepEqual(subscriptionChanges, ['agent/main', 'agent/main']);
  assert.deepEqual(socket.sent.slice(-2), [
    { type: 'subscriptions-accepted', revision: 2, sessionListResolutions: {}, sessionResolutions: {} },
    { type: 'subscriptions-applied', revision: 2 },
  ]);

  socket.emit('close');
  assert.equal(hub.getConnectionCount(), 0);
});

test('WebUiRealtimeHub buffers live events behind the subscription snapshot', async () => {
  let release!: () => void;
  const stateGate = new Promise<void>(resolve => { release = resolve; });
  const { hub } = makeHub({ stateGate });
  const socket = new FakeSocket();
  await hub.handleConnection(socket as any, {} as http.IncomingMessage);
  socket.receive({ type: 'set-subscriptions', revision: 1, sessionListActive: false, sessionListIds: [], sessionIds: ['agent/main'] });
  await flush();

  hub.broadcastSession('agent/main', { type: 'message', message: { text: 'live' } });
  assert.deepEqual(socket.sent, [
    { type: 'connected' },
    { type: 'subscriptions-accepted', revision: 1, sessionListResolutions: {}, sessionResolutions: { 'agent/main': 'agent/main' } },
  ]);
  release();
  await flush();

  assert.deepEqual(socket.sent.slice(2), [
    { type: 'session-state', sessionId: 'agent/main', session: { id: 'agent/main' } },
    { type: 'message', message: { text: 'live' }, sessionId: 'agent/main' },
    { type: 'subscriptions-applied', revision: 1 },
  ]);
});

test('WebUiRealtimeHub sends the owner draft snapshot before buffered deltas', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const hub = new WebUiRealtimeHub({
    checkToken: () => true,
    resolveIds: ids => ({ canonicalIds: ids, missingIds: [], requestedToCanonical: Object.fromEntries(ids.map(id => [id, id])) }),
    loadSessionState: async sessionId => ({ type: 'session-state', sessionId, session: { id: sessionId } }),
    loadModelStreamSnapshot: async sessionId => {
      await gate;
      return { type: 'model-stream-snapshot', sessionId, draft: { streamId: 's', iteration: 1, sequence: 2, text: 'hello', reasoning: '', toolCalls: [] } };
    },
    loadSessionList: async () => ({ type: 'session-list-delta', sessions: [], deletedIds: [] }),
  });
  const socket = new FakeSocket();
  await hub.handleConnection(socket as any, {} as http.IncomingMessage);
  socket.receive({ type: 'set-subscriptions', revision: 1, sessionListActive: false, sessionListIds: [], sessionIds: ['agent/main'] });
  await flush();
  hub.broadcastSession('agent/main', { type: 'session-event', event: { type: 'model-stream-update', streamVersion: 2, streamId: 's', sequence: 2, textDelta: { offset: 3, text: 'lo' } } });
  hub.broadcastSession('agent/main', { type: 'session-event', event: { type: 'model-stream-update', streamVersion: 2, streamId: 's', sequence: 3, textDelta: { offset: 5, text: '!' } } });
  release();
  await flush();
  const snapshotIndex = socket.sent.findIndex(message => message.type === 'model-stream-snapshot');
  const deltaIndex = socket.sent.findIndex(message => message.type === 'session-event');
  assert.ok(snapshotIndex >= 0 && snapshotIndex < deltaIndex);
  assert.deepEqual(socket.sent.filter(message => message.type === 'session-event').map(message => (message.event as any).sequence), [2, 3]);
});

test('WebUiRealtimeHub discards a superseded async subscription snapshot', async () => {
  let release!: () => void;
  const stateGate = new Promise<void>(resolve => { release = resolve; });
  const { hub } = makeHub({ stateGate });
  const socket = new FakeSocket();
  await hub.handleConnection(socket as any, {} as http.IncomingMessage);
  socket.receive({ type: 'set-subscriptions', revision: 1, sessionListActive: false, sessionListIds: [], sessionIds: ['first'] });
  await flush();
  socket.receive({ type: 'set-subscriptions', revision: 2, sessionListActive: false, sessionListIds: [], sessionIds: ['second'] });
  release();
  await flush();
  await flush();

  assert.equal(socket.sent.some(message => message.type === 'session-state' && message.sessionId === 'first'), false);
  assert.equal(socket.sent.some(message => message.type === 'subscriptions-applied' && message.revision === 1), false);
  assert.equal(socket.sent.some(message => message.type === 'session-state' && message.sessionId === 'second'), true);
  assert.deepEqual(socket.sent.at(-1), { type: 'subscriptions-applied', revision: 2 });
});

test('WebUiRealtimeHub carries buffered live events into a superseding revision', async () => {
  let release!: () => void;
  const stateGate = new Promise<void>(resolve => { release = resolve; });
  const { hub } = makeHub({ stateGate });
  const socket = new FakeSocket();
  await hub.handleConnection(socket as any, {} as http.IncomingMessage);
  socket.receive({ type: 'set-subscriptions', revision: 1, sessionListActive: false, sessionListIds: [], sessionIds: ['agent/main'] });
  await flush();
  hub.broadcastSession('agent/main', { type: 'message', message: { text: 'live during revision one' } });
  socket.receive({ type: 'set-subscriptions', revision: 2, sessionListActive: true, sessionListIds: ['list/changed'], sessionIds: ['agent/main'] });
  release();
  await flush();
  await flush();

  assert.equal(socket.sent.some(message => message.type === 'subscriptions-applied' && message.revision === 1), false);
  assert.equal(socket.sent.filter(message => message.type === 'message' && (message.message as any)?.text === 'live during revision one').length, 1);
  assert.deepEqual(socket.sent.at(-1), { type: 'subscriptions-applied', revision: 2 });
});

test('WebUiRealtimeHub authenticates through the real HTTP WebSocket upgrade path', async () => {
  const port = await getFreePort();
  const server = new HttpServer(port, 'upgrade-secret');
  const hub = new WebUiRealtimeHub({
    checkToken: req => server.checkIncomingToken(req),
    resolveIds: ids => ({ canonicalIds: ids, missingIds: [], requestedToCanonical: Object.fromEntries(ids.map(id => [id, id])) }),
    loadSessionState: async sessionId => ({ type: 'session-state', sessionId, session: { id: sessionId } }),
    loadSessionList: async () => ({ type: 'session-list-delta', sessions: [], deletedIds: [] }),
    keepaliveIntervalMs: 60_000,
  });
  server.addWebSocket(WEBUI_REALTIME_PATH, async (socket, req) => hub.handleConnection(socket, req));
  await server.start();

  const socket = new WebSocket(`ws://127.0.0.1:${port}${WEBUI_REALTIME_PATH}`, { headers: { Cookie: 'foxwarm_token=upgrade-secret' } });
  const received: WebUiRealtimeEnvelope[] = [];
  socket.on('message', raw => received.push(JSON.parse(raw.toString())));
  try {
    await once(socket, 'open');
    socket.send(JSON.stringify({ type: 'set-subscriptions', revision: 1, sessionListActive: false, sessionListIds: [], sessionIds: ['agent/main'] }));
    for (let attempt = 0; attempt < 50 && !received.some(message => message.type === 'subscriptions-applied'); attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(received.some(message => message.type === 'connected'), true);
    assert.equal(received.some(message => message.type === 'session-state' && message.sessionId === 'agent/main'), true);
    assert.equal(received.some(message => message.type === 'subscriptions-applied' && message.revision === 1), true);
  } finally {
    socket.close();
    await once(socket, 'close').catch(() => {});
    await server.stop();
  }
});
