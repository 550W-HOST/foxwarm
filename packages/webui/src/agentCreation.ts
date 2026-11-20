export type SessionRuntimeKind = 'foxwarm' | 'claude-code'

export type AgentSummary = {
  id: string
  inherit?: string | null
  inheritable?: boolean
  defaultNode?: string | null
  defaultCwd?: string | null
}

/** Mutable Agent settings as sent to the Agent API; null clears a setting. */
export type AgentSettingsChanges = {
  inheritAgent: string | null
  defaultNode: string | null
  defaultCwd: string | null
}

/** Creation sends only the settings that were chosen. */
export function buildAgentCreationBody(agentId: string, settings?: Partial<AgentSettingsChanges>): { agentId: string } & Partial<Record<keyof AgentSettingsChanges, string>> {
  const body: { agentId: string } & Partial<Record<keyof AgentSettingsChanges, string>> = { agentId: agentId.trim() }
  for (const key of ['inheritAgent', 'defaultNode', 'defaultCwd'] as const) {
    const value = settings?.[key]?.trim()
    if (value) body[key] = value
  }
  return body
}

/**
 * Where a new Session of this Agent starts according to its saved settings: the default Node,
 * else the installation default (master when neither is set). The working directory applies
 * on that Node. Null when nothing chooses placement.
 */
export function agentStartLocation(agent: AgentSummary | undefined, installDefaultNode: string | null = null): { node: string; cwd: string | null } | null {
  const defaultNode = agent?.defaultNode || installDefaultNode
  if (!agent || !(defaultNode || agent.defaultCwd)) return null
  return { node: defaultNode || 'master', cwd: agent.defaultCwd || null }
}

export const RANDOM_SESSION_ID_PLACEHOLDER = 'Random ID (for example, 0712_ab123)'

export function validateAgentId(agentId: string): string | null {
  if (!agentId.trim()) return 'Agent ID is required.'
  if (!/^[a-zA-Z0-9_-]+$/.test(agentId.trim())) {
    return 'Use only letters, numbers, hyphens, and underscores.'
  }
  return null
}

export function validateSessionId(sessionId: string): string | null {
  if (sessionId.includes('/')) return 'Session ID cannot contain “/”.'
  return null
}

export function buildSessionCreationBody(agentId: string, sessionId: string, runtime: SessionRuntimeKind = 'foxwarm', parentSessionId?: string): { agentId: string; sessionId?: string; runtime?: SessionRuntimeKind; parentSessionId?: string } {
  const body: { agentId: string; sessionId?: string; runtime?: SessionRuntimeKind; parentSessionId?: string } = { agentId }
  if (runtime !== 'foxwarm') body.runtime = runtime
  const trimmed = sessionId.trim()
  if (trimmed) body.sessionId = trimmed
  if (parentSessionId) body.parentSessionId = parentSessionId
  return body
}
