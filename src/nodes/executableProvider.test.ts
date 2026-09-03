import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { executeTools } from '../llm';
import * as nodeExecution from '../nodeExecution';
import { createNodeExecutionServiceHandler, nodeExecutionServiceDescriptor } from '../nodeExecutionService';
import { LocalRpcTransport, RpcClient, RpcServiceRegistry } from '../rpc';
import * as sessionManager from '../sessionManager';
import { callTool } from '../tools';
import { tool_call_tool, tool_search_tools } from '../tools/unifiedSearch';
import { tool_run_script } from '../toolscript';
import { ExecutableNodeProvider } from './executableProvider';
import { MasterNodeProvider, NodeProviderRegistry, type NodeDescriptor, type NodeProvider, type NodeToolRequest } from './providerRegistry';

async function invokeProviderTool(provider: ExecutableNodeProvider, request: NodeToolRequest): Promise<unknown> {
  return new NodeProviderRegistry([provider]).invokeTool(request);
}

const fixturePath = path.join(__dirname, 'executableProviderTestFixture.js');
const execFileAsync = promisify(execFile);

function id(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function executableProvider(mode: string, logPath: string, timeoutMs = 2_000, providerId = `fixture-${mode}`): ExecutableNodeProvider {
  return new ExecutableNodeProvider({
    id: providerId.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64),
    type: 'executable',
    command: process.execPath,
    args: [fixturePath, mode, logPath],
    timeoutMs,
  });
}

function request(nodeId = 'fixture-sandbox', toolName = 'read'): NodeToolRequest {
  return {
    sourceSessionId: 'fixture-source',
    nodeId,
    toolName,
    args: { filePath: 'memfs://fixture/input.txt' },
    context: { agent: 'fixture-agent', currentNode: nodeId, cwd: 'memfs://fixture/session' },
  };
}

