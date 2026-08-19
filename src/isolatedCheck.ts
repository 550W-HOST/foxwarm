/**
 * Isolated Session Authorization Helper
 * Centralized authorization logic for isolated sessions
 */

import * as sessionManager from './sessionManager';
import { AGENTS_DIR, getAgentDir } from './config';
import * as path from 'path';
import {
  findExactAgentToolRule,
  isDefaultIsolatedCapabilityAllowed,
  ResolvedToolPermissionIdentity,
} from './permissions';
import { expandHomePath } from './utils/pathResolve';
import * as agentMetadata from './session/agentMetadata';
import type { Session } from './types';

const ISOLATED_ALWAYS_UNAVAILABLE_BUILTINS = new Set([
  'create_agent', 'list_agents', 'set_agent_inherit', 'set_agent_isolated', 'move_session',
  'create_session', 'create_child_session', 'delete_session', 'get_session_messages',
]);

/**
 * Check if isolated session can use a specific tool
 * @param identity Canonical resolved capability identity
 * @param sessionId Session ID
 * @param executionNode Resolved execution node for the tool call
 * @param toolArgs Tool arguments (for path-based tools)
 * @throws Error if not allowed
 */
export async function checkToolPermission(
  identity: ResolvedToolPermissionIdentity,
  sessionId: string,
  executionNode?: string,
  toolArgs?: Record<string, any>
): Promise<void> {
  const session = sessionManager.getSessionCatalog(sessionId);
  if (!session) return;
  await checkToolPermissionForSession(session, identity, executionNode, toolArgs);
}

/** Check a tool against an already-authoritative current Session without loading the global session map. */
export async function checkToolPermissionForSession(
  session: Session,
  rawIdentity: ResolvedToolPermissionIdentity,
  executionNode?: string,
  toolArgs?: Record<string, any>,
  refreshMetadata = false,
): Promise<void> {
  if (refreshMetadata && agentMetadata.isSessionEffectivelyIsolated(session)) {
    await agentMetadata.refreshAgentMetadata(session.agent || 'main');
  }
  if (!agentMetadata.isSessionEffectivelyIsolated(session)) return;
  const agentName = session?.agent || 'main';
  const boundNode = agentMetadata.getAgentIsolationNode(agentName) || session?.currentNode || 'master';
  const effectiveNode = executionNode || 'master';
  const identity: ResolvedToolPermissionIdentity = rawIdentity.source === 'node'
    ? { ...rawIdentity, node: rawIdentity.node || effectiveNode }
    : rawIdentity.source === 'mcp'
      ? { ...rawIdentity, server: rawIdentity.server || 'default' }
      : rawIdentity;

  if (identity.source === 'node' && identity.node === 'master' && identity.tool === 'exec') {
    throw new Error('Isolated agent sessions cannot run exec on master node. Use the bound node instead.');
  }
  if (identity.source === 'builtin' && ISOLATED_ALWAYS_UNAVAILABLE_BUILTINS.has(identity.tool)) {
    throw new Error(`Isolated agent sessions cannot use structurally restricted builtin \`${identity.tool}\`.`);
  }

  const exactRule = findExactAgentToolRule(agentMetadata.getAgentToolRules(agentName), identity);
  if (exactRule?.effect === 'deny') {
    throw new Error(`Agent tool rule denies ${identity.source} capability \`${identity.tool}\`.`);
  }

  if (identity.source === 'builtin' && identity.tool === 'copy_between_nodes') {
    checkCopyBetweenNodesPermission(agentName, boundNode, session?.currentNode, toolArgs);
    return;
  }

  const timerTools = ['create_timer', 'list_timers', 'update_timer', 'delete_timer'];
  if (identity.source === 'builtin' && timerTools.includes(identity.tool)) {
    checkTimerPermissionForSession(session, {
      targetSessionId: toolArgs?.sessionId,
      newSession: toolArgs?.newSession,
      agentName: toolArgs?.agentName,
      sessionPrefix: toolArgs?.sessionPrefix,
    });
    return;
  }

  if (exactRule?.effect === 'allow') return;
  if (isDefaultIsolatedCapabilityAllowed(identity, agentName, boundNode, session.currentNode, effectiveNode, toolArgs)) return;
  throw new Error(`Isolated agent sessions cannot use ${identity.source} capability \`${identity.tool}\`.`);
}

