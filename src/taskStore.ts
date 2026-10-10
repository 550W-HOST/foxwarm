import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export const TASK_ACTIONS = ['create', 'list', 'get', 'claim', 'assign', 'update', 'complete', 'cancel'] as const;
export const TASK_STATUSES = ['open', 'active', 'completed', 'cancelled'] as const;
export const TASK_LIST_SCOPES = ['current-session', 'current-agent', 'all'] as const;
export const TASK_LIST_LIMIT = 50;
export const TASK_CHILD_LIMIT = 20;
export const TASK_NOTE_LIMIT = 10;
export type TaskStatus = typeof TASK_STATUSES[number];
export type TaskActorKind = 'session' | 'user';
export interface TaskRecord {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  parentTaskId: string | null;
  createdByKind: TaskActorKind;
  createdBySessionId: string | null;
  ownerSessionId: string | null;
  result: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  cancelledAt: number | null;
  completionNotificationStatus: string | null;
  assignmentNotificationStatus: string | null;
  previousOwnerSessionId: string | null;
  previousOwnerNotificationStatus: string | null;
  assignmentRevision: number;
  attachedSessionId: string | null;
  legacyGoalSessionId: string | null;
  reminderLastSeq: number | null;
  reminderMessageCount: number;
}

export class TaskError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 400) { super(message); }
}

type TaskArgs = Record<string, any>;
type TaskActor = { kind: 'user' } | { kind: 'session'; sessionId: string };
const ACTION_FIELDS: Record<typeof TASK_ACTIONS[number], string[]> = {
  create: ['title', 'description', 'parentTaskId', 'ownerSessionId', 'notifySession'],
  list: ['status', 'scope'],
  get: ['taskId'],
  claim: ['taskId'],
  assign: ['taskId', 'ownerSessionId', 'notifySession'],
  update: ['taskId', 'description', 'note', 'status', 'notifySession'],
  complete: ['taskId', 'result'],
  cancel: ['taskId', 'reason'],
};
const TEXT_LIMITS: Record<string, number> = {
  title: 200, description: 20000, parentTaskId: 128, taskId: 128,
  note: 1000, result: 20000, reason: 1000,
};

export function validateTaskArgs(args: TaskArgs): void {
  if (!args || typeof args !== 'object' || Array.isArray(args)
    || !TASK_ACTIONS.includes(args.action)) {
    throw new TaskError('TASK_INVALID_ARGS', `task action must be one of: ${TASK_ACTIONS.join(', ')}.`);
  }
  const allowed = ACTION_FIELDS[args.action as typeof TASK_ACTIONS[number]];
  for (const key of Object.keys(args)) {
    if (key !== 'action' && !allowed.includes(key)) throw new TaskError('TASK_INVALID_ARGS', `${key} is not allowed for task ${args.action}.`);
    if (key in TEXT_LIMITS && (typeof args[key] !== 'string' || args[key].length > TEXT_LIMITS[key])) {
      throw new TaskError('TASK_INVALID_ARGS', `${key} must be a string of at most ${TEXT_LIMITS[key]} characters.`);
    }
  }
  const required = args.action === 'create' ? 'title' : args.action === 'list' ? undefined : 'taskId';
  if (required && (typeof args[required] !== 'string' || !args[required].trim())) {
    throw new TaskError('TASK_INVALID_ARGS', `task ${args.action} requires a non-empty ${required}.`);
  }
  if (args.parentTaskId !== undefined && !args.parentTaskId.trim()) throw new TaskError('TASK_INVALID_ARGS', 'parentTaskId must be non-empty.');
  if (Object.prototype.hasOwnProperty.call(args, 'status')) {
    const statuses = args.action === 'update' ? ['open', 'active'] : TASK_STATUSES;
    if (!statuses.includes(args.status)) throw new TaskError('TASK_INVALID_ARGS', `status for task ${args.action} must be one of: ${statuses.join(', ')}.`);
  }
  if (args.action === 'list' && args.scope !== undefined && !TASK_LIST_SCOPES.includes(args.scope)) {
    throw new TaskError('TASK_INVALID_ARGS', `scope for task list must be one of: ${TASK_LIST_SCOPES.join(', ')}.`);
  }
  if (args.action === 'assign' && !Object.prototype.hasOwnProperty.call(args, 'ownerSessionId')) {
    throw new TaskError('TASK_INVALID_ARGS', 'task assign requires an existing ownerSessionId or null.');
  }
  if (Object.prototype.hasOwnProperty.call(args, 'ownerSessionId')
    && args.ownerSessionId !== null && (typeof args.ownerSessionId !== 'string' || !args.ownerSessionId.trim() || args.ownerSessionId.length > 256)) {
    throw new TaskError('TASK_INVALID_ARGS', 'ownerSessionId must identify an existing Session or be null.');
  }
  if (Object.prototype.hasOwnProperty.call(args, 'notifySession') && typeof args.notifySession !== 'boolean') {
    throw new TaskError('TASK_INVALID_ARGS', 'notifySession must be a boolean.');
  }
  if (args.action === 'update' && !['description', 'note', 'status'].some(key => Object.prototype.hasOwnProperty.call(args, key))) {
    throw new TaskError('TASK_INVALID_ARGS', 'task update requires description, note, or status.');
  }
  if (Object.prototype.hasOwnProperty.call(args, 'note') && !args.note.trim()) throw new TaskError('TASK_INVALID_ARGS', 'note must be non-empty.');
}


