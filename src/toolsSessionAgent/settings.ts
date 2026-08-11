import * as sessionManager from '../sessionManager';
import * as sessionRuntime from '../sessionRuntime';
import { MODEL_EFFORTS, type ModelEffort } from '../config';
import { clearSessionGoal, normalizeGoalText, resolveSessionGoalRemindEvery, setSessionGoal } from '../session/goal';
import { refreshSessionSnapshotForSession } from '../session/agentMetadata';
import { applyNormalizedSessionModelEffortSettings, normalizeProspectiveSessionModelEffortSettings } from '../session/modelEffortSettings';
import { buildSessionModelEffortPresentation } from '../session/modelEffortPresentation';
import type { Session } from '../types';
import { ToolArgs, ToolContext, normalizeToolModelKey } from './helpers';

function getTrustedCurrentSession(targetId: string, ctx: ToolContext): Session | undefined {
  if (!ctx.persistCurrentSession || !ctx.session || typeof ctx.session.id !== 'string') return undefined;
  if (!ctx.sessionId || ctx.sessionId !== ctx.session.id || (ctx.session.id !== targetId && !ctx.session.aliases?.includes(targetId))) return undefined;
  return ctx.session;
}

export async function tool_set_goal(args: ToolArgs, ctx: ToolContext) {
  const targetId = ctx?.sessionId;
  if (!targetId) {
    throw new Error('Current session context is required.');
  }

  const session = ctx.session ?? await sessionManager.getSession(targetId);
  const clear = args.clear === true;

  if (clear) {
    clearSessionGoal(session);
    if (ctx.persistCurrentSession) await ctx.persistCurrentSession();
    else await sessionManager.saveSession(session.id);
    return 'ok';
  }

  const goal = normalizeGoalText(args.goal);
  if (!goal) {
    clearSessionGoal(session);
    if (ctx.persistCurrentSession) await ctx.persistCurrentSession();
    else await sessionManager.saveSession(session.id);
    return 'ok';
  }

  const remindEvery = resolveSessionGoalRemindEvery(session, args.remindEvery);
  setSessionGoal(session, goal, remindEvery);
  if (ctx.persistCurrentSession) await ctx.persistCurrentSession();
  else await sessionManager.saveSession(session.id);

  return 'ok';
}

export async function tool_set_session_compact_threshold(args: ToolArgs, ctx: ToolContext) {
  const targetId = args.sessionId || ctx?.sessionId;
  if (!targetId) {
    throw new Error('sessionId is required when there is no current session context.');
  }
  const currentSession = getTrustedCurrentSession(targetId, ctx);

  const clear = args.clear === true;
  if (currentSession) {
    if (clear) {
      const prior = typeof currentSession.compactThresholdTokens === 'number' ? currentSession.compactThresholdTokens : null;
      delete currentSession.compactThresholdTokens;
      if (prior !== null) await ctx.persistCurrentSession!();
      const effective = sessionManager.getEffectiveCompactThresholdTokens(currentSession);
      return `Session \`${currentSession.id}\` compact threshold cleared.\nNow inheriting default auto-compact threshold: ${effective} tokens.`;
    }
    if (typeof args.thresholdTokens !== 'number' || !Number.isFinite(args.thresholdTokens) || args.thresholdTokens <= 0) {
      const effective = sessionManager.getEffectiveCompactThresholdTokens(currentSession);
      const override = typeof currentSession.compactThresholdTokens === 'number'
        ? `${currentSession.compactThresholdTokens} tokens`
        : 'inherit global default';
      return `Session \`${currentSession.id}\` compact threshold status:\noverride: ${override}\neffective: ${effective} tokens`;
    }
    const prior = typeof currentSession.compactThresholdTokens === 'number' ? currentSession.compactThresholdTokens : null;
    const next = Math.floor(args.thresholdTokens);
    currentSession.compactThresholdTokens = next;
    if (prior !== next) await ctx.persistCurrentSession!();
    const effective = sessionManager.getEffectiveCompactThresholdTokens(currentSession);
    return `Session \`${currentSession.id}\` compact threshold updated.\noverride: ${currentSession.compactThresholdTokens} tokens\neffective: ${effective} tokens`;
  }
  if (clear) {
    const result = await sessionRuntime.updateSettings(targetId, { compactThresholdTokens: null });
    const effective = sessionManager.getEffectiveCompactThresholdTokens({
      model: result.session.model || undefined,
      compactThresholdTokens: undefined,
    });
    return [
      `Session \`${result.session.id}\` compact threshold cleared.`,
      `Now inheriting default auto-compact threshold: ${effective} tokens.`,
    ].join('\n');
  }

  if (typeof args.thresholdTokens !== 'number' || !Number.isFinite(args.thresholdTokens) || args.thresholdTokens <= 0) {
    const session = await sessionRuntime.getSession(targetId);
    if (!session) {
      throw new Error(`Session \`${targetId}\` not found.`);
    }
    const effective = sessionManager.getEffectiveCompactThresholdTokens({
      model: session.model || undefined,
      compactThresholdTokens: session.compactThresholdTokens || undefined,
    });
    const override = typeof session.compactThresholdTokens === 'number'
      ? `${session.compactThresholdTokens} tokens`
      : 'inherit global default';
    return [
      `Session \`${session.id}\` compact threshold status:`,
      `override: ${override}`,
      `effective: ${effective} tokens`,
    ].join('\n');
  }

  const result = await sessionRuntime.updateSettings(targetId, { compactThresholdTokens: args.thresholdTokens });
  const effective = sessionManager.getEffectiveCompactThresholdTokens({
    model: result.session.model || undefined,
    compactThresholdTokens: result.current.compactThresholdTokens || undefined,
  });
  return [
    `Session \`${result.session.id}\` compact threshold updated.`,
    `override: ${result.current.compactThresholdTokens} tokens`,
    `effective: ${effective} tokens`,
  ].join('\n');
}

