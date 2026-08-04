import fs from 'fs-extra';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SESSION_RUNTIME_DB_PATH } from './config';
import { RpcError } from './rpc';
import { stableSessionWorkerJson } from './sessionWorkerStableJson';
import { configureAndMigrateSessionWorkerDb } from './sessionWorkerStoreSchema';

export type SessionWorkerOwnershipState = 'inactive' | 'candidate' | 'ready' | 'draining';
export type SessionWorkerStoreOperation = 'register-candidate' | 'activate' | 'clear' | 'drain' | 'exit' | 'touch' | 'publish';

export type SessionWorkerOwnershipRecord = {
  sessionId: string;
  generation: number;
  state: SessionWorkerOwnershipState;
  incarnationId?: string;
  workerPid?: number;
  processIdentity?: string;
  activatedAt?: number;
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
  incarnationId: string;
  expectedRevision: number;
  revision: number;
  headPath: string;
  headSha256: string;
  appliedMailboxIds: number[];
};

export type SessionWorkerStoreOptions = {
  faultInjector?: (operation: SessionWorkerStoreOperation, sessionId: string) => void;
};

function requiredText(value: string, code: string, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new RpcError(code, `${label} must be non-empty.`);
  return value.trim();
}

export class SessionWorkerStore {
  private db?: DatabaseSync;

  constructor(readonly filePath = SESSION_RUNTIME_DB_PATH, private readonly options: SessionWorkerStoreOptions = {}) {}

  open(): void {
    if (this.db) return;
    fs.ensureDirSync(path.dirname(this.filePath));
    const db = new DatabaseSync(this.filePath);
    try {
      configureAndMigrateSessionWorkerDb(db);
      this.db = db;
    } catch (error) {
      try { db.close(); } catch {}
      throw error;
    }
  }

  close(): void {
    this.db?.close();
    this.db = undefined;
  }

  listFencedOwnerships(): SessionWorkerOwnershipRecord[] {
    const rows = this.getDb().prepare(`
      SELECT * FROM session_worker_ownership WHERE state != 'inactive' ORDER BY session_id
    `).all() as any[];
    return rows.map(row => this.toOwnership(row));
  }

  getOwnership(sessionId: string): SessionWorkerOwnershipRecord {
    sessionId = this.sessionId(sessionId);
    this.ensureOwnership(sessionId);
    const row = this.getDb().prepare('SELECT * FROM session_worker_ownership WHERE session_id=?').get(sessionId) as any;
    return this.toOwnership(row);
  }

  beginGeneration(sessionId: string, incarnationId: string): SessionWorkerOwnershipRecord {
    sessionId = this.sessionId(sessionId);
    incarnationId = this.incarnationId(incarnationId);
    const db = this.getDb();
    this.ensureOwnership(sessionId);
    return this.transaction(() => {
      const current = this.getOwnership(sessionId);
      if (current.state !== 'inactive' || current.workerPid !== undefined || current.incarnationId !== undefined) {
        throw new RpcError('SESSION_WORKER_OWNED', `Session ${sessionId} generation ${current.generation} remains fenced (${current.state}).`, true);
      }
      const generation = current.generation + 1;
      const now = Date.now();
      const changed = db.prepare(`
        UPDATE session_worker_ownership
        SET generation=?,state='candidate',incarnation_id=?,worker_pid=NULL,process_identity=NULL,
            activated_at=NULL,last_activity_at=?,updated_at=?,last_exit_reason=NULL
        WHERE session_id=? AND generation=? AND state='inactive' AND incarnation_id IS NULL
      `).run(generation, incarnationId, now, now, sessionId, current.generation);
      this.requireChanged(changed.changes, sessionId, generation, 'candidate');
      return this.getOwnership(sessionId);
    });
  }

