import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import {
  LLM_REQUEST_JOURNAL_AUTHORITY,
  LLM_REQUEST_JOURNAL_AUTHORITY_STATE_COMPLETE,
  LLM_REQUEST_JOURNAL_AUTHORITY_STATE_COPYING,
  LLM_REQUEST_JOURNAL_AUTHORITY_STATE_KEY,
  LLM_REQUEST_JOURNAL_SCHEMA_VERSION,
  type LlmJournalAttemptResultRecord,
  type LlmJournalAttemptStartRecord,
  type LlmJournalObjectRecord,
  type LlmJournalRecord,
  type LlmJournalRecordKind,
  type LlmJournalRequestRecord,
  type LlmJournalScanCursor,
  type LlmRequestJournalCursor,
  type LlmRequestJournalStore,
  type LlmRequestJournalSummary,
  type LlmRequestPurpose,
  canonicalJournalJson,
} from './llmRequestJournalStore';
import type { NormalizedLlmRequestJournalStorageConfig } from './config';

const MIGRATION_LOCK_KEY = 0x46574a31;
const REQUIRED_TABLE_COLUMNS: Record<string, Record<string, { type: string; nullable: boolean }>> = {
  metadata: {
    key: { type: 'text', nullable: false }, value: { type: 'text', nullable: false },
  },
  llm_journal_objects: {
    object_id: { type: 'text', nullable: false }, object_kind: { type: 'text', nullable: false },
    payload: { type: 'text', nullable: false }, created_at: { type: 'bigint', nullable: false },
  },
  llm_journal_requests: {
    request_id: { type: 'text', nullable: false }, session_id: { type: 'text', nullable: true }, purpose: { type: 'text', nullable: false },
    iteration: { type: 'bigint', nullable: false }, created_at: { type: 'bigint', nullable: false }, prompt_object_id: { type: 'text', nullable: false },
    tool_schema_object_id: { type: 'text', nullable: false }, requested_model_key: { type: 'text', nullable: false },
    prompt_cache_key_hash: { type: 'text', nullable: false }, message_count: { type: 'bigint', nullable: false },
    checkpoint_message_ids_json: { type: 'text', nullable: true }, base_request_id: { type: 'text', nullable: true },
    common_prefix_length: { type: 'bigint', nullable: true }, appended_message_ids_json: { type: 'text', nullable: true },
    delta_depth: { type: 'bigint', nullable: false },
  },
  llm_journal_attempt_starts: {
    event_id: { type: 'text', nullable: false }, request_id: { type: 'text', nullable: false }, attempt: { type: 'bigint', nullable: false },
    started_at: { type: 'bigint', nullable: false }, concrete_model_id: { type: 'text', nullable: false },
    virtual_model_key: { type: 'text', nullable: true }, provider_type: { type: 'text', nullable: false },
    semantic_payload_sha256: { type: 'text', nullable: false },
  },
  llm_journal_attempt_results: {
    event_id: { type: 'text', nullable: false }, request_id: { type: 'text', nullable: false }, attempt: { type: 'bigint', nullable: false },
    completed_at: { type: 'bigint', nullable: false }, outcome: { type: 'text', nullable: false },
    result_json: { type: 'text', nullable: true }, error_json: { type: 'text', nullable: true },
  },
};
const REQUIRED_IDENTITY_CONSTRAINTS: Record<string, string[]> = {
  metadata: ['key'],
  llm_journal_objects: ['object_id'],
  llm_journal_requests: ['request_id'],
  llm_journal_attempt_starts: ['event_id'],
  llm_journal_attempt_results: ['event_id'],
};

function quoteIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(value)) throw new Error('Invalid PostgreSQL Journal schema identifier.');
  return `"${value.replace(/"/g, '""')}"`;
}

function number(value: unknown, field: string): number {
  const result = typeof value === 'bigint' ? Number(value) : Number(value);
  if (!Number.isSafeInteger(result)) throw new Error(`Invalid PostgreSQL Journal ${field}.`);
  return result;
}

function parseIds(value: unknown): string[] | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string')) throw new Error('Invalid PostgreSQL Journal message ID list.');
  return parsed;
}

