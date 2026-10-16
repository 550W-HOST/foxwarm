import path from 'path';
import { AGENTS_DIR, getAgentDir } from '../config';

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

