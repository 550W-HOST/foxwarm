/**
 * Isolated Session Authorization Helper
 * Centralized authorization logic for isolated sessions
 */

import * as sessionManager from './sessionManager';
import { getAgentDir } from './config';
import * as path from 'path';

/**
 * Check if isolated session can use a specific tool
 * @param toolName Tool name
 * @param sessionId Session ID
 * @param nodeParam Optional node parameter from tool call
 * @param toolArgs Tool arguments (for path-based tools)
 * @throws Error if not allowed
 */
export async function checkToolPermission(
  toolName: string,
  sessionId: string,
  nodeParam?: string,
  toolArgs?: Record<string, any>
): Promise<void> {
  const session = await sessionManager.getExistingSession(sessionId);
  if (!session?.isolated) return;

  // Tools that isolated session can use
  const allowedTools = ['read', 'write', 'edit', 'apply_patch', 'exec', 'remote_node', 'send_to_session'];
  if (!allowedTools.includes(toolName)) {
    throw new Error(`Isolated session cannot use ${toolName} tool.`);
  }

  // For tools that support node parameter, check node permission
  const nodeDependentTools = ['read', 'write', 'edit', 'apply_patch', 'exec'];
  if (nodeDependentTools.includes(toolName) && nodeParam) {
    const currentNode = session.currentNode || 'master';
    
    // Isolated session can only use:
    // - master (for accessing agent-dir)
    // - its bound node (for local execution)
    const allowedNodes = ['master', currentNode];
    if (!allowedNodes.includes(nodeParam)) {
      throw new Error(`Isolated session cannot specify node "${nodeParam}". Allowed: master, ${currentNode}`);
    }
  }
  
  // Check path access for path-based tools on master
  if (nodeParam === 'master' && toolArgs?.filePath) {
    const fullPath = path.join(process.cwd(), 'agents', session.agent || 'main', toolArgs.filePath);
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
  const cwd = process.cwd();
  const agentDir = getAgentDir(agentName);
  const agentsDir = path.join(cwd, 'agents');

  const normalizedPath = path.normalize(fullPath);
  const normalizedAgentDir = path.normalize(agentDir);
  const normalizedAgentsDir = path.normalize(agentsDir);

  // Allow access only to current agent's directory (agents/{agentName}/)
  if (normalizedPath === normalizedAgentDir || normalizedPath.startsWith(normalizedAgentDir + path.sep)) {
    return;
  }

  // Block access to other agents or sensitive directories
  if (normalizedPath.startsWith(normalizedAgentsDir + path.sep)) {
    const relativePath = normalizedPath.slice(normalizedAgentsDir.length + 1);
    const targetAgent = relativePath.split(path.sep)[0];
    if (targetAgent && targetAgent !== agentName) {
      throw new Error(`Isolated session cannot access other agent directories. Allowed: agents/${agentName}/`);
    }
  }

  throw new Error(`Isolated session can only access agents/${agentName}/ directory.`);
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
  if (session?.isolated) {
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
  if (!session?.isolated) return;

  const attachedChannels = sessionManager.getChannelsBySession(sessionId);
  const attachedChannelIds = attachedChannels.map(ch => `${ch.platform}:${ch.channelUserId}`);
  
  if (!attachedChannelIds.includes(channelId)) {
    throw new Error('Isolated session can only send messages to its own attached channel.');
  }
}