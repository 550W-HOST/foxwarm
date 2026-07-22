import fs from 'fs-extra';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { createInterface } from 'node:readline';
import { ARCHIVE_DB_PATH, SESSION_LOGS_DIR, getSessionArchiveLogPath, getSessionBlockArchiveLogPath } from '../config';
import { logger } from '../common';
import type { Message } from '../types';
import type { ArchiveMessageRecord } from './archive';
import type { ArchiveBlockRecord } from './layeredContext';
import { loadSessionsMetadataSnapshot } from './metadataStore';

export type ArchiveBranchRecord = {
  sessionId: string;
  parentSessionId?: string;
  forkMessageSeq: number;
  forkBlockId: number;
  createdAt: number;
  updatedAt: number;
};

export type EffectiveArchiveMessageRecord = ArchiveMessageRecord & {
  sourceSessionId: string;
  inherited: boolean;
};

export type EffectiveArchiveBlockRecord = ArchiveBlockRecord & {
  sourceSessionId: string;
  inherited: boolean;
};

export type ArchiveVectorCheckpoint = {
  rawLastIndexedSeq: number;
  rawTailStartSeq: number;
  lastIndexedBlockId: number;
  updatedAt: number;
};

export type ArchiveVectorBackfillCandidate = {
  sessionId: string;
  parentSessionId?: string;
  latestLocalMessageSeq: number;
  latestLocalBlockId: number;
  checkpointRawLastIndexedSeq: number;
  checkpointLastIndexedBlockId: number;
};

type LineageEntry = {
  sessionId: string;
  inherited: boolean;
  maxMessageSeq?: number;
  maxBlockId?: number;
};

let db: DatabaseSync | null = null;
const importedSessions = new Set<string>();
let bootstrapPromise: Promise<void> | null = null;

const ARCHIVE_IMPORT_BATCH_SIZE = Math.max(1, Number(process.env.FOXWARM_ARCHIVE_IMPORT_BATCH_SIZE || 200));
const MISSING_IMPORT_FILE_SIZE = -1;

type ArchiveImportSourceKind = 'messages' | 'blocks';

type ArchiveImportSourceState = {
  exists: boolean;
  size: number;
  mtimeMs: number;
};

type ArchiveImportStateRecord = {
  sessionId: string;
  messagesFileSize: number;
  messagesFileMtimeMs: number;
  blocksFileSize: number;
  blocksFileMtimeMs: number;
  updatedAt: number;
};

function getDb(): DatabaseSync {
  if (!db) {
    throw new Error('Archive store is not initialized.');
  }
  return db;
}

function runInTransaction(fn: () => void): void {
  const database = getDb();
  database.exec('BEGIN');
  try {
    fn();
    database.exec('COMMIT');
  } catch (e) {
    try {
      database.exec('ROLLBACK');
    } catch {}
    throw e;
  }
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
}

function getImportSourcePath(sessionId: string, kind: ArchiveImportSourceKind): string {
  return kind === 'messages'
    ? getSessionArchiveLogPath(sessionId)
    : getSessionBlockArchiveLogPath(sessionId);
}

async function getImportSourceState(filePath: string): Promise<ArchiveImportSourceState> {
  try {
    const stat = await fs.stat(filePath);
    return {
      exists: true,
      size: stat.size,
      mtimeMs: Math.floor(stat.mtimeMs),
    };
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      return {
        exists: false,
        size: MISSING_IMPORT_FILE_SIZE,
        mtimeMs: 0,
      };
    }
    throw err;
  }
}

function getImportStateInternal(sessionId: string): ArchiveImportStateRecord | null {
  const row = getDb().prepare(`
    SELECT session_id, messages_file_size, messages_file_mtime_ms, blocks_file_size, blocks_file_mtime_ms, updated_at
    FROM archive_import_state
    WHERE session_id = ?
  `).get(sessionId) as any;

  if (!row?.session_id) {
    return null;
  }

  return {
    sessionId: String(row.session_id),
    messagesFileSize: Number(row.messages_file_size),
    messagesFileMtimeMs: Number(row.messages_file_mtime_ms),
    blocksFileSize: Number(row.blocks_file_size),
    blocksFileMtimeMs: Number(row.blocks_file_mtime_ms),
    updatedAt: Number(row.updated_at) || 0,
  };
}

function isImportStateCurrent(state: ArchiveImportStateRecord | null, kind: ArchiveImportSourceKind, fileState: ArchiveImportSourceState): boolean {
  if (!state) {
    return false;
  }

  if (kind === 'messages') {
    return state.messagesFileSize === fileState.size && state.messagesFileMtimeMs === fileState.mtimeMs;
  }

  return state.blocksFileSize === fileState.size && state.blocksFileMtimeMs === fileState.mtimeMs;
}

