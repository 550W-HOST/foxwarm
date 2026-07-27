import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import fs from 'fs-extra';
import {
  LEGACY_UNDATED_EXEC_ARTIFACT_MIGRATION_ID,
  runLegacyUndatedExecArtifactMigration,
} from './legacyUndatedExecArtifacts';

const execFileAsync = promisify(execFile);
const NOW = new Date(2026, 6, 27, 12, 0, 0, 0);
const OLD = new Date(2026, 6, 25, 23, 59, 59, 999);
const RECENT = new Date(2026, 6, 26, 0, 0, 0, 0);

async function withTempDir(run: (dirPath: string) => Promise<void>): Promise<void> {
  const dirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-legacy-exec-migration-'));
  try {
    await run(dirPath);
  } finally {
    await fs.remove(dirPath).catch(() => {});
  }
}

function paths(root: string) {
  const stateDir = path.join(root, 'state');
  return {
    agentsDir: path.join(root, 'agents'),
    migrationVersionFile: path.join(stateDir, 'migrationVersion.json'),
  };
}

async function writeArtifact(agentsDir: string, agentName: string, fileName: string, mtime: Date = OLD): Promise<string> {
  const filePath = path.join(agentsDir, agentName, '.temp', 'exec', fileName);
  await fs.ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, `contents for ${fileName}\n`);
  await fs.utimes(filePath, mtime, mtime);
  return filePath;
}

async function listArchive(archivePath: string): Promise<string[]> {
  const { stdout } = await execFileAsync('tar', ['-tzf', archivePath]);
  return stdout.trim().split('\n').filter(Boolean);
}

test('legacy undated exec migration archives eligible artifacts, removes sources, and skips after completion', async () => {
  await withTempDir(async (root) => {
    const { agentsDir, migrationVersionFile } = paths(root);
    const artifactName = 'exec_1750000000000_deadbeef.command.sh';
    const artifactPath = await writeArtifact(agentsDir, 'alpha', artifactName);
    const archivesDir = path.join(path.dirname(artifactPath), 'archives');
    const ordinaryArchive = path.join(archivesDir, '2026-07-25.tar.gz');
    await fs.ensureDir(archivesDir);
    await fs.writeFile(ordinaryArchive, 'ordinary archive must remain separate');

    const result = await runLegacyUndatedExecArtifactMigration({ agentsDir, migrationVersionFile, now: NOW });
    assert.equal(result.migratedFiles, 1);
    assert.equal(result.remainingFiles, 0);
    assert.equal(await fs.pathExists(artifactPath), false);
    assert.equal(result.archiveRoots.length, 1);

    const archives = await fs.readdir(result.archiveRoots[0]);
    const migrationArchive = archives.find(name => /legacy-undated-exec-artifacts\.tar\.gz$/.test(name));
    assert.ok(migrationArchive);
    assert.match(migrationArchive, /^2026-07-27-120000000-legacy-undated-exec-artifacts\.tar\.gz$/);
    assert.deepEqual(await listArchive(path.join(result.archiveRoots[0], migrationArchive)), [artifactName]);
    assert.equal(await fs.readFile(ordinaryArchive, 'utf8'), 'ordinary archive must remain separate');

    const version = await fs.readJson(migrationVersionFile);
    assert.equal(version.migrations[LEGACY_UNDATED_EXEC_ARTIFACT_MIGRATION_ID].status, 'completed');

    const laterArtifact = await writeArtifact(agentsDir, 'alpha', 'exec_1750000000001_deadbeef.paths.json');
    const skipped = await runLegacyUndatedExecArtifactMigration({ agentsDir, migrationVersionFile, now: NOW });
    assert.equal(skipped.skippedByVersion, true);
    assert.equal(skipped.scannedFiles, 0);
    assert.equal(await fs.pathExists(laterArtifact), true);
  });
});

