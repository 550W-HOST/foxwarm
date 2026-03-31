import fs from 'fs-extra';
import * as llm from '../llm';
import { logger } from '../common';
import { AGENTS_FILE, getAgentDir } from '../config';
import { getSkillInfo, validateSkillName } from '../skills';
import { Session } from '../types';

export interface AgentMetadata {
  isolated?: boolean;
  isolatedNode?: string;
  inherit?: string;
  skills?: string[];
  [key: string]: any;
}

type AgentMetadataDeps = {
  getSession: (sessionId: string) => Promise<Session>;
  getExistingSession: (sessionId: string) => Promise<Session | null>;
  saveSession: (sessionId: string) => Promise<void>;
  getSessionsMap: () => Map<string, Session>;
  validateAgentName: (agentName: string) => void;
};

const agentMetadata = new Map<string, AgentMetadata>();

function normalizeAgentSkills(skills: unknown): string[] | undefined {
  if (!Array.isArray(skills)) {
    return undefined;
  }

  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const rawSkill of skills) {
    if (typeof rawSkill !== 'string') continue;
    const skillName = rawSkill.trim();
    if (!skillName) continue;

    try {
      validateSkillName(skillName);
    } catch (e) {
      logger.warn({ err: e, skillName }, 'Skipping invalid skill in agent metadata');
      continue;
    }

    if (seen.has(skillName)) continue;
    seen.add(skillName);
    normalized.push(skillName);
  }

  return normalized.length > 0 ? normalized : undefined;
}

function normalizeAgentMetadata(meta: AgentMetadata): AgentMetadata {
  const nextMeta = { ...meta };
  const normalizedSkills = normalizeAgentSkills(meta.skills);
  const isolatedNode = typeof meta.isolatedNode === 'string' && meta.isolatedNode.trim()
    ? meta.isolatedNode.trim()
    : undefined;
  if (normalizedSkills) nextMeta.skills = normalizedSkills;
  else delete nextMeta.skills;
  if (nextMeta.isolated) {
    if (isolatedNode) nextMeta.isolatedNode = isolatedNode;
  } else {
    delete nextMeta.isolatedNode;
  }
  return nextMeta;
}

async function saveAgentMetadata(): Promise<void> {
  const data: Record<string, AgentMetadata> = {};
  for (const [agentName, meta] of agentMetadata.entries()) {
    data[agentName] = meta;
  }
  await fs.writeJson(AGENTS_FILE, data, { spaces: 2 });
}

async function refreshDirectAgentSessions(deps: AgentMetadataDeps, agentName: string): Promise<string[]> {
  const affectedSessions: string[] = [];

  for (const [sessionId, sessionMeta] of deps.getSessionsMap().entries()) {
    const sessionAgent = sessionMeta.agent || 'main';
    if (sessionAgent !== agentName) continue;

    const session = await deps.getSession(sessionId);
    session.persistentMemorySnapshot = await llm.getPersistentMemory(session.agent || 'main');
    await deps.saveSession(sessionId);
    affectedSessions.push(sessionId);
  }

  return affectedSessions;
}

export async function loadAgentMetadata(): Promise<void> {
  agentMetadata.clear();
  if (await fs.pathExists(AGENTS_FILE)) {
    try {
      const data = await fs.readJson(AGENTS_FILE);
      for (const [agentName, meta] of Object.entries(data)) {
        agentMetadata.set(agentName, normalizeAgentMetadata(meta as AgentMetadata));
      }
      logger.info({ count: agentMetadata.size }, 'Agent metadata loaded');
    } catch (e) {
      logger.error({ err: e }, 'Failed to load agent metadata');
    }
  }
}

export function getAgentMetadata(agentName: string): AgentMetadata {
  return agentMetadata.get(agentName) || {};
}

export function getAgentIsolationNode(agentName: string): string | undefined {
  const meta = getAgentMetadata(agentName);
  if (!meta.isolated) return undefined;
  return typeof meta.isolatedNode === 'string' && meta.isolatedNode.trim()
    ? meta.isolatedNode.trim()
    : undefined;
}

export function isAgentIsolated(agentName: string): boolean {
  return !!getAgentMetadata(agentName).isolated;
}

export function isSessionEffectivelyIsolated(session?: Session | null): boolean {
  if (!session) return false;
  return isAgentIsolated(session.agent || 'main');
}

export async function setAgentMetadata(agentName: string, meta: AgentMetadata): Promise<void> {
  agentMetadata.set(agentName, normalizeAgentMetadata(meta));
  await saveAgentMetadata();
}

