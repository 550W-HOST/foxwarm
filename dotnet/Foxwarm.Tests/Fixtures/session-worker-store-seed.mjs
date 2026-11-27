// Seeds a retired TypeScript Session Worker store (`state/session-runtime.sqlite`), schema version 2,
// with one pending mailbox row. The schema and connection settings are the TypeScript
// createCurrentSchema/configureAndMigrateSessionWorkerDb output at the final TypeScript revision
// 80f740477c25d3b42165bb0d201e74ebc5fd4479 (src/sessionWorkerStoreSchema.ts).
// Usage: node session-worker-store-seed.mjs <database> [inactive|active|orphan] [session-id]
import { DatabaseSync } from 'node:sqlite'

const [file, mode = 'inactive', id = 'target'] = process.argv.slice(2)
if (!file) throw new Error('An owned fixture database is required')
const schema = `
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
  `
const db = new DatabaseSync(file)
try {
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = FULL')
  db.exec('BEGIN IMMEDIATE')
  // A fresh file gets the version 2 schema; an existing version 2 file is reused as it is.
  if (db.prepare('PRAGMA user_version').get().user_version === 0) {
    db.exec(schema)
    db.exec('PRAGMA user_version = 2')
  }
  db.exec('COMMIT')
  if (mode !== 'orphan') db.prepare('INSERT INTO session_worker_ownership(session_id,generation,state,updated_at) VALUES(?,0,?,0)').run(id, 'inactive')
  db.prepare('INSERT INTO session_worker_mailbox(session_id,intent_id,kind,payload_json,created_at) VALUES(?,?,?,?,0)').run(id, 'one', 'message', '{}')
  if (mode === 'active') db.prepare("UPDATE session_worker_ownership SET state='candidate',incarnation_id='candidate-1' WHERE session_id=?").run(id)
} finally { db.close() }
