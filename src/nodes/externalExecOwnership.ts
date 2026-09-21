import { generatePersistentExecPetname } from '../../packages/shared/dist/persistentExec';
import type { ExternalNodeOwner } from '../../packages/shared/dist/nodeProtocol';
import { issueExternalExecCompletionCapability, verifyExternalExecCompletionCapability } from './sessionEventCapability';

type ExternalExecState = 'reserved' | 'running' | 'unknown' | 'completed';
export type ExternalExecRecord = {
  nodeId: string;
  /** An opaque resident Docker generation, bound before its exec effect; absent for CLI Nodes. */
  dockerGeneration?: string;
  dockerProvider?: true;
  owner: ExternalNodeOwner;
  execId: string;
  args: Record<string, unknown>;
  capability: string;
  state: ExternalExecState;
  startedAt: number;
  completedAt?: number;
  output?: string;
  cwd?: string;
  onCompleted?: (cwd: string) => void;
};

const MAX_RETAINED_JOBS_PER_CONTEXT = 20;
const MAX_SAVED_ARGS_BYTES = 64 * 1024;
const MAX_COMPLETION_BYTES = 256 * 1024;
const records = new Map<string, Map<string, ExternalExecRecord>>();

function contextKey(owner: ExternalNodeOwner): string { return `${owner.externalId}\0${owner.contextId}`; }

/** Ephemeral Main-only authority: losing this map means external results are no longer claimable. */
export function reserveExternalExec(owner: ExternalNodeOwner, nodeId: string, args: Record<string, unknown>, onCompleted?: (cwd: string) => void): ExternalExecRecord {
  const serialized = JSON.stringify(args);
  if (Buffer.byteLength(serialized) > MAX_SAVED_ARGS_BYTES) throw new Error('External exec arguments exceed 64 KiB.');
  const key = contextKey(owner);
  let scoped = records.get(key);
  if (!scoped) { scoped = new Map(); records.set(key, scoped); }
  let oldestCompleted: ExternalExecRecord | undefined;
  if (scoped.size >= MAX_RETAINED_JOBS_PER_CONTEXT) {
    for (const candidate of scoped.values()) {
      if (candidate.state !== 'completed') continue;
      if (!oldestCompleted || (candidate.completedAt ?? candidate.startedAt) < (oldestCompleted.completedAt ?? oldestCompleted.startedAt)) {
        oldestCompleted = candidate;
      }
    }
    if (!oldestCompleted) throw new Error('Too many active executions in this external context.');
  }
  let execId = generatePersistentExecPetname();
  for (let index = 0; scoped.has(execId) && index < 8; index++) execId = generatePersistentExecPetname();
  if (scoped.has(execId)) throw new Error('A unique external exec ID is not available.');
  const record: ExternalExecRecord = {
    nodeId, owner, execId, args: JSON.parse(serialized),
    capability: issueExternalExecCompletionCapability(nodeId, owner.externalId, owner.contextId, execId),
    state: 'reserved', startedAt: Date.now(), onCompleted,
  };
  if (oldestCompleted) scoped.delete(oldestCompleted.execId);
  scoped.set(execId, record);
  return record;
}

export function getExternalExec(owner: ExternalNodeOwner, execId: string): ExternalExecRecord | undefined {
  if (!owner || owner.kind !== 'external' || typeof owner.externalId !== 'string'
    || typeof owner.contextId !== 'string' || typeof execId !== 'string') return undefined;
  return records.get(contextKey(owner))?.get(execId);
}

export function listExternalExec(owner: ExternalNodeOwner, limit: number): ExternalExecRecord[] {
  return [...(records.get(contextKey(owner))?.values() || [])].sort((a, b) => b.startedAt - a.startedAt).slice(0, limit);
}

export function markExternalExecUnknown(record: ExternalExecRecord): void {
  if (getExternalExec(record.owner, record.execId) === record && record.state === 'reserved') record.state = 'unknown';
}

export function finishExternalExecForeground(record: ExternalExecRecord): void {
  if (getExternalExec(record.owner, record.execId) === record) records.get(contextKey(record.owner))?.delete(record.execId);
}

export function registerExternalExecBackground(nodeId: string, owner: ExternalNodeOwner, execId: string, capability: string): boolean {
  const record = getExternalExec(owner, execId);
  if (!record || record.nodeId !== nodeId || record.capability !== capability
    || !verifyExternalExecCompletionCapability(capability, { nodeId, externalId: owner.externalId, contextId: owner.contextId, execId })) return false;
  if (record.state === 'completed') return true; // A short process may finish before registration is handled.
  record.state = 'running';
  return true;
}

export function completeExternalExec(
  nodeId: string, owner: ExternalNodeOwner, execId: string, capability: string, output: string, cwd?: string,
): boolean {
  const record = getExternalExec(owner, execId);
  if (!record || record.nodeId !== nodeId || record.capability !== capability
    || !verifyExternalExecCompletionCapability(capability, { nodeId, externalId: owner.externalId, contextId: owner.contextId, execId })
    || typeof output !== 'string' || Buffer.byteLength(output) > MAX_COMPLETION_BYTES
    || (cwd !== undefined && (typeof cwd !== 'string' || cwd.length < 1 || cwd.length > 4096))) return false;
  if (record.state === 'completed') return record.output === output;
  record.state = 'completed'; record.output = output; record.cwd = cwd; record.completedAt = Date.now();
  if (cwd) record.onCompleted?.(cwd);
  return true;
}

export function releaseExternalExecContext(owner: ExternalNodeOwner): void { records.delete(contextKey(owner)); }

export function resetExternalExecOwnershipForTests(): void { records.clear(); }