export function getAgentSkills(agentName: string): string[] {
  return [...(getAgentMetadata(agentName).skills || [])];
}

export async function refreshSessionSnapshot(deps: AgentMetadataDeps, sessionId: string): Promise<{ sessionId: string; agentName: string }> {
  const session = await deps.getExistingSession(sessionId);
  if (!session) {
    throw new Error(`Session "${sessionId}" not found.`);
  }

  const agentName = session.agent || 'main';
  session.persistentMemorySnapshot = await llm.getPersistentMemory(agentName);
  await deps.saveSession(session.id);

  return { sessionId: session.id, agentName };
}

export function getAgentInheritanceChain(agentName: string): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  let current: string | undefined = agentName;

  while (current) {
    if (seen.has(current)) {
      logger.warn({ agentName, current, chain }, 'Circular agent inheritance detected, stopping at first repeat');
      break;
    }

    seen.add(current);
    chain.unshift(current);
    current = getAgentMetadata(current).inherit;
  }

  return chain;
}

export async function setAgentInherit(deps: AgentMetadataDeps, agentName: string, inheritAgentName?: string): Promise<{ affectedSessions: string[] }> {
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
  for (const [sessionId, sessionMeta] of deps.getSessionsMap().entries()) {
    const sessionAgent = sessionMeta.agent || 'main';
    if (!getAgentInheritanceChain(sessionAgent).includes(agentName)) continue;

    const session = await deps.getSession(sessionId);
    session.persistentMemorySnapshot = await llm.getPersistentMemory(session.agent || 'main');
    await deps.saveSession(sessionId);
    affectedSessions.push(sessionId);
  }

  return { affectedSessions };
}

export async function setAgentIsolation(
  deps: AgentMetadataDeps,
  agentName: string,
  isolatedNode?: string,
): Promise<{ affectedSessions: string[]; isolated: boolean; node?: string }> {
  deps.validateAgentName(agentName);

  const agentDir = getAgentDir(agentName);
  if (!await fs.pathExists(agentDir)) {
    throw new Error(`Agent "${agentName}" does not exist.`);
  }

  const currentMeta = getAgentMetadata(agentName);
  const nextMeta = { ...currentMeta };
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
    await deps.saveSession(session.id);
    affectedSessions.push(session.id);
  }

  return { affectedSessions, isolated: !!normalizedNode, node: normalizedNode };
}

export async function attachAgentSkill(deps: AgentMetadataDeps, agentName: string, skillName: string): Promise<{ skills: string[]; affectedSessions: string[]; changed: boolean }> {
  deps.validateAgentName(agentName);
  validateSkillName(skillName);

  const agentDir = getAgentDir(agentName);
  if (!await fs.pathExists(agentDir)) {
    throw new Error(`Agent "${agentName}" does not exist.`);
  }

  await getSkillInfo(skillName, { agentName });

  const currentMeta = getAgentMetadata(agentName);
  const currentSkills = getAgentSkills(agentName);
  if (currentSkills.includes(skillName)) {
    return { skills: currentSkills, affectedSessions: [], changed: false };
  }

  const nextSkills = [...currentSkills, skillName];
  await setAgentMetadata(agentName, { ...currentMeta, skills: nextSkills });
  const affectedSessions = await refreshDirectAgentSessions(deps, agentName);

  return { skills: nextSkills, affectedSessions, changed: true };
}

export async function detachAgentSkill(deps: AgentMetadataDeps, agentName: string, skillName: string): Promise<{ skills: string[]; affectedSessions: string[]; changed: boolean }> {
  deps.validateAgentName(agentName);
  validateSkillName(skillName);

  const agentDir = getAgentDir(agentName);
  if (!await fs.pathExists(agentDir)) {
    throw new Error(`Agent "${agentName}" does not exist.`);
  }

  const currentMeta = getAgentMetadata(agentName);
  const currentSkills = getAgentSkills(agentName);
  const nextSkills = currentSkills.filter(existingSkill => existingSkill !== skillName);

  if (nextSkills.length === currentSkills.length) {
    return { skills: currentSkills, affectedSessions: [], changed: false };
  }

  await setAgentMetadata(agentName, { ...currentMeta, skills: nextSkills });
  const affectedSessions = await refreshDirectAgentSessions(deps, agentName);

  return { skills: nextSkills, affectedSessions, changed: true };
}
