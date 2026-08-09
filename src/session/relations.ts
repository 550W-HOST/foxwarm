import fs from 'fs-extra';
import { getSessionHistoryFilePath, getSessionHistoryStore } from './metadataStore';
import { AgentMetadata } from './agentMetadata';
import { MessagePart, QueueItem, Session } from '../types';
import { formatFoxwarmMessage } from '../utils/promptWrappers';
import { formatLocalTimestamp } from '../utils/localTime';

type SessionRelationsDeps = {
  getExistingSession: (sessionId: string) => Promise<Session | null>;
  /** Catalog-only lookup for relation/permission operations. */
  getSessionCatalog?: (sessionId: string) => Session | undefined;
  saveSession: (sessionId: string) => Promise<void>;
  saveSessionsMetadata: () => Promise<void>;
  enqueueSessionItem: (sessionId: string, item: QueueItem) => Promise<void>;
  getSessionsMap: () => Map<string, Session>;
  getAgentMetadata: (agentName: string) => AgentMetadata;
  notifySessionListUpdated: () => void;
  assertMutationAllowed: (sessionIds: Array<string | undefined>, operation: string) => void;
};

function getSessionForRelation(deps: Pick<SessionRelationsDeps, 'getExistingSession' | 'getSessionCatalog'>, sessionId: string): Promise<Session | null> {
  if (deps.getSessionCatalog) return Promise.resolve(deps.getSessionCatalog(sessionId) || null);
  return deps.getExistingSession(sessionId);
}

async function persistSessionMetadataUpdate(
  deps: Pick<SessionRelationsDeps, 'saveSession'>,
  sessionId: string,
  updates: Partial<Session>
): Promise<void> {
  const historyFile = getSessionHistoryFilePath(sessionId);

  if (await fs.pathExists(historyFile)) {
    const historyData = await getSessionHistoryStore(sessionId).readFromPath(historyFile);
    await getSessionHistoryStore(sessionId).write({ ...(historyData || {}), ...updates });
    return;
  }

  await deps.saveSession(sessionId);
}

export function getChildSessionIds(sessions: Map<string, Session>, parentSessionId: string): string[] {
  return Array.from(sessions.entries())
    .filter(([, session]) => session.parentSessionId === parentSessionId)
    .map(([sessionId]) => sessionId);
}

export class SessionRelationCycleError extends Error {
  readonly code = 'SESSION_RELATION_CYCLE';

  constructor(sessionId: string) {
    super(`Session relation cycle detected while traversing descendants of "${sessionId}".`);
    this.name = 'SessionRelationCycleError';
  }
}

function buildCanonicalChildMap(sessions: Map<string, Session>): {
  aliases: Map<string, string>;
  children: Map<string, string[]>;
} {
  const aliases = new Map<string, string>();
  for (const [sessionId, session] of sessions) {
    aliases.set(sessionId, sessionId);
    for (const alias of session.aliases || []) aliases.set(alias, sessionId);
  }

  const children = new Map<string, string[]>();
  for (const [sessionId, session] of sessions) {
    if (!session.parentSessionId) continue;
    const parentSessionId = aliases.get(session.parentSessionId) || session.parentSessionId;
    const siblings = children.get(parentSessionId) || [];
    siblings.push(sessionId);
    children.set(parentSessionId, siblings);
  }
  for (const siblingIds of children.values()) siblingIds.sort((a, b) => a.localeCompare(b));
  return { aliases, children };
}

export function getCanonicalChildSessionIds(sessions: Map<string, Session>, parentSessionId: string): string[] {
  const { aliases, children } = buildCanonicalChildMap(sessions);
  const canonicalParentId = aliases.get(parentSessionId) || parentSessionId;
  return [...(children.get(canonicalParentId) || [])];
}

/**
 * Collect the canonical live subtree beneath one session. Parent aliases are
 * normalized so lifecycle actions use the same logical relation graph as the
 * session list rather than its filtered/pinned presentation tree.
 */
export function collectSessionDescendants(
  sessions: Map<string, Session>,
  rootSessionId: string,
): { descendantIds: string[]; directChildIds: string[]; postOrderIds: string[] } {
  const { aliases, children } = buildCanonicalChildMap(sessions);
  const canonicalRootId = aliases.get(rootSessionId) || rootSessionId;
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const descendantIds: string[] = [];
  const postOrderIds: string[] = [];

  const visit = (sessionId: string, includeInDescendants: boolean): void => {
    if (visiting.has(sessionId)) throw new SessionRelationCycleError(canonicalRootId);
    if (visited.has(sessionId)) return;
    visiting.add(sessionId);
    if (includeInDescendants) descendantIds.push(sessionId);
    for (const childSessionId of children.get(sessionId) || []) {
      visit(childSessionId, true);
    }
    visiting.delete(sessionId);
    visited.add(sessionId);
    postOrderIds.push(sessionId);
  };

  visit(canonicalRootId, false);
  return {
    descendantIds,
    directChildIds: [...(children.get(canonicalRootId) || [])],
    postOrderIds,
  };
}

