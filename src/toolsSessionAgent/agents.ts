import fs from 'fs-extra';
import * as llm from '../llm';
import * as sessionManager from '../sessionManager';
import { AGENTS_DIR } from '../config';
import { resolveModelConfig } from '../config';
import { requireNotIsolated } from '../isolatedCheck';
import { executeMainManagementTool } from '../mainManagementTools';
import { RpcError } from '../rpc';
import {
  ToolArgs,
  ToolContext,
  normalizeToolModelKey,
} from './helpers';

export async function tool_create_agent(args: ToolArgs, ctx: ToolContext) {
  if (ctx?.sessionPlacement === 'session-worker') {
    if (args.convertSession === true) throw new RpcError('SESSION_WORKER_TOOL_UNAVAILABLE', 'create_agent source conversion is unavailable in Session-worker placement.', true);
    if (args.sourceSessionId && ctx.session
      && args.sourceSessionId !== ctx.session.id && !ctx.session.aliases?.includes(args.sourceSessionId)) {
      throw new RpcError('SESSION_WORKER_TOOL_UNAVAILABLE', 'create_agent from another source session is unavailable in Session-worker placement.', true);
    }
    return executeMainManagementTool('create_agent', args, ctx);
  }
  await requireNotIsolated(ctx, 'create_agent');
  const {
    agentName,
    inheritMemory = false,
    sourceSessionId,
    convertSession = false,
    createMainSession = true,
    inherit,
    isolatedNode,
  } = args;

  if (!agentName || typeof agentName !== 'string') {
    throw new Error('agentName is required');
  }

  const normalizedInherit = inherit && String(inherit).trim()
    ? String(inherit).trim()
    : undefined;
  const sourceId = sourceSessionId || ctx.sessionId || ctx.session?.id;
  const result = await sessionManager.createAgentWithMainSession({
    agentName,
    inheritMemory,
    sourceSessionId: sourceId,
    sourceSessionOverride: ctx.session && (sourceId === ctx.session.id || ctx.session.aliases?.includes(sourceId)) ? ctx.session : undefined,
    convertSessionId: convertSession ? sourceId : undefined,
    currentNode: ctx.session?.currentNode,
    model: ctx.session?.model,
    createMainSession,
    inherit: normalizedInherit,
    isolatedNode,
  });

  if (result.convertedFromSessionId) {
    let message = `Session "${result.convertedFromSessionId}" converted to agent "${agentName}".\nAgent folder: ${result.agentDir}\nMain session: ${result.mainSessionId}`;
    if (normalizedInherit) {
      message += `\nShared memory inherits from: ${normalizedInherit}`;
    }
    if (result.aliases.length > 0) {
      message += `\nAliases: ${result.aliases.join(', ')}`;
    }
    if (result.updatedChildren.length > 0) {
      message += `\nUpdated ${result.updatedChildren.length} child session parent reference(s).`;
    }
    return message;
  }

  let message = `Agent "${agentName}" created successfully.\nAgent folder: ${result.agentDir}`;
  if (normalizedInherit) {
    message += `\nShared memory inherits from: ${normalizedInherit}`;
  }
  if (isolatedNode) {
    message += `\nIsolation: enabled on node ${isolatedNode}`;
  }
  if (result.createdMainSession) {
    message += `\nMain session: ${result.mainSessionId}`;
  } else {
    message += '\nMain session: not created';
  }
  return message;
}

export async function tool_list_agents(_args: ToolArgs = {}, ctx?: ToolContext) {
  await requireNotIsolated(ctx, 'list_agents');
  const agentsDir = AGENTS_DIR;

  if (!await fs.pathExists(agentsDir)) {
    return 'No agents directory found.';
  }

  const entries = await fs.readdir(agentsDir, { withFileTypes: true });
  const agents: Array<{name: string, hasSessions: boolean, sessionCount: number, inherit?: string, isolated?: boolean, isolatedNode?: string}> = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const agentName = entry.name;
      const sessions = Array.from(sessionManager.getAllSessions().values())
        .filter(sess => (sess.agent || 'main') === agentName);

      agents.push({
        name: agentName,
        hasSessions: sessions.length > 0,
        sessionCount: sessions.length,
        inherit: sessionManager.getAgentMetadata(agentName).inherit,
        isolated: sessionManager.getAgentMetadata(agentName).isolated,
        isolatedNode: sessionManager.getAgentIsolationNode(agentName),
      });
    }
  }

  if (agents.length === 0) {
    return 'No agents found.';
  }

  let result = `Found ${agents.length} agent(s):\n\n`;
  for (const agent of agents) {
    result += `- **${agent.name}**`;
    if (agent.hasSessions) {
      result += ` (${agent.sessionCount} session${agent.sessionCount > 1 ? 's' : ''})`;
    }
    if (agent.inherit) {
      result += ` [inherits: ${agent.inherit}]`;
    }
    if (agent.isolated) {
      result += ` [isolated${agent.isolatedNode ? `:${agent.isolatedNode}` : ''}]`;
    }
    result += '\n';
  }

  return result;
}

