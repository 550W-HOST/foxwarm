import fs from 'fs-extra';
import { getSessionHistoryFilePath } from './metadataStore';
import { AgentMetadata } from './agentMetadata';
import { MessagePart, QueueItem, Session } from '../types';

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
    const historyData = await fs.readJson(historyFile);
    await fs.writeJson(historyFile, { ...historyData, ...updates }, { spaces: 2 });
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

export async function sendToSession(
  deps: Pick<SessionRelationsDeps, 'getExistingSession' | 'getAgentMetadata' | 'enqueueSessionItem'>,
  targetSessionId: string,
  message: string,
  fromSessionId?: string
): Promise<void> {
  const fromSession = fromSessionId ? await deps.getExistingSession(fromSessionId) : undefined;
  if (fromSessionId && !fromSession) {
    throw new Error(`Session "${fromSessionId}" not found.`);
  }

  const targetSession = await checkIsolatedPermission(deps, fromSession, targetSessionId);

  const sourceAgentMeta = fromSession ? deps.getAgentMetadata(fromSession.agent || 'main') : undefined;
  const targetAgentMeta = deps.getAgentMetadata(targetSession.agent || 'main');

  if ((sourceAgentMeta?.isolated || targetAgentMeta.isolated) && fromSession && !isDirectSessionLink(fromSession, targetSession)) {
    throw new Error('Isolated sessions can only communicate with themselves or their direct parent/child sessions.');
  }

  const replyTarget = fromSessionId || 'unknown-session';
  const prefix = fromSessionId
    ? `[SYSTEM: The following message is an inter-agent message from another session, not from the direct user; source_session_id: \`${fromSessionId}\`; reply_via: send_to_session({sessionId: \`${replyTarget}\`, message: "..."}).]`
    : '[SYSTEM: The following message is system-delivered session content, not from the direct user.]';

  const combinedText = message
    ? `${prefix}\n${message}`
    : prefix;

  const parts: MessagePart[] = [{ text: combinedText }];

  await deps.enqueueSessionItem(targetSessionId, {
    type: 'intersession',
    parts,
  });
}