function objectFromRow(row: any): LlmJournalObjectRecord {
  return { v: 1, kind: 'object', objectId: row.object_id, objectKind: row.object_kind, payload: row.payload, createdAt: number(row.created_at, 'object timestamp') };
}
function requestFromRow(row: any): LlmJournalRequestRecord {
  return {
    v: 1, kind: 'request', requestId: row.request_id, sessionId: row.session_id || undefined, purpose: row.purpose,
    iteration: number(row.iteration, 'iteration'), createdAt: number(row.created_at, 'request timestamp'), promptObjectId: row.prompt_object_id,
    toolSchemaObjectId: row.tool_schema_object_id, requestedModelKey: row.requested_model_key, promptCacheKeyHash: row.prompt_cache_key_hash,
    messageCount: number(row.message_count, 'message count'), deltaDepth: number(row.delta_depth, 'delta depth'),
    ...(row.checkpoint_message_ids_json !== null ? { checkpointMessageObjectIds: parseIds(row.checkpoint_message_ids_json) } : {}),
    ...(row.base_request_id !== null ? { baseRequestId: row.base_request_id, commonPrefixLength: number(row.common_prefix_length, 'common prefix'), appendedMessageObjectIds: parseIds(row.appended_message_ids_json) } : {}),
  };
}
function attemptStartFromRow(row: any): LlmJournalAttemptStartRecord {
  return { v: 1, kind: 'attempt-start', eventId: row.event_id, requestId: row.request_id, attempt: number(row.attempt, 'attempt'), startedAt: number(row.started_at, 'attempt timestamp'), concreteModelId: row.concrete_model_id, virtualModelKey: row.virtual_model_key || undefined, providerType: row.provider_type, semanticPayloadSha256: row.semantic_payload_sha256 };
}
function attemptResultFromRow(row: any): LlmJournalAttemptResultRecord {
  return { v: 1, kind: 'attempt-result', eventId: row.event_id, requestId: row.request_id, attempt: number(row.attempt, 'attempt'), completedAt: number(row.completed_at, 'attempt result timestamp'), outcome: row.outcome, result: row.result_json ? JSON.parse(row.result_json) : undefined, error: row.error_json ? JSON.parse(row.error_json) : undefined };
}

export class PostgresLlmRequestJournalStore implements LlmRequestJournalStore {
  readonly backend = 'postgres' as const;
  private pool?: Pool;
  private initialized = false;
  private snapshotClient?: PoolClient;
  private readonly schemaSql: string;

  constructor(
    private readonly config: Extract<NormalizedLlmRequestJournalStorageConfig, { backend: 'postgres' }>,
    private readonly options: { requireExistingAuthority?: boolean } = {},
  ) {
    this.schemaSql = quoteIdentifier(config.schema);
  }

  private getPool(): Pool {
    if (!this.pool) {
      this.pool = new Pool({
        connectionString: this.config.connectionString,
        max: this.config.poolMax,
        connectionTimeoutMillis: this.config.connectTimeoutMs,
        idleTimeoutMillis: this.config.idleTimeoutMs,
        allowExitOnIdle: true,
        ssl: this.config.ssl ? { rejectUnauthorized: true } : undefined,
      });
    }
    return this.pool;
  }

  private async query<T extends QueryResultRow = any>(text: string, values: unknown[] = []): Promise<T[]> {
    const result = await (this.snapshotClient || this.getPool()).query<T>(text, values);
    return result.rows;
  }