test('legacy undated exec migration defers files through the local-yesterday cutoff and completes after a later start', async () => {
  await withTempDir(async (root) => {
    const { agentsDir, migrationVersionFile } = paths(root);
    const oldArtifact = await writeArtifact(agentsDir, 'alpha', 'exec_1750000000000_deadbeef.command.sh', OLD);
    const recentArtifact = await writeArtifact(agentsDir, 'alpha', 'exec_1750000000001_deadbeef.paths.json', RECENT);

    const first = await runLegacyUndatedExecArtifactMigration({ agentsDir, migrationVersionFile, now: NOW });
    assert.equal(first.migratedFiles, 1);
    assert.equal(first.deferredFiles, 1);
    assert.equal(first.remainingFiles, 1);
    assert.equal(await fs.pathExists(oldArtifact), false);
    assert.equal(await fs.pathExists(recentArtifact), true);
    assert.equal(await fs.pathExists(migrationVersionFile), false);

    await fs.utimes(recentArtifact, OLD, OLD);
    const second = await runLegacyUndatedExecArtifactMigration({ agentsDir, migrationVersionFile, now: NOW });
    assert.equal(second.skippedByVersion, false);
    assert.equal(second.migratedFiles, 1);
    assert.equal(second.remainingFiles, 0);
    assert.equal(await fs.pathExists(recentArtifact), false);
    assert.equal((await fs.readJson(migrationVersionFile)).migrations[LEGACY_UNDATED_EXEC_ARTIFACT_MIGRATION_ID].status, 'completed');
  });
});

test('legacy undated exec migration leaves sources and its version entry absent when archival fails, then retries', async () => {
  await withTempDir(async (root) => {
    const { agentsDir, migrationVersionFile } = paths(root);
    const artifactPath = await writeArtifact(agentsDir, 'alpha', 'exec_1750000000000_deadbeef.command.sh');

    const failed = await runLegacyUndatedExecArtifactMigration({
      agentsDir,
      migrationVersionFile,
      now: NOW,
      archiveFiles: async () => { throw new Error('simulated archive failure'); },
    });
    assert.equal(failed.migratedFiles, 0);
    assert.equal(failed.failedFiles, 1);
    assert.equal(failed.remainingFiles, 1);
    assert.equal(await fs.pathExists(artifactPath), true);
    assert.equal(await fs.pathExists(migrationVersionFile), false);

    const retried = await runLegacyUndatedExecArtifactMigration({ agentsDir, migrationVersionFile, now: NOW });
    assert.equal(retried.migratedFiles, 1);
    assert.equal(retried.remainingFiles, 0);
    assert.equal(await fs.pathExists(artifactPath), false);
    assert.equal((await fs.readJson(migrationVersionFile)).migrations[LEGACY_UNDATED_EXEC_ARTIFACT_MIGRATION_ID].status, 'completed');
  });
});

test('legacy undated exec migration only selects strict known top-level artifact names', async () => {
  await withTempDir(async (root) => {
    const { agentsDir, migrationVersionFile } = paths(root);
    const valid = await writeArtifact(agentsDir, 'alpha', 'exec_1750000000000_deadbeef.user.ps1');
    const invalidNames = [
      'exec_1750000000000_deadbeef.command.bat',
      'exec_1750000000000_not-hex.command.sh',
      'exec_1750000000000_deadbeef.log',
      'unrelated.command.sh',
    ];
    const invalidPaths = await Promise.all(invalidNames.map(name => writeArtifact(agentsDir, 'alpha', name)));

    const result = await runLegacyUndatedExecArtifactMigration({ agentsDir, migrationVersionFile, now: NOW });
    assert.equal(result.scannedFiles, 1);
    assert.equal(result.migratedFiles, 1);
    assert.equal(await fs.pathExists(valid), false);
    for (const invalidPath of invalidPaths) assert.equal(await fs.pathExists(invalidPath), true);
    assert.equal((await fs.readJson(migrationVersionFile)).migrations[LEGACY_UNDATED_EXEC_ARTIFACT_MIGRATION_ID].status, 'completed');
  });
});
