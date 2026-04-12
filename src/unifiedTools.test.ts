import test from 'node:test';
import assert from 'node:assert/strict';
import * as mcpClient from './mcpClient';
import { nodesManager } from './nodes/manager';
import {
  call_tool,
  definitions,
  modelFacingDefinitions,
  search_tools,
} from './tools';

test('search_tools returns structured builtin results with hidden/direct exposure metadata', async () => {
  const result: any = await search_tools({
    query: 'browse',
    sources: ['builtin'],
    includeSchema: true,
    limit: 20,
  });

  assert.equal(typeof result.count, 'number');
  assert.ok(Array.isArray(result.tools));

  const browseList = result.tools.find((tool: any) => tool.name === 'browse_list');
  assert.ok(browseList);
  assert.equal(browseList.source, 'builtin');
  assert.equal(browseList.toolId, 'builtin:browse_list');
  assert.equal(browseList.directExposed, false);
  assert.equal(browseList.hidden, true);
  assert.deepEqual(
    browseList.inputSchema,
    definitions.find(def => def.name === 'browse_list')?.parameters,
  );

  const readResult: any = await search_tools({
    query: 'read',
    sources: ['builtin'],
    includeSchema: false,
    limit: 20,
  });
  const readTool = readResult.tools.find((tool: any) => tool.name === 'read');
  assert.ok(readTool);
  assert.equal(readTool.directExposed, true);
  assert.equal(Object.prototype.hasOwnProperty.call(readTool, 'inputSchema'), false);
});

test('search_tools multi-word queries rank tools matching more words higher', async () => {
  const result: any = await search_tools({
    query: 'session archive',
    sources: ['builtin'],
    includeSchema: false,
    limit: 10,
  });

  assert.ok(result.tools.length >= 2);
  const archiveIndex = result.tools.findIndex((tool: any) => tool.name === 'get_context_archive');
  const sessionIndex = result.tools.findIndex((tool: any) => tool.name === 'get_session_messages');
  assert.ok(archiveIndex >= 0, 'get_context_archive should match both words');
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

test('call_tool can invoke hidden builtin browse_list', async () => {
  const result = await call_tool(
    {
      toolId: 'builtin:browse_list',
      args: {},
    },
    {
      sessionId: 'main',
      session: { agent: 'main', currentNode: 'master' },
    } as any,
  );

  assert.match(String(result), /no tabs open/i);
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
    /call_tool requires args/i,
  );
});

test('call_tool schema marks args as required', () => {
  const def = definitions.find((item) => item.name === 'call_tool');
  assert.ok(def);
  assert.deepEqual(def?.parameters?.required, ['args']);
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

test('search_tools and call_tool cover remote node tools', async () => {
  const originalListNodesWithTools = nodesManager.listNodesWithTools;
  const originalExecuteNodeTool = nodesManager.executeNodeTool;
  const originalGetCurrentNode = nodesManager.getCurrentNode;

  try {
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
    (nodesManager as any).executeNodeTool = async (nodeId: string, tool: string, args: Record<string, any>, sessionId: string) => ({
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
    });

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
    (nodesManager as any).executeNodeTool = originalExecuteNodeTool;
    (nodesManager as any).getCurrentNode = originalGetCurrentNode;
  }
});

test('search_tools and call_tool descriptions include usage guidance and examples', () => {
  const searchDef = definitions.find((entry) => entry.name === 'search_tools');
  const callDef = definitions.find((entry) => entry.name === 'call_tool');
  assert.ok(searchDef);
  assert.ok(callDef);

  assert.match(String(searchDef?.description), /builtin results include file\/edit tools, exec, session\/channel tools, vector\/archive tools, timers/i);
  assert.match(String(searchDef?.description), /example search_tools calls/i);
  assert.match(String((searchDef?.parameters?.properties as any)?.nodeId?.description), /current node/i);

  assert.match(String(callDef?.description), /always put the target tool arguments inside the required `args` object/i);
  assert.match(String(callDef?.description), /builtin:read/i);
  assert.match(String(callDef?.description), /source:\"mcp\"/i);
  assert.match(String((callDef?.parameters?.properties as any)?.args?.description), /required wrapper object/i);
});

test('default model-facing tool definitions exclude hidden browser and legacy wrapper tools', () => {
  for (const name of [
    'browse_open',
    'browse_list',
    'browse_get',
    'browse_close',
    'browse_interact',
    'remote_node',
    'call_mcp',
    'search_mcp_tools',
    'get_archived_messages',
    'get_archived_blocks',
    'set_session_child_model',
    'set_session_compact_threshold',
    'update_session_snapshot',
    'create_agent',
    'create_session',
    'set_agent_inherit',
    'set_agent_isolated',
    'move_session',
  ]) {
    assert.equal(modelFacingDefinitions.some(def => def.name === name), false, `${name} should be hidden from default model-facing tools`);
    assert.equal(definitions.some(def => def.name === name), true, `${name} should remain available for runtime compatibility`);
  }

  assert.equal(modelFacingDefinitions.some(def => def.name === 'search_tools'), true);
  assert.equal(modelFacingDefinitions.some(def => def.name === 'call_tool'), true);
  assert.equal(modelFacingDefinitions.some(def => def.name === 'get_context_archive'), true);
});

test('change_directory and compress_session are removed entirely', () => {
  assert.equal(definitions.some(def => def.name === 'change_directory'), false);
  assert.equal(definitions.some(def => def.name === 'compress_session'), false);
});

test('builtin file/browser tool schemas no longer expose node selector parameters', () => {
  for (const name of ['read', 'write', 'edit', 'apply_patch', 'list_files', 'delete_file', 'browse_open', 'browse_list', 'browse_get', 'browse_close', 'browse_interact']) {
    const def = definitions.find(entry => entry.name === name);
    assert.ok(def, `${name} should exist`);
    assert.equal(Object.prototype.hasOwnProperty.call(def?.parameters?.properties || {}, 'node'), false, `${name} should not expose node parameter`);
  }
});
