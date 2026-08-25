import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { spawnSync } from 'node:child_process';

test('agent deletion rejects immutable and inherited workspaces and removes an idle empty workspace', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-agent-deletion-'));
  try {
    const script = String.raw`
      const assert = require('node:assert/strict');
      const fs = require('fs-extra');
      const sm = require('./lib/sessionManager.js');
      const metadata = require('./lib/session/agentMetadata.js');
      const config = require('./lib/config.js');
      (async () => {
        await fs.ensureDir(config.getAgentDir('parent-agent'));
        await fs.ensureDir(config.getAgentDir('child-agent'));
        await metadata.setAgentMetadata('child-agent', { inherit: 'parent-agent' });
        await assert.rejects(
          () => sm.deleteAgent('parent-agent', async () => true),
          /inherited by: child-agent/,
        );
        await assert.rejects(
          () => sm.deleteAgent('main', async () => true),
          /main agent cannot be deleted/,
        );
        await metadata.setAgentMetadata('child-agent', {});
        let deleteCalls = 0;
        const result = await sm.deleteAgent('parent-agent', async () => {
          deleteCalls += 1;
          return true;
        });
        assert.deepEqual(result, { deletedSessions: [] });
        assert.equal(deleteCalls, 0);
        assert.equal(await fs.pathExists(config.getAgentDir('parent-agent')), false);
        assert.deepEqual(metadata.getAgentMetadata('parent-agent'), {});

        await fs.ensureDir(config.getAgentDir('owned-agent'));
        const created = await sm.createSessionInAgent({ agentName: 'owned-agent', sessionName: 'main' });
        const delegatedSessionIds = [];
        const ownedResult = await sm.deleteAgent('owned-agent', async sessionId => {
          delegatedSessionIds.push(sessionId);
          return sm.deleteSession(sessionId);
        });
        assert.deepEqual(delegatedSessionIds, [created.sessionId]);
        assert.deepEqual(ownedResult, { deletedSessions: [created.sessionId] });
        assert.equal(sm.getSessionCatalog(created.sessionId), undefined);
        assert.equal(await fs.pathExists(config.getAgentDir('owned-agent')), false);
        process.exit(0);
      })().catch(error => { console.error(error.stack || error); process.exit(1); });
    `;
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: path.resolve(__dirname, '..', '..'),
      env: { ...process.env, FOXWARM_DATA_DIR: tempRoot },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    await fs.remove(tempRoot);
  }
});
