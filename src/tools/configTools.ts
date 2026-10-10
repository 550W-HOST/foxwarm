import { promises as fsPromises } from 'fs';
import * as sessionManager from '../sessionManager';
import { checkPathAccess, checkToolPermissionForSession } from '../isolatedCheck';
import { TOOL_AUTH_POLICY_LIMITS } from '../toolAuthorization';
import { configInstaller, ConfigCandidateError, type ConfigTarget } from '../configInstaller';
import { resolveAgentPath } from '../utils/pathResolve';
import type { ToolArgs, ToolContext } from './helpers';

export async function tool_set_config(args: ToolArgs, ctx?: ToolContext): Promise<{ output: string }> {
  if (!ctx?.sessionId || !ctx.session || ctx.session.id !== ctx.sessionId) {
    throw new Error('set_config requires an authoritative current session context.');
  }
  if (!args || Object.keys(args).length !== 2 || !['config', 'models', 'tool-rules'].includes(args.target) || typeof args.filePath !== 'string' || !args.filePath.trim()) {
    throw new Error('set_config requires target (config, models, or tool-rules) and one non-empty filePath.');
  }
  if (Buffer.byteLength(args.filePath, 'utf8') > 4096) throw new Error('set_config filePath exceeds 4096 bytes.');

  const session = ctx.session;
  const agentName = session.agent || 'main';
  const authorize = async () => {
    await checkToolPermissionForSession(session, { source: 'builtin', tool: 'set_config' }, 'master', args);
    await checkToolPermissionForSession(session, { source: 'node', node: 'master', tool: 'read' }, 'master', { filePath: args.filePath });
  };
  await authorize();
  const candidatePath = resolveAgentPath(args.filePath.trim(), agentName, session.cwd);
  if (sessionManager.isSessionEffectivelyIsolated(session)) checkPathAccess(candidatePath, agentName);

  const handle = await fsPromises.open(candidatePath, 'r');
  let bytes: Buffer;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('set_config candidate must be a regular file.');
    if (args.target === 'tool-rules' && stat.size > TOOL_AUTH_POLICY_LIMITS.maxPolicyBytes) {
      throw new Error(`set_config candidate exceeds ${TOOL_AUTH_POLICY_LIMITS.maxPolicyBytes} bytes.`);
    }
    bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead === 0) throw new Error('set_config candidate changed while being read.');
      offset += result.bytesRead;
    }
  } finally {
    await handle.close();
  }

  try {
    const result = await configInstaller.install(args.target as ConfigTarget, bytes, authorize);
    return { output: JSON.stringify({ saved: result.saved, target: result.target,
      applied: result.applied, notApplied: result.notApplied, restartRequired: result.restartRequired }) };
  } catch (error) {
    if (error instanceof ConfigCandidateError) throw new Error(`Invalid ${args.target} YAML candidate. The active file was not changed.`);
    throw error;
  }
}
