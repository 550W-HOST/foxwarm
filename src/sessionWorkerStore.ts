import fs from 'fs-extra';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SESSION_RUNTIME_DB_PATH } from './config';
import { RpcError } from './rpc';

export type SessionWorkerOwnershipState = 'inactive' | 'starting' | 'ready' | 'draining';

export type SessionWorkerOwnershipRecord = {
  sessionId: string;
  generation: number;
  state: SessionWorkerOwnershipState;
  workerPid?: number;
  headRevision: number;
  headPath?: string;
  headSha256?: string;
  mailboxCursor: number;
  lastActivityAt: number;
  updatedAt: number;
  lastExitReason?: string;
};

export type SessionWorkerMailboxIntent = {
  id: number;
  sessionId: string;
  intentId: string;
  kind: string;
  payload: unknown;
  createdAt: number;
  appliedGeneration?: number;
  appliedRevision?: number;
};

export type SessionWorkerHeadPublication = {
  sessionId: string;
  generation: number;
  expectedRevision: number;
  revision: number;
  headPath: string;
  headSha256: string;
  appliedMailboxIds: number[];
};

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
      throw new RpcError('SESSION_WORKER_INVALID_INTENT', 'Session mailbox payload must be serializable.');
    }
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function normalizeSessionId(sessionId: string): string {
  if (typeof sessionId !== 'string' || !sessionId.trim()) {
    throw new RpcError('SESSION_WORKER_INVALID_SESSION', 'Session worker requires a non-empty session ID.');
  }
  return sessionId.trim();
}

function normalizeIntentId(intentId: string): string {
  if (typeof intentId !== 'string' || !intentId.trim()) {
    throw new RpcError('SESSION_WORKER_INVALID_INTENT', 'Session mailbox intent requires a non-empty intent ID.');
  }
  return intentId.trim();
}

export class SessionWorkerStore {
  private db?: DatabaseSync;

  constructor(readonly filePath = SESSION_RUNTIME_DB_PATH) {}