function setImportStateSync(
  sessionId: string,
  next: Partial<Pick<ArchiveImportStateRecord, 'messagesFileSize' | 'messagesFileMtimeMs' | 'blocksFileSize' | 'blocksFileMtimeMs'>>,
): ArchiveImportStateRecord {
  const current = getImportStateInternal(sessionId) || {
    sessionId,
    messagesFileSize: MISSING_IMPORT_FILE_SIZE,
    messagesFileMtimeMs: 0,
    blocksFileSize: MISSING_IMPORT_FILE_SIZE,
    blocksFileMtimeMs: 0,
    updatedAt: 0,
  };

  const merged: ArchiveImportStateRecord = {
    ...current,
    ...next,
    updatedAt: Date.now(),
  };

  getDb().prepare(`
    INSERT INTO archive_import_state (
      session_id, messages_file_size, messages_file_mtime_ms, blocks_file_size, blocks_file_mtime_ms, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      messages_file_size = excluded.messages_file_size,
      messages_file_mtime_ms = excluded.messages_file_mtime_ms,
      blocks_file_size = excluded.blocks_file_size,
      blocks_file_mtime_ms = excluded.blocks_file_mtime_ms,
      updated_at = excluded.updated_at
  `).run(
    merged.sessionId,
    merged.messagesFileSize,
    merged.messagesFileMtimeMs,
    merged.blocksFileSize,
    merged.blocksFileMtimeMs,
    merged.updatedAt,
  );

  return merged;
}

async function refreshImportStateFromFile(sessionId: string, kind: ArchiveImportSourceKind): Promise<void> {
  await initArchiveStore();
  const fileState = await getImportSourceState(getImportSourcePath(sessionId, kind));
  if (kind === 'messages') {
    setImportStateSync(sessionId, {
      messagesFileSize: fileState.size,
      messagesFileMtimeMs: fileState.mtimeMs,
    });
  } else {
    setImportStateSync(sessionId, {
      blocksFileSize: fileState.size,
      blocksFileMtimeMs: fileState.mtimeMs,
    });
  }
}

async function streamJsonlLines(filePath: string, onLine: (line: string) => Promise<void> | void): Promise<void> {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const rawLine of rl) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }
      await onLine(line);
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}