function generateTaskId(): string {
  return `task_${randomBytes(6).toString('hex')}`;
}

/** Small independent SQLite store; tasks never write Session state or history. */
export class TaskStore {
  private db?: DatabaseSync;
  constructor(readonly filePath: string, private readonly identities?: {
    resolveSessionId: (id: string) => string | undefined;
    sessionAliases: (id: string) => string[];
  }) {}

  private canonicalId(id: string): string {
    return this.identities?.resolveSessionId(id) || id;
  }

  private sessionReferences(id: string): string[] {
    const canonical = this.canonicalId(id);
    return [canonical, ...(this.identities?.sessionAliases(canonical) || [])];
  }

  private canonicalTask<T extends object>(task: T): T {
    const result = { ...task };
    const references = result as Record<string, string | null>;
    for (const field of ['createdBySessionId', 'ownerSessionId', 'attachedSessionId', 'previousOwnerSessionId']) {
      if (field in references && references[field] !== null) references[field] = this.canonicalId(references[field]);
    }
    return result;
  }

  private writeReferences(db: DatabaseSync, task: TaskRecord): void {
    db.prepare('UPDATE tasks SET createdBySessionId=?,ownerSessionId=?,attachedSessionId=?,previousOwnerSessionId=? WHERE id=?')
      .run(task.createdBySessionId, task.ownerSessionId, task.attachedSessionId, task.previousOwnerSessionId, task.id);
  }

  private addNote(db: DatabaseSync, taskId: string, author: { kind: TaskActorKind; sessionId?: string }, text: string, now: number): void {
    db.prepare('INSERT INTO task_notes (taskId,authorKind,sessionId,text,createdAt) VALUES (?,?,?,?,?)')
      .run(taskId, author.kind, author.kind === 'session' ? this.canonicalId(author.sessionId || '') : null, text, now);
  }

  private projectNoteAuthor(note: any): any {
    return {
      authorKind: note.authorKind === 'user' ? 'user' : 'session',
      sessionId: note.authorKind === 'session' && note.sessionId !== null ? this.canonicalId(note.sessionId as string) : null,
    };
  }

