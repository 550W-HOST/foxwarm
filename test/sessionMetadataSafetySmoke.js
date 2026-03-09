const assert = require('assert');
const fs = require('fs-extra');
const path = require('path');
const sessionManager = require(path.join(__dirname, '..', 'lib', 'sessionManager'));
const { SESSIONS_DIR, SESSIONS_FILE, CHANNELS_FILE } = require(path.join(__dirname, '..', 'lib', 'config'));

const BACKUP_SUFFIXES = ['', '.bak', '.1.bak', '.2.bak', '.3.bak', '.4.bak', '.5.bak'];

function sessionFilePath(sessionId) {
  return path.join(SESSIONS_DIR, `${sessionId}.json`);
}

async function backupMetadataFiles() {
  const backups = [];
  for (const suffix of BACKUP_SUFFIXES) {
    const target = `${SESSIONS_FILE}${suffix}`;
    if (await fs.pathExists(target)) {
      const backup = `${target}.session-metadata-safety-backup`;
      await fs.copy(target, backup, { overwrite: true });
      backups.push([target, backup]);
    }
  }
  return backups;
}

async function restoreMetadataFiles(backups) {
  for (const suffix of BACKUP_SUFFIXES) {
    const target = `${SESSIONS_FILE}${suffix}`;
    await fs.remove(target).catch(() => {});
  }
  for (const [target, backup] of backups) {
    await fs.move(backup, target, { overwrite: true });
  }
}


async function backupChannelsFile() {
  if (!await fs.pathExists(CHANNELS_FILE)) return null;
  const backup = `${CHANNELS_FILE}.session-metadata-safety-backup`;
  await fs.copy(CHANNELS_FILE, backup, { overwrite: true });
  return backup;
}

async function restoreChannelsFile(backup) {
  await fs.remove(CHANNELS_FILE).catch(() => {});
  if (backup) {
    await fs.move(backup, CHANNELS_FILE, { overwrite: true });
  }
}

async function clearMetadataFiles() {
  for (const suffix of BACKUP_SUFFIXES) {
    await fs.remove(`${SESSIONS_FILE}${suffix}`).catch(() => {});
  }
}

async function clearSessionManagerState() {
  sessionManager.getAllSessions().clear();
  sessionManager.getAllAttachments().clear();
}

function makeHistory(textBase, startTs, seqStart) {
  return [
    { role: 'user', parts: [{ text: `${textBase} user` }], __meta: { timestamp: startTs, seq: seqStart } },
    { role: 'model', parts: [{ text: `${textBase} model` }], __meta: { timestamp: startTs + 1, seq: seqStart + 1 } },
  ];
}

async function writeHistorySession(sessionId, label, startTs, seqStart) {
  const filePath = sessionFilePath(sessionId);
  await fs.ensureDir(path.dirname(filePath));
  await fs.writeJson(filePath, {
    history: makeHistory(label, startTs, seqStart),
    queue: [],
    persistentMemorySnapshot: '',
    currentNode: 'master',
    agent: 'alphabot-dev',
    busy: false,
    nextMessageSeq: seqStart + 2,
    displayName: label,
  }, { spaces: 2 });
}

function makeMetadata(sessionId, lastMessageTime, messageCount, nextMessageSeq, displayName) {
  return {
    id: sessionId,
    busy: false,
    meta: { lastMessageTime, messageCount },
    stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
    queue: [],
    agent: 'alphabot-dev',
    currentNode: 'master',
    nextMessageSeq,
    historyVersion: 0,
    displayName,
  };
}

(async () => {
  const prefix = `alphabot-dev/zz_meta_safety_${Date.now()}`;
  const sessionA = `${prefix}_a`;
  const sessionB = `${prefix}_b`;
  const createdFiles = [sessionFilePath(sessionA), sessionFilePath(sessionB)];
  const metadataBackups = await backupMetadataFiles();
  const channelsBackup = await backupChannelsFile();

  try {
    await fs.writeJson(CHANNELS_FILE, { channels: {} }, { spaces: 2 });
    await writeHistorySession(sessionA, 'meta-safe-a', 1000, 1);
    await writeHistorySession(sessionB, 'meta-safe-b', 2000, 10);

    const goodMetadata = {
      sessions: {
        [sessionA]: makeMetadata(sessionA, 1001, 2, 3, 'meta-safe-a'),
        [sessionB]: makeMetadata(sessionB, 2001, 2, 12, 'meta-safe-b'),
      }
    };

    // Case 1: saveSessionsMetadata preserves metadata for sessions missing from in-memory map
    await clearMetadataFiles();
    await fs.writeJson(SESSIONS_FILE, goodMetadata, { spaces: 2 });
    await clearSessionManagerState();
    await sessionManager.loadSessions();
    const loaded = sessionManager.getAllSessions();
    assert(loaded.has(sessionA) && loaded.has(sessionB), 'loadSessions should load both sessions from metadata');
    loaded.delete(sessionB);
    await sessionManager.saveSessionsMetadata();
    const afterPreserve = await fs.readJson(SESSIONS_FILE);
    assert(afterPreserve.sessions[sessionA], 'session A metadata should remain after save');
    assert(afterPreserve.sessions[sessionB], 'session B metadata should be preserved from baseline/history file');

    // Case 2: loadSessions recovers from backup when sessions.json is missing/corrupt
    await clearMetadataFiles();
    await fs.writeJson(`${SESSIONS_FILE}.1.bak`, goodMetadata, { spaces: 2 });
    await fs.writeFile(SESSIONS_FILE, '{not-json');
    await clearSessionManagerState();
    await sessionManager.loadSessions();
    const recoveredFromBackup = sessionManager.getAllSessions();
    assert(recoveredFromBackup.has(sessionA) && recoveredFromBackup.has(sessionB), 'loadSessions should recover from metadata backup');
    const rewrittenFromBackup = await fs.readJson(SESSIONS_FILE);
    assert(rewrittenFromBackup.sessions[sessionA], 'sessions.json should be rewritten from backup recovery');

    // Case 3: loadSessions rebuilds from session history files when metadata files are gone
    await clearMetadataFiles();
    await clearSessionManagerState();
    await sessionManager.loadSessions();
    const rebuilt = sessionManager.getAllSessions();
    assert(rebuilt.has(sessionA) && rebuilt.has(sessionB), 'loadSessions should rebuild metadata from session history files');
    const rebuiltMetadata = await fs.readJson(SESSIONS_FILE);
    assert(rebuiltMetadata.sessions[sessionA], 'rebuilt sessions.json should contain session A');
    assert(rebuiltMetadata.sessions[sessionB], 'rebuilt sessions.json should contain session B');

    console.log('sessionMetadataSafetySmoke: ok');
  } finally {
    await clearSessionManagerState();
    for (const filePath of createdFiles) {
      await fs.remove(filePath).catch(() => {});
    }
    await restoreMetadataFiles(metadataBackups);
    await restoreChannelsFile(channelsBackup);
  }
})().catch(err => {
  console.error(err);
  process.exit(1);
});