async function readLog(logPath: string): Promise<any[]> {
  if (!await fs.pathExists(logPath)) return [];
  return (await fs.readFile(logPath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error: any) { return error?.code === 'EPERM'; }
}

async function cleanupExecution(transport?: LocalRpcTransport): Promise<void> {
  await nodeExecution.shutdownNodeExecution().catch(() => {});
  nodeExecution.resetNodeExecutionForTests();
  if (transport) {
    await transport.drain().catch(() => {});
    transport.close();
  }
}

test('production registry loads zero or more executable providers from startup app config', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-executable-provider-config-'));
  const configPath = path.join(dir, 'config.yaml');
  const logPath = path.join(dir, 'requests.jsonl');
  await fs.writeFile(configPath, JSON.stringify({
    nodeProviders: {
      'startup-fixture': {
        type: 'executable',
        command: process.execPath,
        args: [fixturePath, 'normal', logPath],
        timeoutSeconds: 2,
      },
    },
  }), 'utf8');
  const providersPath = path.join(__dirname, 'providers.js');
  const script = `const fs=require('node:fs');const {nodeProviderRegistry}=require(${JSON.stringify(providersPath)});nodeProviderRegistry.listNodes().then(nodes=>{fs.writeSync(1,'PROVIDER_RESULT '+JSON.stringify(nodes.filter(n=>n.provider==='startup-fixture'))+'\\n');process.reallyExit(0)},error=>{console.error(error);process.reallyExit(1)})`;
  try {
    const result = await execFileAsync(process.execPath, ['-e', script], {
      cwd: path.join(__dirname, '..', '..'),
      env: { ...process.env, FOXWARM_CONFIG_PATH: configPath, FOXWARM_DATA_DIR: dir },
      timeout: 10_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const line = result.stdout.split(/\r?\n/).find(item => item.startsWith('PROVIDER_RESULT '));
    assert.ok(line);
    const nodes = JSON.parse(line.slice('PROVIDER_RESULT '.length));
    assert.deepEqual(nodes.map((node: any) => [node.id, node.kind, node.provider, node.defaultCwd]), [
      ['fixture-sandbox', 'sandbox', 'startup-fixture', 'memfs://fixture-sandbox/root'],
      ['fixture-secondary', 'sandbox', 'startup-fixture', 'memfs://fixture-secondary/root'],
    ]);
  } finally {
    await fs.remove(dir);
  }
});

test('configured executable provider derives canonical tools and preserves exact Worker direct/unified/ToolScript context', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-executable-provider-'));
  const logPath = path.join(dir, 'requests.jsonl');
  const sourceId = id('executable-source');
  const agent = id('executable-agent');
  const session = await sessionManager.getSession(sourceId);
  session.agent = agent;
  session.currentNode = 'fixture-sandbox';
  session.cwd = 'memfs://fixture/session';
  await sessionManager.saveSession(sourceId);
  const originalSecret = process.env.FOXWARM_PROVIDER_SECRET_TEST;
  process.env.FOXWARM_PROVIDER_SECRET_TEST = 'must-not-reach-provider';

  const provider = executableProvider('normal', logPath, 2_000, 'configured-fixture');
  const serviceRegistry = new RpcServiceRegistry();
  serviceRegistry.register(nodeExecutionServiceDescriptor, createNodeExecutionServiceHandler({
    expectedSourceSessionId: sourceId,
    providerRegistry: new NodeProviderRegistry([new MasterNodeProvider(), provider]),
  }));
  const transport = new LocalRpcTransport(serviceRegistry);
  await nodeExecution.initializeNodeExecution({ transport, placement: 'child-reverse' });
  const ctx: any = {
    sessionId: sourceId,
    session,
    sessionPlacement: 'session-worker',
    persistCurrentSession: async () => {},
  };
  const effects: any = {
    placement: 'session-worker',
    appendMessage: async () => {},
    persistSession: async () => {},
    notifySessionEvent: () => {},
    registerAbortController: () => {},
    clearAbortController: () => {},
    clearWaitById: async () => false,
  };

  try {
    const topology = await nodeExecution.listNodeTopology(sourceId);
    assert.deepEqual(topology.filter(node => node.kind === 'sandbox').map(node => node.id), ['fixture-sandbox', 'fixture-secondary']);
    assert.deepEqual(topology.find(node => node.id === 'fixture-sandbox'), {
      id: 'fixture-sandbox',
      kind: 'sandbox',
      provider: 'configured-fixture',
      type: 'memory-fixture',
      availability: 'ready',
      tools: (await new NodeProviderRegistry([provider]).listNodes()).find(node => node.id === 'fixture-sandbox')!.tools,
    });
    assert.deepEqual(await nodeExecution.validateNodeSelection(sourceId, 'fixture-sandbox'), {
      nodeId: 'fixture-sandbox',
      defaultCwd: 'memfs://fixture-sandbox/root',
    });

    const direct = await executeTools(
      [{ id: 'direct-fixture-read', name: 'read', args: { filePath: 'memfs://fixture/direct.txt' } }],
      { sessionId: sourceId },
      session,
      { currentSessionEffects: effects },
    );
    assert.match(JSON.stringify(direct), /fixture-read/);
    assert.equal(await tool_call_tool({
      source: 'node',
      nodeId: 'fixture-sandbox',
      name: 'read',
      args: { filePath: 'memfs://fixture/unified.txt' },
    }, ctx), 'fixture-read');
    const scripted = await tool_run_script({
      code: 'def main(args):\n    return call_tool(source="node", nodeId="fixture-sandbox", name="read", args={"filePath": "memfs://fixture/script.txt"})',
    }, ctx);
    assert.equal(scripted.status, 'completed');
    assert.match(JSON.stringify(scripted.result), /fixture-read/);

    const callsBeforeUnsupported = (await readLog(logPath)).filter(entry => entry.request.operation === 'filesystem').length;
    await assert.rejects(
      () => tool_call_tool({ source: 'node', nodeId: 'fixture-sandbox', name: 'exec', args: { command: 'must-not-run-on-master' } }, ctx),
      (error: any) => error?.code === 'NODE_EXECUTION_TOOL_UNAVAILABLE',
    );
    assert.equal((await readLog(logPath)).filter(entry => entry.request.operation === 'filesystem').length, callsBeforeUnsupported);

    await sessionManager.setAgentMetadata(agent, {
      isolated: true,
      isolatedNode: 'fixture-sandbox',
      toolRules: [
        { effect: 'allow', source: 'builtin', tool: 'run_script' },
        { effect: 'deny', source: 'node', node: 'fixture-sandbox', tool: 'read' },
      ],
    });
    const callsBeforeDeny = (await readLog(logPath)).filter(entry => entry.request.operation === 'filesystem').length;
    await assert.rejects(() => callTool('read', { filePath: 'memfs://fixture/denied.txt' }, ctx), /tool rule denies/i);
    assert.equal((await readLog(logPath)).filter(entry => entry.request.operation === 'filesystem').length, callsBeforeDeny);

    await sessionManager.setAgentMetadata(agent, {
      isolated: true,
      isolatedNode: 'fixture-sandbox',
      toolRules: [
        { effect: 'allow', source: 'builtin', tool: 'run_script' },
        { effect: 'allow', source: 'node', node: 'fixture-sandbox', tool: 'read' },
        { effect: 'allow', source: 'node', node: 'fixture-secondary', tool: 'read' },
      ],
    });
    assert.match(JSON.stringify(await callTool('read', { filePath: 'memfs://fixture/allowed.txt' }, ctx)), /fixture-read/);
    await assert.rejects(
      () => tool_call_tool({ source: 'node', nodeId: 'fixture-secondary', name: 'read', args: { filePath: 'x' } }, ctx),
      (error: any) => error?.code === 'NODE_EXECUTION_ISOLATED_NODE_DENIED',
    );

    const primitives = (await readLog(logPath)).filter(entry => entry.request.operation === 'filesystem').map(entry => entry.request.request);
    assert.equal(primitives.length >= 8, true);
    for (const primitive of primitives) {
      assert.equal(primitive.sourceSessionId, sourceId);
      assert.equal(primitive.nodeId, 'fixture-sandbox');
      assert.ok(['stat', 'read'].includes(primitive.operation));
      assert.deepEqual(primitive.context, { agent, currentNode: 'fixture-sandbox', cwd: 'memfs://fixture/session' });
      assert.equal(Object.prototype.hasOwnProperty.call(primitive, 'toolName'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(primitive, 'args'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(primitive, 'command'), false);
    }
  } finally {
    await cleanupExecution(transport);
    await sessionManager.setAgentMetadata(agent, { isolated: false }).catch(() => {});
    await sessionManager.deleteSession(sourceId).catch(() => false);
    if (originalSecret === undefined) delete process.env.FOXWARM_PROVIDER_SECRET_TEST;
    else process.env.FOXWARM_PROVIDER_SECRET_TEST = originalSecret;
    await fs.remove(dir);
  }
});

test('colon executable Node IDs round-trip through canonical discovery tool IDs', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-executable-provider-colon-id-'));
  const logPath = path.join(dir, 'requests.jsonl');
  const sourceId = id('colon-id-source');
  const session = await sessionManager.getSession(sourceId);
  session.currentNode = 'fixture:sandbox';
  session.cwd = 'memfs://fixture:session';
  await sessionManager.saveSession(sourceId);
  const serviceRegistry = new RpcServiceRegistry();
  serviceRegistry.register(nodeExecutionServiceDescriptor, createNodeExecutionServiceHandler({
    expectedSourceSessionId: sourceId,
    providerRegistry: new NodeProviderRegistry([
      new MasterNodeProvider(),
      executableProvider('colon-id', logPath, 2_000, 'colon-provider'),
    ]),
  }));
  const transport = new LocalRpcTransport(serviceRegistry);
  await nodeExecution.initializeNodeExecution({ transport, placement: 'child-reverse' });
  const ctx: any = {
    sessionId: sourceId,
    session,
    sessionPlacement: 'session-worker',
    persistCurrentSession: async () => {},
  };
  try {
    const discovered: any = await tool_search_tools({
      sources: ['node'],
      nodeId: 'fixture:sandbox',
      includeSchema: false,
    }, ctx);
    assert.match(discovered.output, /node:fixture:sandbox\/read\(\/\* schema omitted \*\/\);/);
    const result: any = await tool_call_tool({
      toolId: 'node:fixture:sandbox/read',
      args: { filePath: 'memfs://fixture:colon/read.txt' },
    }, ctx);
    assert.equal(result, 'fixture-read');
  } finally {
    await cleanupExecution(transport);
    await sessionManager.deleteSession(sourceId).catch(() => false);
    await fs.remove(dir);
  }
});

test('executable providers expose exec only from the fixed exec backend', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-executable-provider-exec-'));
  const logPath = path.join(dir, 'requests.jsonl');
  try {
    const registry = new NodeProviderRegistry([executableProvider('with-exec', logPath, 2_000, 'exec-provider')]);
    const node = (await registry.listNodes()).find(item => item.id === 'fixture-sandbox')!;
    assert.ok(node.tools.some(tool => tool.name === 'exec'));
    const result: any = await registry.invokeTool({ ...request(), toolName: 'exec', args: { command: 'pwd' } });
    assert.equal(result.output, 'fixture-exec');
    const calls = await readLog(logPath);
    assert.equal(calls.at(-1).request.operation, 'exec');
    assert.equal(Object.prototype.hasOwnProperty.call(calls.at(-1).request.request, 'toolName'), false);
  } finally { await fs.remove(dir); }
});

test('executable provider rejects malformed, mismatched, oversized, and abnormal protocol/process responses without exposing stderr', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-executable-provider-errors-'));
  try {
    for (const [mode, code] of [
      ['malformed', 'NODE_PROVIDER_PROTOCOL_INVALID_RESPONSE'],
      ['multiple', 'NODE_PROVIDER_PROTOCOL_INVALID_RESPONSE'],
      ['protocol-mismatch', 'NODE_PROVIDER_PROTOCOL_MISMATCH'],
      ['provider-mismatch', 'NODE_PROVIDER_ID_MISMATCH'],
      ['request-mismatch', 'NODE_PROVIDER_REQUEST_MISMATCH'],
      ['operation-mismatch', 'NODE_PROVIDER_OPERATION_MISMATCH'],
      ['bad-envelope', 'NODE_PROVIDER_PROTOCOL_INVALID_RESPONSE'],
      ['oversized', 'NODE_PROVIDER_OUTPUT_LIMIT'],
      ['bad-descriptor', 'NODE_PROVIDER_INVALID_DESCRIPTOR'],
      ['oversized-schema', 'NODE_PROVIDER_INVALID_DESCRIPTOR'],
      ['slash-id', 'NODE_PROVIDER_INVALID_DESCRIPTOR'],
      ['reserved-id', 'NODE_PROVIDER_INVALID_DESCRIPTOR'],
    ] as const) {
      const provider = executableProvider(mode, path.join(dir, `${mode}.jsonl`));
      await assert.rejects(() => provider.listNodes(), (error: any) => error?.code === code);
    }

    for (const mode of ['nonzero', 'signal'] as const) {
      const provider = executableProvider(mode, path.join(dir, `${mode}.jsonl`));
      await assert.rejects(
        () => provider.listNodes(),
        (error: any) => error?.code === 'NODE_PROVIDER_PROCESS_EXIT' && !String(error.message).includes('super-secret-provider-detail'),
      );
    }

    const errorProvider = executableProvider('error', path.join(dir, 'error.jsonl'));
    await assert.rejects(
      () => invokeProviderTool(errorProvider, request()),
      (error: any) => error?.code === 'FixtureDenied',
    );

    const oversizedInvoke = executableProvider('oversized-invoke', path.join(dir, 'oversized-invoke.jsonl'));
    await assert.rejects(() => invokeProviderTool(oversizedInvoke, request()), (error: any) => error?.code === 'NODE_PROVIDER_OUTPUT_LIMIT');

    const privateCommand = path.join(dir, 'private-provider-secret-command');
    const missing = new ExecutableNodeProvider({
      id: 'missing-command', type: 'executable', command: privateCommand, args: [], timeoutMs: 1_000,
    });
    await assert.rejects(
      () => missing.listNodes(),
      (error: any) => error?.code === 'NODE_PROVIDER_PROCESS_START' && !String(error.message).includes(privateCommand),
    );

    const invalidLog = path.join(dir, 'invalid-request.jsonl');
    const invalidRequestProvider = executableProvider('normal', invalidLog, 2_000, 'invalid-request');
    await assert.rejects(
      () => invalidRequestProvider.invokeFilesystem({ sourceSessionId: 'fixture-source', nodeId: 'fixture-sandbox', operation: 'stat', path: 'x', context: { agent: 'fixture-agent' }, callback: (() => {}) } as any),
      (error: any) => error?.code === 'NODE_PROVIDER_INVALID_REQUEST',
    );
    await assert.rejects(
      () => invalidRequestProvider.invokeFilesystem({ sourceSessionId: 'fixture-source', nodeId: 'fixture-sandbox', operation: 'write', path: 'x', contentBase64: 'x'.repeat(5 * 1024 * 1024), flag: 'w', context: { agent: 'fixture-agent' } }),
      (error: any) => error?.code === 'NODE_PROVIDER_REQUEST_LIMIT',
    );
    assert.equal(await fs.pathExists(invalidLog), false);
  } finally {
    await fs.remove(dir);
  }
});

