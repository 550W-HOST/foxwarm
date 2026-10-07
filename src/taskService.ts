import type { SessionDeliveryOptions } from './types';
import { TaskStore, TaskError, validateTaskArgs } from './taskStore';

export { TaskError } from './taskStore';

/** Main-owned callers share storage, validation, Session lookup and delivery. */
export class TaskService {
  private lane: Promise<void> = Promise.resolve();
  constructor(readonly store: TaskStore, private readonly deps: {
    resolveSessionId: (id: string) => string | undefined;
    resolveSessionAgent?: (id: string) => string | undefined;
    readSessionMessageSeq?: (id: string) => Promise<number | undefined>;
    sendToSession: (target: string, message: string, source?: string, options?: SessionDeliveryOptions) => Promise<unknown>;
  }) {}

  private async exclusive<T>(operation: () => Promise<T> | T): Promise<T> {
    const prior = this.lane;
    let release: () => void;
    this.lane = new Promise<void>(resolve => { release = resolve; });
    await prior;
    try { return await operation(); } finally { release!(); }
  }

  private async deliverAssignmentPlan(result: any, sessionId: string | undefined, plan: { revision: number; newOwner?: string; previousOwner?: string; sourceKind?: 'session' | 'user' }, additionalMessage?: string): Promise<{ result: any; newOwnerDelivered: boolean }> {
    const failedRecipients: string[] = [];
    let newOwnerDelivered = !plan.newOwner;
    for (const [recipient, plannedTarget] of [['previous', plan.previousOwner], ['new', plan.newOwner]] as const) {
      if (!plannedTarget) continue;
      const target = this.deps.resolveSessionId(plannedTarget) || plannedTarget;
      if (sessionId) sessionId = this.deps.resolveSessionId(sessionId) || sessionId;
      if (target === sessionId) {
        this.store.markAssignmentNotification(result.task.id, plan.revision, recipient, 'skipped');
        if (recipient === 'new') newOwnerDelivered = true;
      }
      else try {
        const description = recipient === 'new'
          ? this.store.readStoredDescription(result.task.id)
          : result.task.description;
        const summary = `${result.task.id} — ${result.task.title}\nStatus: ${result.task.status}${description ? `\n${description}` : ''}`;
        const message = recipient === 'previous'
          ? `Task ownership ${result.task.ownerSessionId ? `transferred to ${result.task.ownerSessionId}` : 'released'}: ${summary.slice(0, 1000)}`
          : `You have been assigned a task: ${summary}${additionalMessage ? `\n\nAdditional instruction:\n${additionalMessage}` : ''}`;
        const event = recipient === 'previous'
          ? result.task.ownerSessionId ? 'transferred' : 'released'
          : result.task.previousOwnerSessionId ? 'transferred' : 'assigned';
        await this.deps.sendToSession(target, message, plan.sourceKind === 'user' ? undefined : sessionId, {
          ...(recipient === 'previous' ? { trigger: false } : {}),
          taskNotification: { taskId: result.task.id, event, recipient, ...(plan.sourceKind ? { sourceKind: plan.sourceKind } : {}) },
        });
        this.store.markAssignmentNotification(result.task.id, plan.revision, recipient, 'sent');
        if (recipient === 'new') newOwnerDelivered = true;
      } catch {
        this.store.markAssignmentNotification(result.task.id, plan.revision, recipient, 'failed');
        failedRecipients.push(recipient === 'previous' ? 'previous owner' : 'new owner');
      }
    }
    if (failedRecipients.length) result.warning = `Task assigned, but the ${failedRecipients.join(' and ')} notification could not be delivered.`;
    result.task = this.store.execute({ action: 'get', taskId: result.task.id }, sessionId).task;
    return { result, newOwnerDelivered };
  }

  async execute(args: Record<string, any>, sessionId: string, anchorSeq?: number): Promise<any> {
    validateTaskArgs(args);
    sessionId = this.deps.resolveSessionId(sessionId) || sessionId;
    let result = await this.exclusive(async () => {
      let normalized = args;
      if (args.ownerSessionId !== undefined && args.ownerSessionId !== null) {
        const ownerSessionId = this.deps.resolveSessionId(args.ownerSessionId);
        if (!ownerSessionId) throw new TaskError('TASK_SESSION_NOT_FOUND', 'Target Session was not found.', 404);
        normalized = { ...args, ownerSessionId };
      }
      const progressAnchor = anchorSeq ?? (['claim', 'assign'].includes(args.action) || (args.action === 'create' && args.ownerSessionId != null) || (args.action === 'update' && args.status === 'active')
        ? await this.deps.readSessionMessageSeq?.(sessionId) : undefined);
      sessionId = this.deps.resolveSessionId(sessionId) || sessionId;
      return this.store.execute(normalized, sessionId, undefined, progressAnchor);
    });
    const plan = result.assignmentNotification;
    delete result.assignmentNotification;
    if (plan) result = (await this.deliverAssignmentPlan(result, sessionId, plan)).result;
    if (args.action === 'complete') {
      // Completion is already durable. Delivery failure must not undo it;
      // retries of complete are terminal-state errors, not repeated sends.
      sessionId = this.deps.resolveSessionId(sessionId) || sessionId;
      const creator = result.task.createdByKind === 'session' && result.task.createdBySessionId
        ? this.deps.resolveSessionId(result.task.createdBySessionId) || result.task.createdBySessionId
        : undefined;
      if (!creator || creator === sessionId) {
        this.store.markCompletionNotification(result.task.id, 'skipped');
      } else try {
        await this.deps.sendToSession(creator,
          `Task completed: ${result.task.id} — ${result.task.title}${result.task.result ? `\n${result.task.result}` : ''}`, sessionId, { taskNotification: { taskId: result.task.id, event: 'completed' } });
        this.store.markCompletionNotification(result.task.id, 'sent');
      } catch {
        this.store.markCompletionNotification(result.task.id, 'failed');
        result.warning = 'Task completed, but the completion notification could not be delivered.';
      }
      result.task = this.store.execute({ action: 'get', taskId: result.task.id }, sessionId).task;
    }
    return result;
  }