async function assertNoParentCycle(
  deps: Pick<SessionRelationsDeps, 'getExistingSession'>,
  childSessionId: string,
  parentSessionId?: string,
): Promise<void> {
  if (!parentSessionId) return;

  if (childSessionId === parentSessionId) {
    throw new Error('A session cannot be its own parent.');
  }

  const seen = new Set<string>([childSessionId]);
  let cursorParentId: string | undefined = parentSessionId;

  while (cursorParentId) {
    const cursorParent = await deps.getExistingSession(cursorParentId);
    if (!cursorParent) break;
    const canonicalCursorId = cursorParent.id;
    if (seen.has(canonicalCursorId)) {
      throw new Error(`Session "${childSessionId}" cannot be moved under descendant "${parentSessionId}" because that would create a parent cycle.`);
    }

    seen.add(canonicalCursorId);
    cursorParentId = cursorParent.parentSessionId || undefined;
  }
}

export async function resolveSessionParentId(
  deps: Pick<SessionRelationsDeps, 'getExistingSession'>,
  childSessionId: string,
  parentSessionId?: string,
): Promise<{ childSession: Session; parentSessionId?: string }> {
  const childSession = await deps.getExistingSession(childSessionId);
  if (!childSession) throw new Error(`Session "${childSessionId}" not found.`);

  if (!parentSessionId) return { childSession };
  const parentSession = await deps.getExistingSession(parentSessionId);
  if (!parentSession) throw new Error(`Session "${parentSessionId}" not found.`);
  if (parentSession.id === childSession.id) throw new Error('A session cannot be its own parent.');
  await assertNoParentCycle(deps, childSession.id, parentSession.id);
  return { childSession, parentSessionId: parentSession.id };
}

export async function setSessionParent(
  deps: Pick<SessionRelationsDeps, 'getExistingSession' | 'saveSession' | 'saveSessionsMetadata' | 'notifySessionListUpdated'> & Partial<Pick<SessionRelationsDeps, 'assertMutationAllowed'>>,
  childSessionId: string,
  parentSessionId?: string
): Promise<{
  childSessionId: string;
  parentSessionId?: string;
  previousParentSessionId?: string;
}> {
  const resolved = await resolveSessionParentId(deps, childSessionId, parentSessionId);
  const childSession = resolved.childSession;

  const realChildId = childSession.id;
  const previousParentSessionId = childSession.parentSessionId || undefined;
  const realParentId = resolved.parentSessionId;

  if (previousParentSessionId === realParentId) {
    return {
      childSessionId: realChildId,
      parentSessionId: realParentId,
      previousParentSessionId,
    };
  }

  deps.assertMutationAllowed?.([realChildId, realParentId], realParentId ? 'change parent relations' : 'detach from its parent');
  childSession.parentSessionId = realParentId;
  await persistSessionMetadataUpdate(deps, realChildId, { parentSessionId: realParentId });
  await deps.saveSessionsMetadata();
  deps.notifySessionListUpdated();

  return {
    childSessionId: realChildId,
    parentSessionId: realParentId,
    previousParentSessionId,
  };
}

export async function updateChildSessionParentIds(
  deps: Pick<SessionRelationsDeps, 'saveSession' | 'saveSessionsMetadata' | 'getSessionsMap' | 'notifySessionListUpdated'>,
  oldParentSessionId: string,
  newParentSessionId: string
): Promise<string[]> {
  const updatedChildIds: string[] = [];

  for (const [sessionId, session] of deps.getSessionsMap().entries()) {
    if (session.parentSessionId !== oldParentSessionId) {
      continue;
    }

    session.parentSessionId = newParentSessionId;
    await persistSessionMetadataUpdate(deps, sessionId, { parentSessionId: newParentSessionId });
    updatedChildIds.push(sessionId);
  }

  if (updatedChildIds.length > 0) {
    await deps.saveSessionsMetadata();
    deps.notifySessionListUpdated();
  }

  return updatedChildIds;
}

function isDirectSessionLink(a: Session | undefined, b: Session | undefined): boolean {
  if (!a || !b) return false;
  if (a.id === b.id) return true;
  if (a.parentSessionId === b.id || b.parentSessionId === a.id) return true;
  return false;
}

async function checkIsolatedPermission(
  deps: Pick<SessionRelationsDeps, 'getExistingSession' | 'getSessionCatalog' | 'getAgentMetadata'>,
  sourceSession: Session | undefined,
  targetSessionId: string
): Promise<Session> {
  const targetSession = await getSessionForRelation(deps, targetSessionId);
  if (!targetSession) {
    throw new Error(`Session "${targetSessionId}" not found.`);
  }

  if (!sourceSession) {
    return targetSession;
  }

  const sourceAgent = sourceSession.agent || 'main';
  const targetAgent = targetSession.agent || 'main';

  const sourceAgentMeta = deps.getAgentMetadata(sourceAgent);
  const targetAgentMeta = deps.getAgentMetadata(targetAgent);

  if ((sourceAgentMeta.isolated || targetAgentMeta.isolated) && isDirectSessionLink(sourceSession, targetSession)) {
    return targetSession;
  }

  if (sourceAgentMeta.isolated && sourceAgent !== targetAgent) {
    throw new Error(`Agent "${sourceAgent}" is isolated and cannot operate on sessions in other agents.`);
  }

  if (targetAgentMeta.isolated && sourceAgent !== targetAgent) {
    throw new Error(`Agent "${targetAgent}" is isolated and cannot be accessed from other agents.`);
  }

  return targetSession;
}

