import {
  ToolArgs,
  ToolContext,
  formatTimerTimestamp,
  formatTimerSummary,
} from './helpers';
import * as sessionManager from '../sessionManager';
import * as timers from '../timers';
import { checkTimerPermission } from '../isolatedCheck';

export async function tool_create_timer(args: ToolArgs, ctx: ToolContext) {
  await checkTimerPermission(ctx, {
    targetSessionId: args.sessionId,
    newSession: args.newSession,
    agentName: args.agentName,
    sessionPrefix: args.sessionPrefix,
  });

  const targetSessionId = args.sessionId || ctx.sessionId;
  if (!targetSessionId) {
    throw new Error('sessionId is required when there is no current session context.');
  }

  const targetSession = await sessionManager.getExistingSession(targetSessionId);
  if (!targetSession) {
    throw new Error(`Session \`${targetSessionId}\` not found.`);
  }

  const timer = await timers.createTimer({
    sessionId: targetSessionId,
    at: args.at,
    afterSeconds: args.afterSeconds,
    cron: args.cron,
    message: args.message,
    newSession: args.newSession,
    sessionPrefix: args.sessionPrefix,
    agentName: args.agentName,
    currentNode: targetSession.currentNode,
    model: targetSession.model,
  });

  return formatTimerSummary(timer);
}

export async function tool_list_timers(args: ToolArgs, ctx: ToolContext) {
  await checkTimerPermission(ctx, { targetSessionId: args.sessionId });

  const targetSessionId = args.sessionId || ctx.sessionId;
  const timerList = timers.listTimers(targetSessionId);

  if (timerList.length === 0) {
    return targetSessionId
      ? `No timers found for session \`${targetSessionId}\`.`
      : 'No timers found.';
  }

  let result = `Found ${timerList.length} timer(s):\n\n`;
  for (const timer of timerList) {
    const mode = timer.mode === 'cron'
      ? `cron: ${timer.cron}`
      : `at: ${formatTimerTimestamp(timer.at)}`;
    const target = timer.newSession
      ? `new session (${timer.agentName || 'main'} / ${timer.sessionPrefix || 'timer'})`
      : `session ${timer.sessionId}`;
    result += `- \`${timer.id}\` - ${mode} - next: ${formatTimerTimestamp(timer.nextRunAt)} - ${target}\n`;
    result += `  ${timer.message}\n`;
  }

  return result.trimEnd();
}

export async function tool_delete_timer(args: ToolArgs, ctx: ToolContext) {
  await checkTimerPermission(ctx, { targetSessionId: args.sessionId });

  const { timerId } = args;
  const targetSessionId = args.sessionId || ctx.sessionId;

  if (!timerId || typeof timerId !== 'string') {
    throw new Error('timerId is required');
  }

  const deleted = await timers.deleteTimer(timerId, targetSessionId);
  if (!deleted) {
    return `Timer \`${timerId}\` not found.`;
  }

  return `Timer \`${timerId}\` deleted.`;
}
