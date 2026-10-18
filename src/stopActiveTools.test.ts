import type { Message } from './types';
import { executeTools } from './toolExecutor';
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { shutdownToolScriptRuntime } from './toolscript';
after(() => shutdownToolScriptRuntime());
import { fork, type ChildProcess } from 'node:child_process';
import { createNodeExecutionServiceHandler, nodeExecutionServiceDescriptor } from './nodeExecutionService';
import { ExecutableNodeProvider } from './nodes/executableProvider';
import { NodeProviderRegistry } from './nodes/providerRegistry';
import path from 'node:path';
import os from 'node:os';
import fs from 'fs-extra';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import * as sessionManager from './sessionManager';
import * as mcpClient from './mcpClient';
import * as mcp from './mcpExternalService';
import { ProcessRpcClientTransport, ProcessRpcServer, RpcClient, RpcServiceRegistry } from './rpc';
import { SessionWorkerStore } from './sessionWorkerStore';
import { readSessionWorkerProcessIdentity } from './sessionWorkerProcessIdentity';
import { sessionWorkerControlServiceDescriptor } from './sessionWorkerControlService';
import { sessionWorkerRuntimeServiceDescriptor } from './sessionWorkerRuntimeService';
import { createSessionWorkerPublicationServiceHandler, sessionWorkerPublicationServiceDescriptor, SessionWorkerProjectionRegistry } from './sessionWorkerPublicationService';
import { createSessionTurnDeliveryServiceHandler, sessionTurnDeliveryServiceDescriptor } from './sessionTurnDelivery';
import { serializeSessionHistoryPayload } from './session/metadataStore';
import type { FunctionCall } from './types';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}

async function loopback() {
  const app = express();
  app.use(express.json());
  const connections = new Map<string, { transport: StreamableHTTPServerTransport; server: Server }>();
  const started = new Map<string, ReturnType<typeof gate>>();
  const releases = new Map<string, ReturnType<typeof gate>>();
  const calls: string[] = [];
  const cancelled: string[] = [];
  let initialized = 0;
  let deleted = 0;
  const start = (tag: string) => {
    let marker = started.get(tag);
    if (!marker) started.set(tag, marker = gate());
    return marker;
  };
  app.all('/mcp', async (req, res) => {
    const id = req.headers['mcp-session-id'];
    let connection = typeof id === 'string' ? connections.get(id) : undefined;
    if (!connection && req.method === 'POST' && req.body?.method === 'initialize') {
      initialized++;
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, enableJsonResponse: true,
        onsessioninitialized: sessionId => { connections.set(sessionId, connection!); },
      });
      const server = new Server({ name: 'stop-fixture', version: '1' }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'probe', inputSchema: { type: 'object' } }] }));
      server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
        const tag = String(request.params.arguments?.tag);
        calls.push(tag);
        if (tag.includes('slow') || tag.includes('independent')) {
          const release = gate();
          releases.set(tag, release);
          const onAbort = () => { cancelled.push(tag); release.resolve(); };
          if (extra.signal.aborted) onAbort();
          else extra.signal.addEventListener('abort', onAbort, { once: true });
          start(tag).resolve();
          await release.promise;
          extra.signal.removeEventListener('abort', onAbort);
        } else start(tag).resolve();
        return { content: [{ type: 'text', text: tag }] };
      });
      connection = { transport, server };
      await server.connect(transport);
    }
    if (!connection) { res.status(404).end(); return; }
    try { await connection.transport.handleRequest(req, res, req.body); }
    catch { if (!res.headersSent) res.status(500).end(); }
    if (req.method === 'DELETE' && typeof id === 'string') {
      deleted++;
      connections.delete(id);
      await connection.server.close();
    }
  });
  const http = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => http.once('listening', resolve));
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('Loopback TCP address missing.');
  return {
    url: `http://127.0.0.1:${address.port}/mcp`, calls, cancelled,
    started: (tag: string) => start(tag).promise,
    release: (tag: string) => releases.get(tag)?.resolve(),
    initialized: () => initialized,
    deleted: () => deleted,
    async close() {
      for (const release of releases.values()) release.resolve();
      await Promise.allSettled([...connections.values()].map(connection => connection.server.close()));
      http.closeAllConnections();
      await new Promise<void>(resolve => http.close(() => resolve()));
    },
  };
}