test('executable provider timeout, cancellation, and stderr bounds terminate and reap the one-shot child', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-executable-provider-cleanup-'));
  try {
    for (const [mode, expectedCode] of [['hang', 'NODE_PROVIDER_TIMEOUT'], ['stderr-overflow', 'NODE_PROVIDER_STDERR_LIMIT']] as const) {
      const logPath = path.join(dir, `${mode}.jsonl`);
      const provider = executableProvider(mode, logPath, mode === 'hang' ? 100 : 2_000);
      await assert.rejects(() => provider.listNodes(), (error: any) => error?.code === expectedCode);
      const entries = await readLog(logPath);
      assert.equal(entries.length, 1);
      assert.equal(pidAlive(entries[0].pid), false);
    }

    const cancelLog = path.join(dir, 'cancel.jsonl');
    const provider = executableProvider('hang', cancelLog, 10_000, 'fixture-cancel');
    const controller = new AbortController();
    const pending = provider.listNodes({ signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(() => pending, (error: any) => error?.code === 'NODE_PROVIDER_CANCELLED');
    const entries = await readLog(cancelLog);
    assert.equal(entries.length, 1);
    assert.equal(pidAlive(entries[0].pid), false);
  } finally {
    await fs.remove(dir);
  }
});

test('Node execution RPC cancellation reaches and reaps an executable provider child', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-executable-provider-rpc-cancel-'));
  const logPath = path.join(dir, 'cancel.jsonl');
  const sourceId = id('rpc-cancel-source');
  await sessionManager.getSession(sourceId);
  const serviceRegistry = new RpcServiceRegistry();
  serviceRegistry.register(nodeExecutionServiceDescriptor, createNodeExecutionServiceHandler({
    expectedSourceSessionId: sourceId,
    providerRegistry: new NodeProviderRegistry([
      new MasterNodeProvider(),
      executableProvider('hang', logPath, 10_000, 'rpc-cancel-provider'),
    ]),
  }));
  const transport = new LocalRpcTransport(serviceRegistry);
  const client = new RpcClient(nodeExecutionServiceDescriptor, transport);
  try {
    const controller = new AbortController();
    const pending = client.call('execute', {
      sourceSessionId: sourceId,
      nodeId: 'fixture-sandbox',
      toolName: 'read',
      args: { filePath: 'memfs://fixture/cancel.txt' },
    }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(() => pending, (error: any) => error?.name === 'AbortError');
    await transport.drain(3_000);
    const entries = await readLog(logPath);
    assert.equal(entries.length >= 1, true);
    assert.equal(entries.every(entry => !pidAlive(entry.pid)), true);
  } finally {
    transport.close();
    await sessionManager.deleteSession(sourceId).catch(() => false);
    await fs.remove(dir);
  }
});

test('exited provider with inherited stdio settles within its bound and does not retain the direct child', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-executable-provider-inherited-stdio-'));
  const logPath = path.join(dir, 'requests.jsonl');
  const provider = executableProvider('inherited-stdio', logPath, 100, 'inherited-stdio-provider');
  const startedAt = Date.now();
  try {
    await assert.rejects(
      () => provider.listNodes(),
      (error: any) => error?.code === 'NODE_PROVIDER_TIMEOUT' || error?.code === 'NODE_PROVIDER_PROCESS_CLOSE_TIMEOUT',
    );
    assert.equal(Date.now() - startedAt < 1_000, true);
    const entries = await readLog(logPath);
    assert.equal(entries.length, 1);
    assert.equal(pidAlive(entries[0].pid), false);
  } finally {
    await fs.remove(dir);
  }
});

