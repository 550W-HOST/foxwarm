export interface SessionRelationRecord {
  id: string
  parentSessionId?: string | null
  aliases?: string[]
}

export function getCanonicalSessionDescendantIds(
  sessions: SessionRelationRecord[],
  rootSessionId: string,
): string[] {
  const aliases = new Map<string, string>()
  for (const session of sessions) {
    aliases.set(session.id, session.id)
    for (const alias of session.aliases || []) aliases.set(alias, session.id)
  }

  const canonicalRootId = aliases.get(rootSessionId) || rootSessionId
  const children = new Map<string, string[]>()
  for (const session of sessions) {
    if (!session.parentSessionId) continue
    const parentSessionId = aliases.get(session.parentSessionId) || session.parentSessionId
    const childIds = children.get(parentSessionId) || []
    childIds.push(session.id)
    children.set(parentSessionId, childIds)
  }

  const visiting = new Set<string>()
  const visited = new Set<string>()
  const descendants: string[] = []
  const visit = (sessionId: string, include: boolean) => {
    if (visiting.has(sessionId)) {
      throw new Error(`Session relation cycle detected beneath "${canonicalRootId}".`)
    }
    if (visited.has(sessionId)) return
    visiting.add(sessionId)
    if (include) descendants.push(sessionId)
    for (const childSessionId of children.get(sessionId) || []) visit(childSessionId, true)
    visiting.delete(sessionId)
    visited.add(sessionId)
  }

  visit(canonicalRootId, false)
  return descendants
}