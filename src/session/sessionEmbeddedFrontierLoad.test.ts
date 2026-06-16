import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);

async function withTempDataDir(run: (dataDir: string) => Promise<void>): Promise<void> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-session-load-'));
  try {
    await run(dataDir);
  } finally {
    await fs.remove(dataDir).catch(() => {});
  }
}

test('runtime session load uses embedded contextFrontier only and deleteSession cleans leftover legacy frontier file', async () => {
  await withTempDataDir(async (dataDir) => {
    const stateDir = path.join(dataDir, 'state');
    const sessionsDir = path.join(stateDir, 'sessions');
    const legacyOnlySessionId = 'runtime_legacy_frontier_ignored';
    const embeddedSessionId = 'runtime_embedded_frontier_loaded';
    const legacyOnlySessionFile = path.join(sessionsDir, `${legacyOnlySessionId}.json`);
    const embeddedSessionFile = path.join(sessionsDir, `${embeddedSessionId}.json`);
    const legacyFrontierFile = path.join(sessionsDir, `${legacyOnlySessionId}.frontier.json`);

    await fs.ensureDir(sessionsDir);
    await fs.writeJson(path.join(stateDir, 'migrationVersion.json'), {
      v: 1,
      migrations: {
        'embedded-context-frontier-v1': {
          status: 'completed',
          completedAt: Date.now(),
          migratedFiles: 0,
          skippedFiles: 0,
          failedFiles: 0,
          backupRoot: path.join(stateDir, 'migration-backup', 'embedded-context-frontier-v1'),
        },
      },
    });
    await fs.writeJson(path.join(stateDir, 'sessions.json'), {
      sessions: {
        [legacyOnlySessionId]: {
          id: legacyOnlySessionId,
          agent: 'main',
          stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
          busy: false,
          queue: [],
          meta: { lastMessageTime: Date.now(), messageCount: 1 },
          currentNode: 'master',
        },
        [embeddedSessionId]: {
          id: embeddedSessionId,
          agent: 'main',
          stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
          busy: false,
          queue: [],
          meta: { lastMessageTime: Date.now(), messageCount: 1 },
          currentNode: 'master',
        },
      },
    });
    await fs.writeJson(legacyOnlySessionFile, {
      history: [{ role: 'user', parts: [{ text: 'history without embedded frontier' }], __meta: { seq: 1, timestamp: 1 } }],
      persistentMemorySnapshot: 'snapshot',
      nextMessageSeq: 2,
      nextBlockId: 1,
      currentNode: 'master',
      agent: 'main',
      queue: [],
      busy: false,
    });
    await fs.writeJson(embeddedSessionFile, {
      history: [{ role: 'user', parts: [{ text: 'history with embedded frontier' }], __meta: { seq: 11, timestamp: 11 } }],
      persistentMemorySnapshot: 'snapshot',
      contextFrontier: [{ kind: 'message', seq: 11, preservedFromBlockId: 77 }],
      nextMessageSeq: 12,
      nextBlockId: 2,
      currentNode: 'master',
      agent: 'main',
      queue: [],
      busy: false,
    });
    await fs.writeJson(legacyFrontierFile, {
      v: 1,
      sessionId: legacyOnlySessionId,
      nextBlockId: 9,
      frontier: [{ kind: 'message', seq: 1, preservedFromBlockId: 123 }],
    });

    const sessionManagerModuleUrl = pathToFileURL(path.join(__dirname, '..', 'sessionManager.js')).href;
    const childScript = `
      (async () => {
        try {
          const fs = require('fs-extra');
          const sm = await import(${JSON.stringify(sessionManagerModuleUrl)});
          await sm.loadSessions();
          const embeddedSession = await sm.getSession(${JSON.stringify(embeddedSessionId)});
          const legacySession = await sm.getSession(${JSON.stringify(legacyOnlySessionId)});
          const deleteLegacyResult = await sm.deleteSession(${JSON.stringify(legacyOnlySessionId)});
          const legacyFileExistsAfterDelete = await fs.pathExists(${JSON.stringify(legacyFrontierFile)});
          const deleteEmbeddedResult = await sm.deleteSession(${JSON.stringify(embeddedSessionId)});
          const result = {
            embeddedContextFrontier: embeddedSession.contextFrontier,
            embeddedPreservedFromBlockId: embeddedSession.history[0]?.__meta?.preservedFromBlockId,
            embeddedContextFrontierItem: embeddedSession.history[0]?.__meta?.contextFrontierItem,
            legacyContextFrontier: legacySession.contextFrontier,
            legacyNextBlockId: legacySession.nextBlockId,
            legacyPreservedFromBlockId: legacySession.history[0]?.__meta?.preservedFromBlockId,
            deleteLegacyResult,
            legacyFileExistsAfterDelete,
            deleteEmbeddedResult,
          };
          process.stdout.write('RESULT_JSON ' + JSON.stringify(result) + '\\n', () => {
            // The session manager initializes the production logger; in this child-process
            // fixture its exit flush hook can keep the process alive after the assertions are
            // already reported. Remove it so the child remains a bounded runtime-load probe.
            process.removeAllListeners('exit');
            process.exit(0);
          });
        } catch (err) {
          console.error(err?.stack || err);
          process.removeAllListeners('exit');
          process.exit(1);
        }
      })();
    `;

    const { stdout } = await execFileAsync(process.execPath, ['-e', childScript], {
      cwd: path.resolve(__dirname, '..', '..'),
      env: { ...process.env, FOXWARM_DATA_DIR: dataDir },
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    const resultLine = stdout.trim().split('\n').find(line => line.startsWith('RESULT_JSON '));
    assert.ok(resultLine, `child process did not report result JSON. stdout:\n${stdout}`);
    const result = JSON.parse(resultLine.slice('RESULT_JSON '.length));

    assert.deepEqual(result.embeddedContextFrontier, [{ kind: 'message', seq: 11, preservedFromBlockId: 77 }]);
    assert.equal(result.embeddedPreservedFromBlockId, 77, 'embedded contextFrontier should annotate current runtime history');
    assert.deepEqual(result.embeddedContextFrontierItem, { kind: 'message', seq: 11, preservedFromBlockId: 77 });
    assert.equal(result.legacyContextFrontier, undefined, 'runtime load should not fallback-read legacy .frontier.json');
    assert.equal(result.legacyNextBlockId, 1, 'legacy .frontier.json nextBlockId should not be applied at runtime');
    assert.equal(result.legacyPreservedFromBlockId, undefined, 'legacy preserved metadata should not be applied at runtime');
    assert.equal(result.deleteLegacyResult, true);
    assert.equal(result.legacyFileExistsAfterDelete, false, 'deleteSession should clean leftover legacy frontier file');
    assert.equal(result.deleteEmbeddedResult, true);
  });
});
