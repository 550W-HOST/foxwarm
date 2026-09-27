import { promises as fsPromises } from 'fs';
import * as sessionManager from '../sessionManager';
import { checkPathAccess, checkToolPermissionForSession } from '../isolatedCheck';
import {
  installToolAuthorizationPolicyBytes,
  parseToolAuthorizationPolicyBytes,
  TOOL_AUTH_POLICY_LIMITS,
} from '../toolAuthorization';
import { resolveAgentPath } from '../utils/pathResolve';
import type { ToolArgs, ToolContext } from './helpers';

export async function tool_set_tool_rules(args: ToolArgs, ctx?: ToolContext): Promise<{ output: string }> {
  if (!ctx?.sessionId || !ctx.session || ctx.session.id !== ctx.sessionId) {
    throw new Error('set_tool_rules requires an authoritative current session context.');
  }
  if (!args || Object.keys(args).length !== 1 || typeof args.filePath !== 'string' || !args.filePath.trim()) {
    throw new Error('set_tool_rules requires exactly one non-empty filePath.');
  }
  if (Buffer.byteLength(args.filePath, 'utf8') > 4096) throw new Error('set_tool_rules filePath exceeds 4096 bytes.');

  const session = ctx.session;
  const agentName = session.agent || 'main';
  await checkToolPermissionForSession(session, { source: 'builtin', tool: 'set_tool_rules' }, 'master', { filePath: args.filePath });
  await checkToolPermissionForSession(session, { source: 'node', node: 'master', tool: 'read' }, 'master', { filePath: args.filePath });
  const candidatePath = resolveAgentPath(args.filePath.trim(), agentName, session.cwd);
  if (sessionManager.isSessionEffectivelyIsolated(session)) checkPathAccess(candidatePath, agentName);

  const handle = await fsPromises.open(candidatePath, 'r');
  let bytes: Buffer;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('set_tool_rules candidate must be a regular file.');
    if (stat.size > TOOL_AUTH_POLICY_LIMITS.maxPolicyBytes) {
      throw new Error(`set_tool_rules candidate exceeds ${TOOL_AUTH_POLICY_LIMITS.maxPolicyBytes} bytes.`);
    }
    bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead === 0) throw new Error('set_tool_rules candidate changed while being read.');
      offset += result.bytesRead;
    }
  } finally {
    await handle.close();
  }

  parseToolAuthorizationPolicyBytes(bytes);
  await installToolAuthorizationPolicyBytes(bytes);
  return { output: 'Tool authorization policy validated and atomically replaced.' };
}
