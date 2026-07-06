import fs from 'fs-extra';
import { getSessionHistoryFilePath, getSessionHistoryStore } from './metadataStore';
import { AgentMetadata } from './agentMetadata';
import { MessagePart, QueueItem, Session } from '../types';
import { formatFoxwarmMessageClose, formatFoxwarmMessageOpen } from '../utils/promptWrappers';

type SessionRelationsDeps = {
  getExistingSession: (sessionId: string) => Promise<Session | null>;
  saveSession: (sessionId: string) => Promise<void>;
  saveSessionsMetadata: () => Promise<void>;
  enqueueSessionItem: (sessionId: string, item: QueueItem) => Promise<void>;
  getSessionsMap: () => Map<string, Session>;
  getAgentMetadata: (agentName: string) => AgentMetadata;
  notifySessionListUpdated: () => void;
};

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

export async function setSessionParent(
  deps: Pick<SessionRelationsDeps, 'getExistingSession' | 'saveSession' | 'saveSessionsMetadata' | 'notifySessionListUpdated'>,
  childSessionId: string,
  parentSessionId?: string
): Promise<{
  childSessionId: string;
  parentSessionId?: string;
  previousParentSessionId?: string;
}> {
  const childSession = await deps.getExistingSession(childSessionId);
  if (!childSession) {
    throw new Error(`Session "${childSessionId}" not found.`);
  }

  const realChildId = childSession.id;
  const previousParentSessionId = childSession.parentSessionId || undefined;

  let realParentId: string | undefined;
  if (parentSessionId) {
    const parentSession = await deps.getExistingSession(parentSessionId);
    if (!parentSession) {
      throw new Error(`Session "${parentSessionId}" not found.`);
    }

    realParentId = parentSession.id;
    if (realParentId === realChildId) {
      throw new Error('A session cannot be its own parent.');
    }
  }

  if (previousParentSessionId === realParentId) {
    return {
      childSessionId: realChildId,
      parentSessionId: realParentId,
      previousParentSessionId,
    };
  }

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
  deps: Pick<SessionRelationsDeps, 'getExistingSession' | 'getAgentMetadata'>,
  sourceSession: Session | undefined,
  targetSessionId: string
): Promise<Session> {
  const targetSession = await deps.getExistingSession(targetSessionId);
  if (!targetSession) {
    throw new Error(`Session "${targetSessionId}" not found.`);
  }

  if (!sourceSession) {
    return targetSession;
  }

  const sourceAgent = sourceSession.agent || 'main';
  const targetAgent = targetSession.agent || 'main';

  const sourceAgentMeta = deps.getAgentMetadata(sourceAgent);
  if (sourceAgentMeta.isolated && sourceAgent !== targetAgent) {
    throw new Error(`Agent "${sourceAgent}" is isolated and cannot operate on sessions in other agents.`);
  }

  const targetAgentMeta = deps.getAgentMetadata(targetAgent);
  if (targetAgentMeta.isolated && sourceAgent !== targetAgent) {
    throw new Error(`Agent "${targetAgent}" is isolated and cannot be accessed from other agents.`);
  }

  return targetSession;
}

export async function resolvePermittedSessionTarget(
  deps: Pick<SessionRelationsDeps, 'getExistingSession' | 'getAgentMetadata'>,
  targetSessionId: string,
  fromSessionId?: string,
): Promise<{ sourceSession?: Session; targetSession: Session; requestedTargetSessionId: string; resolvedTargetSessionId: string }> {
  const sourceSession = fromSessionId ? await deps.getExistingSession(fromSessionId) : undefined;
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
  deps: Pick<SessionRelationsDeps, 'getExistingSession' | 'getAgentMetadata' | 'enqueueSessionItem'>,
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
  const parts: MessagePart[] = [
    {
      system: sourceSessionId
        ? formatFoxwarmMessageOpen({
          type: 'inter-agent',
          sourceSessionId,
          replyTargetSessionId: replyTarget,
          replyVia: 'send_to_session',
          hint: 'inter-agent message from another session, not direct end-user input',
        })
        : formatFoxwarmMessageOpen({
          type: 'system-delivered',
          hint: 'system-delivered session content, not direct end-user input',
        }),
    },
  ];
  if (message) {
    parts.push({ text: message });
  }
  parts.push({ system: formatFoxwarmMessageClose() });

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
