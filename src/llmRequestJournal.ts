import crypto, { randomUUID } from 'crypto';
import fs from 'fs-extra';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { promises as nodeFs } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { STATE_DIR } from './config';
import { logger } from './common';
import { streamJsonlLines } from './jsonl';
import type { ChatResult, Message, ToolDefinition } from './types';

export const LLM_REQUEST_JOURNAL_JSONL_PATH = path.join(STATE_DIR, 'llm-request-journal.jsonl');
const JOURNAL_PATH = LLM_REQUEST_JOURNAL_JSONL_PATH;
const JOURNAL_LOCK_PATH = `${JOURNAL_PATH}.lock`;
export const LLM_REQUEST_JOURNAL_DB_PATH = path.join(STATE_DIR, 'llm-request-journal.sqlite');
const MAX_DELTA_DEPTH = 8;
const requestedImportBatchSize = Number(process.env.FOXWARM_LLM_JOURNAL_IMPORT_BATCH_SIZE || 200);
const IMPORT_BATCH_SIZE = Number.isFinite(requestedImportBatchSize) ? Math.max(1, Math.min(10_000, Math.floor(requestedImportBatchSize))) : 200;
let db: DatabaseSync | null = null;
let initialized = false;
let initPromise: Promise<void> | null = null;
let writeFaultInjector: ((phase: string, record: JournalRecord) => void) | null = null;

async function withJournalFileLock<T>(fn: () => Promise<T>): Promise<T> {
  await fs.ensureDir(path.dirname(JOURNAL_PATH));
  const deadline = Date.now() + 10_000;
  let handle: Awaited<ReturnType<typeof nodeFs.open>> | null = null;
  while (!handle) {
    try {
      handle = await nodeFs.open(JOURNAL_LOCK_PATH, 'wx');
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() })); }
      catch (error) { await handle.close().catch((): void => {}); handle = null; await nodeFs.unlink(JOURNAL_LOCK_PATH).catch((): void => {}); throw error; }
    }
    catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
      const stat = await nodeFs.stat(JOURNAL_LOCK_PATH).catch((): null => null);
      const owner = await nodeFs.readFile(JOURNAL_LOCK_PATH, 'utf8').then(text => JSON.parse(text)).catch((): null => null);
      let ownerAlive = false;
      if (Number.isInteger(owner?.pid) && owner.pid > 0) {
        try { process.kill(owner.pid, 0); ownerAlive = true; }
        catch (ownerError: any) { if (ownerError?.code === 'EPERM') ownerAlive = true; }
      }
      if (!ownerAlive && stat && Date.now() - stat.mtimeMs > 1_000) await nodeFs.unlink(JOURNAL_LOCK_PATH).catch((): void => {});
      if (Date.now() >= deadline) throw new Error('Timed out waiting for LLM request journal file lock');
      await sleep(10);
    }
  }
  try { return await fn(); }
  finally { await handle.close().catch((): void => {}); await nodeFs.unlink(JOURNAL_LOCK_PATH).catch((): void => {}); }
}

export type LlmRequestPurpose = 'normal-turn' | 'compact-plan' | 'btw' | 'toolscript-one-shot' | 'cli' | 'setup-test' | 'low-level';

type ObjectKind = 'prompt' | 'tool-schema' | 'message';
type ObjectRecord = { v: 1; kind: 'object'; objectId: string; objectKind: ObjectKind; payload: string; createdAt: number };
type RequestRecord = {
  v: 1; kind: 'request'; requestId: string; sessionId?: string; purpose: LlmRequestPurpose; iteration: number;
  createdAt: number; promptObjectId: string; toolSchemaObjectId: string; requestedModelKey: string;
  promptCacheKeyHash: string; messageCount: number; checkpointMessageObjectIds?: string[];
  baseRequestId?: string; commonPrefixLength?: number; appendedMessageObjectIds?: string[]; deltaDepth: number;
};
type AttemptStartRecord = { v: 1; kind: 'attempt-start'; eventId: string; requestId: string; attempt: number; startedAt: number; concreteModelId: string; virtualModelKey?: string; providerType: string; semanticPayloadSha256: string };
type AttemptResultRecord = { v: 1; kind: 'attempt-result'; eventId: string; requestId: string; attempt: number; completedAt: number; outcome: 'success' | 'failure' | 'abort'; result?: ChatResult; error?: Record<string, unknown> };
type JournalRecord = ObjectRecord | RequestRecord | AttemptStartRecord | AttemptResultRecord;

export type ReconstructedLlmRequest = {
  requestId: string; sessionId?: string; purpose: LlmRequestPurpose; iteration: number; createdAt: number;
  systemPrompt: string; toolDefinitions: ToolDefinition[]; messages: Message[]; requestedModelKey: string;
  promptCacheKeyHash: string; attempts: Array<{ start: AttemptStartRecord; result?: AttemptResultRecord }>;
  completeness: 'complete';
};

export type LlmRequestJournalSummary = {
  requestId: string; sessionId?: string; purpose: LlmRequestPurpose; iteration: number; createdAt: number;
  requestedModelKey: string; messageCount: number;
};
export type LlmRequestJournalCursor = { createdAt: number; requestId: string };

