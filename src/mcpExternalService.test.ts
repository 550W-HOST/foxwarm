import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

import * as mcpClient from './mcpClient';
import * as sessionManager from './sessionManager';
import {
  callMcpTool,
  configureMcpServer,
  createMcpExternalServiceHandler,
  listMcpServers,
  listMcpTools,
  mcpExternalServiceDescriptor,
  resetMcpExternalServiceForTests,
  shutdownMcpExternalService,
} from './mcpExternalService';
import { LocalRpcTransport, RpcClient, RpcError, RpcServiceRegistry } from './rpc';
import * as isolatedCheck from './isolatedCheck';

function makeId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function cleanup(...sessionIds: string[]): Promise<void> {
  await shutdownMcpExternalService().catch(() => {});
  resetMcpExternalServiceForTests();
  mcpClient.setMcpConfigStoreForTests(null);
  for (const sessionId of sessionIds) await sessionManager.deleteSession(sessionId).catch(() => false);
}

async function withTempStore(run: (store: ReturnType<typeof mcpClient.createMcpConfigStore>) => Promise<void>): Promise<void> {
  const dirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-mcp-service-'));
  const store = mcpClient.createMcpConfigStore(path.join(dirPath, 'mcp.json'));
  mcpClient.setMcpConfigStoreForTests(store);
  try {
    await run(store);
  } finally {
    await fs.remove(dirPath).catch(() => {});
  }
}

test('bound reverse MCP handler rejects wrong source before lookup or client effect', async () => {
  const registry = new RpcServiceRegistry();
  registry.register(mcpExternalServiceDescriptor, createMcpExternalServiceHandler({ expectedSourceSessionId: 'owned' }));
  const transport = new LocalRpcTransport(registry);
  const originalLookup = sessionManager.getExistingSession;
  let lookups = 0;
  (sessionManager as any).getExistingSession = async (): Promise<null> => { lookups += 1; return null; };
  try {
    await assert.rejects(() => new RpcClient(mcpExternalServiceDescriptor, transport).call('listServers', { sourceSessionId: 'wrong' }),
      { code: 'MCP_EXTERNAL_SOURCE_MISMATCH' });
    assert.equal(lookups, 0);
  } finally { (sessionManager as any).getExistingSession = originalLookup; await transport.drain(); transport.close(); }
});

test('MCP external service clones secret-bearing config and returns only redacted summaries', async () => {
  const sourceId = makeId('mcp_service_config');
  await sessionManager.getSession(sourceId);
  await withTempStore(async () => {
    await assert.rejects(
      () => configureMcpServer({ sourceSessionId: sourceId, name: 'invalid', action: 'upsert', config: { command: 'node', args: [7] } as any }),
      (error: any) => error?.code === 'MCP_EXTERNAL_INVALID_REQUEST',
    );
    const sparseConfigArgs: string[] = [];
    sparseConfigArgs.length = 1;
    await assert.rejects(
      () => configureMcpServer({ sourceSessionId: sourceId, name: 'sparse', action: 'upsert', config: { command: 'node', transport: 'stdio', args: sparseConfigArgs } }),
      (error: any) => error?.code === 'MCP_EXTERNAL_INVALID_REQUEST',
    );
    assert.deepEqual(await listMcpServers(sourceId), []);
    const sensitiveValue = ['test', 'credential', Date.now()].join('-');
    const config = {
      command: 'node',
      transport: 'stdio' as const,
      args: ['server.js', sensitiveValue],
      env: { API_KEY: sensitiveValue },
      headers: { Authorization: sensitiveValue },
      token: sensitiveValue,
    };
    await configureMcpServer({ sourceSessionId: sourceId, name: 'private', action: 'upsert', config });
    config.env.API_KEY = 'caller-mutated';

    const summaries = await listMcpServers(sourceId);
    assert.deepEqual(summaries, [{
      name: 'private', enabled: true, transport: 'stdio', command: 'node', argsCount: 2,
      envKeys: ['API_KEY'], headerKeys: ['Authorization'], hasToken: true,
    }]);
    assert.equal(JSON.stringify(summaries).includes(sensitiveValue), false);
    assert.equal((await mcpClient.getServers()).private.env?.API_KEY, sensitiveValue);

    const originalCallTool = mcpClient.callTool;
    (mcpClient as any).callTool = async () => { throw new Error(`connection rejected ${sensitiveValue}`); };
    try {
      await assert.rejects(
        () => callMcpTool(sourceId, 'explicitly-missing', 'probe', {}),
        (error: any) => error?.message === 'MCP operation failed because the underlying error contained configured secret data.',
      );

      await configureMcpServer({ sourceSessionId: sourceId, name: 'short', action: 'upsert', config: { url: 'https://example.invalid/short', env: { KEY: 'x' } } });
      (mcpClient as any).callTool = async () => { throw new Error('external x failure'); };
      await assert.rejects(
        () => callMcpTool(sourceId, 'short', 'probe', {}),
        (error: any) => error?.message === 'MCP operation failed because the underlying error contained configured secret data.',
      );

      (mcpClient as any).callTool = async () => { throw new RpcError('MCP_RETRY', `retry ${sensitiveValue}`, true, { unsafe: sensitiveValue }); };
      await assert.rejects(
        () => callMcpTool(sourceId, 'private', 'probe', {}),
        (error: any) => error?.code === 'MCP_RETRY'
          && error?.retryable === true
          && error?.details === undefined
          && error?.message === 'MCP operation failed because the underlying error contained configured secret data.',
      );
    } finally {
      (mcpClient as any).callTool = originalCallTool;
    }
  });
  await cleanup(sourceId);
});