  private async validateRequiredSchema(client: PoolClient): Promise<void> {
    const result = await client.query(`SELECT table_name,column_name,data_type,is_nullable FROM information_schema.columns WHERE table_schema=$1`, [this.config.schema]);
    const actual = new Map<string, Map<string, { type: string; nullable: boolean }>>();
    for (const row of result.rows) {
      let columns = actual.get(row.table_name);
      if (!columns) { columns = new Map(); actual.set(row.table_name, columns); }
      columns.set(row.column_name, { type: row.data_type, nullable: row.is_nullable === 'YES' });
    }
    for (const [table, expectedColumns] of Object.entries(REQUIRED_TABLE_COLUMNS)) {
      const columns = actual.get(table);
      if (!columns) throw new Error(`PostgreSQL LLM request journal required table ${table} is missing; restore it or choose a fresh empty schema.`);
      for (const [column, expected] of Object.entries(expectedColumns)) {
        const found = columns.get(column);
        if (!found || found.type !== expected.type || found.nullable !== expected.nullable) {
          throw new Error(`PostgreSQL LLM request journal required column ${table}.${column} is missing or incompatible; restore it or choose a fresh empty schema.`);
        }
      }
    }
    const constraints = await client.query(`
      SELECT tc.table_name,tc.constraint_type,
        array_agg(kcu.column_name ORDER BY kcu.ordinal_position) AS columns
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_catalog=tc.constraint_catalog
       AND kcu.constraint_schema=tc.constraint_schema
       AND kcu.constraint_name=tc.constraint_name
       AND kcu.table_name=tc.table_name
      WHERE tc.table_schema=$1 AND tc.constraint_type IN ('PRIMARY KEY','UNIQUE')
      GROUP BY tc.table_name,tc.constraint_name,tc.constraint_type
    `, [this.config.schema]);
    const identities = new Map<string, string[][]>();
    for (const row of constraints.rows) {
      const values = Array.isArray(row.columns) ? row.columns : String(row.columns || '').replace(/^\{|\}$/g, '').split(',').filter(Boolean);
      const current = identities.get(row.table_name) || [];
      current.push(values);
      identities.set(row.table_name, current);
    }
    for (const [table, expectedColumns] of Object.entries(REQUIRED_IDENTITY_CONSTRAINTS)) {
      const found = identities.get(table)?.some(columns => columns.length === expectedColumns.length
        && columns.every((column, index) => column === expectedColumns[index]));
      if (!found) {
        throw new Error(`PostgreSQL LLM request journal required identity constraint ${table}(${expectedColumns.join(',')}) is missing or incompatible; restore it or choose a fresh empty schema.`);
      }
    }
  }

