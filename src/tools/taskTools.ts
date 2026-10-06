import path from 'node:path';
import { STATE_DIR } from '../config';
import { TaskService } from '../taskService';
import * as sessionManager from '../sessionManager';
import { TaskStore } from '../taskStore';
import type { ToolArgs, ToolContext } from './helpers';

export const taskService = new TaskService(new TaskStore(path.join(STATE_DIR, 'tasks.sqlite')), {
  resolveSessionId: id => sessionManager.getSessionCatalog(id)?.id,
  sendToSession: (target, message, source) => sessionManager.sendToSession(target, message, source),
});

/** Runs only at the Main-owned management boundary. */
export async function tool_task(args: ToolArgs, ctx: ToolContext): Promise<{ output: string }> {
  const result = await taskService.execute(args, ctx?.sessionId);
  return { output: JSON.stringify(result) };
}
