import fs from 'fs-extra';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { ARCHIVE_DB_PATH, getSessionArchiveLogPath, getSessionBlockArchiveLogPath } from '../config';
import { logger } from '../common';
import type { Message } from '../types';
import type { ArchiveMessageRecord } from './archive';
import type { ArchiveBlockRecord } from './layeredContext';

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

type LineageEntry = {
  sessionId: string;
  inherited: boolean;
  maxMessageSeq?: number;
  maxBlockId?: number;
};

let db: DatabaseSync | null = null;
const importedSessions = new Set<string>();

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
      raw_start_seq INTEGER NOT NULL,
      raw_end_seq INTEGER NOT NULL,
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
  `);
  try {
    db.exec(`ALTER TABLE archive_messages ADD COLUMN agent TEXT NOT NULL DEFAULT 'main'`);
  } catch {}
  try {
    db.exec(`ALTER TABLE archive_blocks ADD COLUMN agent TEXT NOT NULL DEFAULT 'main'`);
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

async function importSessionMessagesFromJsonl(sessionId: string): Promise<void> {
  const archivePath = getSessionArchiveLogPath(sessionId);
  if (!await fs.pathExists(archivePath)) {
    return;
  }

  const raw = await fs.readFile(archivePath, 'utf8');
  const lines = raw.split('\n').map(line => line.trim()).filter(Boolean);
  if (lines.length === 0) {
    return;
  }

  const database = getDb();
  const insert = database.prepare(`
    INSERT OR IGNORE INTO archive_messages (
      session_id, agent, seq, timestamp, role, message_json
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);

  const records = lines.map(parseMessageRecord).filter((record): record is ArchiveMessageRecord => Boolean(record));
  if (records.length > 0) {
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
  }
}

async function importSessionBlocksFromJsonl(sessionId: string): Promise<void> {
  const archivePath = getSessionBlockArchiveLogPath(sessionId);
  if (!await fs.pathExists(archivePath)) {
    return;
  }

  const raw = await fs.readFile(archivePath, 'utf8');
  const lines = raw.split('\n').map(line => line.trim()).filter(Boolean);
  if (lines.length === 0) {
    return;
  }

  const database = getDb();
  const insert = database.prepare(`
    INSERT OR IGNORE INTO archive_blocks (
      session_id, agent, id, level, source_kind, source_start, source_end,
      raw_start_seq, raw_end_seq, summary, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const records = lines.map(parseBlockRecord).filter((record): record is ArchiveBlockRecord => Boolean(record));
  if (records.length > 0) {
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
          record.rawStartSeq,
          record.rawEndSeq,
          record.summary,
          record.createdAt,
        );
      }
    });
  }
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
}

export function initArchiveStoreSync(): void {
  openArchiveStore();
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
  await initArchiveStore();
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

export async function writeArchiveBlocks(records: ArchiveBlockRecord[]): Promise<void> {
  if (records.length === 0) {
    return;
  }

  await initArchiveStore();
  await ensureSessionBranch(records[0].sessionId);
  const database = getDb();
  const insert = database.prepare(`
    INSERT OR REPLACE INTO archive_blocks (
      session_id, agent, id, level, source_kind, source_start, source_end,
      raw_start_seq, raw_end_seq, summary, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        record.rawStartSeq,
        record.rawEndSeq,
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
    SELECT agent, id, level, source_kind, source_start, source_end, raw_start_seq, raw_end_seq, summary, created_at
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
    rawStartSeq: Number(row.raw_start_seq),
    rawEndSeq: Number(row.raw_end_seq),
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

export async function setVectorCheckpoint(
  sessionId: string,
  checkpoint: Partial<Pick<ArchiveVectorCheckpoint, 'rawLastIndexedSeq' | 'rawTailStartSeq' | 'lastIndexedBlockId'>>,
): Promise<ArchiveVectorCheckpoint> {
  const current = await getVectorCheckpoint(sessionId);
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

export function getVectorSearchLineageSync(sessionId: string): LineageEntry[] {
  initArchiveStoreSync();
  return buildLineage(sessionId);
}
