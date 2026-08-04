import { DatabaseSync } from 'node:sqlite';
import { RpcError } from './rpc';

export const SESSION_WORKER_SCHEMA_VERSION = 1;

const OWNERSHIP_COLUMNS = [
  'session_id', 'generation', 'state', 'incarnation_id', 'worker_pid', 'process_identity',
  'activated_at', 'head_revision', 'head_path', 'head_sha256', 'mailbox_cursor',
  'last_activity_at', 'updated_at', 'last_exit_reason',
];
const MAILBOX_COLUMNS = [
  'id', 'session_id', 'intent_id', 'kind', 'payload_json', 'created_at',
  'applied_generation', 'applied_revision',
];
const LEGACY_OWNERSHIP_COLUMNS = [
  'session_id', 'generation', 'state', 'worker_pid', 'head_revision', 'head_path',
  'head_sha256', 'mailbox_cursor', 'last_activity_at', 'updated_at', 'last_exit_reason',
];
const LEGACY_MAILBOX_COLUMNS = MAILBOX_COLUMNS;

function tableExists(db: DatabaseSync, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function tableColumns(db: DatabaseSync, name: string): string[] {
  return (db.prepare(`PRAGMA table_info(${name})`).all() as Array<{ name: string }>).map(row => row.name);
}

function assertExactColumns(db: DatabaseSync, table: string, expected: string[], label: string): void {
  const actual = tableColumns(db, table).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new RpcError('SESSION_WORKER_SCHEMA_INVALID', `${label} ${table} has an unknown schema.`);
  }
}

function createV1(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_worker_ownership (
      session_id TEXT PRIMARY KEY,
      generation INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL DEFAULT 'inactive' CHECK (state IN ('inactive','candidate','ready','draining')),
      incarnation_id TEXT,
      worker_pid INTEGER,
      process_identity TEXT,
      activated_at INTEGER,
      head_revision INTEGER NOT NULL DEFAULT 0,
      head_path TEXT,
      head_sha256 TEXT,
      mailbox_cursor INTEGER NOT NULL DEFAULT 0,
      last_activity_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      last_exit_reason TEXT
    );
    CREATE TABLE IF NOT EXISTS session_worker_mailbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      intent_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      applied_generation INTEGER,
      applied_revision INTEGER,
      UNIQUE(session_id, intent_id)
    );
    CREATE INDEX IF NOT EXISTS idx_session_worker_mailbox_pending
      ON session_worker_mailbox(session_id, id)
      WHERE applied_revision IS NULL;
  `);
}

function migrateV0(db: DatabaseSync): void {
  const hasOwnership = tableExists(db, 'session_worker_ownership');
  const hasMailbox = tableExists(db, 'session_worker_mailbox');
  if (hasOwnership !== hasMailbox) {
    throw new RpcError('SESSION_WORKER_SCHEMA_INVALID', 'Legacy session-worker schema is incomplete.');
  }
  if (!hasOwnership) {
    createV1(db);
    return;
  }
  assertExactColumns(db, 'session_worker_ownership', LEGACY_OWNERSHIP_COLUMNS, 'Legacy');
  assertExactColumns(db, 'session_worker_mailbox', LEGACY_MAILBOX_COLUMNS, 'Legacy');
  db.exec(`
    ALTER TABLE session_worker_ownership RENAME TO session_worker_ownership_v0;
    ALTER TABLE session_worker_mailbox RENAME TO session_worker_mailbox_v0;
    DROP INDEX IF EXISTS idx_session_worker_mailbox_pending;
  `);
  createV1(db);
  db.exec(`
    INSERT INTO session_worker_ownership(
      session_id,generation,state,incarnation_id,worker_pid,head_revision,head_path,head_sha256,
      mailbox_cursor,last_activity_at,updated_at,last_exit_reason
    )
    SELECT session_id,generation,
           CASE WHEN state='inactive' THEN 'inactive' ELSE 'draining' END,
           CASE WHEN state='inactive' THEN NULL ELSE 'legacy-unproven-' || generation END,
           CASE WHEN state='inactive' THEN NULL ELSE worker_pid END,
           head_revision,head_path,head_sha256,mailbox_cursor,last_activity_at,updated_at,
           CASE WHEN state='inactive' THEN 'schema-v0-migrated-inactive' ELSE 'schema-v0-unproven-fence' END
    FROM session_worker_ownership_v0;
    INSERT INTO session_worker_mailbox(
      id,session_id,intent_id,kind,payload_json,created_at,applied_generation,applied_revision
    )
    SELECT id,session_id,intent_id,kind,payload_json,created_at,applied_generation,applied_revision
    FROM session_worker_mailbox_v0;
    DROP TABLE session_worker_ownership_v0;
    DROP TABLE session_worker_mailbox_v0;
  `);
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
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
  validateSessionWorkerSchema(db);
}

export function validateSessionWorkerSchema(db: DatabaseSync): void {
  const version = Number((db.prepare('PRAGMA user_version').get() as any)?.user_version ?? 0);
  if (version !== SESSION_WORKER_SCHEMA_VERSION) {
    throw new RpcError('SESSION_WORKER_SCHEMA_INVALID', `Session-worker database version ${version} is unsupported.`);
  }
  assertExactColumns(db, 'session_worker_ownership', OWNERSHIP_COLUMNS, 'Current');
  assertExactColumns(db, 'session_worker_mailbox', MAILBOX_COLUMNS, 'Current');
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='session_worker_mailbox'").all() as Array<{ name: string }>;
  const names = new Set(indexes.map(row => row.name));
  if (!names.has('idx_session_worker_mailbox_pending')
    || ![...names].some(name => name.startsWith('sqlite_autoindex_session_worker_mailbox_'))) {
    throw new RpcError('SESSION_WORKER_SCHEMA_INVALID', 'Session-worker mailbox indexes are incomplete.');
  }
}