test('registry filters unavailable and absent executable backends without primitive calls or master fallback', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-executable-provider-filter-'));
  try {
    for (const [mode, toolName, expectedCode] of [
      ['unavailable', 'read', 'NODE_EXECUTION_NODE_UNAVAILABLE'],
      ['normal', 'exec', 'NODE_EXECUTION_TOOL_UNAVAILABLE'],
    ] as const) {
      const logPath = path.join(dir, `${mode}-${toolName}.jsonl`);
      const registry = new NodeProviderRegistry([new MasterNodeProvider(), executableProvider(mode, logPath, 2_000, `filter-${mode}`)]);
      await assert.rejects(() => registry.invokeTool(request('fixture-sandbox', toolName)), (error: any) => error?.code === expectedCode);
      const entries = await readLog(logPath);
      assert.equal(entries.filter(entry => ['filesystem', 'exec'].includes(entry.request.operation)).length, 0);
    }
  } finally {
    await fs.remove(dir);
  }
});

test('fixed master/remote-style Node authority does not depend on deferred executable provider health', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-executable-provider-priority-'));
  const logPath = path.join(dir, 'malformed.jsonl');
  const descriptor: NodeDescriptor = {
    id: 'existing-remote',
    kind: 'remote',
    provider: 'fixed-remote',
    type: 'worker',
    availability: 'ready',
    tools: [{ name: 'read' }],
  };
  const fixed: NodeProvider = {
    id: 'fixed-remote',
    listNodes: () => [descriptor],
    getNode: nodeId => nodeId === descriptor.id ? descriptor : undefined,
    invokeTool: async () => ({ output: 'fixed-remote-result' }),
  };
  try {
    const registry = new NodeProviderRegistry([fixed, executableProvider('malformed', logPath, 2_000, 'broken-deferred')]);
    assert.deepEqual(await registry.invokeTool(request('existing-remote')), { output: 'fixed-remote-result' });
    assert.equal(await fs.pathExists(logPath), false);
  } finally {
    await fs.remove(dir);
  }
});