export function isToolVisibleForSession(
  session: Session | undefined,
  rawIdentity: ResolvedToolPermissionIdentity,
  executionNode = 'master',
): boolean {
  if (!session || !agentMetadata.isSessionEffectivelyIsolated(session)) return true;
  const agentName = session.agent || 'main';
  const boundNode = agentMetadata.getAgentIsolationNode(agentName) || session.currentNode || 'master';
  const identity: ResolvedToolPermissionIdentity = rawIdentity.source === 'node'
    ? { ...rawIdentity, node: rawIdentity.node || executionNode }
    : rawIdentity.source === 'mcp'
      ? { ...rawIdentity, server: rawIdentity.server || 'default' }
      : rawIdentity;
  if (identity.source === 'node' && identity.node === 'master' && identity.tool === 'exec') return false;
  if (identity.source === 'builtin' && ISOLATED_ALWAYS_UNAVAILABLE_BUILTINS.has(identity.tool)) return false;
  const exactRule = findExactAgentToolRule(agentMetadata.getAgentToolRules(agentName), identity);
  if (exactRule) return exactRule.effect === 'allow';
  return isDefaultIsolatedCapabilityAllowed(identity, agentName, boundNode, session.currentNode, executionNode, {}, true);
}


function resolvePermissionPath(filePath: unknown, agentName: string): string | null {
  if (typeof filePath !== 'string' || filePath.trim().length === 0) {
    return null;
  }
  const expandedPath = expandHomePath(filePath.trim());
  const agentDir = getAgentDir(agentName);
  return path.normalize(path.isAbsolute(expandedPath) ? path.resolve(expandedPath) : path.resolve(agentDir, expandedPath));
}

function isPathWithinAgentDir(filePath: unknown, agentName: string): boolean {
  const resolvedPath = resolvePermissionPath(filePath, agentName);
  if (!resolvedPath) {
    return false;
  }
  const agentDir = path.normalize(getAgentDir(agentName));
  return resolvedPath === agentDir || resolvedPath.startsWith(agentDir + path.sep);
}

function checkCopyBetweenNodesPermission(agentName: string, boundNode: string, currentNode: string | undefined, toolArgs?: Record<string, any>): void {
  const sourceNode = typeof toolArgs?.sourceNode === 'string' ? toolArgs.sourceNode : '';
  const targetNode = typeof toolArgs?.targetNode === 'string' ? toolArgs.targetNode : '';
  const allowedNodes = new Set(['master', boundNode]);
  if (typeof currentNode === 'string' && currentNode.length > 0) {
    allowedNodes.add(currentNode);
  }

  if (!allowedNodes.has(sourceNode) || !allowedNodes.has(targetNode)) {
    throw new Error(`Isolated agent sessions can only use copy_between_nodes between master and their bound/current node (${Array.from(allowedNodes).join(', ')}).`);
  }

  if (sourceNode === 'master' && !isPathWithinAgentDir(toolArgs?.sourcePath, agentName)) {
    throw new Error(`Isolated agent session can only read from agents/${agentName}/ on master during copy_between_nodes.`);
  }

  if (targetNode === 'master' && !isPathWithinAgentDir(toolArgs?.targetPath, agentName)) {
    throw new Error(`Isolated agent session can only write to agents/${agentName}/ on master during copy_between_nodes.`);
  }
}

/**
 * Check if isolated session can access the given path
 * Isolated agent sessions can only access their own agent directory (agents/{agentName}/)
 * @param fullPath Absolute path to check
 * @param agentName Current agent name
 * @throws Error if path is not allowed
 */
