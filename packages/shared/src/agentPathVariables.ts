import path from 'path';

/** Expand only a leading Agent-owned path token; do not evaluate shell or process environment. */
export function expandAgentPathVariable(filePath: string, agentDir?: string): string {
  if (!filePath.startsWith('$')) return filePath;
  const slash = filePath.indexOf('/');
  const name = filePath.slice(1, slash < 0 ? undefined : slash);
  if (name !== 'fw_agentdir' && name !== 'fw_tmp') {
    throw new Error(`Unknown Agent path variable: $${name}`);
  }
  if (!agentDir) throw new Error(`Agent path variable $${name} is unavailable in this execution environment.`);
  const root = name === 'fw_tmp' ? path.join(agentDir, 'tmp') : agentDir;
  return slash < 0 ? root : path.join(root, filePath.slice(slash + 1));
}

/** Primitive providers have no Agent-directory contract or path namespace in Core. */
export function rejectUnsupportedAgentPathVariable(filePath: unknown): void {
  if (typeof filePath === 'string' && filePath.startsWith('$')) expandAgentPathVariable(filePath);
}
