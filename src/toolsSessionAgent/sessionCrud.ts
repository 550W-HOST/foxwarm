import * as sessionManager from '../sessionManager';
import { COMPACT_PERCENT } from '../config';
import { requireNotIsolated } from '../isolatedCheck';
import { ToolArgs, ToolContext } from './helpers';

export async function tool_list_sessions(args: ToolArgs = {}, ctx?: ToolContext) {
  await requireNotIsolated(ctx, 'list_sessions');
  const sessions = sessionManager.listSessions();

  if (sessions.length === 0) {
    return 'No sessions found.';
  }

  const total = sessions.length;
  const rawStart = typeof args.start === 'number' && !Number.isNaN(args.start) ? Math.trunc(args.start) : 0;
  const rawCount = typeof args.count === 'number' && !Number.isNaN(args.count) ? Math.trunc(args.count) : 20;
  const start = Math.max(0, Math.min(rawStart, total));
  const count = Math.max(0, rawCount);
  const pageSessions = sessions.slice(start, start + count);

  if (pageSessions.length === 0) {
    return `No sessions found in the requested range. Total sessions: ${total}.`;
  }

  const end = start + pageSessions.length;
  let result = `Found ${total} session(s). Showing ${start + 1}-${end}.`;
  if (end < total) {
    result += ` Use \`start: ${end}\` to see the next page.`;
  }
  result += '\n\n';

  for (const s of pageSessions) {
    const date = s.lastMessageTime ? new Date(s.lastMessageTime).toISOString() : 'never';
    const channel = s.hasChannel ? '📱' : '🤖';
    const displayName = s.displayName ? ` (${s.displayName})` : '';
    const node = s.currentNode || 'master';
    const isolated = s.isolated ? ' isolated' : '';
    const busy = s.busy ? ' 🔄busy' : '';
    const queued = s.queueLength ? ` queue:${s.queueLength}` : '';
    result += `${channel} \`${s.id}\`${displayName} - ${s.messageCount} messages - node: \`${node}\`${isolated}${busy}${queued} - Last: ${date}\n`;
  }

  return result;
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

export async function tool_update_session_name(args: ToolArgs, ctx: ToolContext) {
  const { sessionId, name } = args;
  const targetId = sessionId || ctx?.sessionId;

  if (!targetId) {
    throw new Error('Session ID is required.');
  }

  const session = await sessionManager.getExistingSession(targetId);
  if (!session) {
    throw new Error(`Session \`${targetId}\` not found.`);
  }

  if (name && name.trim()) {
    session.displayName = name.trim();
  } else {
    session.displayName = undefined;
  }

  await sessionManager.saveSession(session.id);

  if (session.displayName) {
    return `Session \`${session.id}\` renamed to "${session.displayName}".`;
  }
  return `Session \`${session.id}\` display name cleared.`;
}

export async function tool_stop_session(args: ToolArgs) {
  const { sessionId } = args;

  const session = await sessionManager.getSession(sessionId);
  if (!session) {
    throw new Error(`Session \`${sessionId}\` not found.`);
  }

  if (!session.busy) {
    return `Session \`${sessionId}\` is not currently running.`;
  }

  const { abortedInFlight } = await sessionManager.requestSessionStop(sessionId);

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

  if (!targetSessionId) {
    throw new Error('sessionId is required when there is no current session context.');
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
    stopAfterCurrentTurn: false,
    requestedBy: compactGuidance ? 'manual' : 'tool',
  });

  if (result.alreadyQueued) {
    return `Compaction is already queued for session \`${targetSessionId}\`.`;
  }

  const mode = compactGuidance ? 'guided compaction plan' : 'automatic compaction plan';
  if (result.startedImmediately) {
    return `Compaction requested for session \`${targetSessionId}\`. It is entering the compact planning flow now using ${mode}.`;
  }

  return `Compaction requested for session \`${targetSessionId}\` using ${mode}. Pending queue length: ${result.queueLength}`;
}
