import test from 'node:test';
import assert from 'node:assert/strict';
import * as mcpClient from '../mcpClient';
import { nodesManager } from '../nodes/manager';
import * as sessionManager from '../sessionManager';
import { executeTools } from '../llm';
import * as nodeExecution from '../nodeExecution';
import { NODE_ENVIRONMENT_BUILTIN_NAMES } from './placement';
import * as tools from '../tools';
import {
  call_tool,
  definitions,
  mcp_config,
  modelFacingDefinitions,
  search_tools,
} from '../tools';

test('search_tools returns structured builtin results with hidden/direct exposure metadata', async () => {
  const mainSession = await sessionManager.getSession('main');
  const result: any = await search_tools({
    query: 'archived messages',
    sources: ['builtin'],
    includeSchema: true,
    limit: 20,
  });

  assert.equal(typeof result.count, 'number');
  assert.ok(Array.isArray(result.tools));

  const archivedMessages = result.tools.find((tool: any) => tool.name === 'get_archived_messages');
  assert.ok(archivedMessages);
  assert.equal(archivedMessages.source, 'builtin');
  assert.equal(archivedMessages.toolId, 'builtin:get_archived_messages');
  assert.equal(archivedMessages.directExposed, false);
  assert.equal(archivedMessages.hidden, true);
  assert.deepEqual(
    archivedMessages.inputSchema,
    definitions.find(def => def.name === 'get_archived_messages')?.parameters,
  );

  const builtinReadResult: any = await search_tools({
    query: 'read',
    sources: ['builtin'],
    includeSchema: false,
    limit: 20,
  });
  assert.equal(builtinReadResult.tools.some((tool: any) => tool.name === 'read'), false);

  mainSession.currentNode = 'master';
  const readResult: any = await search_tools({ query: 'read', sources: ['node'], includeSchema: false }, {
    sessionId: 'main', session: mainSession,
  });
  const readTool = readResult.tools.find((tool: any) => tool.name === 'read');
  assert.ok(readTool);
  assert.equal(readTool.source, 'node');
  assert.equal(readTool.nodeId, 'master');
  assert.equal(readTool.toolId, 'node:master/read');
  assert.equal(Object.prototype.hasOwnProperty.call(readTool, 'inputSchema'), false);
});

test('timer tools are hidden by default but remain reachable through unified search/call', async () => {
  for (const name of ['create_timer', 'list_timers', 'update_timer', 'delete_timer']) {
    const definition = definitions.find(def => def.name === name);
    assert.ok(definition, `${name} should exist`);
    assert.equal(definition?.defaultInject, undefined, `${name} should not be injected by default`);
    assert.equal(modelFacingDefinitions.some(def => def.name === name), false, `${name} should be hidden from model-facing tools`);
  }

  assert.equal(definitions.some(def => def.name === 'list_timer'), false);

  const result: any = await search_tools({
    query: 'timer',
    sources: ['builtin'],
    includeSchema: false,
    limit: 50,
  });

  for (const name of ['create_timer', 'list_timers', 'update_timer', 'delete_timer']) {
    const found = result.tools.find((tool: any) => tool.name === name);
    assert.ok(found, `${name} should be discoverable`);
    assert.equal(found.hidden, true);
    assert.equal(found.directExposed, false);
  }
});

test('unified wait calls reject a one-session waitAllSessions barrier', async () => {
  const sessionId = `unified_wait_barrier_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const session = await sessionManager.getSession(sessionId);
  try {
    await assert.rejects(
      () => call_tool({
        toolId: 'builtin:wait',
        args: { waitAllSessions: ['only-child'] },
      }, { sessionId, session }),
      /at least two distinct session IDs.*ordinary wait.*single-session follow-ups/i,
    );
    assert.equal(session.meta.wait, undefined);
  } finally {
    await sessionManager.deleteSession(sessionId).catch(() => false);
  }
});

test('search_tools multi-word queries rank tools matching more words higher', async () => {
  const result: any = await search_tools({
    query: 'session context',
    sources: ['builtin'],
    includeSchema: false,
    limit: 200,
  });

  assert.ok(result.tools.length >= 2);
  const archiveIndex = result.tools.findIndex((tool: any) => tool.name === 'recall');
  const sessionIndex = result.tools.findIndex((tool: any) => tool.name === 'get_session_messages');
  assert.ok(archiveIndex >= 0, 'recall should match both words');
  assert.ok(sessionIndex >= 0, 'get_session_messages should still match one word');
  assert.ok(archiveIndex < sessionIndex, 'tool matching more query words should rank higher');
});

test('search_tools includeSchema=true keeps full schema only for the first 10 results', async () => {
  const result: any = await search_tools({
    sources: ['builtin'],
    includeSchema: true,
    limit: 15,
  });

  assert.equal(result.tools.length, 15);

  for (const tool of result.tools.slice(0, 10)) {
    assert.equal(Object.prototype.hasOwnProperty.call(tool, 'inputSchema'), true);
  }

  for (const tool of result.tools.slice(10)) {
    assert.equal(Object.prototype.hasOwnProperty.call(tool, 'inputSchema'), false);
    assert.equal(typeof tool.toolId, 'string');
    assert.equal(typeof tool.source, 'string');
    assert.equal(typeof tool.name, 'string');
  }
});

test('search_tools includeSchema=false removes schema from all results', async () => {
  const result: any = await search_tools({
    sources: ['builtin'],
    includeSchema: false,
    limit: 15,
  });

  assert.equal(result.tools.length, 15);
  for (const tool of result.tools) {
    assert.equal(Object.prototype.hasOwnProperty.call(tool, 'inputSchema'), false);
  }
});

test('call_tool rejects node capabilities as builtin and accepts them through node source', async () => {
  await assert.rejects(() => call_tool(
    {
      toolId: 'builtin:browse_list',
      args: {},
    },
    {
      sessionId: 'main',
      session: { agent: 'main', currentNode: 'master' },
    } as any,
  ), /node capability, not a builtin/i);

  const result = await call_tool({ source: 'node', name: 'browse_list', args: {} }, {
    sessionId: 'main', session: { agent: 'main', currentNode: 'master' },
  } as any);

  assert.match(String(result), /no tabs open/i);
});

test('direct and unified builtin dispatch keep session-owner tools local under a remote currentNode', async () => {
  const sessionId = `placement_parity_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const session = await sessionManager.getSession(sessionId);
  session.currentNode = 'unreachable-placement-test-node';
  await sessionManager.saveSession(sessionId);

  try {
    const direct = await executeTools([{
      id: 'placement-direct',
      name: 'set_session_compact_threshold',
      args: { thresholdTokens: 1234 },
    }], { sessionId, session }, session);
    assert.equal(direct.parts[0].functionResponse?.response.error, undefined);
    assert.equal((await sessionManager.getSession(sessionId)).compactThresholdTokens, 1234);

    const unified: any = await call_tool({
      toolId: 'builtin:set_session_compact_threshold',
      args: { thresholdTokens: 2345 },
    }, { sessionId, session });
    assert.equal(unified.error, undefined);
    assert.equal((await sessionManager.getSession(sessionId)).compactThresholdTokens, 2345);
  } finally {
    await sessionManager.deleteSession(sessionId).catch(() => false);
  }
});