function openArchiveStore(): void {
  if (db) {
    return;
  }

  fs.ensureDirSync(path.dirname(ARCHIVE_DB_PATH));
  db = new DatabaseSync(ARCHIVE_DB_PATH);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS archive_branches (
      session_id TEXT PRIMARY KEY,
      parent_session_id TEXT,
      fork_message_seq INTEGER NOT NULL DEFAULT 0,
      fork_block_id INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_archive_branches_parent ON archive_branches(parent_session_id);

    CREATE TABLE IF NOT EXISTS archive_messages (
      session_id TEXT NOT NULL,
      agent TEXT NOT NULL DEFAULT 'main',
      seq INTEGER NOT NULL,
      timestamp INTEGER NOT NULL,
      role TEXT NOT NULL,
      message_json TEXT NOT NULL,
      PRIMARY KEY (session_id, seq)
    );

    CREATE TABLE IF NOT EXISTS archive_blocks (
      session_id TEXT NOT NULL,
      agent TEXT NOT NULL DEFAULT 'main',
      id INTEGER NOT NULL,
      level INTEGER NOT NULL,
      source_kind TEXT NOT NULL,
      source_start INTEGER NOT NULL,
      source_end INTEGER NOT NULL,
      source_block_ids_json TEXT,
      raw_start_seq INTEGER NOT NULL,
      raw_end_seq INTEGER NOT NULL,
      raw_start_timestamp INTEGER,
      raw_end_timestamp INTEGER,
      summary TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, id)
    );

    CREATE TABLE IF NOT EXISTS archive_checkpoints (
      session_id TEXT PRIMARY KEY,
      raw_last_indexed_seq INTEGER NOT NULL DEFAULT 0,
      raw_tail_start_seq INTEGER NOT NULL DEFAULT 0,
      last_indexed_block_id INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS archive_import_state (
      session_id TEXT PRIMARY KEY,
      messages_file_size INTEGER NOT NULL DEFAULT -1,
      messages_file_mtime_ms INTEGER NOT NULL DEFAULT 0,
      blocks_file_size INTEGER NOT NULL DEFAULT -1,
      blocks_file_mtime_ms INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
  `);
  try {
    db.exec(`ALTER TABLE archive_messages ADD COLUMN agent TEXT NOT NULL DEFAULT 'main'`);
  } catch {}
  try {
    db.exec(`ALTER TABLE archive_blocks ADD COLUMN agent TEXT NOT NULL DEFAULT 'main'`);
  } catch {}
  try {
    db.exec(`ALTER TABLE archive_blocks ADD COLUMN raw_start_timestamp INTEGER`);
  } catch {}
  try {
    db.exec(`ALTER TABLE archive_blocks ADD COLUMN raw_end_timestamp INTEGER`);
  } catch {}
  try {
    db.exec(`ALTER TABLE archive_blocks ADD COLUMN source_block_ids_json TEXT`);
  } catch {}
}

function normalizeBranch(row: any): ArchiveBranchRecord | null {
  if (!row?.session_id) {
    return null;
  }

  return {
    sessionId: String(row.session_id),
    parentSessionId: typeof row.parent_session_id === 'string' && row.parent_session_id.length > 0
      ? row.parent_session_id
      : undefined,
    forkMessageSeq: Number(row.fork_message_seq) || 0,
    forkBlockId: Number(row.fork_block_id) || 0,
    createdAt: Number(row.created_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
  };
}

function parseMessageRecord(line: string): ArchiveMessageRecord | null {
  try {
    const record = JSON.parse(line);
    if (
      record?.kind === 'message'
      && typeof record.sessionId === 'string'
      && typeof record.seq === 'number'
      && record.message
    ) {
      return record as ArchiveMessageRecord;
    }
  } catch (e) {
    logger.warn({ err: e }, 'Skipping malformed archive-store message import line');
  }
  return null;
}

function parseBlockRecord(line: string): ArchiveBlockRecord | null {
  try {
    const record = JSON.parse(line);
    if (record?.kind === 'block' && typeof record.sessionId === 'string' && typeof record.id === 'number') {
      return record as ArchiveBlockRecord;
    }
  } catch (e) {
    logger.warn({ err: e }, 'Skipping malformed archive-store block import line');
  }
  return null;
}

function parseSourceBlockIdsJson(value: unknown): number[] | undefined {
  if (typeof value !== 'string' || !value.trim()) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return undefined;
    }

    const ids = parsed
      .map(id => Number(id))
      .filter(id => Number.isInteger(id) && id > 0);
    return ids.length > 0 ? ids : undefined;
  } catch {
    return undefined;
  }
}

type BootstrapSessionCandidate = {
  sessionId: string;
  parentSessionId?: string;
};

async function collectBootstrapSessionCandidates(): Promise<BootstrapSessionCandidate[]> {
  const candidates = new Map<string, BootstrapSessionCandidate>();

  try {
    const { data } = await loadSessionsMetadataSnapshot();
    const sessionsData = data?.sessions && typeof data.sessions === 'object' ? data.sessions : data;
    if (sessionsData && typeof sessionsData === 'object') {
      for (const [sessionId, sessionMeta] of Object.entries(sessionsData)) {
        if (typeof sessionId !== 'string' || !sessionId.trim()) {
          continue;
        }
        const meta = (sessionMeta && typeof sessionMeta === 'object') ? sessionMeta as Record<string, any> : {};
        candidates.set(sessionId, {
          sessionId,
          parentSessionId: typeof meta.parentSessionId === 'string' && meta.parentSessionId.trim().length > 0
            ? meta.parentSessionId.trim()
            : undefined,
        });
      }
    }
  } catch (e) {
    logger.warn({ err: e }, 'Failed to load session metadata while bootstrapping archive store');
  }

  if (await fs.pathExists(SESSION_LOGS_DIR)) {
    const walk = async (dir: string): Promise<void> => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath);
          continue;
        }

        if (!entry.isFile()) {
          continue;
        }

        let sessionId: string | null = null;
        const relativePath = path.relative(SESSION_LOGS_DIR, fullPath);
        if (entry.name.endsWith('.blocks.jsonl')) {
          sessionId = relativePath.slice(0, -'.blocks.jsonl'.length).split(path.sep).join('/');
        } else if (entry.name.endsWith('.jsonl')) {
          sessionId = relativePath.slice(0, -'.jsonl'.length).split(path.sep).join('/');
        }

        if (!sessionId) {
          continue;
        }

        if (!candidates.has(sessionId)) {
          candidates.set(sessionId, { sessionId });
        }
      }
    };

    await walk(SESSION_LOGS_DIR);
  }

  return [...candidates.values()].sort((a, b) => a.sessionId.localeCompare(b.sessionId));
}

async function inferLegacyForkMessageSeq(sessionId: string, parentSessionId: string): Promise<number> {
  const archivePath = getSessionArchiveLogPath(sessionId);
  const fileState = await getImportSourceState(archivePath);
  if (!fileState.exists) {
    return 0;
  }

  let maxSeq = 0;
  let minLocalSeq = Number.POSITIVE_INFINITY;
  await streamJsonlLines(archivePath, async (line) => {
    const record = parseMessageRecord(line);
    if (record?.sessionId === parentSessionId && record.seq > maxSeq) {
      maxSeq = record.seq;
    }
    if (record?.sessionId === sessionId && record.seq < minLocalSeq) {
      minLocalSeq = record.seq;
    }
  });

  if (maxSeq <= 0 && Number.isFinite(minLocalSeq)) {
    return Math.max(0, minLocalSeq - 1);
  }

  return maxSeq;
}

async function inferLegacyForkBlockId(sessionId: string, parentSessionId: string): Promise<number> {
  const archivePath = getSessionBlockArchiveLogPath(sessionId);
  const fileState = await getImportSourceState(archivePath);
  if (!fileState.exists) {
    return 0;
  }

  let maxId = 0;
  let minLocalId = Number.POSITIVE_INFINITY;
  await streamJsonlLines(archivePath, async (line) => {
    const record = parseBlockRecord(line);
    if (record?.sessionId === parentSessionId && record.id > maxId) {
      maxId = record.id;
    }
    if (record?.sessionId === sessionId && record.id < minLocalId) {
      minLocalId = record.id;
    }
  });

  if (maxId <= 0 && Number.isFinite(minLocalId)) {
    return Math.max(0, minLocalId - 1);
  }

  return maxId;
}

async function bootstrapArchiveStoreFromLegacy(): Promise<void> {
  const candidates = await collectBootstrapSessionCandidates();
  if (candidates.length === 0) {
    return;
  }

  for (const candidate of candidates) {
    const existingBranch = getBranchInternal(candidate.sessionId);
    if (existingBranch) {
      continue;
    }

    if (candidate.parentSessionId) {
      const forkMessageSeq = await inferLegacyForkMessageSeq(candidate.sessionId, candidate.parentSessionId);
      const forkBlockId = await inferLegacyForkBlockId(candidate.sessionId, candidate.parentSessionId);
      await ensureSessionBranch(candidate.sessionId, {
        parentSessionId: candidate.parentSessionId,
        forkMessageSeq,
        forkBlockId,
      });
    } else {
      await ensureSessionBranch(candidate.sessionId);
    }

    await yieldToEventLoop();
  }

  for (const candidate of candidates) {
    await importSessionMessagesFromJsonl(candidate.sessionId);
    await importSessionBlocksFromJsonl(candidate.sessionId);
    importedSessions.add(candidate.sessionId);
    await yieldToEventLoop();
  }
}

async function ensureBootstrapped(): Promise<void> {
  if (!bootstrapPromise) {
    bootstrapPromise = bootstrapArchiveStoreFromLegacy().catch((err) => {
      bootstrapPromise = null;
      throw err;
    });
  }

  await bootstrapPromise;
}

async function importSessionMessagesFromJsonl(sessionId: string): Promise<void> {
  const archivePath = getSessionArchiveLogPath(sessionId);
  const fileState = await getImportSourceState(archivePath);
  const currentState = getImportStateInternal(sessionId);
  if (isImportStateCurrent(currentState, 'messages', fileState)) {
    return;
  }

  if (!fileState.exists || fileState.size === 0) {
    setImportStateSync(sessionId, {
      messagesFileSize: fileState.size,
      messagesFileMtimeMs: fileState.mtimeMs,
    });
    return;
  }

  const database = getDb();
  const insert = database.prepare(`
    INSERT OR IGNORE INTO archive_messages (
      session_id, agent, seq, timestamp, role, message_json
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);

  let batch: ArchiveMessageRecord[] = [];
  const flushBatch = async () => {
    if (batch.length === 0) {
      return;
    }

    const records = batch;
    batch = [];
    runInTransaction(() => {
      for (const record of records) {
        insert.run(
          record.sessionId,
          record.agent || 'main',
          record.seq,
          record.timestamp,
          record.role,
          JSON.stringify(record.message),
        );
      }
    });
    await yieldToEventLoop();
  };

  await streamJsonlLines(archivePath, async (line) => {
    const record = parseMessageRecord(line);
    if (!record) {
      return;
    }

    batch.push(record);
    if (batch.length >= ARCHIVE_IMPORT_BATCH_SIZE) {
      await flushBatch();
    }
  });

  await flushBatch();
  setImportStateSync(sessionId, {
    messagesFileSize: fileState.size,
    messagesFileMtimeMs: fileState.mtimeMs,
  });
}

async function importSessionBlocksFromJsonl(sessionId: string): Promise<void> {
  const archivePath = getSessionBlockArchiveLogPath(sessionId);
  const fileState = await getImportSourceState(archivePath);
  const currentState = getImportStateInternal(sessionId);
  if (isImportStateCurrent(currentState, 'blocks', fileState)) {
    return;
  }

  if (!fileState.exists || fileState.size === 0) {
    setImportStateSync(sessionId, {
      blocksFileSize: fileState.size,
      blocksFileMtimeMs: fileState.mtimeMs,
    });
    return;
  }

  const database = getDb();
  const insert = database.prepare(`
    INSERT OR IGNORE INTO archive_blocks (
      session_id, agent, id, level, source_kind, source_start, source_end, source_block_ids_json,
      raw_start_seq, raw_end_seq, raw_start_timestamp, raw_end_timestamp, summary, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let batch: ArchiveBlockRecord[] = [];
  const flushBatch = async () => {
    if (batch.length === 0) {
      return;
    }

    const records = batch;
    batch = [];
    runInTransaction(() => {
      for (const record of records) {
        insert.run(
          record.sessionId,
          record.agent || 'main',
          record.id,
          record.level,
          record.sourceKind,
          record.sourceStart,
          record.sourceEnd,
          record.sourceKind === 'block' && Array.isArray(record.sourceBlockIds) && record.sourceBlockIds.length > 0 ? JSON.stringify(record.sourceBlockIds) : null,
          record.rawStartSeq,
          record.rawEndSeq,
          record.rawStartTimestamp ?? null,
          record.rawEndTimestamp ?? null,
          record.summary,
          record.createdAt,
        );
      }
    });
    await yieldToEventLoop();
  };

  await streamJsonlLines(archivePath, async (line) => {
    const record = parseBlockRecord(line);
    if (!record) {
      return;
    }

    batch.push(record);
    if (batch.length >= ARCHIVE_IMPORT_BATCH_SIZE) {
      await flushBatch();
    }
  });

  await flushBatch();
  setImportStateSync(sessionId, {
    blocksFileSize: fileState.size,
    blocksFileMtimeMs: fileState.mtimeMs,
  });
}

async function ensureImported(sessionId: string): Promise<void> {
  if (!sessionId || importedSessions.has(sessionId)) {
    return;
  }

  await ensureSessionBranch(sessionId);
  await importSessionMessagesFromJsonl(sessionId);
  await importSessionBlocksFromJsonl(sessionId);
  importedSessions.add(sessionId);
}

function getBranchInternal(sessionId: string): ArchiveBranchRecord | null {
  const row = getDb().prepare(`
    SELECT session_id, parent_session_id, fork_message_seq, fork_block_id, created_at, updated_at
    FROM archive_branches
    WHERE session_id = ?
  `).get(sessionId);
  return normalizeBranch(row);
}

function buildLineage(sessionId: string): LineageEntry[] {
  const lineage: LineageEntry[] = [];
  let currentSessionId: string | undefined = sessionId;
  let currentMaxMessageSeq: number | undefined = undefined;
  let currentMaxBlockId: number | undefined = undefined;
  let inherited = false;
  const seen = new Set<string>();

  while (currentSessionId && !seen.has(currentSessionId)) {
    seen.add(currentSessionId);
    lineage.push({
      sessionId: currentSessionId,
      inherited,
      maxMessageSeq: currentMaxMessageSeq,
      maxBlockId: currentMaxBlockId,
    });

    const branch = getBranchInternal(currentSessionId);
    if (!branch?.parentSessionId) {
      break;
    }

    currentSessionId = branch.parentSessionId;
    currentMaxMessageSeq = typeof currentMaxMessageSeq === 'number'
      ? Math.min(currentMaxMessageSeq, branch.forkMessageSeq)
      : branch.forkMessageSeq;
    currentMaxBlockId = typeof currentMaxBlockId === 'number'
      ? Math.min(currentMaxBlockId, branch.forkBlockId)
      : branch.forkBlockId;
    inherited = true;

    if ((currentMaxMessageSeq || 0) <= 0 && (currentMaxBlockId || 0) <= 0) {
      break;
    }
  }

  return lineage;
}

export async function initArchiveStore(): Promise<void> {
  openArchiveStore();
  await ensureBootstrapped();
}

export function initArchiveStoreSync(): void {
  openArchiveStore();
}

/**
 * Return whether a session id has ever been registered in the durable archive.
 *
 * Deleted live sessions intentionally keep their append-only archive records.
 * Callers that allocate new session ids must therefore treat an archived id as
 * reserved even when it no longer exists in sessions.json or state/sessions/.
 */
export async function hasArchivedSessionId(sessionId: string): Promise<boolean> {
  const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!normalizedSessionId) {
    return false;
  }

  await initArchiveStore();
  return getBranchInternal(normalizedSessionId) !== null;
}

export async function ensureSessionBranch(
  sessionId: string,
  options: {
    parentSessionId?: string;
    forkMessageSeq?: number;
    forkBlockId?: number;
    createdAt?: number;
  } = {},
): Promise<ArchiveBranchRecord> {
  openArchiveStore();
  const now = options.createdAt || Date.now();
  getDb().prepare(`
    INSERT OR IGNORE INTO archive_branches (
      session_id, parent_session_id, fork_message_seq, fork_block_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    sessionId,
    options.parentSessionId || null,
    options.parentSessionId ? (options.forkMessageSeq || 0) : 0,
    options.parentSessionId ? (options.forkBlockId || 0) : 0,
    now,
    now,
  );

  if (options.parentSessionId) {
    getDb().prepare(`
      INSERT OR IGNORE INTO archive_checkpoints (
        session_id, raw_last_indexed_seq, raw_tail_start_seq, last_indexed_block_id, updated_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      sessionId,
      options.forkMessageSeq || 0,
      (options.forkMessageSeq || 0) > 0 ? (options.forkMessageSeq || 0) + 1 : 0,
      options.forkBlockId || 0,
      now,
    );
  }

  return getBranchInternal(sessionId) || {
    sessionId,
    parentSessionId: options.parentSessionId,
    forkMessageSeq: options.forkMessageSeq || 0,
    forkBlockId: options.forkBlockId || 0,
    createdAt: now,
    updatedAt: now,
  };
}

export async function getSessionBranch(sessionId: string): Promise<ArchiveBranchRecord | null> {
  await initArchiveStore();
  await ensureImported(sessionId);
  return getBranchInternal(sessionId);
}

export async function writeArchiveMessages(records: ArchiveMessageRecord[]): Promise<void> {
  if (records.length === 0) {
    return;
  }

  await initArchiveStore();
  await ensureSessionBranch(records[0].sessionId);
  const database = getDb();
  const insert = database.prepare(`
    INSERT OR REPLACE INTO archive_messages (
      session_id, agent, seq, timestamp, role, message_json
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  runInTransaction(() => {
    for (const record of records) {
      insert.run(
        record.sessionId,
        record.agent || 'main',
        record.seq,
        record.timestamp,
        record.role,
        JSON.stringify(record.message),
      );
    }
  });
  importedSessions.add(records[0].sessionId);
}

export async function refreshSessionArchiveImportState(sessionId: string, kind: ArchiveImportSourceKind): Promise<void> {
  await refreshImportStateFromFile(sessionId, kind);
}

export async function writeArchiveBlocks(records: ArchiveBlockRecord[]): Promise<void> {
  if (records.length === 0) {
    return;
  }

  await initArchiveStore();
  await ensureSessionBranch(records[0].sessionId);
  const database = getDb();
  const insert = database.prepare(`
    INSERT OR REPLACE INTO archive_blocks (
      session_id, agent, id, level, source_kind, source_start, source_end, source_block_ids_json,
      raw_start_seq, raw_end_seq, raw_start_timestamp, raw_end_timestamp, summary, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  runInTransaction(() => {
    for (const record of records) {
      insert.run(
        record.sessionId,
        record.agent || 'main',
        record.id,
        record.level,
        record.sourceKind,
        record.sourceStart,
        record.sourceEnd,
        record.sourceKind === 'block' && Array.isArray(record.sourceBlockIds) && record.sourceBlockIds.length > 0 ? JSON.stringify(record.sourceBlockIds) : null,
        record.rawStartSeq,
        record.rawEndSeq,
        record.rawStartTimestamp ?? null,
        record.rawEndTimestamp ?? null,
        record.summary,
        record.createdAt,
      );
    }
  });
  importedSessions.add(records[0].sessionId);
}

export async function readLocalArchiveMessages(sessionId: string, startSeq?: number, endSeq?: number): Promise<ArchiveMessageRecord[]> {
  await initArchiveStore();
  await ensureImported(sessionId);

  const rows = getDb().prepare(`
    SELECT agent, seq, timestamp, role, message_json
    FROM archive_messages
    WHERE session_id = ?
      AND (? IS NULL OR seq >= ?)
      AND (? IS NULL OR seq <= ?)
    ORDER BY seq ASC
  `).all(sessionId, startSeq ?? null, startSeq ?? null, endSeq ?? null, endSeq ?? null) as any[];

  return rows.map(row => ({
    v: 1,
    kind: 'message' as const,
    sessionId,
      agent: row.agent || 'main',
    seq: Number(row.seq),
    timestamp: Number(row.timestamp),
    role: row.role,
    message: JSON.parse(row.message_json) as Message,
  }));
}

export async function readEffectiveArchiveMessages(sessionId: string, startSeq?: number, endSeq?: number): Promise<EffectiveArchiveMessageRecord[]> {
  await initArchiveStore();
  await ensureImported(sessionId);

  const lineage = buildLineage(sessionId);
  const results: EffectiveArchiveMessageRecord[] = [];

  for (const entry of lineage) {
    await ensureImported(entry.sessionId);
    const effectiveStart = typeof startSeq === 'number' ? startSeq : undefined;
    const cappedEnd = typeof entry.maxMessageSeq === 'number'
      ? (typeof endSeq === 'number' ? Math.min(endSeq, entry.maxMessageSeq) : entry.maxMessageSeq)
      : endSeq;

    if (typeof entry.maxMessageSeq === 'number' && entry.maxMessageSeq <= 0) {
      continue;
    }
    if (typeof effectiveStart === 'number' && typeof cappedEnd === 'number' && effectiveStart > cappedEnd) {
      continue;
    }

    const local = await readLocalArchiveMessages(entry.sessionId, effectiveStart, cappedEnd);
    results.push(...local.map(record => ({
      ...record,
      sourceSessionId: entry.sessionId,
      inherited: entry.inherited,
    })));
  }

  return results.sort((a, b) => a.seq - b.seq || Number(a.timestamp) - Number(b.timestamp));
}

export async function readLocalArchiveBlocks(sessionId: string, startId?: number, endId?: number): Promise<ArchiveBlockRecord[]> {
  await initArchiveStore();
  await ensureImported(sessionId);

  const rows = getDb().prepare(`
    SELECT agent, id, level, source_kind, source_start, source_end, source_block_ids_json, raw_start_seq, raw_end_seq, raw_start_timestamp, raw_end_timestamp, summary, created_at
    FROM archive_blocks
    WHERE session_id = ?
      AND (? IS NULL OR id >= ?)
      AND (? IS NULL OR id <= ?)
    ORDER BY id ASC
  `).all(sessionId, startId ?? null, startId ?? null, endId ?? null, endId ?? null) as any[];

  return rows.map(row => ({
    v: 1,
    kind: 'block' as const,
    sessionId,
      agent: row.agent || 'main',
    id: Number(row.id),
    level: Number(row.level),
    sourceKind: row.source_kind,
    sourceStart: Number(row.source_start),
    sourceEnd: Number(row.source_end),
    sourceBlockIds: parseSourceBlockIdsJson(row.source_block_ids_json),
    rawStartSeq: Number(row.raw_start_seq),
    rawEndSeq: Number(row.raw_end_seq),
    rawStartTimestamp: row.raw_start_timestamp == null ? undefined : Number(row.raw_start_timestamp),
    rawEndTimestamp: row.raw_end_timestamp == null ? undefined : Number(row.raw_end_timestamp),
    summary: String(row.summary || ''),
    createdAt: Number(row.created_at),
  }));
}

export async function readEffectiveArchiveBlocks(sessionId: string, startId?: number, endId?: number): Promise<EffectiveArchiveBlockRecord[]> {
  await initArchiveStore();
  await ensureImported(sessionId);

  const lineage = buildLineage(sessionId);
  const results: EffectiveArchiveBlockRecord[] = [];

  for (const entry of lineage) {
    await ensureImported(entry.sessionId);
    const effectiveStart = typeof startId === 'number' ? startId : undefined;
    const cappedEnd = typeof entry.maxBlockId === 'number'
      ? (typeof endId === 'number' ? Math.min(endId, entry.maxBlockId) : entry.maxBlockId)
      : endId;

    if (typeof entry.maxBlockId === 'number' && entry.maxBlockId <= 0) {
      continue;
    }
    if (typeof effectiveStart === 'number' && typeof cappedEnd === 'number' && effectiveStart > cappedEnd) {
      continue;
    }

    const local = await readLocalArchiveBlocks(entry.sessionId, effectiveStart, cappedEnd);
    results.push(...local.map(record => ({
      ...record,
      sourceSessionId: entry.sessionId,
      inherited: entry.inherited,
    })));
  }

  return results.sort((a, b) => a.id - b.id || Number(a.createdAt) - Number(b.createdAt));
}

export async function getVectorCheckpoint(sessionId: string): Promise<ArchiveVectorCheckpoint> {
  initArchiveStoreSync();
  const row = getDb().prepare(`
    SELECT raw_last_indexed_seq, raw_tail_start_seq, last_indexed_block_id, updated_at
    FROM archive_checkpoints
    WHERE session_id = ?
  `).get(sessionId) as any;

  return {
    rawLastIndexedSeq: Number(row?.raw_last_indexed_seq) || 0,
    rawTailStartSeq: Number(row?.raw_tail_start_seq) || 0,
    lastIndexedBlockId: Number(row?.last_indexed_block_id) || 0,
    updatedAt: Number(row?.updated_at) || 0,
  };
}

export function getVectorCheckpointSync(sessionId: string): ArchiveVectorCheckpoint {
  initArchiveStoreSync();
  const row = getDb().prepare(`
    SELECT raw_last_indexed_seq, raw_tail_start_seq, last_indexed_block_id, updated_at
    FROM archive_checkpoints
    WHERE session_id = ?
  `).get(sessionId) as any;

  return {
    rawLastIndexedSeq: Number(row?.raw_last_indexed_seq) || 0,
    rawTailStartSeq: Number(row?.raw_tail_start_seq) || 0,
    lastIndexedBlockId: Number(row?.last_indexed_block_id) || 0,
    updatedAt: Number(row?.updated_at) || 0,
  };
}

export function setVectorCheckpointSync(
  sessionId: string,
  checkpoint: Partial<Pick<ArchiveVectorCheckpoint, 'rawLastIndexedSeq' | 'rawTailStartSeq' | 'lastIndexedBlockId'>>,
): ArchiveVectorCheckpoint {
  const current = getVectorCheckpointSync(sessionId);
  const next: ArchiveVectorCheckpoint = {
    rawLastIndexedSeq: checkpoint.rawLastIndexedSeq ?? current.rawLastIndexedSeq,
    rawTailStartSeq: checkpoint.rawTailStartSeq ?? current.rawTailStartSeq,
    lastIndexedBlockId: checkpoint.lastIndexedBlockId ?? current.lastIndexedBlockId,
    updatedAt: Date.now(),
  };

  getDb().prepare(`
    INSERT INTO archive_checkpoints (
      session_id, raw_last_indexed_seq, raw_tail_start_seq, last_indexed_block_id, updated_at
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      raw_last_indexed_seq = excluded.raw_last_indexed_seq,
      raw_tail_start_seq = excluded.raw_tail_start_seq,
      last_indexed_block_id = excluded.last_indexed_block_id,
      updated_at = excluded.updated_at
  `).run(sessionId, next.rawLastIndexedSeq, next.rawTailStartSeq, next.lastIndexedBlockId, next.updatedAt);

  return next;
}

export async function renameSessionArchiveStore(oldSessionId: string, newSessionId: string): Promise<void> {
  await initArchiveStore();
  const database = getDb();
  runInTransaction(() => {
    database.prepare(`UPDATE archive_branches SET session_id = ?, updated_at = ? WHERE session_id = ?`).run(newSessionId, Date.now(), oldSessionId);
    database.prepare(`UPDATE archive_branches SET parent_session_id = ? WHERE parent_session_id = ?`).run(newSessionId, oldSessionId);
    database.prepare(`UPDATE archive_messages SET session_id = ? WHERE session_id = ?`).run(newSessionId, oldSessionId);
    database.prepare(`UPDATE archive_blocks SET session_id = ? WHERE session_id = ?`).run(newSessionId, oldSessionId);
    database.prepare(`UPDATE archive_checkpoints SET session_id = ? WHERE session_id = ?`).run(newSessionId, oldSessionId);
    database.prepare(`UPDATE archive_import_state SET session_id = ?, updated_at = ? WHERE session_id = ?`).run(newSessionId, Date.now(), oldSessionId);
  });

  if (importedSessions.delete(oldSessionId)) {
    importedSessions.add(newSessionId);
  }
}

export async function getVectorSearchLineage(sessionId: string): Promise<LineageEntry[]> {
  await initArchiveStore();
  await ensureImported(sessionId);
  return buildLineage(sessionId);
}

export async function listSessionsNeedingVectorBackfill(): Promise<ArchiveVectorBackfillCandidate[]> {
  await initArchiveStore();

  const rows = getDb().prepare(`
    WITH message_max AS (
      SELECT session_id, MAX(seq) AS latest_local_message_seq
      FROM archive_messages
      GROUP BY session_id
    ),
    block_max AS (
      SELECT session_id, MAX(id) AS latest_local_block_id
      FROM archive_blocks
      GROUP BY session_id
    )
    SELECT
      b.session_id,
      b.parent_session_id,
      COALESCE(m.latest_local_message_seq, 0) AS latest_local_message_seq,
      COALESCE(bl.latest_local_block_id, 0) AS latest_local_block_id,
      COALESCE(c.raw_last_indexed_seq, 0) AS checkpoint_raw_last_indexed_seq,
      COALESCE(c.last_indexed_block_id, 0) AS checkpoint_last_indexed_block_id
    FROM archive_branches b
    LEFT JOIN message_max m ON m.session_id = b.session_id
    LEFT JOIN block_max bl ON bl.session_id = b.session_id
    LEFT JOIN archive_checkpoints c ON c.session_id = b.session_id
    WHERE COALESCE(m.latest_local_message_seq, 0) > COALESCE(c.raw_last_indexed_seq, 0)
       OR COALESCE(bl.latest_local_block_id, 0) > COALESCE(c.last_indexed_block_id, 0)
  `).all() as any[];

  const candidates = rows.map((row): ArchiveVectorBackfillCandidate => ({
    sessionId: String(row.session_id),
    parentSessionId: typeof row.parent_session_id === 'string' && row.parent_session_id.length > 0
      ? row.parent_session_id
      : undefined,
    latestLocalMessageSeq: Number(row.latest_local_message_seq) || 0,
    latestLocalBlockId: Number(row.latest_local_block_id) || 0,
    checkpointRawLastIndexedSeq: Number(row.checkpoint_raw_last_indexed_seq) || 0,
    checkpointLastIndexedBlockId: Number(row.checkpoint_last_indexed_block_id) || 0,
  }));

  const candidateById = new Map(candidates.map(candidate => [candidate.sessionId, candidate]));
  const depthCache = new Map<string, number>();
  const getDepth = (sessionId: string): number => {
    if (depthCache.has(sessionId)) {
      return depthCache.get(sessionId)!;
    }

    const candidate = candidateById.get(sessionId);
    if (!candidate?.parentSessionId || !candidateById.has(candidate.parentSessionId)) {
      depthCache.set(sessionId, 0);
      return 0;
    }

    const depth = getDepth(candidate.parentSessionId) + 1;
    depthCache.set(sessionId, depth);
    return depth;
  };

  return candidates.sort((a, b) => {
    const depthDelta = getDepth(a.sessionId) - getDepth(b.sessionId);
    if (depthDelta !== 0) {
      return depthDelta;
    }
    return a.sessionId.localeCompare(b.sessionId);
  });
}