export function checkPathAccess(fullPath: string, agentName: string): void {
  const agentDir = getAgentDir(agentName);
  const agentsDir = AGENTS_DIR;

  const normalizedPath = path.normalize(fullPath);
  const normalizedAgentDir = path.normalize(agentDir);
  const normalizedAgentsDir = path.normalize(agentsDir);

  // Allow access only to current agent's directory on master.
  if (normalizedPath === normalizedAgentDir || normalizedPath.startsWith(normalizedAgentDir + path.sep)) {
    return;
  }

  // Block access to other agents or sensitive directories
  if (normalizedPath.startsWith(normalizedAgentsDir + path.sep)) {
    const relativePath = normalizedPath.slice(normalizedAgentsDir.length + 1);
    const targetAgent = relativePath.split(path.sep)[0];
    if (targetAgent && targetAgent !== agentName) {
      throw new Error(`Isolated agent session cannot access other agent directories. Allowed on master: agents/${agentName}/`);
    }
  }

  throw new Error(`Isolated agent session can only access agents/${agentName}/ on master.`);
}

/**
 * Require session is NOT isolated (throw if isolated)
 * @param sessionIdOrCtx Session ID or ToolContext
 * @param operation Operation name for error message
 * @throws Error if session is isolated
 */
export async function requireNotIsolated(sessionIdOrCtx: string | { sessionId?: string }, operation: string): Promise<void> {
  const sessionId = typeof sessionIdOrCtx === 'string' ? sessionIdOrCtx : sessionIdOrCtx.sessionId;
  if (!sessionId) return;
  
  const session = sessionManager.getSessionCatalog(sessionId);
  requireNotIsolatedForSession(session, operation);
}

/** Apply the same non-isolated guard to an already-authoritative current Session. */
export function requireNotIsolatedForSession(session: Session | undefined, operation: string): void {
  if (sessionManager.isSessionEffectivelyIsolated(session)) {
    throw new Error(`Isolated session cannot use ${operation} tool.`);
  }
}

/**
 * Allow selected archive-inspection tools for isolated sessions, but only when
 * they target sessions under the same agent. This keeps the permission narrow:
 * read-only archived history on master without opening broader cross-agent
 * master-side session introspection.
 */
export async function checkArchivedReadPermission(
  sessionIdOrCtx: string | { sessionId?: string },
  targetSessionId: string | undefined,
  operation: 'get_archived_messages' | 'get_archived_blocks' | 'recall',
): Promise<void> {
  const sessionId = typeof sessionIdOrCtx === 'string' ? sessionIdOrCtx : sessionIdOrCtx.sessionId;
  if (!sessionId) return;

  const session = sessionManager.getSessionCatalog(sessionId);
  if (!sessionManager.isSessionEffectivelyIsolated(session)) return;

  const callerAgent = session?.agent || 'main';
  const requested = targetSessionId || sessionId;
  const targetSession = sessionManager.getSessionCatalog(requested);
  const targetAgent = targetSession?.agent || requested.split('/')[0] || callerAgent;

  if (targetAgent !== callerAgent) {
    throw new Error(`Isolated session can only use ${operation} for sessions under its own agent (${callerAgent}).`);
  }
}

/** Check an exact current Session (or one of its persisted aliases) without loading the global session map. */
export function checkArchivedReadPermissionForSession(
  session: Session,
  targetSessionId: string | undefined,
  operation: 'get_archived_messages' | 'get_archived_blocks' | 'recall',
): void {
  if (!sessionManager.isSessionEffectivelyIsolated(session)) return;
  const requested = targetSessionId || session.id;
  if (requested === session.id || (session.aliases || []).includes(requested)) return;
  const callerAgent = session.agent || 'main';
  const targetAgent = requested.split('/')[0] || callerAgent;
  if (targetAgent !== callerAgent) {
    throw new Error(`Isolated session can only use ${operation} for sessions under its own agent (${callerAgent}).`);
  }
}

