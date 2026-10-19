import './testEnvironment';
import { createApprovedNode, removeApprovedNode } from './nodes/registry';
import { nodesManager } from './nodes/manager';
import { normalizeAgentToolRules } from './permissions';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import {
  buildToolAuthorizationRequest, evaluateToolAuthorizationPolicy, parseToolAuthorizationPolicyBytes,
  isToolAuthorizationPotentiallyVisibleSync, setToolAuthorizationPolicyForTests,
} from './toolAuthorization';
import { callTool } from './tools';
import { tool_search_tools } from './tools/unifiedSearch';
import * as sessionManager from './sessionManager';
import * as nodeExecution from './nodeExecution';
import { createNodeExecutionServiceHandler, nodeExecutionServiceDescriptor } from './nodeExecutionService';
import { LocalRpcTransport, RpcServiceRegistry } from './rpc';
import { ExecutableNodeProvider } from './nodes/executableProvider';
import { MasterNodeProvider, AuthenticatedRemoteNodeProvider, NodeProviderRegistry } from './nodes/providerRegistry';

const caller = { id: 'developer/work', agent: 'developer', currentNode: 'development/one' };
function request(name = 'read', node = 'development/one', args: Record<string, any> = {}, source: 'node' | 'builtin' | 'mcp' = 'node') {
  return buildToolAuthorizationRequest({ session: caller, tool: { source, name }, targetNode: node, args });
}
function policy(rules: unknown[], defaultAction = 'deny') {
  return parseToolAuthorizationPolicyBytes(JSON.stringify({ version: 1, defaultAction, rules }));
}
test.afterEach(() => setToolAuthorizationPolicyForTests(undefined));

test('concise Session and Node patterns grant all development Nodes without granting Main or MCP operations', () => {
  const rules = policy([
    { session: ['developer/main', 'developer-worker/main'], action: 'allow' },
    { agent: ['developer', 'developer-worker'], node: 'development/*', action: 'allow' },
  ]);
  for (const node of ['development/one', 'development/two']) {
    assert.equal(evaluateToolAuthorizationPolicy(rules, request('read', node)).action, 'allow');
    assert.equal(evaluateToolAuthorizationPolicy(rules, request('exec', node)).action, 'allow');
  }
  for (const req of [request('read', 'master'), request('read', 'other/one'),
    request('task', 'development/one', { node: 'development/one' }, 'builtin'),
    request('read', 'development/one', { node: 'development/one' }, 'mcp'),
    request('run_script', 'development/one', { filePath: 'source.py', node: 'development/one' }, 'builtin')]) {
    assert.equal(evaluateToolAuthorizationPolicy(rules, req).action, 'deny');
  }
  const main = buildToolAuthorizationRequest({ session: { ...caller, id: 'developer/main' }, tool: { source: 'builtin', name: 'task' } });
  assert.equal(evaluateToolAuthorizationPolicy(rules, main).action, 'allow');
  const provider = policy([{ session: 'developer/*', node: { provider: 'development' }, action: 'allow' }]);
  assert.equal(evaluateToolAuthorizationPolicy(provider, request('read', 'development/two')).action, 'allow');
  assert.equal(evaluateToolAuthorizationPolicy(provider, request('read', 'other/two', { providerId: 'development' })).action, 'deny');
});

test('shorthand remains strict, bounded and distinct from exact legacy rules and argument strings', () => {
  const old = policy([{ id: 'old', match: { session: 'developer/*', targetNode: 'development/*' }, action: 'allow' }]);
  assert.equal(evaluateToolAuthorizationPolicy(old, request()).action, 'deny');
  const exactArgs = policy([{ session: 'developer/*', tool: 'exec', args: { command: '*' }, action: 'allow' }]);
  assert.equal(evaluateToolAuthorizationPolicy(exactArgs, request('exec', 'development/one', { command: 'pwd' })).action, 'deny');
  assert.equal(evaluateToolAuthorizationPolicy(exactArgs, request('exec', 'development/one', { command: '*' })).action, 'allow');
  for (const rule of [
    { session: 'developer/*', match: {}, action: 'allow' },
    { node: { current: true, provider: 'development' }, action: 'allow' },
    { node: { current: false }, action: 'allow' },
    { node: { provider: 'dev*' }, action: 'allow' },
    { session: 'developer/?', action: 'allow' },
    { session: 'x'.repeat(513), action: 'allow' },
    { tool: { source: 'builtin', name: 'task' }, args: { taskId: { task: { owned: false } } }, action: 'allow' },
    { tool: { source: 'node', name: 'task' }, args: { taskId: { task: { owned: true } } }, action: 'allow' },
    { tool: { source: 'builtin', name: 'task' }, args: { ownerSessionId: { task: { owned: true } } }, action: 'allow' },
  ]) assert.throws(() => policy([rule]));
  assert.throws(() => policy([{ id: 'rule-2', action: 'allow' }, { action: 'deny' }]), /duplicated/);
  assert.equal(policy([{ action: 'deny' }]).rules[0].id, 'rule-1');
  const longestCoreId = `${'p'.repeat(64)}/${'n'.repeat(128)}`;
  assert.equal(normalizeAgentToolRules([{ effect: 'allow', source: 'node', node: longestCoreId, tool: 'read' }])[0].source, 'node');
  assert.throws(() => normalizeAgentToolRules([{ effect: 'allow', source: 'node', node: 'n'.repeat(129), tool: 'read' }]), /128 UTF-8 bytes/);
});

