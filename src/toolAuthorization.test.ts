import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import * as sessionManager from './sessionManager';
import { executeTools } from './llm';
import { call_tool } from './tools';
import { tool_run_script } from './toolscript';
import * as mcpClient from './mcpClient';
import {
  buildToolAuthorizationRequest,
  evaluateToolAuthorization,
  setToolAuthorizationPolicyForTests,
} from './toolAuthorization';
import { checkToolPermission } from './isolatedCheck';
import { getAgentDir } from './config';

function makeId(prefix: string): string {
  return `main/${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function toolResponseError(message: any): string {
  const response = message.parts?.find((part: any) => part.functionResponse)?.functionResponse?.response;
  return String(response?.error || '');
}

afterEach(() => {
  setToolAuthorizationPolicyForTests(undefined);
});

test('tool authorization evaluator uses first-match semantics and default allow', async () => {
  const request = buildToolAuthorizationRequest({
    session: { id: 'main/auth_eval', agent: 'main' } as any,
    tool: 'exec',
    targetNode: 'master',
    args: { command: 'echo hi' },
  });

  setToolAuthorizationPolicyForTests({
    version: 1,
    rules: [
      { id: 'deny-exec', match: { tool: 'exec' }, action: 'deny', reason: 'first rule' },
      { id: 'allow-exec', match: { tool: 'exec' }, action: 'allow' },
    ],
  });

  const denied = await evaluateToolAuthorization(request);
  assert.equal(denied.matched, true);
  assert.equal(denied.action, 'deny');
  assert.equal(denied.rule?.id, 'deny-exec');

  setToolAuthorizationPolicyForTests({ version: 1, rules: [] });
  const allowed = await evaluateToolAuthorization(request);
  assert.equal(allowed.matched, false);
  assert.equal(allowed.action, 'allow');
});

test('tool authorization evaluator matches scalar/list/tool object, args, targetNode, and path', async () => {
  const request = buildToolAuthorizationRequest({
    session: { id: 'sandbox/session', agent: 'sandbox' } as any,
    tool: { source: 'mcp', name: 'search_repos' },
    targetNode: 'master',
    args: {
      server: 'github',
      toolArgs: { query: 'foxwarm' },
      enabled: true,
    },
  });

  setToolAuthorizationPolicyForTests({
    version: 1,
    rules: [
      {
        id: 'allow-github-search',
        match: {
          agent: ['main', 'sandbox'],
          session: { regex: '^sandbox/' },
          tool: { source: 'mcp', name: ['search_repos'] },
          targetNode: 'master',
          args: {
            server: { oneOf: ['github'] },
            'toolArgs.query': { exists: true },
            enabled: { notOneOf: [false] },
          },
        },
        action: 'allow',
      },
    ],
  });

  const result = await evaluateToolAuthorization(request);
  assert.equal(result.matched, true);
  assert.equal(result.action, 'allow');
  assert.equal(result.rule?.id, 'allow-github-search');

  const outsideRequest = buildToolAuthorizationRequest({
    session: { id: 'main/path_eval', agent: 'main' } as any,
    tool: 'write',
    targetNode: 'master',
    args: { filePath: '/tmp/outside-foxwarm.txt', content: 'nope' },
  });
  setToolAuthorizationPolicyForTests({
    version: 1,
    rules: [
      {
        id: 'deny-outside-agent',
        match: {
          tool: ['write', 'edit'],
          targetNode: 'master',
          path: { anyNotWithin: '${agent.dir}' },
        },
        action: 'deny',
      },
    ],
  });
  const pathResult = await evaluateToolAuthorization(outsideRequest);
  assert.equal(pathResult.matched, true);
  assert.equal(pathResult.action, 'deny');
});

test('runtime authorization denies non-isolated direct builtin tool calls', async () => {
  const sessionId = makeId('auth_direct_deny');
  const session = await sessionManager.getSession(sessionId);
  setToolAuthorizationPolicyForTests({
    version: 1,
    rules: [
      { id: 'deny-search-tools', match: { tool: 'search_tools' }, action: 'deny', reason: 'test deny' },
    ],
  });

  const message = await executeTools([
    { id: 'call_auth_direct', name: 'search_tools', args: { sources: ['builtin'], includeSchema: false, limit: 1 } },
  ], { sessionId, session }, session);

  assert.match(toolResponseError(message), /Tool authorization denied by rule deny-search-tools: test deny/);
});

test('runtime authorization denies call_tool builtin targets before execution', async () => {
  const sessionId = makeId('auth_call_tool_builtin');
  const session = await sessionManager.getSession(sessionId);
  setToolAuthorizationPolicyForTests({
    version: 1,
    rules: [
      { id: 'deny-exec', match: { tool: 'exec' }, action: 'deny' },
    ],
  });

  await assert.rejects(
    () => call_tool({ toolId: 'builtin:exec', args: { command: 'echo should-not-run' } }, { sessionId, session } as any),
    /Tool authorization denied by rule deny-exec/,
  );
});

test('runtime authorization applies to ToolScript nested call_tool calls', async () => {
  const sessionId = makeId('auth_toolscript');
  const session = await sessionManager.getSession(sessionId);
  setToolAuthorizationPolicyForTests({
    version: 1,
    rules: [
      { id: 'deny-exec', match: { tool: 'exec' }, action: 'deny' },
    ],
  });

  const result: any = await tool_run_script({
    code: [
      'def main(args):',
      '    return call_tool("exec", {"command": "echo should-not-run"})',
    ].join('\n'),
  }, { sessionId, session } as any);

  assert.equal(result.status, 'failed');
  assert.match(String(result.error || ''), /Tool authorization denied by rule deny-exec/);
});

test('runtime authorization applies to ToolScript call_tool wrapper calls', async () => {
  const sessionId = makeId('auth_toolscript_wrapper');
  const session = await sessionManager.getSession(sessionId);
  setToolAuthorizationPolicyForTests({
    version: 1,
    rules: [
      { id: 'deny-call-tool-wrapper', match: { tool: 'call_tool' }, action: 'deny' },
    ],
  });

  const result: any = await tool_run_script({
    code: [
      'def main(args):',
      '    return call_tool("search_tools", {"sources": ["builtin"], "includeSchema": False, "limit": 1})',
    ].join('\n'),
  }, { sessionId, session } as any);

  assert.equal(result.status, 'failed');
  assert.match(String(result.error || ''), /Tool authorization denied by rule deny-call-tool-wrapper/);
});

test('runtime authorization matches MCP and node targets from modern call_tool', async () => {
  const sessionId = makeId('auth_dynamic');
  const session = await sessionManager.getSession(sessionId);
  const originalCallTool = mcpClient.callTool;
  try {
    setToolAuthorizationPolicyForTests({
      version: 1,
      rules: [
        {
          id: 'deny-github-search',
          match: { tool: { source: 'mcp', name: 'search_repos' }, args: { server: 'github' } },
          action: 'deny',
        },
      ],
    });
    (mcpClient as any).callTool = async () => {
      throw new Error('MCP call should have been denied before execution');
    };
    await assert.rejects(
      () => call_tool({ toolId: 'mcp:github/search_repos', args: { query: 'foxwarm' } }, { sessionId, session } as any),
      /Tool authorization denied by rule deny-github-search/,
    );

    setToolAuthorizationPolicyForTests({
      version: 1,
      rules: [
        {
          id: 'deny-android-node-tool',
          match: { tool: { source: 'node', name: 'android_screenshot' }, targetNode: 'android-node' },
          action: 'deny',
        },
      ],
    });
    await assert.rejects(
      () => call_tool({ source: 'node', nodeId: 'android-node', name: 'android_screenshot', args: { inline: true } }, { sessionId, session } as any),
      /Tool authorization denied by rule deny-android-node-tool/,
    );
  } finally {
    (mcpClient as any).callTool = originalCallTool;
  }
});

test('runtime authorization uses normalized targetNode for ordinary tools without node args', async () => {
  const sessionId = makeId('auth_target_node');
  const session = await sessionManager.getSession(sessionId);
  session.currentNode = 'sandbox-node';
  await sessionManager.saveSession(sessionId);
  setToolAuthorizationPolicyForTests({
    version: 1,
    rules: [
      { id: 'deny-sandbox-read', match: { tool: 'read', targetNode: 'sandbox-node' }, action: 'deny' },
    ],
  });

  const message = await executeTools([
    { id: 'call_auth_node', name: 'read', args: { filePath: 'README.md' } },
  ], { sessionId, session }, session);

  assert.match(toolResponseError(message), /Tool authorization denied by rule deny-sandbox-read/);
});

test('empty authorization policy preserves legacy isolated central checks while explicit allow bypasses central allowlist', async () => {
  const agentName = `auth_isolated_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const sessionId = `${agentName}/session`;
  try {
    await sessionManager.setAgentMetadata(agentName, { isolated: true, isolatedNode: 'sandbox-node' } as any);
    const session = await sessionManager.getSession(sessionId);
    session.agent = agentName;
    session.currentNode = 'sandbox-node';

    setToolAuthorizationPolicyForTests({ version: 1, rules: [] });
    await assert.rejects(
      () => checkToolPermission('exec', sessionId, 'master', { command: 'echo blocked' }),
      /cannot run exec on master/i,
    );

    setToolAuthorizationPolicyForTests({
      version: 1,
      rules: [
        { id: 'allow-list-nodes', match: { agent: agentName, tool: 'list_nodes' }, action: 'allow' },
      ],
    });
    await assert.doesNotReject(() => checkToolPermission('list_nodes', sessionId, 'master', {}));
  } finally {
    await sessionManager.setAgentMetadata(agentName, { isolated: false } as any).catch(() => {});
  }
});

