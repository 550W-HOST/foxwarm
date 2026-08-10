import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as sessionManager from './sessionManager';
import { createMainManagementToolServiceHandler, mainManagementToolServiceDescriptor } from './mainManagementToolService';
import { LocalRpcTransport, RpcClient, RpcServiceRegistry } from './rpc';
import { getSessionHistoryFilePath, serializeSessionHistoryPayload } from './session/metadataStore';
import { SessionWorkerIngressCoordinator } from './sessionWorkerIngress';
import { SessionWorkerSourceContextRegistry } from './sessionWorkerSourceContextRegistry';
import { SessionWorkerStore } from './sessionWorkerStore';
import { SessionWorkerSupervisor } from './sessionWorkerSupervisor';
import type { Session } from './types';
import { createNodeRegistryStore, createPendingPairing, resetNodeRegistryForTests, setNodeRegistryStoreForTests } from './nodes/registry';
import * as nodeTools from './tools/nodeTools';
import { getAgentDir } from './config';
import { sessionCatalogStore } from './session/catalogStore';

test.before(async () => {
  await sessionCatalogStore.initialize();
});

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  assert.fail('Timed out waiting for condition.');
}

function baseSession(id: string): Session {
  return {
    id, agent: 'main', history: [], contextFrontier: [], persistentMemorySnapshot: 'cross-session prompt',
    systemPromptFiles: [], snapshotUpdatedAt: Date.now(),
    stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
    busy: false, queue: [], meta: { lastMessageTime: 0 }, lastAppliedMailboxId: 0,
  } as Session;
}

test('worker child creation, reply delivery, and facade queries stay Main-owned end to end', async () => {
  const parentId = `mc-parent-${Date.now()}`;
  const childId = `${parentId}_mp-child`;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-worker-cross-'));
  const store = new SessionWorkerStore(path.join(root, 'session-runtime.sqlite')); store.open();
  const sourceContexts = new SessionWorkerSourceContextRegistry();
  const supervisor = new SessionWorkerSupervisor({
    store, idleMs: 60_000, workerScriptPath: path.join(__dirname, 'sessionWorkerRuntimeTestChild.js'),
    workerEnv: { FOXWARM_DATA_DIR: root, FOXWARM_TEST_CROSS_SESSION: 'create-child,reply,query' },
    resolveExactFinalSourceContext: sourceContexts.resolve,
  });
  const ingress = new SessionWorkerIngressCoordinator(store, supervisor, sourceContexts, id => id, () => true);
  const parentStatePath = path.join(root, 'state', 'sessions', `${parentId}.json`);
  await fs.outputJson(parentStatePath, serializeSessionHistoryPayload(baseSession(parentId)));
  // Production Main and Worker share this authority path; mirror the split test
  // root so non-fork child creation can inherit current owner settings from the
  // same read-only detached source as fork creation.
  await fs.copy(parentStatePath, getSessionHistoryFilePath(parentId));
  const parentAuthorityText = async () => fs.readFile(parentStatePath, 'utf8');
  const createdRealSessions: string[] = [];
  try {
    await supervisor.reconcileStartupOwnerships();
    // Main holds only a lightweight catalog stub; the authority stays in the worker tree.
    sessionManager.getAllSessions().set(parentId, baseSession(parentId));
    // The facade creates the child catalog + initial authority in Main; the test
    // mirrors that initial authority into the worker tree before the child's
    // first durable ingress (production Main and workers share one state root).
    // Mirror production: the sink durably appends then triggers processing
    // detached (queue-and-trigger semantics); an awaited variant would deadlock
    // once a waitAfterHandoff target replies to a busy-mid-turn source.
    sessionManager.setSessionWorkerEnqueueSink(async (id, item) => {
      if (id === childId) {
        const workerTreeJson = path.join(root, 'state', 'sessions', `${childId}.json`);
        await fs.ensureDir(path.dirname(workerTreeJson));
        await fs.copy(getSessionHistoryFilePath(childId), workerTreeJson);
        createdRealSessions.push(childId);
      }
      await ingress.enqueueEnsuringWorker(id, item);
    });

    await ingress.submitEnsuringWorker(parentId, { type: 'user', parts: [{ text: 'create child' }] });
    // The child session now exists in the Main catalog with the exact parent link.
    const childStub = sessionManager.getAllSessions().get(childId);
    assert.ok(childStub, 'child session must be created in the Main-owned catalog');
    assert.equal(childStub!.parentSessionId, parentId);
    // waitAfterHandoff:true armed the generic reply wait and ended the turn —
    // the exact chain that previously deadlocked under worker placement.
    const afterHandoff = JSON.parse(await parentAuthorityText());
    assert.ok(afterHandoff.meta?.wait, 'handoff wait is armed after the successful awaited handoff');
    assert.equal(afterHandoff.busy, false, 'the handoff turn ended instead of hanging');
    // The child's initial message spawns its own worker, which replies to the parent;
    // the reply wakes the armed wait through the durable mailbox.
    await waitFor(async () => (await parentAuthorityText()).includes('child reply to parent'));
    const afterReply = JSON.parse(await parentAuthorityText());
    assert.ok(!afterReply.meta?.wait, 'the reply wake cleared the armed wait');
    assert.ok(supervisor.getStatus(childId)?.ready, 'the child session runs in its own worker');
    const parentText = await parentAuthorityText();
    assert.ok(parentText.includes('Child session created'), 'facade create tool result is committed to the parent authority');
    assert.ok(!JSON.stringify(sessionManager.getAllSessions().get(childId)!.history).includes('hello child'),
      'Main never hydrates the child authority');

    // Facade queries: catalog list and cross-session detached message reads.
    // Bridge the test's split state root: production Main and workers share one
    // root, so mirror the child's current authority before the detached read.
    await fs.copy(path.join(root, 'state', 'sessions', `${childId}.json`), getSessionHistoryFilePath(childId));
    await ingress.submitEnsuringWorker(parentId, { type: 'user', parts: [{ text: 'query sessions' }] });
    const queried = await parentAuthorityText();
    assert.ok(queried.includes('list-output:'), 'session list output is committed');
    assert.ok(queried.includes(childId), 'catalog list includes the child session');
    assert.ok(queried.includes('messages-output:'), 'cross-session message read output is committed');
    assert.ok(queried.includes('hello child'), 'detached read serves the child authority content');
    assert.ok(!JSON.stringify(sessionManager.getAllSessions().get(childId)!.history).includes('hello child'),
      'facade queries keep the Main stub unhydrated');
  } finally {
    sessionManager.setSessionWorkerEnqueueSink(undefined);
    await supervisor.shutdown(5_000).catch(() => {});
    store.close();
    for (const id of createdRealSessions) await sessionManager.deleteSession(id).catch(() => {});
    sessionManager.getAllSessions().delete(parentId);
    await fs.remove(getSessionHistoryFilePath(parentId)).catch(() => {});
    await sessionManager.saveSessionCatalogEntries(sessionManager.getAllSessions().keys()).catch(() => {});
    await fs.remove(root);
  }
});

