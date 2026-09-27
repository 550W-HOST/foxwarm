export type LauncherDraft = {
  nodeId: string
  path: string
}

export function selectLauncherDraftNode<T extends LauncherDraft>(draft: T, nodeId: string): T {
  if (nodeId === draft.nodeId) return draft
  return { ...draft, nodeId, path: '/' }
}