  private schemaSqlText(): string {
    return `
      CREATE TABLE ${this.schemaSql}.metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE ${this.schemaSql}.llm_journal_objects (
        object_id TEXT PRIMARY KEY, object_kind TEXT NOT NULL, payload TEXT NOT NULL, created_at BIGINT NOT NULL
      );
      CREATE TABLE ${this.schemaSql}.llm_journal_requests (
        request_id TEXT PRIMARY KEY, session_id TEXT, purpose TEXT NOT NULL, iteration BIGINT NOT NULL, created_at BIGINT NOT NULL,
        prompt_object_id TEXT NOT NULL, tool_schema_object_id TEXT NOT NULL, requested_model_key TEXT NOT NULL,
        prompt_cache_key_hash TEXT NOT NULL, message_count BIGINT NOT NULL, checkpoint_message_ids_json TEXT,
        base_request_id TEXT, common_prefix_length BIGINT, appended_message_ids_json TEXT, delta_depth BIGINT NOT NULL
      );
      CREATE INDEX llm_journal_requests_session_created ON ${this.schemaSql}.llm_journal_requests(session_id, created_at, request_id);
      CREATE TABLE ${this.schemaSql}.llm_journal_attempt_starts (
        event_id TEXT PRIMARY KEY, request_id TEXT NOT NULL, attempt BIGINT NOT NULL, started_at BIGINT NOT NULL,
        concrete_model_id TEXT NOT NULL, virtual_model_key TEXT, provider_type TEXT NOT NULL, semantic_payload_sha256 TEXT NOT NULL
      );
      CREATE INDEX llm_journal_attempt_starts_request_order ON ${this.schemaSql}.llm_journal_attempt_starts(request_id, attempt, started_at, event_id);
      CREATE TABLE ${this.schemaSql}.llm_journal_attempt_results (
        event_id TEXT PRIMARY KEY, request_id TEXT NOT NULL, attempt BIGINT NOT NULL, completed_at BIGINT NOT NULL,
        outcome TEXT NOT NULL, result_json TEXT, error_json TEXT
      );
      CREATE INDEX llm_journal_attempt_results_request_order ON ${this.schemaSql}.llm_journal_attempt_results(request_id, attempt, completed_at, event_id);
    `;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    const client = await this.getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);
      const schemaExists = Number((await client.query(`SELECT COUNT(*)::bigint AS count FROM information_schema.schemata WHERE schema_name=$1`, [this.config.schema])).rows[0]?.count || 0) > 0;
      const tables = schemaExists
        ? (await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema=$1`, [this.config.schema])).rows.map(row => row.table_name)
        : [];
      if (!schemaExists || tables.length === 0) {
        if (this.options.requireExistingAuthority) {
          throw new Error('PostgreSQL LLM request journal authority required by the completed local cutover marker is missing; restore the PostgreSQL schema from backup.');
        }
        await client.query(`CREATE SCHEMA IF NOT EXISTS ${this.schemaSql}`);
        await client.query(this.schemaSqlText());
        await client.query(`INSERT INTO ${this.schemaSql}.metadata(key,value) VALUES ('authority',$1),('schema_version',$2),($3,$4)`, [
          LLM_REQUEST_JOURNAL_AUTHORITY, String(LLM_REQUEST_JOURNAL_SCHEMA_VERSION),
          LLM_REQUEST_JOURNAL_AUTHORITY_STATE_KEY, LLM_REQUEST_JOURNAL_AUTHORITY_STATE_COMPLETE,
        ]);
      } else {
        if (!tables.includes('metadata')) throw new Error('PostgreSQL LLM request journal schema is nonempty but has no metadata table; restore it or choose a fresh empty schema.');
        const metadata = await client.query(`SELECT key,value FROM ${this.schemaSql}.metadata WHERE key IN ('authority','schema_version',$1)`, [LLM_REQUEST_JOURNAL_AUTHORITY_STATE_KEY]);
        const values = new Map(metadata.rows.map(row => [row.key, row.value]));
        if (!values.has('authority') || !values.has('schema_version') || !values.has(LLM_REQUEST_JOURNAL_AUTHORITY_STATE_KEY)) throw new Error('PostgreSQL LLM request journal has an incomplete authority/schema marker; restore it or choose a fresh empty schema.');
        if (values.get('authority') !== LLM_REQUEST_JOURNAL_AUTHORITY) throw new Error('PostgreSQL LLM request journal authority marker does not match Foxwarm.');
        const version = Number(values.get('schema_version'));
        if (!Number.isInteger(version) || version !== LLM_REQUEST_JOURNAL_SCHEMA_VERSION) throw new Error(`Unsupported PostgreSQL LLM request journal schema version ${values.get('schema_version')}.`);
        const state = values.get(LLM_REQUEST_JOURNAL_AUTHORITY_STATE_KEY);
        if (state !== LLM_REQUEST_JOURNAL_AUTHORITY_STATE_COMPLETE) {
          throw new Error(`PostgreSQL LLM request journal authority state is ${state || 'missing'}; drop it or choose a fresh empty schema before retrying the copy.`);
        }
        await this.validateRequiredSchema(client);
      }
      await client.query('COMMIT');
      this.initialized = true;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> { const pool = this.pool; this.pool = undefined; this.initialized = false; if (pool) await pool.end(); }

  async beginMigrationCopy(): Promise<void> {
    await this.initialize();
    const client = await this.getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);
      const counts = await client.query(`SELECT (SELECT COUNT(*) FROM ${this.schemaSql}.llm_journal_objects)::bigint objects,(SELECT COUNT(*) FROM ${this.schemaSql}.llm_journal_requests)::bigint requests,(SELECT COUNT(*) FROM ${this.schemaSql}.llm_journal_attempt_starts)::bigint attempt_starts,(SELECT COUNT(*) FROM ${this.schemaSql}.llm_journal_attempt_results)::bigint attempt_results`);
      if (Object.values(counts.rows[0] || {}).some(value => Number(value) !== 0)) throw new Error('PostgreSQL LLM request journal target is not empty; drop it or choose a fresh empty schema.');
      const updated = await client.query(`UPDATE ${this.schemaSql}.metadata SET value=$1 WHERE key=$2 AND value=$3`, [LLM_REQUEST_JOURNAL_AUTHORITY_STATE_COPYING, LLM_REQUEST_JOURNAL_AUTHORITY_STATE_KEY, LLM_REQUEST_JOURNAL_AUTHORITY_STATE_COMPLETE]);
      if (updated.rowCount !== 1) throw new Error('PostgreSQL LLM request journal cannot enter copying state.');
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }

  async completeMigrationCopy(): Promise<void> {
    const client = await this.getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);
      const updated = await client.query(`UPDATE ${this.schemaSql}.metadata SET value=$1 WHERE key=$2 AND value=$3`, [LLM_REQUEST_JOURNAL_AUTHORITY_STATE_COMPLETE, LLM_REQUEST_JOURNAL_AUTHORITY_STATE_KEY, LLM_REQUEST_JOURNAL_AUTHORITY_STATE_COPYING]);
      if (updated.rowCount !== 1) throw new Error('PostgreSQL LLM request journal cannot publish complete migration authority.');
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }

  async appendRecords(records: LlmJournalRecord[]): Promise<void> {
    await this.initialize();
    const client = await this.getPool().connect();
    try {
      await client.query('BEGIN');
      for (const record of records) {
        if (record.kind === 'object') await client.query(`INSERT INTO ${this.schemaSql}.llm_journal_objects(object_id,object_kind,payload,created_at) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [record.objectId, record.objectKind, record.payload, record.createdAt]);
        else if (record.kind === 'request') await client.query(`INSERT INTO ${this.schemaSql}.llm_journal_requests(request_id,session_id,purpose,iteration,created_at,prompt_object_id,tool_schema_object_id,requested_model_key,prompt_cache_key_hash,message_count,checkpoint_message_ids_json,base_request_id,common_prefix_length,appended_message_ids_json,delta_depth) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT DO NOTHING`, [record.requestId, record.sessionId || null, record.purpose, record.iteration, record.createdAt, record.promptObjectId, record.toolSchemaObjectId, record.requestedModelKey, record.promptCacheKeyHash, record.messageCount, record.checkpointMessageObjectIds ? JSON.stringify(record.checkpointMessageObjectIds) : null, record.baseRequestId || null, record.commonPrefixLength ?? null, record.appendedMessageObjectIds ? JSON.stringify(record.appendedMessageObjectIds) : null, record.deltaDepth]);
        else if (record.kind === 'attempt-start') await client.query(`INSERT INTO ${this.schemaSql}.llm_journal_attempt_starts(event_id,request_id,attempt,started_at,concrete_model_id,virtual_model_key,provider_type,semantic_payload_sha256) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`, [record.eventId, record.requestId, record.attempt, record.startedAt, record.concreteModelId, record.virtualModelKey || null, record.providerType, record.semanticPayloadSha256]);
        else await client.query(`INSERT INTO ${this.schemaSql}.llm_journal_attempt_results(event_id,request_id,attempt,completed_at,outcome,result_json,error_json) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`, [record.eventId, record.requestId, record.attempt, record.completedAt, record.outcome, record.result ? canonicalJournalJson(record.result) : null, record.error ? canonicalJournalJson(record.error) : null]);
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }

  async hasObject(objectId: string): Promise<boolean> { return (await this.query(`SELECT 1 FROM ${this.schemaSql}.llm_journal_objects WHERE object_id=$1`, [objectId])).length > 0; }
  async getObject(objectId: string): Promise<LlmJournalObjectRecord | null> { const [row] = await this.query(`SELECT * FROM ${this.schemaSql}.llm_journal_objects WHERE object_id=$1`, [objectId]); return row ? objectFromRow(row) : null; }
  async getRequest(requestId: string): Promise<LlmJournalRequestRecord | null> { const [row] = await this.query(`SELECT * FROM ${this.schemaSql}.llm_journal_requests WHERE request_id=$1`, [requestId]); return row ? requestFromRow(row) : null; }
  async getLatestRequestForSession(sessionId: string): Promise<Pick<LlmJournalRequestRecord, 'requestId'|'deltaDepth'> | null> { const [row] = await this.query(`SELECT request_id,delta_depth FROM ${this.schemaSql}.llm_journal_requests WHERE session_id=$1 ORDER BY created_at DESC,request_id DESC LIMIT 1`, [sessionId]); return row ? { requestId: row.request_id, deltaDepth: number(row.delta_depth, 'delta depth') } : null; }
  async getAttemptStarts(requestId: string): Promise<LlmJournalAttemptStartRecord[]> { return (await this.query(`SELECT * FROM ${this.schemaSql}.llm_journal_attempt_starts WHERE request_id=$1 ORDER BY attempt,started_at,event_id`, [requestId])).map(attemptStartFromRow); }
  async getAttemptResults(requestId: string): Promise<LlmJournalAttemptResultRecord[]> { return (await this.query(`SELECT * FROM ${this.schemaSql}.llm_journal_attempt_results WHERE request_id=$1 ORDER BY attempt,completed_at,event_id`, [requestId])).map(attemptResultFromRow); }

  async listRequests(options: { sessionId?: string; purpose?: LlmRequestPurpose; limit: number; before?: LlmRequestJournalCursor }): Promise<LlmRequestJournalSummary[]> {
    const conditions: string[] = []; const values: unknown[] = [];
    const bind = (value: unknown): string => { values.push(value); return `$${values.length}`; };
    if (options.sessionId) conditions.push(`session_id=${bind(options.sessionId)}`);
    if (options.purpose) conditions.push(`purpose=${bind(options.purpose)}`);
    if (options.before) { const a = bind(options.before.createdAt), b = bind(options.before.createdAt), c = bind(options.before.requestId); conditions.push(`(created_at < ${a} OR (created_at = ${b} AND request_id < ${c}))`); }
    const limit = bind(options.limit);
    const rows = await this.query(`SELECT request_id,session_id,purpose,iteration,created_at,requested_model_key,message_count FROM ${this.schemaSql}.llm_journal_requests ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''} ORDER BY created_at DESC,request_id DESC LIMIT ${limit}`, values);
    return rows.map(row => ({ requestId: row.request_id, sessionId: row.session_id || undefined, purpose: row.purpose, iteration: number(row.iteration, 'iteration'), createdAt: number(row.created_at, 'createdAt'), requestedModelKey: row.requested_model_key, messageCount: number(row.message_count, 'message count') }));
  }

  async scanRecords(kind: LlmJournalRecordKind, after: LlmJournalScanCursor | undefined, limit: number): Promise<{ records: LlmJournalRecord[]; next?: LlmJournalScanCursor }> {
    const map = {
      object: { table: 'llm_journal_objects', time: 'created_at', id: 'object_id', convert: objectFromRow },
      request: { table: 'llm_journal_requests', time: 'created_at', id: 'request_id', convert: requestFromRow },
      'attempt-start': { table: 'llm_journal_attempt_starts', time: 'started_at', id: 'event_id', convert: attemptStartFromRow },
      'attempt-result': { table: 'llm_journal_attempt_results', time: 'completed_at', id: 'event_id', convert: attemptResultFromRow },
    } as const;
    const entry = map[kind];
    const rows = await this.query(`SELECT * FROM ${this.schemaSql}.${entry.table} ${after ? `WHERE (${entry.time},${entry.id}) > ($1,$2)` : ''} ORDER BY ${entry.time},${entry.id} LIMIT $${after ? 3 : 1}`, after ? [after.time, after.id, limit] : [limit]);
    const records = rows.map(entry.convert as (row: any) => LlmJournalRecord);
    const last: any = rows[rows.length - 1];
    return { records, ...(last ? { next: { time: number(last[entry.time], 'scan timestamp'), id: last[entry.id] } } : {}) };
  }

  async getRecord(record: LlmJournalRecord): Promise<LlmJournalRecord | null> {
    if (record.kind === 'object') return this.getObject(record.objectId);
    if (record.kind === 'request') return this.getRequest(record.requestId);
    const [row] = await this.query(`SELECT * FROM ${this.schemaSql}.${record.kind === 'attempt-start' ? 'llm_journal_attempt_starts' : 'llm_journal_attempt_results'} WHERE event_id=$1`, [record.eventId]);
    return row ? (record.kind === 'attempt-start' ? attemptStartFromRow(row) : attemptResultFromRow(row)) : null;
  }
  async getCounts(): Promise<{ objects: number; requests: number; attemptStarts: number; attemptResults: number }> { const [row] = await this.query(`SELECT (SELECT COUNT(*) FROM ${this.schemaSql}.llm_journal_objects)::bigint objects,(SELECT COUNT(*) FROM ${this.schemaSql}.llm_journal_requests)::bigint requests,(SELECT COUNT(*) FROM ${this.schemaSql}.llm_journal_attempt_starts)::bigint attempt_starts,(SELECT COUNT(*) FROM ${this.schemaSql}.llm_journal_attempt_results)::bigint attempt_results`); return { objects: number(row.objects, 'object count'), requests: number(row.requests, 'request count'), attemptStarts: number(row.attempt_starts, 'attempt-start count'), attemptResults: number(row.attempt_results, 'attempt-result count') }; }
  async getMetadata(key: string): Promise<string | undefined> { const [row] = await this.query(`SELECT value FROM ${this.schemaSql}.metadata WHERE key=$1`, [key]); return row?.value; }
  async setMetadata(key: string, value: string): Promise<void> { await this.query(`INSERT INTO ${this.schemaSql}.metadata(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [key, value]); }
  async withConsistentSnapshot<T>(fn: () => Promise<T>): Promise<T> { if (this.snapshotClient) return fn(); const client = await this.getPool().connect(); try { await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); this.snapshotClient = client; const result = await fn(); await client.query('COMMIT'); return result; } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; } finally { this.snapshotClient = undefined; client.release(); } }
  async checkIntegrity(): Promise<void> {
    const authority = await this.getMetadata('authority');
    const version = await this.getMetadata('schema_version');
    const state = await this.getMetadata(LLM_REQUEST_JOURNAL_AUTHORITY_STATE_KEY);
    if (authority !== LLM_REQUEST_JOURNAL_AUTHORITY || version !== String(LLM_REQUEST_JOURNAL_SCHEMA_VERSION)
      || ![LLM_REQUEST_JOURNAL_AUTHORITY_STATE_COMPLETE, LLM_REQUEST_JOURNAL_AUTHORITY_STATE_COPYING].includes(state || '')) {
      throw new Error('PostgreSQL LLM request journal authority/schema verification failed.');
    }
  }
  async replaceObjectPayloadForTests(id:string,payload:string){const [row]=await this.query(`SELECT o.object_id,o.payload FROM ${this.schemaSql}.llm_journal_requests r JOIN ${this.schemaSql}.llm_journal_objects o ON o.object_id=r.prompt_object_id WHERE r.request_id=$1`,[id]);if(!row)throw new Error(`Request ${id} not found`);await this.query(`UPDATE ${this.schemaSql}.llm_journal_objects SET payload=$1 WHERE object_id=$2`,[payload,row.object_id]);return row.payload;}
  async replaceRequestMessageCountForTests(id:string,count:number){const [row]=await this.query(`SELECT message_count FROM ${this.schemaSql}.llm_journal_requests WHERE request_id=$1`,[id]);if(!row)throw new Error(`Request ${id} not found`);await this.query(`UPDATE ${this.schemaSql}.llm_journal_requests SET message_count=$1 WHERE request_id=$2`,[count,id]);return number(row.message_count,'message count');}
  async replaceRequestCreatedAtForTests(ids:string[],time:number){for(const id of ids)await this.query(`UPDATE ${this.schemaSql}.llm_journal_requests SET created_at=$1 WHERE request_id=$2`,[time,id]);}
  async replaceRequestIdentityForTests(id:string,v:{purpose:string;promptCacheKeyHash:string;iteration:number}){const [row]=await this.query(`SELECT purpose,prompt_cache_key_hash,iteration FROM ${this.schemaSql}.llm_journal_requests WHERE request_id=$1`,[id]);await this.query(`UPDATE ${this.schemaSql}.llm_journal_requests SET purpose=$1,prompt_cache_key_hash=$2,iteration=$3 WHERE request_id=$4`,[v.purpose,v.promptCacheKeyHash,v.iteration,id]);return{purpose:row.purpose,promptCacheKeyHash:row.prompt_cache_key_hash,iteration:number(row.iteration,'iteration')};}
  async replaceAttemptStartHashForTests(id:string,hash:string){const [row]=await this.query(`SELECT event_id,semantic_payload_sha256 FROM ${this.schemaSql}.llm_journal_attempt_starts WHERE request_id=$1 ORDER BY attempt LIMIT 1`,[id]);await this.query(`UPDATE ${this.schemaSql}.llm_journal_attempt_starts SET semantic_payload_sha256=$1 WHERE event_id=$2`,[hash,row.event_id]);return row.semantic_payload_sha256;}
  async replaceAttemptResultOutcomeForTests(id:string,outcome:string){const [row]=await this.query(`SELECT event_id,outcome FROM ${this.schemaSql}.llm_journal_attempt_results WHERE request_id=$1 ORDER BY attempt LIMIT 1`,[id]);await this.query(`UPDATE ${this.schemaSql}.llm_journal_attempt_results SET outcome=$1 WHERE event_id=$2`,[outcome,row.event_id]);return row.outcome;}
}