test('main-management facade forks read-only, rejects stale generations, and validates bounded args', async () => {
  const parentId = `mc-fork-${Date.now()}`;
  const forkChildId = `${parentId}_mp-fork`;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-facade-fork-'));
  const store = new SessionWorkerStore(path.join(root, 'session-runtime.sqlite')); store.open();
  const registry = new RpcServiceRegistry();
  registry.register(mainManagementToolServiceDescriptor, createMainManagementToolServiceHandler({
    expectedSourceSessionId: parentId, expectedGeneration: 1, expectedIncarnationId: 'inc-fork', workerStore: store,
  }));
  const transport = new LocalRpcTransport(registry, { maxPendingRequests: 32 });
  const client = new RpcClient(mainManagementToolServiceDescriptor, transport);
  const createdSessions = [parentId, forkChildId];
  try {
    const parent = await sessionManager.getSession(parentId);
    await sessionManager.appendSessionMessage(parentId, { role: 'user', parts: [{ text: 'fork parent message one' }] } as any);
    await sessionManager.appendSessionMessage(parentId, { role: 'model', parts: [{ text: 'fork parent message two' }] } as any);
    const parentJsonPath = getSessionHistoryFilePath(parentId);
    const parentBytesBefore = await fs.readFile(parentJsonPath);
    // Simulate a ready durable fence owned by the calling worker generation.
    store.beginGeneration(parentId, 'inc-fork');
    store.registerCandidate(parentId, 1, 'inc-fork', 999_999, 'fake-identity');
    store.activateCandidate(parentId, 1, 'inc-fork', 999_999, 'fake-identity');

    // Stale generation fencing rejects before any operation runs.
    const staleRegistry = new RpcServiceRegistry();
    staleRegistry.register(mainManagementToolServiceDescriptor, createMainManagementToolServiceHandler({
      expectedSourceSessionId: parentId, expectedGeneration: 99, expectedIncarnationId: 'inc-stale', workerStore: store,
    }));
    const staleTransport = new LocalRpcTransport(staleRegistry, { maxPendingRequests: 4 });
    try {
      await assert.rejects(
        () => new RpcClient(mainManagementToolServiceDescriptor, staleTransport).call('execute',
          { sourceSessionId: parentId, operation: 'create_child_session', args: { suffix: 'mp-stale' } }),
        (error: any) => error?.code === 'MAIN_MANAGEMENT_SOURCE_STALE' && error?.retryable === true,
      );
    } finally { staleTransport.close(); }

    // Bounded validation: unknown keys and missing suffix are rejected.
    await assert.rejects(
      () => client.call('execute', { sourceSessionId: parentId, operation: 'create_child_session', args: { suffix: 'x', bogus: 1 } }),
      (error: any) => error?.code === 'MAIN_MANAGEMENT_INVALID_ARGS',
    );
    await assert.rejects(
      () => client.call('execute', { sourceSessionId: parentId, operation: 'create_child_session', args: {} }),
      (error: any) => error?.code === 'MAIN_MANAGEMENT_INVALID_ARGS',
    );
    await assert.rejects(
      () => client.call('execute', { sourceSessionId: parentId, operation: 'delete_session' as any, args: {} }),
      (error: any) => error?.code === 'MAIN_MANAGEMENT_OPERATION_NOT_ALLOWED',
    );
    await assert.rejects(
      () => client.call('execute', { sourceSessionId: 'someone/else', operation: 'session_list', args: {} }),
      (error: any) => error?.code === 'MAIN_MANAGEMENT_SOURCE_MISMATCH',
    );

    // fork=true derives from the authority through a strictly read-only detached read.
    const forkResult: any = await client.call('execute',
      { sourceSessionId: parentId, operation: 'create_child_session', args: { suffix: 'mp-fork', fork: true } });
    assert.ok(String(forkResult?.result).includes(forkChildId));
    const parentHistoryLength = (await sessionManager.getSessionMessages(parentId, 0, 1000)).length;
    const forked = await sessionManager.getSession(forkChildId);
    assert.ok(forked.history.length >= parentHistoryLength, 'the fork inherits the authority history');
    assert.ok(JSON.stringify(forked.history.slice(0, parentHistoryLength)).includes('fork parent message one')
      && JSON.stringify(forked.history.slice(0, parentHistoryLength)).includes('fork parent message two'),
      'the inherited prefix matches the parent authority exactly');
    assert.deepEqual(await fs.readFile(parentJsonPath), parentBytesBefore, 'fork never writes the parent authority');
    assert.equal(store.getOwnership(parentId).mailboxCursor, 0, 'fork never touches the durable mailbox cursor');

    // Detached cross-session read and catalog list through the same facade.
    const messages: any = await client.call('execute',
      { sourceSessionId: parentId, operation: 'get_session_messages', args: { sessionId: forkChildId, count: 5 } });
    assert.ok(String(messages?.result).includes('fork parent message one'), 'detached read serves fenced authority content');
    const list: any = await client.call('execute', { sourceSessionId: parentId, operation: 'session_list', args: {} });
    assert.ok(String(list?.result).includes(parentId));
    assert.equal(parent.history.length, 2, 'Main catalog session for the fenced parent is never rehydrated');
  } finally {
    transport.close();
    for (const id of createdSessions) await sessionManager.deleteSession(id).catch(() => {});
    store.close();
    await fs.remove(root);
  }
});