test('call_tool rejects missing args wrapper with a caller-level error', async () => {
  await assert.rejects(
    () => call_tool(
      {
        toolId: 'builtin:create_agent',
      },
      {
        sessionId: 'main',
        session: { agent: 'main', currentNode: 'master' },
      } as any,
    ),
    /call_tool args requires args .* argsJson/i,
  );
});

test('call_tool schema exposes argsJson fallback', () => {
  const def = definitions.find((item) => item.name === 'call_tool');
  assert.ok(def);
  assert.equal(def?.parameters?.properties?.args?.type, 'object');
  assert.equal(def?.parameters?.properties?.argsJson?.type, 'string');
  assert.notEqual(def?.parameters?.required?.includes('args'), true);
});

test('call_tool parses argsJson fallback for target tool arguments', async () => {
  await sessionManager.getSession('main');
  const result: any = await call_tool(
    {
      toolId: 'builtin:search_tools',
      argsJson: JSON.stringify({ query: 'read', sources: ['builtin'], limit: 1, includeSchema: false }),
    },
    { sessionId: 'main', session: sessionManager.getSessionCatalog('main') } as any,
  );

  assert.equal(result.count, 1);
  assert.equal(result.tools[0].source, 'builtin');
});

test('call_tool rejects invalid argsJson with a clear error', async () => {
  await assert.rejects(
    () => call_tool(
      {
        toolId: 'builtin:search_tools',
        argsJson: '{not json}',
      },
      {} as any,
    ),
    /argsJson must be a JSON object string/i,
  );
});

test('mcp_config schema exposes envJson and headersJson fallbacks', () => {
  const def = definitions.find((item) => item.name === 'mcp_config');
  assert.ok(def);
  assert.equal(def?.parameters?.properties?.env?.type, 'object');
  assert.equal(def?.parameters?.properties?.envJson?.type, 'string');
  assert.equal(def?.parameters?.properties?.headers?.type, 'object');
  assert.equal(def?.parameters?.properties?.headersJson?.type, 'string');
  assert.equal(def?.parameters?.properties?.timeoutSeconds?.minimum, 0);
  assert.equal(def?.parameters?.properties?.timeoutSeconds?.maximum, 3600);
});

test('agent isolation management schemas expose only exact source-specific tool rules', () => {
  for (const name of ['create_agent', 'set_agent_isolated']) {
    const definition: any = definitions.find(item => item.name === name);
    const ruleSchema = definition?.parameters?.properties?.toolRules;
    assert.equal(ruleSchema?.type, 'array');
    assert.equal(ruleSchema?.maxItems, 256);
    assert.equal(ruleSchema?.items?.oneOf?.length, 3);
    assert.deepEqual(ruleSchema.items.oneOf.map((item: any) => item.required), [
      ['effect', 'source', 'tool'],
      ['effect', 'source', 'node', 'tool'],
      ['effect', 'source', 'server', 'tool'],
    ]);
    assert.equal(ruleSchema.items.oneOf.every((item: any) => item.additionalProperties === false), true);
    assert.equal(ruleSchema.items.oneOf.every((item: any) => item.properties.tool.maxLength === 128), true);
    assert.equal(ruleSchema.items.oneOf[1].properties.node.maxLength, 128);
    assert.equal(ruleSchema.items.oneOf[2].properties.server.maxLength, 128);
  }
});

test('mcp_config parses envJson and headersJson string-map fallbacks', async () => {
  await sessionManager.getSession('main');
  const originalUpsertServer = mcpClient.upsertServer;
  const captured: any[] = [];
  (mcpClient as any).upsertServer = async (name: string, config: any) => {
    captured.push({ name, config });
  };

  try {
    const result = await mcp_config({
      name: 'json-fallback-test',
      command: 'node',
      transport: 'stdio',
      envJson: JSON.stringify({ API_KEY: 'secret' }),
      headersJson: JSON.stringify({ 'X-Test': 'ok' }),
      timeoutSeconds: 240,
    }, { sessionId: 'main' });

    assert.match(String(result), /json-fallback-test/);
    assert.equal(captured.length, 1);
    assert.deepEqual(captured[0].config.env, { API_KEY: 'secret' });
    assert.deepEqual(captured[0].config.headers, { 'X-Test': 'ok' });
    assert.equal(captured[0].config.timeoutSeconds, 240);
    assert.match(String(result), /240 second/);
    assert.equal(Object.prototype.hasOwnProperty.call(captured[0].config, 'url'), false);
    const cleared = await mcp_config({ name: 'json-fallback-test', timeoutSeconds: 0 }, { sessionId: 'main' });
    assert.equal(captured[1].config.timeoutSeconds, 0);
    assert.match(String(cleared), /reset to the MCP SDK default/i);
  } finally {
    (mcpClient as any).upsertServer = originalUpsertServer;
  }
});