async function fixture(run: (root: string, remote: Awaited<ReturnType<typeof loopback>>) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-stop-mcp-'));
  const remote = await loopback();
  mcpClient.setMcpConfigStoreForTests(mcpClient.createMcpConfigStore(path.join(root, 'mcp.json')));
  try {
    await mcpClient.upsertServer('stop-fixture', { transport: 'streamable-http', url: remote.url });
    await run(root, remote);
  } finally {
    await mcp.shutdownMcpExternalService();
    mcp.resetMcpExternalServiceForTests();
    await mcpClient.resetMcpConnectionsForTests();
    mcpClient.setMcpConfigStoreForTests(null);
    await remote.close();
    await fs.remove(root);
  }
}

function mcpCall(tag: string): FunctionCall {
  return { id: tag, name: 'call_tool', args: { toolId: 'mcp:stop-fixture/probe', args: { tag } } };
}
function responses(result: Message) {
  return result.parts.filter((part: any) => part.functionResponse).map((part: any) => part.functionResponse);
}

test('Stop reaches a real HTTP MCP request, closes only its caller binding, skips effects and rebuilds without replay', { timeout: 15_000 }, async () => {
  await fixture(async (root, remote) => {
    const session = await sessionManager.getSession(`stop-local-${randomUUID()}`);
    const other = await sessionManager.getSession(`stop-other-${randomUUID()}`);
    const forbidden = path.join(root, 'must-not-write');
    try {
      await mcp.callMcpTool(other.id, 'stop-fixture', 'probe', { tag: 'other' });
      const running = executeTools([mcpCall('slow-local'), { id: 'write', name: 'write', args: { filePath: forbidden, content: 'never' } }],
        { sessionId: session.id, session }, session);
      await remote.started('slow-local');
      session.stopping = true;
      assert.equal(sessionManager.abortSessionInFlight(session.id), true);
      const result = responses((await running).message);
      assert.deepEqual(result.map((item: any) => item.tool_use_id), ['slow-local', 'write']);
      assert.match(result[0].response.error, /abort|cancel/i);
      assert.match(result[1].response.error, /not started/);
      assert.equal(await fs.pathExists(forbidden), false);
      assert.deepEqual(remote.cancelled, ['slow-local']);
      assert.equal(remote.deleted(), 1);
      assert.equal(sessionManager.abortSessionInFlight(session.id), false, 'settled batch releases its controller');
      await mcp.callMcpTool(other.id, 'stop-fixture', 'probe', { tag: 'other-again' });
      assert.equal(remote.initialized(), 2, 'the other caller remains on its original binding');
      session.stopping = false;
      const fresh = await executeTools([mcpCall('fresh')], { sessionId: session.id, session }, session);
      assert.equal(responses(fresh.message)[0].response.output, 'fresh');
      assert.equal(remote.initialized(), 3);
      assert.equal(remote.calls.filter(tag => tag === 'slow-local').length, 1, 'possibly executed tools are never replayed');
    } finally {
      session.stopping = false;
      await sessionManager.deleteSession(session.id);
      await sessionManager.deleteSession(other.id);
    }
  });
});

test('Stop cancels one request but preserves an independent in-flight request on the same caller/server binding', { timeout: 15_000 }, async () => {
  await fixture(async (_root, remote) => {
    const session = await sessionManager.getSession(`stop-shared-${randomUUID()}`);
    const independent = mcp.callMcpTool(session.id, 'stop-fixture', 'probe', { tag: 'independent' });
    try {
      await remote.started('independent');
      const running = executeTools([mcpCall('slow-shared')], { sessionId: session.id, session }, session);
      await remote.started('slow-shared');
      session.stopping = true;
      assert.equal(sessionManager.abortSessionInFlight(session.id), true);
      assert.match(responses((await running).message)[0].response.error, /abort|cancel/i);
      assert.equal(remote.deleted(), 0);
      assert.deepEqual(remote.cancelled, ['slow-shared']);
      remote.release('independent');
      assert.equal(await independent, 'independent');
      await mcp.callMcpTool(session.id, 'stop-fixture', 'probe', { tag: 'still-live' });
      assert.equal(remote.initialized(), 1);
    } finally {
      remote.release('independent');
      await independent.catch(() => {});
      session.stopping = false;
      await sessionManager.deleteSession(session.id);
    }
  });
});

