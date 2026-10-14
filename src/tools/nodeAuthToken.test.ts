import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import fsPromises from 'node:fs/promises';
import os from 'os';
import path from 'path';
import { tool_node_create_auth_token } from './nodeTools';
import { call_tool } from '../tools';
import { tool_run_script } from '../toolscript';
import * as sessionManager from '../sessionManager';
import { executeMainManagementTool, shutdownMainManagementTools, resetMainManagementToolsForTests } from '../mainManagementTools';
import { parseToolAuthorizationPolicyBytes, setToolAuthorizationPolicyForTests } from '../toolAuthorization';
import {
  authenticateApprovedNode,
  createNodeRegistryStore,
  listApprovedNodes,
  resetNodeRegistryForTests,
  setNodeRegistryStoreForTests,
} from '../nodes/registry';

async function withFixture(run: (dirPath: string) => Promise<void>): Promise<void> {
  const dirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-node-auth-token-'));
  try {
    setNodeRegistryStoreForTests(createNodeRegistryStore(path.join(dirPath, 'nodes.json')));
    await run(dirPath);
  } finally {
    resetNodeRegistryForTests();
    setNodeRegistryStoreForTests(null);
    await fs.remove(dirPath).catch(() => {});
  }
}

const context = { sessionId: 'main', session: { id: 'main', agent: 'main' } } as any;

test('node_create_auth_token writes an owner-only token file while returning no token', async () => {
  await withFixture(async dirPath => {
    const privateDir = path.join(dirPath, 'private');
    const aliasDir = path.join(dirPath, 'private-alias');
    await fs.ensureDir(privateDir);
    await fs.symlink(privateDir, aliasDir, 'dir');
    const filePath = path.join(aliasDir, 'node.token');

    const result = await tool_node_create_auth_token({ nodeId: 'fixture-node', filePath }, context);
    assert.deepEqual(result, { nodeId: 'fixture-node', filePath });

    const token = await fs.readFile(filePath, 'utf8');
    assert.match(token, /^[a-f0-9]{64}\n$/);
    assert.equal((await fs.stat(filePath)).mode & 0o777, 0o600);
    assert.equal((await authenticateApprovedNode('fixture-node', token.trim()))?.nodeId, 'fixture-node');
    assert.equal(JSON.stringify(await listApprovedNodes()).includes(token.trim()), false);
  });
});

test('node_create_auth_token rejects an existing file before reserving its Node ID', async () => {
  await withFixture(async dirPath => {
    const filePath = path.join(dirPath, 'existing.token');
    await fs.writeFile(filePath, 'keep-me\n', { mode: 0o640 });

    await assert.rejects(
      () => tool_node_create_auth_token({ nodeId: 'existing-file-node', filePath }, context),
      /Token file already exists/,
    );
    assert.equal(await fs.readFile(filePath, 'utf8'), 'keep-me\n');
    assert.equal((await listApprovedNodes()).some(node => node.nodeId === 'existing-file-node'), false);
  });
});

test('node_create_auth_token rejects an existing Node ID without creating a second credential file', async () => {
  await withFixture(async dirPath => {
    const firstPath = path.join(dirPath, 'first.token');
    const secondPath = path.join(dirPath, 'second.token');
    const first = await tool_node_create_auth_token({ nodeId: 'duplicate-node', filePath: firstPath }, context);
    const original = await fs.readFile(firstPath, 'utf8');

    await assert.rejects(
      () => tool_node_create_auth_token({ nodeId: 'duplicate-node', filePath: secondPath }, context),
      /already exists/,
    );
    assert.equal(await fs.readFile(firstPath, 'utf8'), original);
    assert.equal(await fs.pathExists(secondPath), false);
    assert.equal((await authenticateApprovedNode(first.nodeId, original.trim()))?.nodeId, first.nodeId);
  });
});

test('node_create_auth_token keeps a reserved Node when writing the created file fails and cleans the file', async () => {
  await withFixture(async dirPath => {
    const filePath = path.join(dirPath, 'injected-failure.token');
    const originalOpen = fsPromises.open;
    (fsPromises as any).open = async (targetPath: string, flags: any, mode: any) => {
      const handle = await originalOpen(targetPath, flags, mode);
      if (targetPath === filePath) {
        (handle as any).writeFile = async () => { throw new Error('injected write failure'); };
      }
      return handle;
    };
    try {
      await assert.rejects(
        () => tool_node_create_auth_token({ nodeId: 'write-failure-node', filePath }, context),
        /Node `write-failure-node` remains reserved.*cleaned.*injected write failure/,
      );
      assert.equal(await fs.pathExists(filePath), false);
      assert.equal((await listApprovedNodes()).some(node => node.nodeId === 'write-failure-node'), true);
    } finally {
      (fsPromises as any).open = originalOpen;
    }
  });
});