test('mcp_config rejects non-string values from envJson', async () => {
  await assert.rejects(
    () => mcp_config({
      name: 'bad-json-fallback-test',
      command: 'node',
      transport: 'stdio',
      envJson: JSON.stringify({ PORT: 3000 }),
    }),
    /envJson must be a JSON object string with string values/i,
  );
});

test('mcp_config can disable an existing server without repeating its connection config', async () => {
  await sessionManager.getSession('main');
  const originalSetServerEnabled = mcpClient.setServerEnabled;
  const captured: Array<{ name: string; enable: boolean }> = [];
  (mcpClient as any).setServerEnabled = async (name: string, enable: boolean) => {
    captured.push({ name, enable });
  };

  try {
    const result = await mcp_config({ name: 'existing-server', enable: false }, { sessionId: 'main' });
    assert.equal(String(result), 'MCP server "existing-server" disabled.');
    assert.deepEqual(captured, [{ name: 'existing-server', enable: false }]);
  } finally {
    (mcpClient as any).setServerEnabled = originalSetServerEnabled;
  }
});

test('search_tools and call_tool cover MCP tools with schema-preserving structured results', async () => {
  const originalListServers = mcpClient.listServers;
  const originalListTools = mcpClient.listTools;
  const originalCallTool = mcpClient.callTool;

  try {
    (mcpClient as any).listServers = async () => ([
      {
        name: 'github',
        enabled: true,
        transport: 'stdio',
        argsCount: 0,
        envKeys: [] as string[],
        headerKeys: [] as string[],
        hasToken: false,
        timeoutSeconds: null as number | null,
      },
    ]);
    (mcpClient as any).listTools = async (server?: string) => ({
      tools: [
        {
          name: 'search_repos',
          description: `Search repositories on ${server || 'default'}`,
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string' },
            },
            required: ['query'],
          },
          annotations: { title: 'Search repos' },
        },
      ],
    });
    (mcpClient as any).callTool = async (server: string | undefined, tool: string, args?: Record<string, any>) => ({
      ok: true,
      server,
      tool,
      args,
    });

    const searchResult: any = await search_tools({
      sources: ['mcp'],
      server: 'github',
      includeSchema: true,
    }, {
      sessionId: 'main',
      session: { agent: 'main' },
    } as any);

    assert.equal(searchResult.count, 1);
    assert.equal(searchResult.tools[0].source, 'mcp');
    assert.equal(searchResult.tools[0].server, 'github');
    assert.equal(searchResult.tools[0].toolId, 'mcp:github/search_repos');
    assert.deepEqual(searchResult.tools[0].inputSchema, {
      type: 'object',
      properties: {
        query: { type: 'string' },
      },
      required: ['query'],
    });

    const callResult = await call_tool({
      toolId: 'mcp:github/search_repos',
      args: { query: 'foxwarm' },
    }, {
      sessionId: 'main',
      session: { agent: 'main' },
    } as any);

    assert.deepEqual(callResult, {
      ok: true,
      server: 'github',
      tool: 'search_repos',
      args: { query: 'foxwarm' },
    });
  } finally {
    (mcpClient as any).listServers = originalListServers;
    (mcpClient as any).listTools = originalListTools;
    (mcpClient as any).callTool = originalCallTool;
  }
});

