import crypto from 'crypto';
import fs from 'fs-extra';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { replaceLoneSurrogates } from './utils/unicode';

export const ARCHIVE_SEARCH_SCHEMA_VERSION = 1;
export const ARCHIVE_SEARCH_NORMALIZER_VERSION = 1;
export const ARCHIVE_SEARCH_MAX_QUERY_LENGTH = 2000;
export const ARCHIVE_SEARCH_MAX_IDENTIFIERS = 4;
export const ARCHIVE_SEARCH_MAX_TERMS = 12;
export const ARCHIVE_SEARCH_MAX_EXPRESSION_LENGTH = 4096;
export const ARCHIVE_SEARCH_MAX_SCOPE_SESSIONS = 64;
export const ARCHIVE_SEARCH_MAX_LANE_RESULTS = 200;

const HAN_BIGRAM_SENTINEL = '\u241f';
const COMMON_QUERY_TERMS = new Set([
  'about', 'after', 'again', 'before', 'current', 'details', 'find', 'from', 'have', 'into', 'latest',
  'message', 'please', 'recall', 'search', 'session', 'show', 'that', 'this', 'tool', 'using', 'what', 'when',
  'where', 'which', 'with', 'would', 'your',
]);

const ARCHIVE_SEARCH_INSERT_TRIGGER_SQL = `
  CREATE TRIGGER archive_search_documents_ai AFTER INSERT ON archive_search_documents BEGIN
    INSERT INTO archive_search_fts(rowid, index_text) VALUES (new.rowid, new.index_text);
  END
`;

const ARCHIVE_SEARCH_DELETE_TRIGGER_SQL = `
  CREATE TRIGGER archive_search_documents_ad AFTER DELETE ON archive_search_documents BEGIN
    INSERT INTO archive_search_fts(archive_search_fts, rowid, index_text)
      VALUES ('delete', old.rowid, old.index_text);
  END
`;

const ARCHIVE_SEARCH_UPDATE_TRIGGER_SQL = `
  CREATE TRIGGER archive_search_documents_au AFTER UPDATE ON archive_search_documents BEGIN
    INSERT INTO archive_search_fts(archive_search_fts, rowid, index_text)
      VALUES ('delete', old.rowid, old.index_text);
    INSERT INTO archive_search_fts(rowid, index_text) VALUES (new.rowid, new.index_text);
  END
`;

export type ArchiveSearchMemoryKind = 'raw' | 'block' | 'fact';

export type ArchiveSearchDocumentInput = {
  sessionId: string;
  agent?: string;
  memoryKind: ArchiveSearchMemoryKind;
  sourceKey: string;
  sourceFamily: string;
  text: string;
  seq?: number;
  startSeq?: number;
  endSeq?: number;
  rawStartSeq?: number;
  rawEndSeq?: number;
  timestamp?: number;
  blockId?: number;
  blockLevel?: number;
};

export type PreparedArchiveSearchDocument = Omit<ArchiveSearchDocumentInput, 'text'> & {
  agent: string;
  indexText: string;
  contentHash: string;
};

export type ArchiveSearchCheckpoint = {
  rawLastIndexedSeq: number;
  lastIndexedBlockId: number;
  updatedAt: number;
};

export type ArchiveSearchQueryLane = 'identifier' | 'prose';

export type CompiledArchiveSearchQuery = {
  normalizedQuery: string;
  identifiers: string[];
  proseTerms: string[];
  identifierMatch?: string;
  proseMatch?: string;
};

export type ArchiveSearchQueryScope = {
  sessionIds?: string[];
  agent?: string;
  lineageSessions?: Array<{ sessionId: string; maxMessageSeq?: number; maxBlockId?: number }>;
};

export type ArchiveSearchQueryResult = {
  lane: ArchiveSearchQueryLane;
  rank: number;
  bm25: number;
  rowid: number;
  sessionId: string;
  agent: string;
  memoryKind: ArchiveSearchMemoryKind;
  sourceKey: string;
  sourceFamily: string;
  seq?: number;
  startSeq?: number;
  endSeq?: number;
  rawStartSeq?: number;
  rawEndSeq?: number;
  timestamp?: number;
  blockId?: number;
  blockLevel?: number;
};

export type ArchiveSearchStatus = {
  schemaVersion: number;
  normalizerVersion: number;
  documentCount: number;
  rawCount: number;
  blockCount: number;
  factCount: number;
};

export type ArchiveSearchIndexOptions = {
  beforeCheckpointWrite?: () => void;
};