  registerCandidate(sessionId: string, generation: number, incarnationId: string, workerPid: number, processIdentity: string): SessionWorkerOwnershipRecord {
    this.inject('register-candidate', sessionId);
    if (!Number.isSafeInteger(workerPid) || workerPid <= 0) throw new RpcError('SESSION_WORKER_INVALID_PID', 'Worker PID must be positive.');
    processIdentity = requiredText(processIdentity, 'SESSION_WORKER_INVALID_PROCESS_IDENTITY', 'Worker process identity');
    const changed = this.getDb().prepare(`
      UPDATE session_worker_ownership SET worker_pid=?,process_identity=?,updated_at=?
      WHERE session_id=? AND generation=? AND incarnation_id=? AND state='candidate'
        AND worker_pid IS NULL AND process_identity IS NULL
    `).run(workerPid, processIdentity, Date.now(), this.sessionId(sessionId), generation, this.incarnationId(incarnationId));
    this.requireChanged(changed.changes, sessionId, generation, 'candidate registration');
    return this.getOwnership(sessionId);
  }

  activateCandidate(sessionId: string, generation: number, incarnationId: string, workerPid: number, processIdentity: string): SessionWorkerOwnershipRecord {
    this.inject('activate', sessionId);
    const now = Date.now();
    const changed = this.getDb().prepare(`
      UPDATE session_worker_ownership SET state='ready',activated_at=?,last_activity_at=?,updated_at=?
      WHERE session_id=? AND generation=? AND incarnation_id=? AND state='candidate'
        AND worker_pid=? AND process_identity=?
    `).run(now, now, now, this.sessionId(sessionId), generation, this.incarnationId(incarnationId), workerPid, processIdentity);
    this.requireChanged(changed.changes, sessionId, generation, 'activation');
    return this.getOwnership(sessionId);
  }

  verifyActivatedIncarnation(sessionId: string, generation: number, incarnationId: string, workerPid: number, processIdentity: string): SessionWorkerOwnershipRecord {
    const current = this.getOwnership(sessionId);
    if (current.generation !== generation || current.incarnationId !== incarnationId || current.state !== 'ready'
      || current.workerPid !== workerPid || current.processIdentity !== processIdentity || !current.activatedAt) {
      throw new RpcError('SESSION_WORKER_NOT_ACTIVATED', `Session ${sessionId} incarnation is not durably activated.`, true);
    }
    return current;
  }

  clearUnregisteredCandidate(sessionId: string, generation: number, incarnationId: string, reason: string): SessionWorkerOwnershipRecord {
    this.inject('clear', sessionId);
    const changed = this.getDb().prepare(`
      UPDATE session_worker_ownership
      SET state='inactive',incarnation_id=NULL,worker_pid=NULL,process_identity=NULL,activated_at=NULL,
          updated_at=?,last_exit_reason=?
      WHERE session_id=? AND generation=? AND incarnation_id=? AND state='candidate'
        AND worker_pid IS NULL AND process_identity IS NULL AND activated_at IS NULL
    `).run(Date.now(), reason, this.sessionId(sessionId), generation, this.incarnationId(incarnationId));
    this.requireChanged(changed.changes, sessionId, generation, 'abandoned candidate');
    return this.getOwnership(sessionId);
  }

  markDraining(sessionId: string, generation: number, incarnationId: string): SessionWorkerOwnershipRecord {
    this.inject('drain', sessionId);
    const changed = this.getDb().prepare(`
      UPDATE session_worker_ownership SET state='draining',updated_at=?
      WHERE session_id=? AND generation=? AND incarnation_id=? AND state IN ('candidate','ready')
    `).run(Date.now(), this.sessionId(sessionId), generation, this.incarnationId(incarnationId));
    this.requireChanged(changed.changes, sessionId, generation, 'draining');
    return this.getOwnership(sessionId);
  }

  markExitObserved(sessionId: string, generation: number, incarnationId: string, reason: string): SessionWorkerOwnershipRecord {
    this.inject('exit', sessionId);
    const changed = this.getDb().prepare(`
      UPDATE session_worker_ownership
      SET state='inactive',incarnation_id=NULL,worker_pid=NULL,process_identity=NULL,activated_at=NULL,
          updated_at=?,last_exit_reason=?
      WHERE session_id=? AND generation=? AND incarnation_id=? AND state!='inactive'
    `).run(Date.now(), reason, this.sessionId(sessionId), generation, this.incarnationId(incarnationId));
    this.requireChanged(changed.changes, sessionId, generation, 'exit');
    return this.getOwnership(sessionId);
  }

