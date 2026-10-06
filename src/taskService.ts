import { TaskStore, TaskError, validateTaskArgs } from './taskStore';

export { TaskError } from './taskStore';

/** Main-owned callers share storage, validation, Session lookup and delivery. */
export class TaskService {
  private lane: Promise<void> = Promise.resolve();
  constructor(readonly store: TaskStore, private readonly deps: {
    resolveSessionId: (id: string) => string | undefined;
    readSessionMessageSeq?: (id: string) => Promise<number | undefined>;
    sendToSession: (target: string, message: string, source: string) => Promise<unknown>;
  }) {}

  private async exclusive<T>(operation: () => Promise<T> | T): Promise<T> {
    const prior = this.lane;
    let release: () => void;
    this.lane = new Promise<void>(resolve => { release = resolve; });
    await prior;
    try { return await operation(); } finally { release!(); }
  }

  async execute(args: Record<string, any>, sessionId: string, anchorSeq?: number): Promise<any> {
    validateTaskArgs(args);
    let notifyAssignment = false;
    const result = await this.exclusive(async () => {
      let normalized = args;
      if (args.action === 'assign' && args.ownerSessionId !== null) {
        const ownerSessionId = this.deps.resolveSessionId(args.ownerSessionId);
        if (!ownerSessionId) throw new TaskError('TASK_SESSION_NOT_FOUND', 'Target Session was not found.', 404);
        normalized = { ...args, ownerSessionId };
      }
      if (args.action === 'assign' && args.notifySession === true) {
        const before = this.store.execute({ action: 'get', taskId: args.taskId }, sessionId).task;
        notifyAssignment = before.ownerSessionId !== normalized.ownerSessionId
          || !before.assignmentNotificationStatus || before.assignmentNotificationStatus === 'failed';
      }
      const progressAnchor = anchorSeq ?? (['claim', 'assign'].includes(args.action) || (args.action === 'update' && args.status === 'active')
        ? await this.deps.readSessionMessageSeq?.(sessionId) : undefined);
      return this.store.execute(normalized, sessionId, undefined, progressAnchor);
    });
    if (notifyAssignment) {
      const target = result.task.ownerSessionId;
      if (target === sessionId) this.store.markAssignmentNotification(result.task.id, target, 'skipped');
      else try {
        await this.deps.sendToSession(target,
          `You have been assigned a task: ${result.task.id} — ${result.task.title}\nStatus: ${result.task.status}${result.task.description ? `\n${result.task.description.slice(0, 1000)}` : ''}`, sessionId);
        this.store.markAssignmentNotification(result.task.id, target, 'sent');
      } catch {
        this.store.markAssignmentNotification(result.task.id, target, 'failed');
        result.warning = 'Task assigned, but the assignment notification could not be delivered.';
      }
      result.task = this.store.execute({ action: 'get', taskId: result.task.id }, sessionId).task;
    }
    if (args.action === 'complete') {
      // Completion is already durable. Delivery failure must not undo it;
      // retries of complete are terminal-state errors, not repeated sends.
      if (result.task.createdBySessionId === sessionId) {
        this.store.markCompletionNotification(result.task.id, 'skipped');
      } else try {
        await this.deps.sendToSession(result.task.createdBySessionId,
          `Task completed: ${result.task.id} — ${result.task.title}${result.task.result ? `\n${result.task.result}` : ''}`, sessionId);
        this.store.markCompletionNotification(result.task.id, 'sent');
      } catch {
        this.store.markCompletionNotification(result.task.id, 'failed');
        result.warning = 'Task completed, but the completion notification could not be delivered.';
      }
      result.task = this.store.execute({ action: 'get', taskId: result.task.id }, sessionId).task;
    }
    return result;
  }

  async executeForWebUi(args: Record<string, any>, requestedSessionId?: string): Promise<any> {
    // The ordinary authenticated WebUI has management access to all Sessions.
    // This is an explicit operation target, not an identity inferred from auth.
    const target = requestedSessionId ?? (args.action === 'create' ? undefined
      : (() => { const task = this.get(args.taskId).task; return task.ownerSessionId ?? task.createdBySessionId; })());
    if (!target || typeof target !== 'string') throw new TaskError('TASK_SESSION_REQUIRED', 'Select an existing Session for this operation.');
    const sessionId = this.deps.resolveSessionId(target);
    if (!sessionId) throw new TaskError('TASK_SESSION_NOT_FOUND', 'Target Session was not found.', 404);
    return { ...await this.execute(args, sessionId), sessionId };
  }

  /** Read-only callers do not need a Session actor. */
  list(status?: string, limit?: number): any {
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 50)) {
      throw new TaskError('TASK_INVALID_ARGS', 'limit must be an integer from 1 to 50.');
    }
    return this.store.execute({ action: 'list', ...(status === undefined ? {} : { status }) }, undefined, limit);
  }

  get(taskId: string): any {
    return this.store.execute({ action: 'get', taskId }, undefined);
  }

  async createAttachedChild(taskId: string, sourceSessionId: string, create: () => Promise<string>): Promise<string> {
    return this.exclusive(async () => {
      const task = this.store.execute({ action: 'get', taskId }, sourceSessionId).task;
      if (task.status === 'completed' || task.status === 'cancelled') throw new TaskError('TASK_TERMINAL', 'A terminal task cannot be attached to a new Session.', 409);
      if (task.ownerSessionId) throw new TaskError('TASK_OWNED', `Task ${task.id} is already owned by Session ${task.ownerSessionId}.`, 409);
      const childSessionId = await create();
      this.store.execute({ action: 'claim', taskId }, childSessionId);
      this.store.execute({ action: 'update', taskId, note: `Attached new Session ${childSessionId}.` }, childSessionId);
      return childSessionId;
    });
  }
}
