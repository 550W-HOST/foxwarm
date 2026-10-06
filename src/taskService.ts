import type { SessionEnqueueOptions } from './types';
import { TaskStore, TaskError, validateTaskArgs } from './taskStore';

export { TaskError } from './taskStore';

/** Main-owned callers share storage, validation, Session lookup and delivery. */
export class TaskService {
  private lane: Promise<void> = Promise.resolve();
  constructor(readonly store: TaskStore, private readonly deps: {
    resolveSessionId: (id: string) => string | undefined;
    readSessionMessageSeq?: (id: string) => Promise<number | undefined>;
    sendToSession: (target: string, message: string, source: string, options?: SessionEnqueueOptions) => Promise<unknown>;
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
    sessionId = this.deps.resolveSessionId(sessionId) || sessionId;
    const result = await this.exclusive(async () => {
      let normalized = args;
      if (args.action === 'assign' && args.ownerSessionId !== null) {
        const ownerSessionId = this.deps.resolveSessionId(args.ownerSessionId);
        if (!ownerSessionId) throw new TaskError('TASK_SESSION_NOT_FOUND', 'Target Session was not found.', 404);
        normalized = { ...args, ownerSessionId };
      }
      const progressAnchor = anchorSeq ?? (['claim', 'assign'].includes(args.action) || (args.action === 'update' && args.status === 'active')
        ? await this.deps.readSessionMessageSeq?.(sessionId) : undefined);
      sessionId = this.deps.resolveSessionId(sessionId) || sessionId;
      return this.store.execute(normalized, sessionId, undefined, progressAnchor);
    });
    const plan = result.assignmentNotification;
    delete result.assignmentNotification;
    if (plan) {
      const failedRecipients: string[] = [];
      for (const [recipient, plannedTarget] of [['previous', plan.previousOwner], ['new', plan.newOwner]] as const) {
        if (!plannedTarget) continue;
        const target = this.deps.resolveSessionId(plannedTarget) || plannedTarget;
        sessionId = this.deps.resolveSessionId(sessionId) || sessionId;
        if (target === sessionId) this.store.markAssignmentNotification(result.task.id, plan.revision, recipient, 'skipped');
        else try {
          const summary = `${result.task.id} — ${result.task.title}\nStatus: ${result.task.status}${result.task.description ? `\n${result.task.description.slice(0, 1000)}` : ''}`;
          const message = recipient === 'previous'
            ? `Task ownership ${result.task.ownerSessionId ? `transferred to ${result.task.ownerSessionId}` : 'released'}: ${summary}`
            : `You have been assigned a task: ${summary}`;
          await this.deps.sendToSession(target, message, sessionId, recipient === 'previous' ? { trigger: false } : undefined);
          this.store.markAssignmentNotification(result.task.id, plan.revision, recipient, 'sent');
        } catch {
          this.store.markAssignmentNotification(result.task.id, plan.revision, recipient, 'failed');
          failedRecipients.push(recipient === 'previous' ? 'previous owner' : 'new owner');
        }
      }
      if (failedRecipients.length) result.warning = `Task assigned, but the ${failedRecipients.join(' and ')} notification could not be delivered.`;
      result.task = this.store.execute({ action: 'get', taskId: result.task.id }, sessionId).task;
    }
    if (args.action === 'complete') {
      // Completion is already durable. Delivery failure must not undo it;
      // retries of complete are terminal-state errors, not repeated sends.
      sessionId = this.deps.resolveSessionId(sessionId) || sessionId;
      const creator = this.deps.resolveSessionId(result.task.createdBySessionId) || result.task.createdBySessionId;
      if (creator === sessionId) {
        this.store.markCompletionNotification(result.task.id, 'skipped');
      } else try {
        await this.deps.sendToSession(creator,
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
    return { ...await this.execute(args, sessionId), sessionId: this.deps.resolveSessionId(sessionId) || sessionId };
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
      this.store.bindChild(taskId, childSessionId);
      return childSessionId;
    });
  }
}