export async function tool_set_agent_inherit(args: ToolArgs, ctx?: ToolContext) {
  await requireNotIsolated(ctx, 'set_agent_inherit');
  const { agentName, inheritAgentName } = args;

  if (!agentName || typeof agentName !== 'string') {
    throw new Error('agentName is required');
  }

  const normalizedInherit = inheritAgentName && String(inheritAgentName).trim()
    ? String(inheritAgentName).trim()
    : undefined;

  const result = await sessionManager.setAgentInherit(agentName, normalizedInherit);
  const chain = sessionManager.getAgentInheritanceChain(agentName);

  let message = normalizedInherit
    ? `Agent "${agentName}" now inherits shared memory from "${normalizedInherit}".`
    : `Cleared shared memory inheritance for agent "${agentName}".`;

  message += `\nInheritance chain: ${chain.join(' -> ')}`;
  if (result.affectedSessions.length > 0) {
    message += `\nUpdated ${result.affectedSessions.length} session snapshot(s).`;
  }

  return message;
}

export async function tool_set_agent_isolated(args: ToolArgs, ctx?: ToolContext) {
  await requireNotIsolated(ctx, 'set_agent_isolated');
  const { agentName, nodeId } = args;

  if (!agentName || typeof agentName !== 'string') {
    throw new Error('agentName is required');
  }

  const result = await sessionManager.setAgentIsolation(
    agentName,
    typeof nodeId === 'string' && nodeId.trim() ? nodeId.trim() : undefined,
  );

  let message = result.isolated
    ? `Agent "${agentName}" is now isolated on node "${result.node}".`
    : `Agent "${agentName}" isolation cleared.`;
  if (result.affectedSessions.length > 0) {
    message += `\nUpdated ${result.affectedSessions.length} session(s).`;
  }
  return message;
}

export async function tool_move_session(args: ToolArgs, ctx: ToolContext) {
  const {
    sessionId,
    newSessionId,
    createAgent = false,
    newAgentName,
    createAgentInheritMemory,
    parentSessionId,
  } = args;

  const sourceId = sessionId || ctx.sessionId;
  if (!sourceId) {
    throw new Error('sessionId is required');
  }

  const sourceSession = await sessionManager.getExistingSession(sourceId);
  if (!sourceSession) {
    throw new Error(`Session "${sourceId}" not found.`);
  }

  if (sessionManager.isSessionEffectivelyIsolated(sourceSession)) {
    throw new Error('Isolated session cannot use move_session tool.');
  }
  if (parentSessionId !== undefined && (typeof parentSessionId !== 'string' || !parentSessionId.trim())) {
    throw new Error('parentSessionId must be a non-empty session ID when provided.');
  }

  const result = await sessionManager.moveSessionToTarget({
    sourceSessionId: sourceId,
    newSessionId,
    createAgent,
    newAgentName,
    createAgentInheritMemory,
    ...(parentSessionId !== undefined ? { parentSessionId: parentSessionId.trim() } : {}),
  });

  let message = `Session "${sourceId}" moved to "${result.targetSessionId}".`;
  if (result.createdAgent) {
    message += `\nAgent "${result.targetAgent}" created.`;
  }
  if (result.aliases.length > 0) {
    message += `\nAliases: ${result.aliases.join(', ')}`;
  }
  if (result.updatedChildren.length > 0) {
    message += `\nUpdated ${result.updatedChildren.length} child session parent reference(s).`;
  }
  message += `\nPrevious parent: ${result.previousParentSessionId || '(none)'}.`;
  message += `\nResulting parent: ${result.parentSessionId || '(none)'}.`;
  if (result.parentUpdateError) {
    message += `\nWARNING: The identity move committed, but the requested parent update was not confirmed: ${result.parentUpdateError}`;
    message += `\nRequested parent: ${result.requestedParentSessionId || '(none)'}.`;
  }

  return message;
}

export async function tool_create_session(args: ToolArgs, ctx: ToolContext) {
  if (ctx?.sessionPlacement === 'session-worker') return executeMainManagementTool('create_session', args, ctx);
  await requireNotIsolated(ctx, 'create_session');
  const { agentName, sessionName, displayName, parentSessionId } = args;
  const requestedModel = normalizeToolModelKey(args.model);
  const systemPromptFiles = args.systemPromptFiles === undefined
    ? undefined
    : llm.normalizeSystemPromptFiles(args.systemPromptFiles);

  if (args.systemPromptFiles !== undefined && !Array.isArray(args.systemPromptFiles)) {
    throw new Error('systemPromptFiles must be an array of strings');
  }

  if (!agentName || typeof agentName !== 'string') {
    throw new Error('agentName is required');
  }
  if (!sessionName || typeof sessionName !== 'string') {
    throw new Error('sessionName is required');
  }

  const result = await sessionManager.createSessionInAgent({
    agentName,
    sessionName,
    displayName,
    parentSessionId,
    systemPromptFiles,
    currentNode: ctx.session?.currentNode,
    model: sessionManager.resolveSpawnedSessionModel(ctx.session, requestedModel),
  });

  let message = `Session "${result.sessionId}" created under agent "${agentName}".`;
  if (displayName) {
    message += `\nDisplay name: ${displayName}`;
  }
  if (parentSessionId) {
    message += `\nParent session: ${parentSessionId}`;
  }
  if (systemPromptFiles) {
    message += `\nSystem prompt files: ${systemPromptFiles.length > 0 ? systemPromptFiles.join(', ') : '(none)'}`;
  }
  const createdSession = await sessionManager.getSession(result.sessionId);
  const { currentKey } = resolveModelConfig(createdSession.model);
  message += `\nModel: ${currentKey}`;
  return message;
}
