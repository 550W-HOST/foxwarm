import fs from 'fs-extra';
import path from 'path';
import crypto from 'crypto';
import { promises as nodeFs } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { ARCHIVE_DB_PATH, SESSION_ID_RESERVATIONS_LOG_PATH, SESSION_LOGS_DIR, STATE_DIR, getSessionArchiveLogPath, getSessionBlockArchiveLogPath } from '../config';
import { logger } from '../common';
import { streamJsonlLines as streamJsonlStream } from '../jsonl';
import type { Message } from '../types';
import type { ArchiveMessageRecord } from './archive';
import type { ArchiveBlockRecord } from './layeredContext';
import type { ExtractedMemoryFact } from './compactPlan';
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
const uncertainPayloadImportOwners = new Map<string, boolean>();
let bootstrapPromise: Promise<void> | null = null;
let reservationLedgerLoadPromise: Promise<Map<string, string>> | null = null;

type SessionIdReservationRecord = {
  v: 1;
  sessionId: string;
  canonicalSessionId: string;
  timestamp: number;
};

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
  database.exec('BEGIN IMMEDIATE');
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

async function streamJsonlLines(filePath: string, onLine: (line: string) => Promise<void> | void): Promise<void> {
  await streamJsonlStream(fs.createReadStream(filePath, { encoding: 'utf8' }), onLine);
}

function upsertSessionIdReservationSync(sessionId: string, canonicalSessionId: string, timestamp: number): void {
  getDb().prepare(`
    INSERT INTO archive_session_id_reservations (
      session_id, canonical_session_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      canonical_session_id = excluded.canonical_session_id,
      updated_at = excluded.updated_at
  `).run(sessionId, canonicalSessionId, timestamp, timestamp);
}

async function loadSessionIdReservationLedger(): Promise<Map<string, string>> {
  if (!reservationLedgerLoadPromise) {
    reservationLedgerLoadPromise = (async () => {
      const reservations = new Map<string, string>();
      let ledgerNeedsRewrite = !await fs.pathExists(SESSION_ID_RESERVATIONS_LOG_PATH);
      if (!ledgerNeedsRewrite) {
        const content = await fs.readFile(SESSION_ID_RESERVATIONS_LOG_PATH, 'utf8');
        for (const rawLine of content.split(/\r?\n/)) {
          const line = rawLine.trim();
          if (!line) {
            continue;
          }
          let record: Partial<SessionIdReservationRecord>;
          try {
            record = JSON.parse(line) as Partial<SessionIdReservationRecord>;
          } catch {
            ledgerNeedsRewrite = true;
            continue;
          }
          if (record.v !== 1
            || typeof record.sessionId !== 'string'
            || record.sessionId.length === 0
            || typeof record.canonicalSessionId !== 'string'
            || record.canonicalSessionId.length === 0) {
            ledgerNeedsRewrite = true;
            continue;
          }
          const existing = reservations.get(record.sessionId);
          if (existing !== undefined && existing !== record.canonicalSessionId) {
            throw new Error(`Session ID reservation ledger has conflicting mappings for "${record.sessionId}".`);
          }
          reservations.set(record.sessionId, record.canonicalSessionId);
        }
      }

      const sqliteRows = getDb().prepare(`
        SELECT session_id, canonical_session_id, updated_at
        FROM archive_session_id_reservations
      `).all() as Array<{ session_id: string; canonical_session_id: string; updated_at: number }>;
      for (const row of sqliteRows) {
        const existing = reservations.get(row.session_id);
        if (existing !== undefined && existing !== row.canonical_session_id) {
          throw new Error(`Session ID reservation state conflicts for "${row.session_id}" between ledger and SQLite.`);
        }
        if (existing === undefined) {
          reservations.set(row.session_id, row.canonical_session_id);
          ledgerNeedsRewrite = true;
        }
      }

      assertValidReservationGraph(reservations);

      if (ledgerNeedsRewrite) {
        logger.warn({ reservationCount: reservations.size }, 'Repairing session ID reservation ledger from durable state');
        await writeSessionIdReservationLedger(reservations);
      }

      const now = Date.now();
      for (const [sessionId, canonicalSessionId] of reservations) {
        upsertSessionIdReservationSync(sessionId, canonicalSessionId, now);
      }
      return reservations;
    })().catch(error => {
      reservationLedgerLoadPromise = null;
      throw error;
    });
  }
  return reservationLedgerLoadPromise;
}