test('search_tools keeps MCP results from healthy servers when another MCP server fails', async () => {
  const originalListServers = mcpClient.listServers;
  const originalListTools = mcpClient.listTools;

  try {
    (mcpClient as any).listServers = async () => ([
      { name: 'healthy', enabled: true, transport: 'stdio', argsCount: 0, envKeys: [] as string[], headerKeys: [] as string[], hasToken: false, timeoutSeconds: null as number | null },
      { name: 'broken', enabled: true, transport: 'stdio', argsCount: 0, envKeys: [] as string[], headerKeys: [] as string[], hasToken: false, timeoutSeconds: null as number | null },
    ]);
    (mcpClient as any).listTools = async (server?: string) => {
      if (server === 'broken') {
        throw new Error('missing token');
      }
      return {
        tools: [
          {
            name: 'healthy_tool',
            description: 'A tool from a healthy MCP server',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      };
    };

    const result: any = await search_tools({ sources: ['mcp'], includeSchema: false }, {
      sessionId: 'main',
      session: { agent: 'main' },
    } as any);

    assert.equal(result.count, 1);
    assert.equal(result.tools[0].server, 'healthy');
    assert.equal(result.tools[0].name, 'healthy_tool');
    assert.ok(result.warnings?.some((warning: string) => /broken/.test(warning) && /missing token/.test(warning)));
  } finally {
    (mcpClient as any).listServers = originalListServers;
    (mcpClient as any).listTools = originalListTools;
  }
});

test('call_tool requires an MCP server when not using an MCP toolId', async () => {
  await assert.rejects(
    () => call_tool({ source: 'mcp', name: 'search_repos', args: {} }, {
      sessionId: 'main',
      session: { agent: 'main' },
    } as any),
    /require.*server/i,
  );
});

test('call_tool passes parsed MCP JSON text results through as structured values', async () => {
  const originalCallTool = mcpClient.callTool;

  try {
    (mcpClient as any).callTool = async () => mcpClient.normalizeMcpToolResult({
      content: [{ type: 'text', text: '{"ok":true,"items":[{"name":"foxwarm"}]}' }],
    });

    const callResult = await call_tool({
      toolId: 'mcp:github/search_repos',
      args: { query: 'foxwarm' },
    }, {
      sessionId: 'main',
      session: { agent: 'main' },
    } as any);

    assert.deepEqual(callResult, {
      ok: true,
      items: [{ name: 'foxwarm' }],
    });
  } finally {
    (mcpClient as any).callTool = originalCallTool;
  }
});

test('search_tools and call_tool cover remote node tools', async () => {
  const originalListNodesWithTools = nodesManager.listNodesWithTools;
  const originalExecuteTool = nodesManager.executeTool;
  const originalGetCurrentNode = nodesManager.getCurrentNode;
  const originalGetNode = nodesManager.getNode;

  try {
    await sessionManager.getSession('main');
    (nodesManager as any).listNodesWithTools = () => ([
      {
        id: 'android-node',
        type: 'android',
        tools: [
          {
            name: 'android_screenshot',
            description: 'Take an Android screenshot',
            parameters: {
              type: 'object',
              properties: {
                inline: { type: 'boolean' },
              },
            },
          },
        ],
      },
      {
        id: 'other-node',
        type: 'android',
        tools: [
          {
            name: 'android_input_text',
            description: 'Type text on another node',
            parameters: {
              type: 'object',
              properties: {
                text: { type: 'string' },
              },
            },
          },
        ],
      },
    ]);
    (nodesManager as any).getNode = (nodeId: string) => nodeId === 'android-node'
      ? { id: nodeId, ws: {}, tools: new Set(['android_screenshot']) }
      : undefined;
    (nodesManager as any).executeTool = async (nodeId: string, tool: string, args: Record<string, any>, sessionId: string) => ({
      ok: true,
      nodeId,
      tool,
      args,
      sessionId,
    });
    (nodesManager as any).getCurrentNode = async () => 'android-node';

    const searchResult: any = await search_tools({
      sources: ['node'],
      nodeId: 'android-node',
      includeSchema: true,
    }, { sessionId: 'main', session: sessionManager.getSessionCatalog('main') } as any);

    assert.equal(searchResult.count, 1);
    assert.equal(searchResult.tools[0].source, 'node');
    assert.equal(searchResult.tools[0].nodeId, 'android-node');
    assert.equal(searchResult.tools[0].toolId, 'node:android-node/android_screenshot');
    assert.deepEqual(searchResult.tools[0].inputSchema, {
      type: 'object',
      properties: {
        inline: { type: 'boolean' },
      },
    });

    const callResult = await call_tool({
      source: 'node',
      nodeId: 'android-node',
      name: 'android_screenshot',
      args: { inline: true },
    }, {
      sessionId: 'main',
      session: { agent: 'main' },
    } as any);

    assert.deepEqual(callResult, {
      ok: true,
      nodeId: 'android-node',
      tool: 'android_screenshot',
      args: { inline: true },
      sessionId: 'main',
    });

    const defaultNodeSearchResult: any = await search_tools({
      sources: ['node'],
      includeSchema: false,
    }, {
      sessionId: 'main',
      session: { agent: 'main', currentNode: 'android-node' },
    } as any);

    assert.equal(defaultNodeSearchResult.count, 1);
    assert.equal(defaultNodeSearchResult.tools[0].nodeId, 'android-node');
    assert.equal(defaultNodeSearchResult.tools.some((tool: any) => tool.nodeId === 'other-node'), false);
  } finally {
    (nodesManager as any).listNodesWithTools = originalListNodesWithTools;
    (nodesManager as any).executeTool = originalExecuteTool;
    (nodesManager as any).getCurrentNode = originalGetCurrentNode;
    (nodesManager as any).getNode = originalGetNode;
  }
});

test('master Node discovery and dynamic calls expose only canonical node-environment builtins and bypass RPC', async () => {
  const sourceId = `master_node_source_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const isolatedId = `master_node_isolated_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const isolatedAgent = `master_node_agent_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const source = await sessionManager.getSession(sourceId);
  source.currentNode = 'master';
  await sessionManager.saveSession(sourceId);
  const isolated = await sessionManager.getSession(isolatedId);
  isolated.agent = isolatedAgent;
  isolated.currentNode = 'bound-remote';
  await sessionManager.saveSession(isolatedId);
  const originalRemoteExecute = (nodeExecution as any).executeNodeTool;
  let remoteCalls = 0;

  try {
    (nodeExecution as any).executeNodeTool = async () => {
      remoteCalls += 1;
      throw new Error('master calls must not enter node execution RPC');
    };
    const discovered: any = await search_tools({
      sources: ['node'],
      nodeId: 'master',
      includeSchema: true,
      limit: 200,
    }, { sessionId: sourceId, session: source });
    assert.deepEqual(
      [...discovered.tools.map((tool: any) => tool.name)].sort(),
      [...NODE_ENVIRONMENT_BUILTIN_NAMES].sort(),
    );
    assert.equal(discovered.tools.every((tool: any) => tool.toolId === `node:master/${tool.name}`), true);

    const byId: any = await call_tool({
      toolId: 'node:master/read',
      args: { filePath: `${process.cwd()}/package.json`, startLine: 1, endLine: 1 },
    }, { sessionId: sourceId, session: source });
    const explicit: any = await call_tool({
      source: 'node',
      nodeId: 'master',
      name: 'read',
      args: { filePath: `${process.cwd()}/package.json`, startLine: 1, endLine: 1 },
    }, { sessionId: sourceId, session: source });
    assert.equal(byId.error, undefined);
    assert.equal(explicit.error, undefined);
    assert.equal(remoteCalls, 0);

    await assert.rejects(
      () => call_tool({ source: 'node', nodeId: 'master', name: 'list_agents', args: {} }, { sessionId: sourceId, session: source }),
      /not available on node `master`/,
    );

    await sessionManager.setAgentMetadata(isolatedAgent, { isolated: true, isolatedNode: 'bound-remote' });
    await assert.rejects(
      () => call_tool({ source: 'node', nodeId: 'master', name: 'read', args: { filePath: '/tmp/outside-isolated-agent' } }, { sessionId: isolatedId, session: isolated }),
      /restricted to agent-level allowed tools|cannot use (?:node capability `)?read|can only access/i,
    );

    const forwarded: any[] = [];
    (nodeExecution as any).executeNodeTool = async (...args: any[]) => {
      remoteCalls += 1;
      forwarded.push(args);
      return { remote: true, toolName: args[2] };
    };
    source.currentNode = 'remote-a';
    await sessionManager.saveSession(sourceId);
    assert.deepEqual(
      await call_tool({ source: 'node', name: 'read', args: { filePath: 'remote.txt' } }, { sessionId: sourceId, session: source }),
      { remote: true, toolName: 'read' },
    );
    assert.deepEqual(
      await call_tool({ source: 'node', nodeId: 'remote-a', name: 'dynamic_probe', args: {} }, { sessionId: sourceId, session: source }),
      { remote: true, toolName: 'dynamic_probe' },
    );
    assert.equal(remoteCalls, 2);
    assert.deepEqual(forwarded.map(call => [call[0], call[1], call[2]]), [
      [sourceId, 'remote-a', 'read'],
      [sourceId, 'remote-a', 'dynamic_probe'],
    ]);
  } finally {
    (nodeExecution as any).executeNodeTool = originalRemoteExecute;
    await sessionManager.setAgentMetadata(isolatedAgent, { isolated: false }).catch(() => {});
    await sessionManager.deleteSession(sourceId).catch(() => false);
    await sessionManager.deleteSession(isolatedId).catch(() => false);
  }
});

