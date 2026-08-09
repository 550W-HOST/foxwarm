import * as sessionManager from '../sessionManager';
import * as sessionRuntime from '../sessionRuntime';
import { COMPACT_PERCENT } from '../config';
import { requireNotIsolated } from '../isolatedCheck';
import { executeMainManagementTool } from '../mainManagementTools';
import { ToolArgs, ToolContext } from './helpers';
import { buildSessionListOutput, buildSessionStatusInfo, formatSessionStatus } from '../sessionStatus';

export async function tool_session(args: ToolArgs = {}, ctx?: ToolContext) {
  const action = typeof args.action === 'string' && args.action.trim()
    ? args.action.trim().toLowerCase()
    : 'status';

  if (action === 'list') {
    // The session catalog is Main-owned; a worker reads it through the
    // fixed main-management facade instead of its own empty module state.
    if (ctx?.sessionPlacement === 'session-worker') return executeMainManagementTool('session_list', args, ctx);
    await requireNotIsolated(ctx, 'session list');
    return buildSessionListOutput(args, ctx?.sessionId);
  }

  if (action === 'update-display-name') {
    if (ctx?.sessionPlacement === 'session-worker') return executeMainManagementTool('session_update_display_name', args, ctx);
    return updateSessionDisplayName(args, ctx);
  }

  if (action !== 'status') {
    throw new Error('session.action must be "status", "list", or "update-display-name".');
  }

  const targetSessionId = ctx?.sessionId;
  if (!targetSessionId) {
    throw new Error('Cannot show session status without current session context.');
  }

  return formatSessionStatus(await buildSessionStatusInfo(targetSessionId, ctx?.session, ctx?.sessionPlacement === 'session-worker'));
}

export async function tool_delete_session(args: ToolArgs, ctx: ToolContext) {
  await requireNotIsolated(ctx, 'delete_session');
  const { sessionId } = args;

  if (ctx && ctx.sessionId === sessionId) {
    throw new Error('Cannot delete current session. Use /clear to clear history or switch to another session first.');
  }

  const prep = await sessionManager.prepareSessionForDestructiveAction(sessionId);

  if (prep.requiresRetry) {
    const queueNote = prep.droppedQueueItems > 0
      ? ` Cleared ${prep.droppedQueueItems} queued item(s).`
      : '';
    if (prep.abortedInFlight) {
      return `Stop signal sent to busy session \`${sessionId}\`. The in-flight LLM request was aborted.${queueNote} Retry delete after the session becomes idle.`;
    }
    return `Stop signal sent to busy session \`${sessionId}\`. It will stop after the current tool call completes.${queueNote} Retry delete after the session becomes idle.`;
  }

  const deleted = await sessionManager.deleteSession(sessionId);

  if (deleted) {
    return `Session \`${sessionId}\` deleted successfully.`;
  }

  return `Session \`${sessionId}\` not found.`;
}

function formatDisplayName(name: string | undefined): string {
  return typeof name === 'string' ? JSON.stringify(name) : 'unset';
}

async function updateSessionDisplayName(args: ToolArgs, ctx?: ToolContext) {
  const { sessionId, name } = args;
  const targetId = sessionId || ctx?.sessionId;

  if (!targetId) {
    throw new Error('Session ID is required.');
  }
  if (typeof name !== 'string') {
    throw new Error('session.name is required for action="update-display-name".');
  }

  const session = await sessionRuntime.getSession(targetId);
  if (!session) {
    throw new Error(`Session \`${targetId}\` not found.`);
  }

  const previousName = session.displayName || undefined;
  const nextName = name.trim() || undefined;

  if (previousName === nextName) {
    return `Session \`${session.id}\` display name unchanged (from ${formatDisplayName(previousName)} to ${formatDisplayName(nextName)}).`;
  }

  await sessionRuntime.updateSettings(session.id, { displayName: nextName || null });

  return `Session \`${session.id}\` display name changed from ${formatDisplayName(previousName)} to ${formatDisplayName(nextName)}.`;
}