  private getDb(): DatabaseSync {
    if (this.db) return this.db;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const db = new DatabaseSync(this.filePath);
    try {
      db.exec(`PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT,
          status TEXT NOT NULL CHECK(status IN ('open','active','completed','cancelled')),
          parentTaskId TEXT REFERENCES tasks(id), createdByKind TEXT NOT NULL DEFAULT 'session' CHECK(createdByKind IN ('session','user')),
          createdBySessionId TEXT,
          ownerSessionId TEXT, result TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
          completedAt INTEGER, cancelledAt INTEGER
        );
        CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status, updatedAt);
        CREATE INDEX IF NOT EXISTS tasks_parent ON tasks(parentTaskId, createdAt);
        CREATE TABLE IF NOT EXISTS task_notes (
          id INTEGER PRIMARY KEY, taskId TEXT NOT NULL REFERENCES tasks(id),
          authorKind TEXT NOT NULL DEFAULT 'session' CHECK(authorKind IN ('session','user')),
          sessionId TEXT, text TEXT NOT NULL, createdAt INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS task_notes_task ON task_notes(taskId, id);
      `);
      const columns = db.prepare('PRAGMA table_info(tasks)').all() as any[];
      for (const [name, type] of [['completionNotificationStatus', 'TEXT'], ['assignmentNotificationStatus', 'TEXT'], ['previousOwnerSessionId', 'TEXT'], ['previousOwnerNotificationStatus', 'TEXT'], ['assignmentRevision', 'INTEGER NOT NULL DEFAULT 0'], ['attachedSessionId', 'TEXT'], ['legacyGoalSessionId', 'TEXT'], ['reminderLastSeq', 'INTEGER'], ['reminderMessageCount', 'INTEGER NOT NULL DEFAULT 0']]) {
        if (!columns.some(column => column.name === name)) db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${type}`);
      }
      this.migrateActorColumns(db, columns);
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS tasks_legacy_goal ON tasks(legacyGoalSessionId); CREATE INDEX IF NOT EXISTS tasks_self_owned ON tasks(createdBySessionId,ownerSessionId,status,createdAt,id)');
      this.db = db;
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  private migrateActorColumns(db: DatabaseSync, taskColumns: any[]): void {
    const noteColumns = db.prepare('PRAGMA table_info(task_notes)').all() as any[];
    if (taskColumns.some(column => column.name === 'createdByKind') && noteColumns.some(column => column.name === 'authorKind')) return;

    db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE;');
    try {
      db.exec('DROP INDEX IF EXISTS tasks_status; DROP INDEX IF EXISTS tasks_parent; DROP INDEX IF EXISTS tasks_legacy_goal; DROP INDEX IF EXISTS tasks_self_owned; DROP INDEX IF EXISTS task_notes_task;');
      db.exec(`ALTER TABLE tasks RENAME TO tasks_actor_legacy;
        ALTER TABLE task_notes RENAME TO task_notes_actor_legacy;
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT,
          status TEXT NOT NULL CHECK(status IN ('open','active','completed','cancelled')),
          parentTaskId TEXT REFERENCES tasks(id), createdByKind TEXT NOT NULL DEFAULT 'session' CHECK(createdByKind IN ('session','user')),
          createdBySessionId TEXT,
          ownerSessionId TEXT, result TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
          completedAt INTEGER, cancelledAt INTEGER,
          completionNotificationStatus TEXT, assignmentNotificationStatus TEXT,
          previousOwnerSessionId TEXT, previousOwnerNotificationStatus TEXT,
          assignmentRevision INTEGER NOT NULL DEFAULT 0, attachedSessionId TEXT,
          legacyGoalSessionId TEXT, reminderLastSeq INTEGER, reminderMessageCount INTEGER NOT NULL DEFAULT 0
        );
        INSERT INTO tasks (id,title,description,status,parentTaskId,createdByKind,createdBySessionId,ownerSessionId,result,createdAt,updatedAt,
          completedAt,cancelledAt,completionNotificationStatus,assignmentNotificationStatus,previousOwnerSessionId,previousOwnerNotificationStatus,
          assignmentRevision,attachedSessionId,legacyGoalSessionId,reminderLastSeq,reminderMessageCount)
          SELECT id,title,description,status,parentTaskId,'session',createdBySessionId,ownerSessionId,result,createdAt,updatedAt,
            completedAt,cancelledAt,completionNotificationStatus,assignmentNotificationStatus,previousOwnerSessionId,previousOwnerNotificationStatus,
            assignmentRevision,attachedSessionId,legacyGoalSessionId,reminderLastSeq,reminderMessageCount FROM tasks_actor_legacy;
        CREATE TABLE task_notes (
          id INTEGER PRIMARY KEY, taskId TEXT NOT NULL REFERENCES tasks(id),
          authorKind TEXT NOT NULL DEFAULT 'session' CHECK(authorKind IN ('session','user')),
          sessionId TEXT, text TEXT NOT NULL, createdAt INTEGER NOT NULL
        );
        INSERT INTO task_notes (id,taskId,authorKind,sessionId,text,createdAt)
          SELECT id,taskId,'session',sessionId,text,createdAt FROM task_notes_actor_legacy;
        DROP TABLE task_notes_actor_legacy;
        DROP TABLE tasks_actor_legacy;
        CREATE INDEX tasks_status ON tasks(status, updatedAt);
        CREATE INDEX tasks_parent ON tasks(parentTaskId, createdAt);
        CREATE INDEX task_notes_task ON task_notes(taskId, id);`);
      db.exec('COMMIT; PRAGMA foreign_keys=ON;');
    } catch (error) {
      try { db.exec('ROLLBACK; PRAGMA foreign_keys=ON;'); } catch {}
      throw error;
    }
  }

  close(): void {
    this.db?.close();
    this.db = undefined;
  }

  markCompletionNotification(taskId: string, status: 'sent' | 'failed' | 'skipped'): void {
    this.markNotification(taskId, 'completionNotificationStatus', status);
  }

  markAssignmentNotification(taskId: string, revision: number, recipient: 'new' | 'previous', status: 'sent' | 'failed' | 'skipped'): void {
    this.markNotification(taskId, recipient === 'new' ? 'assignmentNotificationStatus' : 'previousOwnerNotificationStatus', status, revision);
  }

  /** Internal delivery read: keep public TaskStore projections bounded. */
  readStoredDescription(taskId: string): string | null {
    const row = this.getDb().prepare('SELECT description FROM tasks WHERE id=?').get(taskId) as { description?: unknown } | undefined;
    if (!row) throw new TaskError('TASK_NOT_FOUND', `Task ${taskId} was not found.`, 404);
    return typeof row.description === 'string' ? row.description : null;
  }

  private markNotification(taskId: string, field: 'completionNotificationStatus' | 'assignmentNotificationStatus' | 'previousOwnerNotificationStatus', status: string, revision?: number): void {
    const db = this.getDb();
    db.exec('BEGIN IMMEDIATE');
    try {
      this.writeReferences(db, this.requireTask(db, taskId));
      db.prepare(`UPDATE tasks SET ${field}=? WHERE id=? AND ${field}='pending'${revision === undefined ? '' : ' AND assignmentRevision=?'}`)
        .run(status, taskId, ...(revision === undefined ? [] : [revision]));
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  execute(args: TaskArgs, sessionId?: string, listLimit = TASK_LIST_LIMIT, anchorSeq?: number, scopeSessionIds?: readonly string[]): any {
    validateTaskArgs(args);
    if (args.action !== 'list' && args.action !== 'get' && (typeof sessionId !== 'string' || !sessionId.trim())) throw new TaskError('TASK_INVALID_ARGS', 'task requires a current Session.');
    if (sessionId !== undefined) sessionId = this.canonicalId(sessionId);
    if (args.ownerSessionId !== undefined && args.ownerSessionId !== null) args = { ...args, ownerSessionId: this.canonicalId(args.ownerSessionId) };
    return this.executeWithActor(args, { kind: 'session', sessionId }, listLimit, anchorSeq, scopeSessionIds);
  }

  /** User authority is supplied only by the authenticated Tasks route. */
  executeAsUser(args: TaskArgs): any {
    args = args.action !== 'comment' && args.notifySession === undefined ? { ...args, notifySession: true } : args;
    if (args.action === 'comment') {
      const { notifySession, ...comment } = args;
      // Reuse the existing note and task-ID bounds without extending the tool schema.
      validateTaskArgs({ ...comment, action: 'update' });
      if (typeof args.note !== 'string' || !args.note.trim()) throw new TaskError('TASK_INVALID_ARGS', 'A comment requires a non-empty note.');
      if (notifySession !== undefined && typeof notifySession !== 'boolean') throw new TaskError('TASK_INVALID_ARGS', 'notifySession must be a boolean.');
      if (Object.keys(args).some(key => !['action', 'taskId', 'note', 'notifySession'].includes(key))) throw new TaskError('TASK_INVALID_ARGS', 'Comments accept note and notifySession only.');
    } else {
      if (!['create', 'assign'].includes(args.action)) throw new TaskError('TASK_INVALID_ARGS', 'Invalid user task operation.');
      validateTaskArgs(args);
    }
    if (args.ownerSessionId !== undefined && args.ownerSessionId !== null) args = { ...args, ownerSessionId: this.canonicalId(args.ownerSessionId) };
    return this.executeWithActor(args, { kind: 'user' });
  }

  private executeWithActor(args: TaskArgs, actor: TaskActor, listLimit = TASK_LIST_LIMIT, anchorSeq?: number, scopeSessionIds?: readonly string[]): any {
    const db = this.getDb();
    // A write transaction covers the read, authority check and update, even
    // across independent SQLite connections/processes racing to claim.
    db.exec(args.action === 'list' || args.action === 'get' ? 'BEGIN' : 'BEGIN IMMEDIATE');
    try {
      const result = this.executeInTransaction(db, args, actor, listLimit, anchorSeq, scopeSessionIds);
      db.exec('COMMIT');
      if (result.task) {
        const { legacyGoalSessionId, reminderLastSeq, reminderMessageCount, assignmentRevision, ...visibleTask } = result.task;
        result.task = visibleTask;
        if (result.task.description?.length > 20000) result.task.description = result.task.description.slice(0, 19999) + '…';
      }
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  private executeInTransaction(db: DatabaseSync, args: TaskArgs, actor: TaskActor, listLimit: number, anchorSeq?: number, scopeSessionIds?: readonly string[]): any {
    const sessionId = actor.kind === 'session' ? actor.sessionId : null;
    if (args.action === 'list') {
      const filters = [args.status === undefined ? "status IN ('open','active')" : 'status=?'];
      const params: any[] = args.status === undefined ? [] : [args.status];
      if (args.scope !== undefined && args.scope !== 'all') {
        const scopedIds = scopeSessionIds ?? (args.scope === 'current-session' && sessionId ? [sessionId] : []);
        const ids = [...new Set(scopedIds.flatMap(id => this.sessionReferences(id)))];
        if (ids.length === 0) filters.push('0');
        else {
          const placeholders = ids.map(() => '?').join(',');
          filters.push(`(createdBySessionId IN (${placeholders}) OR ownerSessionId IN (${placeholders}))`);
          params.push(...ids, ...ids);
        }
      }
      const where = filters.join(' AND ');
      const tasks = db.prepare(`SELECT id,title,status,parentTaskId,createdByKind,createdBySessionId,ownerSessionId,updatedAt
        FROM tasks WHERE ${where} ORDER BY updatedAt DESC,id LIMIT ?`).all(...params, Math.max(1, Math.min(TASK_LIST_LIMIT, listLimit)));
      const total = Number(db.prepare(`SELECT COUNT(*) AS count FROM tasks WHERE ${where}`).get(...params).count);
      return { tasks: tasks.map(task => this.canonicalTask(task)), total, omitted: total - tasks.length };
    }
    const now = Date.now();
    if (args.action === 'create') {
      if (args.parentTaskId && !db.prepare('SELECT id FROM tasks WHERE id=?').get(args.parentTaskId)) {
        throw new TaskError('TASK_NOT_FOUND', `Parent task ${args.parentTaskId} not found.`, 404);
      }
      // Parent is immutable and can only reference an existing task. A fresh
      // generated ID therefore cannot form a cycle, including self-parenting.
      const id = generateTaskId();
      const owner = args.ownerSessionId ?? null;
      const notify = owner !== null && args.notifySession === true;
      db.prepare(`INSERT INTO tasks (id,title,description,status,parentTaskId,createdByKind,createdBySessionId,ownerSessionId,createdAt,updatedAt,
        assignmentRevision,assignmentNotificationStatus,reminderLastSeq) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, args.title, args.description ?? null, owner ? 'active' : 'open', args.parentTaskId ?? null, actor.kind, sessionId, owner,
          now, now, owner ? 1 : 0, notify ? 'pending' : null, owner === sessionId ? anchorSeq ?? null : null);
      return { task: this.requireTask(db, id), ...(notify ? { assignmentNotification: { revision: 1, newOwner: owner } } : {}) };
    }
    const task = this.requireTask(db, args.taskId);
    if (args.action === 'get') {
      const children = db.prepare(`SELECT id,title,status,ownerSessionId FROM tasks WHERE parentTaskId=?
        ORDER BY createdAt,id LIMIT ?`).all(task.id, TASK_CHILD_LIMIT);
      const childCount = Number(db.prepare('SELECT COUNT(*) AS count FROM tasks WHERE parentTaskId=?').get(task.id).count);
      const notes = db.prepare(`SELECT authorKind,sessionId,text,createdAt FROM task_notes WHERE taskId=?
        ORDER BY id DESC LIMIT ?`).all(task.id, TASK_NOTE_LIMIT).reverse();
      const noteCount = Number(db.prepare('SELECT COUNT(*) AS count FROM task_notes WHERE taskId=?').get(task.id).count);
      return { task, children: children.map(child => this.canonicalTask(child)), childrenOmitted: childCount - children.length,
        notes: notes.map(note => ({ ...this.projectNoteAuthor(note), text: note.text, createdAt: note.createdAt })), notesOmitted: noteCount - notes.length };
    }
    if (args.action === 'comment') {
      this.writeReferences(db, task);
      this.addNote(db, task.id, actor, args.note, now);
      db.prepare('UPDATE tasks SET updatedAt=? WHERE id=?').run(now, task.id);
      return { task: this.requireTask(db, task.id),
        ...(args.notifySession === true && task.ownerSessionId ? { commentNotification: { owner: task.ownerSessionId } } : {}) };
    }
    const state = `status=${task.status}, owner=${task.ownerSessionId ?? 'unclaimed'}`;
    if (task.status === 'completed' || task.status === 'cancelled') {
      throw new TaskError('TASK_TERMINAL', `Task ${task.id} is terminal (${state}); ${args.action} is not allowed.`, 409);
    }
    let assignmentNotification: { revision: number; newOwner?: string; previousOwner?: string };
    if (args.action === 'claim') {
      if (task.ownerSessionId && task.ownerSessionId !== sessionId) {
        throw new TaskError('TASK_OWNED', `Task ${task.id} is already claimed by another Session (${state}).`, 409);
      }
      this.writeReferences(db, task);
      if (!task.ownerSessionId) db.prepare("UPDATE tasks SET ownerSessionId=?,status='active',updatedAt=?,reminderLastSeq=?,reminderMessageCount=0 WHERE id=?")
        .run(sessionId, now, anchorSeq ?? null, task.id);
    } else {
      const noteOnlyUpdate = args.action === 'update'
        && Object.prototype.hasOwnProperty.call(args, 'note')
        && !Object.prototype.hasOwnProperty.call(args, 'description')
        && !Object.prototype.hasOwnProperty.call(args, 'status');
      const permitted = args.action === 'cancel' || args.action === 'assign'
        ? sessionId === task.createdBySessionId || sessionId === task.ownerSessionId
        : noteOnlyUpdate || sessionId === (task.ownerSessionId ?? task.createdBySessionId);
      if (actor.kind !== 'user' && !permitted) throw new TaskError('TASK_FORBIDDEN', `Session ${sessionId} cannot ${args.action} task ${task.id} (${state}); ${args.action === 'cancel' || args.action === 'assign' ? 'creator or owner' : task.ownerSessionId ? 'owner' : 'creator'} required.`, 403);
      this.writeReferences(db, task);
      if (args.action === 'assign') {
        const changedOwner = task.ownerSessionId !== args.ownerSessionId;
        const revision = task.assignmentRevision + (changedOwner ? 1 : 0);
        const previousOwner = changedOwner ? task.ownerSessionId : task.previousOwnerSessionId;
        const previousStatus = changedOwner ? null : task.previousOwnerNotificationStatus;
        const newStatus = changedOwner ? null : task.assignmentNotificationStatus;
        const notifyNew = args.notifySession === true && args.ownerSessionId !== null && (!newStatus || newStatus === 'failed');
        const notifyPrevious = args.notifySession === true && previousOwner !== null && previousOwner !== args.ownerSessionId
          && (changedOwner || previousStatus === 'failed');
        db.prepare(`UPDATE tasks SET ownerSessionId=?,status=?,updatedAt=?,assignmentRevision=?,previousOwnerSessionId=?,
          assignmentNotificationStatus=?,previousOwnerNotificationStatus=? WHERE id=?`)
          .run(args.ownerSessionId, args.ownerSessionId ? 'active' : 'open', now, revision, previousOwner,
            notifyNew ? 'pending' : newStatus, notifyPrevious ? 'pending' : previousStatus, task.id);
        assignmentNotification = { revision, newOwner: notifyNew ? args.ownerSessionId : undefined, previousOwner: notifyPrevious ? previousOwner : undefined };
        if (changedOwner) db.prepare('UPDATE tasks SET reminderLastSeq=?,reminderMessageCount=0 WHERE id=?')
          .run(args.ownerSessionId === sessionId ? anchorSeq ?? null : null, task.id);
        if (changedOwner) this.addNote(db, task.id, actor, `Owner changed from ${task.ownerSessionId ?? 'unclaimed'} to ${args.ownerSessionId ?? 'unclaimed'}.`, now);
      } else if (args.action === 'update') {
        db.prepare('UPDATE tasks SET description=?,status=?,updatedAt=? WHERE id=?')
          .run(args.description ?? task.description, args.status ?? task.status, now, task.id);
        if (args.status === 'active' && task.status !== 'active') db.prepare('UPDATE tasks SET reminderLastSeq=?,reminderMessageCount=0 WHERE id=?')
          .run(anchorSeq ?? null, task.id);
        if (args.note !== undefined) this.addNote(db, task.id, actor, args.note, now);
        if (args.note !== undefined && args.notifySession === true && task.ownerSessionId && task.ownerSessionId !== sessionId) {
          return { task: this.requireTask(db, task.id), commentNotification: { owner: task.ownerSessionId } };
        }
      } else if (args.action === 'complete') {
        db.prepare("UPDATE tasks SET status='completed',result=?,completedAt=?,updatedAt=?,completionNotificationStatus='pending' WHERE id=?")
          .run(args.result ?? null, now, now, task.id);
      } else if (args.action === 'cancel') {
        db.prepare("UPDATE tasks SET status='cancelled',cancelledAt=?,updatedAt=? WHERE id=?").run(now, now, task.id);
        if (args.reason !== undefined) this.addNote(db, task.id, actor, args.reason, now);
      }
    }
    return { task: this.requireTask(db, task.id), ...(assignmentNotification ? { assignmentNotification } : {}) };
  }


  attachChild(taskId: string, childSessionId: string): void {
    childSessionId = this.canonicalId(childSessionId);
    const db = this.getDb();
    db.exec('BEGIN IMMEDIATE');
    try {
      const task = this.requireTask(db, taskId);
      if (task.ownerSessionId !== childSessionId) throw new TaskError('TASK_OWNED', `Task ${task.id} is not owned by child Session ${childSessionId}.`, 409);
      db.prepare('UPDATE tasks SET attachedSessionId=? WHERE id=?').run(childSessionId, taskId);
      this.addNote(db, taskId, { kind: 'session', sessionId: childSessionId }, `Attached new Session ${childSessionId}.`, Date.now());
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  /** Retry-safe legacy migration; a terminal migrated task is never recreated/reactivated. */
  migrateLegacyGoal(sessionId: string, goal: string, anchorSeq: number): TaskRecord {
    sessionId = this.canonicalId(sessionId);
    const db = this.getDb();
    db.exec('BEGIN IMMEDIATE');
    try {
      const references = this.sessionReferences(sessionId);
      let task = db.prepare(`SELECT * FROM tasks WHERE legacyGoalSessionId IN (${references.map(() => '?').join(',')}) ORDER BY createdAt,id LIMIT 1`)
        .get(...references) as unknown as TaskRecord;
      if (task) { task = this.canonicalTask(task); this.writeReferences(db, task); }
      if (!task) {
        const now = Date.now();
        const id = generateTaskId();
        const title = goal.trim().split('\n')[0].slice(0, 200) || 'Migrated task';
        db.prepare(`INSERT INTO tasks (id,title,description,status,createdBySessionId,ownerSessionId,createdAt,updatedAt,
          legacyGoalSessionId,reminderLastSeq) VALUES (?,?,?,'active',?,?,?,?,?,?)`)
          .run(id, title, goal, sessionId, sessionId, now, now, sessionId, anchorSeq);
        task = this.requireTask(db, id);
      }
      db.exec('COMMIT');
      return task;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  /** Counts only supplied ordinary visible seqs; callers checkpoint before compact removal. */
  taskContext(sessionId: string, sequences: number[], consume: boolean, retainedTaskIds: string[] = []): any[] {
    sessionId = this.canonicalId(sessionId);
    const db = this.getDb();
    db.exec('BEGIN IMMEDIATE');
    try {
      const references = this.sessionReferences(sessionId);
      const placeholders = references.map(() => '?').join(',');
      const eligible = (db.prepare(`SELECT * FROM tasks WHERE createdBySessionId IN (${placeholders}) AND ownerSessionId IN (${placeholders}) AND status='active' ORDER BY createdAt,id`)
        .all(...references, ...references) as unknown as TaskRecord[]).map(task => this.canonicalTask(task));
      const tasks: any[] = [];
      const latest = sequences.length ? sequences[sequences.length - 1] : 0;
      for (const task of eligible) {
        this.writeReferences(db, task);
        let count = task.reminderMessageCount;
        if (task.reminderLastSeq === null) count = 0;
        else count = Math.min(30, count + sequences.filter(seq => seq > task.reminderLastSeq).length);
        const due = count >= 30;
        if (consume && (due || retainedTaskIds.includes(task.id))) {
          tasks.push({ id: task.id, title: task.title, status: task.status });
          if (due) count = 0;
        }
        db.prepare('UPDATE tasks SET reminderLastSeq=?,reminderMessageCount=? WHERE id=?')
          .run(Math.max(latest, task.reminderLastSeq ?? 0), count, task.id);
      }
      db.exec('COMMIT');
      return tasks;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  private requireTask(db: DatabaseSync, taskId: string): TaskRecord {
    const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId) as unknown as TaskRecord;
    if (!task) throw new TaskError('TASK_NOT_FOUND', `Task ${taskId} not found.`, 404);
    return this.canonicalTask(task);
  }

}