test('node_create_auth_token removes its newly created file when Node ID reservation fails', async () => {
  await withFixture(async dirPath => {
    const filePath = path.join(dirPath, 'invalid-id.token');
    await assert.rejects(
      () => tool_node_create_auth_token({ nodeId: 'Invalid Node', filePath }, context),
      /must already be in sanitized form/,
    );
    assert.equal(await fs.pathExists(filePath), false);
    assert.equal((await listApprovedNodes()).some(node => node.nodeId === 'Invalid Node'), false);
  });
});

test('node_create_auth_token rejects an existing symlink without replacing its target or reserving the Node', async () => {
  await withFixture(async dirPath => {
    const targetPath = path.join(dirPath, 'target.token');
    const linkPath = path.join(dirPath, 'link.token');
    await fs.writeFile(targetPath, 'keep-target\n');
    await fs.symlink(targetPath, linkPath);

    await assert.rejects(
      () => tool_node_create_auth_token({ nodeId: 'symlink-node', filePath: linkPath }, context),
      /Token file already exists/,
    );
    assert.equal(await fs.readFile(targetPath, 'utf8'), 'keep-target\n');
    assert.equal((await listApprovedNodes()).some(node => node.nodeId === 'symlink-node'), false);
  });
});

test('Session-worker direct, unified, and ToolScript calls stay on Main and never expose the token', async () => {
  await withFixture(async dirPath => {
    await shutdownMainManagementTools().catch(() => {});
    resetMainManagementToolsForTests();
    const sourceId = `node_auth_worker_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const source = await sessionManager.getSession(sourceId);
    const workerContext: any = {
      sessionId: sourceId,
      session: source,
      sessionPlacement: 'session-worker',
      persistCurrentSession: async () => {},
    };
    const directPath = path.join(dirPath, 'direct.token');
    const unifiedPath = path.join(dirPath, 'unified.token');
    const scriptPath = path.join(dirPath, 'script.token');
    const copiedPath = path.join(dirPath, 'copied.token');
    const copyCommand = `cp -- '${scriptPath}' '${copiedPath}'`;
    try {
      const direct = await tool_node_create_auth_token({ nodeId: 'worker-direct', filePath: directPath }, workerContext);
      const unified = await call_tool({
        toolId: 'builtin:node_create_auth_token',
        args: { nodeId: 'worker-unified', filePath: unifiedPath },
      }, workerContext);
      const script = await tool_run_script({ code: `def main(args):
    created = call_tool(toolId="builtin:node_create_auth_token", args={"nodeId":"worker-script", "filePath":${JSON.stringify(scriptPath)}})
    call_tool(source="node", nodeId="master", name="exec", args={"command": ${JSON.stringify(copyCommand)}})
    return {"nodeId": created["nodeId"], "filePath": created["filePath"], "exec": "completed"}` }, workerContext);

      assert.deepEqual(direct, { nodeId: 'worker-direct', filePath: directPath });
      assert.deepEqual(unified, { nodeId: 'worker-unified', filePath: unifiedPath });
      assert.equal(script.status, 'completed');
      assert.deepEqual(script.result, { nodeId: 'worker-script', filePath: scriptPath, exec: 'completed' });

      const canary = (await fs.readFile(scriptPath, 'utf8')).trim();
      assert.equal(await fs.readFile(copiedPath, 'utf8'), `${canary}\n`);
      assert.equal(JSON.stringify(script).includes(canary), false);
      assert.equal(JSON.stringify(source.history || []).includes(canary), false);
      for (const [nodeId, tokenPath] of [['worker-direct', directPath], ['worker-unified', unifiedPath], ['worker-script', scriptPath]] as const) {
        assert.equal((await authenticateApprovedNode(nodeId, (await fs.readFile(tokenPath, 'utf8')).trim()))?.nodeId, nodeId);
      }
    } finally {
      await sessionManager.deleteSession(sourceId).catch(() => false);
      await shutdownMainManagementTools().catch(() => {});
      resetMainManagementToolsForTests();
    }
  });
});

test('generic policy denial blocks auth-token creation before file or registry effects', async () => {
  await withFixture(async dirPath => {
    await shutdownMainManagementTools().catch(() => {});
    resetMainManagementToolsForTests();
    const sourceId = `node_auth_denied_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const source = await sessionManager.getSession(sourceId);
    const workerContext: any = {
      sessionId: sourceId,
      session: source,
      sessionPlacement: 'session-worker',
      persistCurrentSession: async () => {},
    };
    const filePath = path.join(dirPath, 'denied.token');
    setToolAuthorizationPolicyForTests(parseToolAuthorizationPolicyBytes('version: 1\ndefaultAction: deny\nrules: []\n'));
    try {
      await assert.rejects(
        () => executeMainManagementTool('node_create_auth_token', { nodeId: 'denied-node', filePath }, workerContext),
        /denies|denied|not allowed|forbidden/i,
      );
      assert.equal(await fs.pathExists(filePath), false);
      assert.equal((await listApprovedNodes()).some(node => node.nodeId === 'denied-node'), false);
    } finally {
      setToolAuthorizationPolicyForTests(undefined);
      await sessionManager.deleteSession(sourceId).catch(() => false);
      await shutdownMainManagementTools().catch(() => {});
      resetMainManagementToolsForTests();
    }
  });
});