function canonicalize(value: any): any {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  const result: Record<string, any> = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) result[key] = canonicalize(value[key]);
  }
  return result;
}
export function canonicalJournalJson(value: unknown): string { return JSON.stringify(canonicalize(value)); }
function sha256(value: string): string { return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`; }
export function hashJournalValue(value: unknown): string { return sha256(canonicalJournalJson(value)); }

function getDb(): DatabaseSync {
  if (!db) throw new Error('LLM request journal is not initialized');
  return db;
}

function openStore(): void {
  if (db) return;
  fs.ensureDirSync(path.dirname(LLM_REQUEST_JOURNAL_DB_PATH));
  db = new DatabaseSync(LLM_REQUEST_JOURNAL_DB_PATH);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS llm_journal_metadata (
      key TEXT PRIMARY KEY, value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS llm_journal_objects (
      object_id TEXT PRIMARY KEY, object_kind TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS llm_journal_requests (
      request_id TEXT PRIMARY KEY, session_id TEXT, purpose TEXT NOT NULL, iteration INTEGER NOT NULL, created_at INTEGER NOT NULL,
      prompt_object_id TEXT NOT NULL, tool_schema_object_id TEXT NOT NULL, requested_model_key TEXT NOT NULL,
      prompt_cache_key_hash TEXT NOT NULL, message_count INTEGER NOT NULL, checkpoint_message_ids_json TEXT,
      base_request_id TEXT, common_prefix_length INTEGER, appended_message_ids_json TEXT, delta_depth INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_llm_journal_requests_session_created ON llm_journal_requests(session_id, created_at, request_id);
    CREATE TABLE IF NOT EXISTS llm_journal_attempt_starts (
      event_id TEXT PRIMARY KEY, request_id TEXT NOT NULL, attempt INTEGER NOT NULL, started_at INTEGER NOT NULL,
      concrete_model_id TEXT NOT NULL, virtual_model_key TEXT, provider_type TEXT NOT NULL, semantic_payload_sha256 TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS llm_journal_attempt_results (
      event_id TEXT PRIMARY KEY, request_id TEXT NOT NULL, attempt INTEGER NOT NULL, completed_at INTEGER NOT NULL,
      outcome TEXT NOT NULL, result_json TEXT, error_json TEXT
    );
    CREATE TABLE IF NOT EXISTS llm_journal_import_state (
      source_path TEXT PRIMARY KEY, imported_size INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
  `);
}

function runInTransaction(fn: () => void): void {
  const database = getDb();
  database.exec('BEGIN IMMEDIATE');
  try { fn(); database.exec('COMMIT'); }
  catch (error) { try { database.exec('ROLLBACK'); } catch {} throw error; }
}