  async executeAsUser(args: Record<string, any>): Promise<any> {
    if (args.action !== 'comment') validateTaskArgs(args);
    const normalized = { ...args };
    if (normalized.ownerSessionId !== undefined && normalized.ownerSessionId !== null) {
      const ownerSessionId = this.deps.resolveSessionId(normalized.ownerSessionId);
      if (!ownerSessionId) throw new TaskError('TASK_SESSION_NOT_FOUND', 'Target Session was not found.', 404);
      normalized.ownerSessionId = ownerSessionId;
    }
    let result = await this.exclusive(() => this.store.executeAsUser(normalized));
    const assignmentPlan = result.assignmentNotification;
    delete result.assignmentNotification;
    if (assignmentPlan) result = (await this.deliverAssignmentPlan(result, undefined, { ...assignmentPlan, sourceKind: 'user' })).result;
    const commentPlan = result.commentNotification;
    delete result.commentNotification;
    if (commentPlan) {
      try {
        await this.deps.sendToSession(commentPlan.owner,
          `Comment on task ${result.task.id} — ${result.task.title}\n${normalized.note}`,
          undefined,
          { taskNotification: { taskId: result.task.id, event: 'commented', sourceKind: 'user' } });
      } catch {
        result.warning = 'Comment saved, but the owner notification could not be delivered.';
      }
      result.task = this.store.execute({ action: 'get', taskId: result.task.id }, undefined).task;
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
  list(status?: string, limit?: number, includeSessionAgents = false): any {
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 50)) {
      throw new TaskError('TASK_INVALID_ARGS', 'limit must be an integer from 1 to 50.');
    }
    const result = this.store.execute({ action: 'list', ...(status === undefined ? {} : { status }) }, undefined, limit);
    if (!includeSessionAgents || !this.deps.resolveSessionAgent) return result;
    return {
      ...result,
      tasks: result.tasks.map((task: any) => ({
        ...task,
        createdByAgent: task.createdBySessionId ? this.deps.resolveSessionAgent!(task.createdBySessionId) || null : null,
        ownerAgent: task.ownerSessionId ? this.deps.resolveSessionAgent!(task.ownerSessionId) || null : null,
      })),
    };
  }

  get(taskId: string): any {
    return this.store.execute({ action: 'get', taskId }, undefined);
  }

  async createAttachedChild(taskId: string, sourceSessionId: string, create: () => Promise<string>, additionalMessage?: string): Promise<{ childSessionId: string; assignmentDelivered: boolean; warning?: string }> {
    const source = this.deps.resolveSessionId(sourceSessionId) || sourceSessionId;
    const attached = await this.exclusive(async () => {
      const task = this.store.execute({ action: 'get', taskId }, source).task;
      if (task.status === 'completed' || task.status === 'cancelled') throw new TaskError('TASK_TERMINAL', 'A terminal task cannot be attached to a new Session.', 409);
      if (task.createdBySessionId !== source && task.ownerSessionId !== source) {
        throw new TaskError('TASK_FORBIDDEN', `Session ${source} cannot assign task ${task.id} (creator or owner required).`, 403);
      }
      const childSessionId = await create();
      const result = this.store.execute({ action: 'assign', taskId, ownerSessionId: childSessionId, notifySession: true }, source);
      const plan = result.assignmentNotification;
      delete result.assignmentNotification;
      this.store.attachChild(taskId, childSessionId);
      return { childSessionId, result: { ...result, assignmentNotification: plan } };
    });
    let { childSessionId, result } = attached;
    let assignmentDelivered = true;
    if (result.assignmentNotification) {
      const plan = result.assignmentNotification;
      delete result.assignmentNotification;
      const delivered = await this.deliverAssignmentPlan(result, source, plan, additionalMessage);
      assignmentDelivered = delivered.newOwnerDelivered;
      result = delivered.result;
    }
    return { childSessionId, assignmentDelivered, ...(result.warning ? { warning: result.warning } : {}) };
  }
}
