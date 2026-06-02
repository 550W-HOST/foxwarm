/**
 * Shared path resolution utilities used by tools, toolscript, and node file transfer.
 */

import os from 'os';
import path from 'path';
import { getAgentDir } from '../config';

/**
 * Expand `~` or `~/...` to the user's home directory.
 */
export function expandHomePath(filePath: string): string {
  if (filePath === '~') {
    return os.homedir();
  }
  if (filePath.startsWith('~/') || filePath.startsWith('~\\')) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}

/**
 * Resolve a file path relative to an agent's directory (or session cwd if set).
 * Absolute paths and `~/...` are resolved directly.
 */
export function resolveAgentPath(filePath: string, agentName: string = 'main', sessionCwd?: string): string {
  const expandedPath = expandHomePath(filePath);
  if (path.isAbsolute(expandedPath)) {
    return path.resolve(expandedPath);
  }

  const agentDir = getAgentDir(agentName);
  const baseDir = (typeof sessionCwd === 'string' && sessionCwd.trim().length > 0)
    ? expandHomePath(sessionCwd.trim())
    : agentDir;

  return path.resolve(baseDir, expandedPath);
}