test('isolated exact rules align Main-local discovery, direct, unified, ToolScript, Node, and MCP calls', async () => {
  const sourceId = `rules_main_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const agentName = `rules_agent_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const session = await sessionManager.getSession(sourceId);
  session.agent = agentName;
  session.currentNode = 'bound-node';
  await sessionManager.saveSession(sourceId);
  await sessionManager.setAgentMetadata(agentName, {
    isolated: true,
    isolatedNode: 'bound-node',
    toolRules: [
      { effect: 'allow', source: 'builtin', tool: 'run_script' },
      { effect: 'allow', source: 'builtin', tool: 'list_agents' },
      { effect: 'deny', source: 'builtin', tool: 'skill' },
      { effect: 'deny', source: 'node', node: 'bound-node', tool: 'exec' },
      { effect: 'allow', source: 'node', node: 'master', tool: 'read' },
      { effect: 'allow', source: 'mcp', server: 'demo', tool: 'probe' },
    ],
  });
  const originals = {
    listNodesWithTools: nodesManager.listNodesWithTools,
    getNode: nodesManager.getNode,
    executeTool: nodesManager.executeTool,
    listTools: mcpClient.listTools,
    callTool: mcpClient.callTool,
  };
  try {
    (nodesManager as any).listNodesWithTools = () => [{
      id: 'bound-node', type: 'test', tools: [
        { name: 'read', description: 'read', parameters: { type: 'object' } },
        { name: 'exec', description: 'exec', parameters: { type: 'object' } },
        { name: 'custom_probe', description: 'custom', parameters: { type: 'object' } },
      ],
    }, {
      id: 'master', type: 'master', tools: [
        { name: 'read', description: 'master read', parameters: { type: 'object' } },
        { name: 'exec', description: 'master exec', parameters: { type: 'object' } },
      ],
    }];
    (nodesManager as any).getNode = () => ({ id: 'bound-node', ws: {}, tools: new Set(['read', 'exec', 'custom_probe']) });
    (nodesManager as any).executeTool = async (_node: string, tool: string) => ({ tool });
    (mcpClient as any).listTools = async () => ({ tools: [
      { name: 'probe', description: 'allowed MCP' },
      { name: 'other', description: 'hidden MCP' },
    ] });
    (mcpClient as any).callTool = async (_server: string, tool: string) => ({ tool });

    const found: any = await search_tools({ sources: ['builtin', 'node', 'mcp'], limit: 200 }, { sessionId: sourceId, session });
    const ids = new Set(found.tools.map((tool: any) => tool.toolId));
    assert.equal(ids.has('builtin:run_script'), true);
    assert.equal(ids.has('builtin:skill'), false);
    assert.equal(ids.has('builtin:list_agents'), false);
    assert.equal(ids.has('node:bound-node/read'), true);
    assert.equal(ids.has('node:bound-node/exec'), false);
    assert.equal(ids.has('node:bound-node/custom_probe'), true);
    assert.equal(ids.has('mcp:demo/probe'), true);
    assert.equal(ids.has('mcp:demo/other'), false);
    const masterFound: any = await search_tools({ sources: ['node'], nodeId: 'master', limit: 20 }, { sessionId: sourceId, session });
    assert.equal(masterFound.tools.some((tool: any) => tool.toolId === 'node:master/read'), true);
    assert.equal(masterFound.tools.some((tool: any) => tool.toolId === 'node:master/exec'), false);

    await assert.rejects(() => tools.callTool('exec', { command: 'true' }, { sessionId: sourceId, session }), /tool rule denies/i);
    await assert.rejects(() => call_tool({ source: 'node', name: 'exec', args: { command: 'true' } }, { sessionId: sourceId, session }), /tool rule denies/i);
    const nested = await tools.run_script({ code: 'def main(args):\n    return call_tool("exec", {"command": "true"})' }, { sessionId: sourceId, session });
    assert.equal(nested.status, 'failed');
    assert.match(String(nested.error), /tool rule denies/i);
    assert.deepEqual(await call_tool({ source: 'mcp', server: 'demo', name: 'probe', args: {} }, { sessionId: sourceId, session }), { tool: 'probe' });
    await assert.rejects(() => call_tool({ source: 'mcp', server: 'demo', name: 'other', args: {} }, { sessionId: sourceId, session }), /cannot use mcp capability/i);
    await assert.rejects(() => call_tool({ source: 'builtin', name: 'list_agents', args: {} }, { sessionId: sourceId, session }), /structurally restricted/i);
    await assert.rejects(() => call_tool({ source: 'node', nodeId: 'master', name: 'read', args: { filePath: '/tmp/outside-agent.txt' } }, { sessionId: sourceId, session }), /can only access/i);
  } finally {
    (nodesManager as any).listNodesWithTools = originals.listNodesWithTools;
    (nodesManager as any).getNode = originals.getNode;
    (nodesManager as any).executeTool = originals.executeTool;
    (mcpClient as any).listTools = originals.listTools;
    (mcpClient as any).callTool = originals.callTool;
    await sessionManager.setAgentMetadata(agentName, { isolated: false }).catch(() => {});
    await sessionManager.deleteSession(sourceId).catch(() => false);
  }
});