test('foreground ToolScript cannot swallow Stop and start another host tool', { timeout: 15_000 }, async () => {
  await fixture(async (root, remote) => {
    const session = await sessionManager.getSession(`stop-script-${randomUUID()}`);
    const forbidden = path.join(root, 'must-not-write');
    try {
      const running = executeTools([{ id: 'slow-script', name: 'run_script', args: {
        code: 'try:\n    call_tool(source="mcp", server="stop-fixture", name="probe", args={"tag": "slow-script"})\nexcept Exception:\n    pass\ncall_tool("write", {"filePath": args["path"], "content": "never"})',
        args: { path: forbidden },
      } }], { sessionId: session.id, session }, session);
      await remote.started('slow-script');
      session.stopping = true;
      sessionManager.abortSessionInFlight(session.id);
      const stopped = responses((await running).message)[0].response;
      assert.equal(stopped.status, 'failed');
      assert.equal(await fs.pathExists(forbidden), false);
    } finally {
      session.stopping = false;
      await sessionManager.deleteSession(session.id);
    }
  });
});

test('Main Stop ends shared MCP setup waiting before dispatch without interrupting the independent initializer', { timeout: 10_000 }, async () => {
  await fixture(async (_root) => {
    const connecting = gate();
    const started = gate();
    let closes = 0;
    const dispatches: string[] = [];
    class Transport { async close() { closes++; } }
    class Client {
      async connect() { started.resolve(); await connecting.promise; }
      async close() { closes++; }
      async callTool(input: any) { dispatches.push(input.arguments.tag); return { content: [{ type: 'text', text: input.arguments.tag }] }; }
    }
    mcpClient.setMcpSdkForTests({ Client, StreamableHTTPClientTransport: Transport, SSEClientTransport: Transport, StdioClientTransport: Transport });
    const session = await sessionManager.getSession(`stop-shared-setup-${randomUUID()}`);
    const independent = mcp.callMcpTool(session.id, 'stop-fixture', 'probe', { tag: 'independent' });
    try {
      await started.promise;
      const admitted = gate();
      const foreground = executeTools([mcpCall('unstarted-setup')], { sessionId: session.id, session, onToolStart: async () => admitted.resolve() }, session);
      await admitted.promise;
      await new Promise(resolve => setImmediate(resolve));
      const before = Date.now();
      session.stopping = true;
      assert.equal(sessionManager.abortSessionInFlight(session.id), true);
      const fallback = setTimeout(() => connecting.resolve(), 1000);
      let result: any;
      try { result = responses((await foreground).message)[0]; }
      finally { clearTimeout(fallback); }
      assert(Date.now() - before < 200, 'Stop must not wait for a shared connection to finish setup');
      assert.match(result.response.error, /not.*executed|not started/i);
      assert.deepEqual(dispatches, []);
      assert.equal(closes, 0);
      connecting.resolve();
      assert.equal(await independent, 'independent');
      assert.deepEqual(dispatches, ['independent']);
    } finally {
      connecting.resolve();
      await independent.catch(() => {});
      session.stopping = false;
      await sessionManager.deleteSession(session.id);
    }
  });
});

