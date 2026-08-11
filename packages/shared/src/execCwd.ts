import fs from 'fs-extra';
import os from 'os';
import path from 'path';

export type ExecCwdSource = 'explicit' | 'session' | 'default';

export interface ResolveExecCwdOptions {
  cwd?: unknown;
  sessionCwd?: unknown;
  defaultCwd: string;
  nodeId?: string;
}

export interface ResolvedExecCwd {
  cwd: string;
  raw?: string;
  source: ExecCwdSource;
}

export function expandHomePath(filePath: string): string {
  if (filePath === '~') return os.homedir();
  if (filePath.startsWith('~/') || filePath.startsWith('~\\')) return path.join(os.homedir(), filePath.slice(2));
  return filePath;
}

export function resolveExecCwd(options: ResolveExecCwdOptions): ResolvedExecCwd {
  const explicit = typeof options.cwd === 'string' && options.cwd.trim().length > 0
    ? options.cwd.trim()
    : undefined;
  const session = typeof options.sessionCwd === 'string' && options.sessionCwd.trim().length > 0
    ? options.sessionCwd.trim()
    : undefined;

  const source: ExecCwdSource = explicit ? 'explicit' : (session ? 'session' : 'default');
  const raw = explicit || session;
  const base = session ? expandHomePath(session) : options.defaultCwd;
  const candidate = raw || options.defaultCwd;
  const expanded = expandHomePath(candidate);
  const cwd = path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(base, expanded);
  return { cwd, raw, source };
}

function formatNode(nodeId?: string): string {
  return nodeId && nodeId.trim().length > 0 ? ` on node \`${nodeId}\`` : '';
}

export function buildInvalidExecCwdMessage(resolved: ResolvedExecCwd, reason: string, nodeId?: string): string {
  const rawPart = resolved.raw ? ` Raw cwd: \`${resolved.raw}\`.` : '';
  return `Cannot start exec${formatNode(nodeId)}: working directory is invalid (${reason}). Source: ${resolved.source}.${rawPart} Resolved cwd: \`${resolved.cwd}\`.`;
}

export async function validateResolvedExecCwd(resolved: ResolvedExecCwd, nodeId?: string): Promise<ResolvedExecCwd> {
  let stats;
  try {
    stats = await fs.stat(resolved.cwd);
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      throw new Error(buildInvalidExecCwdMessage(resolved, 'path does not exist', nodeId));
    }
    if (err?.code === 'EACCES' || err?.code === 'EPERM') {
      throw new Error(buildInvalidExecCwdMessage(resolved, `path is not accessible: ${err.code}`, nodeId));
    }
    throw new Error(buildInvalidExecCwdMessage(resolved, err?.message || String(err), nodeId));
  }

  if (!stats.isDirectory()) {
    throw new Error(buildInvalidExecCwdMessage(resolved, 'path is not a directory', nodeId));
  }

  try {
    await fs.access(resolved.cwd, fs.constants.R_OK | fs.constants.X_OK);
  } catch (err: any) {
    throw new Error(buildInvalidExecCwdMessage(resolved, `directory is not accessible: ${err?.code || err?.message || err}`, nodeId));
  }

  return resolved;
}

export async function resolveValidatedExecCwd(options: ResolveExecCwdOptions): Promise<ResolvedExecCwd> {
  return await validateResolvedExecCwd(resolveExecCwd(options), options.nodeId);
}