/**
 * Check if isolated session can send to a specific channel
 * @param sessionIdOrCtx Session ID or ToolContext
 * @param channelTargetId Target channel target id (<channel-instance-id>:<conversation-id>)
 * @throws Error if not allowed
 */
export async function checkChannelPermission(sessionIdOrCtx: string | { sessionId?: string }, channelTargetId: string): Promise<void> {
  const sessionId = typeof sessionIdOrCtx === 'string' ? sessionIdOrCtx : sessionIdOrCtx.sessionId;
  if (!sessionId) return;
  
  const session = sessionManager.getSessionCatalog(sessionId);
  if (!sessionManager.isSessionEffectivelyIsolated(session)) return;

  const attachedChannels = sessionManager.getChannelsBySession(sessionId);
  const attachedChannelIds = attachedChannels.map(ch => `${ch.channelId}:${ch.conversationId}`);
  
  if (!attachedChannelIds.includes(channelTargetId)) {
    throw new Error('Isolated session can only send messages to its own attached channel.');
  }
}

/**
 * Check if isolated session can use send_file for the given target.
 * For channel targets, reuse the attached-channel check.
 * For session targets, only allow the current isolated session itself so the
 * caller cannot relay files through another session's attached channels.
 */
export async function checkSendFilePermission(
  sessionIdOrCtx: string | { sessionId?: string },
  options: { channelTargetId?: string; targetSessionId?: string }
): Promise<void> {
  const sessionId = typeof sessionIdOrCtx === 'string' ? sessionIdOrCtx : sessionIdOrCtx.sessionId;
  if (!sessionId) return;

  const session = sessionManager.getSessionCatalog(sessionId);
  if (!sessionManager.isSessionEffectivelyIsolated(session)) return;

  if (options.channelTargetId) {
    await checkChannelPermission(sessionId, options.channelTargetId);
  }

  if (options.targetSessionId && options.targetSessionId !== sessionId) {
    throw new Error('Isolated session can only send files via its own current session attachments.');
  }
}

/**
 * Check whether an isolated session may manage a timer.
 * Isolated sessions may only manage timers for their own current session.
 * They may create timer-fired new sessions, but only inside the same agent so
 * the new session naturally inherits the agent-level isolation binding.
 */
export async function checkTimerPermission(
  sessionIdOrCtx: string | { sessionId?: string },
  options: {
    targetSessionId?: string;
    newSession?: unknown;
    agentName?: unknown;
    sessionPrefix?: unknown;
  } = {}
): Promise<void> {
  const sessionId = typeof sessionIdOrCtx === 'string' ? sessionIdOrCtx : sessionIdOrCtx.sessionId;
  if (!sessionId) return;

  const session = sessionManager.getSessionCatalog(sessionId);
  if (!session) return;
  checkTimerPermissionForSession(session, options);
}

export function checkTimerPermissionForSession(
  session: Session,
  options: {
    targetSessionId?: string;
    newSession?: unknown;
    agentName?: unknown;
    sessionPrefix?: unknown;
  } = {},
): void {
  if (!agentMetadata.isSessionEffectivelyIsolated(session)) return;

  const callerAgent = session?.agent || 'main';
  const targetSessionId = options.targetSessionId || session.id;
  if (targetSessionId !== session.id) {
    throw new Error('Isolated session can only manage timers for its own current session.');
  }

  const requestedAgent = typeof options.agentName === 'string' && options.agentName.trim().length > 0
    ? options.agentName.trim()
    : undefined;

  if (options.newSession === true) {
    if (requestedAgent && requestedAgent !== callerAgent) {
      throw new Error(`Isolated session timers may only create new sessions inside their own agent (${callerAgent}).`);
    }
    return;
  }

  if (requestedAgent) {
    throw new Error('Isolated session timers may only specify agentName together with newSession=true.');
  }

  if (typeof options.sessionPrefix === 'string' && options.sessionPrefix.trim().length > 0) {
    throw new Error('Isolated session timers may only specify sessionPrefix together with newSession=true.');
  }
}