async function writeSessionIdReservationLedger(reservations: Map<string, string>): Promise<void> {
  const timestamp = Date.now();
  const content = [...reservations.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([sessionId, canonicalSessionId]) => JSON.stringify({
      v: 1,
      sessionId,
      canonicalSessionId,
      timestamp,
    } satisfies SessionIdReservationRecord))
    .join('\n');
  await fs.ensureDir(path.dirname(SESSION_ID_RESERVATIONS_LOG_PATH));
  const temporaryPath = `${SESSION_ID_RESERVATIONS_LOG_PATH}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporaryPath, content ? `${content}\n` : '');
  await fs.move(temporaryPath, SESSION_ID_RESERVATIONS_LOG_PATH, { overwrite: true });
}

function assertValidReservationGraph(reservations: Map<string, string>): void {
  for (const start of reservations.keys()) {
    let current = start;
    const seen = new Set<string>();
    while (true) {
      const next = reservations.get(current);
      if (!next || next === current) break;
      if (seen.has(current)) {
        throw new Error(`Session ID reservation ledger contains an alias cycle involving "${current}".`);
      }
      seen.add(current);
      current = next;
    }
  }
}

function resolveCanonicalReservation(reservations: Map<string, string>, sessionId: string): string {
  let current = sessionId;
  while (true) {
    const next = reservations.get(current);
    if (!next || next === current) break;
    current = next;
  }
  return current;
}

async function persistSessionIdReservation(sessionId: string, canonicalSessionId: string): Promise<void> {
  if (!sessionId || !canonicalSessionId) {
    return;
  }

  const reservations = await loadSessionIdReservationLedger();
  const currentCanonical = reservations.get(sessionId);
  if (currentCanonical !== undefined && currentCanonical !== canonicalSessionId) {
    if (resolveCanonicalReservation(reservations, sessionId) === canonicalSessionId) return;
    throw new Error(`Session ID reservation "${sessionId}" already maps to "${currentCanonical}", not "${canonicalSessionId}".`);
  }
  if (currentCanonical !== canonicalSessionId) {
    const previousRow = getDb().prepare(`
      SELECT canonical_session_id, created_at, updated_at
      FROM archive_session_id_reservations
      WHERE session_id = ?
    `).get(sessionId) as { canonical_session_id: string; created_at: number; updated_at: number } | undefined;
    reservations.set(sessionId, canonicalSessionId);
    try {
      assertValidReservationGraph(reservations);
      upsertSessionIdReservationSync(sessionId, canonicalSessionId, Date.now());
      await writeSessionIdReservationLedger(reservations);
    } catch (error) {
      if (currentCanonical === undefined) reservations.delete(sessionId);
      else reservations.set(sessionId, currentCanonical);
      if (previousRow) {
        getDb().prepare(`
          UPDATE archive_session_id_reservations
          SET canonical_session_id = ?, created_at = ?, updated_at = ?
          WHERE session_id = ?
        `).run(previousRow.canonical_session_id, previousRow.created_at, previousRow.updated_at, sessionId);
      } else {
        getDb().prepare(`DELETE FROM archive_session_id_reservations WHERE session_id = ?`).run(sessionId);
      }
      throw error;
    }
    return;
  }

  upsertSessionIdReservationSync(sessionId, canonicalSessionId, Date.now());
}

async function resolveArchivedRecordSessionId(sessionId: string): Promise<string> {
  const reservations = await loadSessionIdReservationLedger();
  return resolveCanonicalReservation(reservations, sessionId);
}

export async function resolveArchivedSessionId(sessionId: string): Promise<string> {
  await initArchiveStore();
  return resolveArchivedRecordSessionId(sessionId);
}

function openArchiveStore(): void {
  if (db) {
    return;
  }

  fs.ensureDirSync(path.dirname(ARCHIVE_DB_PATH));
  db = new DatabaseSync(ARCHIVE_DB_PATH);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = FULL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS archive_store_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS archive_branches (
      session_id TEXT PRIMARY KEY,
      parent_session_id TEXT,
      fork_message_seq INTEGER NOT NULL DEFAULT 0,
      fork_block_id INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_archive_branches_parent ON archive_branches(parent_session_id);

    CREATE TABLE IF NOT EXISTS archive_session_id_reservations (
      session_id TEXT PRIMARY KEY,
      canonical_session_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_archive_session_id_reservations_canonical
      ON archive_session_id_reservations(canonical_session_id);

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
      memory_facts_json TEXT,
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
  try {
    db.exec(`ALTER TABLE archive_blocks ADD COLUMN memory_facts_json TEXT`);
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

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function isCanonicalMessage(value: unknown): boolean {
  if (!isRecord(value) || !['user', 'model', 'tool'].includes(value.role) || !Array.isArray(value.parts)) return false;
  if (value.modelVisible !== undefined && typeof value.modelVisible !== 'boolean') return false;
  if (value.__meta !== undefined && !isRecord(value.__meta)) return false;
  if (value.providerMeta !== undefined && (!isRecord(value.providerMeta) || !isRecord(value.providerMeta.providerSpecificFields) || (value.providerMeta.sourceModelId !== undefined && typeof value.providerMeta.sourceModelId !== 'string'))) return false;
  return value.parts.every((part: unknown) => {
    if (!isRecord(part)) return false;
    for (const key of ['text', 'system', 'thinking', 'toolUseId'] as const) if (part[key] !== undefined && typeof part[key] !== 'string') return false;
    if (part.systemPayload !== undefined && typeof part.systemPayload !== 'boolean') return false;
    if (part.functionCall !== undefined && (!isRecord(part.functionCall) || typeof part.functionCall.id !== 'string' || typeof part.functionCall.name !== 'string' || !isRecord(part.functionCall.args))) return false;
    if (part.functionResponse !== undefined && (!isRecord(part.functionResponse) || typeof part.functionResponse.tool_use_id !== 'string' || typeof part.functionResponse.name !== 'string' || part.functionResponse.response === undefined)) return false;
    if (part.inlineData !== undefined && (!isRecord(part.inlineData) || typeof part.inlineData.data !== 'string')) return false;
    if (part.inlineDataRef !== undefined && (!isRecord(part.inlineDataRef) || typeof part.inlineDataRef.imageId !== 'string' || typeof part.inlineDataRef.mimeType !== 'string'
      || !isFiniteNumber(part.inlineDataRef.byteLength) || typeof part.inlineDataRef.sha256 !== 'string')) return false;
    if (part.imageMeta !== undefined && (!isRecord(part.imageMeta) || typeof part.imageMeta.imageId !== 'string')) return false;
    if (part.providerMeta !== undefined && !isRecord(part.providerMeta)) return false;
    return true;
  });
}

function isCanonicalMessageRecord(value: unknown): value is ArchiveMessageRecord {
  if (!isRecord(value) || value.v !== 1 || value.kind !== 'message' || typeof value.sessionId !== 'string' || !value.sessionId
    || typeof value.agent !== 'string' || !value.agent || !isPositiveInteger(value.seq) || !isFiniteNumber(value.timestamp)
    || !['user', 'model', 'tool'].includes(value.role) || !isCanonicalMessage(value.message)) return false;
  return value.role === value.message.role;
}

function isCanonicalBlockRecord(value: unknown): value is ArchiveBlockRecord {
  if (!isRecord(value) || value.v !== 1 || value.kind !== 'block' || typeof value.sessionId !== 'string' || !value.sessionId
    || typeof value.agent !== 'string' || !value.agent || !isPositiveInteger(value.id) || !isPositiveInteger(value.level)
    || !['message', 'block'].includes(value.sourceKind) || !isPositiveInteger(value.sourceStart) || !isPositiveInteger(value.sourceEnd) || value.sourceStart > value.sourceEnd
    || !isPositiveInteger(value.rawStartSeq) || !isPositiveInteger(value.rawEndSeq) || value.rawStartSeq > value.rawEndSeq
    || typeof value.summary !== 'string' || !isFiniteNumber(value.createdAt)) return false;
  if (value.sourceBlockIds !== undefined && (!Array.isArray(value.sourceBlockIds) || !value.sourceBlockIds.every(isPositiveInteger))) return false;
  if (value.rawStartTimestamp !== undefined && !isFiniteNumber(value.rawStartTimestamp)) return false;
  if (value.rawEndTimestamp !== undefined && !isFiniteNumber(value.rawEndTimestamp)) return false;
  if (value.memoryFacts !== undefined && (!Array.isArray(value.memoryFacts) || !value.memoryFacts.every((fact: unknown) => isRecord(fact)
    && ['decision', 'preference', 'fact', 'convention', 'environment'].includes(fact.kind) && typeof fact.text === 'string'
    && (fact.context === undefined || typeof fact.context === 'string') && (fact.attributedTo === undefined || ['user', 'assistant', 'both'].includes(fact.attributedTo))))) return false;
  return true;
}

type ParsedLegacyMessageLine = {
  record: ArchiveMessageRecord;
  recoveredTornPrefix: boolean;
};

const LEGACY_MESSAGE_SIGNATURE = '{"v":1,"kind":"message"';
const LEGACY_MESSAGE_HEADER = /^\{"v":1,"kind":"message","sessionId":("(?:\\.|[^"\\])*"),"agent":("(?:\\.|[^"\\])*"),"seq":([1-9]\d*),/;

function parseLegacyMessageLine(line: string): ParsedLegacyMessageLine | null {
  try {
    const record = JSON.parse(line);
    return isCanonicalMessageRecord(record) ? { record, recoveredTornPrefix: false } : null;
  } catch {}

  // Narrow migration-only recovery for the historical append-after-torn
  // physical line shape. The raw line remains untouched and is later moved
  // verbatim to migration backup.
  const header = LEGACY_MESSAGE_HEADER.exec(line);
  if (!header) return null;
  let prefixSessionId: string;
  try { prefixSessionId = JSON.parse(header[1]); } catch { return null; }
  const prefixSeq = Number(header[3]);
  const candidates: Array<{ index: number; record: ArchiveMessageRecord }> = [];
  let searchFrom = 1;
  while (true) {
    const index = line.indexOf(LEGACY_MESSAGE_SIGNATURE, searchFrom);
    if (index < 0) break;
    searchFrom = index + 1;
    try {
      const record = JSON.parse(line.slice(index));
      if (isCanonicalMessageRecord(record)) candidates.push({ index, record });
    } catch {}
  }
  if (candidates.length !== 1) return null;
  const candidate = candidates[0];
  try {
    JSON.parse(line.slice(0, candidate.index));
    return null; // Two complete concatenated objects are not the torn shape.
  } catch (error) {
    // All supported historical evidence is a prefix torn inside a JSON
    // string. Other invalid-prefix grammars stay fail-closed.
    if (!String((error as Error)?.message || error).includes('Unterminated string')) return null;
  }
  if (candidate.record.sessionId !== prefixSessionId || candidate.record.seq !== prefixSeq) return null;
  return { record: candidate.record, recoveredTornPrefix: true };
}

function parseMessageRecord(line: string): ArchiveMessageRecord | null {
  try {
    const record = JSON.parse(line);
    if (isCanonicalMessageRecord(record)) return record;
  } catch (error) {
    logger.warn({ err: error }, 'Skipping malformed archive-store message import line');
  }
  return null;
}

function parseBlockRecord(line: string): ArchiveBlockRecord | null {
  try {
    const record = JSON.parse(line);
    if (isCanonicalBlockRecord(record)) return record;
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
  aliases?: string[];
};

async function collectBootstrapSessionCandidates(): Promise<BootstrapSessionCandidate[]> {
  const candidates = new Map<string, BootstrapSessionCandidate>();

  try {
    const { data } = await loadSessionsMetadataSnapshot();
    const sessionsData = data?.sessions && typeof data.sessions === 'object' ? data.sessions : data;
    if (sessionsData && typeof sessionsData === 'object') {
      for (const [sessionId, sessionMeta] of Object.entries(sessionsData)) {
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          continue;
        }
        const meta = (sessionMeta && typeof sessionMeta === 'object') ? sessionMeta as Record<string, any> : {};
        candidates.set(sessionId, {
          sessionId,
          parentSessionId: typeof meta.parentSessionId === 'string' && meta.parentSessionId.length > 0
            ? meta.parentSessionId
            : undefined,
          aliases: Array.isArray(meta.aliases)
            ? meta.aliases.filter((alias): alias is string => typeof alias === 'string' && alias.length > 0)
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

async function inferLegacyForkMessageSeq(sessionId: string, parentSessionId: string, allowRecoveredMessageLineage = false): Promise<number> {
  const archivePath = getSessionArchiveLogPath(sessionId);
  const fileState = await getImportSourceState(archivePath);
  if (!fileState.exists) {
    return 0;
  }

  let maxSeq = 0;
  let minLocalSeq = Number.POSITIVE_INFINITY;
  await streamJsonlLines(archivePath, async (line) => {
    const record = allowRecoveredMessageLineage ? parseLegacyMessageLine(line)?.record : parseMessageRecord(line);
    if (!record) {
      return;
    }
    const canonicalSessionId = await resolveArchivedRecordSessionId(record.sessionId);
    if (canonicalSessionId === parentSessionId && record.seq > maxSeq) {
      maxSeq = record.seq;
    }
    if (canonicalSessionId === sessionId && record.seq < minLocalSeq) {
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
    if (!record) {
      return;
    }
    const canonicalSessionId = await resolveArchivedRecordSessionId(record.sessionId);
    if (canonicalSessionId === parentSessionId && record.id > maxId) {
      maxId = record.id;
    }
    if (canonicalSessionId === sessionId && record.id < minLocalId) {
      minLocalId = record.id;
    }
  });

  if (maxId <= 0 && Number.isFinite(minLocalId)) {
    return Math.max(0, minLocalId - 1);
  }

  return maxId;
}

async function findMismatchedHistoricalPayloadId(sessionId: string): Promise<string | undefined> {
  let lastRecordSessionId: string | undefined;
  let sawCurrentSessionId = false;
  const inspect = async (filePath: string, parse: (line: string) => { sessionId: string } | null): Promise<void> => {
    if (!await fs.pathExists(filePath)) return;
    await streamJsonlLines(filePath, line => {
      const record = parse(line);
      if (!record) return;
      lastRecordSessionId = record.sessionId;
      if (record.sessionId === sessionId) sawCurrentSessionId = true;
    });
  };
  await inspect(getSessionArchiveLogPath(sessionId), parseMessageRecord);
  if (!lastRecordSessionId) {
    await inspect(getSessionBlockArchiveLogPath(sessionId), parseBlockRecord);
  }
  return !sawCurrentSessionId && lastRecordSessionId && lastRecordSessionId !== sessionId
    ? lastRecordSessionId
    : undefined;
}

async function bootstrapArchiveStoreFromLegacy(options: { allowRecoveredMessageLineage?: boolean } = {}): Promise<void> {
  await loadSessionIdReservationLedger();

  const candidates = await collectBootstrapSessionCandidates();
  const discoveredSessionIds = new Set(candidates.map(candidate => candidate.sessionId));
  const existingBranchRows = getDb().prepare(`SELECT session_id FROM archive_branches`).all() as Array<{ session_id: string }>;
  for (const row of existingBranchRows) discoveredSessionIds.add(row.session_id);

  for (const candidate of candidates) {
    const existingBranch = getBranchInternal(candidate.sessionId);
    for (const alias of [...(candidate.aliases || [])].reverse()) {
      await persistSessionIdReservation(alias, candidate.sessionId);
    }
    if (!existingBranch) {
      const mismatchedPayloadId = await findMismatchedHistoricalPayloadId(candidate.sessionId);
      if (mismatchedPayloadId) {
        // A path/payload mismatch is not proof of a move: legacy forks copied
        // parent records into child logs. Reserve the payload identity as its
        // own lifetime without redirecting or merging either archive.
        uncertainPayloadImportOwners.set(`${candidate.sessionId}\0${mismatchedPayloadId}`, !discoveredSessionIds.has(mismatchedPayloadId));
        await ensureSessionBranch(mismatchedPayloadId);
      }
    }

    if (existingBranch) {
      continue;
    }

    if (candidate.parentSessionId) {
      const parentSessionId = await resolveArchivedRecordSessionId(candidate.parentSessionId);
      const forkMessageSeq = await inferLegacyForkMessageSeq(candidate.sessionId, parentSessionId, options.allowRecoveredMessageLineage === true);
      const forkBlockId = await inferLegacyForkBlockId(candidate.sessionId, parentSessionId);
      await ensureSessionBranch(candidate.sessionId, {
        parentSessionId,
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

async function ensureBootstrapped(options: { allowRecoveredMessageLineage?: boolean } = {}): Promise<void> {
  if (!bootstrapPromise) {
    bootstrapPromise = bootstrapArchiveStoreFromLegacy(options).catch((err) => {
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

    const canonicalSessionId = await resolveArchivedRecordSessionId(record.sessionId);
    if (canonicalSessionId !== sessionId) {
      await ensureSessionBranch(canonicalSessionId);
      if (!uncertainPayloadImportOwners.get(`${sessionId}\0${canonicalSessionId}`)) return;
    }
    batch.push(canonicalSessionId === record.sessionId ? record : { ...record, sessionId: canonicalSessionId });
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
      raw_start_seq, raw_end_seq, raw_start_timestamp, raw_end_timestamp, summary, memory_facts_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          record.memoryFacts?.length ? JSON.stringify(record.memoryFacts) : null,
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

    const canonicalSessionId = await resolveArchivedRecordSessionId(record.sessionId);
    if (canonicalSessionId !== sessionId) {
      await ensureSessionBranch(canonicalSessionId);
      if (!uncertainPayloadImportOwners.get(`${sessionId}\0${canonicalSessionId}`)) return;
    }
    batch.push(canonicalSessionId === record.sessionId ? record : { ...record, sessionId: canonicalSessionId });
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
  if (sessionId) await ensureSessionBranch(sessionId);
}

function parseMemoryFactsJson(value: unknown): ExtractedMemoryFact[] | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return undefined;
    const facts = parsed.filter((fact): fact is ExtractedMemoryFact => (
      !!fact && typeof fact === 'object'
      && ['decision', 'preference', 'fact', 'convention', 'environment'].includes((fact as any).kind)
      && typeof (fact as any).text === 'string' && (fact as any).text.trim().length > 0
    )).map((fact: any) => ({
      kind: fact.kind,
      text: fact.text,
      ...(typeof fact.context === 'string' && fact.context.trim() ? { context: fact.context } : {}),
      ...(['user', 'assistant', 'both'].includes(fact.attributedTo) ? { attributedTo: fact.attributedTo } : {}),
    }));
    return facts.length ? facts : undefined;
  } catch {
    return undefined;
  }
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
  await loadSessionIdReservationLedger();
}

export function initArchiveStoreSync(): void {
  openArchiveStore();
}

/**
 * Return whether a session id has ever been registered in the durable archive.
 *
 * Deleted live sessions intentionally keep their append-only archive records.
 * Callers that allocate new session ids must therefore treat an archived id as
 * reserved even when it no longer exists in catalog.sqlite or state/sessions/.
 */
export async function hasArchivedSessionId(sessionId: string): Promise<boolean> {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return false;
  }

  await initArchiveStore();
  const reservation = getDb().prepare(`
    SELECT 1
    FROM archive_session_id_reservations
    WHERE session_id = ? OR canonical_session_id = ?
  `).get(sessionId, sessionId);
  return reservation !== undefined || getBranchInternal(sessionId) !== null;
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
      raw_start_seq, raw_end_seq, raw_start_timestamp, raw_end_timestamp, summary, memory_facts_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        record.memoryFacts?.length ? JSON.stringify(record.memoryFacts) : null,
        record.createdAt,
      );
    }
  });
  importedSessions.add(records[0].sessionId);
}

export async function readLocalArchiveMessages(sessionId: string, startSeq?: number, endSeq?: number): Promise<ArchiveMessageRecord[]> {
  await initArchiveStore();
  sessionId = await resolveArchivedRecordSessionId(sessionId);
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
  sessionId = await resolveArchivedRecordSessionId(sessionId);
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
  sessionId = await resolveArchivedRecordSessionId(sessionId);
  await ensureImported(sessionId);

  const rows = getDb().prepare(`
    SELECT agent, id, level, source_kind, source_start, source_end, source_block_ids_json, raw_start_seq, raw_end_seq, raw_start_timestamp, raw_end_timestamp, summary, memory_facts_json, created_at
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
    ...(parseMemoryFactsJson(row.memory_facts_json) ? { memoryFacts: parseMemoryFactsJson(row.memory_facts_json) } : {}),
    createdAt: Number(row.created_at),
  }));
}

