import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export const TASK_ACTIONS = ['create', 'list', 'get', 'claim', 'assign', 'update', 'complete', 'cancel'] as const;
export const TASK_STATUSES = ['open', 'active', 'completed', 'cancelled'] as const;
export const TASK_LIST_LIMIT = 50;
export const TASK_CHILD_LIMIT = 20;
export const TASK_NOTE_LIMIT = 10;
export type TaskStatus = typeof TASK_STATUSES[number];
export interface TaskRecord {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  parentTaskId: string | null;
  createdBySessionId: string;
  ownerSessionId: string | null;
  result: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  cancelledAt: number | null;
  completionNotificationStatus: string | null;
}

export class TaskError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 400) { super(message); }
}

type TaskArgs = Record<string, any>;
const ACTION_FIELDS: Record<typeof TASK_ACTIONS[number], string[]> = {
  create: ['title', 'description', 'parentTaskId'],
  list: ['status'],
  get: ['taskId'],
  claim: ['taskId'],
  assign: ['taskId', 'ownerSessionId'],
  update: ['taskId', 'description', 'note', 'status'],
  complete: ['taskId', 'result'],
  cancel: ['taskId', 'reason'],
};
const TEXT_LIMITS: Record<string, number> = {
  title: 200, description: 4000, parentTaskId: 128, taskId: 128,
  note: 1000, result: 4000, reason: 1000,
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
  if (args.action === 'assign' && (!Object.prototype.hasOwnProperty.call(args, 'ownerSessionId')
    || (args.ownerSessionId !== null && (typeof args.ownerSessionId !== 'string' || !args.ownerSessionId.trim() || args.ownerSessionId.length > 256)))) {
    throw new TaskError('TASK_INVALID_ARGS', 'task assign requires an existing ownerSessionId or null.');
  }
  if (args.action === 'update' && !['description', 'note', 'status'].some(key => Object.prototype.hasOwnProperty.call(args, key))) {
    throw new TaskError('TASK_INVALID_ARGS', 'task update requires description, note, or status.');
  }
  if (Object.prototype.hasOwnProperty.call(args, 'note') && !args.note.trim()) throw new TaskError('TASK_INVALID_ARGS', 'note must be non-empty.');
}

/** Small independent SQLite store; tasks never write Session state or history. */
export class TaskStore {
  private db?: DatabaseSync;
  constructor(readonly filePath: string) {}