test('failed MCP service config persistence leaves the previous live snapshot published', async () => {
  const sourceId = makeId('mcp_service_persist');
  await sessionManager.getSession(sourceId);
  await withTempStore(async store => {
    await configureMcpServer({ sourceSessionId: sourceId, name: 'alpha', action: 'upsert', config: { url: 'https://example.invalid/alpha' } });
    await configureMcpServer({ sourceSessionId: sourceId, name: 'alpha', action: 'upsert', config: { description: 'merged update' } });
    for (const config of [
      { transport: 'stdio' },
      { transport: 'auto' },
      { transport: 'unsupported' },
    ]) {
      await assert.rejects(
        () => configureMcpServer({ sourceSessionId: sourceId, name: 'invalid', action: 'upsert', config: config as any }),
        /requires command|requires url|unsupported MCP transport/i,
      );
    }
    assert.deepEqual((await listMcpServers(sourceId)).map(server => [server.name, server.description]), [['alpha', 'merged update']]);
    const originalWrite = store.write.bind(store);
    (store as any).write = async () => { throw new Error('simulated MCP persistence failure'); };
    await assert.rejects(
      () => configureMcpServer({ sourceSessionId: sourceId, name: 'beta', action: 'upsert', config: { url: 'https://example.invalid/beta' } }),
      /simulated MCP persistence failure/,
    );
    assert.deepEqual((await listMcpServers(sourceId)).map(server => server.name), ['alpha']);
    (store as any).write = originalWrite;
  });
  await cleanup(sourceId);
});

test('MCP service list/call clone image results and structured handler errors', async () => {
  const sourceId = makeId('mcp_service_clone');
  await sessionManager.getSession(sourceId);
  const originalListTools = mcpClient.listTools;
  const originalCallTool = mcpClient.callTool;
  const sharedList = { tools: [{ name: 'image_tool', inputSchema: { type: 'object' } }] };
  const sharedResult = { inlineDataItems: [{ mimeType: 'image/png', data: 'fixture-image' }], meta: { value: 1 } };
  (mcpClient as any).listTools = async () => sharedList;
  (mcpClient as any).callTool = async () => sharedResult;
  try {
    const listed: any = await listMcpTools(sourceId, 'demo');
    listed.tools[0].name = 'mutated';
    assert.equal(sharedList.tools[0].name, 'image_tool');

    const sparseNested: unknown[] = [];
    sparseNested.length = 1;
    await assert.rejects(
      () => callMcpTool(sourceId, 'demo', 'image_tool', { nested: sparseNested }),
      (error: any) => error?.code === 'MCP_EXTERNAL_INVALID_REQUEST',
    );
    const extraKeyArray: any[] = [1];
    (extraKeyArray as any).extra = true;
    await assert.rejects(
      () => callMcpTool(sourceId, 'demo', 'image_tool', { nested: extraKeyArray }),
      (error: any) => error?.code === 'MCP_EXTERNAL_INVALID_REQUEST',
    );

    const result: any = await callMcpTool(sourceId, 'demo', 'image_tool', { nested: [1, { values: ['dense'] }] });
    result.meta.value = 9;
    assert.equal(sharedResult.meta.value, 1);

    (mcpClient as any).callTool = async () => { throw new Error('MCP handler failed'); };
    await assert.rejects(
      () => callMcpTool(sourceId, 'demo', 'image_tool', {}),
      (error: any) => error?.code === 'RPC_HANDLER_ERROR' && error?.message === 'MCP handler failed',
    );
  } finally {
    (mcpClient as any).listTools = originalListTools;
    (mcpClient as any).callTool = originalCallTool;
    await cleanup(sourceId);
  }
});

