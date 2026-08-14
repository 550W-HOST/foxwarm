import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalRpcTransport, RpcClient, RpcServiceRegistry } from './rpc';
import { buildSessionWorkerProjection } from './sessionWorkerPersistence';
import { createSessionWorkerPublicationServiceHandler, sessionWorkerPublicationServiceDescriptor, SessionWorkerProjectionRegistry } from './sessionWorkerPublicationService';
import type { Session } from './types';

function projection(id: string) {
  return buildSessionWorkerProjection({ id, history: [], queue: [], meta: {},
    stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null }, currentNode: 'master' } as Session);
}

test('projection registry applies clones in order and fences stale identities and DTOs', async () => {
  const registry = new SessionWorkerProjectionRegistry();
  const first = { sessionId: 'publication-session', generation: 1, incarnationId: 'one' };
  registry.establish(first);
  const order: number[] = [];
  registry.subscribe(async entry => { await Promise.resolve(); order.push(entry.projection!.messageCount); });
  const value = projection(first.sessionId); value.messageCount = 1;
  value.historyVersion = 2;
  await registry.apply(first, value); value.messageCount = 99;
  assert.equal(registry.get(first.sessionId)?.projection?.messageCount, 1); assert.deepEqual(order, [1]);
  assert.equal(registry.get(first.sessionId)?.projection?.historyVersion, 2);
  const returned = registry.get(first.sessionId)!; returned.projection!.messageCount = 88;
  assert.equal(registry.get(first.sessionId)?.projection?.messageCount, 1);
  const accessor: any = projection(first.sessionId); let accessorCalls = 0;
  Object.defineProperty(accessor, 'stats', { enumerable: true, get() { accessorCalls += 1; return {}; } });
  await assert.rejects(() => registry.apply(first, accessor), { code: 'SESSION_WORKER_PUBLICATION_INVALID' });
  assert.equal(accessorCalls, 0);
  await assert.rejects(() => registry.apply(first, { ...projection(first.sessionId), currentNode: 'x'.repeat(129) }),
    { code: 'SESSION_WORKER_PUBLICATION_INVALID' });
  for (const runtimeState of [
    { ...projection(first.sessionId).runtimeState, active: { phase: 'unknown', extra: true } },
    { ...projection(first.sessionId).runtimeState, tool: { name: 'read', startedAt: 'bad' } },
    { ...projection(first.sessionId).runtimeState, tool: { name: 'set_goal', argsPreview: true, startedAt: 1 } },
    { ...projection(first.sessionId).runtimeState, waiting: { waitId: 'w', waitingFor: 'network' } },
  ]) await assert.rejects(() => registry.apply(first, { ...projection(first.sessionId), runtimeState }), { code: 'SESSION_WORKER_PUBLICATION_INVALID' });
  await assert.rejects(() => registry.apply(first, { ...projection(first.sessionId), busy: true }), { code: 'SESSION_WORKER_PUBLICATION_INVALID' });
  await assert.rejects(() => registry.apply(first, { ...projection(first.sessionId), queueLength: 1 }), { code: 'SESSION_WORKER_PUBLICATION_INVALID' });
  await assert.rejects(() => registry.apply(first, { ...projection(first.sessionId), historyVersion: -1 }), { code: 'SESSION_WORKER_PUBLICATION_INVALID' });

  const services = new RpcServiceRegistry();
  services.register(sessionWorkerPublicationServiceDescriptor, createSessionWorkerPublicationServiceHandler({ expected: first, registry }));
  const transport = new LocalRpcTransport(services); const client = new RpcClient(sessionWorkerPublicationServiceDescriptor, transport);
  try {
    await assert.rejects(() => client.call('publishCommitted', { ...first, generation: 2, projection: projection(first.sessionId) }),
      { code: 'SESSION_WORKER_PUBLICATION_SOURCE_MISMATCH' });
    await assert.rejects(() => client.call('publishCommitted', { ...first, projection: { ...projection(first.sessionId), stateRevision: 1 } as any }),
      { code: 'SESSION_WORKER_PUBLICATION_INVALID' });
    assert.equal(registry.get(first.sessionId)?.projection?.messageCount, 1);
  } finally { await transport.drain(); transport.close(); }

  const second = { sessionId: first.sessionId, generation: 2, incarnationId: 'two' };
  registry.establish(second); assert.equal(registry.get(first.sessionId)?.stale, true);
  await assert.rejects(() => registry.apply(first, projection(first.sessionId)), { code: 'SESSION_WORKER_PUBLICATION_STALE' });
  await registry.apply(second, projection(first.sessionId)); assert.equal(registry.get(first.sessionId)?.generation, 2);
  assert.equal(registry.markStale(first), false); assert.equal(registry.markStale(second), true);
  await assert.rejects(() => registry.apply(second, projection(first.sessionId)), { code: 'SESSION_WORKER_PUBLICATION_STALE' });
  assert.equal(registry.clear(first), false); assert.equal(registry.clear(second), true);
});

test('subscriber apply failure marks the exact projection stale', async () => {
  const registry = new SessionWorkerProjectionRegistry(); const identity = { sessionId: 'callback-failure', generation: 1, incarnationId: 'one' };
  registry.establish(identity); registry.subscribe(() => { throw new Error('apply callback failed'); });
  await assert.rejects(() => registry.apply(identity, projection(identity.sessionId)), { code: 'SESSION_WORKER_PUBLICATION_APPLY_FAILED' });
  assert.equal(registry.get(identity.sessionId)?.stale, true);
  await assert.rejects(() => registry.apply(identity, projection(identity.sessionId)), { code: 'SESSION_WORKER_PUBLICATION_STALE' });
});