function normalizeToolEffort(value: unknown): ModelEffort | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new Error('effort must be a canonical effort string or null.');
  const normalized = value.trim().toLowerCase();
  if (!normalized || ['default', 'unset'].includes(normalized)) return null;
  if (!MODEL_EFFORTS.includes(normalized as ModelEffort)) throw new Error(`effort must be one of: ${MODEL_EFFORTS.join(', ')}, default, or unset.`);
  return normalized as ModelEffort;
}

function formatChildModelEffortStatus(session: Pick<Session, 'id' | 'model' | 'effort' | 'childModelDefault' | 'childEffortDefault'>): string {
  const view = buildSessionModelEffortPresentation(session);
  return [
    `Session \`${session.id}\` child model/effort defaults:`,
    `model override: ${view.childModelDefault ? `\`${view.childModelDefault}\`` : 'follow current model'}`,
    `effective model: \`${view.effectiveChildModelKey}\``,
    `effort override: ${view.childEffort.raw || 'unset'}`,
    `effective effort: ${view.childEffort.effective}`,
    `allowed: ${view.childEffort.allowed.join(', ')}`,
  ].join('\n');
}

function formatChildMutationResult(session: Pick<Session, 'id' | 'model' | 'effort' | 'childModelDefault' | 'childEffortDefault'>, action: string): string {
  return `${action}\n${formatChildModelEffortStatus(session)}`;
}

export async function tool_set_session_child_model(args: ToolArgs, ctx: ToolContext) {
  const targetId = args.sessionId || ctx?.sessionId;
  if (!targetId) throw new Error('sessionId is required when there is no current session context.');
  const suppliedModel = Object.prototype.hasOwnProperty.call(args, 'model');
  if (args.clear === true && suppliedModel) throw new Error('clear=true cannot be combined with model.');
  const hasModel = args.clear === true || suppliedModel;
  const hasEffort = Object.prototype.hasOwnProperty.call(args, 'effort');
  const patch: Record<string, any> = {};
  if (hasModel) patch.childModelDefault = args.clear === true ? null : (normalizeToolModelKey(args.model) || null);
  if (hasEffort) patch.childEffortDefault = normalizeToolEffort(args.effort);

  const currentSession = getTrustedCurrentSession(targetId, ctx);
  if (currentSession) {
    if (Object.keys(patch).length === 0) return formatChildModelEffortStatus(currentSession);
    const changed = applyNormalizedSessionModelEffortSettings(
      currentSession,
      normalizeProspectiveSessionModelEffortSettings(currentSession, patch),
    );
    if (changed.length > 0) await ctx.persistCurrentSession!();
    const action = args.clear === true && !hasEffort
      ? 'Child default model cleared.'
      : hasModel && !hasEffort ? 'Child default model updated.' : 'Child model/effort defaults updated.';
    return formatChildMutationResult(currentSession, action);
  }

  if (Object.keys(patch).length === 0) {
    const session = await sessionRuntime.getSession(targetId);
    if (!session) throw new Error(`Session \`${targetId}\` not found.`);
    return formatChildModelEffortStatus(session);
  }
  const result = await sessionRuntime.updateSettings(targetId, patch);
  const action = args.clear === true && !hasEffort
    ? 'Child default model cleared.'
    : hasModel && !hasEffort ? 'Child default model updated.' : 'Child model/effort defaults updated.';
  return formatChildMutationResult(result.session, action);
}

export async function tool_update_session_snapshot(args: ToolArgs, ctx: ToolContext) {
  const { sessionId } = args;
  const targetId = sessionId || ctx?.sessionId;

  if (!targetId) {
    throw new Error('Session ID is required.');
  }

  const currentSession = getTrustedCurrentSession(targetId, ctx);
  if (currentSession) {
    const result = await refreshSessionSnapshotForSession(currentSession, ctx.persistCurrentSession!);
    return `Session \`${result.sessionId}\` snapshot updated.\nAgent: \`${result.agentName}\``;
  }

  const result = await sessionManager.refreshSessionSnapshot(targetId);
  return `Session \`${result.sessionId}\` snapshot updated.\nAgent: \`${result.agentName}\``;
}