async function withWorkerTools(root: string, session: any, calls: FunctionCall[], register: (registry: RpcServiceRegistry) => void,
  run: (runtime: RpcClient<typeof sessionWorkerRuntimeServiceDescriptor>, store: SessionWorkerStore, child: ChildProcess, statePath: string) => Promise<void>) {
    const workerRoot = path.join(root, 'worker');
    const statePath = path.join(workerRoot, 'state', 'sessions', `${session.id}.json`);
    await fs.outputJson(statePath, serializeSessionHistoryPayload(session));
    const storePath = path.join(workerRoot, 'state', 'workers.sqlite');
    const store = new SessionWorkerStore(storePath);
    store.open();
    const incarnationId = 'stop-test-incarnation';
    const ownership = store.beginGeneration(session.id, incarnationId);
    const child = fork(path.join(__dirname, 'sessionWorkerRuntimeTestChild.js'), [], {
      env: { ...process.env, FOXWARM_DATA_DIR: workerRoot,
        FOXWARM_SESSION_WORKER_SESSION_ID: session.id,
        FOXWARM_SESSION_WORKER_GENERATION: String(ownership.generation),
        FOXWARM_SESSION_WORKER_INCARNATION_ID: incarnationId,
        FOXWARM_SESSION_WORKER_STORE_PATH: storePath,
        FOXWARM_TEST_STOP_MCP_TOOLS: JSON.stringify(calls),
      }, serialization: 'advanced', stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let stderr = '';
    child.stderr?.on('data', chunk => { stderr += String(chunk); });
    const transport = new ProcessRpcClientTransport(child, { generation: ownership.generation });
    const registry = new RpcServiceRegistry();
    register(registry);
    const projections = new SessionWorkerProjectionRegistry();
    const identity = { sessionId: session.id, generation: ownership.generation, incarnationId };
    projections.establish(identity);
    registry.register(sessionWorkerPublicationServiceDescriptor, createSessionWorkerPublicationServiceHandler({ expected: identity, registry: projections }));
    registry.register(sessionTurnDeliveryServiceDescriptor, createSessionTurnDeliveryServiceHandler({ expectedSourceSessionId: session.id }));
    const reverse = new ProcessRpcServer(registry, { generation: ownership.generation, peer: child, direction: 'reverse', exitOnDisconnect: false });
    child.once('disconnect', () => reverse.close());
    child.once('exit', () => reverse.close());
    reverse.start();
    try {
      await transport.waitUntilReady();
      const processIdentity = readSessionWorkerProcessIdentity(child.pid!)!;
      store.registerCandidate(session.id, ownership.generation, incarnationId, child.pid!, processIdentity);
      store.activateCandidate(session.id, ownership.generation, incarnationId, child.pid!, processIdentity);
      const control = new RpcClient(sessionWorkerControlServiceDescriptor, transport);
      const runtime = new RpcClient(sessionWorkerRuntimeServiceDescriptor, transport);
      await control.call('activate', {});
      await run(runtime, store, child, statePath);
    } catch (error) {
      throw new Error(`${String(error)}\nWorker stderr: ${stderr}`);
    } finally {
      reverse.close();
      await transport.close();
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
        child.kill('SIGTERM');
        await exited;
      }
      store.close();
    }
}

test('exact Worker Stop cancels reverse MCP execution and commits paired receipts before returning', { timeout: 20_000 }, async () => {
  await fixture(async (root, remote) => {
    const session = await sessionManager.getSession(`stop-worker-${randomUUID()}`);
    const forbidden = path.join(root, 'worker-must-not-write');
    try {
      await withWorkerTools(root, session, [mcpCall('slow-worker'), { id: 'write', name: 'write', args: { filePath: forbidden, content: 'never' } }],
        registry => registry.register(mcp.mcpExternalServiceDescriptor, mcp.createMcpExternalServiceHandler({ expectedSourceSessionId: session.id })),
        async (runtime, store, _child, statePath) => {
      store.enqueueIntent(session.id, 'stop-test-input', 'enqueue', { type: 'user', parts: [{ text: 'Run the deterministic tool fixture.' }] });
      const running = runtime.call('runPending', { limit: 8 });
      await remote.started('slow-worker');
      const stop = await runtime.call('interrupt', {}, { timeoutMs: 10_000 });
      assert.equal(stop.stopping, true);
      assert.equal(stop.abortedInFlight, true);
      await running;
      const state = await fs.readJson(statePath);
      const model = state.history.find((message: any) => message.parts.some((part: any) => part.functionCall));
      const tools = state.history.find((message: any) => message.role === 'tool');
      assert.deepEqual(model.parts.map((part: any) => part.functionCall.id), ['slow-worker', 'write']);
      assert.deepEqual(responses(tools).map((item: any) => item.tool_use_id), ['slow-worker', 'write']);
      assert.match(responses(tools)[0].response.error, /abort|cancel/i);
      assert.equal(await fs.pathExists(forbidden), false);
      assert.equal(state.busy, false);
      assert.equal(state.stopping, false);
      assert.deepEqual(remote.cancelled, ['slow-worker']);
        });
    } finally { await sessionManager.deleteSession(session.id); }
  });
});

for (const stopFirst of [false, true]) {
  test(`exact Worker exit cleans its one-shot executable provider${stopFirst ? ' after a prior Stop' : ''}`, { timeout: 15_000 }, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-worker-provider-close-'));
    const logPath = path.join(root, 'provider.jsonl');
    const session = await sessionManager.getSession(`provider-worker-${randomUUID()}`);
    session.currentNode = 'fixture-sandbox';
    const provider = new ExecutableNodeProvider({ id: 'close-fixture', type: 'executable', command: process.execPath,
      args: [path.join(__dirname, 'nodes/executableProviderTestFixture.js'), 'delayed-filesystem', logPath], timeoutMs: 5000 });
    const providers = new NodeProviderRegistry([provider]);
    const settled = gate();
    const stopped = gate();
    let context: any;
    try {
      await withWorkerTools(root, session, [{ id: 'provider-read', name: 'read', args: { filePath: 'fixture' } }], registry => {
        const handler = createNodeExecutionServiceHandler({ expectedSourceSessionId: session.id, providerRegistry: providers });
        registry.register(nodeExecutionServiceDescriptor, { ...handler, async execute(input, ctx) {
          context = ctx;
          ctx.signal.addEventListener('abort', () => stopped.resolve(), { once: true });
          try { return await handler.execute(input, ctx); }
          finally { settled.resolve(); }
        } });
      }, async (runtime, store, child) => {
        store.enqueueIntent(session.id, 'provider-input', 'enqueue', { type: 'user', parts: [{ text: 'Run the deterministic provider fixture.' }] });
        const running = runtime.call('runPending', { limit: 8 });
        void running.catch(() => {});
        const readyBy = Date.now() + 5000;
        while (!await fs.pathExists(`${logPath}.ready`)) {
          if (Date.now() > readyBy) throw new Error('Provider filesystem fixture did not become ready.');
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        const providerPid = Number(await fs.readFile(`${logPath}.ready`, 'utf8'));
        if (stopFirst) {
          const stop = runtime.call('interrupt', {}, { timeoutMs: 5000 });
          void stop.catch(() => {});
          await stopped.promise;
          assert.equal(context.signal.aborted, true);
          assert.equal(context.hardCancellationSignal.aborted, false, 'user Stop must not kill a one-shot provider');
          assert.doesNotThrow(() => process.kill(providerPid, 0), 'the actual provider remains alive before owner loss');
        }
        const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
        child.kill('SIGTERM');
        await exited;
        await settled.promise;
        assert.equal(context.hardCancellationSignal.aborted, true, 'owner loss remains observable after the ordinary signal already aborted');
        assert.equal(context.hardCancellationSignal.reason.code, 'RPC_CLOSED');
        assert.throws(() => process.kill(providerPid, 0), { code: 'ESRCH' }, 'owner loss cleans up its actual one-shot provider process');
        await new Promise(resolve => setTimeout(resolve, 1600));
        assert.equal(await fs.pathExists(`${logPath}.effect`), false, 'the owned provider process cannot cause a later effect after Worker exit');
        await running.catch(() => {});
      });
    } finally {
      await sessionManager.deleteSession(session.id);
      await fs.remove(root);
    }
  });
}