export async function tool_stop_session(args: ToolArgs, ctx?: ToolContext) {
  const { sessionId } = args;

  if (ctx?.sessionPlacement === 'session-worker' && ctx.session && (ctx.session.id === sessionId || ctx.session.aliases?.includes(sessionId)) && ctx.persistCurrentSession) {
    ctx.session.stopping = true;
    await ctx.persistCurrentSession();
    return `Stop signal set for session \`${sessionId}\`. It will stop after the current tool call completes.`;
  }

  const session = await sessionRuntime.getSession(sessionId);
  if (!session) {
    throw new Error(`Session \`${sessionId}\` not found.`);
  }

  if (!session.busy) {
    return `Session \`${sessionId}\` is not currently running.`;
  }

  const { abortedInFlight } = await sessionRuntime.control(sessionId, 'stop');

  if (abortedInFlight) {
    return `Stop signal sent to session \`${sessionId}\`. The in-flight LLM request was aborted.`;
  }

  return `Stop signal sent to session \`${sessionId}\`. It will stop after the current tool call completes.`;
}

function normalizeKeepPercent(value: unknown, defaultPercent = COMPACT_PERCENT): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return defaultPercent;
  }

  if (value > 1 && value <= 100) {
    return value / 100;
  }

  if (value > 0 && value <= 1) {
    return value;
  }

  return defaultPercent;
}

export async function tool_compact_session(args: ToolArgs, ctx: ToolContext) {
  const targetSessionId = args.sessionId || ctx.sessionId;
  const compactGuidance = typeof args.summary === 'string' && args.summary.trim()
    ? args.summary.trim()
    : undefined;
  const keepPercent = normalizeKeepPercent(args.keepPercent);

  if (ctx.sessionPlacement === 'session-worker') {
    if (!ctx.session || targetSessionId !== ctx.sessionId || ctx.session.id !== ctx.sessionId) {
      throw new Error('Session-worker compact_session may target only the exact current session.');
    }
    return `Compaction was not started for session \`${ctx.sessionId}\`: synchronous Session-worker placement cannot start background compaction from a busy model tool call. Request /compact when the session is idle.`;
  }

  if (!targetSessionId) {
    throw new Error('sessionId is required when there is no current session context.');
  }

  if (sessionManager.isSessionWorkerFenced(targetSessionId)) {
    throw new Error('Cross-session compaction is unavailable while the target Session worker is active. Request compaction from the target session when it is idle.');
  }

  const targetSession = await sessionManager.getExistingSession(targetSessionId);
  if (!targetSession) {
    throw new Error(`Session \`${targetSessionId}\` not found.`);
  }

  const isSelf = targetSessionId === ctx.sessionId;
  if (!isSelf && (targetSession.busy || targetSession.queue.length > 0)) {
    throw new Error(`Session \`${targetSessionId}\` must be idle with an empty queue before another session can request compaction.`);
  }

  const result = await sessionManager.requestSessionCompaction(targetSessionId, {
    compactGuidance,
    keepPercent,
    completionMarker: isSelf
      ? 'Compaction completed. You can continue working now.'
      : 'Compaction completed.',
  });

  if (result.alreadyQueued) {
    return `Compaction is already pending for session \`${targetSessionId}\`.`;
  }

  const mode = compactGuidance ? 'guided compaction plan' : 'automatic compaction plan';
  if (result.startedImmediately) {
    return result.runsInBackground
      ? `Compaction requested for session \`${targetSessionId}\`. It is entering the background compact planning flow now using ${mode}.`
      : `Compaction started for session \`${targetSessionId}\` using ${mode}. The session remains busy until awaited compaction finishes.`;
  }

  return `Compaction was not started for session \`${targetSessionId}\`: its model disables background compaction, so the session must be idle before compaction can run.`;
}
