import type { ToolContext } from './tools/helpers';

/** Source/input intent only: execution always belongs to the current Session owner. */
export type TimerScript = {
  code?: string;
  filePath?: string;
  node?: string;
  args?: Record<string, unknown>;
  mode?: 'foreground' | 'background';
  timeoutSecs?: number;
};

export type TimerScriptOutcome = {
  runId: string;
  status: 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
  waitingReason?: string;
  error?: string;
};

export function normalizeTimerScript(value: unknown): TimerScript {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('script must be a ToolScript specification.');
  const fields = new Set(['code', 'filePath', 'node', 'args', 'argsJson', 'mode', 'timeoutSecs']);
  for (const key of Object.keys(value)) if (!fields.has(key)) throw new Error(`Unsupported script field: ${key}.`);
  return require('./toolscript').normalizeToolScriptStartArgs(value);
}

/** No model batch, history row, shared abort slot, or caller-turn post-action consumer. */
export async function runTimerScriptForOwner(script: TimerScript, ctx: ToolContext): Promise<TimerScriptOutcome> {
  const result = await require('./tools').callTool('run_script', script, { ...ctx, toolScriptWaitScope: {} });
  return {
    runId: result.runId,
    status: result.status,
    ...(result.waitingReason ? { waitingReason: result.waitingReason } : {}),
    ...(result.error ? { error: result.error } : {}),
  };
}
