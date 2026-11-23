// Writes a TypeScript-era Archive (`state/archive-store.sqlite`) through node:sqlite. The schema,
// connection settings and row writes are those of the retired TypeScript archiveStore at the final
// TypeScript revision 80f740477c25d3b42165bb0d201e74ebc5fd4479 (openArchiveStore,
// ensureSessionBranch, writeArchiveMessages and the empty reservation ledger written by
// initArchiveStore), so browser and app scenarios start managed Main on that format.
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const SCHEMA = `
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
      friction_score INTEGER,
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
  `

/** Opens (creating when absent) the Archive of a caller-owned data root. Close it when done. */
export function openArchive(root, { reservationLedger = false } = {}) {
  const state = path.join(root, 'state')
  fs.mkdirSync(state, { recursive: true })
  const db = new DatabaseSync(path.join(state, 'archive-store.sqlite'))
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = FULL')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(SCHEMA)
  // initArchiveStore repaired a missing reservation ledger; without reservations it is empty.
  const ledger = path.join(state, 'session-id-reservations.jsonl')
  if (reservationLedger && !fs.existsSync(ledger)) fs.writeFileSync(ledger, '')
  return db
}

export function ensureBranch(db, sessionId, createdAt = Date.now()) {
  db.prepare(`INSERT OR IGNORE INTO archive_branches (
      session_id, parent_session_id, fork_message_seq, fork_block_id, created_at, updated_at
    ) VALUES (?, NULL, 0, 0, ?, ?)`).run(sessionId, createdAt, createdAt)
}

/** Appends one Session's messages ({ sessionId, agent, seq, timestamp, role, message }). */
export function writeMessages(db, records) {
  if (!records.length) return
  ensureBranch(db, records[0].sessionId)
  const insert = db.prepare(`INSERT INTO archive_messages (
      session_id, agent, seq, timestamp, role, message_json
    ) VALUES (?, ?, ?, ?, ?, ?)`)
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const record of records) insert.run(record.sessionId, record.agent || 'main', record.seq, record.timestamp, record.role, JSON.stringify(record.message))
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

