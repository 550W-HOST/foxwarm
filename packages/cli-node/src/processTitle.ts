export function formatNodeProcessTitle(nodeId?: string): string {
  const normalizedNodeId = nodeId?.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return normalizedNodeId ? `foxwarm:node ${normalizedNodeId}` : 'foxwarm:node';
}

export function setNodeProcessTitle(nodeId?: string): void {
  process.title = formatNodeProcessTitle(nodeId);
}