test('explicit allow does not bypass legacy isolated special copy_between_nodes checks', async () => {
  const agentName = `auth_copy_guard_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const sessionId = `${agentName}/session`;
  try {
    await sessionManager.setAgentMetadata(agentName, { isolated: true, isolatedNode: 'sandbox-node' } as any);
    const session = await sessionManager.getSession(sessionId);
    session.agent = agentName;
    session.currentNode = 'sandbox-node';
    setToolAuthorizationPolicyForTests({
      version: 1,
      rules: [
        { id: 'allow-copy', match: { agent: agentName, tool: 'copy_between_nodes' }, action: 'allow' },
      ],
    });

    await assert.rejects(
      () => checkToolPermission('copy_between_nodes', sessionId, 'master', {
        sourceNode: 'master',
        sourcePath: '/tmp/outside-agent.txt',
        targetNode: 'sandbox-node',
        targetPath: '/tmp/remote-target.txt',
      }),
      /only read from agents\//,
    );
  } finally {
    await sessionManager.setAgentMetadata(agentName, { isolated: false } as any).catch(() => {});
  }
});

test('explicit allow does not bypass legacy tool-local isolated hard guards', async () => {
  const agentName = `auth_hard_guard_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const sessionId = `${agentName}/session`;
  try {
    await sessionManager.setAgentMetadata(agentName, { isolated: true, isolatedNode: 'sandbox-node' } as any);
    const session = await sessionManager.getSession(sessionId);
    session.agent = agentName;
    session.currentNode = 'sandbox-node';
    setToolAuthorizationPolicyForTests({
      version: 1,
      rules: [
        { id: 'allow-load-skill', match: { agent: agentName, tool: 'load_skill' }, action: 'allow' },
      ],
    });

    const message = await executeTools([
      { id: 'call_auth_hard_guard', name: 'load_skill', args: { skillName: 'about-foxwarm' } },
    ], { sessionId, session }, session);

    assert.match(toolResponseError(message), /Isolated session cannot use load_skill tool/);
  } finally {
    await sessionManager.setAgentMetadata(agentName, { isolated: false } as any).catch(() => {});
  }
});

test('path matcher can target copy_between_nodes source and target path arguments', async () => {
  const request = buildToolAuthorizationRequest({
    session: { id: 'main/auth_copy_path', agent: 'main' } as any,
    tool: 'copy_between_nodes',
    targetNode: 'master',
    args: {
      sourceNode: 'master',
      sourcePath: path.join(getAgentDir('main'), 'safe.txt'),
      targetNode: 'master',
      targetPath: '/tmp/outside-copy-target.txt',
    },
  });
  setToolAuthorizationPolicyForTests({
    version: 1,
    rules: [
      {
        id: 'deny-copy-target-outside-agent',
        match: {
          tool: 'copy_between_nodes',
          args: { targetNode: 'master' },
          path: { arg: 'targetPath', anyNotWithin: '${agent.dir}' },
        },
        action: 'deny',
      },
    ],
  });

  const result = await evaluateToolAuthorization(request);
  assert.equal(result.matched, true);
  assert.equal(result.action, 'deny');
  assert.equal(result.rule?.id, 'deny-copy-target-outside-agent');
});