test('call_tool is a permission-neutral dispatcher and only its concrete target is authorized', async () => {
  const sourceId = `dispatcher_call_tool_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const agentName = `dispatcher_call_tool_agent_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const session = await sessionManager.getSession(sourceId);
  session.agent = agentName;
  session.currentNode = 'remote-a';
  const ctx: any = { sessionId: sourceId, session };
  const originalExecute = nodeExecution.executeNodeTool;
  let effects = 0;
  const descriptor = { source: 'node', name: 'custom_probe', args: {} };
  try {
    (nodeExecution as any).executeNodeTool = async () => { effects += 1; return { output: 'allowed' }; };

    const found: any = await search_tools({ query: 'call tool', sources: ['builtin'], limit: 200 }, ctx);
    assert.equal(found.tools.some((tool: any) => tool.toolId === 'builtin:call_tool'), false);
    await assert.rejects(() => call_tool({
      source: 'builtin', name: 'call_tool', args: { source: 'node', name: 'custom_probe', args: {} },
    }, ctx), /dispatcher\/container.*not a concrete builtin capability/i);
    await assert.rejects(() => call_tool({
      toolId: 'builtin:call_tool', args: { source: 'node', name: 'custom_probe', args: {} },
    }, ctx), /dispatcher\/container.*not a concrete builtin capability/i);

    await sessionManager.setAgentMetadata(agentName, {
      isolated: true,
      isolatedNode: 'remote-a',
      toolRules: [
        { effect: 'allow', source: 'builtin', tool: 'run_script' },
        { effect: 'deny', source: 'node', node: 'remote-a', tool: 'custom_probe' },
      ],
    });

    await assert.rejects(() => tools.callTool('call_tool', descriptor, ctx), /denies node capability `custom_probe`/i);
    await assert.rejects(() => call_tool(descriptor, ctx), /denies node capability `custom_probe`/i);
    const nested = await tools.run_script({
      code: 'def main(args):\n    return call_tool(source="node", name="custom_probe", args={})',
    }, ctx);
    assert.equal(nested.status, 'failed');
    assert.match(String(nested.error), /denies node capability `custom_probe`/i);
    assert.equal(effects, 0);

    await sessionManager.setAgentMetadata(agentName, {
      isolated: true,
      isolatedNode: 'remote-a',
      toolRules: [{ effect: 'allow', source: 'builtin', tool: 'run_script' }],
    });
    assert.deepEqual(await tools.callTool('call_tool', descriptor, ctx), { output: 'allowed' });
    assert.deepEqual(await call_tool(descriptor, ctx), { output: 'allowed' });
    const allowedNested = await tools.run_script({
      code: 'def main(args):\n    return call_tool(source="node", name="custom_probe", args={})',
    }, ctx);
    assert.equal(allowedNested.status, 'completed');
    assert.deepEqual(allowedNested.result, { output: 'allowed' });
    assert.equal(effects, 3);
  } finally {
    (nodeExecution as any).executeNodeTool = originalExecute;
    await sessionManager.setAgentMetadata(agentName, { isolated: false }).catch(() => {});
    await sessionManager.deleteSession(sourceId).catch(() => false);
  }
});

