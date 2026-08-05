import { DatabaseSync } from 'node:sqlite';
import { RpcError } from './rpc';
import { stableSessionWorkerJson } from './sessionWorkerStableJson';

export const SESSION_WORKER_SCHEMA_VERSION = 2;

const OWNERSHIP_COLUMNS = [
  'session_id', 'generation', 'state', 'incarnation_id', 'worker_pid', 'process_identity',
  'activated_at', 'mailbox_cursor', 'last_activity_at', 'updated_at', 'last_exit_reason',
];
const MAILBOX_COLUMNS = [
  'id', 'session_id', 'intent_id', 'kind', 'payload_json', 'created_at',
  'applied_generation', 'applied_incarnation_id', 'applied_at',
];
const V1_OWNERSHIP_COLUMNS = [
  'session_id', 'generation', 'state', 'incarnation_id', 'worker_pid', 'process_identity',
  'activated_at', 'head_revision', 'head_path', 'head_sha256', 'mailbox_cursor',
  'last_activity_at', 'updated_at', 'last_exit_reason',
];
const V1_MAILBOX_COLUMNS = [
  'id', 'session_id', 'intent_id', 'kind', 'payload_json', 'created_at',
  'applied_generation', 'applied_revision',
];
const LEGACY_OWNERSHIP_COLUMNS = [
  'session_id', 'generation', 'state', 'worker_pid', 'head_revision', 'head_path',
  'head_sha256', 'mailbox_cursor', 'last_activity_at', 'updated_at', 'last_exit_reason',
];
const LEGACY_MAILBOX_COLUMNS = V1_MAILBOX_COLUMNS;

function tableExists(db: DatabaseSync, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function tableColumns(db: DatabaseSync, name: string): string[] {
  return (db.prepare(`PRAGMA table_info(${name})`).all() as Array<{ name: string }>).map(row => row.name);
}

type TableInfo = { name: string; type: string; notnull: number; dflt_value: string | null; pk: number };

function tableInfo(db: DatabaseSync, name: string): TableInfo[] {
  return db.prepare(`PRAGMA table_info(${name})`).all() as TableInfo[];
}

function requireColumn(
  rows: TableInfo[],
  name: string,
  expected: Partial<Pick<TableInfo, 'type' | 'notnull' | 'dflt_value' | 'pk'>>,
): void {
  const row = rows.find(candidate => candidate.name === name);
  if (!row || Object.entries(expected).some(([key, value]) => row[key as keyof TableInfo] !== value)) {
    throw new RpcError('SESSION_WORKER_SCHEMA_INVALID', `Session-worker column ${name} has invalid constraints.`);
  }
}

function assertExactColumns(db: DatabaseSync, table: string, expected: string[], label: string): void {
  const actual = tableColumns(db, table).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new RpcError('SESSION_WORKER_SCHEMA_INVALID', `${label} ${table} has an unknown schema.`);
  }
}

function normalizedTableSql(db: DatabaseSync, table: string): string {
  return String((db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as any)?.sql || '')
    .replace(/\s+/g, ' ').trim().toLowerCase();
}

