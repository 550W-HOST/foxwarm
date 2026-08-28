import test from 'node:test';
import assert from 'node:assert/strict';

import { executeTools } from './llm';
import * as nodeExecution from './nodeExecution';
import { nodesManager } from './nodes/manager';
import * as sessionManager from './sessionManager';
import { call_tool } from './tools';
import { createNodeExecutionServiceHandler, nodeExecutionServiceDescriptor } from './nodeExecutionService';
import { LocalRpcTransport, RpcClient, RpcServiceRegistry } from './rpc';
import { getAgentDir } from './config';
import { createHash } from 'node:crypto';
import {
  MasterNodeProvider,
  NodeProviderRegistry,
  type NodeDescriptor,
  type NodeProvider,
  type NodeProviderDescriptor,
  type NodeToolRequest,
} from './nodes/providerRegistry';

function makeId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function fakeNode(nodeId: string, tools: string[]): any {
  return { id: nodeId, ws: {}, tools: new Set(tools) };
}

async function cleanup(...sessionIds: string[]): Promise<void> {
  await nodeExecution.shutdownNodeExecution().catch(() => {});
  nodeExecution.resetNodeExecutionForTests();
  for (const sessionId of sessionIds) {
    await sessionManager.deleteSession(sessionId).catch(() => false);
  }
}

test('bound reverse Node handler rejects wrong source before lookup or effect', async () => {
  const registry = new RpcServiceRegistry();
  registry.register(nodeExecutionServiceDescriptor, createNodeExecutionServiceHandler({ expectedSourceSessionId: 'owned' }));
  const transport = new LocalRpcTransport(registry);
  const originalLookup = sessionManager.getExistingSession;
  let lookups = 0;
  (sessionManager as any).getExistingSession = async (): Promise<null> => { lookups += 1; return null; };
  try {
    await assert.rejects(() => new RpcClient(nodeExecutionServiceDescriptor, transport).call('execute', {
      sourceSessionId: 'wrong', nodeId: 'remote', toolName: 'read', args: {},
    }), { code: 'NODE_EXECUTION_SOURCE_MISMATCH' });
    await assert.rejects(() => new RpcClient(nodeExecutionServiceDescriptor, transport).call('list', { sourceSessionId: 'wrong' }),
      { code: 'NODE_EXECUTION_SOURCE_MISMATCH' });
    await assert.rejects(() => new RpcClient(nodeExecutionServiceDescriptor, transport).call('copy', {
      sourceSessionId: 'wrong', sourceNode: 'master', sourcePath: 'a', targetNode: 'remote', targetPath: 'b',
    }), { code: 'NODE_EXECUTION_SOURCE_MISMATCH' });
    assert.equal(lookups, 0);
  } finally { (sessionManager as any).getExistingSession = originalLookup; await transport.drain(); transport.close(); }
});

test('protocol-incompatible Nodes stay visible but list, select, and dispatch fail before provider invocation', async () => {
  const sourceId = makeId('node_protocol_source');
  await sessionManager.getSession(sourceId);
  let invocations = 0;
  const unavailableNode: NodeProviderDescriptor = {
    id: 'old-node', kind: 'remote', provider: 'protocol-test', type: 'cli-node', availability: 'error', tools: [],
    unavailable: {
      code: 'NODE_PROTOCOL_INCOMPATIBLE',
      message: 'Node `old-node` is connected but requires a client upgrade.',
      retryable: false,
    },
    protocolCompatibility: {
      status: 'upgrade-required', client: { min: 3, max: 3 }, master: { min: 1, max: 2 }, legacyClient: false,
    },
  };
  const descriptor: NodeProvider = {
    id: 'protocol-test',
    listNodes: async () => [unavailableNode],
    getNode: async nodeId => nodeId === unavailableNode.id ? unavailableNode : undefined,
    invokeTool: async () => { invocations += 1; return null; },
  };
  const providers = new NodeProviderRegistry([descriptor]);
  const registry = new RpcServiceRegistry();
  registry.register(nodeExecutionServiceDescriptor, createNodeExecutionServiceHandler({ providerRegistry: providers }));
  const transport = new LocalRpcTransport(registry);
  const client = new RpcClient(nodeExecutionServiceDescriptor, transport);
  try {
    const listed = await client.call('list', { sourceSessionId: sourceId });
    assert.equal(listed.nodes[0]?.availability, 'error');
    assert.equal(listed.nodes[0]?.unavailable?.code, 'NODE_PROTOCOL_INCOMPATIBLE');
    assert.equal(listed.nodes[0]?.protocolCompatibility?.status, 'upgrade-required');
    await assert.rejects(() => client.call('select', { sourceSessionId: sourceId, nodeId: 'old-node' }), {
      code: 'NODE_PROTOCOL_INCOMPATIBLE', retryable: false,
    });
    await assert.rejects(() => client.call('execute', { sourceSessionId: sourceId, nodeId: 'old-node', toolName: 'exec', args: {} }), {
      code: 'NODE_PROTOCOL_INCOMPATIBLE', retryable: false,
    });
    assert.equal(invocations, 0);
  } finally {
    await transport.drain(); transport.close();
    await cleanup(sourceId);
  }
});

