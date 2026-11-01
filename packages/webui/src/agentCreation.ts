export type SessionRuntimeKind = 'foxwarm' | 'claude-code'

export type AgentSummary = {
  id: string
  inherit?: string | null
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