function validateCurrentRows(db: DatabaseSync): void {
  const invalidOwnership = db.prepare(`
    SELECT session_id FROM session_worker_ownership WHERE
      generation < 0 OR mailbox_cursor < 0 OR last_activity_at < 0 OR updated_at < 0 OR
      (state='inactive' AND (incarnation_id IS NOT NULL OR worker_pid IS NOT NULL OR process_identity IS NOT NULL OR activated_at IS NOT NULL)) OR
      (state='candidate' AND (incarnation_id IS NULL OR activated_at IS NOT NULL
        OR ((worker_pid IS NULL) != (process_identity IS NULL)))) OR
      (state='ready' AND (incarnation_id IS NULL OR worker_pid IS NULL OR process_identity IS NULL OR activated_at IS NULL)) OR
      (state='draining' AND (incarnation_id IS NULL OR ((process_identity IS NULL) != (activated_at IS NULL))
        OR (process_identity IS NOT NULL AND worker_pid IS NULL)))
    LIMIT 1
  `).get() as { session_id?: string } | undefined;
  if (invalidOwnership) throw new RpcError('SESSION_WORKER_SCHEMA_INVALID', `Session-worker ownership row ${invalidOwnership.session_id} is semantically invalid.`);

  const invalidMailbox = db.prepare(`
    SELECT m.id FROM session_worker_mailbox m
    LEFT JOIN session_worker_ownership o ON o.session_id=m.session_id
    WHERE (m.applied_at IS NOT NULL AND o.session_id IS NULL) OR m.created_at < 0 OR
      ((m.applied_at IS NULL) != (m.applied_generation IS NULL)) OR
      ((m.applied_at IS NULL) != (m.applied_incarnation_id IS NULL)) OR
      (m.applied_at IS NOT NULL AND (m.applied_generation < 0 OR m.applied_at < m.created_at)) OR
      (m.applied_at IS NULL AND m.id <= o.mailbox_cursor) OR
      (m.applied_at IS NOT NULL AND m.id > o.mailbox_cursor)
    LIMIT 1
  `).get() as { id?: number } | undefined;
  if (invalidMailbox) throw new RpcError('SESSION_WORKER_SCHEMA_INVALID', `Session-worker mailbox row ${invalidMailbox.id} is semantically invalid.`);

  const rows = db.prepare('SELECT id,payload_json FROM session_worker_mailbox').all() as Array<{ id: number; payload_json: string }>;
  for (const row of rows) {
    try {
      const canonical = stableSessionWorkerJson(JSON.parse(String(row.payload_json)));
      if (canonical !== String(row.payload_json)) throw new Error('payload is not canonical');
    } catch (error: any) {
      throw new RpcError('SESSION_WORKER_SCHEMA_INVALID', `Session-worker mailbox row ${row.id} has invalid payload JSON: ${error?.message || error}`);
    }
  }
}

function createCurrentSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_worker_ownership (
      session_id TEXT PRIMARY KEY NOT NULL,
      generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
      state TEXT NOT NULL DEFAULT 'inactive' CHECK (state IN ('inactive','candidate','ready','draining')),
      incarnation_id TEXT,
      worker_pid INTEGER,
      process_identity TEXT,
      activated_at INTEGER,
      mailbox_cursor INTEGER NOT NULL DEFAULT 0 CHECK (mailbox_cursor >= 0),
      last_activity_at INTEGER NOT NULL DEFAULT 0 CHECK (last_activity_at >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
      last_exit_reason TEXT,
      CHECK (
        (state = 'inactive' AND incarnation_id IS NULL AND worker_pid IS NULL AND process_identity IS NULL AND activated_at IS NULL)
        OR (state = 'candidate' AND incarnation_id IS NOT NULL AND activated_at IS NULL
          AND ((worker_pid IS NULL AND process_identity IS NULL) OR (worker_pid IS NOT NULL AND process_identity IS NOT NULL)))
        OR (state = 'ready' AND incarnation_id IS NOT NULL AND worker_pid IS NOT NULL
          AND process_identity IS NOT NULL AND activated_at IS NOT NULL)
        OR (state = 'draining' AND incarnation_id IS NOT NULL
          AND ((worker_pid IS NOT NULL AND process_identity IS NOT NULL AND activated_at IS NOT NULL)
            OR (process_identity IS NULL AND activated_at IS NULL)))
      )
    );
    CREATE TABLE IF NOT EXISTS session_worker_mailbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      session_id TEXT NOT NULL,
      intent_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      applied_generation INTEGER,
      applied_incarnation_id TEXT,
      applied_at INTEGER,
      CHECK (
        (applied_generation IS NULL AND applied_incarnation_id IS NULL AND applied_at IS NULL)
        OR (applied_generation IS NOT NULL AND applied_generation >= 0
          AND applied_incarnation_id IS NOT NULL AND applied_at IS NOT NULL AND applied_at >= created_at)
      ),
      UNIQUE(session_id, intent_id)
    );
    CREATE INDEX IF NOT EXISTS idx_session_worker_mailbox_pending
      ON session_worker_mailbox(session_id, id)
      WHERE applied_at IS NULL;
  `);
}

function migrateV0(db: DatabaseSync): void {
  const hasOwnership = tableExists(db, 'session_worker_ownership');
  const hasMailbox = tableExists(db, 'session_worker_mailbox');
  if (hasOwnership !== hasMailbox) {
    throw new RpcError('SESSION_WORKER_SCHEMA_INVALID', 'Legacy session-worker schema is incomplete.');
  }
  if (!hasOwnership) {
    createCurrentSchema(db);
    return;
  }
  assertExactColumns(db, 'session_worker_ownership', LEGACY_OWNERSHIP_COLUMNS, 'Legacy');
  assertExactColumns(db, 'session_worker_mailbox', LEGACY_MAILBOX_COLUMNS, 'Legacy');
  db.exec(`
    ALTER TABLE session_worker_ownership RENAME TO session_worker_ownership_v0;
    ALTER TABLE session_worker_mailbox RENAME TO session_worker_mailbox_v0;
    DROP INDEX IF EXISTS idx_session_worker_mailbox_pending;
  `);
  createCurrentSchema(db);
  db.exec(`
    INSERT INTO session_worker_ownership(
      session_id,generation,state,incarnation_id,worker_pid,mailbox_cursor,last_activity_at,updated_at,last_exit_reason
    )
    SELECT session_id,generation,
           CASE WHEN state='inactive' THEN 'inactive' ELSE 'draining' END,
           CASE WHEN state='inactive' THEN NULL ELSE 'legacy-unproven-' || generation END,
           CASE WHEN state='inactive' THEN NULL ELSE worker_pid END,
           mailbox_cursor,last_activity_at,updated_at,
           CASE WHEN state='inactive' THEN 'schema-v0-migrated-inactive' ELSE 'schema-v0-unproven-fence' END
    FROM session_worker_ownership_v0;
  `);
  const legacyRows = db.prepare(`
    SELECT id,session_id,intent_id,kind,payload_json,created_at,applied_generation,applied_revision
    FROM session_worker_mailbox_v0 ORDER BY id
  `).all() as any[];
  const insertMailbox = db.prepare(`
    INSERT INTO session_worker_mailbox(
      id,session_id,intent_id,kind,payload_json,created_at,applied_generation,applied_incarnation_id,applied_at
    ) VALUES(?,?,?,?,?,?,?,?,?)
  `);
  for (const row of legacyRows) {
    let payload: unknown;
    try {
      payload = JSON.parse(String(row.payload_json));
      const canonical = stableSessionWorkerJson(payload);
      insertMailbox.run(row.id, row.session_id, row.intent_id, row.kind, canonical, row.created_at,
        row.applied_revision == null ? null : (row.applied_generation ?? 0),
        row.applied_revision == null ? null : 'legacy-v0',
        row.applied_revision == null ? null : row.created_at);
    } catch (error: any) {
      throw new RpcError(
        'SESSION_WORKER_SCHEMA_INVALID',
        `Legacy session-worker mailbox row ${row.id} has an invalid payload: ${error?.message || error}`,
      );
    }
  }
  db.exec(`DROP TABLE session_worker_ownership_v0; DROP TABLE session_worker_mailbox_v0;`);
}

function migrateV1(db: DatabaseSync): void {
  validateSchemaSemantics(db, V1_OWNERSHIP_COLUMNS, V1_MAILBOX_COLUMNS, 'Version 1', true);
  db.exec(`
    ALTER TABLE session_worker_ownership RENAME TO session_worker_ownership_v1;
    ALTER TABLE session_worker_mailbox RENAME TO session_worker_mailbox_v1;
    DROP INDEX IF EXISTS idx_session_worker_mailbox_pending;
  `);
  createCurrentSchema(db);
  db.exec(`
    INSERT INTO session_worker_ownership(
      session_id,generation,state,incarnation_id,worker_pid,process_identity,activated_at,
      mailbox_cursor,last_activity_at,updated_at,last_exit_reason
    )
    SELECT session_id,generation,state,incarnation_id,worker_pid,process_identity,activated_at,
           mailbox_cursor,last_activity_at,updated_at,last_exit_reason
    FROM session_worker_ownership_v1;
  `);
  const legacyRows = db.prepare(`
    SELECT id,session_id,intent_id,kind,payload_json,created_at,applied_generation,applied_revision
    FROM session_worker_mailbox_v1 ORDER BY id
  `).all() as any[];
  const insertMailbox = db.prepare(`
    INSERT INTO session_worker_mailbox(
      id,session_id,intent_id,kind,payload_json,created_at,applied_generation,applied_incarnation_id,applied_at
    ) VALUES(?,?,?,?,?,?,?,?,?)
  `);
  for (const row of legacyRows) {
    try {
      const canonical = stableSessionWorkerJson(JSON.parse(String(row.payload_json)));
      insertMailbox.run(row.id, row.session_id, row.intent_id, row.kind, canonical, row.created_at,
        row.applied_revision == null ? null : (row.applied_generation ?? 0),
        row.applied_revision == null ? null : 'legacy-v1',
        row.applied_revision == null ? null : row.created_at);
    } catch (error: any) {
      throw new RpcError(
        'SESSION_WORKER_SCHEMA_INVALID',
        `Version 1 session-worker mailbox row ${row.id} has an invalid payload: ${error?.message || error}`,
      );
    }
  }
  db.exec(`DROP TABLE session_worker_ownership_v1; DROP TABLE session_worker_mailbox_v1;`);
}

export function configureAndMigrateSessionWorkerDb(db: DatabaseSync): void {
  // Busy timeout must precede journal-mode or schema operations because both
  // may take locks when another main/worker connection is opening the file.
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = FULL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('BEGIN IMMEDIATE');
  try {
    const version = Number((db.prepare('PRAGMA user_version').get() as any)?.user_version ?? 0);
    if (version > SESSION_WORKER_SCHEMA_VERSION) {
      throw new RpcError(
        'SESSION_WORKER_SCHEMA_NEWER',
        `Session-worker database version ${version} is newer than supported version ${SESSION_WORKER_SCHEMA_VERSION}.`,
      );
    }
    if (version === 0) {
      migrateV0(db);
      db.exec(`PRAGMA user_version = ${SESSION_WORKER_SCHEMA_VERSION}`);
    } else if (version === 1) {
      migrateV1(db);
      db.exec(`PRAGMA user_version = ${SESSION_WORKER_SCHEMA_VERSION}`);
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
  validateSessionWorkerSchema(db);
}

function validateSchemaSemantics(
  db: DatabaseSync,
  ownershipColumns: string[],
  mailboxColumns: string[],
  label: string,
  includeV1Head: boolean,
): void {
  assertExactColumns(db, 'session_worker_ownership', ownershipColumns, label);
  assertExactColumns(db, 'session_worker_mailbox', mailboxColumns, label);
  const ownership = tableInfo(db, 'session_worker_ownership');
  const requiredOwnership: Record<string, Partial<TableInfo>> = {
    session_id: { type: 'TEXT', notnull: 1, dflt_value: null, pk: 1 },
    generation: { type: 'INTEGER', notnull: 1, dflt_value: '0', pk: 0 },
    state: { type: 'TEXT', notnull: 1, dflt_value: "'inactive'", pk: 0 },
    incarnation_id: { type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
    worker_pid: { type: 'INTEGER', notnull: 0, dflt_value: null, pk: 0 },
    process_identity: { type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
    activated_at: { type: 'INTEGER', notnull: 0, dflt_value: null, pk: 0 },
    mailbox_cursor: { type: 'INTEGER', notnull: 1, dflt_value: '0', pk: 0 },
    last_activity_at: { type: 'INTEGER', notnull: 1, dflt_value: '0', pk: 0 },
    updated_at: { type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0 },
    last_exit_reason: { type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
  };
  if (includeV1Head) {
    requiredOwnership.head_revision = { type: 'INTEGER', notnull: 1, dflt_value: '0', pk: 0 };
    requiredOwnership.head_path = { type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 };
    requiredOwnership.head_sha256 = { type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 };
  }
  for (const [name, expected] of Object.entries(requiredOwnership)) {
    requireColumn(ownership, name, expected);
  }
  const ownershipSql = String((db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='session_worker_ownership'").get() as any)?.sql || '')
    .replace(/\s+/g, ' ').toLowerCase();
  if (!ownershipSql.includes("check (state in ('inactive','candidate','ready','draining'))")) {
    throw new RpcError('SESSION_WORKER_SCHEMA_INVALID', 'Session-worker ownership state CHECK is missing or invalid.');
  }
  if (!includeV1Head) {
    const mailboxSql = normalizedTableSql(db, 'session_worker_mailbox');
    const requiredOwnershipChecks = [
      'check (generation >= 0)', 'check (mailbox_cursor >= 0)', 'check (last_activity_at >= 0)',
      'check (updated_at >= 0)', "state = 'inactive'", "state = 'candidate'", "state = 'ready'", "state = 'draining'",
    ];
    const requiredMailboxChecks = [
      'check (created_at >= 0)', 'applied_generation is null and applied_incarnation_id is null and applied_at is null',
      'applied_at >= created_at',
    ];
    if (requiredOwnershipChecks.some(fragment => !ownershipSql.includes(fragment))
      || requiredMailboxChecks.some(fragment => !mailboxSql.includes(fragment))) {
      throw new RpcError('SESSION_WORKER_SCHEMA_INVALID', 'Session-worker semantic CHECK constraints are missing or invalid.');
    }
  }

  const mailbox = tableInfo(db, 'session_worker_mailbox');
  const requiredMailbox: Record<string, Partial<TableInfo>> = {
    id: { type: 'INTEGER', notnull: 1, dflt_value: null, pk: 1 },
    session_id: { type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
    intent_id: { type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
    kind: { type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
    payload_json: { type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
    created_at: { type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0 },
    applied_generation: { type: 'INTEGER', notnull: 0, dflt_value: null, pk: 0 },
    ...(includeV1Head
      ? { applied_revision: { type: 'INTEGER', notnull: 0, dflt_value: null, pk: 0 } }
      : {
          applied_incarnation_id: { type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
          applied_at: { type: 'INTEGER', notnull: 0, dflt_value: null, pk: 0 },
        }),
  };
  for (const [name, expected] of Object.entries(requiredMailbox)) {
    requireColumn(mailbox, name, expected);
  }
  const indexes = db.prepare("PRAGMA index_list(session_worker_mailbox)").all() as Array<{ name: string; unique: number; partial: number }>;
  const columnsFor = (name: string): string[] => (db.prepare(`PRAGMA index_info(${JSON.stringify(name)})`).all() as Array<{ name: string }>).map(row => row.name);
  const uniqueIntent = indexes.find(index => index.unique === 1 && index.partial === 0
    && JSON.stringify(columnsFor(index.name)) === JSON.stringify(['session_id', 'intent_id']));
  const pending = indexes.find(index => index.name === 'idx_session_worker_mailbox_pending');
  const pendingSql = String((db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_session_worker_mailbox_pending'").get() as any)?.sql || '')
    .replace(/\s+/g, ' ').trim().toLowerCase();
  const pendingPredicate = includeV1Head ? 'where applied_revision is null' : 'where applied_at is null';
  if (!uniqueIntent || !pending || pending.unique !== 0 || pending.partial !== 1
    || JSON.stringify(columnsFor(pending.name)) !== JSON.stringify(['session_id', 'id'])
    || !pendingSql.endsWith(pendingPredicate)) {
    throw new RpcError('SESSION_WORKER_SCHEMA_INVALID', 'Session-worker mailbox UNIQUE or pending partial index is invalid.');
  }
}

export function validateSessionWorkerSchema(db: DatabaseSync): void {
  const version = Number((db.prepare('PRAGMA user_version').get() as any)?.user_version ?? 0);
  if (version !== SESSION_WORKER_SCHEMA_VERSION) {
    throw new RpcError('SESSION_WORKER_SCHEMA_INVALID', `Session-worker database version ${version} is unsupported.`);
  }
  validateSchemaSemantics(db, OWNERSHIP_COLUMNS, MAILBOX_COLUMNS, 'Current', false);
  validateCurrentRows(db);
}