export class ArchiveSearchRebuildRequiredError extends Error {
  readonly code = 'ARCHIVE_SEARCH_REBUILD_REQUIRED';
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveSearchRebuildRequiredError';
  }
}

export function normalizeArchiveSearchText(value: unknown): string {
  return replaceLoneSurrogates(String(value || '')).text.normalize('NFKC').toLowerCase();
}

export function buildHanBigramTokens(value: string): string[] {
  const normalized = normalizeArchiveSearchText(value);
  const tokens = new Set<string>();
  for (const match of normalized.matchAll(/[\p{Script=Han}]{2,}/gu)) {
    const characters = [...match[0]];
    for (let index = 0; index < characters.length - 1; index += 1) {
      tokens.add(`${HAN_BIGRAM_SENTINEL}${characters[index]}${characters[index + 1]}${HAN_BIGRAM_SENTINEL}`);
    }
  }
  return [...tokens].sort();
}

export function buildArchiveSearchIndexText(value: string): string {
  const normalized = normalizeArchiveSearchText(value).trim();
  if (!normalized) return '';
  const grams = buildHanBigramTokens(normalized);
  return grams.length > 0 ? `${normalized}\n${grams.join(' ')}` : normalized;
}

function isStrongIdentifier(value: string): boolean {
  if (value.length < 4 || value.length > 160) return false;
  if (/^[0-9a-f]{7,64}$/i.test(value)) return true;
  if (/^\/[\p{L}\p{N}_-]+(?:\s+[\p{L}\p{N}_-]+)?$/u.test(value)) return true;
  if (/^[\p{L}\p{N}][\p{L}\p{N}_/:.\-]*[_/:.\-][\p{L}\p{N}_/:.\-]*$/u.test(value)) return true;
  if (/^[\p{Lu}][\p{L}\p{N}]*(?:[\p{Lu}][\p{L}\p{N}]*)+$/u.test(value)) return true;
  if (/^[\p{L}\p{N}]+(?:_[\p{L}\p{N}]+)+$/u.test(value)) return true;
  return /^\d{4,}$/.test(value);
}

function quoteFtsTerm(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function boundMatchExpression(terms: string[], operator: 'OR' | 'AND'): string | undefined {
  const accepted: string[] = [];
  for (const term of terms) {
    const next = [...accepted, quoteFtsTerm(term)].join(` ${operator} `);
    if (next.length > ARCHIVE_SEARCH_MAX_EXPRESSION_LENGTH) break;
    accepted.push(quoteFtsTerm(term));
  }
  return accepted.length > 0 ? accepted.join(` ${operator} `) : undefined;
}

export function compileArchiveSearchQuery(query: string): CompiledArchiveSearchQuery {
  const bounded = String(query || '').slice(0, ARCHIVE_SEARCH_MAX_QUERY_LENGTH);
  const normalizedQuery = normalizeArchiveSearchText(bounded).trim();
  const identifiers = new Set<string>();
  const addIdentifierMatches = (regex: RegExp) => {
    for (const match of bounded.matchAll(regex)) {
      const originalValue = match[0].replace(/[),.;!?]+$/u, '').trim();
      const value = normalizeArchiveSearchText(originalValue);
      if (isStrongIdentifier(originalValue)) identifiers.add(value);
    }
  };
  addIdentifierMatches(/[\p{L}\p{N}][\p{L}\p{N}_/:.\-]{2,159}/gu);
  addIdentifierMatches(/\b[0-9a-fA-F]{7,64}\b/g);
  addIdentifierMatches(/\/[\p{L}\p{N}_-]+(?:\s+[\p{L}\p{N}_-]+)?/gu);

  const proseTerms = new Set<string>();
  for (const match of normalizedQuery.matchAll(/[\p{L}\p{N}]{3,}/gu)) {
    const term = match[0];
    if (!COMMON_QUERY_TERMS.has(term) && !identifiers.has(term)) proseTerms.add(term);
    if (proseTerms.size >= ARCHIVE_SEARCH_MAX_TERMS) break;
  }
  for (const match of normalizedQuery.matchAll(/[\p{Script=Han}]{2,}/gu)) {
    const run = match[0];
    const characters = [...run];
    if (characters.length >= 3) proseTerms.add(run);
    for (let index = 0; index < characters.length - 1 && proseTerms.size < ARCHIVE_SEARCH_MAX_TERMS; index += 1) {
      proseTerms.add(`${HAN_BIGRAM_SENTINEL}${characters[index]}${characters[index + 1]}${HAN_BIGRAM_SENTINEL}`);
    }
  }

  const identifierList = [...identifiers]
    .sort((a, b) => b.length - a.length || a.localeCompare(b))
    .slice(0, ARCHIVE_SEARCH_MAX_IDENTIFIERS);
  const proseList = [...proseTerms].slice(0, ARCHIVE_SEARCH_MAX_TERMS);
  return {
    normalizedQuery,
    identifiers: identifierList,
    proseTerms: proseList,
    identifierMatch: boundMatchExpression(identifierList, 'OR'),
    proseMatch: boundMatchExpression(proseList, 'AND'),
  };
}

