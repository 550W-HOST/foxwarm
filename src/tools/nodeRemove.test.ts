import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { call_tool, definitions, modelFacingDefinitions, node_remove, search_tools } from '../tools';
import { tool_run_script } from '../toolscript';
import * as sessionManager from '../sessionManager';
import { getAgentDir } from '../config';
import { nodesManager } from '../nodes/manager';
import {
  approvePendingPairing, authenticateApprovedNode, claimApprovedPairing, createApprovedNode,
  createNodeRegistryStore, createPendingPairing, listApprovedNodes, resetNodeRegistryForTests,
  setNodeRegistryStoreForTests,
} from '../nodes/registry';
import { executeMainManagementTool, resetMainManagementToolsForTests, shutdownMainManagementTools } from '../mainManagementTools';
import { createMainManagementToolServiceHandler, mainManagementToolServiceDescriptor } from '../mainManagementToolService';
import { LocalRpcTransport, RpcClient, RpcServiceRegistry } from '../rpc';
import { SessionWorkerStore } from '../sessionWorkerStore';
import { parseToolAuthorizationPolicyBytes, setToolAuthorizationPolicyForTests } from '../toolAuthorization';
import { resolveBuiltinToolPlacement } from './placement';

async function withFixture(run: (ctx: any, root: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-node-remove-'));
  const sessionId = `node_remove_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const session = await sessionManager.getSession(sessionId);
  const ctx = { sessionId, session };
  setNodeRegistryStoreForTests(createNodeRegistryStore(path.join(root, 'nodes.json')));
  await shutdownMainManagementTools();
  resetMainManagementToolsForTests();
  try {
    await run(ctx, root);
  } finally {
    setToolAuthorizationPolicyForTests(undefined);
    for (const node of await listApprovedNodes()) nodesManager.disconnectNode(node.nodeId, 'test cleanup');
    resetNodeRegistryForTests();
    setNodeRegistryStoreForTests(null);
    await shutdownMainManagementTools();
    resetMainManagementToolsForTests();
    await sessionManager.deleteSession(sessionId);
    await fs.remove(root);
  }
}

function registerOnlineNode(nodeId: string): number[] {
  const closes: number[] = [];
  nodesManager.registerNodeWithTools({
    send: () => {}, close: (code: number) => { closes.push(code); }, terminate: () => {},
  } as any, {} as any, 'cli', { tools: [] }, nodeId);
  return closes;
}

test('node_remove is hidden, discoverable, and Main-owned independently of the current Node', async () => {
  await withFixture(async ctx => {
    const definition = definitions.find(def => def.name === 'node_remove');
    assert.ok(definition);
    assert.equal(modelFacingDefinitions.some(def => def.name === 'node_remove'), false);
    assert.deepEqual(definition.parameters.required, ['nodeId']);
    assert.equal(definition.parameters.properties.nodeId.type, 'string');
    assert.deepEqual(resolveBuiltinToolPlacement('node_remove', { nodeId: 'target' }, 'other-node'), {
      name: 'node_remove', owner: 'main-management', executionNode: 'master',
    });
    const found = await search_tools({ query: 'node_remove', sources: ['builtin'], limit: 1 }, ctx);
    assert.match(found.output, /builtin:node_remove/);
  });
});

test('Main direct removal revokes offline approval and its unclaimed handoff without changing Session routing or files', async () => {
  await withFixture(async (ctx, root) => {
    const pending = await createPendingPairing({ nodeType: 'cli', capabilities: { tools: [] } });
    const approved = await approvePendingPairing(pending.id, 'offline-target');
    const other = await createApprovedNode('unrelated-node');
    const credentialFile = path.join(root, 'client-credentials.json');
    await fs.writeJson(credentialFile, { nodeId: approved.nodeId, authToken: approved.authToken });
    ctx.session.currentNode = approved.nodeId;

    const result = await node_remove({ nodeId: ` ${approved.nodeId} ` }, ctx);

    assert.deepEqual(result, { nodeId: approved.nodeId, disconnected: false });
    assert.equal(await authenticateApprovedNode(approved.nodeId, approved.authToken), null);
    assert.equal(await claimApprovedPairing(pending.id), null);
    assert.equal((await authenticateApprovedNode(other.nodeId, other.authToken))?.nodeId, other.nodeId);
    assert.equal(ctx.session.currentNode, approved.nodeId);
    assert.ok(sessionManager.getAllSessions().has(ctx.sessionId));
    assert.equal((await fs.readJson(credentialFile)).authToken, approved.authToken);
  });
});

test('unified online removal disconnects the runtime and ToolScript reaches the same Main operation', async () => {
  await withFixture(async ctx => {
    const online = await createApprovedNode('online-target');
    const offline = await createApprovedNode('script-target');
    const closes = registerOnlineNode(online.nodeId);
    try {
      assert.deepEqual(await call_tool({ toolId: 'builtin:node_remove', args: { nodeId: online.nodeId } }, ctx), {
        nodeId: online.nodeId, disconnected: true,
      });
      assert.deepEqual(closes, [1008]);
      assert.equal(nodesManager.getNode(online.nodeId), undefined);
      assert.equal(await authenticateApprovedNode(online.nodeId, online.authToken), null);
      const script = await tool_run_script({ code: 'def main(args):\n    return call_tool(toolId="builtin:node_remove", args={"nodeId":"script-target"})' }, ctx);
      assert.equal(script.status, 'completed');
      assert.deepEqual(script.result, { nodeId: offline.nodeId, disconnected: false });
      assert.equal(await authenticateApprovedNode(offline.nodeId, offline.authToken), null);
    } finally {
      nodesManager.disconnectNode(online.nodeId, 'test cleanup');
    }
  });
});

test('node_remove requires an explicit ID and preserves registry errors for reserved, invalid, and unknown targets', async () => {
  await withFixture(async ctx => {
    const approved = await createApprovedNode('current-node');
    ctx.session.currentNode = approved.nodeId;
    for (const args of [{}, { nodeId: '' }, { nodeId: 42 }]) {
      await assert.rejects(() => node_remove(args, ctx), /nodeId is required/);
    }
    await assert.rejects(() => node_remove({ nodeId: 'master' }, ctx), /reserved/);
    await assert.rejects(() => node_remove({ nodeId: 'bad node' }, ctx), /must match/);
    await assert.rejects(() => node_remove({ nodeId: 'missing-node' }, ctx), /not found/);
    assert.equal((await authenticateApprovedNode(approved.nodeId, approved.authToken))?.nodeId, approved.nodeId);
  });
});

test('generic policy denial at the Main boundary preserves credentials and the live connection', async () => {
  await withFixture(async ctx => {
    const approved = await createApprovedNode('denied-target');
    const closes = registerOnlineNode(approved.nodeId);
    setToolAuthorizationPolicyForTests(parseToolAuthorizationPolicyBytes('version: 1\ndefaultAction: deny\nrules: []\n'));
    await assert.rejects(() => executeMainManagementTool('node_remove', { nodeId: approved.nodeId }, ctx), /denies|denied/);
    await assert.rejects(() => call_tool({ toolId: 'builtin:node_remove', args: { nodeId: approved.nodeId } }, ctx), /denies|denied/);
    assert.deepEqual(closes, []);
    assert.ok(nodesManager.getNode(approved.nodeId));
    assert.equal((await authenticateApprovedNode(approved.nodeId, approved.authToken))?.nodeId, approved.nodeId);
  });
});

test('default isolated permissions reject node_remove through both unified calls and the Main boundary', async () => {
  await withFixture(async ctx => {
    const agentName = `node_remove_agent_${Date.now()}`;
    const approved = await createApprovedNode('isolated-target');
    ctx.session.agent = agentName;
    await sessionManager.setAgentMetadata(agentName, { isolated: true, isolatedNode: 'bound-node', toolRules: [] });
    try {
      await assert.rejects(() => call_tool({ toolId: 'builtin:node_remove', args: { nodeId: approved.nodeId } }, ctx), /Isolated agent/);
      await assert.rejects(() => executeMainManagementTool('node_remove', { nodeId: approved.nodeId }, ctx), /Isolated agent/);
      assert.equal((await authenticateApprovedNode(approved.nodeId, approved.authToken))?.nodeId, approved.nodeId);
    } finally {
      await sessionManager.setAgentMetadata(agentName, { isolated: false });
      ctx.session.agent = 'main';
      await fs.remove(getAgentDir(agentName));
    }
  });
});

test('reverse RPC rejects mismatched sources and stale Worker generations before removal', async () => {
  await withFixture(async (ctx, root) => {
    const approved = await createApprovedNode('fenced-target');
    const store = new SessionWorkerStore(path.join(root, 'workers.sqlite'));
    store.open();
    store.beginGeneration(ctx.sessionId, 'current-incarnation');
    store.registerCandidate(ctx.sessionId, 1, 'current-incarnation', 999_999, 'fixture-identity');
    store.activateCandidate(ctx.sessionId, 1, 'current-incarnation', 999_999, 'fixture-identity');
    const registry = new RpcServiceRegistry();
    registry.register(mainManagementToolServiceDescriptor, createMainManagementToolServiceHandler({
      expectedSourceSessionId: ctx.sessionId, expectedGeneration: 2,
      expectedIncarnationId: 'stale-incarnation', workerStore: store,
    }));
    const transport = new LocalRpcTransport(registry);
    const client = new RpcClient(mainManagementToolServiceDescriptor, transport);
    try {
      await assert.rejects(() => client.call('execute', {
        sourceSessionId: 'another-source', operation: 'node_remove', args: { nodeId: approved.nodeId },
      }), { code: 'MAIN_MANAGEMENT_SOURCE_MISMATCH' });
      await assert.rejects(() => client.call('execute', {
        sourceSessionId: ctx.sessionId, operation: 'node_remove', args: { nodeId: approved.nodeId },
      }), (error: any) => error.code === 'MAIN_MANAGEMENT_SOURCE_STALE' && error.retryable === true);
      assert.equal((await authenticateApprovedNode(approved.nodeId, approved.authToken))?.nodeId, approved.nodeId);
    } finally {
      transport.close();
      store.close();
    }
  });
});
