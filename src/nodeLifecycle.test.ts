import test from 'node:test';
import assert from 'node:assert/strict';

import * as nodeExecution from './nodeExecution';
import { createNodeExecutionServiceHandler, nodeExecutionServiceDescriptor } from './nodeExecutionService';
import { LocalRpcTransport, RpcServiceRegistry } from './rpc';
import * as sessionManager from './sessionManager';
import { callTool } from './tools';
import { tool_call_tool } from './tools/unifiedSearch';
import { tool_run_script } from './toolscript';
import {
  MasterNodeProvider,
  NodeProviderRegistry,
  type NodeDescriptor,
  type NodeLifecycleNodeRequest,
  type NodeLifecycleProviderRequest,
  type NodeLifecycleResult,
  type NodeProvider,
  NodeProviderError,
} from './nodes/providerRegistry';

function id(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function descriptor(nodeId: string, provider = 'lifecycle-fixture'): NodeDescriptor {
  return {
    id: nodeId,
    kind: 'sandbox',
    provider,
    type: 'lifecycle-fixture',
    availability: 'ready',
    defaultCwd: `fixture://${nodeId}/root`,
    tools: [{ name: 'read', parameters: { type: 'object' } }],
  };
}

function lifecycleProvider(options: {
  id?: string;
  initial?: string[];
  omit?: Array<'create' | 'ensure' | 'inspect' | 'destroy'>;
  mismatch?: 'inspect' | 'destroy';
  calls?: any[];
} = {}): NodeProvider {
  const providerId = options.id || 'lifecycle-fixture';
  const nodes = new Map((options.initial || ['managed-node']).map(nodeId => [nodeId, descriptor(nodeId, providerId)]));
  const calls = options.calls || [];
  const provider: NodeProvider = {
    id: providerId,
    listNodes: () => [...nodes.values()],
    getNode: nodeId => nodes.get(nodeId),
    invokeTool: async () => ({ output: 'unused' }),
  };
  if (!options.omit?.includes('create')) provider.createNode = async (request: NodeLifecycleProviderRequest): Promise<NodeLifecycleResult> => {
    calls.push(['create', request]);
    const nodeId = request.nodeId || 'created-node';
    const node = descriptor(nodeId, providerId); nodes.set(nodeId, node);
    return { node, effect: 'Fixture registered the Node.', dataRetention: 'Fixture retains test memory only.', details: { request } };
  };
  if (!options.omit?.includes('ensure')) provider.ensureNode = async (request: NodeLifecycleProviderRequest): Promise<NodeLifecycleResult> => {
    calls.push(['ensure', request]);
    const nodeId = request.nodeId || 'ensured-node';
    const node = nodes.get(nodeId) || descriptor(nodeId, providerId); nodes.set(nodeId, node);
    return { node, effect: 'Fixture ensured the Node.', details: { request } };
  };
  if (!options.omit?.includes('inspect')) provider.inspectNode = async (request: NodeLifecycleNodeRequest): Promise<NodeLifecycleResult> => {
    calls.push(['inspect', request]);
    return { node: descriptor(options.mismatch === 'inspect' ? 'wrong-node' : request.nodeId, providerId), details: { request } };
  };
  if (!options.omit?.includes('destroy')) provider.destroyNode = async (request: NodeLifecycleNodeRequest): Promise<NodeLifecycleResult> => {
    calls.push(['destroy', request]);
    nodes.delete(request.nodeId);
    return {
      nodeId: options.mismatch === 'destroy' ? 'wrong-node' : request.nodeId,
      effect: 'Fixture removed its registration.',
      dataRetention: 'Fixture does not claim external data deletion.',
      details: { request },
    };
  };
  return provider;
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function controlledProvider(providerId: string, initial: string[] = []) {
  const nodes = new Map(initial.map(nodeId => [nodeId, descriptor(nodeId, providerId)]));
  const provider: NodeProvider = {
    id: providerId,
    listNodes: () => [...nodes.values()],
    getNode: nodeId => nodes.get(nodeId),
    invokeTool: async () => ({ output: 'unused' }),
  };
  return { provider, nodes };
}

async function install(registry: NodeProviderRegistry, expectedSourceSessionId?: string): Promise<LocalRpcTransport> {
  await nodeExecution.shutdownNodeExecution().catch(() => {});
  nodeExecution.resetNodeExecutionForTests();
  const services = new RpcServiceRegistry();
  services.register(nodeExecutionServiceDescriptor, createNodeExecutionServiceHandler({
    providerRegistry: registry,
    ...(expectedSourceSessionId ? { expectedSourceSessionId } : {}),
  }));
  const transport = new LocalRpcTransport(services);
  await nodeExecution.initializeNodeExecution({ transport, placement: 'child-reverse' });
  return transport;
}

async function cleanup(transport: LocalRpcTransport | undefined, ...sessionIds: string[]): Promise<void> {
  await nodeExecution.shutdownNodeExecution().catch(() => {});
  nodeExecution.resetNodeExecutionForTests();
  if (transport) {
    await transport.drain().catch(() => {});
    transport.close();
  }
  for (const sessionId of sessionIds) await sessionManager.deleteSession(sessionId).catch(() => false);
}

test('node lifecycle uses exact provider/node routing, confirmation, and provider-described results in Main-local placement', async () => {
  const sourceId = id('lifecycle-main');
  const session = await sessionManager.getSession(sourceId);
  const calls: any[] = [];
  const provider = lifecycleProvider({ calls });
  let transport: LocalRpcTransport | undefined;
  try {
    transport = await install(new NodeProviderRegistry([new MasterNodeProvider(), provider]));
    const ctx: any = { sessionId: sourceId, session, sessionPlacement: 'local' };

    const listed = String(await callTool('node', { action: 'list' }, ctx));
    assert.match(listed, /Lifecycle providers:/);
    assert.match(listed, /`lifecycle-fixture` \(create, ensure, inspect, destroy\)/);

    const created: any = await callTool('node', {
      action: 'create', providerId: 'lifecycle-fixture', nodeId: 'created-a', parameters: { opaque: { value: 1 } },
    }, ctx);
    assert.equal(created.node.id, 'created-a');
    assert.equal(created.effect, 'Fixture registered the Node.');
    assert.deepEqual(calls[0][1], {
      sourceSessionId: sourceId,
      nodeId: 'created-a',
      parameters: { opaque: { value: 1 } },
      context: { agent: 'main' },
    });
    assert.equal(Object.prototype.hasOwnProperty.call(calls[0][1], 'confirmation'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(calls[0][1], 'providerConfig'), false);

    const ensured: any = await tool_call_tool({
      source: 'builtin', name: 'node', args: {
        action: 'ensure', providerId: 'lifecycle-fixture', nodeId: 'ensured-a', parametersJson: '{"flavor":"ensure"}',
      },
    }, ctx);
    assert.equal(ensured.node.id, 'ensured-a');

    const generated: any = await tool_run_script({
      code: 'def main(args):\n    return call_tool(source="builtin", name="node", args=args)',
      args: { action: 'create', providerId: 'lifecycle-fixture', parameters: { generated: true } },
    }, ctx);
    assert.equal(generated.status, 'completed');
    assert.equal(generated.result.node.id, 'created-node');

    const inspected: any = await tool_call_tool({
      source: 'builtin', name: 'node', args: { action: 'inspect', nodeId: 'created-a', parameters: { verbose: true } },
    }, ctx);
    assert.equal(inspected.node.id, 'created-a');
    assert.equal(inspected.details.request.nodeId, 'created-a');

    const callsBeforeBadConfirmation = calls.length;
    await assert.rejects(
      () => callTool('node', { action: 'create', providerId: 'lifecycle-fixture', confirmation: 'not-accepted', parameters: {} }, ctx),
      /does not accept confirmation/,
    );
    await assert.rejects(
      () => callTool('node', { action: 'inspect', nodeId: 'created-a', providerId: 'lifecycle-fixture' }, ctx),
      /does not accept providerId/,
    );
    await assert.rejects(
      () => callTool('node', { action: 'destroy', nodeId: 'created-a', confirmation: 'destroy created-a' }, ctx),
      (error: any) => error?.code === 'NODE_LIFECYCLE_CONFIRMATION_REQUIRED',
    );
    assert.equal(calls.length, callsBeforeBadConfirmation);

    const destroyed: any = await tool_run_script({
      code: 'def main(args):\n    return call_tool(source="builtin", name="node", args=args)',
      args: { action: 'destroy', nodeId: 'created-a', confirmation: 'destroy node created-a', parameters: { force: false } },
    }, ctx);
    assert.equal(destroyed.status, 'completed');
    assert.equal(destroyed.result.nodeId, 'created-a');
    assert.match(destroyed.result.dataRetention, /does not claim/);
    assert.equal(calls.at(-1)[0], 'destroy');
  } finally {
    await cleanup(transport, sourceId);
  }
});

test('lifecycle rejects unsupported providers, duplicate result identities, and mismatched inspect/destroy descriptors', async () => {
  const sourceId = id('lifecycle-guards');
  const session = await sessionManager.getSession(sourceId);
  let transport: LocalRpcTransport | undefined;
  try {
    const ownerACalls: any[] = [];
    const ownerBCalls: any[] = [];
    const unsupported = lifecycleProvider({ id: 'unsupported', initial: ['unsupported-node'], omit: ['create', 'ensure', 'inspect', 'destroy'] });
    const ownerA = lifecycleProvider({ id: 'owner-a', initial: ['collision', 'created-node'], calls: ownerACalls });
    const ownerB = lifecycleProvider({ id: 'owner-b', initial: [], mismatch: 'inspect', calls: ownerBCalls });
    transport = await install(new NodeProviderRegistry([new MasterNodeProvider(), unsupported, ownerA, ownerB]));
    const ctx: any = { sessionId: sourceId, session, sessionPlacement: 'local' };

    await assert.rejects(
      () => callTool('node', { action: 'create', providerId: 'unsupported', parameters: {} }, ctx),
      (error: any) => error?.code === 'NODE_LIFECYCLE_OPERATION_UNSUPPORTED',
    );
    await assert.rejects(
      () => callTool('node', { action: 'inspect', nodeId: 'unsupported-node' }, ctx),
      (error: any) => error?.code === 'NODE_LIFECYCLE_OPERATION_UNSUPPORTED',
    );
    await assert.rejects(
      () => callTool('node', { action: 'create', providerId: 'owner-b', nodeId: 'collision', parameters: {} }, ctx),
      (error: any) => error?.code === 'NODE_LIFECYCLE_NODE_EXISTS',
    );
    assert.equal(ownerBCalls.length, 0);
    const sameOwnerEnsure: any = await callTool('node', {
      action: 'ensure', providerId: 'owner-a', nodeId: 'collision', parameters: { sameOwner: true },
    }, ctx);
    assert.equal(sameOwnerEnsure.node.id, 'collision');
    assert.equal(ownerACalls.length, 1);
    await assert.rejects(
      () => callTool('node', { action: 'ensure', providerId: 'owner-b', nodeId: 'collision', parameters: {} }, ctx),
      (error: any) => error?.code === 'NODE_LIFECYCLE_NODE_OWNED_BY_OTHER_PROVIDER',
    );
    assert.equal(ownerBCalls.length, 0);
    await assert.rejects(
      () => callTool('node', { action: 'create', providerId: 'owner-b', parameters: { providerGenerated: true } }, ctx),
      (error: any) => error?.code === 'NODE_PROVIDER_DUPLICATE_NODE',
    );
    assert.equal(ownerBCalls.length, 1);
    for (const invalidNodeId of ['bad/node', 'MASTER', ' requested-node ']) {
      const callsBeforeInvalid: number = ownerBCalls.length;
      await assert.rejects(
        () => callTool('node', { action: 'create', providerId: 'owner-b', nodeId: invalidNodeId, parameters: {} }, ctx),
        (error: any) => error?.code === 'NODE_LIFECYCLE_INVALID_NODE_ID',
      );
      assert.equal(ownerBCalls.length, callsBeforeInvalid);
    }
    await assert.rejects(
      () => callTool('node', {
        action: 'create', providerId: 'owner-b', nodeId: 'too-large',
        parameters: { value: 'x'.repeat(70 * 1024) },
      }, ctx),
      (error: any) => error?.code === 'NODE_LIFECYCLE_INVALID_REQUEST',
    );
    const deepParameters: Record<string, unknown> = {};
    let cursor = deepParameters;
    for (let index = 0; index < 14; index += 1) {
      cursor.next = {};
      cursor = cursor.next as Record<string, unknown>;
    }
    await assert.rejects(
      () => callTool('node', { action: 'create', providerId: 'owner-b', nodeId: 'deep-node', parameters: deepParameters }, ctx),
      (error: any) => error?.code === 'NODE_LIFECYCLE_INVALID_REQUEST',
    );

    await callTool('node', { action: 'create', providerId: 'owner-b', nodeId: 'owner-b-node', parameters: {} }, ctx);
    await assert.rejects(
      () => callTool('node', { action: 'inspect', nodeId: 'owner-b-node' }, ctx),
      (error: any) => error?.code === 'NODE_LIFECYCLE_NODE_MISMATCH',
    );

    const requestedMismatch = lifecycleProvider({ id: 'requested-mismatch', initial: [] });
    requestedMismatch.createNode = async request => ({ node: descriptor(`${request.nodeId}-wrong`, 'requested-mismatch') });
    requestedMismatch.ensureNode = async request => ({ node: descriptor(`${request.nodeId}-wrong`, 'requested-mismatch') });
    await cleanup(transport);
    transport = await install(new NodeProviderRegistry([new MasterNodeProvider(), requestedMismatch]));
    for (const action of ['create', 'ensure'] as const) {
      await assert.rejects(
        () => callTool('node', { action, providerId: 'requested-mismatch', nodeId: `${action}-requested`, parameters: {} }, ctx),
        (error: any) => error?.code === 'NODE_LIFECYCLE_NODE_MISMATCH',
      );
    }

    const mismatchDestroy = lifecycleProvider({ id: 'destroy-mismatch', initial: ['destroy-node'], mismatch: 'destroy' });
    await cleanup(transport);
    transport = await install(new NodeProviderRegistry([new MasterNodeProvider(), mismatchDestroy]));
    await assert.rejects(
      () => callTool('node', { action: 'destroy', nodeId: 'destroy-node', confirmation: 'destroy node destroy-node' }, ctx),
      (error: any) => error?.code === 'NODE_LIFECYCLE_NODE_MISMATCH',
    );

    const oversizedResult = lifecycleProvider({ id: 'oversized-result', initial: [] });
    oversizedResult.createNode = async () => ({
      node: descriptor('oversized-result-node', 'oversized-result'),
      details: { value: 'x'.repeat(140 * 1024) },
    });
    await cleanup(transport);
    transport = await install(new NodeProviderRegistry([new MasterNodeProvider(), oversizedResult]));
    await assert.rejects(
      () => callTool('node', { action: 'create', providerId: 'oversized-result', parameters: {} }, ctx),
      (error: any) => error?.code === 'NODE_LIFECYCLE_INVALID_RESPONSE',
    );

    const malformedResult = lifecycleProvider({ id: 'malformed-result', initial: [] });
    malformedResult.createNode = async () => ({
      node: descriptor('malformed-result-node', 'malformed-result'),
      unexpected: true,
    } as any);
    await cleanup(transport);
    transport = await install(new NodeProviderRegistry([new MasterNodeProvider(), malformedResult]));
    await assert.rejects(
      () => callTool('node', { action: 'create', providerId: 'malformed-result', parameters: {} }, ctx),
      (error: any) => error?.code === 'NODE_LIFECYCLE_INVALID_RESULT',
    );

    const throwingProvider = lifecycleProvider({ id: 'throwing-provider', initial: [] });
    throwingProvider.createNode = async () => { throw new Error('private launch /host/secret-provider --token hidden'); };
    await cleanup(transport);
    transport = await install(new NodeProviderRegistry([new MasterNodeProvider(), throwingProvider]));
    await assert.rejects(
      () => callTool('node', { action: 'create', providerId: 'throwing-provider', parameters: {} }, ctx),
      (error: any) => error?.code === 'NODE_LIFECYCLE_PROVIDER_FAILED'
        && !/host\/secret|token hidden/.test(String(error?.message)),
    );
  } finally {
    await cleanup(transport, sourceId);
  }
});

test('lifecycle mutation lane prevents concurrent requested-ID create effects across providers', async () => {
  const first = controlledProvider('race-first');
  const second = controlledProvider('race-second');
  const firstStarted = deferred();
  const releaseFirst = deferred();
  let firstEffects = 0;
  let secondEffects = 0;
  first.provider.createNode = async request => {
    firstEffects += 1;
    firstStarted.resolve();
    await releaseFirst.promise;
    const node = descriptor(request.nodeId!, first.provider.id);
    first.nodes.set(node.id, node);
    return { node };
  };
  second.provider.createNode = async request => {
    secondEffects += 1;
    const node = descriptor(request.nodeId!, second.provider.id);
    second.nodes.set(node.id, node);
    return { node };
  };
  const registry = new NodeProviderRegistry([first.provider, second.provider]);
  const request = { sourceSessionId: 'race-source', nodeId: 'same-requested', parameters: {}, context: { agent: 'main' } };
  const firstCall = registry.createNode(first.provider.id, request);
  await firstStarted.promise;
  const secondCall = registry.createNode(second.provider.id, request);
  releaseFirst.resolve();
  assert.equal((await firstCall).node?.id, 'same-requested');
  await assert.rejects(() => secondCall, (error: any) => error?.code === 'NODE_LIFECYCLE_NODE_EXISTS');
  assert.equal(firstEffects, 1);
  assert.equal(secondEffects, 0);
});

test('lifecycle mutation lane serializes provider-generated IDs and retains post-result duplicate failure', async () => {
  const first = controlledProvider('generated-first');
  const second = controlledProvider('generated-second');
  const firstStarted = deferred();
  const releaseFirst = deferred();
  let active = 0;
  let maxActive = 0;
  const create = (owner: ReturnType<typeof controlledProvider>, wait: boolean) => async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    if (wait) {
      firstStarted.resolve();
      await releaseFirst.promise;
    }
    const node = descriptor('provider-generated-shared', owner.provider.id);
    owner.nodes.set(node.id, node);
    active -= 1;
    return { node };
  };
  first.provider.createNode = create(first, true);
  second.provider.createNode = create(second, false);
  const registry = new NodeProviderRegistry([first.provider, second.provider]);
  const request = { sourceSessionId: 'generated-source', parameters: {}, context: { agent: 'main' } };
  const firstCall = registry.createNode(first.provider.id, request);
  await firstStarted.promise;
  const secondCall = registry.createNode(second.provider.id, request);
  releaseFirst.resolve();
  assert.equal((await firstCall).node?.id, 'provider-generated-shared');
  await assert.rejects(() => secondCall, (error: any) => error?.code === 'NODE_PROVIDER_DUPLICATE_NODE');
  assert.equal(maxActive, 1);
});

test('lifecycle mutation lane keeps create and destroy ownership/effect windows ordered', async () => {
  const controlled = controlledProvider('create-destroy-provider');
  const createStarted = deferred();
  const releaseCreate = deferred();
  const order: string[] = [];
  controlled.provider.createNode = async request => {
    order.push('create-start');
    createStarted.resolve();
    await releaseCreate.promise;
    const node = descriptor(request.nodeId!, controlled.provider.id);
    controlled.nodes.set(node.id, node);
    order.push('create-finish');
    return { node };
  };
  controlled.provider.destroyNode = async request => {
    order.push('destroy');
    controlled.nodes.delete(request.nodeId);
    return { nodeId: request.nodeId };
  };
  const registry = new NodeProviderRegistry([controlled.provider]);
  const base = { sourceSessionId: 'ordered-source', parameters: {}, context: { agent: 'main' } };
  const createCall = registry.createNode(controlled.provider.id, { ...base, nodeId: 'ordered-node' });
  await createStarted.promise;
  const destroyCall = registry.destroyNode({ ...base, nodeId: 'ordered-node' });
  assert.deepEqual(order, ['create-start']);
  releaseCreate.resolve();
  assert.equal((await createCall).node?.id, 'ordered-node');
  assert.equal((await destroyCall).nodeId, 'ordered-node');
  assert.deepEqual(order, ['create-start', 'create-finish', 'destroy']);
  assert.equal(controlled.nodes.has('ordered-node'), false);
});

test('queued lifecycle cancellation rejects before provider effect', async () => {
  const blocker = controlledProvider('cancel-blocker');
  const queued = controlledProvider('cancel-queued');
  const blockerStarted = deferred();
  const releaseBlocker = deferred();
  let queuedEffects = 0;
  blocker.provider.createNode = async request => {
    blockerStarted.resolve();
    await releaseBlocker.promise;
    const node = descriptor(request.nodeId!, blocker.provider.id);
    blocker.nodes.set(node.id, node);
    return { node };
  };
  queued.provider.createNode = async request => {
    queuedEffects += 1;
    const node = descriptor(request.nodeId!, queued.provider.id);
    queued.nodes.set(node.id, node);
    return { node };
  };
  const registry = new NodeProviderRegistry([blocker.provider, queued.provider]);
  const base = { sourceSessionId: 'cancel-source', parameters: {}, context: { agent: 'main' } };
  const blockerCall = registry.createNode(blocker.provider.id, { ...base, nodeId: 'blocker-node' });
  await blockerStarted.promise;
  const controller = new AbortController();
  const queuedCall = registry.createNode(queued.provider.id, { ...base, nodeId: 'cancelled-node' }, { signal: controller.signal });
  controller.abort();
  releaseBlocker.resolve();
  await blockerCall;
  await assert.rejects(
    () => queuedCall,
    (error: any) => error?.code === 'NODE_LIFECYCLE_CANCELLED' && error?.retryable === true,
  );
  assert.equal(queuedEffects, 0);
});

test('failed lifecycle mutation releases the lane for a queued caller', async () => {
  const failing = controlledProvider('failure-first');
  const succeeding = controlledProvider('failure-second');
  const failureStarted = deferred();
  const releaseFailure = deferred();
  let successEffects = 0;
  failing.provider.createNode = async () => {
    failureStarted.resolve();
    await releaseFailure.promise;
    throw new NodeProviderError('FIXTURE_LIFECYCLE_FAILURE', 'safe fixture failure');
  };
  succeeding.provider.createNode = async request => {
    successEffects += 1;
    const node = descriptor(request.nodeId!, succeeding.provider.id);
    succeeding.nodes.set(node.id, node);
    return { node };
  };
  const registry = new NodeProviderRegistry([failing.provider, succeeding.provider]);
  const base = { sourceSessionId: 'failure-source', parameters: {}, context: { agent: 'main' } };
  const failingCall = registry.createNode(failing.provider.id, { ...base, nodeId: 'failed-node' });
  await failureStarted.promise;
  const succeedingCall = registry.createNode(succeeding.provider.id, { ...base, nodeId: 'succeeded-node' });
  releaseFailure.resolve();
  await assert.rejects(() => failingCall, (error: any) => error?.code === 'FIXTURE_LIFECYCLE_FAILURE');
  assert.equal((await succeedingCall).node?.id, 'succeeded-node');
  assert.equal(successEffects, 1);
});

test('Node provider registry awaits initialization, rolls back failure, and shuts down idempotently', async () => {
  const calls: string[] = []; let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const provider = (id: string, initialize: () => Promise<void>): NodeProvider => ({ id, initialize, shutdown: async () => { calls.push(`shutdown:${id}`); }, listNodes: () => [], getNode: () => undefined, invokeTool: async () => undefined });
  const first = provider('first', async () => { calls.push('init:first'); await gate; }); const second = provider('second', async () => { calls.push('init:second'); }); const registry = new NodeProviderRegistry([first, second]);
  const pending = registry.initialize(); await new Promise(resolve => setTimeout(resolve, 20)); assert.deepEqual(calls, ['init:first']); release(); await pending; assert.deepEqual(calls, ['init:first', 'init:second']);
  await registry.shutdown(); await registry.shutdown(); assert.deepEqual(calls.slice(2), ['shutdown:second', 'shutdown:first']);

  const rollback: string[] = []; const failed = new NodeProviderRegistry([
    { ...provider('ok', async () => { rollback.push('init:ok'); }), shutdown: async () => { rollback.push('shutdown:ok'); } },
    { ...provider('bad', async () => { rollback.push('init:bad'); throw new Error('startup failed'); }), shutdown: async () => { rollback.push('shutdown:bad'); } },
  ]);
  await assert.rejects(() => failed.initialize(), /startup failed/); assert.deepEqual(rollback, ['init:ok', 'init:bad', 'shutdown:bad', 'shutdown:ok']);
});

test('Worker lifecycle preserves exact source fence and provider context', async () => {
  const sourceId = id('lifecycle-worker');
  const wrongId = id('lifecycle-wrong');
  const session = await sessionManager.getSession(sourceId);
  const calls: any[] = [];
  let transport: LocalRpcTransport | undefined;
  try {
    transport = await install(new NodeProviderRegistry([new MasterNodeProvider(), lifecycleProvider({ calls })]), sourceId);
    const workerCtx: any = {
      sessionId: sourceId, session, sessionPlacement: 'session-worker', persistCurrentSession: async () => {},
    };
    const result: any = await callTool('node', {
      action: 'ensure', providerId: 'lifecycle-fixture', nodeId: 'worker-node', parameters: { worker: true },
    }, workerCtx);
    assert.equal(result.node.id, 'worker-node');
    assert.equal(calls[0][1].sourceSessionId, sourceId);
    assert.deepEqual(calls[0][1].context, { agent: 'main' });
    const generated: any = await tool_call_tool({
      source: 'builtin', name: 'node', args: {
        action: 'create', providerId: 'lifecycle-fixture', parameters: { workerGenerated: true },
      },
    }, workerCtx);
    assert.equal(generated.node.id, 'created-node');
    assert.equal(calls[1][1].nodeId, undefined);
    assert.equal(calls[1][1].sourceSessionId, sourceId);

    const wrongSession = { ...session, id: wrongId };
    await assert.rejects(
      () => callTool('node', { action: 'ensure', providerId: 'lifecycle-fixture', nodeId: 'wrong', parameters: {} }, {
        ...workerCtx, sessionId: wrongId, session: wrongSession,
      }),
      (error: any) => error?.code === 'NODE_EXECUTION_SOURCE_MISMATCH',
    );
  } finally {
    await cleanup(transport, sourceId, wrongId);
  }
});

test('isolated lifecycle structurally denies mutations while exact bound-node inspect remains read-only', async () => {
  const sourceId = id('lifecycle-isolated');
  const agent = id('lifecycle-agent');
  const session = await sessionManager.getSession(sourceId);
  session.agent = agent;
  session.currentNode = 'managed-node';
  await sessionManager.saveSession(sourceId);
  await sessionManager.setAgentMetadata(agent, {
    isolated: true,
    isolatedNode: 'managed-node',
    toolRules: [{ effect: 'allow', source: 'builtin', tool: 'node' }],
  });
  const calls: any[] = [];
  let transport: LocalRpcTransport | undefined;
  try {
    transport = await install(new NodeProviderRegistry([new MasterNodeProvider(), lifecycleProvider({ calls, initial: ['managed-node', 'other-node'] })]));
    const ctx: any = { sessionId: sourceId, session, sessionPlacement: 'local' };
    const listed = String(await callTool('node', { action: 'list' }, ctx));
    assert.match(listed, /`lifecycle-fixture` \(inspect\)/);
    assert.doesNotMatch(listed, /\(create|ensure|destroy/);
    for (const [action, args] of [
      ['create', { providerId: 'lifecycle-fixture', nodeId: 'new', parameters: {} }],
      ['ensure', { providerId: 'lifecycle-fixture', nodeId: 'new', parameters: {} }],
      ['destroy', { nodeId: 'managed-node', confirmation: 'destroy node managed-node' }],
    ] as const) {
      await assert.rejects(
        () => callTool('node', { action, ...args }, ctx),
        (error: any) => error?.code === 'NODE_LIFECYCLE_ISOLATED_MUTATION_DENIED',
      );
    }
    assert.equal(calls.length, 0);
    const inspected: any = await callTool('node', { action: 'inspect', nodeId: 'managed-node' }, ctx);
    assert.equal(inspected.node.id, 'managed-node');
    assert.equal(calls.length, 1);
    await assert.rejects(
      () => callTool('node', { action: 'inspect', nodeId: 'other-node' }, ctx),
      (error: any) => error?.code === 'NODE_EXECUTION_ISOLATED_NODE_DENIED',
    );
    assert.equal(calls.length, 1);
  } finally {
    await sessionManager.setAgentMetadata(agent, { isolated: false }).catch(() => {});
    await cleanup(transport, sourceId);
  }
});
