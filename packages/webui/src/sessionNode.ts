import type { SessionRuntimeState } from './sessionRuntimeState'

export interface SessionNodeLike {
  currentNode?: string
  runtimeState?: Pick<SessionRuntimeState, 'tool'> | null
}

/**
 * Effective execution node for a session: the node of the tool that is currently
 * running wins, then the session default node, then the built-in `master` node.
 * This mirrors the placement rule used by the Architecture view.
 */
export const getResolvedSessionNodeId = (session: SessionNodeLike): string => (
  session.runtimeState?.tool?.executionNode
  || session.currentNode
  || 'master'
)

/** True when the session resolves to an execution node other than `master`. */
export const isRemoteSessionNode = (session: SessionNodeLike): boolean => getResolvedSessionNodeId(session) !== 'master'