test('executable provider lifecycle persists provider-defined Nodes and safe effect/retention details', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-executable-provider-lifecycle-'));
  const logPath = path.join(dir, 'requests.jsonl');
  const provider = executableProvider('normal', logPath, 2_000, 'lifecycle-executable');
  const base = { sourceSessionId: 'lifecycle-source', nodeId: 'dynamic:one', parameters: { opaque: { value: 1 } }, context: { agent: 'lifecycle-agent' } };
  try {
    const created = await provider.createNode(base);
    assert.equal(created.node?.id, 'dynamic:one');
    assert.match(created.effect || '', /created|registered/i);
    assert.match(created.dataRetention || '', /test state file/i);
    assert.equal((await provider.listNodes()).some(node => node.id === 'dynamic:one'), true);

    const ensured = await provider.ensureNode(base);
    assert.equal(ensured.node?.id, 'dynamic:one');
    const inspected = await provider.inspectNode({ ...base, nodeId: 'dynamic:one' });
    assert.equal(inspected.node?.id, 'dynamic:one');
    assert.equal((inspected.details as any).observed.sourceSessionId, 'lifecycle-source');
    assert.deepEqual((inspected.details as any).observed.context, { agent: 'lifecycle-agent' });

    const destroyed = await provider.destroyNode({ ...base, nodeId: 'dynamic:one' });
    assert.equal(destroyed.nodeId, 'dynamic:one');
    assert.match(destroyed.dataRetention || '', /no claim/i);
    const generated = await provider.createNode({
      sourceSessionId: 'lifecycle-source', parameters: { generated: true }, context: { agent: 'lifecycle-agent' },
    });
    assert.equal(generated.node?.id, 'fixture-created');
    assert.equal((await provider.listNodes()).some(node => node.id === 'dynamic:one'), false);

    const operations = (await readLog(logPath)).map(entry => entry.request.operation);
    assert.deepEqual(operations, ['create', 'list', 'ensure', 'inspect', 'destroy', 'create', 'list']);
  } finally {
    await fs.remove(dir);
  }
});