test('current Node selectors use caller routing, and multi-Node allows require every effect endpoint', () => {
  const current = policy([{ node: { current: true }, action: 'allow' }]);
  assert.equal(evaluateToolAuthorizationPolicy(current, request()).action, 'allow');
  assert.equal(evaluateToolAuthorizationPolicy(current, request('read', 'development/two', { currentNode: 'development/two' })).action, 'deny');
  const development = policy([{ node: 'development/*', action: 'allow' }]);
  const copy = (sourceNode: string, targetNode: string) => request('copy_between_nodes', 'master', { sourceNode, targetNode }, 'builtin');
  assert.equal(evaluateToolAuthorizationPolicy(development, copy('development/one', 'development/two')).action, 'allow');
  assert.equal(evaluateToolAuthorizationPolicy(development, copy('development/one', 'master')).action, 'deny');
  assert.equal(evaluateToolAuthorizationPolicy(development, copy('master', 'development/one')).action, 'deny');
  const denyMaster = policy([{ node: 'master', action: 'deny' }], 'allow');
  assert.equal(evaluateToolAuthorizationPolicy(denyMaster, copy('development/one', 'master')).action, 'deny');
  assert.equal(evaluateToolAuthorizationPolicy(development, request('node', 'master', { action: 'select', nodeId: 'development/two' }, 'builtin')).action, 'allow');
  const denySelection = policy([
    { tool: { source: 'builtin', name: 'node' }, args: { action: 'select' }, action: 'deny' },
    { node: 'development/*', action: 'allow' },
  ]);
  assert.equal(evaluateToolAuthorizationPolicy(denySelection, request('node', 'master', { action: 'select', nodeId: 'development/two' }, 'builtin')).action, 'deny');
});

test('discovery conservatively retains unknown registered endpoints without treating ToolScript as a Node wrapper', () => {
  setToolAuthorizationPolicyForTests(policy([{ node: 'development/*', action: 'allow' }]));
  assert.equal(isToolAuthorizationPotentiallyVisibleSync(request()), true);
  assert.equal(isToolAuthorizationPotentiallyVisibleSync(request('node', 'master', {}, 'builtin'), { nodeTargetsUnknown: true }), true);
  assert.equal(isToolAuthorizationPotentiallyVisibleSync(request('copy_between_nodes', 'master', {}, 'builtin'), { nodeTargetsUnknown: true }), true);
  assert.equal(isToolAuthorizationPotentiallyVisibleSync(request('run_script', 'master', {}, 'builtin'), { targetNodeUnknown: true }), false);
  assert.equal(isToolAuthorizationPotentiallyVisibleSync(request('task', 'development/one', {}, 'builtin')), false);
});

function provider(id: string, logPath: string) {
  return new ExecutableNodeProvider({ id, type: 'executable', command: process.execPath,
    args: [path.join(__dirname, 'nodes', 'executableProviderTestFixture.js'), 'normal', logPath], timeoutMs: 2000 });
}