export async function readEffectiveArchiveBlocks(sessionId: string, startId?: number, endId?: number): Promise<EffectiveArchiveBlockRecord[]> {
  await initArchiveStore();
  sessionId = await resolveArchivedRecordSessionId(sessionId);
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
  renameSessionArchiveStoreRows(oldSessionId, newSessionId);
}

function renameSessionArchiveStoreRows(oldSessionId: string, newSessionId: string): void {
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

export function renameSessionArchiveStoreForRecovery(oldSessionId: string, newSessionId: string): void {
  initArchiveStoreSync();
  renameSessionArchiveStoreRows(oldSessionId, newSessionId);
}

export async function commitSessionIdRename(oldSessionId: string, newSessionId: string): Promise<void> {
  await initArchiveStore();
  await persistSessionIdReservation(oldSessionId, newSessionId);
}

export async function rollbackUncommittedSessionArchive(sessionId: string): Promise<void> {
  await initArchiveStore();
  runInTransaction(() => {
    getDb().prepare(`DELETE FROM archive_messages WHERE session_id = ?`).run(sessionId);
    getDb().prepare(`DELETE FROM archive_blocks WHERE session_id = ?`).run(sessionId);
    getDb().prepare(`DELETE FROM archive_checkpoints WHERE session_id = ?`).run(sessionId);
    getDb().prepare(`DELETE FROM archive_import_state WHERE session_id = ?`).run(sessionId);
    getDb().prepare(`DELETE FROM archive_branches WHERE session_id = ?`).run(sessionId);
  });
  importedSessions.delete(sessionId);
}

export type LegacyArchiveMigrationSource = {
  filePath: string;
  relativeStatePath: string;
  kind: 'messages' | 'blocks';
  sha256: string;
  recordCount: number;
  recoveredRecords: Array<{ sessionId: string; seq: number; payloadSha256: string; insertedIntoSqlite: boolean }>;
  tornPrefixCount: number;
};

export function markArchiveStoreSqliteAuthority(migrationId: string): void {
  openArchiveStore();
  getDb().prepare('INSERT OR REPLACE INTO archive_store_metadata(key,value) VALUES(?,?)').run('sqlite_authority_migration', migrationId);
}

export function hasArchiveStoreSqliteAuthority(migrationId: string): boolean {
  openArchiveStore();
  const row: any = getDb().prepare('SELECT value FROM archive_store_metadata WHERE key=?').get('sqlite_authority_migration');
  return row?.value === migrationId;
}

function canonicalJson(value: any): string {
  const normalize = (item: any): any => {
    if (Array.isArray(item)) return item.map(normalize);
    if (!item || typeof item !== 'object') return item;
    return Object.fromEntries(Object.keys(item).sort().filter(key => item[key] !== undefined).map(key => [key, normalize(item[key])]));
  };
  return JSON.stringify(normalize(value));
}

async function hashFile(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function validateLegacyFileStructure(
  filePath: string,
  kind: 'messages' | 'blocks',
  recoveredPayloads: Map<string, string>,
): Promise<{ recordCount: number; recoveredRecords: Array<{ sessionId: string; seq: number; payloadSha256: string; insertedIntoSqlite: boolean }>; tornPrefixCount: number }> {
  let count = 0;
  const recoveredRecords: Array<{ sessionId: string; seq: number; payloadSha256: string; insertedIntoSqlite: boolean }> = [];
  let tornPrefixCount = 0;
  await streamJsonlLines(filePath, async line => {
    if (kind === 'messages') {
      const parsed = parseLegacyMessageLine(line);
      if (!parsed) {
        try { JSON.parse(line); } catch { throw new Error(`Malformed legacy session archive line in ${filePath}`); }
        throw new Error(`Invalid legacy session message record in ${filePath}`);
      }
      if (parsed.recoveredTornPrefix) {
        const identity = `${parsed.record.sessionId}\0${parsed.record.seq}`;
        const payload = canonicalJson(parsed.record);
        const priorPayload = recoveredPayloads.get(identity);
        if (priorPayload !== undefined && priorPayload !== payload) throw new Error(`Divergent recovered legacy session message ${parsed.record.sessionId}#${parsed.record.seq}`);
        recoveredPayloads.set(identity, payload);
        recoveredRecords.push({
          sessionId: parsed.record.sessionId,
          seq: parsed.record.seq,
          payloadSha256: crypto.createHash('sha256').update(payload).digest('hex'),
          insertedIntoSqlite: false,
        });
        tornPrefixCount += 1;
      }
    } else {
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { throw new Error(`Malformed legacy block archive line in ${filePath}`); }
      if (!isCanonicalBlockRecord(parsed)) throw new Error(`Invalid legacy session block record in ${filePath}`);
    }
    count += 1;
  });
  return { recordCount: count, recoveredRecords, tornPrefixCount };
}

async function verifyLegacyMessageFile(filePath: string, preexistingKeys: Set<string>): Promise<number> {
  let count = 0;
  await streamJsonlLines(filePath, async line => {
    const record = parseLegacyMessageLine(line)?.record;
    if (!record) throw new Error(`Invalid legacy session message record in ${filePath}`);
    const sessionId = await resolveArchivedRecordSessionId(record.sessionId);
    let rowSessionId = sessionId;
    let row: any = getDb().prepare('SELECT agent,seq,timestamp,role,message_json FROM archive_messages WHERE session_id=? AND seq=?').get(rowSessionId, record.seq);
    if (!row && rowSessionId !== record.sessionId) {
      rowSessionId = record.sessionId;
      row = getDb().prepare('SELECT agent,seq,timestamp,role,message_json FROM archive_messages WHERE session_id=? AND seq=?').get(rowSessionId, record.seq);
    }
    if (!row) throw new Error(`Legacy session message ${record.sessionId}#${record.seq} is missing from SQLite`);
    const expected = { agent: record.agent || 'main', seq: record.seq, timestamp: record.timestamp, role: record.role, message: record.message };
    const actual = { agent: row.agent || 'main', seq: Number(row.seq), timestamp: Number(row.timestamp), role: row.role, message: JSON.parse(row.message_json) };
    if (!preexistingKeys.has(`${rowSessionId}\0${record.seq}`) && canonicalJson(expected) !== canonicalJson(actual)) throw new Error(`Conflicting legacy session message ${record.sessionId}#${record.seq}`);
    count += 1;
  });
  return count;
}

async function verifyLegacyBlockFile(filePath: string, preexistingKeys: Set<string>): Promise<number> {
  let count = 0;
  await streamJsonlLines(filePath, async line => {
    try { JSON.parse(line); } catch { throw new Error(`Malformed legacy block archive line in ${filePath}`); }
    const record = parseBlockRecord(line);
    if (!record) throw new Error(`Invalid legacy session block record in ${filePath}`);
    const sessionId = await resolveArchivedRecordSessionId(record.sessionId);
    const select = getDb().prepare(`SELECT agent,id,level,source_kind,source_start,source_end,source_block_ids_json,raw_start_seq,raw_end_seq,
      raw_start_timestamp,raw_end_timestamp,summary,memory_facts_json,created_at FROM archive_blocks WHERE session_id=? AND id=?`);
    let rowSessionId = sessionId;
    let row: any = select.get(rowSessionId, record.id);
    if (!row && rowSessionId !== record.sessionId) {
      rowSessionId = record.sessionId;
      row = select.get(rowSessionId, record.id);
    }
    if (!row) throw new Error(`Legacy session block ${record.sessionId}#${record.id} is missing from SQLite`);
    const expected = {
      agent: record.agent || 'main', id: record.id, level: record.level, sourceKind: record.sourceKind, sourceStart: record.sourceStart,
      sourceEnd: record.sourceEnd, sourceBlockIds: record.sourceKind === 'block' ? record.sourceBlockIds : undefined,
      rawStartSeq: record.rawStartSeq, rawEndSeq: record.rawEndSeq, rawStartTimestamp: record.rawStartTimestamp,
      rawEndTimestamp: record.rawEndTimestamp, summary: record.summary, memoryFacts: record.memoryFacts, createdAt: record.createdAt,
    };
    const actual = {
      agent: row.agent || 'main', id: Number(row.id), level: Number(row.level), sourceKind: row.source_kind, sourceStart: Number(row.source_start),
      sourceEnd: Number(row.source_end), sourceBlockIds: parseSourceBlockIdsJson(row.source_block_ids_json), rawStartSeq: Number(row.raw_start_seq),
      rawEndSeq: Number(row.raw_end_seq), rawStartTimestamp: row.raw_start_timestamp == null ? undefined : Number(row.raw_start_timestamp),
      rawEndTimestamp: row.raw_end_timestamp == null ? undefined : Number(row.raw_end_timestamp), summary: row.summary,
      memoryFacts: parseMemoryFactsJson(row.memory_facts_json), createdAt: Number(row.created_at),
    };
    if (!preexistingKeys.has(`${rowSessionId}\0${record.id}`) && canonicalJson(expected) !== canonicalJson(actual)) throw new Error(`Conflicting legacy session block ${record.sessionId}#${record.id}`);
    count += 1;
  });
  return count;
}

/** Migration-only: import and strictly verify every active legacy session archive JSONL. */
export async function migrateLegacySessionArchivesToSqlite(): Promise<LegacyArchiveMigrationSource[]> {
  openArchiveStore();
  const candidates = await collectBootstrapSessionCandidates();
  const inventory: LegacyArchiveMigrationSource[] = [];
  const recoveredPayloads = new Map<string, string>();
  // Validate complete canonical structures before bootstrap can create rows,
  // branches, or reservations. A repaired source therefore retries from the
  // same pre-migration authority state.
  for (const { sessionId } of candidates) {
    for (const [kind, filePath] of [
      ['messages', getSessionArchiveLogPath(sessionId)],
      ['blocks', getSessionBlockArchiveLogPath(sessionId)],
    ] as const) {
      if (!await fs.pathExists(filePath)) continue;
      const validation = await validateLegacyFileStructure(filePath, kind, recoveredPayloads);
      inventory.push({ filePath, relativeStatePath: path.relative(STATE_DIR, filePath), kind, sha256: await hashFile(filePath), ...validation });
    }
  }
  const preexistingMessageKeys = new Set((getDb().prepare('SELECT session_id,seq FROM archive_messages').all() as Array<{ session_id: string; seq: number }>).map(row => `${row.session_id}\0${row.seq}`));
  const preexistingBlockKeys = new Set((getDb().prepare('SELECT session_id,id FROM archive_blocks').all() as Array<{ session_id: string; id: number }>).map(row => `${row.session_id}\0${row.id}`));
  await ensureBootstrapped({ allowRecoveredMessageLineage: true });
  const insertedRecoveredIdentities = new Set<string>();
  const recoveredInsert = getDb().prepare(`INSERT INTO archive_messages(session_id,agent,seq,timestamp,role,message_json) VALUES(?,?,?,?,?,?)`);
  for (const [identity, payload] of recoveredPayloads) {
    const record = JSON.parse(payload) as ArchiveMessageRecord;
    const sessionId = await resolveArchivedRecordSessionId(record.sessionId);
    await ensureSessionBranch(sessionId);
    const targetPreexisted = preexistingMessageKeys.has(`${sessionId}\0${record.seq}`);
    const markerKey = `migration_recovered_torn_message:${crypto.createHash('sha256').update(identity).digest('hex')}`;
    const markerValue = canonicalJson({ sessionId: record.sessionId, seq: record.seq, payloadSha256: crypto.createHash('sha256').update(payload).digest('hex') });
    runInTransaction(() => {
      const marker: any = getDb().prepare('SELECT value FROM archive_store_metadata WHERE key=?').get(markerKey);
      if (marker && marker.value !== markerValue) throw new Error(`Conflicting durable torn-message recovery marker for ${record.sessionId}#${record.seq}`);
      const existing: any = getDb().prepare('SELECT agent,seq,timestamp,role,message_json FROM archive_messages WHERE session_id=? AND seq=?').get(sessionId, record.seq);
      const expected = { agent: record.agent, seq: record.seq, timestamp: record.timestamp, role: record.role, message: record.message };
      const actual = existing ? { agent: existing.agent, seq: Number(existing.seq), timestamp: Number(existing.timestamp), role: existing.role, message: JSON.parse(existing.message_json) } : null;
      const rowMatches = actual !== null && canonicalJson(expected) === canonicalJson(actual);
      if (marker && !rowMatches) throw new Error(`Recovered torn-message row no longer matches its durable marker for ${record.sessionId}#${record.seq}`);
      if (!existing && targetPreexisted) throw new Error(`Preexisting SQLite row disappeared during torn-message recovery for ${record.sessionId}#${record.seq}`);
      if (!existing) {
        recoveredInsert.run(sessionId, record.agent, record.seq, record.timestamp, record.role, JSON.stringify(record.message));
        getDb().prepare('INSERT INTO archive_store_metadata(key,value) VALUES(?,?)').run(markerKey, markerValue);
        insertedRecoveredIdentities.add(identity);
      } else if (marker) {
        insertedRecoveredIdentities.add(identity);
      } else if (!targetPreexisted) {
        if (!rowMatches) throw new Error(`Bootstrap recovered torn-message row does not match ${record.sessionId}#${record.seq}`);
        getDb().prepare('INSERT INTO archive_store_metadata(key,value) VALUES(?,?)').run(markerKey, markerValue);
        insertedRecoveredIdentities.add(identity);
      }
    });
  }
  // Mark one deterministic source occurrence for each inserted logical row;
  // copied fork logs retain their own physical recovery audit without
  // inflating the inserted logical-row count.
  for (const source of inventory) {
    for (const recovered of source.recoveredRecords) {
      const identity = `${recovered.sessionId}\0${recovered.seq}`;
      if (insertedRecoveredIdentities.delete(identity)) recovered.insertedIntoSqlite = true;
    }
  }
  const branches = getDb().prepare('SELECT session_id,parent_session_id,fork_message_seq,fork_block_id FROM archive_branches').all() as Array<{
    session_id: string; parent_session_id: string | null; fork_message_seq: number; fork_block_id: number;
  }>;
  const parentBySession = new Map(branches.map(branch => [branch.session_id, branch.parent_session_id || undefined]));
  for (const branch of branches) {
    if (!Number.isInteger(branch.fork_message_seq) || branch.fork_message_seq < 0 || !Number.isInteger(branch.fork_block_id) || branch.fork_block_id < 0) {
      throw new Error(`Invalid archive lineage caps for ${branch.session_id}`);
    }
    const seen = new Set<string>();
    let current: string | undefined = branch.session_id;
    while (current) {
      if (seen.has(current)) throw new Error(`Archive lineage cycle involving ${current}`);
      seen.add(current);
      current = parentBySession.get(current);
    }
  }
  const sources: LegacyArchiveMigrationSource[] = [];
  for (const source of inventory) {
    const recordCount = source.kind === 'messages' ? await verifyLegacyMessageFile(source.filePath, preexistingMessageKeys) : await verifyLegacyBlockFile(source.filePath, preexistingBlockKeys);
    const sha256 = await hashFile(source.filePath);
    if (recordCount !== source.recordCount || sha256 !== source.sha256) throw new Error(`Legacy archive changed during verification: ${source.relativeStatePath}`);
    sources.push(source);
  }
  const integrity: any = getDb().prepare('PRAGMA integrity_check').get();
  if (!integrity || Object.values(integrity)[0] !== 'ok') throw new Error(`archive-store.sqlite integrity_check failed: ${JSON.stringify(integrity)}`);
  if ((getDb().prepare('PRAGMA foreign_key_check').all() as any[]).length) throw new Error('archive-store.sqlite foreign_key_check failed');
  return sources.sort((a, b) => a.filePath.localeCompare(b.filePath));
}

/** Export the SQLite-authoritative session archive as compatibility JSONL files. */
export async function exportSessionArchivesJsonl(outputRoot: string): Promise<{ files: number; records: number }> {
  await initArchiveStore();
  const resolvedOutputRoot = path.resolve(outputRoot);
  if (resolvedOutputRoot === path.parse(resolvedOutputRoot).root) throw new Error('Archive export output cannot be a filesystem root');
  const temporaryRoot = `${resolvedOutputRoot}.${process.pid}.${Date.now()}.tmp`;
  await fs.remove(temporaryRoot);
  await fs.ensureDir(temporaryRoot);
  const exportPath = (relativePath: string): string => {
    const resolved = path.resolve(temporaryRoot, relativePath);
    if (resolved !== temporaryRoot && !resolved.startsWith(`${temporaryRoot}${path.sep}`)) throw new Error(`Unsafe session ID in archive export path: ${relativePath}`);
    return resolved;
  };
  const exportDb = new DatabaseSync(ARCHIVE_DB_PATH, { readOnly: true });
  let files = 0;
  let records = 0;
  const writeRows = (filePath: string, rows: Iterable<any>, toRecord: (row: any) => unknown): void => {
    fs.ensureDirSync(path.dirname(filePath));
    const descriptor = fs.openSync(filePath, 'w', 0o600);
    let count = 0;
    let buffered = '';
    try {
      for (const row of rows) {
        buffered += `${JSON.stringify(toRecord(row))}\n`;
        count += 1;
        if (buffered.length >= 256 * 1024) { fs.writeSync(descriptor, buffered); buffered = ''; }
      }
      if (buffered) fs.writeSync(descriptor, buffered);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    if (count === 0) fs.removeSync(filePath);
    else { files += 1; records += count; }
  };
  try {
    exportDb.exec('PRAGMA query_only = ON; BEGIN');
    const branches = exportDb.prepare('SELECT session_id FROM archive_branches ORDER BY session_id').iterate() as Iterable<{ session_id: string }>;
    for (const branch of branches) {
      writeRows(
        exportPath(`${branch.session_id}.jsonl`),
        exportDb.prepare('SELECT agent,seq,timestamp,role,message_json FROM archive_messages WHERE session_id=? ORDER BY seq').iterate(branch.session_id) as Iterable<any>,
        row => ({ v: 1, kind: 'message', sessionId: branch.session_id, agent: row.agent || 'main', seq: Number(row.seq), timestamp: Number(row.timestamp), role: row.role, message: JSON.parse(row.message_json) }),
      );
      writeRows(
        exportPath(`${branch.session_id}.blocks.jsonl`),
        exportDb.prepare(`SELECT agent,id,level,source_kind,source_start,source_end,source_block_ids_json,raw_start_seq,raw_end_seq,
          raw_start_timestamp,raw_end_timestamp,summary,memory_facts_json,created_at FROM archive_blocks WHERE session_id=? ORDER BY id`).iterate(branch.session_id) as Iterable<any>,
        row => ({
          v: 1, kind: 'block', sessionId: branch.session_id, agent: row.agent || 'main', id: Number(row.id), level: Number(row.level),
          sourceKind: row.source_kind, sourceStart: Number(row.source_start), sourceEnd: Number(row.source_end),
          ...(parseSourceBlockIdsJson(row.source_block_ids_json) ? { sourceBlockIds: parseSourceBlockIdsJson(row.source_block_ids_json) } : {}),
          rawStartSeq: Number(row.raw_start_seq), rawEndSeq: Number(row.raw_end_seq),
          ...(row.raw_start_timestamp == null ? {} : { rawStartTimestamp: Number(row.raw_start_timestamp) }),
          ...(row.raw_end_timestamp == null ? {} : { rawEndTimestamp: Number(row.raw_end_timestamp) }),
          summary: String(row.summary || ''), ...(parseMemoryFactsJson(row.memory_facts_json) ? { memoryFacts: parseMemoryFactsJson(row.memory_facts_json) } : {}),
          createdAt: Number(row.created_at),
        }),
      );
    }
    exportDb.exec('COMMIT');
    exportDb.close();
  } catch (error) {
    try { exportDb.exec('ROLLBACK'); } catch {}
    try { exportDb.close(); } catch {}
    await fs.remove(temporaryRoot);
    throw error;
  }
  const previousRoot = `${resolvedOutputRoot}.${process.pid}.${Date.now()}.previous`;
  await fs.remove(previousRoot);
  if (await fs.pathExists(resolvedOutputRoot)) await fs.move(resolvedOutputRoot, previousRoot);
  try {
    await fs.move(temporaryRoot, resolvedOutputRoot);
    await fs.remove(previousRoot);
  } catch (error) {
    await fs.remove(resolvedOutputRoot).catch((): void => {});
    if (await fs.pathExists(previousRoot)) await fs.move(previousRoot, resolvedOutputRoot);
    throw error;
  }
  const directory = await nodeFs.open(path.dirname(resolvedOutputRoot), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
  return { files, records };
}

export async function getVectorSearchLineage(sessionId: string): Promise<LineageEntry[]> {
  await initArchiveStore();
  sessionId = await resolveArchivedRecordSessionId(sessionId);
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