test('Node compound copy keeps bytes inside Main for master and remote sources', async () => {
  const sourceId = makeId('node_copy_source');
  await sessionManager.getSession(sourceId);
  const originals = { read: nodesManager.readFileFromNode, write: nodesManager.writeFileToNode };
  const reads: any[] = []; const writes: any[] = [];
  (nodesManager as any).readFileFromNode = async (...args: any[]) => {
    reads.push(args); const data = Buffer.from(`bytes-${args[0]}`);
    return { dataBase64: data.toString('base64'), sizeBytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
  };
  const sha256 = 'a'.repeat(64);
  (nodesManager as any).writeFileToNode = async (...args: any[]) => { writes.push(args); return { sha256, overwritten: false }; };
  try {
    const first = await nodeExecution.copyBetweenNodes(sourceId, { sourceNode: 'master', sourcePath: 'a', targetNode: 'remote-a', targetPath: 'b' });
    const second = await nodeExecution.copyBetweenNodes(sourceId, { sourceNode: 'remote-a', sourcePath: 'c', targetNode: 'remote-b', targetPath: 'd', overwrite: true });
    await nodeExecution.copyBetweenNodes(sourceId, { sourceNode: 'master', sourcePath: '  a  ', targetNode: 'remote-a', targetPath: '   ' });
    assert.equal(first.sha256, sha256); assert.equal(second.overwritten, false);
    assert.deepEqual(writes.map(call => call.slice(0, 5)), [
      ['remote-a', 'b', Buffer.from('bytes-master').toString('base64'), false, sourceId],
      ['remote-b', 'd', Buffer.from('bytes-remote-a').toString('base64'), true, sourceId],
      ['remote-a', '   ', Buffer.from('bytes-master').toString('base64'), false, sourceId],
    ]);
    assert.equal(reads[2][1], '  a  ');
    assert.equal(JSON.stringify([first, second]).includes('bytes-'), false);
    assert.deepEqual(Object.keys(first).sort(), ['overwritten', 'sha256', 'sizeBytes', 'sourceNode', 'sourcePath', 'targetNode', 'targetPath']);
    (nodesManager as any).writeFileToNode = async () => ({ sha256: 'bad', overwritten: false });
    await assert.rejects(() => nodeExecution.copyBetweenNodes(sourceId, { sourceNode: 'master', sourcePath: 'a', targetNode: 'remote-a', targetPath: 'b' }),
      { code: 'NODE_EXECUTION_INVALID_RESPONSE' });
    const writesBeforeInvalidSource = writes.length;
    for (const invalid of [
      { dataBase64: '***', sizeBytes: 1, sha256: 'a'.repeat(64) },
      { dataBase64: 'YQ==', sizeBytes: 2, sha256: createHash('sha256').update('a').digest('hex') },
      { dataBase64: 'YQ==', sizeBytes: 1, sha256: 'a'.repeat(64) },
    ]) {
      (nodesManager as any).readFileFromNode = async () => invalid;
      (nodesManager as any).writeFileToNode = async (...args: any[]) => { writes.push(args); return { sha256, overwritten: false }; };
      await assert.rejects(() => nodeExecution.copyBetweenNodes(sourceId, { sourceNode: 'master', sourcePath: 'a', targetNode: 'remote-a', targetPath: 'b' }),
        { code: 'NODE_EXECUTION_INVALID_RESPONSE' });
      assert.equal(writes.length, writesBeforeInvalidSource);
    }
  } finally {
    (nodesManager as any).readFileFromNode = originals.read; (nodesManager as any).writeFileToNode = originals.write;
    await cleanup(sourceId);
  }
});

test('Node topology bounds schemas without invoking capability accessors', async () => {
  const sourceId = makeId('node_topology_bounds'); await sessionManager.getSession(sourceId);
  const originals = { withTools: nodesManager.listNodesWithTools, list: nodesManager.listNodes };
  let accessorCalls = 0;
  const accessorTool: any = { name: 'accessor', description: 'safe' };
  Object.defineProperty(accessorTool, 'parameters', { enumerable: true, get() { accessorCalls += 1; return { type: 'object' }; } });
  const specialSchema: any = { type: 'object' };
  Object.defineProperty(specialSchema, '__proto__', { enumerable: true, writable: true, configurable: true,
    value: { nested: 'proto-data' } });
  Object.defineProperty(specialSchema, 'constructor', { enumerable: true, writable: true, configurable: true,
    value: { nested: 'constructor-data' } });
  specialSchema.prototype = { nested: 'prototype-data' };
  specialSchema.nested = {};
  Object.defineProperty(specialSchema.nested, '__proto__', { enumerable: true, writable: true, configurable: true, value: 'nested-proto' });
  specialSchema.nested.constructor = 'nested-constructor'; specialSchema.nested.prototype = 'nested-prototype';
  (nodesManager as any).listNodesWithTools = () => [{ id: 'bounded', type: 'node', tools: [
    { name: 'valid', description: 'd'.repeat(3000), parameters: specialSchema },
    { name: 'oversize', parameters: { value: 'x'.repeat(20 * 1024) } }, accessorTool,
  ] }];
  (nodesManager as any).listNodes = () => [{ id: 'bounded', lastActivity: 1 }];
  try {
    const node = (await nodeExecution.listNodeTopology(sourceId)).find(item => item.id === 'bounded')!;
    assert.equal(accessorCalls, 0); assert.equal(node.tools.length, 3);
    assert.equal(node.tools[0].description?.length, 2000);
    const schema: any = node.tools[0].parameters;
    assert.equal(Object.getPrototypeOf(schema), Object.prototype);
    assert.equal(Object.prototype.hasOwnProperty.call(schema, '__proto__'), true);
    assert.deepEqual(schema.__proto__, { nested: 'proto-data' });
    assert.deepEqual(schema.constructor, { nested: 'constructor-data' });
    assert.deepEqual(schema.prototype, { nested: 'prototype-data' });
    assert.equal(Object.getPrototypeOf(schema.nested), Object.prototype);
    assert.deepEqual({ proto: schema.nested.__proto__, constructor: schema.nested.constructor, prototype: schema.nested.prototype },
      { proto: 'nested-proto', constructor: 'nested-constructor', prototype: 'nested-prototype' });
    assert.equal(node.tools[1].parameters, undefined); assert.equal(node.tools[2].parameters, undefined);
    assert.ok(Buffer.byteLength(JSON.stringify(node), 'utf8') < 256 * 1024);
  } finally {
    (nodesManager as any).listNodesWithTools = originals.withTools; (nodesManager as any).listNodes = originals.list;
    await cleanup(sourceId);
  }
});

test('generic Node registry lists, selects, and invokes a complete non-WebSocket sandbox capability', async () => {
  const sourceId = makeId('node_provider_sandbox');
  const session = await sessionManager.getSession(sourceId);
  session.currentNode = 'fixture-sandbox';
  session.cwd = 'sandbox://session-cwd';
  await sessionManager.saveSession(sourceId);
  const requests: NodeToolRequest[] = [];
  const descriptor: NodeDescriptor = {
    id: 'fixture-sandbox',
    kind: 'sandbox',
    provider: 'deterministic-test',
    type: 'memory-fixture',
    availability: 'ready',
    defaultCwd: '  sandbox://project-root  ',
    tools: [{ name: 'read', description: 'Read from the deterministic fixture.', parameters: { type: 'object' } }],
  };
  const provider: NodeProvider = {
    id: 'deterministic-test',
    listNodes: () => [descriptor],
    getNode: nodeId => nodeId === descriptor.id ? descriptor : undefined,
    async invokeTool(request) {
      requests.push(request);
      return { output: `fixture:${String(request.args.filePath)}` };
    },
  };
  const registry = new RpcServiceRegistry();
  registry.register(nodeExecutionServiceDescriptor, createNodeExecutionServiceHandler({
    providerRegistry: new NodeProviderRegistry([new MasterNodeProvider(), provider]),
  }));
  const transport = new LocalRpcTransport(registry);
  const client = new RpcClient(nodeExecutionServiceDescriptor, transport);
  const originalGetNode = nodesManager.getNode;
  const originalExecuteTool = nodesManager.executeTool;
  try {
    (nodesManager as any).getNode = () => { throw new Error('sandbox provider must not use WebSocket node lookup'); };
    (nodesManager as any).executeTool = async () => { throw new Error('sandbox provider must not use WebSocket execution'); };
    const topology = await client.call('list', { sourceSessionId: sourceId });
    const sandbox = topology.nodes.find(node => node.id === descriptor.id);
    assert.deepEqual(sandbox && {
      id: sandbox.id,
      kind: sandbox.kind,
      provider: sandbox.provider,
      availability: sandbox.availability,
      tools: sandbox.tools.map(tool => tool.name),
    }, {
      id: 'fixture-sandbox',
      kind: 'sandbox',
      provider: 'deterministic-test',
      availability: 'ready',
      tools: ['read'],
    });
    assert.deepEqual(await client.call('select', { sourceSessionId: sourceId, nodeId: descriptor.id }), {
      nodeId: descriptor.id,
      defaultCwd: '  sandbox://project-root  ',
    });
    assert.equal(await new NodeProviderRegistry([provider]).getDefaultCwd({ sourceSessionId: sourceId, nodeId: descriptor.id, context: { agent: session.agent || 'main' } }), '  sandbox://project-root  ');
    assert.deepEqual(await client.call('execute', {
      sourceSessionId: sourceId,
      nodeId: descriptor.id,
      toolName: 'read',
      args: { filePath: 'notes.txt' },
    }), { result: { output: 'fixture:notes.txt' } });
    await client.call('execute', { sourceSessionId: sourceId, nodeId: descriptor.id, toolName: 'read', args: { filePath: 'deferred.txt' }, routingSnapshot: { currentNode: descriptor.id, cwd: 'sandbox://captured', deferSessionCwdSync: true } });
    assert.deepEqual(requests, [{
      sourceSessionId: sourceId,
      nodeId: descriptor.id,
      toolName: 'read',
      args: { filePath: 'notes.txt' },
      context: { agent: session.agent || 'main', currentNode: descriptor.id, cwd: 'sandbox://session-cwd' },
    }, {
      sourceSessionId: sourceId, nodeId: descriptor.id, toolName: 'read', args: { filePath: 'deferred.txt' },
      context: { agent: session.agent || 'main', currentNode: descriptor.id, cwd: 'sandbox://captured', deferSessionCwdSync: true },
    }]);
  } finally {
    (nodesManager as any).getNode = originalGetNode;
    (nodesManager as any).executeTool = originalExecuteTool;
    await transport.drain().catch(() => {});
    transport.close();
    await sessionManager.deleteSession(sourceId).catch(() => false);
  }
});

test('primitive Node backends derive canonical file tools and preserve provider-owned opaque parent paths', async () => {
  const files = new Map<string, Buffer>([['urn:existing', Buffer.from('hello world\n')]]);
  const observed: any[] = [];
  const descriptors: NodeProviderDescriptor[] = [
    { id: 'primitive-rw', kind: 'sandbox', provider: 'primitive-fixture', type: 'memory', availability: 'ready', primitiveBackends: { filesystem: 'read-write' } },
    { id: 'primitive-ro', kind: 'sandbox', provider: 'primitive-fixture', type: 'memory', availability: 'ready', primitiveBackends: { filesystem: 'read' } },
  ];
  const provider: NodeProvider = {
    id: 'primitive-fixture',
    listNodes: () => descriptors,
    getNode: nodeId => descriptors.find(node => node.id === nodeId),
    async invokeFilesystem(request) {
      observed.push(request);
      const value = files.get(request.path);
      if (request.operation === 'parent') return { path: 'urn:provider-owned-parent' };
      if (request.operation === 'stat') {
        if (!value) { const error: any = new Error('missing'); error.code = 'ENOENT'; throw error; }
        return { kind: 'file', size: value.length, modifiedAtMs: 1 };
      }
      if (request.operation === 'read') {
        if (!value) { const error: any = new Error('missing'); error.code = 'ENOENT'; throw error; }
        return { dataBase64: value.subarray(request.offset!, request.offset! + request.count!).toString('base64') };
      }
      if (request.operation === 'readdir') return [];
      if (request.operation === 'write') {
        if (request.flag === 'wx' && value) { const error: any = new Error('exists'); error.code = 'EEXIST'; throw error; }
        files.set(request.path, Buffer.from(request.contentBase64!, 'base64')); return null;
      }
      if (request.operation === 'remove') { files.delete(request.path); return null; }
      return null;
    },
  };
  const registry = new NodeProviderRegistry([provider]);
  const tools = Object.fromEntries((await registry.listNodes()).map(node => [node.id, node.tools.map(tool => tool.name)]));
  assert.deepEqual(tools['primitive-rw'], ['read', 'write', 'edit', 'apply_patch']);
  assert.deepEqual(tools['primitive-ro'], ['read']);
  const base = { sourceSessionId: 'source', nodeId: 'primitive-rw', context: { agent: 'agent', currentNode: 'primitive-rw', cwd: 'urn:cwd' } };
  assert.equal(await registry.invokeTool({ ...base, toolName: 'read', args: { filePath: 'urn:existing' } }), 'hello world\n');
  await registry.invokeTool({ ...base, toolName: 'edit', args: { filePath: 'urn:existing', oldText: 'world', newText: 'primitive' } });
  await registry.invokeTool({ ...base, toolName: 'apply_patch', args: { input: '*** Begin Patch\n*** Update File: urn:existing\n@@\n-hello primitive\n+hello canonical\n*** Add File: urn:added\n+added\n*** End Patch' } });
  await registry.invokeTool({ ...base, toolName: 'write', args: { filePath: 'urn:new', content: 'new', overwrite: true, createDirs: true } });
  assert.equal(files.get('urn:existing')?.toString(), 'hello canonical\n');
  assert.equal(files.get('urn:added')?.toString(), 'added');
  assert.equal(files.get('urn:new')?.toString(), 'new');
  assert.ok(observed.every(request => request.path.startsWith('urn:')));
  assert.equal(observed.filter(request => request.operation === 'parent').length, 2);
  assert.ok(observed.filter(request => request.operation === 'mkdir').every(request => request.path === 'urn:provider-owned-parent'));
  assert.ok(observed.every(request => !Object.prototype.hasOwnProperty.call(request, 'toolName')));
  await assert.rejects(() => registry.invokeTool({ ...base, nodeId: 'primitive-ro', toolName: 'edit', args: { filePath: 'x', oldText: 'a', newText: 'b' } }),
    (error: any) => error?.code === 'NODE_EXECUTION_TOOL_UNAVAILABLE');
});

test('primitive descriptors reject provider tool schemas and missing advertised backends', async () => {
  const descriptor = (overrides: Partial<NodeDescriptor> = {}): any => ({
    id: 'dishonest', kind: 'sandbox', provider: 'dishonest-provider', type: 'memory', availability: 'ready',
    primitiveBackends: { filesystem: 'read' }, ...overrides,
  });
  for (const provider of [
    { id: 'dishonest-provider', listNodes: () => [descriptor({ tools: [{ name: 'provider_read' }] })], getNode: () => undefined, invokeFilesystem: async () => null },
    { id: 'dishonest-provider', listNodes: () => [descriptor()], getNode: () => undefined },
    { id: 'dishonest-provider', listNodes: () => [descriptor({ primitiveBackends: { exec: true } })], getNode: () => undefined },
  ] as NodeProvider[]) {
    await assert.rejects(() => new NodeProviderRegistry([provider]).listNodes(),
      (error: any) => error?.code === 'NODE_PROVIDER_INVALID_DESCRIPTOR');
  }
});

test('primitive patch Add propagates invalid stat and performs no mutation', async () => {
  const bytes = Buffer.from('existing bytes');
  const calls: string[] = [];
  const descriptor: NodeProviderDescriptor = {
    id: 'invalid-stat', kind: 'sandbox', provider: 'invalid-stat-provider', type: 'memory', availability: 'ready',
    primitiveBackends: { filesystem: 'read-write' },
  };
  const provider: NodeProvider = {
    id: 'invalid-stat-provider', listNodes: () => [descriptor], getNode: nodeId => nodeId === descriptor.id ? descriptor : undefined,
    async invokeFilesystem(request) {
      calls.push(request.operation);
      if (request.operation === 'stat') return null;
      if (request.operation === 'read') return { dataBase64: bytes.toString('base64') };
      throw new Error(`unexpected mutation: ${request.operation}`);
    },
  };
  await assert.rejects(() => new NodeProviderRegistry([provider]).invokeTool({
    sourceSessionId: 'source', nodeId: descriptor.id, toolName: 'apply_patch',
    args: { input: '*** Begin Patch\n*** Add File: opaque-existing\n+replacement\n*** End Patch' },
    context: { agent: 'agent', currentNode: descriptor.id, cwd: 'opaque-cwd' },
  }), /Filesystem stat returned an invalid result/);
  assert.deepEqual(calls, ['stat']);
  assert.equal(bytes.toString(), 'existing bytes');
});

test('direct remote builtin and dynamic node calls share the Node execution service', async () => {
  const sourceId = makeId('node_execution_source');
  const session = await sessionManager.getSession(sourceId);
  session.currentNode = 'remote-a';
  await sessionManager.saveSession(sourceId);
  const originalGetNode = nodesManager.getNode;
  const originalExecuteTool = nodesManager.executeTool;
  const calls: any[] = [];

  try {
    (nodesManager as any).getNode = (nodeId: string) => fakeNode(nodeId, ['read', 'dynamic_probe']);
    (nodesManager as any).executeTool = async (...args: any[]) => {
      calls.push(args);
      return { ok: true, tool: args[1] };
    };

    const direct = await executeTools(
      [{ id: 'remote-read', name: 'read', args: { filePath: 'README.md' } }],
      { sessionId: sourceId, session },
      session,
    );
    assert.deepEqual(direct.parts.find(part => part.functionResponse)?.functionResponse?.response, { ok: true, tool: 'read' });

    const dynamic = await call_tool({
      source: 'node',
      nodeId: 'remote-a',
      name: 'dynamic_probe',
      args: { value: 1 },
    }, { sessionId: sourceId, session });
    assert.deepEqual(dynamic, { ok: true, tool: 'dynamic_probe' });
    assert.deepEqual(calls.map(call => call.slice(0, 4)), [
      ['remote-a', 'read', { filePath: 'README.md' }, sourceId],
      ['remote-a', 'dynamic_probe', { value: 1 }, sourceId],
    ]);
  } finally {
    (nodesManager as any).getNode = originalGetNode;
    (nodesManager as any).executeTool = originalExecuteTool;
    await cleanup(sourceId);
  }
});

test('isolated bound-node advertised tools remain usable in Main-local and Worker reverse placement', async () => {
  const sourceId = makeId('node_execution_isolated_dynamic');
  const agentName = makeId('node_execution_isolated_agent');
  const session = await sessionManager.getSession(sourceId);
  session.agent = agentName;
  session.currentNode = 'bound-node';
  await sessionManager.saveSession(sourceId);
  await sessionManager.setAgentMetadata(agentName, { isolated: true, isolatedNode: 'bound-node' });
  const originalGetNode = nodesManager.getNode;
  const originalExecuteTool = nodesManager.executeTool;
  let reverseTransport: LocalRpcTransport | undefined;
  const calls: any[] = [];

  try {
    (nodesManager as any).getNode = (nodeId: string) => fakeNode(nodeId, ['custom_probe']);
    (nodesManager as any).executeTool = async (...args: any[]) => {
      calls.push(args);
      return { ok: true, nodeId: args[0], tool: args[1] };
    };

    const descriptor = { source: 'node', nodeId: 'bound-node', name: 'custom_probe', args: { value: 1 } };
    assert.deepEqual(await call_tool(descriptor, { sessionId: sourceId, session }), {
      ok: true, nodeId: 'bound-node', tool: 'custom_probe',
    });
    await assert.rejects(
      () => call_tool({ ...descriptor, nodeId: 'other-node' }, { sessionId: sourceId, session }),
      (error: any) => error?.code === 'NODE_EXECUTION_ISOLATED_NODE_DENIED',
    );
    await assert.rejects(
      () => call_tool({ ...descriptor, nodeId: 'master' }, { sessionId: sourceId, session }),
      /not available on node `master`/,
    );
    await sessionManager.setAgentMetadata(agentName, {
      isolated: true,
      isolatedNode: 'bound-node',
      toolRules: [
        { effect: 'allow', source: 'node', node: 'other-node', tool: 'custom_probe' },
        { effect: 'allow', source: 'node', node: 'master', tool: 'exec' },
      ],
    });
    await assert.rejects(
      () => call_tool({ ...descriptor, nodeId: 'other-node' }, { sessionId: sourceId, session }),
      (error: any) => error?.code === 'NODE_EXECUTION_ISOLATED_NODE_DENIED',
    );
    await assert.rejects(
      () => call_tool({ source: 'node', nodeId: 'master', name: 'exec', args: { command: 'echo forbidden' } }, { sessionId: sourceId, session }),
      /cannot run exec on master/i,
    );

    await nodeExecution.shutdownNodeExecution();
    nodeExecution.resetNodeExecutionForTests();
    const registry = new RpcServiceRegistry();
    registry.register(nodeExecutionServiceDescriptor, createNodeExecutionServiceHandler({ expectedSourceSessionId: sourceId }));
    reverseTransport = new LocalRpcTransport(registry);
    await nodeExecution.initializeNodeExecution({ transport: reverseTransport, placement: 'child-reverse' });
    const workerContext = {
      sessionId: sourceId,
      session,
      sessionPlacement: 'session-worker',
      persistCurrentSession: async () => {},
    } as any;

    assert.deepEqual(await call_tool(descriptor, workerContext), {
      ok: true, nodeId: 'bound-node', tool: 'custom_probe',
    });
    await assert.rejects(
      () => call_tool({ ...descriptor, nodeId: 'other-node' }, workerContext),
      (error: any) => error?.code === 'NODE_EXECUTION_ISOLATED_NODE_DENIED',
    );
    await assert.rejects(
      () => call_tool({ ...descriptor, nodeId: 'master' }, workerContext),
      /not available on node `master`/,
    );
    assert.deepEqual(calls.map(call => [call[0], call[1], call[3]]), [
      ['bound-node', 'custom_probe', sourceId],
      ['bound-node', 'custom_probe', sourceId],
    ]);
  } finally {
    await nodeExecution.shutdownNodeExecution().catch(() => {});
    nodeExecution.resetNodeExecutionForTests();
    if (reverseTransport) {
      await reverseTransport.drain().catch(() => {});
      reverseTransport.close();
    }
    (nodesManager as any).getNode = originalGetNode;
    (nodesManager as any).executeTool = originalExecuteTool;
    await sessionManager.setAgentMetadata(agentName, { isolated: false }).catch(() => {});
    await sessionManager.deleteSession(sourceId).catch(() => false);
  }
});

test('master-currentNode node tools bypass Node execution RPC', async () => {
  const sourceId = makeId('node_execution_master');
  const session = await sessionManager.getSession(sourceId);
  session.currentNode = 'master';
  await sessionManager.saveSession(sourceId);
  const originalRemoteExecute = (nodeExecution as any).executeNodeTool;
  let remoteCalls = 0;
  (nodeExecution as any).executeNodeTool = async () => {
    remoteCalls += 1;
    throw new Error('remote service must not be called');
  };

  try {
    const result = await executeTools(
      [{ id: 'local-read', name: 'read', args: { filePath: `${process.cwd()}/package.json`, startLine: 1, endLine: 1 } }],
      { sessionId: sourceId, session },
      session,
    );
    assert.equal(result.parts.find(part => part.functionResponse)?.functionResponse?.response.error, undefined);
    assert.equal(remoteCalls, 0);
  } finally {
    (nodeExecution as any).executeNodeTool = originalRemoteExecute;
    await cleanup(sourceId);
  }
});

test('routing snapshots preserve parallel exec cwd and dynamic other-node calls carry no cwd snapshot', async () => {
  const sourceId = makeId('node_execution_snapshot');
  const session = await sessionManager.getSession(sourceId);
  session.currentNode = 'remote-a';
  session.cwd = '/remote/work';
  await sessionManager.saveSession(sourceId);
  const originalGetNode = nodesManager.getNode;
  const originalExecuteTool = nodesManager.executeTool;
  const snapshots: any[] = [];

  try {
    (nodesManager as any).getNode = (nodeId: string) => fakeNode(nodeId, ['exec', 'dynamic_probe']);
    (nodesManager as any).executeTool = async (_nodeId: string, toolName: string, _args: any, _sessionId: string, snapshot?: any) => {
      snapshots.push({ toolName, snapshot });
      return { output: 'ok' };
    };

    await executeTools([
      { id: 'exec-a', name: 'exec', args: { command: 'echo a' } },
      { id: 'exec-b', name: 'exec', args: { command: 'echo b' } },
    ], { sessionId: sourceId, session }, session);
    assert.deepEqual(snapshots.slice(0, 2), [
      { toolName: 'exec', snapshot: { currentNode: 'remote-a', cwd: '/remote/work' } },
      { toolName: 'exec', snapshot: { currentNode: 'remote-a', cwd: '/remote/work' } },
    ]);

    session.currentNode = 'master';
    session.cwd = '/master/local';
    await sessionManager.saveSession(sourceId);
    await call_tool({ source: 'node', nodeId: 'remote-b', name: 'dynamic_probe', args: {} }, { sessionId: sourceId, session });
    assert.deepEqual(snapshots[2], { toolName: 'dynamic_probe', snapshot: undefined });
  } finally {
    (nodesManager as any).getNode = originalGetNode;
    (nodesManager as any).executeTool = originalExecuteTool;
    await cleanup(sourceId);
  }
});

test('Node execution rejects master, stale, offline, unadvertised, and isolated-denied targets', async () => {
  const sourceId = makeId('node_execution_guard');
  const agentName = makeId('node_execution_agent');
  const session = await sessionManager.getSession(sourceId);
  session.agent = agentName;
  session.currentNode = 'bound-node';
  await sessionManager.saveSession(sourceId);
  const originalGetNode = nodesManager.getNode;
  const originalExecuteTool = nodesManager.executeTool;
  const originalList = nodesManager.listNodesWithTools;
  const originalSelect = nodesManager.setCurrentNode;
  const originalRead = nodesManager.readFileFromNode;
  const originalWrite = nodesManager.writeFileToNode;

  try {
    (nodesManager as any).executeTool = async () => ({ ok: true });
    await assert.rejects(
      () => nodeExecution.executeNodeTool(sourceId, 'master', 'read', {}),
      (error: any) => error?.code === 'NODE_EXECUTION_MASTER_FORBIDDEN',
    );
    await assert.rejects(
      () => nodeExecution.executeNodeTool(makeId('missing'), 'remote-a', 'read', {}),
      (error: any) => error?.code === 'NODE_EXECUTION_SOURCE_NOT_FOUND',
    );
    (nodesManager as any).getNode = (): any => undefined;
    await assert.rejects(
      () => nodeExecution.executeNodeTool(sourceId, 'remote-a', 'read', {}),
      (error: any) => error?.code === 'NODE_EXECUTION_NODE_UNAVAILABLE',
    );
    (nodesManager as any).getNode = (nodeId: string) => fakeNode(nodeId, ['other_tool']);
    await assert.rejects(
      () => nodeExecution.executeNodeTool(sourceId, 'remote-a', 'read', {}),
      (error: any) => error?.code === 'NODE_EXECUTION_TOOL_UNAVAILABLE',
    );

    await sessionManager.setAgentMetadata(agentName, { isolated: true, isolatedNode: 'bound-node' });
    (nodesManager as any).getNode = (nodeId: string) => fakeNode(nodeId, ['read']);
    (nodesManager as any).listNodesWithTools = () => [{ id: 'bound-node', type: 'node', tools: [{ name: 'read' }] },
      { id: 'other-node', type: 'node', tools: [{ name: 'read' }] }];
    (nodesManager as any).setCurrentNode = () => {};
    (nodesManager as any).readFileFromNode = async () => ({ dataBase64: 'Ynl0ZXM=', sizeBytes: 5,
      sha256: createHash('sha256').update('bytes').digest('hex') });
    (nodesManager as any).writeFileToNode = async () => ({ sha256: 'b'.repeat(64), overwritten: false });
    assert.deepEqual(await nodeExecution.executeNodeTool(sourceId, 'bound-node', 'read', {}), { ok: true });
    assert.deepEqual((await nodeExecution.listNodeTopology(sourceId)).map(node => node.id), ['master', 'bound-node']);
    assert.deepEqual((await nodeExecution.listNodeTopology(sourceId, undefined, 'other-node')).map(node => node.id), ['master', 'bound-node']);
    assert.equal((await nodeExecution.validateNodeSelection(sourceId, 'bound-node')).nodeId, 'bound-node');
    assert.equal((await nodeExecution.copyBetweenNodes(sourceId, { sourceNode: 'master', sourcePath: `${getAgentDir(agentName)}/from`, targetNode: 'bound-node', targetPath: '/to' })).sha256, 'b'.repeat(64));
    assert.equal((await nodeExecution.copyBetweenNodes(sourceId, { sourceNode: 'bound-node', sourcePath: '/from', targetNode: 'master', targetPath: `${getAgentDir(agentName)}/to` })).sha256, 'b'.repeat(64));
    await assert.rejects(
      () => nodeExecution.executeNodeTool(sourceId, 'other-node', 'read', {}),
      (error: any) => error?.code === 'NODE_EXECUTION_ISOLATED_NODE_DENIED',
    );
    await assert.rejects(() => nodeExecution.validateNodeSelection(sourceId, 'other-node'),
      (error: any) => error?.code === 'NODE_EXECUTION_ISOLATED_NODE_DENIED');
    await assert.rejects(() => nodeExecution.copyBetweenNodes(sourceId, { sourceNode: 'master', sourcePath: `${getAgentDir(agentName)}/from`, targetNode: 'other-node', targetPath: '/to' }), /bound\/current node/);
  } finally {
    await sessionManager.setAgentMetadata(agentName, { isolated: false }).catch(() => {});
    (nodesManager as any).getNode = originalGetNode;
    (nodesManager as any).executeTool = originalExecuteTool;
    (nodesManager as any).listNodesWithTools = originalList;
    (nodesManager as any).setCurrentNode = originalSelect;
    (nodesManager as any).readFileFromNode = originalRead;
    (nodesManager as any).writeFileToNode = originalWrite;
    await cleanup(sourceId);
  }
});

test('Node execution clones results and preserves remote image/error handling', async () => {
  const sourceId = makeId('node_execution_result');
  const session = await sessionManager.getSession(sourceId);
  session.currentNode = 'remote-a';
  await sessionManager.saveSession(sourceId);
  const originalGetNode = nodesManager.getNode;
  const originalExecuteTool = nodesManager.executeTool;
  const shared = { nested: { value: 1 } };
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nGQAAAAASUVORK5CYII=';

  try {
    (nodesManager as any).getNode = (nodeId: string) => fakeNode(nodeId, ['read']);
    (nodesManager as any).executeTool = async () => shared;
    const cloned = await nodeExecution.executeNodeTool(sourceId, 'remote-a', 'read', {});
    cloned.nested.value = 9;
    assert.equal(shared.nested.value, 1);

    (nodesManager as any).executeTool = async () => ({ inlineData: { data: png, mimeType: 'image/png' } });
    const imageResult = await executeTools(
      [{ id: 'remote-image', name: 'read', args: { filePath: 'image.png' } }],
      { sessionId: sourceId, session }, session,
    );
    assert.equal(imageResult.parts.some(part => part.inlineData?.mimeType === 'image/png'), true);

    (nodesManager as any).executeTool = async () => { throw new Error('remote execution failed'); };
    const errorResult = await executeTools(
      [{ id: 'remote-error', name: 'read', args: { filePath: 'missing' } }],
      { sessionId: sourceId, session }, session,
    );
    assert.match(String(errorResult.parts.find(part => part.functionResponse)?.functionResponse?.response.error), /remote execution failed/);
  } finally {
    (nodesManager as any).getNode = originalGetNode;
    (nodesManager as any).executeTool = originalExecuteTool;
    await cleanup(sourceId);
  }
});

test('terminal shutdown drains accepted Node execution and fences new calls', async () => {
  const sourceId = makeId('node_execution_drain');
  await sessionManager.getSession(sourceId);
  const originalGetNode = nodesManager.getNode;
  const originalExecuteTool = nodesManager.executeTool;
  let markStarted!: () => void;
  let releaseHandler!: () => void;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const release = new Promise<void>(resolve => { releaseHandler = resolve; });

  try {
    (nodesManager as any).getNode = (nodeId: string) => fakeNode(nodeId, ['read']);
    (nodesManager as any).executeTool = async () => {
      markStarted();
      await release;
      return 'done';
    };
    const accepted = nodeExecution.executeNodeTool(sourceId, 'remote-a', 'read', {});
    await started;
    let settled = false;
    const shutdown = nodeExecution.shutdownNodeExecution().then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false);
    await assert.rejects(
      () => nodeExecution.executeNodeTool(sourceId, 'remote-a', 'read', {}),
      (error: any) => error?.code === 'NODE_EXECUTION_SHUTDOWN',
    );
    releaseHandler();
    assert.equal(await accepted, 'done');
    await shutdown;
    assert.deepEqual(nodeExecution.getNodeExecutionStatus(), { placement: 'local', ready: false });
  } finally {
    releaseHandler?.();
    (nodesManager as any).getNode = originalGetNode;
    (nodesManager as any).executeTool = originalExecuteTool;
    await cleanup(sourceId);
  }
});