test('Worker direct, unified and ToolScript calls retain actual caller current Node across Main authorization', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fw-node-policy-'));
  const sourceId = `node-policy-${Date.now()}`;
  const source = await sessionManager.getSession(sourceId);
  source.currentNode = 'master';
  await sessionManager.saveSession(sourceId);
  const selected = 'development/fixture-sandbox';
  const other = 'development/fixture-secondary';
  const owner = { ...source, currentNode: selected, cwd: 'memfs://owner/cwd' };
  const ctx: any = { sessionId: sourceId, session: owner, sessionPlacement: 'session-worker', persistCurrentSession: async () => {} };
  const registry = new RpcServiceRegistry();
  registry.register(nodeExecutionServiceDescriptor, createNodeExecutionServiceHandler({ expectedSourceSessionId: sourceId,
    providerRegistry: new NodeProviderRegistry([new MasterNodeProvider(), provider('development', path.join(root, 'requests.jsonl'))]) }));
  const transport = new LocalRpcTransport(registry);
  await nodeExecution.initializeNodeExecution({ transport, placement: 'child-reverse' });
  setToolAuthorizationPolicyForTests(policy([
    { session: sourceId, node: { current: true }, action: 'allow' },
    { session: sourceId, tool: { source: 'builtin', name: ['run_script', 'search_tools'] }, action: 'allow' },
  ]));
  try {
    assert.match(JSON.stringify(await callTool('read', { filePath: 'memfs://input.txt' }, ctx)), /fixture-read/);
    assert.match(JSON.stringify(await callTool('call_tool', { toolId: `node:${selected}/read`, args: { filePath: 'memfs://input.txt' } }, ctx)), /fixture-read/);
    await assert.rejects(() => callTool('call_tool', { source: 'node', nodeId: other, name: 'read', args: { filePath: 'memfs://input.txt' } }, ctx), /authorization rule denies/);
    const nested = await callTool('run_script', { code: `return call_tool("node:${selected}/read", {"filePath":"memfs://input.txt"})` }, ctx);
    assert.equal(nested.status, 'completed');
    assert.match(JSON.stringify(nested.result), /fixture-read/);
    const search: any = await tool_search_tools({ sources: ['node'], query: 'read', nodeId: selected }, ctx);
    assert.match(search.output, /node:development\/fixture-sandbox\/read/);
    const deniedSearch: any = await tool_search_tools({ sources: ['node'], query: 'read', nodeId: other }, ctx);
    assert.doesNotMatch(deniedSearch.output, /node:development\/fixture-secondary\/read/);
    // The source-cwd capture intentionally names the other Node. It must not become caller selection.
    await assert.rejects(() => callTool('run_script', { node: other, filePath: 'memfs://source.py' }, ctx), /authorization rule denies/);
    setToolAuthorizationPolicyForTests(policy([{ session: sourceId, node: { provider: 'development' }, action: 'allow' }]));
    assert.match(JSON.stringify(await callTool('call_tool', { toolId: `node:${other}/read`, args: { filePath: 'memfs://input.txt' } }, ctx)), /fixture-read/);
    await assert.rejects(() => callTool('call_tool', { toolId: 'node:master/read', args: { filePath: 'must-not-read' } }, ctx), /authorization rule denies/);
    await assert.rejects(() => callTool('run_script', { code: 'return 1' }, ctx), /authorization rule denies/);
    await assert.rejects(() => nodeExecution.copyBetweenNodes(sourceId, {
      sourceNode: `development/${'n'.repeat(128)}`, sourcePath: 'source', targetNode: 'master', targetPath: 'target',
      callerCurrentNode: selected,
    }), /authorization rule denies/, 'qualified copy endpoint bounds reach policy evaluation, not a native-ID length rejection');
    await callTool('node', { action: 'select', nodeId: other }, ctx);
    assert.equal(owner.currentNode, other);
    assert.match(JSON.stringify(await callTool('read', { filePath: 'memfs://input.txt' }, ctx)), /fixture-read/);
    setToolAuthorizationPolicyForTests(policy([
      { session: sourceId, tool: { source: 'builtin', name: 'node' }, args: { action: 'select' }, action: 'deny' },
      { session: sourceId, node: 'development/*', action: 'allow' },
    ]));
    await assert.rejects(() => callTool('node', { action: 'select', nodeId: selected }, ctx), /authorization rule denies/);
    assert.equal(owner.currentNode, other);
  } finally {
    setToolAuthorizationPolicyForTests(undefined);
    await nodeExecution.shutdownNodeExecution(); nodeExecution.resetNodeExecutionForTests();
    await transport.drain(); transport.close();
    await sessionManager.deleteSession(sourceId);
    await fs.remove(root);
  }
});