  private getDb(): DatabaseSync {
    if (this.db) return this.db;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const db = new DatabaseSync(this.filePath);
    try {
      db.exec(`PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT,
          status TEXT NOT NULL CHECK(status IN ('open','active','completed','cancelled')),
          parentTaskId TEXT REFERENCES tasks(id), createdBySessionId TEXT NOT NULL,
          ownerSessionId TEXT, result TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
          completedAt INTEGER, cancelledAt INTEGER
        );
        CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status, updatedAt);
        CREATE INDEX IF NOT EXISTS tasks_parent ON tasks(parentTaskId, createdAt);
        CREATE TABLE IF NOT EXISTS task_notes (
          id INTEGER PRIMARY KEY, taskId TEXT NOT NULL REFERENCES tasks(id),
          sessionId TEXT NOT NULL, text TEXT NOT NULL, createdAt INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS task_notes_task ON task_notes(taskId, id);
      `);
      const columns = db.prepare('PRAGMA table_info(tasks)').all() as any[];
      if (!columns.some(column => column.name === 'completionNotificationStatus')) {
        db.exec('ALTER TABLE tasks ADD COLUMN completionNotificationStatus TEXT');
      }
      this.db = db;
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  close(): void {
    this.db?.close();
    this.db = undefined;
  }

  markCompletionNotification(taskId: string, status: 'sent' | 'failed'): void {
    this.getDb().prepare("UPDATE tasks SET completionNotificationStatus=? WHERE id=? AND completionNotificationStatus='pending'")
      .run(status, taskId);
  }

  execute(args: TaskArgs, sessionId?: string, listLimit = TASK_LIST_LIMIT): any {
    validateTaskArgs(args);
    if (args.action !== 'list' && args.action !== 'get' && (typeof sessionId !== 'string' || !sessionId.trim())) throw new TaskError('TASK_INVALID_ARGS', 'task requires a current Session.');
    const db = this.getDb();
    // A write transaction covers the read, authority check and update, even
    // across independent SQLite connections/processes racing to claim.
    db.exec(args.action === 'list' || args.action === 'get' ? 'BEGIN' : 'BEGIN IMMEDIATE');
    try {
      const result = this.executeInTransaction(db, args, sessionId, listLimit);
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  private executeInTransaction(db: DatabaseSync, args: TaskArgs, sessionId: string, listLimit: number): any {
    if (args.action === 'list') {
      const where = args.status === undefined ? "status IN ('open','active')" : 'status=?';
      const params = args.status === undefined ? [] : [args.status];
      const tasks = db.prepare(`SELECT id,title,status,parentTaskId,createdBySessionId,ownerSessionId,updatedAt
        FROM tasks WHERE ${where} ORDER BY updatedAt DESC,id LIMIT ?`).all(...params, Math.max(1, Math.min(TASK_LIST_LIMIT, listLimit)));
      const total = Number(db.prepare(`SELECT COUNT(*) AS count FROM tasks WHERE ${where}`).get(...params).count);
      return { tasks, total, omitted: total - tasks.length };
    }
    const now = Date.now();
    if (args.action === 'create') {
      if (args.parentTaskId && !db.prepare('SELECT id FROM tasks WHERE id=?').get(args.parentTaskId)) {
        throw new TaskError('TASK_NOT_FOUND', `Parent task ${args.parentTaskId} not found.`, 404);
      }
      // Parent is immutable and can only reference an existing task. A fresh
      // generated ID therefore cannot form a cycle, including self-parenting.
      const id = `task_${randomUUID()}`;
      db.prepare(`INSERT INTO tasks (id,title,description,status,parentTaskId,createdBySessionId,createdAt,updatedAt)
        VALUES (?,?,?,'open',?,?,?,?)`).run(id, args.title, args.description ?? null, args.parentTaskId ?? null, sessionId, now, now);
      return { task: this.requireTask(db, id) };
    }
    const task = this.requireTask(db, args.taskId);
    if (args.action === 'get') {
      const children = db.prepare(`SELECT id,title,status,ownerSessionId FROM tasks WHERE parentTaskId=?
        ORDER BY createdAt,id LIMIT ?`).all(task.id, TASK_CHILD_LIMIT);
      const childCount = Number(db.prepare('SELECT COUNT(*) AS count FROM tasks WHERE parentTaskId=?').get(task.id).count);
      const notes = db.prepare(`SELECT sessionId,text,createdAt FROM task_notes WHERE taskId=?
        ORDER BY id DESC LIMIT ?`).all(task.id, TASK_NOTE_LIMIT).reverse();
      const noteCount = Number(db.prepare('SELECT COUNT(*) AS count FROM task_notes WHERE taskId=?').get(task.id).count);
      return { task, children, childrenOmitted: childCount - children.length, notes, notesOmitted: noteCount - notes.length };
    }
    const state = `status=${task.status}, owner=${task.ownerSessionId ?? 'unclaimed'}`;
    if (task.status === 'completed' || task.status === 'cancelled') {
      throw new TaskError('TASK_TERMINAL', `Task ${task.id} is terminal (${state}); ${args.action} is not allowed.`, 409);
    }
    if (args.action === 'claim') {
      if (task.ownerSessionId && task.ownerSessionId !== sessionId) {
        throw new TaskError('TASK_OWNED', `Task ${task.id} is already claimed by another Session (${state}).`, 409);
      }
      if (!task.ownerSessionId) db.prepare("UPDATE tasks SET ownerSessionId=?,status='active',updatedAt=? WHERE id=?").run(sessionId, now, task.id);
    } else {
      const permitted = args.action === 'cancel' || args.action === 'assign'
        ? sessionId === task.createdBySessionId || sessionId === task.ownerSessionId
        : sessionId === (task.ownerSessionId ?? task.createdBySessionId);
      if (!permitted) throw new TaskError('TASK_FORBIDDEN', `Session ${sessionId} cannot ${args.action} task ${task.id} (${state}); ${args.action === 'cancel' || args.action === 'assign' ? 'creator or owner' : task.ownerSessionId ? 'owner' : 'creator'} required.`, 403);
      if (args.action === 'assign') {
        db.prepare("UPDATE tasks SET ownerSessionId=?,status=?,updatedAt=? WHERE id=?")
          .run(args.ownerSessionId, args.ownerSessionId === null ? 'open' : 'active', now, task.id);
        this.addNote(db, task.id, sessionId, `Owner changed from ${task.ownerSessionId ?? 'unclaimed'} to ${args.ownerSessionId ?? 'unclaimed'}.`, now);
      } else if (args.action === 'update') {
        db.prepare('UPDATE tasks SET description=?,status=?,updatedAt=? WHERE id=?')
          .run(args.description ?? task.description, args.status ?? task.status, now, task.id);
        if (args.note !== undefined) this.addNote(db, task.id, sessionId, args.note, now);
      } else if (args.action === 'complete') {
        db.prepare("UPDATE tasks SET status='completed',result=?,completedAt=?,updatedAt=?,completionNotificationStatus='pending' WHERE id=?")
          .run(args.result ?? null, now, now, task.id);
      } else if (args.action === 'cancel') {
        db.prepare("UPDATE tasks SET status='cancelled',cancelledAt=?,updatedAt=? WHERE id=?").run(now, now, task.id);
        if (args.reason !== undefined) this.addNote(db, task.id, sessionId, args.reason, now);
      }
    }
    return { task: this.requireTask(db, task.id) };
  }

  private requireTask(db: DatabaseSync, taskId: string): TaskRecord {
    const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId) as unknown as TaskRecord;
    if (!task) throw new TaskError('TASK_NOT_FOUND', `Task ${taskId} not found.`, 404);
    return task;
  }

  private addNote(db: DatabaseSync, taskId: string, sessionId: string, text: string, now: number): void {
    db.prepare('INSERT INTO task_notes (taskId,sessionId,text,createdAt) VALUES (?,?,?,?)').run(taskId, sessionId, text, now);
  }
}
