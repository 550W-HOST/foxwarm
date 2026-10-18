import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import * as sessionManager from '../sessionManager';
import { createNodeExecutionServiceHandler, nodeExecutionServiceDescriptor } from '../nodeExecutionService';
import * as nodeExecution from '../nodeExecution';
import * as sessionRuntime from '../sessionRuntime';
import { LocalRpcTransport, RpcServiceRegistry } from '../rpc';
import { callTool } from '../tools';
import { executeTools } from '../toolExecutor';
import { SESSIONS_DIR } from '../config';
import { createExecRuntime } from '../execManager';
import { ExecutableNodeProvider } from './executableProvider';
import { NodeProviderRegistry, type NodeToolRequest } from './providerRegistry';

function fixture(root: string, mode = 'normal', timeoutMs = 1000, delivered: string[] = []) {
  const provider = new ExecutableNodeProvider({ id: 'process-provider', type: 'executable', command: process.execPath,
    args: [path.join(__dirname, 'primitiveExecTestFixture.js'), root, mode], timeoutMs });
  const runtime = createExecRuntime({ getDefaultCwd: () => root, getExecTempDir: () => root,
    registryPath: path.join(root, 'running-exec.json'),
    resolveBackend: (providerId, nodeId) => registry.execBackend(providerId, nodeId),
    completionDispatcher: async (entry, status, message) => { delivered.push(`${entry.sessionId}:${status.exitCode}:${message}`); },
  });
  const registry = new NodeProviderRegistry([provider], { getExecRuntime: () => runtime });
  return { runtime, registry, provider };
}

