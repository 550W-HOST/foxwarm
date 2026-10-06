import path from 'node:path';
import { STATE_DIR } from '../config';
import { TaskService } from '../taskService';
import * as sessionManager from '../sessionManager';
import { readSessionHistorySnapshot } from '../session/metadataStore';
import { TaskStore } from '../taskStore';
import type { ToolArgs, ToolContext } from './helpers';

export const taskService = new TaskService(new TaskStore(path.join(STATE_DIR, 'tasks.sqlite'), {
  resolveSessionId: id => sessionManager.getSessionCatalog(id)?.id,
  sessionAliases: id => sessionManager.getSessionCatalog(id)?.aliases || [],
}), {
  resolveSessionId: id => sessionManager.getSessionCatalog(id)?.id,
  readSessionMessageSeq: async id => {
    const state = await readSessionHistorySnapshot(id);
    return typeof state?.nextMessageSeq === 'number' ? Math.max(0, state.nextMessageSeq - 1) : undefined;
  },
  sendToSession: (target, message, source, options) => sessionManager.sendToSession(target, message, source, options),
});

/** Runs only at the Main-owned management boundary. */
export async function tool_task(args: ToolArgs, ctx: ToolContext): Promise<any> {
  const result = await taskService.execute(args, ctx?.sessionId, typeof ctx?.session?.nextMessageSeq === 'number' ? Math.max(0, ctx.session.nextMessageSeq - 1) : undefined);
  const complete = args.action === 'complete';
  const sent = complete && result.task.completionNotificationStatus === 'sent';
  const linked = complete && result.task.attachedSessionId === ctx?.sessionId;
  return { output: JSON.stringify(result),
    ...(sent || linked ? { __toolPostAction: {
      ...(sent ? { successfulSendToSessionTarget: result.task.createdBySessionId } : {}),
      ...(linked ? { completedLinkedTask: { taskId: result.task.id, attachedSessionId: result.task.attachedSessionId } } : {}),
    } } : {}),
  };
}