test('executable lifecycle rejects unsupported, malformed, oversized, and mismatched provider results', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-executable-provider-lifecycle-errors-'));
  const createRequest = { sourceSessionId: 'source', nodeId: 'node-a', parameters: {}, context: { agent: 'agent-a' } };
  try {
    const unsupported = executableProvider('unsupported-lifecycle', path.join(dir, 'unsupported.jsonl'), 2_000, 'unsupported-lifecycle');
    await assert.rejects(() => unsupported.createNode(createRequest), (error: any) => error?.code === 'NODE_LIFECYCLE_OPERATION_UNSUPPORTED');

    const malformed = executableProvider('lifecycle-malformed', path.join(dir, 'malformed.jsonl'), 2_000, 'malformed-lifecycle');
    await assert.rejects(() => malformed.createNode(createRequest), (error: any) => error?.code === 'NODE_PROVIDER_PROTOCOL_INVALID_RESPONSE');

    const oversized = executableProvider('lifecycle-oversized', path.join(dir, 'oversized.jsonl'), 2_000, 'oversized-lifecycle');
    await assert.rejects(() => oversized.createNode(createRequest), (error: any) => error?.code === 'NODE_PROVIDER_OUTPUT_LIMIT');

    const mismatch = executableProvider('lifecycle-node-mismatch', path.join(dir, 'mismatch.jsonl'), 2_000, 'mismatch-lifecycle');
    const registry = new NodeProviderRegistry([new MasterNodeProvider(), mismatch]);
    await assert.rejects(
      () => registry.createNode('mismatch-lifecycle', {
        sourceSessionId: 'source', nodeId: 'create-requested', parameters: {}, context: { agent: 'agent-a' },
      }),
      (error: any) => error?.code === 'NODE_LIFECYCLE_NODE_MISMATCH',
    );
    await assert.rejects(
      () => registry.ensureNode('mismatch-lifecycle', {
        sourceSessionId: 'source', nodeId: 'ensure-requested', parameters: {}, context: { agent: 'agent-a' },
      }),
      (error: any) => error?.code === 'NODE_LIFECYCLE_NODE_MISMATCH',
    );
    await assert.rejects(
      () => registry.inspectNode({ sourceSessionId: 'source', nodeId: 'fixture-sandbox', parameters: {}, context: { agent: 'agent-a' } }),
      (error: any) => error?.code === 'NODE_LIFECYCLE_NODE_MISMATCH',
    );
    await assert.rejects(
      () => registry.destroyNode({ sourceSessionId: 'source', nodeId: 'fixture-sandbox', parameters: {}, context: { agent: 'agent-a' } }),
      (error: any) => error?.code === 'NODE_LIFECYCLE_NODE_MISMATCH',
    );
  } finally {
    await fs.remove(dir);
  }
});

