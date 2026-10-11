import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { shutdownToolScriptRuntime } from './toolscript';
after(() => shutdownToolScriptRuntime());
import { fork } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'fs-extra';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { executeTools } from './llm';
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
function responses(result: any) {
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
      const result = responses(await running);
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
      assert.equal(responses(fresh)[0].response.output, 'fresh');
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
      assert.match(responses(await running)[0].response.error, /abort|cancel/i);
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
      const stopped = responses(await running)[0].response;
      assert.equal(stopped.status, 'failed');
      assert.equal(await fs.pathExists(forbidden), false);
    } finally {
      session.stopping = false;
      await sessionManager.deleteSession(session.id);
    }
  });
});

test('exact Worker Stop cancels reverse MCP execution and commits paired receipts before returning', { timeout: 20_000 }, async () => {
  await fixture(async (root, remote) => {
    const session = await sessionManager.getSession(`stop-worker-${randomUUID()}`);
    const workerRoot = path.join(root, 'worker');
    const statePath = path.join(workerRoot, 'state', 'sessions', `${session.id}.json`);
    await fs.outputJson(statePath, serializeSessionHistoryPayload(session));
    const storePath = path.join(workerRoot, 'state', 'workers.sqlite');
    const store = new SessionWorkerStore(storePath);
    store.open();
    const incarnationId = 'stop-test-incarnation';
    const ownership = store.beginGeneration(session.id, incarnationId);
    const forbidden = path.join(root, 'worker-must-not-write');
    const child = fork(path.join(__dirname, 'sessionWorkerRuntimeTestChild.js'), [], {
      env: { ...process.env, FOXWARM_DATA_DIR: workerRoot,
        FOXWARM_SESSION_WORKER_SESSION_ID: session.id,
        FOXWARM_SESSION_WORKER_GENERATION: String(ownership.generation),
        FOXWARM_SESSION_WORKER_INCARNATION_ID: incarnationId,
        FOXWARM_SESSION_WORKER_STORE_PATH: storePath,
        FOXWARM_TEST_STOP_MCP_TOOLS: JSON.stringify([mcpCall('slow-worker'), { id: 'write', name: 'write', args: { filePath: forbidden, content: 'never' } }]),
      }, serialization: 'advanced', stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let stderr = '';
    child.stderr?.on('data', chunk => { stderr += String(chunk); });
    const transport = new ProcessRpcClientTransport(child, { generation: ownership.generation });
    const registry = new RpcServiceRegistry();
    registry.register(mcp.mcpExternalServiceDescriptor, mcp.createMcpExternalServiceHandler({ expectedSourceSessionId: session.id }));
    const projections = new SessionWorkerProjectionRegistry();
    const identity = { sessionId: session.id, generation: ownership.generation, incarnationId };
    projections.establish(identity);
    registry.register(sessionWorkerPublicationServiceDescriptor, createSessionWorkerPublicationServiceHandler({ expected: identity, registry: projections }));
    registry.register(sessionTurnDeliveryServiceDescriptor, createSessionTurnDeliveryServiceHandler({ expectedSourceSessionId: session.id }));
    const reverse = new ProcessRpcServer(registry, { generation: ownership.generation, peer: child, direction: 'reverse', exitOnDisconnect: false });
    reverse.start();
    try {
      await transport.waitUntilReady();
      const processIdentity = readSessionWorkerProcessIdentity(child.pid!)!;
      store.registerCandidate(session.id, ownership.generation, incarnationId, child.pid!, processIdentity);
      store.activateCandidate(session.id, ownership.generation, incarnationId, child.pid!, processIdentity);
      const control = new RpcClient(sessionWorkerControlServiceDescriptor, transport);
      const runtime = new RpcClient(sessionWorkerRuntimeServiceDescriptor, transport);
      await control.call('activate', {});
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
      await sessionManager.deleteSession(session.id);
    }
  });
});