export function prepareArchiveSearchDocument(input: ArchiveSearchDocumentInput): PreparedArchiveSearchDocument {
  const sessionId = input.sessionId.trim();
  const sourceKey = input.sourceKey.trim();
  const sourceFamily = input.sourceFamily.trim();
  if (!sessionId || !sourceKey || !sourceFamily) throw new Error('Archive search document identity fields are required.');
  if (!['raw', 'block', 'fact'].includes(input.memoryKind)) throw new Error(`Invalid archive search memory kind: ${input.memoryKind}`);
  if (input.memoryKind === 'raw' && !Number.isSafeInteger(input.seq)) throw new Error('Raw archive search documents require a safe integer seq.');
  if ((input.memoryKind === 'block' || input.memoryKind === 'fact') && !Number.isSafeInteger(input.blockId)) {
    throw new Error(`${input.memoryKind} archive search documents require a safe integer blockId.`);
  }
  const indexText = buildArchiveSearchIndexText(input.text);
  if (!indexText) throw new Error('Archive search documents require nonempty canonical text.');
  const contentHash = crypto.createHash('sha256')
    .update(String(ARCHIVE_SEARCH_NORMALIZER_VERSION)).update('\0')
    .update(input.memoryKind).update('\0').update(indexText)
    .digest('hex');
  const { text: _sourceText, ...metadata } = input;
  return { ...metadata, sessionId, sourceKey, sourceFamily, agent: input.agent?.trim() || 'main', indexText, contentHash };
}

function nullableSafeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) ? Number(value) : null;
}

function normalizeSqlDefinition(value: unknown): string {
  return String(value || '').replace(/\s+/g, ' ').trim().replace(/;+$/g, '').trim().toLowerCase();
}

function mostRestrictiveCap(current: number | undefined, next: number | undefined): number | undefined {
  if (current === undefined) return next;
  if (next === undefined) return current;
  return Math.min(current, next);
}

function normalizeLineageScope(
  input: Array<{ sessionId: string; maxMessageSeq?: number; maxBlockId?: number }>,
): Array<{ sessionId: string; maxMessageSeq?: number; maxBlockId?: number }> {
  const bySession = new Map<string, { sessionId: string; maxMessageSeq?: number; maxBlockId?: number }>();
  for (const entry of input) {
    const sessionId = String(entry.sessionId || '').trim();
    if (!sessionId) throw new Error('Archive search lineage Session IDs must be nonempty.');
    const maxMessageSeq = entry.maxMessageSeq === undefined ? undefined : Math.max(0, Math.floor(entry.maxMessageSeq));
    const maxBlockId = entry.maxBlockId === undefined ? undefined : Math.max(0, Math.floor(entry.maxBlockId));
    const existing = bySession.get(sessionId);
    if (!existing) {
      bySession.set(sessionId, { sessionId, maxMessageSeq, maxBlockId });
    } else {
      existing.maxMessageSeq = mostRestrictiveCap(existing.maxMessageSeq, maxMessageSeq);
      existing.maxBlockId = mostRestrictiveCap(existing.maxBlockId, maxBlockId);
    }
  }
  return [...bySession.values()];
}

