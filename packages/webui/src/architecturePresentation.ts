export interface ArchitectureFocusReveal {
  identity: string
  ancestors: string[]
}

/**
 * Describe the one-shot disclosure needed to reveal the current session.
 * The current row itself is deliberately excluded: revealing a row never
 * implies opening that row's own descendants.
 */
export function getArchitectureFocusReveal(
  focusPathRootToCurrent: readonly string[],
  currentSession: string | undefined,
  revealedIdentity?: string | null,
): ArchitectureFocusReveal | null {
  if (!currentSession || focusPathRootToCurrent.at(-1) !== currentSession) return null

  const ancestors: string[] = []
  const seen = new Set<string>()
  for (const sessionId of focusPathRootToCurrent.slice(0, -1)) {
    if (!sessionId || sessionId === currentSession || seen.has(sessionId)) continue
    seen.add(sessionId)
    ancestors.push(sessionId)
  }

  const identity = JSON.stringify([currentSession, ...ancestors])
  return identity === revealedIdentity ? null : { identity, ancestors }
}