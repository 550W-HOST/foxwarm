import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type http from 'node:http';
import { WebUiRealtimeHub, type WebUiRealtimeEnvelope } from './webuiRealtime';

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

function makeHub(options: { authorized?: boolean; stateGate?: Promise<void> } = {}) {
  const subscriptionChanges: string[] = [];
  const hub = new WebUiRealtimeHub({
    checkToken: () => options.authorized !== false,
    resolveIds: ids => ({
      canonicalIds: ids.filter(id => id !== 'missing').map(id => id === 'alias' ? 'agent/main' : id),
      missingIds: ids.filter(id => id === 'missing'),
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
    onSessionSubscriptionChanged: sessionId => subscriptionChanges.push(sessionId),
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
  assert.deepEqual(socket.sent.at(-1), { type: 'subscriptions-applied', revision: 2 });

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
  assert.deepEqual(socket.sent, [{ type: 'connected' }]);
  release();
  await flush();

  assert.deepEqual(socket.sent.slice(1), [
    { type: 'session-state', sessionId: 'agent/main', session: { id: 'agent/main' } },
    { type: 'message', message: { text: 'live' }, sessionId: 'agent/main' },
    { type: 'subscriptions-applied', revision: 1 },
  ]);
});
