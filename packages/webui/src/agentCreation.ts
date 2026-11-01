export type SessionRuntimeKind = 'foxwarm' | 'claude-code'

export type AgentSummary = {
  id: string
  inherit?: string | null
  isolated?: boolean
  isolatedNode?: string | null
  defaultNode?: string | null
  defaultCwd?: string | null
}

/** Mutable Agent settings as sent to the Agent API; null clears a setting. */
export type AgentSettingsChanges = {
  inheritAgent: string | null
  defaultNode: string | null
  defaultCwd: string | null
  isolatedNode: string | null
}

/** Creation sends only the settings that were chosen. */
export function buildAgentCreationBody(agentId: string, settings?: Partial<AgentSettingsChanges>): { agentId: string } & Partial<Record<keyof AgentSettingsChanges, string>> {
  const body: { agentId: string } & Partial<Record<keyof AgentSettingsChanges, string>> = { agentId: agentId.trim() }
  for (const key of ['inheritAgent', 'defaultNode', 'defaultCwd', 'isolatedNode'] as const) {
    const value = settings?.[key]?.trim()
    if (value) body[key] = value
  }
  return body
}

/**
 * Where a new Session of this Agent starts according to its saved settings: the isolation
 * Node, else the default Node (Main when unset). The working directory applies only on the
 * default Node. Null when the Agent has no placement settings.
 */
export function agentStartLocation(agent: AgentSummary | undefined): { node: string; cwd: string | null } | null {
  if (!agent || !(agent.isolatedNode || agent.defaultNode || agent.defaultCwd)) return null
  const node = agent.isolatedNode || agent.defaultNode || 'master'
  return { node, cwd: agent.defaultCwd && node === (agent.defaultNode || 'master') ? agent.defaultCwd : null }
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
