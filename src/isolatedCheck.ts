/**
 * Isolated Session Authorization Helper
 * Centralized authorization logic for isolated sessions
 */

import * as sessionManager from './sessionManager';
import { AGENTS_DIR, getAgentDir } from './config';
import * as path from 'path';

/**
 * Check if isolated session can use a specific tool
 * @param toolName Tool name
 * @param sessionId Session ID
 * @param executionNode Resolved execution node for the tool call
 * @param toolArgs Tool arguments (for path-based tools)
 * @throws Error if not allowed
 */
export async function checkToolPermission(
  toolName: string,
  sessionId: string,
  executionNode?: string,
  toolArgs?: Record<string, any>
): Promise<void> {
  const session = await sessionManager.getExistingSession(sessionId);
  if (!sessionManager.isSessionEffectivelyIsolated(session)) return;

  const timerTools = ['create_timer', 'list_timers', 'delete_timer'];
  if (timerTools.includes(toolName)) {
    await checkTimerPermission(sessionId, {
      targetSessionId: toolArgs?.sessionId,
      newSession: toolArgs?.newSession,
      agentName: toolArgs?.agentName,
      sessionPrefix: toolArgs?.sessionPrefix,
    });
    return;
  }

  // Tools that isolated session can use
  const allowedTools = ['read', 'write', 'edit', 'apply_patch', 'exec', 'remote_node', 'send_to_session', 'send_file', 'search_memory'];
  if (!allowedTools.includes(toolName)) {
    throw new Error(`Isolated session cannot use ${toolName} tool.`);
  }

  // For tools that execute on a node, check node permission.
  // Isolated sessions may still access files on master within their own
  // agent directory, but must never run shell exec on master.
  const nodeDependentTools = ['read', 'write', 'edit', 'apply_patch', 'exec'];
  if (nodeDependentTools.includes(toolName) && executionNode) {
    const currentNode = sessionManager.getAgentIsolationNode(session.agent || 'main') || session.currentNode || 'master';

    if (toolName === 'exec' && executionNode === 'master') {
      throw new Error('Isolated session cannot run exec on master node. Bind it to a non-master node first.');
    }

    const allowsMaster = toolName !== 'exec';
    const allowedNodes = allowsMaster ? ['master', currentNode] : [currentNode];
    if (!allowedNodes.includes(executionNode)) {
      const allowedText = allowsMaster ? `master, ${currentNode}` : currentNode;
      throw new Error(`Isolated session cannot run ${toolName} on node "${executionNode}". Allowed: ${allowedText}`);
    }
  }
  
  // Check path access for path-based tools on master
  const pathBoundTools = ['read', 'write', 'edit', 'apply_patch', 'send_file'];
  if (pathBoundTools.includes(toolName) && toolArgs?.filePath && (!executionNode || executionNode === 'master')) {
    const requestedPath = String(toolArgs.filePath);
    const fullPath = path.isAbsolute(requestedPath)
      ? requestedPath
      : path.join(getAgentDir(session.agent || 'main'), requestedPath);
    checkPathAccess(fullPath, session.agent || 'main');
  }
}

/**
 * Check if isolated session can access the given path
 * Isolated sessions can only access their own agent directory (agents/{agentName}/)
 * @param fullPath Absolute path to check
 * @param agentName Current agent name
 * @throws Error if path is not allowed
 */
export function checkPathAccess(fullPath: string, agentName: string): void {
  const agentDir = getAgentDir(agentName);
  const agentMemoryDir = path.join(agentDir, 'memory');
  const agentsDir = AGENTS_DIR;

  const normalizedPath = path.normalize(fullPath);
  const normalizedAgentMemoryDir = path.normalize(agentMemoryDir);
  const normalizedAgentsDir = path.normalize(agentsDir);

  // Allow access only to current agent's memory directory on master.
  if (normalizedPath === normalizedAgentMemoryDir || normalizedPath.startsWith(normalizedAgentMemoryDir + path.sep)) {
    return;
  }

  // Block access to other agents or sensitive directories
  if (normalizedPath.startsWith(normalizedAgentsDir + path.sep)) {
    const relativePath = normalizedPath.slice(normalizedAgentsDir.length + 1);
    const targetAgent = relativePath.split(path.sep)[0];
    if (targetAgent && targetAgent !== agentName) {
      throw new Error(`Isolated session cannot access other agent directories. Allowed on master: agents/${agentName}/memory/`);
    }
  }

  throw new Error(`Isolated session can only access agents/${agentName}/memory/ on master.`);
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
  
  const session = await sessionManager.getExistingSession(sessionId);
  if (sessionManager.isSessionEffectivelyIsolated(session)) {
    throw new Error(`Isolated session cannot use ${operation} tool.`);
  }
}

/**
 * Check if isolated session can send to a specific channel
 * @param sessionIdOrCtx Session ID or ToolContext
 * @param channelId Target channel ID (platform:userId)
 * @throws Error if not allowed
 */
export async function checkChannelPermission(sessionIdOrCtx: string | { sessionId?: string }, channelId: string): Promise<void> {
  const sessionId = typeof sessionIdOrCtx === 'string' ? sessionIdOrCtx : sessionIdOrCtx.sessionId;
  if (!sessionId) return;
  
  const session = await sessionManager.getExistingSession(sessionId);
  if (!sessionManager.isSessionEffectivelyIsolated(session)) return;

  const attachedChannels = sessionManager.getChannelsBySession(sessionId);
  const attachedChannelIds = attachedChannels.map(ch => `${ch.platform}:${ch.channelUserId}`);
  
  if (!attachedChannelIds.includes(channelId)) {
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
  options: { channelId?: string; targetSessionId?: string }
): Promise<void> {
  const sessionId = typeof sessionIdOrCtx === 'string' ? sessionIdOrCtx : sessionIdOrCtx.sessionId;
  if (!sessionId) return;

  const session = await sessionManager.getExistingSession(sessionId);
  if (!sessionManager.isSessionEffectivelyIsolated(session)) return;

  if (options.channelId) {
    await checkChannelPermission(sessionId, options.channelId);
  }

  if (options.targetSessionId && options.targetSessionId !== sessionId) {
    throw new Error('Isolated session can only send files via its own current session attachments.');
  }
}

/**
 * Check whether an isolated session may manage a timer.
 * Isolated sessions may only manage timers for the current session and may not
 * use timer options that create or target new sessions/agents.
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

  const session = await sessionManager.getExistingSession(sessionId);
  if (!sessionManager.isSessionEffectivelyIsolated(session)) return;

  const targetSessionId = options.targetSessionId || sessionId;
  if (targetSessionId !== sessionId) {
    throw new Error('Isolated session can only manage timers for its own current session.');
  }

  const hasAgentName = typeof options.agentName === 'string' && options.agentName.trim().length > 0;
  const hasSessionPrefix = typeof options.sessionPrefix === 'string' && options.sessionPrefix.trim().length > 0;
  if (options.newSession === true || hasAgentName || hasSessionPrefix) {
    throw new Error('Isolated session timers can only target the current session; new-session/agent/prefix options are not allowed.');
  }
}