const request = (command: string, extra: Record<string, unknown> = {}): NodeToolRequest => ({
  sourceSessionId: 'fixture-owner', nodeId: 'process-fixture', toolName: 'exec', args: { command, ...extra },
  context: { agent: 'fixture-agent', currentNode: 'process-fixture', cwd: 'fixture://cwd', programmatic: true },
});
const calls = async (root: string): Promise<any[]> => (await fs.readFile(path.join(root, 'requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));

async function temporary(run: (root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fw-provider-exec-'));
  try { await run(root); } finally { await fs.remove(root); }
}

test('second-process provider uses canonical results, raw bytes, nonzero exits, and target cwd without actor payloads', async () => temporary(async root => {
  const { registry, runtime } = fixture(root);
  try {
    const result: any = await registry.invokeTool(request("printf '  héllo\\n'; exit 7"));
    assert.equal(result.status, 'completed');
    assert.equal(result.exitCode, 7);
    assert.equal(result.content, '  héllo\n');
    assert.match(result.output, /Exit code: 7/);
    const recorded = await calls(root);
    const started = recorded.find(call => call.operation === 'exec-start');
    assert.deepEqual(started.request, { nodeId: 'process-fixture', command: "printf '  héllo\\n'; exit 7", cwd: 'fixture://cwd' });
    const queried = recorded.find(call => call.operation === 'exec-poll');
    assert.deepEqual(Object.keys(queried.request).sort(), ['nodeId', 'ref']);
    assert.equal(JSON.stringify(result).includes(queried.request.ref), false, 'opaque references never become model-visible result fields or log locators');
    assert.equal((await runtime.listRunningExecs()).length, 0);
  } finally { await runtime.shutdown(); }
}));

test('Stop during a provider start awaits its receipt and releases waiting without killing or replaying the command', async () => temporary(async root => {
  const delivered: string[] = [];
  const { registry, runtime } = fixture(root, 'slow-start', 2000, delivered);
  const controller = new AbortController();
  try {
    const pending = registry.invokeTool(request("sleep 1; printf 'survived'"), { signal: controller.signal, foregroundToolCancellation: true });
    setTimeout(() => controller.abort(), 100);
    const result: any = await pending;
    assert.equal(result.status, 'running');
    assert.match(result.output, /not killed/);
    assert.equal(result.output.includes('PID:'), false, 'unknown PIDs are omitted, not invented');
    const status = await runtime.waitForExecCompletion(result.execId, 5000);
    assert.equal(status?.exitCode, 0);
    await runtime.reconcileNow();
    assert.equal(delivered.length, 1);
    assert.match(delivered[0], /^fixture-owner:0:/);
    assert.equal((await calls(root)).filter(call => call.operation === 'exec-start').length, 1);
  } finally { await runtime.shutdown(); }
}));

test('provider background tracking reattaches to the same persisted handle and notifies its original owner after manager restart', async () => temporary(async root => {
  let first = fixture(root);
  let entry;
  try {
    await first.runtime.initialize();
    entry = await first.runtime.startPersistentExec({ command: 'sleep 0.8; printf done', backend: { providerId: first.provider.id }, nodeId: 'process-fixture', sessionId: 'original-owner', agentName: 'fixture-agent' });
    assert.equal(await first.runtime.waitForExecCompletion(entry.id, 30), null);
    await first.runtime.markExecForBackgroundNotification(entry.id);
  } finally { await first.runtime.shutdown(); }
  const delivered: string[] = [];
  const second = fixture(root, 'normal', 1000, delivered);
  try {
    await second.runtime.initialize();
    assert.equal(second.runtime.listRunningExecs()[0].backend?.ref, entry!.backend?.ref);
    assert.equal((await second.runtime.waitForExecCompletion(entry!.id, 5000))?.exitCode, 0);
    await second.runtime.reconcileNow();
    assert.equal(delivered.length, 1);
    assert.match(delivered[0], /^original-owner:0:/);
    assert.equal((await calls(root)).filter(call => call.operation === 'exec-start').length, 1);
    assert.deepEqual(second.runtime.listRunningExecs(), []);
  } finally { await second.runtime.shutdown(); }
}));

test('lost execution is unknown rather than success; unavailable output is separate from real exit status', async () => {
  for (const mode of ['lost', 'unreadable-log', 'short-log']) await temporary(async root => {
    const { registry, runtime } = fixture(root, mode);
    try {
      const result: any = await registry.invokeTool(request('printf exact; exit 3'));
      assert.equal(result.exitCode, mode === 'lost' ? null : 3);
      if (mode === 'lost') assert.match(result.output, /Execution lost/);
      else { assert.match(result.output, /output unavailable/); assert.equal(result.content, undefined); assert.equal(result.truncated, true); }
    } finally { await runtime.shutdown(); }
  });
});

test('uncertain start is never replayed and a transient poll failure retains the execution', async () => {
  await temporary(async root => {
    const { registry, runtime } = fixture(root, 'drop-start');
    try {
      await assert.rejects(() => registry.invokeTool(request('printf once')), /outcome is unknown.*Do not automatically repeat/);
      assert.equal((await calls(root)).filter(call => call.operation === 'exec-start').length, 1);
      assert.deepEqual(runtime.listRunningExecs(), []);
    } finally { await runtime.shutdown(); }
  });
  await temporary(async root => {
    const { registry, runtime } = fixture(root, 'fail-poll');
    try {
      const result: any = await registry.invokeTool(request('sleep 0.3; printf once'));
      assert.equal(result.exitCode, 0);
      assert.equal(result.content, 'once');
      assert.equal((await calls(root)).filter(call => call.operation === 'exec-start').length, 1);
    } finally { await runtime.shutdown(); }
  });
});

test('slow provider queries share one in-flight request, do not block Stop, and do not block other completion delivery', async () => temporary(async root => {
  const delivered: string[] = [];
  const { runtime } = fixture(root, 'hang-poll', 2000, delivered);
  const controller = new AbortController();
  try {
    await runtime.initialize();
    const entry = await runtime.startPersistentExec({ command: 'sleep 0.5', backend: { providerId: 'process-provider' }, nodeId: 'process-fixture', sessionId: 'owner', agentName: 'agent' });
    const started = Date.now();
    const first = runtime.waitForExecCompletion(entry.id, 5000, controller.signal);
    const second = runtime.waitForExecCompletion(entry.id, 80);
    setTimeout(() => controller.abort(), 100);
    assert.equal(await first, null);
    assert.equal(await second, null);
    assert.ok(Date.now() - started < 400);
    assert.equal((await calls(root)).filter(call => call.operation === 'exec-poll').length, 1);
    await runtime.markExecForBackgroundNotification(entry.id);
    const native = await runtime.startPersistentExec({ command: 'true', sessionId: 'native-owner', agentName: 'agent' });
    await runtime.waitForExecCompletion(native.id, 5000);
    await runtime.markExecForBackgroundNotification(native.id);
    const reconciliation = runtime.reconcileNow();
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.ok(delivered.some(message => message.startsWith('native-owner:0:')), 'completion is delivered without waiting for the slow query');
    await reconciliation;
    assert.ok(runtime.listRunningExecs().some(item => item.id === entry.id), 'query timeout is not process exit');
    assert.ok(!runtime.listRunningExecs().some(item => item.id === native.id), 'other entries progress independently');
  } finally { await runtime.shutdown(); }
}));

test('large provider logs use bounded samples and preserve the full same-Node log path without copying to Main', async () => temporary(async root => {
  const { registry, runtime } = fixture(root);
  try {
    const result: any = await registry.invokeTool(request("head -c 1100000 /dev/zero | tr '\\0' x"));
    assert.equal(result.exitCode, 0);
    assert.equal(result.truncated, true);
    assert.equal(result.content, undefined);
    assert.equal(result.sizeBytes, 1100000);
    assert.match(result.logPath, /^fixture:\/\//);
    const reads = (await calls(root)).filter(call => call.operation === 'filesystem' && call.request.operation === 'read');
    assert.equal(reads.length, 2);
    assert.ok(reads.every(call => call.request.count <= 5000));
    assert.ok(result.output.length < 30000);
  } finally { await runtime.shutdown(); }
}));


test('exact Node and raw-call permission fences deny provider execution before any start effect', async () => temporary(async root => {
  const { registry, runtime } = fixture(root);
  const sourceId = `provider-permission-${Date.now()}`;
  const agent = `provider-permission-agent-${Date.now()}`;
  const session = await sessionManager.getSession(sourceId);
  session.agent = agent;
  session.currentNode = 'process-fixture';
  await sessionManager.saveSession(sourceId);
  await sessionManager.setAgentMetadata(agent, { isolated: true, isolatedNode: 'process-fixture', toolRules: [{ effect: 'deny', source: 'node', node: 'process-fixture', tool: 'exec' }] });
  const handler = createNodeExecutionServiceHandler({ expectedSourceSessionId: sourceId, providerRegistry: registry });
  const context: any = { signal: new AbortController().signal };
  try {
    const input = { sourceSessionId: sourceId, nodeId: 'process-fixture', toolName: 'exec', args: { command: 'touch must-not-exist' } };
    await assert.rejects(async () => handler.execute(input, context), /tool rule denies/i);
    await assert.rejects(async () => handler.execute({ ...input, sourceSessionId: 'wrong-owner' }, context), (error: any) => error.code === 'NODE_EXECUTION_SOURCE_MISMATCH');
    await assert.rejects(() => registry.invokeTool({ ...request('touch must-not-exist'), nodeId: 'wrong-node' }), /not available/);
    const recorded = await calls(root);
    assert.equal(recorded.some(call => call.operation === 'exec-start'), false);
    assert.equal(await fs.pathExists(path.join(root, 'cwd', 'must-not-exist')), false);
  } finally {
    await runtime.shutdown();
    await sessionManager.deleteSession(sourceId).catch(() => false);
  }
}));

test('a removed provider cannot silently hand a persisted execution to native or another provider', async () => temporary(async root => {
  const first = fixture(root);
  await first.runtime.initialize();
  const entry = await first.runtime.startPersistentExec({ backend: { providerId: 'process-provider' }, nodeId: 'process-fixture', command: 'printf retained', sessionId: 'original-owner', agentName: 'main' });
  await first.runtime.markExecForBackgroundNotification(entry.id);
  await first.runtime.shutdown();
  const second = createExecRuntime({ getDefaultCwd: () => root, getExecTempDir: () => root, registryPath: path.join(root, 'running-exec.json'),
    resolveBackend: () => { throw new Error('Provider configuration removed.'); } });
  try {
    await second.initialize();
    await second.reconcileNow();
    assert.equal(second.listRunningExecs()[0].backend?.ref, entry.backend?.ref);
    assert.equal((await calls(root)).filter(call => call.operation === 'exec-start').length, 1);
  } finally { await second.shutdown(); }
}));

test('owner loss can bound a dispatched start without replaying or killing the detached command', async () => temporary(async root => {
  const { registry, runtime } = fixture(root, 'slow-start', 2000);
  const owner = new AbortController();
  try {
    const pending = registry.invokeTool(request('sleep 0.3; printf detached'), {
      signal: new AbortController().signal, hardCancellationSignal: owner.signal, foregroundToolCancellation: true,
    });
    // A missing transport receipt is deliberately not interpreted as no effect.
    const dispatched = Date.now() + 2000;
    while (!await fs.pathExists(path.join(root, 'start-ready'))) {
      if (Date.now() > dispatched) throw new Error('Start fixture did not receive its request.');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    owner.abort();
    await assert.rejects(() => pending, /outcome is unknown/);
    await new Promise(resolve => setTimeout(resolve, 400));
    const directories = (await fs.readdir(root, { withFileTypes: true })).filter(item => item.isDirectory() && item.name !== 'cwd');
    assert.equal(directories.length, 1);
    assert.equal(await fs.readFile(path.join(root, directories[0].name, 'output'), 'utf8'), 'detached');
    assert.equal((await calls(root)).filter(call => call.operation === 'exec-start').length, 1);
  } finally { await runtime.shutdown(); }
}));


test('registered exec polls its exact backend after provider destroy makes the Node unavailable, preserving lost status and retained logs', async () => temporary(async root => {
  const delivered: string[] = [];
  const { registry, runtime } = fixture(root, 'offline-after-destroy', 2000, delivered);
  try {
    const result: any = await registry.invokeTool(request('printf before; sleep 2; printf after', { timeout: 1 }));
    assert.equal(result.status, 'running');
    const entry = runtime.listRunningExecs().find(candidate => candidate.id === result.execId)!;
    const destroyed = await registry.destroyNode({ sourceSessionId: 'fixture-owner', nodeId: 'process-fixture', parameters: {}, context: { agent: 'fixture-agent' } });
    assert.equal(destroyed.nodeId, 'process-fixture');
    assert.equal((await registry.resolveNode('process-fixture'))?.descriptor.availability, 'offline');
    const status = await runtime.waitForExecCompletion(entry.id, 3000);
    assert.equal(status?.exitCode, null);
    assert.match(status?.error || '', /Execution lost/);
    await runtime.reconcileNow();
    assert.equal(delivered.length, 1);
    assert.match(delivered[0], /^fixture-owner:null:/);
    assert.match(delivered[0], /Execution lost/);
    assert.deepEqual(runtime.listRunningExecs(), []);
    const bytes: any = await registry.execBackend('process-provider', 'process-fixture').files.read(entry.logPath, 0, 100);
    assert.equal(bytes.toString(), 'before');
    const recorded = await calls(root);
    const destruction = recorded.findIndex(call => call.operation === 'destroy');
    assert.ok(recorded.slice(destruction + 1).some(call => call.operation === 'exec-poll'), 'poll is dispatched after availability changes, not rejected by a ready-node lookup');
    assert.equal(recorded.filter(call => call.operation === 'exec-start').length, 1);
  } finally { await runtime.shutdown(); }
}));


test('normal Main callTool and batch cwd replay preserve exact provider paths without changing native settings normalization', async () => temporary(async root => {
  const { registry, runtime } = fixture(root);
  const sessionId = `provider-main-cwd-${Date.now()}`;
  const session = await sessionManager.getSession(sessionId);
  session.currentNode = 'process-fixture';
  session.cwd = root;
  await sessionManager.saveSession(sessionId);
  const exact = path.join(root, 'destination ');
  await fs.ensureDir(exact);
  await fs.ensureDir(path.join(root, 'destination'));
  const services = new RpcServiceRegistry();
  services.register(nodeExecutionServiceDescriptor, createNodeExecutionServiceHandler({ providerRegistry: registry }));
  await nodeExecution.initializeNodeExecution({ transport: new LocalRpcTransport(services) });
  const ctx: any = { sessionId, session, programmatic: true };
  try {
    await callTool('exec', { command: `cd ${JSON.stringify(exact)}` }, ctx);
    assert.equal(session.cwd, exact);
    assert.equal((await fs.readJson(path.join(SESSIONS_DIR, `${sessionId}.json`))).cwd, exact);
    assert.equal((await callTool('exec', { command: 'pwd' }, ctx)).content, `${exact}\n`);
    await sessionRuntime.updateSettings(sessionId, { cwd: `${root}  ` });
    assert.equal(session.cwd, root, 'ordinary/native settings still normalize their input');
    await executeTools([{ id: 'provider-main-cd', name: 'exec', args: { command: `cd ${JSON.stringify(exact)}` } }], { sessionId, programmatic: true }, session);
    assert.equal(session.cwd, exact, 'normal Main batch replay does not use the native string normalizer');
    assert.equal((await fs.readJson(path.join(SESSIONS_DIR, `${sessionId}.json`))).cwd, exact);
    assert.equal((await callTool('exec', { command: 'pwd' }, ctx)).content, `${exact}\n`);
  } finally {
    await nodeExecution.shutdownNodeExecution();
    nodeExecution.resetNodeExecutionForTests();
    await sessionRuntime.shutdownSessionRuntime();
    await runtime.shutdown();
    await sessionManager.deleteSession(sessionId).catch(() => false);
  }
}));
