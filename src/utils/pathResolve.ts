/**
 * Shared path resolution utilities used by tools, toolscript, and node file transfer.
 */

import os from 'os';
import path from 'path';
import fs from 'fs-extra';
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

/**
 * Canonicalize an existing path through realpath. For a not-yet-existing path,
 * canonicalize its nearest existing ancestor and append the missing suffix.
 * This closes static symlink-prefix escapes but is not an OS-level race-proof handle.
 */
export function canonicalPotentialPathSync(filePath: string): string {
  const seenSymlinks = new Set<string>();
  const entryExists = (candidate: string): boolean => {
    try { fs.lstatSync(candidate); return true; }
    catch (error: any) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false;
      throw error;
    }
  };
  const canonicalize = (candidate: string): string => {
    let current = path.resolve(candidate);
    const suffix: string[] = [];
    while (!entryExists(current)) {
      const parent = path.dirname(current);
      if (parent === current) break;
      suffix.unshift(path.basename(current));
      current = parent;
    }
    let base = current;
    if (entryExists(current)) {
      try { base = fs.realpathSync(current); }
      catch (error: any) {
        const stat = fs.lstatSync(current);
        if (!stat.isSymbolicLink()) throw error;
        if (seenSymlinks.has(current)) throw new Error('Symlink cycle encountered while canonicalizing path.');
        seenSymlinks.add(current);
        const target = fs.readlinkSync(current);
        base = canonicalize(path.resolve(path.dirname(current), target));
      }
    }
    return path.join(base, ...suffix);
  };
  return canonicalize(filePath);
}
