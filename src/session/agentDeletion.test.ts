import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { spawnSync } from 'node:child_process';

function runIsolatedScript(tempRoot: string, script: string): void {
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '..', '..'),
    env: { ...process.env, FOXWARM_DATA_DIR: tempRoot },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test('agent deletion rejects immutable and inherited workspaces and removes an idle empty workspace', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-agent-deletion-'));
  try {
    runIsolatedScript(tempRoot, String.raw`
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
        const ownedSession = await sm.getExistingSession(created.sessionId);
        ownedSession.busy = true;
        await sm.saveSession(ownedSession);
        await assert.rejects(
          () => sm.deleteAgent('owned-agent', async sessionId => {
            delegatedSessionIds.push(sessionId);
            return sm.deleteSession(sessionId);
          }),
          /active sessions: owned-agent\/main/,
        );
        assert.deepEqual(delegatedSessionIds, []);
        ownedSession.busy = false;
        await sm.saveSession(ownedSession);
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
    `);
  } finally {
    await fs.remove(tempRoot);
  }
});

test('agent deletion discards queued Session work and stays deleted after restart', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-agent-deletion-restart-'));
  try {
    runIsolatedScript(tempRoot, String.raw`
      const assert = require('node:assert/strict');
      const fs = require('fs-extra');
      const sm = require('./lib/sessionManager.js');
      const metadata = require('./lib/session/agentMetadata.js');
      const config = require('./lib/config.js');
      (async () => {
        await fs.ensureDir(config.getAgentDir('queued-agent'));
        await metadata.setAgentMetadata('queued-agent', { isolated: true, isolatedNode: 'node-a' });
        const queued = await sm.createSessionInAgent({ agentName: 'queued-agent', sessionName: 'queued' });
        const idle = await sm.createSessionInAgent({ agentName: 'queued-agent', sessionName: 'idle' });
        await sm.enqueueSessionItem(queued.sessionId, { type: 'user', parts: [{ text: 'discard with confirmed Agent deletion' }] });
        assert.equal((await sm.getExistingSession(queued.sessionId)).queue.length, 1);
        assert.ok(sm.getSessionCatalog(idle.sessionId));
        process.exit(0);
      })().catch(error => { console.error(error.stack || error); process.exit(1); });
    `);

    runIsolatedScript(tempRoot, String.raw`
      const assert = require('node:assert/strict');
      const fs = require('fs-extra');
      const path = require('node:path');
      const sm = require('./lib/sessionManager.js');
      const { deleteSessionLifecycle } = require('./lib/sessionDeletion.js');
      const metadata = require('./lib/session/agentMetadata.js');
      const config = require('./lib/config.js');
      (async () => {
        await metadata.loadAgentMetadata();
        await sm.loadSessions();
        const queuedId = 'queued-agent/queued';
        const idleId = 'queued-agent/idle';
        assert.equal(sm.getSessionCatalog(queuedId).queue.length, 0, 'restart begins from a lazy catalog stub');
        assert.equal(sm.getSessionCatalog(idleId).queue.length, 0);

        const delegatedSessionIds = [];
        const result = await sm.deleteAgent('queued-agent', async sessionId => {
          delegatedSessionIds.push(sessionId);
          const deletion = await deleteSessionLifecycle({ requestedSessionId: sessionId, includeDescendants: false });
          assert.notEqual(deletion.status, 'busy');
          return deletion.status === 'deleted';
        });
        assert.deepEqual(new Set(delegatedSessionIds), new Set([queuedId, idleId]));
        assert.deepEqual(new Set(result.deletedSessions), new Set([queuedId, idleId]));
        assert.equal(await fs.pathExists(config.getAgentDir('queued-agent')), false);
        assert.deepEqual(metadata.getAgentMetadata('queued-agent'), {});
        assert.equal(await fs.pathExists(path.join(config.SESSIONS_DIR, queuedId + '.json')), false);
        assert.equal(await fs.pathExists(path.join(config.SESSIONS_DIR, idleId + '.json')), false);
        assert.equal(sm.getSessionCatalog(queuedId), undefined);
        assert.equal(sm.getSessionCatalog(idleId), undefined);
        process.exit(0);
      })().catch(error => { console.error(error.stack || error); process.exit(1); });
    `);

    runIsolatedScript(tempRoot, String.raw`
      const assert = require('node:assert/strict');
      const fs = require('fs-extra');
      const sm = require('./lib/sessionManager.js');
      const config = require('./lib/config.js');
      (async () => {
        await sm.loadSessions();
        assert.equal(sm.getSessionCatalog('queued-agent/queued'), undefined);
        assert.equal(sm.getSessionCatalog('queued-agent/idle'), undefined);
        assert.equal(await sm.getExistingSession('queued-agent/queued'), null);
        assert.equal(await fs.pathExists(config.getAgentDir('queued-agent')), false);

        await sm.createAgentWithMainSession({ agentName: 'queued-agent', createMainSession: false });
        await assert.rejects(
          () => sm.createSessionInAgent({ agentName: 'queued-agent', sessionName: 'queued' }),
          error => error && error.code === sm.ARCHIVED_SESSION_ID_ERROR_CODE,
        );
        process.exit(0);
      })().catch(error => { console.error(error.stack || error); process.exit(1); });
    `);
  } finally {
    await fs.remove(tempRoot);
  }
});