  touch(sessionId: string, generation: number, incarnationId: string, timestamp = Date.now()): void {
    this.inject('touch', sessionId);
    const changed = this.getDb().prepare(`
      UPDATE session_worker_ownership SET last_activity_at=?,updated_at=?
      WHERE session_id=? AND generation=? AND incarnation_id=? AND state='ready'
    `).run(timestamp, timestamp, this.sessionId(sessionId), generation, this.incarnationId(incarnationId));
    this.requireChanged(changed.changes, sessionId, generation, 'activity');
  }

  enqueueIntent(sessionId: string, intentId: string, kind: string, payload: unknown): SessionWorkerMailboxIntent {
    sessionId = this.sessionId(sessionId);
    intentId = requiredText(intentId, 'SESSION_WORKER_INVALID_INTENT', 'Mailbox intent ID');
    kind = requiredText(kind, 'SESSION_WORKER_INVALID_INTENT', 'Mailbox intent kind');
    const payloadJson = stableSessionWorkerJson(payload);
    const db = this.getDb();
    return this.transaction(() => {
      db.prepare(`
        INSERT INTO session_worker_mailbox(session_id,intent_id,kind,payload_json,created_at)
        VALUES(?,?,?,?,?) ON CONFLICT(session_id,intent_id) DO NOTHING
      `).run(sessionId, intentId, kind, payloadJson, Date.now());
      const row = db.prepare('SELECT * FROM session_worker_mailbox WHERE session_id=? AND intent_id=?').get(sessionId, intentId) as any;
      if (!row || row.kind !== kind || row.payload_json !== payloadJson) {
        throw new RpcError('SESSION_WORKER_INTENT_CONFLICT', `Mailbox intent ${intentId} was reused with different content.`);
      }
      return this.toIntent(row);
    });
  }

  countMailboxIntents(): number {
    return Number((this.getDb().prepare('SELECT COUNT(*) AS count FROM session_worker_mailbox').get() as any).count);
  }

  listPendingIntents(sessionId: string, afterId?: number, limit = 256): SessionWorkerMailboxIntent[] {
    sessionId = this.sessionId(sessionId);
    const cursor = afterId === undefined ? this.getOwnership(sessionId).mailboxCursor : Math.max(0, Math.floor(afterId));
    return (this.getDb().prepare(`
      SELECT * FROM session_worker_mailbox
      WHERE session_id=? AND id>? AND applied_revision IS NULL ORDER BY id LIMIT ?
    `).all(sessionId, cursor, Math.max(1, Math.min(4096, Math.floor(limit)))) as any[]).map(row => this.toIntent(row));
  }

  publishHead(publication: SessionWorkerHeadPublication): SessionWorkerOwnershipRecord {
    this.inject('publish', publication.sessionId);
    const { sessionId, generation, incarnationId, expectedRevision, revision, headPath, headSha256 } = publication;
    if (!Number.isSafeInteger(revision) || revision !== expectedRevision + 1 || !headPath || !headSha256) {
      throw new RpcError('SESSION_WORKER_INVALID_REVISION', 'Published head must increment once and include path/hash.');
    }
    const ids = [...new Set(publication.appliedMailboxIds)].sort((a, b) => a - b);
    const db = this.getDb();
    return this.transaction(() => {
      const current = this.verifyPublicationOwner(sessionId, generation, incarnationId, expectedRevision);
      if (ids.length) {
        const prefix = db.prepare(`
          SELECT id FROM session_worker_mailbox
          WHERE session_id=? AND id>? AND applied_revision IS NULL ORDER BY id LIMIT ?
        `).all(sessionId, current.mailboxCursor, ids.length) as Array<{ id: number }>;
        if (prefix.length !== ids.length || prefix.some((row, index) => Number(row.id) !== ids[index])) {
          throw new RpcError('SESSION_WORKER_MAILBOX_CONFLICT', `Mailbox publication for ${sessionId} must acknowledge an ordered pending prefix.`);
        }
      }
      let cursor = current.mailboxCursor;
      for (const id of ids) {
        const changed = db.prepare(`
          UPDATE session_worker_mailbox SET applied_generation=?,applied_revision=?
          WHERE id=? AND session_id=? AND applied_revision IS NULL
        `).run(generation, revision, id, sessionId);
        this.requireChanged(changed.changes, sessionId, generation, `mailbox ${id}`);
        cursor = Math.max(cursor, id);
      }
      const changed = db.prepare(`
        UPDATE session_worker_ownership
        SET head_revision=?,head_path=?,head_sha256=?,mailbox_cursor=?,last_activity_at=?,updated_at=?
        WHERE session_id=? AND generation=? AND incarnation_id=?
          AND state IN ('ready','draining') AND head_revision=?
      `).run(revision, headPath, headSha256, cursor, Date.now(), Date.now(), sessionId, generation, incarnationId, expectedRevision);
      this.requireChanged(changed.changes, sessionId, generation, 'publication');
      return this.getOwnership(sessionId);
    });
  }

