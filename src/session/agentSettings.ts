import fs from 'fs-extra';
import { getAgentDir } from '../config';
import type { Session } from '../types';
import { normalizeAgentToolRules } from '../permissions';
import { getAgentMetadata, getAgentInheritanceChain, isAgentIsolated, setAgentMetadata } from './agentMetadata';
import { buildSessionSystemPromptSnapshotForSession } from './promptSnapshot';
import { shouldAutoRefreshSessionSnapshot } from './snapshotRefresh';

type AgentMetadataDeps = {
  getSession: (sessionId: string) => Promise<Session>;
  getExistingSession: (sessionId: string) => Promise<Session | null>;
  saveSession: (sessionId: string) => Promise<void>;
  getSessionsMap: () => Map<string, Session>;
  validateAgentName: (agentName: string) => void;
};

async function rebuildSessionSnapshotIfMaterialized(session: Session): Promise<boolean> {
  const snapshot = await buildSessionSystemPromptSnapshotForSession(session);
  if (snapshot === undefined) return false;
  session.persistentMemorySnapshot = snapshot;
  return true;
}

export async function refreshSessionSnapshot(deps: AgentMetadataDeps, sessionId: string): Promise<{ sessionId: string; agentName: string }> {
  const session = await deps.getExistingSession(sessionId);
  if (!session) {
    throw new Error(`Session "${sessionId}" not found.`);
  }

  return refreshSessionSnapshotForSession(session, () => deps.saveSession(session.id));
}

export async function refreshSessionSnapshotForSession(
  session: Session,
  persistSession: () => Promise<void>,
): Promise<{ sessionId: string; agentName: string }> {
  const agentName = session.agent || 'main';
  if (await rebuildSessionSnapshotIfMaterialized(session)) await persistSession();

  return { sessionId: session.id, agentName };
}

export async function setAgentInherit(
  deps: AgentMetadataDeps,
  agentName: string,
  inheritAgentName?: string,
  refreshSnapshots: boolean = false,
): Promise<{ affectedSessions: string[] }> {
  deps.validateAgentName(agentName);

  const agentDir = getAgentDir(agentName);
  if (!await fs.pathExists(agentDir)) {
    throw new Error(`Agent "${agentName}" does not exist.`);
  }

  if (inheritAgentName) {
    deps.validateAgentName(inheritAgentName);
    if (inheritAgentName === agentName) {
      throw new Error('Agent cannot inherit from itself.');
    }

    if (isAgentIsolated(inheritAgentName)) {
      throw new Error(`Agent "${inheritAgentName}" is isolated and cannot be used as an inherit source.`);
    }

    const inheritAgentDir = getAgentDir(inheritAgentName);
    if (!await fs.pathExists(inheritAgentDir)) {
      throw new Error(`Inherited agent "${inheritAgentName}" does not exist.`);
    }

    const parentChain = getAgentInheritanceChain(inheritAgentName);
    if (parentChain.includes(agentName)) {
      throw new Error(`Circular inheritance detected: "${agentName}" already appears in "${inheritAgentName}" inherit chain.`);
    }
  }

  const currentMeta = getAgentMetadata(agentName);
  const nextMeta = { ...currentMeta };
  if (inheritAgentName) nextMeta.inherit = inheritAgentName;
  else delete nextMeta.inherit;
  await setAgentMetadata(agentName, nextMeta);

  const affectedSessions: string[] = [];
  if (!refreshSnapshots) return { affectedSessions };
  const refreshStartedAt = Date.now();
  for (const [sessionId, sessionMeta] of deps.getSessionsMap().entries()) {
    const sessionAgent = sessionMeta.agent || 'main';
    if (!getAgentInheritanceChain(sessionAgent).includes(agentName)) continue;
    if (shouldAutoRefreshSessionSnapshot(sessionMeta, refreshStartedAt)) continue;

    const session = await deps.getSession(sessionId);
    if (await rebuildSessionSnapshotIfMaterialized(session)) await deps.saveSession(sessionId);
    affectedSessions.push(sessionId);
  }

  return { affectedSessions };
}

export async function setAgentIsolation(
  deps: AgentMetadataDeps,
  agentName: string,
  isolatedNode?: string,
  toolRules?: unknown,
): Promise<{ affectedSessions: string[]; isolated: boolean; node?: string; toolRuleCount: number }> {
  deps.validateAgentName(agentName);

  const agentDir = getAgentDir(agentName);
  if (!await fs.pathExists(agentDir)) {
    throw new Error(`Agent "${agentName}" does not exist.`);
  }

  const currentMeta = getAgentMetadata(agentName);
  const nextMeta = { ...currentMeta };
  if (toolRules !== undefined) nextMeta.toolRules = normalizeAgentToolRules(toolRules);
  const normalizedNode = isolatedNode && String(isolatedNode).trim()
    ? String(isolatedNode).trim()
    : undefined;

  if (normalizedNode) {
    if (normalizedNode === 'master') {
      throw new Error('Isolated agent must bind to a non-master node.');
    }
    nextMeta.isolated = true;
    nextMeta.isolatedNode = normalizedNode;
  } else {
    nextMeta.isolated = false;
    delete nextMeta.isolatedNode;
  }

  await setAgentMetadata(agentName, nextMeta);

  const affectedSessions: string[] = [];
  for (const [sessionId, sessionMeta] of deps.getSessionsMap().entries()) {
    const sessionAgent = sessionMeta.agent || 'main';
    if (sessionAgent !== agentName) continue;

    const session = await deps.getSession(sessionId);
    if (normalizedNode) {
      session.currentNode = normalizedNode;
    }
    await rebuildSessionSnapshotIfMaterialized(session);
    await deps.saveSession(session.id);
    affectedSessions.push(session.id);
  }

  return { affectedSessions, isolated: !!normalizedNode, node: normalizedNode, toolRuleCount: nextMeta.toolRules?.length || 0 };
}
