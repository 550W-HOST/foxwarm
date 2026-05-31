import * as sessionManager from '../sessionManager';
import { resolveModelConfig } from '../config';
import { clearSessionGoal, normalizeGoalText, resolveSessionGoalRemindEvery, resolveSessionGoalRemindOnTurnEnd, setSessionGoal } from '../session/goal';
import { ToolArgs, ToolContext, normalizeToolModelKey } from './helpers';

export async function tool_set_goal(args: ToolArgs, ctx: ToolContext) {
  const targetId = ctx?.sessionId;
  if (!targetId) {
    throw new Error('Current session context is required.');
  }

  const session = ctx.session ?? await sessionManager.getSession(targetId);
  const clear = args.clear === true;

  if (clear) {
    clearSessionGoal(session);
    await sessionManager.saveSession(session.id);
    return 'ok';
  }

  const goal = normalizeGoalText(args.goal);
  if (!goal) {
    clearSessionGoal(session);
    await sessionManager.saveSession(session.id);
    return 'ok';
  }

  const remindEvery = resolveSessionGoalRemindEvery(session, args.remindEvery);
  const remindOnTurnEnd = resolveSessionGoalRemindOnTurnEnd(session, args.remindOnTurnEnd);
  setSessionGoal(session, goal, remindEvery, remindOnTurnEnd);
  await sessionManager.saveSession(session.id);

  return 'ok';
}

export async function tool_set_session_compact_threshold(args: ToolArgs, ctx: ToolContext) {
  const targetId = args.sessionId || ctx?.sessionId;
  if (!targetId) {
    throw new Error('sessionId is required when there is no current session context.');
  }

  const clear = args.clear === true;
  if (clear) {
    const result = await sessionManager.setSessionCompactThreshold(targetId);
    return [
      `Session \`${result.sessionId}\` compact threshold cleared.`,
      `Now inheriting default auto-compact threshold: ${result.effectiveThresholdTokens} tokens.`,
    ].join('\n');
  }

  if (typeof args.thresholdTokens !== 'number' || !Number.isFinite(args.thresholdTokens) || args.thresholdTokens <= 0) {
    const session = await sessionManager.getExistingSession(targetId);
    if (!session) {
      throw new Error(`Session \`${targetId}\` not found.`);
    }
    const effective = sessionManager.getEffectiveCompactThresholdTokens(session);
    const override = typeof session.compactThresholdTokens === 'number'
      ? `${session.compactThresholdTokens} tokens`
      : 'inherit global default';
    return [
      `Session \`${session.id}\` compact threshold status:`,
      `override: ${override}`,
      `effective: ${effective} tokens`,
    ].join('\n');
  }

  const result = await sessionManager.setSessionCompactThreshold(targetId, args.thresholdTokens);
  return [
    `Session \`${result.sessionId}\` compact threshold updated.`,
    `override: ${result.thresholdTokens} tokens`,
    `effective: ${result.effectiveThresholdTokens} tokens`,
  ].join('\n');
}

export async function tool_set_session_child_model(args: ToolArgs, ctx: ToolContext) {
  const targetId = args.sessionId || ctx?.sessionId;
  if (!targetId) {
    throw new Error('sessionId is required when there is no current session context.');
  }

  const clear = args.clear === true;
  if (clear) {
    const result = await sessionManager.setSessionChildModelDefault(targetId);
    const { currentKey } = resolveModelConfig(result.effectiveModel);
    return [
      `Session \`${result.sessionId}\` child default model cleared.`,
      `Now inheriting the current session model path (effective spawn model: \`${currentKey}\`).`,
    ].join('\n');
  }

  const normalizedModel = normalizeToolModelKey(args.model);
  if (!normalizedModel) {
    const session = await sessionManager.getExistingSession(targetId);
    if (!session) {
      throw new Error(`Session \`${targetId}\` not found.`);
    }

    const override = typeof session.childModelDefault === 'string' && session.childModelDefault.trim()
      ? `\`${session.childModelDefault.trim()}\``
      : 'inherit current session model';
    const { currentKey: currentSessionModel } = resolveModelConfig(session.model);
    const { currentKey: effectiveSpawnModel } = resolveModelConfig(sessionManager.resolveSpawnedSessionModel(session));
    return [
      `Session \`${session.id}\` child default model status:`,
      `override: ${override}`,
      `current session model: \`${currentSessionModel}\``,
      `effective spawned-session model: \`${effectiveSpawnModel}\``,
    ].join('\n');
  }

  const result = await sessionManager.setSessionChildModelDefault(targetId, normalizedModel);
  const { currentKey } = resolveModelConfig(result.effectiveModel);
  return [
    `Session \`${result.sessionId}\` child default model updated.`,
    `override: \`${normalizedModel}\``,
    `effective spawned-session model: \`${currentKey}\``,
  ].join('\n');
}

export async function tool_update_session_snapshot(args: ToolArgs, ctx: ToolContext) {
  const { sessionId } = args;
  const targetId = sessionId || ctx?.sessionId;

  if (!targetId) {
    throw new Error('Session ID is required.');
  }

  const result = await sessionManager.refreshSessionSnapshot(targetId);
  return `Session \`${result.sessionId}\` snapshot updated.\nAgent: \`${result.agentName}\``;
}
