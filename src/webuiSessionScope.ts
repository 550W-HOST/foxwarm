import { webUiScopeAgent } from './accessConfig';

export type WebUiScopeSession = { id: string; agent?: string };
export type WebUiScopeResolver = (sessionId: string) => WebUiScopeSession | undefined;

/** Resolve aliases before comparing exact bindings or current Agent ownership. */
export function webUiSessionScopeAllows(
  bindings: readonly string[],
  requestedId: string,
  resolve: WebUiScopeResolver,
): boolean {
  const session = resolve(requestedId);
  if (!session) return false;
  return bindings.some(binding => {
    const agent = webUiScopeAgent(binding);
    return agent !== undefined ? session.agent === agent : resolve(binding)?.id === session.id;
  });
}

/** Project current canonical IDs without storing a login-time scope snapshot. */
export function projectWebUiSessionScope(
  bindings: readonly string[],
  resolve: WebUiScopeResolver,
  listAgent: (agent: string) => WebUiScopeSession[],
): string[] {
  return [...new Set(bindings.flatMap(binding => {
    const agent = webUiScopeAgent(binding);
    if (agent !== undefined) return listAgent(agent).filter(session => session.agent === agent).map(session => session.id);
    const session = resolve(binding);
    return session ? [session.id] : [];
  }))];
}