  open(): void {
    if (this.db) return;
    fs.ensureDirSync(path.dirname(this.filePath));
    const db = new DatabaseSync(this.filePath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = FULL');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_worker_ownership (
        session_id TEXT PRIMARY KEY,
        generation INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL DEFAULT 'inactive' CHECK (state IN ('inactive','starting','ready','draining')),
        worker_pid INTEGER,
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
    this.db = db;
  }

  close(): void {
    this.db?.close();
    this.db = undefined;
  }

  recoverOrphanedOwnerships(reason = 'main-process-restart'): number {
    const db = this.getDb();
    const now = Date.now();
    const result = db.prepare(`
      UPDATE session_worker_ownership
      SET state = 'inactive', worker_pid = NULL, updated_at = ?, last_exit_reason = ?
      WHERE state != 'inactive' OR worker_pid IS NOT NULL
    `).run(now, reason);
    return Number(result.changes);
  }

  getOwnership(sessionId: string): SessionWorkerOwnershipRecord {
    sessionId = normalizeSessionId(sessionId);
    this.ensureOwnership(sessionId);
    const row = this.getDb().prepare(`
      SELECT session_id,generation,state,worker_pid,head_revision,head_path,head_sha256,
             mailbox_cursor,last_activity_at,updated_at,last_exit_reason
      FROM session_worker_ownership WHERE session_id = ?
    `).get(sessionId) as any;
    return this.toOwnership(row);
  }

  beginGeneration(sessionId: string): SessionWorkerOwnershipRecord {
    sessionId = normalizeSessionId(sessionId);
    const db = this.getDb();
    this.ensureOwnership(sessionId);
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.getOwnership(sessionId);
      if (current.state !== 'inactive' || current.workerPid !== undefined) {
        throw new RpcError(
          'SESSION_WORKER_OWNED',
          `Session ${sessionId} is still owned by generation ${current.generation} (${current.state}).`,
          true,
        );
      }
      const generation = current.generation + 1;
      const now = Date.now();
      db.prepare(`
        UPDATE session_worker_ownership
        SET generation = ?, state = 'starting', worker_pid = NULL,
            last_activity_at = ?, updated_at = ?, last_exit_reason = NULL
        WHERE session_id = ? AND generation = ? AND state = 'inactive'
      `).run(generation, now, now, sessionId, current.generation);
      db.exec('COMMIT');
      return this.getOwnership(sessionId);
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  markReady(sessionId: string, generation: number, workerPid: number): SessionWorkerOwnershipRecord {
    if (!Number.isSafeInteger(workerPid) || workerPid <= 0) {
      throw new RpcError('SESSION_WORKER_INVALID_PID', 'Session worker PID must be a positive integer.');
    }
    const changed = this.getDb().prepare(`
      UPDATE session_worker_ownership
      SET state = 'ready', worker_pid = ?, last_activity_at = ?, updated_at = ?
      WHERE session_id = ? AND generation = ? AND state = 'starting' AND worker_pid IS NULL
    `).run(workerPid, Date.now(), Date.now(), normalizeSessionId(sessionId), generation);
    this.requireChanged(changed.changes, sessionId, generation, 'ready');
    return this.getOwnership(sessionId);
  }

  markDraining(sessionId: string, generation: number): SessionWorkerOwnershipRecord {
    const now = Date.now();
    const changed = this.getDb().prepare(`
      UPDATE session_worker_ownership SET state = 'draining', updated_at = ?
      WHERE session_id = ? AND generation = ? AND state IN ('starting','ready')
    `).run(now, normalizeSessionId(sessionId), generation);
    this.requireChanged(changed.changes, sessionId, generation, 'draining');
    return this.getOwnership(sessionId);
  }

  markExitObserved(sessionId: string, generation: number, reason: string): SessionWorkerOwnershipRecord {
    const changed = this.getDb().prepare(`
      UPDATE session_worker_ownership
      SET state = 'inactive', worker_pid = NULL, updated_at = ?, last_exit_reason = ?
      WHERE session_id = ? AND generation = ? AND state != 'inactive'
    `).run(Date.now(), reason, normalizeSessionId(sessionId), generation);
    this.requireChanged(changed.changes, sessionId, generation, 'exit');
    return this.getOwnership(sessionId);
  }

  touch(sessionId: string, generation: number, timestamp = Date.now()): void {
    const changed = this.getDb().prepare(`
      UPDATE session_worker_ownership SET last_activity_at = ?, updated_at = ?
      WHERE session_id = ? AND generation = ? AND state = 'ready'
    `).run(timestamp, timestamp, normalizeSessionId(sessionId), generation);
    this.requireChanged(changed.changes, sessionId, generation, 'activity');
  }

  enqueueIntent(sessionId: string, intentId: string, kind: string, payload: unknown): SessionWorkerMailboxIntent {
    sessionId = normalizeSessionId(sessionId);
    intentId = normalizeIntentId(intentId);
    if (typeof kind !== 'string' || !kind.trim()) {
      throw new RpcError('SESSION_WORKER_INVALID_INTENT', 'Session mailbox intent requires a non-empty kind.');
    }
    const payloadJson = canonicalJson(payload);
    const db = this.getDb();
    const existing = db.prepare(`
      SELECT id,session_id,intent_id,kind,payload_json,created_at,applied_generation,applied_revision
      FROM session_worker_mailbox WHERE session_id = ? AND intent_id = ?
    `).get(sessionId, intentId) as any;
    if (existing) {
      if (existing.session_id !== sessionId || existing.kind !== kind.trim() || existing.payload_json !== payloadJson) {
        throw new RpcError('SESSION_WORKER_INTENT_CONFLICT', `Mailbox intent ${intentId} was reused with different content.`);
      }
      return this.toIntent(existing);
    }
    const result = db.prepare(`
      INSERT INTO session_worker_mailbox(session_id,intent_id,kind,payload_json,created_at)
      VALUES(?,?,?,?,?)
    `).run(sessionId, intentId, kind.trim(), payloadJson, Date.now());
    return this.getIntent(Number(result.lastInsertRowid));
  }

  listPendingIntents(sessionId: string, afterId?: number, limit = 256): SessionWorkerMailboxIntent[] {
    sessionId = normalizeSessionId(sessionId);
    const ownership = this.getOwnership(sessionId);
    const cursor = afterId === undefined ? ownership.mailboxCursor : Math.max(0, Math.floor(afterId));
    const rows = this.getDb().prepare(`
      SELECT id,session_id,intent_id,kind,payload_json,created_at,applied_generation,applied_revision
      FROM session_worker_mailbox
      WHERE session_id = ? AND id > ? AND applied_revision IS NULL
      ORDER BY id LIMIT ?
    `).all(sessionId, cursor, Math.max(1, Math.min(4096, Math.floor(limit)))) as any[];
    return rows.map(row => this.toIntent(row));
  }

  publishHead(publication: SessionWorkerHeadPublication): SessionWorkerOwnershipRecord {
    const { sessionId, generation, expectedRevision, revision, headPath, headSha256 } = publication;
    if (!Number.isSafeInteger(revision) || revision !== expectedRevision + 1) {
      throw new RpcError('SESSION_WORKER_INVALID_REVISION', 'Published session revision must increment exactly once.');
    }
    if (!headPath || !headSha256) {
      throw new RpcError('SESSION_WORKER_INVALID_HEAD', 'Published session head requires path and SHA-256.');
    }
    const ids = [...new Set(publication.appliedMailboxIds)].sort((a, b) => a - b);
    const db = this.getDb();
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.getOwnership(sessionId);
      if (current.generation !== generation
        || !['ready', 'draining'].includes(current.state)
        || current.headRevision !== expectedRevision) {
        throw new RpcError('SESSION_WORKER_STALE_GENERATION', `Session ${sessionId} generation/revision no longer owns publication.`, true);
      }
      let cursor = current.mailboxCursor;
      if (ids.length > 0) {
        const prefix = db.prepare(`
          SELECT id FROM session_worker_mailbox
          WHERE session_id = ? AND id > ? AND applied_revision IS NULL
          ORDER BY id LIMIT ?
        `).all(sessionId, cursor, ids.length) as Array<{ id: number }>;
        if (prefix.length !== ids.length || prefix.some((row, index) => Number(row.id) !== ids[index])) {
          throw new RpcError(
            'SESSION_WORKER_MAILBOX_CONFLICT',
            `Mailbox publication for ${sessionId} must acknowledge one ordered pending prefix.`,
          );
        }
      }
      for (const id of ids) {
        const row = db.prepare(`
          SELECT id FROM session_worker_mailbox
          WHERE id = ? AND session_id = ? AND applied_revision IS NULL
        `).get(id, sessionId) as any;
        if (!row) throw new RpcError('SESSION_WORKER_MAILBOX_CONFLICT', `Mailbox row ${id} is not pending for ${sessionId}.`);
        db.prepare(`
          UPDATE session_worker_mailbox SET applied_generation = ?, applied_revision = ?
          WHERE id = ? AND session_id = ? AND applied_revision IS NULL
        `).run(generation, revision, id, sessionId);
        cursor = Math.max(cursor, id);
      }
      const changed = db.prepare(`
        UPDATE session_worker_ownership
        SET head_revision = ?, head_path = ?, head_sha256 = ?, mailbox_cursor = ?,
            last_activity_at = ?, updated_at = ?
        WHERE session_id = ? AND generation = ? AND state IN ('ready','draining') AND head_revision = ?
      `).run(revision, headPath, headSha256, cursor, Date.now(), Date.now(), sessionId, generation, expectedRevision);
      this.requireChanged(changed.changes, sessionId, generation, 'publication');
      db.exec('COMMIT');
      return this.getOwnership(sessionId);
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  private ensureOwnership(sessionId: string): void {
    this.getDb().prepare(`
      INSERT INTO session_worker_ownership(session_id,updated_at) VALUES(?,?)
      ON CONFLICT(session_id) DO NOTHING
    `).run(sessionId, Date.now());
  }

  private getIntent(id: number): SessionWorkerMailboxIntent {
    const row = this.getDb().prepare(`
      SELECT id,session_id,intent_id,kind,payload_json,created_at,applied_generation,applied_revision
      FROM session_worker_mailbox WHERE id = ?
    `).get(id) as any;
    if (!row) throw new RpcError('SESSION_WORKER_INTENT_NOT_FOUND', `Mailbox intent ${id} was not found.`);
    return this.toIntent(row);
  }

  private toIntent(row: any): SessionWorkerMailboxIntent {
    return {
      id: Number(row.id), sessionId: String(row.session_id), intentId: String(row.intent_id),
      kind: String(row.kind), payload: JSON.parse(String(row.payload_json)), createdAt: Number(row.created_at),
      ...(row.applied_generation == null ? {} : { appliedGeneration: Number(row.applied_generation) }),
      ...(row.applied_revision == null ? {} : { appliedRevision: Number(row.applied_revision) }),
    };
  }

  private toOwnership(row: any): SessionWorkerOwnershipRecord {
    return {
      sessionId: String(row.session_id), generation: Number(row.generation), state: row.state,
      ...(row.worker_pid == null ? {} : { workerPid: Number(row.worker_pid) }),
      headRevision: Number(row.head_revision),
      ...(row.head_path == null ? {} : { headPath: String(row.head_path) }),
      ...(row.head_sha256 == null ? {} : { headSha256: String(row.head_sha256) }),
      mailboxCursor: Number(row.mailbox_cursor), lastActivityAt: Number(row.last_activity_at),
      updatedAt: Number(row.updated_at),
      ...(row.last_exit_reason == null ? {} : { lastExitReason: String(row.last_exit_reason) }),
    };
  }

  private requireChanged(changes: number | bigint, sessionId: string, generation: number, action: string): void {
    if (Number(changes) !== 1) {
      throw new RpcError('SESSION_WORKER_STALE_GENERATION', `Session ${sessionId} generation ${generation} cannot commit ${action}.`, true);
    }
  }

  private getDb(): DatabaseSync {
    if (!this.db) this.open();
    return this.db!;
  }
}