test('MCP external service rejects stale and isolated source sessions', async () => {
  const sourceId = makeId('mcp_service_isolated');
  const agentName = makeId('mcp_service_agent');
  const source = await sessionManager.getSession(sourceId);
  source.agent = agentName;
  await sessionManager.saveSession(sourceId);
  try {
    await assert.rejects(
      () => listMcpServers(makeId('missing')),
      (error: any) => error?.code === 'MCP_EXTERNAL_SOURCE_NOT_FOUND',
    );
    await sessionManager.setAgentMetadata(agentName, { isolated: true, isolatedNode: 'test-node' });
    await assert.rejects(() => listMcpServers(sourceId), /restricted to agent-level allowed tools/i);
    await assert.rejects(() => listMcpTools(sourceId), /unavailable to isolated sessions/i);
    await assert.rejects(() => callMcpTool(sourceId, 'demo', 'probe', {}), /unavailable to isolated sessions/i);
  } finally {
    await sessionManager.setAgentMetadata(agentName, { isolated: false }).catch(() => {});
    await cleanup(sourceId);
  }
});

test('MCP service rejects non-record DTOs, extra tag fields, and non-JSON args', async () => {
  const sourceId = makeId('mcp_service_exact_dto');
  await sessionManager.getSession(sourceId);
  const handler: any = createMcpExternalServiceHandler();
  try {
    for (const invoke of [
      () => handler.listServers({ sourceSessionId: sourceId, extra: true }, {}),
      () => handler.listTools({ sourceSessionId: sourceId, server: 'demo', extra: true }, {}),
      () => handler.callTool({ sourceSessionId: sourceId, server: 'demo', name: 'probe', args: {}, extra: true }, {}),
      () => handler.configure({ sourceSessionId: sourceId, name: 'demo', action: 'set-enabled', enabled: true, config: {} }, {}),
      () => handler.configure({ sourceSessionId: sourceId, name: 'demo', action: 'upsert', config: { url: 'https://example.invalid' }, enabled: true }, {}),
      () => handler.callTool({ sourceSessionId: sourceId, name: 'probe', args: new Date() }, {}),
      () => handler.callTool({ sourceSessionId: sourceId, name: 'probe', args: new Map() }, {}),
    ]) {
      await assert.rejects(invoke, (error: any) => error?.code === 'MCP_EXTERNAL_INVALID_REQUEST');
    }
  } finally {
    await cleanup(sourceId);
  }
});

test('MCP call authorization receives the complete nested args object', async () => {
  const sourceId = makeId('mcp_service_permission_args');
  await sessionManager.getSession(sourceId);
  const originalPermission = isolatedCheck.checkToolPermission;
  const originalCallTool = mcpClient.callTool;
  const captured: any[] = [];
  (isolatedCheck as any).checkToolPermission = async (...args: any[]) => { captured.push(structuredClone(args)); };
  (mcpClient as any).callTool = async () => ({ ok: true });
  try {
    await callMcpTool(sourceId, 'demo', 'probe', { nested: { value: 7 }, items: [1, 2] });
    assert.deepEqual(captured, [[
      'call_tool', sourceId, 'master',
      { source: 'mcp', server: 'demo', name: 'probe', args: { nested: { value: 7 }, items: [1, 2] } },
    ]]);
  } finally {
    (isolatedCheck as any).checkToolPermission = originalPermission;
    (mcpClient as any).callTool = originalCallTool;
    await cleanup(sourceId);
  }
});

test('MCP external service drains accepted calls and terminally fences later calls', async () => {
  const sourceId = makeId('mcp_service_drain');
  await sessionManager.getSession(sourceId);
  const originalListServers = mcpClient.listServers;
  let markStarted!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  (mcpClient as any).listServers = async (): Promise<mcpClient.McpServerSummary[]> => {
    markStarted();
    await blocked;
    return [];
  };
  try {
    const accepted = listMcpServers(sourceId);
    await started;
    const shutdown = shutdownMcpExternalService();
    await assert.rejects(
      () => listMcpServers(sourceId),
      (error: any) => error?.code === 'MCP_EXTERNAL_SHUTDOWN',
    );
    release();
    assert.deepEqual(await accepted, []);
    await shutdown;
    await assert.rejects(
      () => listMcpServers(sourceId),
      (error: any) => error?.code === 'MCP_EXTERNAL_SHUTDOWN',
    );
    resetMcpExternalServiceForTests();
  } finally {
    (mcpClient as any).listServers = originalListServers;
    await cleanup(sourceId);
  }
});
