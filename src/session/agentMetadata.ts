import fs from 'fs-extra';
import * as llm from '../llm';
import { logger } from '../common';
import { AGENTS_FILE, getAgentDir } from '../config';
import { Session } from '../types';
import { DiskJsonData } from '../utils/diskJsonData';

function getSessionSystemPromptOptions(session: Session): { agentName: string; sessionId: string; systemPromptFiles?: string[] } {
  return {
    agentName: session.agent || 'main',
    sessionId: session.id,
    systemPromptFiles: session.systemPromptFiles,
  };
}

export interface AgentMetadata {
  isolated?: boolean;
  isolatedNode?: string;
  inherit?: string;
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

function normalizeAgentMetadataPayload(raw: any, filePath: string): Record<string, AgentMetadata> {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Invalid agent metadata payload in ${filePath}`);
  }
  return raw;
}

export function createAgentMetadataStore(filePath: string = AGENTS_FILE): DiskJsonData<Record<string, AgentMetadata>> {
  return new DiskJsonData<Record<string, AgentMetadata>>(filePath, {
    backup: false,
    normalizeLoadedData: normalizeAgentMetadataPayload,
    onReadError: (err: unknown, candidatePath: string) => {
      logger.warn({ err, candidatePath }, 'Failed to read agent metadata candidate');
    },
  });
}

let agentMetadataStore = createAgentMetadataStore();

export function setAgentMetadataStoreForTests(store: DiskJsonData<Record<string, AgentMetadata>> | null): void {
  agentMetadataStore = store || createAgentMetadataStore();
  agentMetadata.clear();
}

export function resetAgentMetadataForTests(): void {
  agentMetadata.clear();
}

function normalizeAgentMetadata(meta: AgentMetadata): AgentMetadata {
  const nextMeta = { ...meta };
  const isolatedNode = typeof meta.isolatedNode === 'string' && meta.isolatedNode.trim()
    ? meta.isolatedNode.trim()
    : undefined;
  delete nextMeta.skills;
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
  await agentMetadataStore.write(data);
}

export async function loadAgentMetadata(): Promise<void> {
  agentMetadata.clear();
  const loaded = await agentMetadataStore.loadFirstAvailable();
  if (loaded) {
    try {
      const data = loaded.data;
      for (const [agentName, meta] of Object.entries(data)) {
        agentMetadata.set(agentName, normalizeAgentMetadata(meta as AgentMetadata));
      }
      if (loaded.source !== agentMetadataStore.filePath) {
        logger.warn({ source: loaded.source }, 'Recovering agent metadata from fallback source');
        await agentMetadataStore.write(data);
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

export async function refreshSessionSnapshot(deps: AgentMetadataDeps, sessionId: string): Promise<{ sessionId: string; agentName: string }> {
  const session = await deps.getExistingSession(sessionId);
  if (!session) {
    throw new Error(`Session "${sessionId}" not found.`);
  }

  const agentName = session.agent || 'main';
  session.persistentMemorySnapshot = await llm.buildSessionSystemPromptSnapshot(getSessionSystemPromptOptions(session));
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
    session.persistentMemorySnapshot = await llm.buildSessionSystemPromptSnapshot(getSessionSystemPromptOptions(session));
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
    session.persistentMemorySnapshot = await llm.buildSessionSystemPromptSnapshot(getSessionSystemPromptOptions(session));
    await deps.saveSession(session.id);
    affectedSessions.push(session.id);
  }

  return { affectedSessions, isolated: !!normalizedNode, node: normalizedNode };
}
