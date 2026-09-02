import {
  ToolArgs,
  ToolContext,
  buildEndTurnResult,
  normalizeWaitFallbackSeconds,
  normalizeWaitAllSessions,
  normalizeWaitAnySessions,
  normalizeWaitExecIds,
  normalizeWaitForInput,
  normalizeCreateChildSessionArgs,
  normalizeForceModel,
  normalizeAfterSendBehavior,
  isNonEmptyString,
  prepareChannelFile,
  formatSendFileSessionResult,
  isWebUiUnsupportedFileDelivery,
  buildSendFileResult,
} from './helpers';
import * as sessionManager from '../sessionManager';
import { armMainWaitLiveness, scheduleMainWaitTimeout, validateMainWaitExecIds, validateMainWaitSessions } from '../mainManagementTools';
import { logger } from '../common';
import { requireNotIsolated, checkChannelPermission, checkSendFilePermission } from '../isolatedCheck';
import { COMPACT_PLAN_TOOL_NAME } from '../session/compactPlan';

export async function tool_create_child_session(args: ToolArgs, ctx: ToolContext) {
  await requireNotIsolated(ctx, 'create_child_session');
  const normalizedArgs = normalizeCreateChildSessionArgs(args);
  const { suffix, fork = false, message, node } = normalizedArgs;
  const afterSend = normalizeAfterSendBehavior(normalizedArgs, 'create_child_session');
  const forced = normalizeForceModel(normalizedArgs, 'create_child_session');

  if (!ctx || !ctx.sessionId) {
    throw new Error('Cannot create child session: missing context');
  }
  if (afterSend === 'wait' && (typeof message !== 'string' || !message.trim())) {
    throw new Error('create_child_session with afterSend="wait" requires a non-empty initial message.');
  }

  const currentSessionId = ctx.sessionId;
  const childSessionId = await sessionManager.createChildSession(currentSessionId, suffix, fork,
    { node, model: forced.model, effort: forced.effort, sourceOverride: (ctx as any).sourceOverride });

  if (message) {
    if (afterSend === 'wait' || afterSend === 'finish') {
      await sessionManager.sendToSession(childSessionId, message, currentSessionId);
    } else {
      sessionManager.sendToSession(childSessionId, message, currentSessionId).catch(err => {
        logger.error({ err, childSessionId }, 'Failed to send initial message to child session');
      });
    }
    const output = `Child session created: \`${childSessionId}\` (${fork ? 'forked from parent' : 'new session'}). Initial message sent.`;
    if (afterSend === 'wait') {
      return { output, __toolPostAction: { waitForReply: true, successfulSendToSessionTarget: childSessionId } };
    }
    return afterSend === 'finish'
      ? { ...buildEndTurnResult(), output, __toolPostAction: { finishAfterSend: true } }
      : output;
  }

  const output = `Child session created: \`${childSessionId}\` (${fork ? 'forked from parent' : 'new session'})`;
  return afterSend === 'finish'
    ? { ...buildEndTurnResult(), output, __toolPostAction: { finishAfterSend: true } }
    : output;
}

export async function tool_send_to_session(args: ToolArgs, ctx: ToolContext) {
  const unknownKeys = Object.keys(args || {}).filter(key => !['sessionId', 'message', 'afterSend', 'noFurtherAssistantReply', 'waitAfterHandoff'].includes(key));
  if (unknownKeys.length) throw new Error(`send_to_session received unsupported argument${unknownKeys.length === 1 ? '' : 's'}: ${unknownKeys.join(', ')}.`);
  const { sessionId, message } = args;
  const afterSend = normalizeAfterSendBehavior(args, 'send_to_session');
  const fromSessionId = ctx?.sessionId;

  if (!sessionId || typeof sessionId !== 'string') {
    throw new Error('sessionId is required');
  }

  const result = await sessionManager.sendToSession(sessionId, message, fromSessionId);
  const output = result.resolvedSessionId !== result.requestedSessionId
    ? `Message sent to session \`${result.resolvedSessionId}\` (requested \`${result.requestedSessionId}\`)`
    : `Message sent to session \`${result.resolvedSessionId}\``;
  const successfulSendToSessionTarget = result.resolvedSessionId;
  const includeSuccessfulTarget = !!ctx?.persistCurrentSession
    || ctx?.sessionPlacement === 'session-worker'
    || ctx?.captureSuccessfulSendToSessionTarget === true
    || afterSend === 'wait';
  if (afterSend === 'wait') {
    return { output, __toolPostAction: {
      waitForReply: true,
      ...(includeSuccessfulTarget ? { successfulSendToSessionTarget } : {}),
    } };
  }
  if (!includeSuccessfulTarget) {
    return afterSend === 'finish'
      ? { ...buildEndTurnResult(), output, __toolPostAction: { finishAfterSend: true } }
      : output;
  }
  return afterSend === 'finish'
    ? { ...buildEndTurnResult(), output, __toolPostAction: { finishAfterSend: true, successfulSendToSessionTarget } }
    : { output, __toolPostAction: { successfulSendToSessionTarget } };
}

