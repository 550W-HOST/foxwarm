import * as sessionManager from './sessionManager';
import { resolveSpecialSessionTargetId } from './session/relations';
import type { Session } from './types';
import type { ToolAuthorizationRequest, ToolAuthorizationSessionTarget } from './toolAuthorization';

const TIMER_TOOLS = new Set(['create_timer', 'list_timers', 'update_timer', 'delete_timer']);
const ARCHIVE_TOOLS = new Set(['get_archived_messages', 'get_archived_blocks']);
const SUPPORTED_TOOLS = new Set([
  'send_to_session', 'send_file', 'recall', 'get_session_messages',
  ...TIMER_TOOLS, ...ARCHIVE_TOOLS,
]);

export function supportsToolAuthorizationSessionTarget(toolName: string): boolean {
  return SUPPORTED_TOOLS.has(toolName);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
function canonicalParentSessionId(parentSessionId: string | undefined): string | undefined {
  return parentSessionId ? (sessionManager.getSessionCatalog(parentSessionId)?.id || parentSessionId) : undefined;
}

export function resolveToolAuthorizationSessionTargetRequest(
  source: Pick<Session, 'id' | 'agent' | 'parentSessionId'>,
  toolName: string,
  args: Record<string, any>,
): ToolAuthorizationSessionTarget | undefined {
  let requested = nonEmptyString(args.sessionId);
  if (toolName === 'send_to_session') {
    if (!requested) return undefined;
    try { requested = resolveSpecialSessionTargetId(requested, source as Session, source.id); }
    catch { return undefined; }
  } else if (toolName === 'send_file') {
    if (nonEmptyString(args.channelTargetId)) return undefined;
    requested ||= source.id;
  } else if (TIMER_TOOLS.has(toolName) || ARCHIVE_TOOLS.has(toolName)) {
    requested ||= source.id;
  } else if (toolName === 'recall') {
    if (!requested && nonEmptyString(args.vector_query) && args.scope !== 'current-session') return undefined;
    requested ||= source.id;
  } else if (toolName === 'get_session_messages') {
    if (!requested) return undefined;
  } else {
    return undefined;
  }
  const target = sessionManager.getSessionCatalog(requested);
  if (!target) return undefined;
  const parentSessionId = canonicalParentSessionId(target.parentSessionId);
  return {
    id: target.id,
    agent: target.agent || 'main',
    ...(parentSessionId ? { parentSessionId } : {}),
  };
}

export function populateToolAuthorizationSessionTargets(
  request: ToolAuthorizationRequest,
  source: Pick<Session, 'id' | 'agent' | 'parentSessionId'>,
): ToolAuthorizationRequest {
  request.sourceParentSessionId = canonicalParentSessionId(source.parentSessionId);
  request.sessionTargets = {
    sessionId: resolveToolAuthorizationSessionTargetRequest(source, request.tool.name, request.args),
  };
  return request;
}