function runTransaction<T>(db: DatabaseSync, callback: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = callback();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

export class ArchiveSearchIndex {
  private readonly db: DatabaseSync;
  private readonly options: ArchiveSearchIndexOptions;
  private closed = false;

  private constructor(db: DatabaseSync, options: ArchiveSearchIndexOptions) {
    this.db = db;
    this.options = options;
  }

  static open(dbPath: string, options: ArchiveSearchIndexOptions = {}): ArchiveSearchIndex {
    if (!dbPath || !path.isAbsolute(dbPath)) throw new Error('Archive search DB path must be absolute.');
    fs.ensureDirSync(path.dirname(dbPath));
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA busy_timeout = 5000');
    const index = new ArchiveSearchIndex(db, options);
    try {
      index.initializeOrValidateSchema();
      return index;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Archive search index is closed.');
  }

  private initializeOrValidateSchema(): void {
    const metadataExists = !!this.db.prepare(`
      SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'archive_search_metadata'
    `).get();
    if (!metadataExists) {
      this.createSchema();
      return;
    }
    const rows = this.db.prepare(`SELECT key, value FROM archive_search_metadata`).all() as Array<{ key: string; value: string }>;
    const metadata = new Map(rows.map(row => [row.key, row.value]));
    const schemaVersion = Number(metadata.get('schema_version'));
    const normalizerVersion = Number(metadata.get('normalizer_version'));
    if (schemaVersion !== ARCHIVE_SEARCH_SCHEMA_VERSION || normalizerVersion !== ARCHIVE_SEARCH_NORMALIZER_VERSION) {
      throw new ArchiveSearchRebuildRequiredError(
        `Archive search DB requires rebuild (schema ${schemaVersion}/${ARCHIVE_SEARCH_SCHEMA_VERSION}, normalizer ${normalizerVersion}/${ARCHIVE_SEARCH_NORMALIZER_VERSION}).`,
      );
    }
    this.validateSchemaDefinition();
  }

  private requireSchemaObject(name: string, type: 'table' | 'trigger', clauses: string[]): void {
    const rows = this.db.prepare(`SELECT type, sql FROM sqlite_master WHERE name = ?`).all(name) as Array<{ type: string; sql: string }>;
    if (rows.length !== 1 || rows[0].type !== type) {
      throw new ArchiveSearchRebuildRequiredError(`Archive search object ${name} must be exactly one ${type}.`);
    }
    const sql = normalizeSqlDefinition(rows[0].sql);
    for (const clause of clauses.map(normalizeSqlDefinition)) {
      if (!sql.includes(clause)) {
        throw new ArchiveSearchRebuildRequiredError(`Archive search object ${name} has an incompatible definition.`);
      }
    }
  }

  private requireExactSchemaObject(name: string, type: 'table' | 'trigger', canonicalSql: string): void {
    const rows = this.db.prepare(`SELECT type, sql FROM sqlite_master WHERE name = ?`).all(name) as Array<{ type: string; sql: string }>;
    if (rows.length !== 1 || rows[0].type !== type) {
      throw new ArchiveSearchRebuildRequiredError(`Archive search object ${name} must be exactly one ${type}.`);
    }
    if (normalizeSqlDefinition(rows[0].sql) !== normalizeSqlDefinition(canonicalSql)) {
      throw new ArchiveSearchRebuildRequiredError(`Archive search object ${name} has an incompatible canonical definition.`);
    }
  }

  private requireTableColumns(tableName: string, required: Array<{ name: string; type: string; pk?: number; notnull?: number }>): void {
    const rows = this.db.prepare(`PRAGMA table_info(${tableName})`).all() as any[];
    const byName = new Map(rows.map(row => [String(row.name), row]));
    for (const expected of required) {
      const row = byName.get(expected.name);
      if (!row || String(row.type).toUpperCase() !== expected.type
        || (expected.pk !== undefined && Number(row.pk) !== expected.pk)
        || (expected.notnull !== undefined && Number(row.notnull) !== expected.notnull)) {
        throw new ArchiveSearchRebuildRequiredError(`Archive search table ${tableName} has incompatible column ${expected.name}.`);
      }
    }
  }

  private validateSchemaDefinition(): void {
    this.requireSchemaObject('archive_search_metadata', 'table', ['key text primary key', 'value text not null']);
    this.requireSchemaObject('archive_search_checkpoints', 'table', [
      'session_id text primary key', 'raw_last_indexed_seq integer not null', 'last_indexed_block_id integer not null',
    ]);
    this.requireSchemaObject('archive_search_documents', 'table', [
      'rowid integer primary key', 'unique(session_id, memory_kind, source_key)',
      "check(memory_kind in ('raw', 'block', 'fact'))",
    ]);
    this.requireSchemaObject('archive_search_fts', 'table', [
      'create virtual table archive_search_fts using fts5', "content='archive_search_documents'",
      "content_rowid='rowid'", "tokenize='trigram case_sensitive 1'",
    ]);
    this.requireExactSchemaObject('archive_search_documents_ai', 'trigger', ARCHIVE_SEARCH_INSERT_TRIGGER_SQL);
    this.requireExactSchemaObject('archive_search_documents_ad', 'trigger', ARCHIVE_SEARCH_DELETE_TRIGGER_SQL);
    this.requireExactSchemaObject('archive_search_documents_au', 'trigger', ARCHIVE_SEARCH_UPDATE_TRIGGER_SQL);
    this.requireTableColumns('archive_search_metadata', [
      { name: 'key', type: 'TEXT', pk: 1 }, { name: 'value', type: 'TEXT', notnull: 1 },
    ]);
    this.requireTableColumns('archive_search_checkpoints', [
      { name: 'session_id', type: 'TEXT', pk: 1 },
      { name: 'raw_last_indexed_seq', type: 'INTEGER', notnull: 1 },
      { name: 'last_indexed_block_id', type: 'INTEGER', notnull: 1 },
      { name: 'updated_at', type: 'INTEGER', notnull: 1 },
    ]);
    this.requireTableColumns('archive_search_documents', [
      { name: 'rowid', type: 'INTEGER', pk: 1 },
      { name: 'session_id', type: 'TEXT', notnull: 1 },
      { name: 'agent', type: 'TEXT', notnull: 1 },
      { name: 'memory_kind', type: 'TEXT', notnull: 1 },
      { name: 'source_key', type: 'TEXT', notnull: 1 },
      { name: 'source_family', type: 'TEXT', notnull: 1 },
      { name: 'index_text', type: 'TEXT', notnull: 1 },
      { name: 'content_hash', type: 'TEXT', notnull: 1 },
    ]);
    const uniqueIndexes = this.db.prepare(`PRAGMA index_list(archive_search_documents)`).all() as any[];
    const hasIdentity = uniqueIndexes.some(index => {
      if (Number(index.unique) !== 1) return false;
      const columns = (this.db.prepare(`PRAGMA index_info(${String(index.name)})`).all() as any[]).map(row => String(row.name));
      return columns.join(',') === 'session_id,memory_kind,source_key';
    });
    if (!hasIdentity) throw new ArchiveSearchRebuildRequiredError('Archive search document unique identity is incompatible.');
  }

  private createSchema(): void {
    runTransaction(this.db, () => {
      this.db.exec(`
        CREATE TABLE archive_search_metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        ) STRICT;
        CREATE TABLE archive_search_checkpoints (
          session_id TEXT PRIMARY KEY,
          raw_last_indexed_seq INTEGER NOT NULL DEFAULT 0,
          last_indexed_block_id INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE archive_search_documents (
          rowid INTEGER PRIMARY KEY,
          session_id TEXT NOT NULL,
          agent TEXT NOT NULL,
          memory_kind TEXT NOT NULL CHECK(memory_kind IN ('raw', 'block', 'fact')),
          source_key TEXT NOT NULL,
          source_family TEXT NOT NULL,
          seq INTEGER,
          start_seq INTEGER,
          end_seq INTEGER,
          raw_start_seq INTEGER,
          raw_end_seq INTEGER,
          timestamp INTEGER,
          block_id INTEGER,
          block_level INTEGER,
          index_text TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(session_id, memory_kind, source_key)
        ) STRICT;
        CREATE INDEX idx_archive_search_documents_session_kind
          ON archive_search_documents(session_id, memory_kind);
        CREATE INDEX idx_archive_search_documents_agent
          ON archive_search_documents(agent);
        CREATE INDEX idx_archive_search_documents_block
          ON archive_search_documents(session_id, block_id);
        CREATE VIRTUAL TABLE archive_search_fts USING fts5(
          index_text,
          content='archive_search_documents',
          content_rowid='rowid',
          tokenize='trigram case_sensitive 1'
        );
      `);
      this.db.exec(`${ARCHIVE_SEARCH_INSERT_TRIGGER_SQL};${ARCHIVE_SEARCH_DELETE_TRIGGER_SQL};${ARCHIVE_SEARCH_UPDATE_TRIGGER_SQL};`);
      this.db.prepare(`INSERT INTO archive_search_metadata(key, value) VALUES (?, ?)`).run('schema_version', String(ARCHIVE_SEARCH_SCHEMA_VERSION));
      this.db.prepare(`INSERT INTO archive_search_metadata(key, value) VALUES (?, ?)`).run('normalizer_version', String(ARCHIVE_SEARCH_NORMALIZER_VERSION));
      this.db.prepare(`INSERT INTO archive_search_metadata(key, value) VALUES (?, ?)`).run('build_generation', crypto.randomUUID());
    });
  }

  private upsertDocument(document: PreparedArchiveSearchDocument, now: number): void {
    this.db.prepare(`
      INSERT INTO archive_search_documents (
        session_id, agent, memory_kind, source_key, source_family,
        seq, start_seq, end_seq, raw_start_seq, raw_end_seq, timestamp,
        block_id, block_level, index_text, content_hash, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, memory_kind, source_key) DO UPDATE SET
        agent = excluded.agent,
        source_family = excluded.source_family,
        seq = excluded.seq,
        start_seq = excluded.start_seq,
        end_seq = excluded.end_seq,
        raw_start_seq = excluded.raw_start_seq,
        raw_end_seq = excluded.raw_end_seq,
        timestamp = excluded.timestamp,
        block_id = excluded.block_id,
        block_level = excluded.block_level,
        index_text = excluded.index_text,
        content_hash = excluded.content_hash,
        updated_at = excluded.updated_at
    `).run(
      document.sessionId, document.agent, document.memoryKind, document.sourceKey, document.sourceFamily,
      nullableSafeInteger(document.seq), nullableSafeInteger(document.startSeq), nullableSafeInteger(document.endSeq),
      nullableSafeInteger(document.rawStartSeq), nullableSafeInteger(document.rawEndSeq), nullableSafeInteger(document.timestamp),
      nullableSafeInteger(document.blockId), nullableSafeInteger(document.blockLevel), document.indexText, document.contentHash, now,
    );
  }

  private advanceCheckpoint(sessionId: string, checkpoint: Partial<ArchiveSearchCheckpoint>, now: number): void {
    this.options.beforeCheckpointWrite?.();
    const raw = Math.max(0, Math.floor(checkpoint.rawLastIndexedSeq ?? 0));
    const block = Math.max(0, Math.floor(checkpoint.lastIndexedBlockId ?? 0));
    this.db.prepare(`
      INSERT INTO archive_search_checkpoints(session_id, raw_last_indexed_seq, last_indexed_block_id, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        raw_last_indexed_seq = max(archive_search_checkpoints.raw_last_indexed_seq, excluded.raw_last_indexed_seq),
        last_indexed_block_id = max(archive_search_checkpoints.last_indexed_block_id, excluded.last_indexed_block_id),
        updated_at = excluded.updated_at
    `).run(sessionId, raw, block, now);
  }

  upsertRawDocuments(sessionId: string, inputs: ArchiveSearchDocumentInput[], rawLastIndexedSeq: number): void {
    this.assertOpen();
    const documents = inputs.map(prepareArchiveSearchDocument);
    if (documents.some(document => document.sessionId !== sessionId || document.memoryKind !== 'raw')) {
      throw new Error('Raw archive search batch identity mismatch.');
    }
    runTransaction(this.db, () => {
      const now = Date.now();
      documents.forEach(document => this.upsertDocument(document, now));
      this.advanceCheckpoint(sessionId, { rawLastIndexedSeq }, now);
    });
  }

  replaceBlockDocuments(
    sessionId: string,
    blockInput: ArchiveSearchDocumentInput,
    factInputs: ArchiveSearchDocumentInput[],
    lastIndexedBlockId: number,
  ): void {
    this.replaceBlockDocumentBatch(sessionId, [{ block: blockInput, facts: factInputs }], lastIndexedBlockId);
  }

  replaceBlockDocumentBatch(
    sessionId: string,
    entries: Array<{ block: ArchiveSearchDocumentInput; facts: ArchiveSearchDocumentInput[] }>,
    lastIndexedBlockId: number,
  ): void {
    this.assertOpen();
    const prepared = entries.map(entry => ({ block: prepareArchiveSearchDocument(entry.block), facts: entry.facts.map(prepareArchiveSearchDocument) }));
    for (const { block, facts } of prepared) {
      if (block.sessionId !== sessionId || block.memoryKind !== 'block' || !Number.isSafeInteger(block.blockId)) {
        throw new Error('Block archive search batch identity mismatch.');
      }
      if (facts.some(fact => fact.sessionId !== sessionId || fact.memoryKind !== 'fact'
        || fact.blockId !== block.blockId || fact.sourceFamily !== block.sourceFamily)) {
        throw new Error('Fact archive search batch must use its creating block family.');
      }
    }
    runTransaction(this.db, () => {
      const now = Date.now();
      const deleteFacts = this.db.prepare(`DELETE FROM archive_search_documents WHERE session_id = ? AND memory_kind = 'fact' AND block_id = ?`);
      for (const { block, facts } of prepared) {
        deleteFacts.run(sessionId, block.blockId!);
        this.upsertDocument(block, now);
        facts.forEach(fact => this.upsertDocument(fact, now));
      }
      this.advanceCheckpoint(sessionId, { lastIndexedBlockId }, now);
    });
  }

  deleteDocuments(sessionId: string, memoryKind?: ArchiveSearchMemoryKind): number {
    this.assertOpen();
    return runTransaction(this.db, () => {
      if (!memoryKind) {
        const result = this.db.prepare(`DELETE FROM archive_search_documents WHERE session_id = ?`).run(sessionId);
        this.db.prepare(`DELETE FROM archive_search_checkpoints WHERE session_id = ?`).run(sessionId);
        return Number(result.changes) || 0;
      }
      if (memoryKind === 'block') {
        const result = this.db.prepare(`
          DELETE FROM archive_search_documents
          WHERE session_id = ? AND (memory_kind = 'block' OR memory_kind = 'fact')
        `).run(sessionId);
        this.db.prepare(`
          UPDATE archive_search_checkpoints SET last_indexed_block_id = 0, updated_at = ? WHERE session_id = ?
        `).run(Date.now(), sessionId);
        return Number(result.changes) || 0;
      }
      const result = this.db.prepare(`DELETE FROM archive_search_documents WHERE session_id = ? AND memory_kind = ?`).run(sessionId, memoryKind);
      if (memoryKind === 'raw') {
        this.db.prepare(`
          UPDATE archive_search_checkpoints SET raw_last_indexed_seq = 0, updated_at = ? WHERE session_id = ?
        `).run(Date.now(), sessionId);
      } else {
        this.db.prepare(`
          UPDATE archive_search_checkpoints SET last_indexed_block_id = 0, updated_at = ? WHERE session_id = ?
        `).run(Date.now(), sessionId);
      }
      return Number(result.changes) || 0;
    });
  }

  getCheckpoint(sessionId: string): ArchiveSearchCheckpoint {
    this.assertOpen();
    const row = this.db.prepare(`
      SELECT raw_last_indexed_seq, last_indexed_block_id, updated_at
      FROM archive_search_checkpoints WHERE session_id = ?
    `).get(sessionId) as any;
    return {
      rawLastIndexedSeq: Number(row?.raw_last_indexed_seq) || 0,
      lastIndexedBlockId: Number(row?.last_indexed_block_id) || 0,
      updatedAt: Number(row?.updated_at) || 0,
    };
  }

  getStatus(): ArchiveSearchStatus {
    this.assertOpen();
    const row = this.db.prepare(`
      SELECT count(*) AS document_count,
        sum(CASE WHEN memory_kind = 'raw' THEN 1 ELSE 0 END) AS raw_count,
        sum(CASE WHEN memory_kind = 'block' THEN 1 ELSE 0 END) AS block_count,
        sum(CASE WHEN memory_kind = 'fact' THEN 1 ELSE 0 END) AS fact_count
      FROM archive_search_documents
    `).get() as any;
    return {
      schemaVersion: ARCHIVE_SEARCH_SCHEMA_VERSION,
      normalizerVersion: ARCHIVE_SEARCH_NORMALIZER_VERSION,
      documentCount: Number(row?.document_count) || 0,
      rawCount: Number(row?.raw_count) || 0,
      blockCount: Number(row?.block_count) || 0,
      factCount: Number(row?.fact_count) || 0,
    };
  }

  private queryLane(
    lane: ArchiveSearchQueryLane,
    matchExpression: string,
    scope: ArchiveSearchQueryScope,
    requestedLimit: number,
  ): ArchiveSearchQueryResult[] {
    const limit = Math.max(1, Math.min(ARCHIVE_SEARCH_MAX_LANE_RESULTS, Math.floor(requestedLimit) || 20));
    const rawLineage = normalizeLineageScope(scope.lineageSessions || []);
    const rawSessionIds = [...new Set((scope.sessionIds || []).filter(Boolean))];
    if (rawLineage.length > ARCHIVE_SEARCH_MAX_SCOPE_SESSIONS || rawSessionIds.length > ARCHIVE_SEARCH_MAX_SCOPE_SESSIONS) {
      throw new Error(`Archive search scope exceeds ${ARCHIVE_SEARCH_MAX_SCOPE_SESSIONS} Sessions.`);
    }
    const lineage = rawLineage;
    const sessionIds = rawSessionIds;
    if (lineage.length > 0 && sessionIds.length > 0) throw new Error('Archive search query scope cannot combine sessionIds and lineageSessions.');

    const cteParams: any[] = [];
    const predicateParams: any[] = [];
    let cte = '';
    let scopeJoin = '';
    const predicates = ['archive_search_fts MATCH ?'];
    predicateParams.push(matchExpression);

    if (lineage.length > 0) {
      cte = `WITH scope(session_id, max_message_seq, max_block_id) AS (VALUES ${lineage.map(() => '(?, ?, ?)').join(', ')})`;
      for (const entry of lineage) cteParams.push(entry.sessionId, entry.maxMessageSeq ?? null, entry.maxBlockId ?? null);
      scopeJoin = `JOIN scope ON scope.session_id = d.session_id`;
      predicates.push(`(
        (d.memory_kind = 'raw' AND (scope.max_message_seq IS NULL OR d.seq <= scope.max_message_seq))
        OR (d.memory_kind IN ('block', 'fact') AND (scope.max_block_id IS NULL OR d.block_id <= scope.max_block_id))
      )`);
    } else if (sessionIds.length > 0) {
      predicates.push(`d.session_id IN (${sessionIds.map(() => '?').join(', ')})`);
      predicateParams.push(...sessionIds);
    }
    if (scope.agent) {
      predicates.push('d.agent = ?');
      predicateParams.push(scope.agent);
    }
    const params = [...cteParams, ...predicateParams, limit];

    const rows = this.db.prepare(`
      ${cte}
      SELECT d.rowid, d.session_id, d.agent, d.memory_kind, d.source_key, d.source_family,
        d.seq, d.start_seq, d.end_seq, d.raw_start_seq, d.raw_end_seq, d.timestamp,
        d.block_id, d.block_level, bm25(archive_search_fts) AS bm25_score
      FROM archive_search_fts
      JOIN archive_search_documents d ON d.rowid = archive_search_fts.rowid
      ${scopeJoin}
      WHERE ${predicates.join(' AND ')}
      ORDER BY bm25_score ASC, d.rowid ASC
      LIMIT ?
    `).all(...params) as any[];

    return rows.map((row, index) => ({
      lane,
      rank: index + 1,
      bm25: Number(row.bm25_score),
      rowid: Number(row.rowid),
      sessionId: String(row.session_id),
      agent: String(row.agent),
      memoryKind: row.memory_kind,
      sourceKey: String(row.source_key),
      sourceFamily: String(row.source_family),
      ...(row.seq == null ? {} : { seq: Number(row.seq) }),
      ...(row.start_seq == null ? {} : { startSeq: Number(row.start_seq) }),
      ...(row.end_seq == null ? {} : { endSeq: Number(row.end_seq) }),
      ...(row.raw_start_seq == null ? {} : { rawStartSeq: Number(row.raw_start_seq) }),
      ...(row.raw_end_seq == null ? {} : { rawEndSeq: Number(row.raw_end_seq) }),
      ...(row.timestamp == null ? {} : { timestamp: Number(row.timestamp) }),
      ...(row.block_id == null ? {} : { blockId: Number(row.block_id) }),
      ...(row.block_level == null ? {} : { blockLevel: Number(row.block_level) }),
    }));
  }

  query(
    query: string,
    scope: ArchiveSearchQueryScope = {},
    requestedLimit: number = 20,
  ): { compiled: CompiledArchiveSearchQuery; identifier: ArchiveSearchQueryResult[]; prose: ArchiveSearchQueryResult[] } {
    this.assertOpen();
    const compiled = compileArchiveSearchQuery(query);
    if (compiled.identifierMatch && compiled.identifierMatch.length > ARCHIVE_SEARCH_MAX_EXPRESSION_LENGTH) {
      throw new Error('Archive search identifier MATCH expression exceeds its bound.');
    }
    if (compiled.proseMatch && compiled.proseMatch.length > ARCHIVE_SEARCH_MAX_EXPRESSION_LENGTH) {
      throw new Error('Archive search prose MATCH expression exceeds its bound.');
    }
    return {
      compiled,
      identifier: compiled.identifierMatch ? this.queryLane('identifier', compiled.identifierMatch, scope, requestedLimit) : [],
      prose: compiled.proseMatch ? this.queryLane('prose', compiled.proseMatch, scope, requestedLimit) : [],
    };
  }

  rebuildFtsFromDocuments(): void {
    this.assertOpen();
    runTransaction(this.db, () => {
      this.db.exec(`INSERT INTO archive_search_fts(archive_search_fts) VALUES ('rebuild')`);
    });
  }

  optimize(maxPages: number = 256): void {
    this.assertOpen();
    const boundedPages = Math.max(1, Math.min(4096, Math.floor(maxPages) || 256));
    this.db.prepare(`INSERT INTO archive_search_fts(archive_search_fts, rank) VALUES ('merge', ?)`).run(boundedPages);
    this.db.exec('PRAGMA optimize');
  }

  checkpointWal(): void {
    this.assertOpen();
    this.db.exec('PRAGMA wal_checkpoint(PASSIVE)');
  }

  close(): void {
    if (this.closed) return;
    try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch {}
    this.db.close();
    this.closed = true;
  }
}
