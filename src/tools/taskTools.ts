import path from 'node:path';
import { STATE_DIR } from '../config';
import { TaskService } from '../taskService';
import * as sessionManager from '../sessionManager';
import { readSessionHistorySnapshot } from '../session/metadataStore';
import { TaskStore } from '../taskStore';
import type { ToolArgs, ToolContext } from './helpers';

export const taskService = new TaskService(new TaskStore(path.join(STATE_DIR, 'tasks.sqlite')), {
  resolveSessionId: id => sessionManager.getSessionCatalog(id)?.id,
  readSessionMessageSeq: async id => {
    const state = await readSessionHistorySnapshot(id);
    return typeof state?.nextMessageSeq === 'number' ? Math.max(0, state.nextMessageSeq - 1) : undefined;
  },
  sendToSession: (target, message, source) => sessionManager.sendToSession(target, message, source),
});

/** Runs only at the Main-owned management boundary. */
export async function tool_task(args: ToolArgs, ctx: ToolContext): Promise<{ output: string; __toolPostAction?: { successfulSendToSessionTarget: string } }> {
  const result = await taskService.execute(args, ctx?.sessionId, typeof ctx?.session?.nextMessageSeq === 'number' ? Math.max(0, ctx.session.nextMessageSeq - 1) : undefined);
  return { output: JSON.stringify(result),
    ...(args.action === 'complete' && result.task.completionNotificationStatus === 'sent'
      ? { __toolPostAction: { successfulSendToSessionTarget: result.task.createdBySessionId } } : {}),
  };
}