function insertRecord(record: JournalRecord): void {
  const database = getDb();
  if (record.kind === 'object') {
    database.prepare('INSERT OR IGNORE INTO llm_journal_objects(object_id,object_kind,payload,created_at) VALUES(?,?,?,?)')
      .run(record.objectId, record.objectKind, record.payload, record.createdAt); return;
  }
  if (record.kind === 'request') {
    database.prepare(`INSERT OR IGNORE INTO llm_journal_requests(
      request_id,session_id,purpose,iteration,created_at,prompt_object_id,tool_schema_object_id,requested_model_key,prompt_cache_key_hash,
      message_count,checkpoint_message_ids_json,base_request_id,common_prefix_length,appended_message_ids_json,delta_depth
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      record.requestId, record.sessionId || null, record.purpose, record.iteration, record.createdAt, record.promptObjectId,
      record.toolSchemaObjectId, record.requestedModelKey, record.promptCacheKeyHash, record.messageCount,
      record.checkpointMessageObjectIds ? JSON.stringify(record.checkpointMessageObjectIds) : null, record.baseRequestId || null,
      record.commonPrefixLength ?? null, record.appendedMessageObjectIds ? JSON.stringify(record.appendedMessageObjectIds) : null, record.deltaDepth,
    ); return;
  }
  if (record.kind === 'attempt-start') {
    database.prepare('INSERT OR IGNORE INTO llm_journal_attempt_starts(event_id,request_id,attempt,started_at,concrete_model_id,virtual_model_key,provider_type,semantic_payload_sha256) VALUES(?,?,?,?,?,?,?,?)')
      .run(record.eventId, record.requestId, record.attempt, record.startedAt, record.concreteModelId, record.virtualModelKey || null, record.providerType, record.semanticPayloadSha256); return;
  }
  database.prepare('INSERT OR IGNORE INTO llm_journal_attempt_results(event_id,request_id,attempt,completed_at,outcome,result_json,error_json) VALUES(?,?,?,?,?,?,?)')
    .run(record.eventId, record.requestId, record.attempt, record.completedAt, record.outcome, record.result ? canonicalJournalJson(record.result) : null, record.error ? canonicalJournalJson(record.error) : null);
}

function assertObjectRecord(record: ObjectRecord): void {
  if (typeof record.objectId !== 'string' || typeof record.createdAt !== 'number') throw new Error('Invalid LLM journal object record');
  if (!['prompt', 'tool-schema', 'message'].includes(record.objectKind)) throw new Error(`Invalid LLM journal object kind ${record.objectKind}`);
  if (typeof record.payload !== 'string') throw new Error(`Invalid LLM journal object payload ${record.objectId}`);
  const expected = sha256(`${record.objectKind}\0${record.payload}`);
  if (record.objectId !== expected) throw new Error(`LLM journal object hash mismatch for ${record.objectId}`);
}

function assertRequestRecord(record: RequestRecord): void {
  if (typeof record.requestId !== 'string' || typeof record.promptObjectId !== 'string' || typeof record.toolSchemaObjectId !== 'string'
    || !Number.isFinite(record.createdAt) || !Number.isInteger(record.iteration) || record.iteration < 0 || typeof record.requestedModelKey !== 'string'
    || (record.sessionId !== undefined && typeof record.sessionId !== 'string')
    || !['normal-turn','compact-plan','btw','toolscript-one-shot','cli','setup-test','low-level'].includes(record.purpose)
    || !/^sha256:[a-f0-9]{64}$/.test(record.promptCacheKeyHash)) throw new Error('Invalid LLM journal request identity');
  if (!Number.isInteger(record.messageCount) || record.messageCount < 0) throw new Error(`Invalid LLM journal message count for ${record.requestId}`);
  if (!Number.isInteger(record.deltaDepth) || record.deltaDepth < 0 || record.deltaDepth > MAX_DELTA_DEPTH) throw new Error(`Invalid LLM journal delta depth for ${record.requestId}`);
  const checkpoint = Array.isArray(record.checkpointMessageObjectIds);
  const delta = typeof record.baseRequestId === 'string' && Array.isArray(record.appendedMessageObjectIds) && Number.isInteger(record.commonPrefixLength) && record.commonPrefixLength! >= 0;
  if (checkpoint === delta) throw new Error(`LLM journal request ${record.requestId} must contain exactly one checkpoint or delta`);
  if (checkpoint && record.deltaDepth !== 0) throw new Error(`LLM journal checkpoint ${record.requestId} has nonzero depth`);
}

function assertAttemptStartRecord(record: AttemptStartRecord): void {
  if (typeof record.eventId !== 'string' || typeof record.requestId !== 'string' || !Number.isInteger(record.attempt) || record.attempt < 1
    || !Number.isFinite(record.startedAt) || typeof record.concreteModelId !== 'string' || typeof record.providerType !== 'string'
    || (record.virtualModelKey !== undefined && typeof record.virtualModelKey !== 'string')
    || !/^sha256:[a-f0-9]{64}$/.test(record.semanticPayloadSha256)) throw new Error('Invalid LLM journal attempt-start record');
}

function assertAttemptResultRecord(record: AttemptResultRecord): void {
  if (typeof record.eventId !== 'string' || typeof record.requestId !== 'string' || !Number.isInteger(record.attempt) || record.attempt < 1
    || !Number.isFinite(record.completedAt) || !['success', 'failure', 'abort'].includes(record.outcome)
    || (record.outcome === 'success' && (!record.result || typeof record.result !== 'object'))
    || (record.outcome !== 'success' && (!record.error || typeof record.error !== 'object'))) throw new Error('Invalid LLM journal attempt-result record');
}

function requestRecordFromRow(row: any): RequestRecord {
  return {
    v: 1, kind: 'request', requestId: row.request_id, sessionId: row.session_id || undefined, purpose: row.purpose,
    iteration: row.iteration, createdAt: row.created_at, promptObjectId: row.prompt_object_id, toolSchemaObjectId: row.tool_schema_object_id,
    requestedModelKey: row.requested_model_key, promptCacheKeyHash: row.prompt_cache_key_hash, messageCount: row.message_count, deltaDepth: row.delta_depth,
    ...(row.checkpoint_message_ids_json !== null ? { checkpointMessageObjectIds: parseIds(row.checkpoint_message_ids_json) } : {}),
    ...(row.base_request_id !== null ? { baseRequestId: row.base_request_id, commonPrefixLength: row.common_prefix_length, appendedMessageObjectIds: parseIds(row.appended_message_ids_json) } : {}),
  };
}

function attemptStartRecordFromRow(row: any): AttemptStartRecord {
  return { v: 1, kind: 'attempt-start', eventId: row.event_id, requestId: row.request_id, attempt: row.attempt, startedAt: row.started_at,
    concreteModelId: row.concrete_model_id, virtualModelKey: row.virtual_model_key || undefined, providerType: row.provider_type, semanticPayloadSha256: row.semantic_payload_sha256 };
}

function attemptResultRecordFromRow(row: any): AttemptResultRecord {
  return { v: 1, kind: 'attempt-result', eventId: row.event_id, requestId: row.request_id, attempt: row.attempt, completedAt: row.completed_at,
    outcome: row.outcome, result: row.result_json ? JSON.parse(row.result_json) : undefined, error: row.error_json ? JSON.parse(row.error_json) : undefined };
}

function parseRecord(line: string): JournalRecord | null {
  try {
    const value = JSON.parse(line);
    if (value?.v !== 1 || !['object','request','attempt-start','attempt-result'].includes(value.kind)) return null;
    if (value.kind === 'object') assertObjectRecord(value);
    if (value.kind === 'request') assertRequestRecord(value);
    if (value.kind === 'attempt-start') assertAttemptStartRecord(value);
    if (value.kind === 'attempt-result') assertAttemptResultRecord(value);
    return value as JournalRecord;
  } catch (error) {
    logger.warn({ err: error }, 'Skipping malformed or corrupt LLM request journal line');
    return null;
  }
}

function validateRequestManifestSync(requestId: string): void {
  const row: any = getDb().prepare('SELECT * FROM llm_journal_requests WHERE request_id=?').get(requestId);
  if (!row) throw new Error(`LLM request journal request ${requestId} not found`);
  const ids = reconstructMessageIdsSync(requestId);
  if (ids.length !== Number(row.message_count)) throw new Error(`LLM journal reconstructed message count mismatch for ${requestId}`);
  const prompt = objectValue<unknown>(row.prompt_object_id, 'prompt');
  const schema = objectValue<unknown>(row.tool_schema_object_id, 'tool-schema');
  if (typeof prompt !== 'string') throw new Error(`LLM journal prompt object has invalid payload for ${requestId}`);
  if (!Array.isArray(schema)) throw new Error(`LLM journal tool-schema object has invalid payload for ${requestId}`);
  for (const id of ids) {
    const message = objectValue<any>(id, 'message');
    if (!message || typeof message !== 'object' || !Array.isArray(message.parts)) throw new Error(`LLM journal message object has invalid payload for ${requestId}`);
  }
}

async function importJournalJsonl(): Promise<void> {
  const source = await fs.stat(JOURNAL_PATH).catch((error: any) => error?.code === 'ENOENT' ? null : Promise.reject(error));
  if (!source || source.size === 0) return;
  const state: any = getDb().prepare('SELECT imported_size FROM llm_journal_import_state WHERE source_path=?').get(JOURNAL_PATH);
  let importedSize = Math.max(0, Number(state?.imported_size) || 0);
  if (importedSize > source.size) {
    logger.warn({ importedSize, sourceSize: source.size }, 'LLM request journal JSONL shrank; rebuilding its dedicated SQLite index');
    runInTransaction(() => {
      getDb().exec('DELETE FROM llm_journal_attempt_results; DELETE FROM llm_journal_attempt_starts; DELETE FROM llm_journal_requests; DELETE FROM llm_journal_objects;');
    });
    importedSize = 0;
  }
  if (importedSize === source.size) return;

  const stream = fs.createReadStream(JOURNAL_PATH, { start: importedSize, end: source.size - 1, encoding: 'utf8' });
  let batch: JournalRecord[] = [];
  const flush = () => {
    if (batch.length === 0) return;
    const records = batch;
    batch = [];
    runInTransaction(() => {
      for (const record of records) insertRecord(record);
      for (const record of records) if (record.kind === 'request') validateRequestManifestSync(record.requestId);
    });
  };
  await streamJsonlLines(stream, line => {
    const record = parseRecord(line);
    if (!record) return;
    batch.push(record);
    if (batch.length >= IMPORT_BATCH_SIZE) flush();
  });
  flush();
  getDb().prepare(`INSERT INTO llm_journal_import_state(source_path,imported_size,updated_at) VALUES(?,?,?)
    ON CONFLICT(source_path) DO UPDATE SET imported_size=excluded.imported_size,updated_at=excluded.updated_at`).run(JOURNAL_PATH, source.size, Date.now());
}

export async function initLlmRequestJournal(): Promise<void> {
  if (initialized) return;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    openStore();
    initialized = true;
  })();
  try { await initPromise; }
  catch (error) { try { db?.close(); } catch {} db = null; throw error; }
  finally { initPromise = null; }
}

async function appendRecord(record: JournalRecord): Promise<void> {
  await initLlmRequestJournal();
  writeFaultInjector?.('before-sqlite-write', record);
  runInTransaction(() => insertRecord(record));
}

async function ensureObject(objectKind: ObjectKind, value: unknown): Promise<string> {
  const payload = canonicalJournalJson(value);
  const objectId = sha256(`${objectKind}\0${payload}`);
  await initLlmRequestJournal();
  const exists = getDb().prepare('SELECT 1 FROM llm_journal_objects WHERE object_id=?').get(objectId);
  if (!exists) await appendRecord({ v: 1, kind: 'object', objectId, objectKind, payload, createdAt: Date.now() });
  return objectId;
}

function parseIds(value: unknown): string[] {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string')) throw new Error('Invalid LLM request journal message object ID list');
  return parsed;
}

function reconstructMessageIdsSync(requestId: string, seen = new Set<string>()): string[] {
  if (seen.has(requestId)) throw new Error(`LLM request journal delta cycle at ${requestId}`);
  if (seen.size > MAX_DELTA_DEPTH) throw new Error(`LLM request journal delta chain exceeds ${MAX_DELTA_DEPTH} for ${requestId}`);
  seen.add(requestId);
  const row: any = getDb().prepare('SELECT * FROM llm_journal_requests WHERE request_id=?').get(requestId);
  if (!row) throw new Error(`LLM request journal request ${requestId} not found`);
  const depth = Number(row.delta_depth);
  if (!Number.isInteger(depth) || depth < 0 || depth > MAX_DELTA_DEPTH) throw new Error(`Invalid LLM request journal delta depth for ${requestId}`);
  if (row.checkpoint_message_ids_json) {
    if (depth !== 0 || row.base_request_id) throw new Error(`Invalid LLM request journal checkpoint for ${requestId}`);
    return parseIds(row.checkpoint_message_ids_json);
  }
  if (!row.base_request_id) throw new Error(`LLM request journal request ${requestId} has no checkpoint or base`);
  if (depth === 0) throw new Error(`Invalid zero-depth LLM request journal delta for ${requestId}`);
  const baseRow: any = getDb().prepare('SELECT delta_depth FROM llm_journal_requests WHERE request_id=?').get(row.base_request_id);
  if (!baseRow || Number(baseRow.delta_depth) !== depth - 1) throw new Error(`Invalid LLM request journal delta ancestry for ${requestId}`);
  const base = reconstructMessageIdsSync(row.base_request_id, seen);
  const commonPrefix = Number(row.common_prefix_length);
  if (!Number.isInteger(commonPrefix) || commonPrefix < 0 || commonPrefix > base.length) throw new Error(`Invalid LLM request journal common prefix for ${requestId}`);
  return [...base.slice(0, commonPrefix), ...parseIds(row.appended_message_ids_json)];
}

export async function beginLlmRequestJournal(args: {
  sessionId?: string; purpose?: LlmRequestPurpose; iteration?: number; systemPrompt: string; toolDefinitions: ToolDefinition[];
  messages: Message[]; requestedModelKey: string; promptCacheKey: string;
}): Promise<{ requestId: string }> {
  await initLlmRequestJournal();
  const promptObjectId = await ensureObject('prompt', args.systemPrompt);
  const toolSchemaObjectId = await ensureObject('tool-schema', args.toolDefinitions);
  const messageObjectIds: string[] = [];
  for (const message of args.messages) messageObjectIds.push(await ensureObject('message', message));
  const requestId = randomUUID();
  let baseRequestId: string | undefined;
  let commonPrefixLength = 0;
  let deltaDepth = 0;
  if (args.sessionId) {
    const prior: any = getDb().prepare('SELECT request_id,delta_depth FROM llm_journal_requests WHERE session_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(args.sessionId);
    if (prior && Number(prior.delta_depth) < MAX_DELTA_DEPTH) {
      const priorIds = reconstructMessageIdsSync(prior.request_id);
      while (commonPrefixLength < priorIds.length && commonPrefixLength < messageObjectIds.length && priorIds[commonPrefixLength] === messageObjectIds[commonPrefixLength]) commonPrefixLength++;
      baseRequestId = prior.request_id;
      deltaDepth = Number(prior.delta_depth) + 1;
    }
  }
  const record: RequestRecord = {
    v: 1, kind: 'request', requestId, sessionId: args.sessionId, purpose: args.purpose || 'low-level', iteration: args.iteration || 0,
    createdAt: Date.now(), promptObjectId, toolSchemaObjectId, requestedModelKey: args.requestedModelKey,
    promptCacheKeyHash: sha256(args.promptCacheKey), messageCount: messageObjectIds.length, deltaDepth,
    ...(baseRequestId ? { baseRequestId, commonPrefixLength, appendedMessageObjectIds: messageObjectIds.slice(commonPrefixLength) } : { checkpointMessageObjectIds: messageObjectIds }),
  };
  await appendRecord(record);
  return { requestId };
}

export async function appendLlmAttemptStart(args: Omit<AttemptStartRecord, 'v'|'kind'|'eventId'|'startedAt'|'semanticPayloadSha256'> & { startedAt?: number; semanticPayload: unknown }): Promise<void> {
  const { semanticPayload, ...rest } = args;
  await appendRecord({ v: 1, kind: 'attempt-start', eventId: randomUUID(), startedAt: args.startedAt || Date.now(), ...rest, semanticPayloadSha256: hashJournalValue(semanticPayload) });
}
export async function appendLlmAttemptResult(args: Omit<AttemptResultRecord, 'v'|'kind'|'eventId'|'completedAt'> & { completedAt?: number }): Promise<void> {
  await appendRecord({ v: 1, kind: 'attempt-result', eventId: randomUUID(), completedAt: args.completedAt || Date.now(), ...args });
}

function objectValue<T>(objectId: string, expectedKind?: ObjectKind): T {
  const row: any = getDb().prepare('SELECT object_kind,payload FROM llm_journal_objects WHERE object_id=?').get(objectId);
  if (!row) throw new Error(`LLM request journal object ${objectId} not found`);
  if (expectedKind && row.object_kind !== expectedKind) throw new Error(`LLM request journal object ${objectId} has kind ${row.object_kind}, expected ${expectedKind}`);
  const expectedId = sha256(`${row.object_kind}\0${row.payload}`);
  if (expectedId !== objectId) throw new Error(`LLM request journal object hash mismatch for ${objectId}`);
  return JSON.parse(row.payload) as T;
}

export async function reconstructLlmRequest(requestId: string): Promise<ReconstructedLlmRequest | { requestId: string; completeness: 'legacy-partial'; missing: string[] } | { requestId: string; completeness: 'corrupt'; errors: string[] }> {
  await initLlmRequestJournal();
  const row: any = getDb().prepare('SELECT * FROM llm_journal_requests WHERE request_id=?').get(requestId);
  if (!row) return { requestId, completeness: 'legacy-partial', missing: ['request-manifest','system-prompt','tool-schema','canonical-messages'] };
  try {
    const requestRecord = requestRecordFromRow(row);
    assertRequestRecord(requestRecord);
    validateRequestManifestSync(requestId);
    const ids = reconstructMessageIdsSync(requestId);
    const startRows = getDb().prepare('SELECT * FROM llm_journal_attempt_starts WHERE request_id=? ORDER BY attempt,started_at').all(requestId) as any[];
    const resultRows = getDb().prepare('SELECT * FROM llm_journal_attempt_results WHERE request_id=? ORDER BY attempt,completed_at').all(requestId) as any[];
    const starts = startRows.map(attemptStartRecordFromRow);
    const results = resultRows.map(attemptResultRecordFromRow);
    const startsByAttempt = new Map<number, AttemptStartRecord>();
    const resultsByAttempt = new Map<number, AttemptResultRecord>();
    for (const start of starts) {
      assertAttemptStartRecord(start);
      if (start.requestId !== requestId || startsByAttempt.has(start.attempt)) throw new Error(`Invalid or duplicate LLM journal attempt start for ${requestId}`);
      startsByAttempt.set(start.attempt, start);
    }
    for (const result of results) {
      assertAttemptResultRecord(result);
      if (result.requestId !== requestId || !startsByAttempt.has(result.attempt) || resultsByAttempt.has(result.attempt)) throw new Error(`Invalid, orphaned, or duplicate LLM journal attempt result for ${requestId}`);
      resultsByAttempt.set(result.attempt, result);
    }
    return {
      requestId, sessionId: requestRecord.sessionId, purpose: requestRecord.purpose, iteration: requestRecord.iteration, createdAt: requestRecord.createdAt,
      systemPrompt: objectValue<string>(requestRecord.promptObjectId, 'prompt'), toolDefinitions: objectValue<ToolDefinition[]>(requestRecord.toolSchemaObjectId, 'tool-schema'),
      messages: ids.map(id => objectValue<Message>(id, 'message')), requestedModelKey: requestRecord.requestedModelKey, promptCacheKeyHash: requestRecord.promptCacheKeyHash,
      attempts: starts.map(start => ({ start, result: resultsByAttempt.get(start.attempt) })), completeness: 'complete',
    };
  } catch (error: any) {
    return { requestId, completeness: 'corrupt', errors: [error?.message || String(error)] };
  }
}

export async function listLlmRequestJournal(options: { sessionId?: string; purpose?: LlmRequestPurpose; limit?: number; before?: LlmRequestJournalCursor } = {}): Promise<LlmRequestJournalSummary[]> {
  await initLlmRequestJournal();
  const conditions: string[] = [];
  const params: Array<string | number> = [];
  if (options.sessionId) { conditions.push('session_id=?'); params.push(options.sessionId); }
  if (options.purpose) { conditions.push('purpose=?'); params.push(options.purpose); }
  if (options.before && Number.isFinite(options.before.createdAt) && typeof options.before.requestId === 'string') {
    conditions.push('(created_at < ? OR (created_at = ? AND request_id < ?))');
    params.push(options.before.createdAt, options.before.createdAt, options.before.requestId);
  }
  const limit = Math.max(1, Math.min(1000, Math.floor(options.limit || 100)));
  const rows = getDb().prepare(`SELECT request_id,session_id,purpose,iteration,created_at,requested_model_key,message_count
    FROM llm_journal_requests ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
    ORDER BY created_at DESC, request_id DESC LIMIT ?`).all(...params, limit) as any[];
  return rows.map(row => ({ requestId: row.request_id, sessionId: row.session_id || undefined, purpose: row.purpose, iteration: row.iteration,
    createdAt: row.created_at, requestedModelKey: row.requested_model_key, messageCount: row.message_count }));
}

export type LegacyLlmJournalMigrationSource = { filePath: string; relativeStatePath: string; sha256: string; recordCount: number };

export function markLlmJournalSqliteAuthority(migrationId: string): void {
  openStore();
  getDb().prepare('INSERT OR REPLACE INTO llm_journal_metadata(key,value) VALUES(?,?)').run('sqlite_authority_migration', migrationId);
}

export function hasLlmJournalSqliteAuthority(migrationId: string): boolean {
  openStore();
  const row: any = getDb().prepare('SELECT value FROM llm_journal_metadata WHERE key=?').get('sqlite_authority_migration');
  return row?.value === migrationId;
}

function journalRecordFromSqlite(record: JournalRecord): JournalRecord | null {
  if (record.kind === 'object') {
    const row: any = getDb().prepare('SELECT object_id,object_kind,payload,created_at FROM llm_journal_objects WHERE object_id=?').get(record.objectId);
    return row ? { v: 1, kind: 'object', objectId: row.object_id, objectKind: row.object_kind, payload: row.payload, createdAt: row.created_at } : null;
  }
  if (record.kind === 'request') {
    const row: any = getDb().prepare('SELECT * FROM llm_journal_requests WHERE request_id=?').get(record.requestId);
    return row ? requestRecordFromRow(row) : null;
  }
  if (record.kind === 'attempt-start') {
    const row: any = getDb().prepare('SELECT * FROM llm_journal_attempt_starts WHERE event_id=?').get(record.eventId);
    return row ? attemptStartRecordFromRow(row) : null;
  }
  const row: any = getDb().prepare('SELECT * FROM llm_journal_attempt_results WHERE event_id=?').get(record.eventId);
  return row ? attemptResultRecordFromRow(row) : null;
}

/** Migration-only: import and strictly verify the active legacy LLM journal JSONL. */
export async function migrateLegacyLlmRequestJournalToSqlite(): Promise<LegacyLlmJournalMigrationSource[]> {
  openStore();
  if (!await fs.pathExists(JOURNAL_PATH)) return [];
  return withJournalFileLock(async () => {
    await importJournalJsonl();
    let recordCount = 0;
    const requestIds = new Set<string>();
    await streamJournalLinesStrict(JOURNAL_PATH, line => {
      let raw: any;
      try { raw = JSON.parse(line); } catch { throw new Error('Malformed legacy LLM request journal JSONL'); }
      if (raw?.v !== 1 || !['object','request','attempt-start','attempt-result'].includes(raw.kind)) throw new Error('Invalid legacy LLM request journal record kind');
      if (raw.kind === 'object') assertObjectRecord(raw);
      else if (raw.kind === 'request') assertRequestRecord(raw);
      else if (raw.kind === 'attempt-start') assertAttemptStartRecord(raw);
      else assertAttemptResultRecord(raw);
      const stored = journalRecordFromSqlite(raw as JournalRecord);
      if (!stored || canonicalJournalJson(stored) !== canonicalJournalJson(raw)) throw new Error(`Legacy LLM request journal conflict for ${raw.objectId || raw.requestId || raw.eventId}`);
      if (raw.kind === 'request') validateRequestManifestSync(raw.requestId);
      if (typeof raw.requestId === 'string') requestIds.add(raw.requestId);
      recordCount += 1;
    });
    for (const requestId of requestIds) {
      if (!getDb().prepare('SELECT 1 FROM llm_journal_requests WHERE request_id=?').get(requestId)) throw new Error(`Legacy LLM attempt references missing request ${requestId}`);
      const reconstructed = await reconstructLlmRequest(requestId);
      if (reconstructed.completeness !== 'complete') throw new Error(`Legacy LLM request ${requestId} failed reconstruction verification`);
    }
    const integrity: any = getDb().prepare('PRAGMA integrity_check').get();
    if (!integrity || Object.values(integrity)[0] !== 'ok') throw new Error(`llm-request-journal.sqlite integrity_check failed: ${JSON.stringify(integrity)}`);
    if ((getDb().prepare('PRAGMA foreign_key_check').all() as any[]).length) throw new Error('llm-request-journal.sqlite foreign_key_check failed');
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(JOURNAL_PATH)) hash.update(chunk as Buffer);
    return [{ filePath: JOURNAL_PATH, relativeStatePath: path.relative(STATE_DIR, JOURNAL_PATH), sha256: hash.digest('hex'), recordCount }];
  });
}

async function streamJournalLinesStrict(filePath: string, onLine: (line: string) => void): Promise<void> {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  await streamJsonlLines(stream, onLine);
}

/** Export the SQLite-authoritative canonical LLM journal in migration-compatible JSONL. */
export async function exportLlmRequestJournalJsonl(outputPath: string): Promise<{ records: number }> {
  await initLlmRequestJournal();
  await fs.ensureDir(path.dirname(outputPath));
  const temporaryPath = `${outputPath}.${process.pid}.${Date.now()}.tmp`;
  const exportDb = new DatabaseSync(LLM_REQUEST_JOURNAL_DB_PATH, { readOnly: true });
  const fileDescriptor = fs.openSync(temporaryPath, 'w', 0o600);
  let records = 0;
  let buffered = '';
  const writeRecord = (record: JournalRecord): void => {
    buffered += `${JSON.stringify(record)}\n`;
    records += 1;
    if (buffered.length >= 256 * 1024) {
      fs.writeSync(fileDescriptor, buffered);
      buffered = '';
    }
  };
  try {
    exportDb.exec('PRAGMA query_only = ON; BEGIN');
    for (const row of exportDb.prepare('SELECT * FROM llm_journal_objects ORDER BY rowid').iterate() as Iterable<any>) writeRecord({ v: 1, kind: 'object', objectId: row.object_id, objectKind: row.object_kind, payload: row.payload, createdAt: row.created_at });
    for (const row of exportDb.prepare('SELECT * FROM llm_journal_requests ORDER BY rowid').iterate() as Iterable<any>) writeRecord(requestRecordFromRow(row));
    for (const row of exportDb.prepare('SELECT * FROM llm_journal_attempt_starts ORDER BY rowid').iterate() as Iterable<any>) writeRecord(attemptStartRecordFromRow(row));
    for (const row of exportDb.prepare('SELECT * FROM llm_journal_attempt_results ORDER BY rowid').iterate() as Iterable<any>) writeRecord(attemptResultRecordFromRow(row));
    exportDb.exec('COMMIT');
    if (buffered) fs.writeSync(fileDescriptor, buffered);
    fs.fsyncSync(fileDescriptor);
    fs.closeSync(fileDescriptor);
    exportDb.close();
    await fs.move(temporaryPath, outputPath, { overwrite: true });
    const directory = await nodeFs.open(path.dirname(outputPath), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
    return { records };
  } catch (error) {
    try { exportDb.exec('ROLLBACK'); } catch {}
    try { fs.closeSync(fileDescriptor); } catch {}
    try { exportDb.close(); } catch {}
    await fs.remove(temporaryPath).catch((): void => {});
    throw error;
  }
}

export function setLlmRequestJournalFaultInjectorForTests(injector: ((phase: string, record: JournalRecord) => void) | null): void { writeFaultInjector = injector; }
export async function getLlmRequestJournalStatsForTests(): Promise<{ objects: number; requests: number }> {
  await initLlmRequestJournal();
  const objects: any = getDb().prepare('SELECT COUNT(*) AS count FROM llm_journal_objects').get();
  const requests: any = getDb().prepare('SELECT COUNT(*) AS count FROM llm_journal_requests').get();
  return { objects: Number(objects?.count) || 0, requests: Number(requests?.count) || 0 };
}
export async function getLlmRequestManifestForTests(requestId: string): Promise<{ deltaDepth: number; checkpoint: boolean; baseRequestId?: string } | null> {
  await initLlmRequestJournal();
  const row: any = getDb().prepare('SELECT delta_depth,checkpoint_message_ids_json,base_request_id FROM llm_journal_requests WHERE request_id=?').get(requestId);
  return row ? { deltaDepth: row.delta_depth, checkpoint: !!row.checkpoint_message_ids_json, baseRequestId: row.base_request_id || undefined } : null;
}
export async function replaceLlmJournalPromptPayloadForTests(requestId: string, payload: string): Promise<string> {
  await initLlmRequestJournal();
  const row: any = getDb().prepare(`SELECT o.object_id,o.payload FROM llm_journal_requests r JOIN llm_journal_objects o ON o.object_id=r.prompt_object_id WHERE r.request_id=?`).get(requestId);
  if (!row) throw new Error(`Request ${requestId} not found`);
  getDb().prepare('UPDATE llm_journal_objects SET payload=? WHERE object_id=?').run(payload, row.object_id);
  return row.payload;
}
export async function replaceLlmJournalMessageCountForTests(requestId: string, messageCount: number): Promise<number> {
  await initLlmRequestJournal();
  const row: any = getDb().prepare('SELECT message_count FROM llm_journal_requests WHERE request_id=?').get(requestId);
  if (!row) throw new Error(`Request ${requestId} not found`);
  getDb().prepare('UPDATE llm_journal_requests SET message_count=? WHERE request_id=?').run(messageCount, requestId);
  return row.message_count;
}
export async function replaceLlmJournalCreatedAtForTests(requestIds: string[], createdAt: number): Promise<void> {
  await initLlmRequestJournal();
  const update = getDb().prepare('UPDATE llm_journal_requests SET created_at=? WHERE request_id=?');
  runInTransaction(() => { for (const requestId of requestIds) update.run(createdAt, requestId); });
}
export async function replaceLlmJournalRequestIdentityForTests(requestId: string, values: { purpose: string; promptCacheKeyHash: string; iteration: number }): Promise<{ purpose: string; promptCacheKeyHash: string; iteration: number }> {
  await initLlmRequestJournal();
  const row: any = getDb().prepare('SELECT purpose,prompt_cache_key_hash,iteration FROM llm_journal_requests WHERE request_id=?').get(requestId);
  if (!row) throw new Error(`Request ${requestId} not found`);
  getDb().prepare('UPDATE llm_journal_requests SET purpose=?,prompt_cache_key_hash=?,iteration=? WHERE request_id=?').run(values.purpose, values.promptCacheKeyHash, values.iteration, requestId);
  return { purpose: row.purpose, promptCacheKeyHash: row.prompt_cache_key_hash, iteration: row.iteration };
}
export async function replaceLlmJournalAttemptStartHashForTests(requestId: string, hash: string): Promise<string> {
  await initLlmRequestJournal();
  const row: any = getDb().prepare('SELECT event_id,semantic_payload_sha256 FROM llm_journal_attempt_starts WHERE request_id=? ORDER BY attempt LIMIT 1').get(requestId);
  if (!row) throw new Error(`Attempt start for ${requestId} not found`);
  getDb().prepare('UPDATE llm_journal_attempt_starts SET semantic_payload_sha256=? WHERE event_id=?').run(hash, row.event_id);
  return row.semantic_payload_sha256;
}
export async function replaceLlmJournalAttemptResultOutcomeForTests(requestId: string, outcome: string): Promise<string> {
  await initLlmRequestJournal();
  const row: any = getDb().prepare('SELECT event_id,outcome FROM llm_journal_attempt_results WHERE request_id=? ORDER BY attempt LIMIT 1').get(requestId);
  if (!row) throw new Error(`Attempt result for ${requestId} not found`);
  getDb().prepare('UPDATE llm_journal_attempt_results SET outcome=? WHERE event_id=?').run(outcome, row.event_id);
  return row.outcome;
}
export function resetLlmRequestJournalForTests(): void { try { db?.close(); } catch {} db = null; initialized = false; initPromise = null; }