  private verifyPublicationOwner(sessionId: string, generation: number, incarnationId: string, revision: number): SessionWorkerOwnershipRecord {
    const current = this.getOwnership(sessionId);
    if (current.generation !== generation || current.incarnationId !== incarnationId
      || !['ready', 'draining'].includes(current.state) || current.headRevision !== revision || !current.activatedAt) {
      throw new RpcError('SESSION_WORKER_STALE_GENERATION', `Session ${sessionId} generation/revision cannot publish.`, true);
    }
    return current;
  }

  private ensureOwnership(sessionId: string): void {
    this.getDb().prepare(`INSERT INTO session_worker_ownership(session_id,updated_at) VALUES(?,?) ON CONFLICT(session_id) DO NOTHING`).run(sessionId, Date.now());
  }
  private toIntent(row: any): SessionWorkerMailboxIntent {
    return { id: Number(row.id), sessionId: String(row.session_id), intentId: String(row.intent_id), kind: String(row.kind),
      payload: JSON.parse(String(row.payload_json)), createdAt: Number(row.created_at),
      ...(row.applied_generation == null ? {} : { appliedGeneration: Number(row.applied_generation) }),
      ...(row.applied_revision == null ? {} : { appliedRevision: Number(row.applied_revision) }) };
  }
  private toOwnership(row: any): SessionWorkerOwnershipRecord {
    return { sessionId: String(row.session_id), generation: Number(row.generation), state: row.state,
      ...(row.incarnation_id == null ? {} : { incarnationId: String(row.incarnation_id) }),
      ...(row.worker_pid == null ? {} : { workerPid: Number(row.worker_pid) }),
      ...(row.process_identity == null ? {} : { processIdentity: String(row.process_identity) }),
      ...(row.activated_at == null ? {} : { activatedAt: Number(row.activated_at) }),
      headRevision: Number(row.head_revision), ...(row.head_path == null ? {} : { headPath: String(row.head_path) }),
      ...(row.head_sha256 == null ? {} : { headSha256: String(row.head_sha256) }), mailboxCursor: Number(row.mailbox_cursor),
      lastActivityAt: Number(row.last_activity_at), updatedAt: Number(row.updated_at),
      ...(row.last_exit_reason == null ? {} : { lastExitReason: String(row.last_exit_reason) }) };
  }
  private transaction<T>(run: () => T): T {
    const db = this.getDb(); db.exec('BEGIN IMMEDIATE');
    try { const result = run(); db.exec('COMMIT'); return result; }
    catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  }
  private requireChanged(changes: number | bigint, sessionId: string, generation: number, action: string): void {
    if (Number(changes) !== 1) throw new RpcError('SESSION_WORKER_STALE_GENERATION', `Session ${sessionId} generation ${generation} cannot commit ${action}.`, true);
  }
  private sessionId(value: string): string { return requiredText(value, 'SESSION_WORKER_INVALID_SESSION', 'Session ID'); }
  private incarnationId(value: string): string { return requiredText(value, 'SESSION_WORKER_INVALID_INCARNATION', 'Worker incarnation ID'); }
  private inject(operation: SessionWorkerStoreOperation, sessionId: string): void { this.options.faultInjector?.(operation, sessionId); }
  private getDb(): DatabaseSync { if (!this.db) this.open(); return this.db!; }
}
