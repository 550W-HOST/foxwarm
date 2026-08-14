import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

import { EMBEDDED_CONTEXT_FRONTIER_MIGRATION_ID, runEmbeddedContextFrontierMigration } from './embeddedContextFrontier';
import type { ArchiveBlockRecord } from '../session/layeredContext';

async function withTempDir(run: (dirPath: string) => Promise<void>): Promise<void> {
  const dirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-frontier-migration-'));
  try {
    await run(dirPath);
  } finally {
    await fs.remove(dirPath).catch(() => {});
  }
}

function blockRecord(): ArchiveBlockRecord {
  return {
    v: 1,
    kind: 'block',
    sessionId: 'alpha',
    agent: 'main',
    id: 3,
    level: 1,
    sourceKind: 'message',
    sourceStart: 1,
    sourceEnd: 2,
    rawStartSeq: 1,
    rawEndSeq: 2,
    rawStartTimestamp: 100,
    rawEndTimestamp: 200,
    summary: 'legacy block summary',
    createdAt: 300,
  };
}

test('frontier migration retires the legacy file without changing active history', async () => {
  await withTempDir(async (dirPath) => {
    const stateDir = path.join(dirPath, 'state');
    const sessionsDir = path.join(stateDir, 'sessions');
    const migrationVersionFile = path.join(stateDir, 'migrationVersion.json');
    const migrationBackupDir = path.join(stateDir, 'migration-backup');
    await fs.ensureDir(sessionsDir);

    const sessionFile = path.join(sessionsDir, 'alpha.json');
    const frontierFile = path.join(sessionsDir, 'alpha.frontier.json');
    await fs.writeJson(sessionFile, {
      history: [
        {
          role: 'model',
          parts: [{ text: '[CTX-BLOCK L1 B#3 raw#1-#2] legacy block summary' }],
          __meta: { timestamp: 300 },
        },
        {
          role: 'user',
          parts: [{ text: 'exact preserved instruction' }],
          __meta: { seq: 2, timestamp: 200 },
        },
      ],
      persistentMemorySnapshot: 'snapshot',
      nextBlockId: 1,
    });
    await fs.writeJson(frontierFile, {
      v: 1,
      sessionId: 'alpha',
      nextBlockId: 4,
      frontier: [
        { kind: 'block', id: 3, level: 1, rawStartSeq: 1, rawEndSeq: 2 },
        { kind: 'message', seq: 2, preservedFromBlockId: 3 },
      ],
    });

    const result = await runEmbeddedContextFrontierMigration({
      stateDir,
      sessionsDir,
      migrationVersionFile,
      migrationBackupDir,
      readBlocksByIdRange: async () => [blockRecord()],
    });

    assert.equal(result.skippedByVersion, false);
    assert.equal(result.scannedFiles, 1);
    assert.equal(result.migratedFiles, 1);
    assert.equal(result.failedFiles, 0);
    assert.equal(await fs.pathExists(frontierFile), false);

    const migratedSession = await fs.readJson(sessionFile);
    assert.equal(Object.prototype.hasOwnProperty.call(migratedSession, 'contextFrontier'), false);
    assert.equal(migratedSession.nextBlockId, 4);
    assert.equal(migratedSession.history[0].parts[0].text, '[CTX-BLOCK L1 B#3 raw#1-#2] legacy block summary');
    assert.equal(migratedSession.history[1].parts[0].text, 'exact preserved instruction');

    const backupFile = path.join(migrationBackupDir, EMBEDDED_CONTEXT_FRONTIER_MIGRATION_ID, 'sessions', 'alpha.frontier.json');
    assert.equal(await fs.pathExists(backupFile), true);

    const migrationVersion = await fs.readJson(migrationVersionFile);
    assert.equal(migrationVersion.migrations[EMBEDDED_CONTEXT_FRONTIER_MIGRATION_ID].status, 'completed');
    assert.equal(migrationVersion.migrations[EMBEDDED_CONTEXT_FRONTIER_MIGRATION_ID].migratedFiles, 1);

    const secondRun = await runEmbeddedContextFrontierMigration({
      stateDir,
      sessionsDir,
      migrationVersionFile,
      migrationBackupDir,
      readBlocksByIdRange: async () => {
        throw new Error('should not scan after migration version is recorded');
      },
    });
    assert.equal(secondRun.skippedByVersion, true);
    assert.equal(secondRun.scannedFiles, 0);
  });
});

test('frontier migration retires even unmatched legacy frontier because history is authoritative', async () => {
  await withTempDir(async (dirPath) => {
    const stateDir = path.join(dirPath, 'state');
    const sessionsDir = path.join(stateDir, 'sessions');
    const migrationVersionFile = path.join(stateDir, 'migrationVersion.json');
    const migrationBackupDir = path.join(stateDir, 'migration-backup');
    await fs.ensureDir(sessionsDir);

    const sessionFile = path.join(sessionsDir, 'broken.json');
    const frontierFile = path.join(sessionsDir, 'broken.frontier.json');
    await fs.writeJson(sessionFile, {
      history: [{ role: 'user', parts: [{ text: 'wrong seq' }], __meta: { seq: 99 } }],
      persistentMemorySnapshot: 'snapshot',
    });
    await fs.writeJson(frontierFile, {
      v: 1,
      sessionId: 'broken',
      frontier: [{ kind: 'message', seq: 1 }],
    });

    const result = await runEmbeddedContextFrontierMigration({
      stateDir,
      sessionsDir,
      migrationVersionFile,
      migrationBackupDir,
      readBlocksByIdRange: async () => [],
    });

    assert.equal(result.migratedFiles, 1);
    assert.equal(result.failedFiles, 0);
    assert.equal(await fs.pathExists(frontierFile), false);
    const unchangedSession = await fs.readJson(sessionFile);
    assert.equal(unchangedSession.contextFrontier, undefined);

    const migrationVersion = await fs.readJson(migrationVersionFile);
    assert.equal(migrationVersion.migrations[EMBEDDED_CONTEXT_FRONTIER_MIGRATION_ID].status, 'completed');
  });
});