test('executable lifecycle timeout and cancellation reap the direct provider child', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-executable-provider-lifecycle-cleanup-'));
  const request = { sourceSessionId: 'source', nodeId: 'node-a', parameters: {}, context: { agent: 'agent-a' } };
  try {
    const timeoutLog = path.join(dir, 'timeout.jsonl');
    const timeoutProvider = executableProvider('hang', timeoutLog, 100, 'lifecycle-timeout');
    await assert.rejects(() => timeoutProvider.createNode(request), (error: any) => error?.code === 'NODE_PROVIDER_TIMEOUT');
    const timeoutEntries = await readLog(timeoutLog);
    assert.equal(timeoutEntries.length, 1);
    assert.equal(pidAlive(timeoutEntries[0].pid), false);

    const cancelLog = path.join(dir, 'cancel.jsonl');
    const cancelProvider = executableProvider('hang', cancelLog, 10_000, 'lifecycle-cancel');
    const controller = new AbortController();
    const pending = cancelProvider.ensureNode(request, { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(() => pending, (error: any) => error?.code === 'NODE_PROVIDER_CANCELLED');
    const cancelEntries = await readLog(cancelLog);
    assert.equal(cancelEntries.length, 1);
    assert.equal(pidAlive(cancelEntries[0].pid), false);
  } finally {
    await fs.remove(dir);
  }
});
