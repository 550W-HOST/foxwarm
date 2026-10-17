import { logger } from '../common';
import { AGENTS_FILE } from '../config';
import type { Session } from '../types';
import { DiskJsonData } from '../utils/diskJsonData';
import { AgentToolRule, normalizeAgentToolRules } from '../permissions';

export interface AgentMetadata {
  isolated?: boolean;
  isolatedNode?: string;
  inherit?: string;
  toolRules?: AgentToolRule[];
  [key: string]: any;
}

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

export function installAgentMetadataSnapshotForWorker(agentName: string, meta: AgentMetadata): void {
  agentMetadata.set(agentName, normalizeAgentMetadata(meta));
}

function normalizeAgentMetadata(meta: AgentMetadata): AgentMetadata {
  const nextMeta = { ...meta };
  const isolatedNode = typeof meta.isolatedNode === 'string' && meta.isolatedNode.trim()
    ? meta.isolatedNode.trim()
    : undefined;
  delete nextMeta.skills;
  if (meta.toolRules !== undefined) nextMeta.toolRules = normalizeAgentToolRules(meta.toolRules);
  else delete nextMeta.toolRules;
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
  const loaded = await agentMetadataStore.loadFirstAvailable();
  if (!loaded) {
    logger.info({ count: agentMetadata.size }, 'Agent metadata unavailable; preserving current authority snapshot');
    return;
  }
  const data = loaded.data;
  const normalizedEntries = Object.entries(data).map(([agentName, meta]) => [agentName, normalizeAgentMetadata(meta as AgentMetadata)] as const);
  if (loaded.source !== agentMetadataStore.filePath) {
    logger.warn({ source: loaded.source }, 'Recovering agent metadata from fallback source');
    await agentMetadataStore.write(Object.fromEntries(normalizedEntries));
  }
  agentMetadata.clear();
  for (const [agentName, meta] of normalizedEntries) agentMetadata.set(agentName, meta);
  logger.info({ count: agentMetadata.size }, 'Agent metadata loaded');
}

export async function refreshAgentMetadata(agentName: string): Promise<void> {
  const loaded = await agentMetadataStore.loadFirstAvailable();
  if (!loaded) return;
  const raw = loaded?.data?.[agentName];
  if (raw === undefined) return;
  agentMetadata.set(agentName, normalizeAgentMetadata(raw as AgentMetadata));
}

export function getAgentMetadata(agentName: string): AgentMetadata {
  return agentMetadata.get(agentName) || {};
}

export function getAgentToolRules(agentName: string): AgentToolRule[] {
  return getAgentMetadata(agentName).toolRules || [];
}

export function listAgentMetadataEntries(): Array<[string, AgentMetadata]> {
  return [...agentMetadata.entries()].map(([agentName, metadata]) => [agentName, {
    ...metadata,
    ...(metadata.toolRules ? { toolRules: metadata.toolRules.map(rule => ({ ...rule })) } : {}),
  }]);
}

export async function deleteAgentMetadata(agentName: string): Promise<void> {
  if (!agentMetadata.delete(agentName)) return;
  await saveAgentMetadata();
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

export async function setAgentToolRules(agentName: string, toolRules: unknown): Promise<number> {
  const normalized = normalizeAgentToolRules(toolRules);
  await setAgentMetadata(agentName, { ...getAgentMetadata(agentName), toolRules: normalized });
  return normalized.length;
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