test('real Worker calls cross-session recall, agent creation, and node bootstrap/pairing through exact Main ownership', async () => {
  const sourceId = `mc-tools-${Date.now()}`;
  const targetId = `${sourceId}-target`;
  const agentName = `mcagent_${Date.now()}`;
  const createdSessionId = `${agentName}/created`;
  const approvedNodeId = `mc-node-${Date.now()}`;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-worker-main-tools-'));
  const store = new SessionWorkerStore(path.join(root, 'session-runtime.sqlite')); store.open();
  const sourceContexts = new SessionWorkerSourceContextRegistry();
  setNodeRegistryStoreForTests(createNodeRegistryStore(path.join(root, 'nodes.json')));
  const pending = await createPendingPairing({ requestedName: 'worker-fixture', nodeType: 'cli', capabilities: { tools: [] } });
  const calls = [
    { name: 'recall', args: { sessionId: targetId, target: 'overview', previewLength: 1000 } },
    { name: 'get_archived_messages', args: { sessionId: targetId } },
    { name: 'get_archived_blocks', args: { sessionId: targetId } },
    { name: 'create_agent', args: { agentName, createMainSession: false } },
    { name: 'create_session', args: { agentName, sessionName: 'created' } },
    { name: 'node_bootstrap_info', args: {} },
    { name: 'node_pair_list', args: {} },
    { name: 'node_pair_approve', args: { pendingId: pending.id, nodeId: approvedNodeId } },
  ];
  const supervisor = new SessionWorkerSupervisor({
    store, idleMs: 60_000, workerScriptPath: path.join(__dirname, 'sessionWorkerRuntimeTestChild.js'),
    workerEnv: { FOXWARM_DATA_DIR: root, FOXWARM_TEST_MAIN_TOOLS: JSON.stringify(calls) },
    resolveExactFinalSourceContext: sourceContexts.resolve,
  });
  const ingress = new SessionWorkerIngressCoordinator(store, supervisor, sourceContexts, id => id, id => sessionManager.getAllSessions().has(id));
  const sourcePath = path.join(root, 'state', 'sessions', `${sourceId}.json`);
  const originalBootstrap = (nodeTools as any).tool_node_bootstrap_info;
  (nodeTools as any).tool_node_bootstrap_info = async () => ({ kind: 'disposable-bootstrap-fixture' });
  try {
    await supervisor.reconcileStartupOwnerships();
    const source = baseSession(sourceId); source.model = 'openai/gpt-5.6-sol';
    const sourceStub = baseSession(sourceId); sourceStub.model = 'stale-main-model';
    const target = baseSession(targetId);
    sessionManager.getAllSessions().set(sourceId, sourceStub); sessionManager.getAllSessions().set(targetId, target);
    await fs.outputJson(sourcePath, serializeSessionHistoryPayload(source));
    await fs.outputJson(getSessionHistoryFilePath(sourceId), serializeSessionHistoryPayload(source));
    await fs.outputJson(getSessionHistoryFilePath(targetId), serializeSessionHistoryPayload(target));
    sessionManager.setSessionWorkerEnqueueSink(async (id, item) => { await ingress.enqueueEnsuringWorker(id, item); });
    await ingress.submitEnsuringWorker(sourceId, { type: 'user', parts: [{ text: 'exercise main-owned tools' }] });
    const authority = await fs.readJson(sourcePath);
    const text = JSON.stringify(authority.history);
    assert.match(text, new RegExp(`Recall overview for session .${targetId}`));
    assert.match(text, /No archived messages matched/);
    assert.match(text, /No archived blocks found/);
    assert.ok(text.includes(agentName) && text.includes('created successfully'));
    assert.ok(text.includes(createdSessionId) && text.includes('created under agent'));
    assert.equal((await sessionManager.getSession(createdSessionId)).model, source.model, 'new session inherits the detached Worker authority model, not the stale Main stub');
    assert.match(text, /disposable-bootstrap-fixture/);
    assert.match(text, new RegExp(pending.id));
    assert.match(text, new RegExp(`Approved node.*${approvedNodeId}`));
    assert.equal(JSON.stringify(sessionManager.getAllSessions().get(sourceId)!.history), '[]', 'Main source stub remains unhydrated');
  } finally {
    sessionManager.setSessionWorkerEnqueueSink(undefined);
    (nodeTools as any).tool_node_bootstrap_info = originalBootstrap;
    await supervisor.shutdown(5_000).catch(() => {}); store.close();
    await sessionManager.deleteSession(createdSessionId).catch(() => {});
    await sessionManager.deleteSession(targetId).catch(() => {});
    sessionManager.getAllSessions().delete(sourceId);
    await fs.remove(getSessionHistoryFilePath(sourceId)).catch(() => {});
    await fs.remove(getAgentDir(agentName)).catch(() => {});
    resetNodeRegistryForTests(); setNodeRegistryStoreForTests(null);
    await fs.remove(root);
  }
});
