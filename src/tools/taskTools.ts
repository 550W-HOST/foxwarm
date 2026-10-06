import path from 'node:path';
import { STATE_DIR } from '../config';
import { TaskStore } from '../taskStore';
import type { ToolArgs, ToolContext } from './helpers';

const taskStore = new TaskStore(path.join(STATE_DIR, 'tasks.sqlite'));

/** Runs only at the Main-owned management boundary. */
export async function tool_task(args: ToolArgs, ctx: ToolContext): Promise<{ output: string }> {
  const result = taskStore.execute(args, ctx?.sessionId);
  return { output: JSON.stringify(result) };
}
