import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import {
  createAgentMetadataStore,
  getAgentMetadata,
  getAgentToolRules,
  loadAgentMetadata,
  refreshAgentMetadata,
  resetAgentMetadataForTests,
  setAgentMetadata,
  setAgentIsolation,
  setAgentMetadataStoreForTests,
} from './agentMetadata';
import { getAgentDir } from '../config';
import * as sessionManager from '../sessionManager';
import { tool_create_agent, tool_list_agents, tool_set_agent_isolated } from '../toolsSessionAgent/agents';
import { checkToolPermissionForSession } from '../isolatedCheck';
import { tool_search_tools } from '../tools/unifiedSearch';

async function withTempDir(run: (dirPath: string) => Promise<void>): Promise<void> {
  const dirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-agent-metadata-'));
  try {
    await run(dirPath);
  } finally {
    resetAgentMetadataForTests();
    setAgentMetadataStoreForTests(null);
    await fs.remove(dirPath).catch(() => {});
  }
}

async function listBackupMatches(filePath: string): Promise<string[]> {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  return entries.filter((name) => name === `${base}.bak` || name.startsWith(`${base}.`) && name.endsWith('.bak')).map((name) => path.join(dir, name));
}

test('agent metadata persistence uses lightweight no-backup writes', async () => {
  await withTempDir(async (dirPath) => {
    const filePath = path.join(dirPath, 'agents.json');
    setAgentMetadataStoreForTests(createAgentMetadataStore(filePath));
    resetAgentMetadataForTests();

    await setAgentMetadata('alpha-agent', { isolated: true, isolatedNode: 'sandbox-a', skills: ['ignored-skill'] } as any);
    await setAgentMetadata('beta-agent', { inherit: 'alpha-agent' });
    resetAgentMetadataForTests();
    await loadAgentMetadata();

    assert.deepEqual(getAgentMetadata('alpha-agent'), {
      isolated: true,
      isolatedNode: 'sandbox-a',
    });
    assert.deepEqual(getAgentMetadata('beta-agent'), {
      inherit: 'alpha-agent',
    });

    const rewritten = await fs.readJson(filePath);
    assert.deepEqual(Object.keys(rewritten).sort(), ['alpha-agent', 'beta-agent']);
    assert.deepEqual(createAgentMetadataStore(filePath).listCandidatePaths(), [filePath]);
    assert.deepEqual(await listBackupMatches(filePath), []);
  });
});

test('agent tool rules normalize exactly, persist empty replacement, and reject invalid identities', async () => {
  await withTempDir(async (dirPath) => {
    const filePath = path.join(dirPath, 'agents.json');
    setAgentMetadataStoreForTests(createAgentMetadataStore(filePath));
    resetAgentMetadataForTests();

    await setAgentMetadata('rules-agent', {
      isolated: true,
      isolatedNode: ' sandbox-a ',
      toolRules: [
        { effect: 'allow', source: 'builtin', tool: ' run_script ' },
        { effect: 'deny', source: 'node', node: ' sandbox-a ', tool: ' exec ' },
        { effect: 'allow', source: 'mcp', server: ' search ', tool: ' web_search ' },
      ],
    } as any);
    assert.deepEqual(getAgentMetadata('rules-agent').toolRules, [
      { effect: 'allow', source: 'builtin', tool: 'run_script' },
      { effect: 'deny', source: 'node', node: 'sandbox-a', tool: 'exec' },
      { effect: 'allow', source: 'mcp', server: 'search', tool: 'web_search' },
    ]);

    resetAgentMetadataForTests();
    await loadAgentMetadata();
    assert.equal(getAgentMetadata('rules-agent').toolRules?.length, 3);
    const externallyUpdated = await fs.readJson(filePath);
    externallyUpdated['rules-agent'].toolRules = [{ effect: 'deny', source: 'builtin', tool: 'skill' }];
    await fs.writeJson(filePath, externallyUpdated);
    await refreshAgentMetadata('rules-agent');
    assert.deepEqual(getAgentToolRules('rules-agent'), [{ effect: 'deny', source: 'builtin', tool: 'skill' }]);
    await fs.remove(filePath);
    await refreshAgentMetadata('rules-agent');
    assert.deepEqual(getAgentToolRules('rules-agent'), [{ effect: 'deny', source: 'builtin', tool: 'skill' }]);
    await setAgentMetadata('rules-agent', { ...getAgentMetadata('rules-agent'), toolRules: [] });
    assert.deepEqual((await fs.readJson(filePath))['rules-agent'].toolRules, []);

    for (const toolRules of [
      [{ effect: 'allow', source: 'builtin', tool: '*' }],
      [{ effect: 'allow', source: 'builtin', tool: 'run_script', node: 'x' }],
      [
        { effect: 'allow', source: 'node', node: 'sandbox-a', tool: 'exec' },
        { effect: 'deny', source: 'node', node: 'sandbox-a', tool: 'exec' },
      ],
      Array.from({ length: 257 }, (_, index) => ({ effect: 'allow', source: 'builtin', tool: `tool-${index}` })),
      [{ effect: 'allow', source: 'builtin', tool: 'x'.repeat(129) }],
      [{ effect: 'allow', source: 'mcp', server: '你'.repeat(43), tool: 'search' }],
    ]) {
      await assert.rejects(() => setAgentMetadata('invalid-agent', { toolRules } as any), /toolRules/i);
    }
    assert.deepEqual(getAgentMetadata('invalid-agent'), {});
  });
});