export async function resolvePermittedSessionTarget(
  deps: Pick<SessionRelationsDeps, 'getExistingSession' | 'getSessionCatalog' | 'getAgentMetadata'>,
  targetSessionId: string,
  fromSessionId?: string,
): Promise<{ sourceSession?: Session; targetSession: Session; requestedTargetSessionId: string; resolvedTargetSessionId: string }> {
  const sourceSession = fromSessionId ? await getSessionForRelation(deps, fromSessionId) : undefined;
  if (fromSessionId && !sourceSession) {
    throw new Error(`Session "${fromSessionId}" not found.`);
  }

  const requestedTargetSessionId = targetSessionId;
  const resolvedTargetSessionId = resolveSpecialSessionTargetId(requestedTargetSessionId, sourceSession, fromSessionId);
  const targetSession = await checkIsolatedPermission(deps, sourceSession, resolvedTargetSessionId);

  const sourceAgentMeta = sourceSession ? deps.getAgentMetadata(sourceSession.agent || 'main') : undefined;
  const targetAgentMeta = deps.getAgentMetadata(targetSession.agent || 'main');

  if ((sourceAgentMeta?.isolated || targetAgentMeta.isolated) && sourceSession && !isDirectSessionLink(sourceSession, targetSession)) {
    throw new Error('Isolated sessions can only communicate with themselves or their direct parent/child sessions.');
  }

  return { sourceSession, targetSession, requestedTargetSessionId, resolvedTargetSessionId: targetSession.id };
}

function buildAgentMainSessionId(agentName: string): string {
  return agentName === 'main' ? 'main' : `${agentName}/main`;
}

function resolveSpecialSessionTargetId(targetSessionId: string, sourceSession?: Session, fromSessionId?: string): string {
  if (targetSessionId === '<main>') {
    if (!sourceSession) {
      throw new Error('Cannot resolve `<main>` without current session context.');
    }
    return buildAgentMainSessionId(sourceSession.agent || 'main');
  }

  if (targetSessionId === '<parent>') {
    if (!sourceSession) {
      throw new Error('Cannot resolve `<parent>` without current session context.');
    }
    if (!sourceSession.parentSessionId) {
      throw new Error(`Cannot resolve \`<parent>\`: current session \`${sourceSession.id || fromSessionId || 'unknown'}\` has no parent session.`);
    }
    return sourceSession.parentSessionId;
  }

  return targetSessionId;
}

export async function sendToSession(
  deps: Pick<SessionRelationsDeps, 'getExistingSession' | 'getSessionCatalog' | 'getAgentMetadata' | 'enqueueSessionItem'>,
  targetSessionId: string,
  message: string,
  fromSessionId?: string
): Promise<{ requestedSessionId: string; resolvedSessionId: string }> {
  const { sourceSession: fromSession, targetSession, requestedTargetSessionId } = await resolvePermittedSessionTarget(deps, targetSessionId, fromSessionId);
  if (fromSession && fromSession.id === targetSession.id) {
    throw new Error(`send_to_session target resolves to this same session: current_session_id=\`${fromSession.id}\`, requested_session_id=\`${requestedTargetSessionId}\`, resolved_session_id=\`${targetSession.id}\`. You are already in this session; check whether you meant to send to a parent/child/other session. If you meant to message the direct user in the current session rather than another agent, do not use send_to_session; generate ordinary assistant text instead.`);
  }

  const sourceSessionId = fromSession?.id || fromSessionId;
  const replyTarget = sourceSessionId || 'unknown-session';
  const time = formatLocalTimestamp(Date.now());
  const parts: MessagePart[] = [{
    system: sourceSessionId
      ? formatFoxwarmMessage({
        type: 'inter-agent',
        sourceSessionId,
        replyTargetSessionId: replyTarget,
        replyVia: 'send_to_session',
        time,
        hint: 'inter-agent message from another session, not direct end-user input',
      }, message || '')
      : formatFoxwarmMessage({
        type: 'system-delivered',
        time,
        hint: 'system-delivered session content, not direct end-user input',
      }, message || ''),
  }];

  await deps.enqueueSessionItem(targetSession.id, {
    type: 'intersession',
    sourceSessionId: fromSession?.id,
    parts,
  });

  return {
    requestedSessionId: requestedTargetSessionId,
    resolvedSessionId: targetSession.id,
  };
}
