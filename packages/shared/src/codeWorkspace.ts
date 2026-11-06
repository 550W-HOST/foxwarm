import { isCoreNodeId } from './nodeIdentity';

export function codeWorkspaceFilename(nodeId: string): string {
  if (!isCoreNodeId(nodeId)) throw new Error('Invalid Code Node identity.');
  return `node-${encodeURIComponent(nodeId)}.code-workspace`;
}

/** Read the Node identity even when its persisted workspace has no folder roots. */
export function codeWorkspaceNode(path: string): string | undefined {
  const name = path.split('/').pop() || '';
  if (!name.startsWith('node-') || !name.endsWith('.code-workspace')) return undefined;
  try {
    const nodeId = decodeURIComponent(name.slice(5, -'.code-workspace'.length));
    return isCoreNodeId(nodeId) ? nodeId : undefined;
  } catch { return undefined; }
}