test('Core namespaces isolate identical adapter-local IDs and preserve lifecycle wire IDs', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fw-node-namespaces-'));
  const firstLog = path.join(root, 'first.jsonl');
  const registry = new NodeProviderRegistry([provider('first', firstLog), provider('second', path.join(root, 'second.jsonl'))]);
  const context = { sourceSessionId: 'owner', parameters: {}, context: { agent: 'developer' } };
  try {
    const nodes = await registry.listNodes();
    assert.equal(nodes.length, 4);
    assert.equal(new Set(nodes.map(node => node.id)).size, 4);
    assert.equal((await registry.resolveNode('first/fixture-sandbox'))?.descriptor.provider, 'first');
    assert.equal(await registry.resolveNode('fixture-sandbox'), undefined, 'ordinary routing has no legacy local-ID alias');
    const created = await registry.createNode('first', { ...context, nodeId: 'first/dynamic' });
    assert.equal(created.node?.id, 'first/dynamic');
    assert.equal((await registry.ensureNode('first', { ...context, nodeId: 'first/dynamic' })).node?.id, 'first/dynamic');
    assert.equal((await registry.inspectNode({ ...context, nodeId: 'first/dynamic' })).node?.id, 'first/dynamic');
    assert.equal((await registry.destroyNode({ ...context, nodeId: 'first/dynamic' })).nodeId, 'first/dynamic');
    await assert.rejects(() => registry.createNode('first', { ...context, nodeId: 'second/dynamic' }), /selected provider namespace/);
    const calls = (await fs.readFile(firstLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    for (const call of calls.filter(call => ['create', 'ensure', 'inspect', 'destroy'].includes(call.request.operation))) {
      assert.equal(call.request.request.nodeId, 'dynamic');
    }
  } finally { await fs.remove(root); }
});


test('registered native identities retain wildcard denies and explicit allows across direct, unified and Main execution', async () => {
  const nodeId = `_native-policy-${Date.now()}`;
  const approved = await createApprovedNode(nodeId);
  assert.equal(approved.nodeId, nodeId);
  let effects = 0;
  const ws: any = {
    send(raw: string) {
      const message = JSON.parse(raw);
      if (message.type !== 'tool_call') return;
      effects += 1;
      queueMicrotask(() => nodesManager.handleToolResponse(message.callId, { output: 'native read reached effect' }, nodeId));
    },
    close() {},
  };
  nodesManager.registerNodeWithTools(ws, {} as any, 'cli-node', {
    tools: [{ name: 'read', description: 'Native fixture read', parameters: { type: 'object' } }],
  }, nodeId);
  const source = await sessionManager.getSession(`native-policy-${Date.now()}`);
  source.currentNode = nodeId;
  await sessionManager.saveSession(source.id);
  const ctx = { sessionId: source.id, session: source };
  const registry = new RpcServiceRegistry();
  registry.register(nodeExecutionServiceDescriptor, createNodeExecutionServiceHandler({ expectedSourceSessionId: source.id,
    providerRegistry: new NodeProviderRegistry([new MasterNodeProvider(), new AuthenticatedRemoteNodeProvider()]) }));
  const transport = new LocalRpcTransport(registry);
  await nodeExecution.initializeNodeExecution({ transport, placement: 'child-reverse' });
  try {
    setToolAuthorizationPolicyForTests(policy([{ node: '*', action: 'deny' }], 'allow'));
    await assert.rejects(() => callTool('read', { filePath: '/fixture' }, ctx), /authorization rule denies/);
    await assert.rejects(() => callTool('call_tool', { toolId: `node:${nodeId}/read`, args: { filePath: '/fixture' } }, ctx), /authorization rule denies/);
    await assert.rejects(() => nodeExecution.executeNodeTool(source.id, nodeId, 'read', { filePath: '/fixture' }), /authorization rule denies/);
    assert.equal(effects, 0, 'no authenticated adapter effect is dispatched under the wildcard deny');
    const hidden: any = await tool_search_tools({ sources: ['node'], nodeId, query: 'read' }, ctx);
    assert.ok(!hidden.output.includes(`node:${nodeId}/read`));

    setToolAuthorizationPolicyForTests(policy([{ node: { provider: 'authenticated-remote' }, action: 'allow' }]));
    assert.match(JSON.stringify(await callTool('read', { filePath: '/fixture' }, ctx)), /native read reached effect/);
    assert.match(JSON.stringify(await callTool('call_tool', { toolId: `node:${nodeId}/read`, args: { filePath: '/fixture' } }, ctx)), /native read reached effect/);
    assert.match(JSON.stringify(await nodeExecution.executeNodeTool(source.id, nodeId, 'read', { filePath: '/fixture' })), /native read reached effect/);
    assert.equal(effects, 3);
    const visible: any = await tool_search_tools({ sources: ['node'], nodeId, query: 'read' }, ctx);
    assert.ok(visible.output.includes(`node:${nodeId}/read`));
  } finally {
    setToolAuthorizationPolicyForTests(undefined);
    await nodeExecution.shutdownNodeExecution(); nodeExecution.resetNodeExecutionForTests();
    await transport.drain(); transport.close();
    nodesManager.unregisterNode(nodeId);
    await removeApprovedNode(nodeId);
    await sessionManager.deleteSession(source.id);
  }
});