export async function tool_wait(args: ToolArgs, ctx?: ToolContext) {
  const allowedKeys = new Set(['reason', 'waitAllSessions', 'waitAnySessions', 'waitExecIds', 'waitForInput', 'wakeIfNoActivityAfterSeconds']);
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('wait arguments must be an object.');
  const unknownKeys = Object.keys(args).filter(key => !allowedKeys.has(key));
  if (unknownKeys.length) throw new Error(`wait received unsupported argument${unknownKeys.length === 1 ? '' : 's'}: ${unknownKeys.join(', ')}.`);
  const { reason } = args || {};
  const timeoutSeconds = normalizeWaitFallbackSeconds(args?.wakeIfNoActivityAfterSeconds);
  let waitAllSessions = normalizeWaitAllSessions(args?.waitAllSessions);
  let waitAnySessions = normalizeWaitAnySessions(args?.waitAnySessions);
  const waitExecIds = normalizeWaitExecIds(args?.waitExecIds);
  const waitForInput = normalizeWaitForInput(args?.waitForInput);
  if (waitAllSessions && waitAnySessions) throw new Error('waitAllSessions and waitAnySessions are mutually exclusive.');
  if (!waitAllSessions && !waitAnySessions && !waitExecIds && !waitForInput && timeoutSeconds === undefined) {
    throw new Error('wait requires at least one progress source: waitAllSessions, waitAnySessions, waitExecIds, waitForInput:true, or wakeIfNoActivityAfterSeconds. reason alone is not sufficient.');
  }
  let explicitWaitId: string | undefined;

  if (ctx?.sessionId) {
    if (waitAllSessions) {
      waitAllSessions = (await validateMainWaitSessions({ sourceSessionId: ctx.sessionId, sessionIds: waitAllSessions })).sessionIds;
      if (waitAllSessions.length < 2) throw new Error('waitAllSessions must resolve to at least two distinct Sessions.');
    }
    if (waitAnySessions) {
      waitAnySessions = (await validateMainWaitSessions({ sourceSessionId: ctx.sessionId, sessionIds: waitAnySessions })).sessionIds;
      if (waitAnySessions.length < 1) throw new Error('waitAnySessions must resolve to at least one distinct Session.');
    }
    if (waitExecIds) {
      const active = ctx.execRuntime?.listRunningExecs() || [];
      const queued = new Set((ctx.session?.queue || []).map((item: any) => item?.execId).filter((id: unknown): id is string => typeof id === 'string'));
      const unresolved: string[] = [];
      for (const execId of waitExecIds) {
        const entry = active.find(candidate => candidate.id === execId);
        const owned = entry && entry.sessionId === ctx.sessionId && entry.agentName === (ctx.session?.agent || 'main');
        if (!owned && !queued.has(execId)) unresolved.push(execId);
      }
      const remoteActive = unresolved.length
        ? new Set((await validateMainWaitExecIds({ sourceSessionId: ctx.sessionId, execIds: unresolved })).activeExecIds)
        : new Set<string>();
      for (const execId of unresolved) {
        if (!remoteActive.has(execId)) {
          throw new Error(`waitExecIds entry \`${execId}\` is not an accessible active exec owned by this Session/Agent and has no queued completion. Use the exact execId, never a PID, log path, or command text.`);
        }
      }
    }
    const waitOptions = {
      reason: typeof reason === 'string' ? reason : undefined,
      timeoutSeconds,
      waitAllSessions,
      waitAnySessions,
      waitExecIds,
      waitForInput,
      declarationVersion: 1 as const,
    };
    const waitState = ctx.persistCurrentSession && ctx.session?.id === ctx.sessionId
      ? await sessionManager.startSessionWaitForSession(ctx.session, waitOptions, ctx.persistCurrentSession)
      : await sessionManager.startSessionWait(ctx.sessionId, waitOptions);
    explicitWaitId = waitState.id;

    if (timeoutSeconds !== undefined) {
      await scheduleMainWaitTimeout({
        sourceSessionId: ctx.sessionId,
        waitId: waitState.id,
        timeoutSeconds,
      });
    }
    if ((waitAllSessions || waitAnySessions) && timeoutSeconds === undefined && !waitForInput && !waitExecIds) {
      await armMainWaitLiveness({ sourceSessionId: ctx.sessionId, waitId: waitState.id });
    }
  } else {
    throw new Error('Cannot use wait without session context.');
  }

  return {
    ...buildEndTurnResult(typeof reason === 'string' ? reason : undefined),
    ...(explicitWaitId ? { __toolPostAction: { explicitWaitId } } : {}),
  };
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

export async function executeSendFileMain(args: ToolArgs, ctx?: ToolContext) {
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
  const turnReplyMetadata = ctx?.channelReplyMetadata;
  const sendOptions = {
    caption,
    ...(turnReplyMetadata?.qqbotMessageId && turnReplyMetadata.qqbotChannelId && turnReplyMetadata.qqbotConversationId
      ? {
        qqbotMessageId: turnReplyMetadata.qqbotMessageId,
        qqbotChannelId: turnReplyMetadata.qqbotChannelId,
        qqbotConversationId: turnReplyMetadata.qqbotConversationId,
      }
      : {}),
  };

  if (normalizedChannelTargetId) {
    if (normalizedChannelTargetId.startsWith('webui:')) {
      return buildSendFileResult(`File \`${file.name}\` is ready for WebUI target \`${normalizedChannelTargetId}\`.`, file);
    }

    const matchesTurnSource = Boolean(
      turnReplyMetadata?.qqbotMessageId
      && turnReplyMetadata.qqbotChannelId
      && turnReplyMetadata.qqbotConversationId
      && normalizedChannelTargetId === `${turnReplyMetadata.qqbotChannelId}:${turnReplyMetadata.qqbotConversationId}`,
    );
    await sessionManager.sendFileToChannelTargetId(
      normalizedChannelTargetId,
      file,
      matchesTurnSource ? sendOptions : { caption },
    );
    return buildSendFileResult(`File \`${file.name}\` sent to channel target \`${normalizedChannelTargetId}\``, file);
  }

  const result = await sessionManager.sendFileToSession(normalizedSessionId, file, sendOptions);
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

export async function tool_send_file(args: ToolArgs, ctx?: ToolContext) {
  if (ctx?.sessionPlacement !== 'session-worker') return await executeSendFileMain(args, ctx);
  if (!ctx.sessionId || !ctx.session || ctx.session.id !== ctx.sessionId) throw new Error('send_file requires exact session context.');
  const { deliverFile } = await import('../fileDelivery');
  const currentNode = ctx.session.currentNode || 'master';
  const runtimeNodeId = ctx.runtimeNodeId || currentNode;
  return await deliverFile({
    sourceSessionId: ctx.sessionId,
    intent: {
      ...(isNonEmptyString(args.sessionId) ? { sessionId: args.sessionId.trim() } : {}),
      ...(isNonEmptyString(args.channelTargetId) ? { channelTargetId: args.channelTargetId.trim() } : {}),
      filePath: isNonEmptyString(args.filePath) ? args.filePath.trim() : args.filePath,
      ...(isNonEmptyString(args.caption) ? { caption: args.caption.trim() } : {}),
      ...(isNonEmptyString(args.text) ? { text: args.text.trim() } : {}),
    },
    routing: { runtimeNodeId, currentNode, ...(typeof ctx.session.cwd === 'string' && ctx.session.cwd ? { cwd: ctx.session.cwd } : {}) },
  });
}