test('malformed persisted rules reject authority loading, preserve a valid isolated snapshot, and are not reread for non-isolated workers', async () => {
  await withTempDir(async (dirPath) => {
    const filePath = path.join(dirPath, 'agents.json');
    setAgentMetadataStoreForTests(createAgentMetadataStore(filePath));
    await setAgentMetadata('guarded-agent', {
      isolated: true,
      isolatedNode: 'sandbox-a',
      toolRules: [{ effect: 'deny', source: 'builtin', tool: 'skill' }],
    });
    const malformed = await fs.readJson(filePath);
    malformed['guarded-agent'].toolRules = [{ effect: 'allow', source: 'builtin', tool: '*' }];
    await fs.writeJson(filePath, malformed);

    await assert.rejects(() => loadAgentMetadata(), /wildcard/i);
    assert.equal(getAgentMetadata('guarded-agent').isolated, true);
    assert.deepEqual(getAgentToolRules('guarded-agent'), [{ effect: 'deny', source: 'builtin', tool: 'skill' }]);
    await assert.rejects(() => checkToolPermissionForSession({
      id: 'guarded-session', agent: 'guarded-agent', currentNode: 'sandbox-a',
    } as any, { source: 'builtin', tool: 'skill' }, 'master', {}, true), /wildcard/i);
    assert.equal(getAgentMetadata('guarded-agent').isolated, true);

    resetAgentMetadataForTests();
    await assert.rejects(() => sessionManager.loadSessions(), /wildcard/i);

    await setAgentMetadata('worker-nonisolated', { isolated: false });
    const invalidRefresh = await fs.readJson(filePath);
    invalidRefresh['worker-nonisolated'].toolRules = [{ effect: 'allow', source: 'builtin', tool: '*' }];
    await fs.writeJson(filePath, invalidRefresh);
    const session: any = { id: 'worker-nonisolated-session', agent: 'worker-nonisolated', currentNode: 'master' };
    await assert.doesNotReject(() => checkToolPermissionForSession(session,
      { source: 'builtin', tool: 'skill' }, 'master', {}, true));
    await assert.doesNotReject(() => tool_search_tools({ sources: ['builtin'], limit: 1 }, {
      sessionId: session.id, session, sessionPlacement: 'session-worker',
    } as any));
  });
});

test('agent isolation mutation replaces rules only when supplied and reports the live count', async () => {
  await withTempDir(async (dirPath) => {
    const filePath = path.join(dirPath, 'agents.json');
    const agentName = `rules-isolation-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const agentDir = getAgentDir(agentName);
    setAgentMetadataStoreForTests(createAgentMetadataStore(filePath));
    await fs.ensureDir(agentDir);
    const deps: any = {
      validateAgentName: () => {},
      getSessionsMap: () => new Map(),
      getSession: async () => { throw new Error('unexpected session load'); },
      getExistingSession: async (): Promise<any> => null,
      saveSession: async () => {},
    };
    try {
      const enabled = await setAgentIsolation(deps, agentName, 'sandbox-a', [
        { effect: 'allow', source: 'builtin', tool: 'run_script' },
      ]);
      assert.equal(enabled.toolRuleCount, 1);
      assert.match(await tool_list_agents({}, {} as any), new RegExp(`\\*\\*${agentName}\\*\\*.*\\[tool rules:1\\]`));
      await setAgentIsolation(deps, agentName, 'sandbox-b');
      assert.equal(getAgentToolRules(agentName).length, 1);
      const cleared = await tool_set_agent_isolated({ agentName, toolRules: [] }, {} as any);
      assert.match(cleared, /isolated on node "sandbox-b"/);
      assert.match(cleared, /Tool rules: 0\./);
      assert.deepEqual(getAgentMetadata(agentName).toolRules, []);
    } finally {
      await fs.remove(agentDir).catch(() => {});
    }
  });
});

test('agent creation persists optional exact tool rules before returning', async () => {
  await withTempDir(async (dirPath) => {
    const filePath = path.join(dirPath, 'agents.json');
    const agentName = `rules-create-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const agentDir = getAgentDir(agentName);
    const invalidName = `${agentName}-invalid`;
    setAgentMetadataStoreForTests(createAgentMetadataStore(filePath));
    try {
      const created = await tool_create_agent({
        agentName,
        createMainSession: false,
        isolatedNode: 'sandbox-a',
        toolRules: [{ effect: 'allow', source: 'mcp', server: 'search', tool: 'web_search' }],
      }, {} as any);
      assert.match(created, /Tool rules: 1/);
      assert.deepEqual(getAgentMetadata(agentName), {
        isolated: true,
        isolatedNode: 'sandbox-a',
        toolRules: [{ effect: 'allow', source: 'mcp', server: 'search', tool: 'web_search' }],
      });

      await assert.rejects(() => sessionManager.createAgentWithMainSession({
        agentName: invalidName,
        createMainSession: false,
        toolRules: [{ effect: 'allow', source: 'builtin', tool: '*' }],
      }), /wildcard/i);
      assert.equal(await fs.pathExists(getAgentDir(invalidName)), false);
    } finally {
      await fs.remove(agentDir).catch(() => {});
      await fs.remove(getAgentDir(invalidName)).catch(() => {});
    }
  });
});
