import {
  ToolArgs,
  ToolContext,
  buildEndTurnResult,
  normalizeWaitTimeoutSeconds,
  normalizeWaitAllSessions,
  isNonEmptyString,
  prepareChannelFile,
  formatSendFileSessionResult,
  isWebUiUnsupportedFileDelivery,
  buildSendFileResult,
} from './helpers';
import * as sessionManager from '../sessionManager';
import * as timers from '../timers';
import { logger } from '../common';
import { requireNotIsolated, checkChannelPermission, checkSendFilePermission } from '../isolatedCheck';
import { COMPACT_PLAN_TOOL_NAME } from '../session/compactPlan';

export async function tool_create_child_session(args: ToolArgs, ctx: ToolContext) {
  await requireNotIsolated(ctx, 'create_child_session');
  const { suffix, fork = false, message, node, noFurtherAssistantReply } = args;

  if (!ctx || !ctx.sessionId) {
    throw new Error('Cannot create child session: missing context');
  }

  const currentSessionId = ctx.sessionId;
  const childSessionId = await sessionManager.createChildSession(currentSessionId, suffix, fork, { node });

  if (message) {
    sessionManager.sendToSession(childSessionId, message, currentSessionId).catch(err => {
      logger.error({ err, childSessionId }, 'Failed to send initial message to child session');
    });
    const output = `Child session created: \`${childSessionId}\` (${fork ? 'forked from parent' : 'new session'}). Initial message sent.`;
    return noFurtherAssistantReply
      ? { ...buildEndTurnResult(), output }
      : output;
  }

  const output = `Child session created: \`${childSessionId}\` (${fork ? 'forked from parent' : 'new session'})`;
  return noFurtherAssistantReply
    ? { ...buildEndTurnResult(), output }
    : output;
}

export async function tool_send_to_session(args: ToolArgs, ctx: ToolContext) {
  const { sessionId, message, noFurtherAssistantReply } = args;
  const fromSessionId = ctx?.sessionId;

  if (!sessionId || typeof sessionId !== 'string') {
    throw new Error('sessionId is required');
  }

  const result = await sessionManager.sendToSession(sessionId, message, fromSessionId);
  const output = result.resolvedSessionId !== result.requestedSessionId
    ? `Message sent to session \`${result.resolvedSessionId}\` (requested \`${result.requestedSessionId}\`)`
    : `Message sent to session \`${result.resolvedSessionId}\``;
  return noFurtherAssistantReply
    ? { ...buildEndTurnResult(), output }
    : output;
}

export async function tool_wait(args: ToolArgs, ctx?: ToolContext) {
  const { reason } = args || {};
  const timeoutSeconds = normalizeWaitTimeoutSeconds(args?.timeoutSeconds);
  const waitAllSessions = normalizeWaitAllSessions(args?.waitAllSessions);

  if (ctx?.sessionId) {
    const waitState = await sessionManager.startSessionWait(ctx.sessionId, {
      reason: typeof reason === 'string' ? reason : undefined,
      timeoutSeconds,
      waitAllSessions,
    });

    if (timeoutSeconds !== undefined) {
      await timers.createWaitTimeoutTimer({
        sessionId: ctx.sessionId,
        waitId: waitState.id,
        timeoutSeconds,
      });
    }
  } else if (timeoutSeconds !== undefined) {
    throw new Error('Cannot use wait timeout without session context.');
  }

  return buildEndTurnResult(typeof reason === 'string' ? reason : undefined);
}

export async function tool_submit_compact_plan() {
  return `${COMPACT_PLAN_TOOL_NAME} is only valid inside the dedicated compact planning flow. Request compaction with compact_session and only submit a plan when the system compact prompt explicitly asks for it.`;
}

export async function tool_send_to_channel(args: ToolArgs, ctx?: ToolContext) {
  const { channelTargetId, message } = args;
  if (!channelTargetId || typeof channelTargetId !== 'string') {
    throw new Error('channelTargetId is required (format: <channel-instance-id>:<conversation-id>)');
  }
  if (!message || typeof message !== 'string') {
    throw new Error('message is required');
  }

  if (ctx?.sessionId) {
    await checkChannelPermission(ctx.sessionId, channelTargetId);
  }

  await sessionManager.sendToChannelTargetId(channelTargetId, message);
  return `Message sent to channel target \`${channelTargetId}\``;
}

export async function tool_send_file(args: ToolArgs, ctx?: ToolContext) {
  const { sessionId, channelTargetId, filePath } = args;
  const hasSessionId = isNonEmptyString(sessionId);
  const normalizedChannelTargetId = isNonEmptyString(channelTargetId)
    ? channelTargetId.trim()
    : undefined;
  const hasChannelTargetId = Boolean(normalizedChannelTargetId);
  const normalizedSessionId = hasSessionId
    ? sessionId.trim()
    : (ctx?.sessionId ? ctx.sessionId : undefined);

  if (hasSessionId && hasChannelTargetId) {
    throw new Error('At most one of sessionId or channelTargetId may be specified');
  }
  if (!normalizedSessionId && !hasChannelTargetId) {
    throw new Error('sessionId or channelTargetId is required when there is no active session context');
  }
  if (!isNonEmptyString(filePath)) {
    throw new Error('filePath is required');
  }

  const caption = isNonEmptyString(args.caption)
    ? args.caption.trim()
    : (isNonEmptyString(args.text) ? args.text.trim() : undefined);

  if (ctx?.sessionId) {
    await checkSendFilePermission(ctx.sessionId, {
      channelTargetId: normalizedChannelTargetId,
      targetSessionId: normalizedChannelTargetId ? undefined : normalizedSessionId,
    });
  }

  const file = await prepareChannelFile(filePath.trim(), ctx);

  if (normalizedChannelTargetId) {
    if (normalizedChannelTargetId.startsWith('webui:')) {
      return buildSendFileResult(`File \`${file.name}\` is ready for WebUI target \`${normalizedChannelTargetId}\`.`, file);
    }

    await sessionManager.sendFileToChannelTargetId(normalizedChannelTargetId, file, { caption });
    return buildSendFileResult(`File \`${file.name}\` sent to channel target \`${normalizedChannelTargetId}\``, file);
  }

  const result = await sessionManager.sendFileToSession(normalizedSessionId, file, { caption });
  const hasWebUiDownloadFallback = result.skippedChannels.some((item) => isWebUiUnsupportedFileDelivery(item.channelId, item.reason));
  const output = formatSendFileSessionResult(normalizedSessionId, file, result);

  if (hasWebUiDownloadFallback && result.deliveredChannels.length === 0 && result.failedChannels.length === 0) {
    return buildSendFileResult(output, file);
  }

  if (result.deliveredChannels.length === 0) {
    throw new Error(output);
  }

  if (hasWebUiDownloadFallback) {
    return buildSendFileResult(output, file);
  }

  return buildSendFileResult(output, file);
}