test('search_tools and call_tool descriptions include usage guidance and examples', () => {
  const searchDef = definitions.find((entry) => entry.name === 'search_tools');
  const callDef = definitions.find((entry) => entry.name === 'call_tool');
  assert.ok(searchDef);
  assert.ok(callDef);

  assert.match(String(searchDef?.description), /builtin results contain Foxwarm control\/session\/management tools/i);
  assert.match(String(searchDef?.description), /Node results contain environment capabilities/i);
  assert.match(String(searchDef?.description), /example search_tools calls/i);
  assert.match(String(searchDef?.description), /mcp-management skill/i);
  assert.match(String((searchDef?.parameters?.properties as any)?.nodeId?.description), /current node/i);

  assert.match(String(callDef?.description), /argsJson.*JSON object string fallback/i);
  assert.match(String(callDef?.description), /must use source=node/i);
  assert.match(String(callDef?.description), /source:\"mcp\"/i);
  assert.match(String((callDef?.parameters?.properties as any)?.nodeId?.description), /omit.*current node/i);
  assert.match(String((callDef?.parameters?.properties as any)?.args?.description), /wrapper object/i);
  assert.match(String((callDef?.parameters?.properties as any)?.argsJson?.description), /providers that do not expose free-form object fields/i);

  const mcpConfigDef = definitions.find((entry) => entry.name === 'mcp_config');
  assert.match(String(mcpConfigDef?.description), /apply immediately/i);
  assert.match(String(mcpConfigDef?.description), /no Foxwarm restart/i);
  assert.match(String(mcpConfigDef?.description), /Do not edit the backing state\/config file manually/i);
});

test('default model-facing tool definitions exclude hidden browser and advanced tools', () => {
  for (const name of [
    'browse_open',
    'browse_list',
    'browse_get',
    'browse_close',
    'browse_interact',
    'get_archived_messages',
    'get_archived_blocks',
    'delete_session',
    'stop_session',
    'compact_session',
    'list_toolscript_runs',
    'get_toolscript_run',
    'cancel_toolscript_run',
    'start_toolscript_run',
    'set_session_child_model',
    'set_session_compact_threshold',
    'update_session_snapshot',
    'create_agent',
    'create_session',
    'set_agent_inherit',
    'set_agent_isolated',
    'move_session',
    'create_timer',
    'list_timers',
    'update_timer',
    'delete_timer',
    'mcp_config',
    'list_mcp_servers',
  ]) {
    assert.equal(modelFacingDefinitions.some(def => def.name === name), false, `${name} should be hidden from default model-facing tools`);
    assert.equal(definitions.some(def => def.name === name), true, `${name} should remain available for runtime compatibility`);
  }

  assert.equal(modelFacingDefinitions.some(def => def.name === 'search_tools'), true);
  assert.equal(modelFacingDefinitions.some(def => def.name === 'call_tool'), true);
  assert.equal(modelFacingDefinitions.some(def => def.name === 'recall'), true);
  assert.equal(definitions.some(def => def.name === 'get_context_archive'), false);
  assert.equal(modelFacingDefinitions.some(def => def.name === 'image_crop'), true);
  assert.equal(modelFacingDefinitions.some(def => def.name === 'image_write_to_file'), true);
  assert.equal(modelFacingDefinitions.some(def => def.name === 'submit_compact_plan'), true);
  assert.equal(modelFacingDefinitions.some(def => def.name === 'set_goal'), true);
  assert.equal(modelFacingDefinitions.some(def => def.name === 'session'), true);
  assert.equal(modelFacingDefinitions.some(def => def.name === 'skill'), true);
  assert.equal(modelFacingDefinitions.some(def => def.name === 'node'), true);
  for (const removedName of ['delete_file', 'update_session_name', 'list_skills', 'load_skill', 'list_nodes', 'change_current_node']) {
    assert.equal(definitions.some(def => def.name === removedName), false, `${removedName} should be removed from the builtin registry`);
  }
  assert.equal(definitions.some(def => def.name === 'list_sessions'), false);
  assert.equal(modelFacingDefinitions.some(def => def.name === 'wait'), true);
  assert.equal(definitions.some(def => def.name === 'set_todo'), false);
  assert.equal(modelFacingDefinitions.some(def => def.name === 'end_turn'), false);
  assert.equal(definitions.some(def => def.name === 'end_turn'), false);
});

test('recall model-facing schema separates target/vector retrieval from literal result post-filtering', () => {
  const recallDef = definitions.find(def => def.name === 'recall');
  assert.ok(recallDef);
  assert.equal(recallDef.defaultInject, true);
  assert.match(String(recallDef.description), /CTX-BLOCK/);
  assert.match(String(recallDef.description), /vector_query for semantic search/i);
  assert.match(String((recallDef.parameters?.properties as any)?.contentFilter?.description), /literal case-insensitive post-filter/i);
  assert.match(String((recallDef.parameters?.properties as any)?.contentFilter?.description), /not semantic search/i);
  assert.equal(Object.prototype.hasOwnProperty.call(recallDef.parameters?.properties || {}, 'query'), false);
  assert.deepEqual(Object.keys(recallDef.parameters?.properties || {}).sort(), [
    'agentName',
    'contentFilter',
    'excludeRegex',
    'includeRegex',
    'limit',
    'preferBlocks',
    'previewLength',
    'scope',
    'sessionId',
    'target',
    'toolDetail',
    'vector_query',
  ]);
  for (const legacyName of ['startSeq', 'endSeq', 'startId', 'endId', 'includeMessages', 'includeBlocks']) {
    assert.equal(Object.prototype.hasOwnProperty.call(recallDef.parameters?.properties || {}, legacyName), false);
  }
  assert.equal(definitions.some(def => def.name === 'get_context_archive'), false);

  const sessionMessagesDef = definitions.find(def => def.name === 'get_session_messages');
  assert.ok(sessionMessagesDef);
  assert.ok((sessionMessagesDef.parameters?.properties as any)?.contentFilter);
  assert.equal(Object.prototype.hasOwnProperty.call(sessionMessagesDef.parameters?.properties || {}, 'query'), false);
});

test('submit_compact_plan exposes the replaceAsBlocks array-or-JSON-string contract', () => {
  const compactDef = modelFacingDefinitions.find(def => def.name === 'submit_compact_plan');
  assert.ok(compactDef);
  assert.deepEqual(compactDef.parameters.required, ['replaceAsBlocks']);
  assert.equal(Object.prototype.hasOwnProperty.call(compactDef.parameters.properties, 'createBlocksJson'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(compactDef.parameters.properties, 'createBlocks'), false);
  const replacementSchema = compactDef.parameters.properties.replaceAsBlocks as any;
  assert.deepEqual(replacementSchema.oneOf.map((entry: any) => entry.type), ['array', 'string']);
  assert.deepEqual(replacementSchema.oneOf[0].items.required, ['level', 'sourceKind', 'sourceStart', 'sourceEnd', 'summary']);
  assert.deepEqual(replacementSchema.oneOf[0].items.properties.memoryFacts.items.required, ['kind', 'text']);
  assert.deepEqual(replacementSchema.oneOf[0].items.properties.memoryFacts.items.properties.attributedTo.enum, ['user', 'assistant', 'both']);
  assert.equal(compactDef.parameters.properties.preserveMessages.type, 'array');
  assert.equal(compactDef.parameters.properties.removePreservedMessages.type, 'array');
});

test('wait is the model-facing pause tool and end_turn is removed', () => {
  const waitDef = definitions.find(def => def.name === 'wait');
  assert.ok(waitDef);
  assert.equal(waitDef.defaultInject, true);
  assert.equal((waitDef.parameters?.properties as any)?.reason?.type, 'string');
  assert.equal((waitDef.parameters?.properties as any)?.timeoutSeconds?.type, 'number');
  assert.equal((waitDef.parameters?.properties as any)?.waitExecIds?.type, 'array');
  assert.equal(Object.prototype.hasOwnProperty.call(waitDef.parameters?.properties || {}, 'timeoutMessage'), false);
  assert.equal(definitions.some(def => def.name === 'end_turn'), false);
});

test('wait schema documents session activity, active-turn queueing, and one-shot fallback without polling', () => {
  const waitDef = definitions.find(def => def.name === 'wait');
  assert.ok(waitDef);

  const description = String(waitDef.description);
  assert.match(description, /pause .* until new session activity arrives/i);
  assert.match(description, /user\/inter-agent messages and supported session\/system activity wake the session/i);
  assert.match(description, /model or tool work is still running.*queues.*next safe processing point.*source boundaries/i);
  assert.match(description, /nothing useful remains to do or say/i);
  assert.doesNotMatch(description, /event-driven/i);

  const timeoutDescription = String((waitDef.parameters?.properties as any)?.timeoutSeconds?.description);
  assert.match(timeoutDescription, /one-shot fallback wake/i);
  assert.match(timeoutDescription, /not a polling interval/i);
});

test('set_goal schema keeps goal optional so clear can omit it', () => {
  const definition = definitions.find(def => def.name === 'set_goal');
  assert.ok(definition);
  assert.equal((definition.parameters?.properties as any)?.goal?.type, 'string');
  assert.equal(Object.prototype.hasOwnProperty.call(definition.parameters?.properties || {}, 'remindOnTurnEnd'), false);
  assert.deepEqual(definition.parameters?.required, undefined);
});

test('defaultInject metadata is the single source of truth for default model injection', () => {
  for (const definition of modelFacingDefinitions) {
    assert.equal(definition.defaultInject, true, `${definition.name} should explicitly opt in to default model injection`);
  }

  const hiddenBrowse = definitions.find(def => def.name === 'browse_list');
  assert.ok(hiddenBrowse);
  assert.equal(hiddenBrowse?.defaultInject, undefined);
  assert.equal(modelFacingDefinitions.some(def => def.name === 'browse_list'), false);
});

test('default model-facing tool names and serialized schema size stay consolidated', () => {
  assert.deepEqual(modelFacingDefinitions.map(def => def.name), [
    'read',
    'write',
    'edit',
    'apply_patch',
    'read_memory',
    'write_memory',
    'edit_memory',
    'delete_memory',
    'apply_patch_memory',
    'copy_between_nodes',
    'image_crop',
    'image_write_to_file',
    'exec',
    'create_child_session',
    'send_to_session',
    'wait',
    'send_to_channel',
    'send_file',
    'session',
    'list_agents',
    'skill',
    'get_session_messages',
    'recall',
    'set_goal',
    'submit_compact_plan',
    'search_tools',
    'call_tool',
    'run_script',
    'continue_script',
    'node',
  ]);

  const serializedBytes = Buffer.byteLength(JSON.stringify(modelFacingDefinitions), 'utf8');
  assert.equal(serializedBytes, 36_788);
  assert.ok(serializedBytes < 38_069, 'serialized default schema should stay below the pre-consolidation baseline');
});

test('obsolete context and resource builtins are removed entirely', async () => {
  const session = await sessionManager.getSession('main');
  for (const name of ['remote_node', 'node_tools', 'call_mcp', 'search_mcp_tools']) {
    assert.equal(definitions.some(def => def.name === name), false);
    assert.equal((tools as any)[name], undefined);
    await assert.rejects(() => tools.callTool(name, {}, { sessionId: session.id, session }), /Unknown builtin tool/);
  }
  assert.equal(definitions.some(def => def.name === 'get_memory_context'), false);
  assert.equal((tools as any).get_memory_context, undefined);
  assert.equal(definitions.some(def => def.name === 'change_directory'), false);
  assert.equal(definitions.some(def => def.name === 'compress_session'), false);
  assert.equal(definitions.some(def => def.name === 'list_sessions'), false);
});

test('consolidated resource tool schemas expose their approved actions', () => {
  const definition = definitions.find(def => def.name === 'session');
  assert.ok(definition);
  assert.equal(definition.defaultInject, true);
  assert.deepEqual((definition.parameters?.properties as any)?.action?.enum, ['status', 'list', 'update-display-name']);
  assert.equal((definition.parameters?.properties as any)?.start?.type, 'number');
  assert.equal((definition.parameters?.properties as any)?.count?.type, 'number');
  assert.equal((definition.parameters?.properties as any)?.sessionId?.type, 'string');
  assert.equal((definition.parameters?.properties as any)?.name?.type, 'string');
  assert.deepEqual(definition.parameters?.required, []);

  const skillDefinition = definitions.find(def => def.name === 'skill');
  assert.deepEqual((skillDefinition?.parameters?.properties as any)?.action?.enum, ['list', 'load']);
  assert.deepEqual(skillDefinition?.parameters?.required, ['action']);

  const nodeDefinition = definitions.find(def => def.name === 'node');
  assert.deepEqual((nodeDefinition?.parameters?.properties as any)?.action?.enum,
    ['list', 'select', 'create', 'ensure', 'inspect', 'destroy']);
  assert.equal((nodeDefinition?.parameters?.properties as any)?.providerId?.type, 'string');
  assert.equal((nodeDefinition?.parameters?.properties as any)?.nodeId?.type, 'string');
  assert.equal((nodeDefinition?.parameters?.properties as any)?.parameters?.type, 'object');
  assert.equal((nodeDefinition?.parameters?.properties as any)?.parametersJson?.type, 'string');
  assert.equal((nodeDefinition?.parameters?.properties as any)?.confirmation?.type, 'string');
  assert.deepEqual(nodeDefinition?.parameters?.required, ['action']);
  assert.equal(definitions.some(def => def.name === 'sandbox' || def.name === 'node_resource'), false);
});

test('builtin file/browser tool schemas no longer expose node selector parameters', () => {
  for (const name of ['read', 'write', 'edit', 'apply_patch', 'browse_open', 'browse_list', 'browse_get', 'browse_close', 'browse_interact']) {
    const def = definitions.find(entry => entry.name === name);
    assert.ok(def, `${name} should exist`);
    assert.equal(Object.prototype.hasOwnProperty.call(def?.parameters?.properties || {}, 'node'), false, `${name} should not expose node parameter`);
  }
});

test('list_files is removed from builtin tool definitions', () => {
  assert.equal(definitions.some(def => def.name === 'list_files'), false);
  assert.equal(modelFacingDefinitions.some(def => def.name === 'list_files'), false);
});
