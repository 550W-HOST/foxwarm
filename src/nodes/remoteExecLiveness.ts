import { verifyRemoteExecCompletionCapability } from './sessionEventCapability';

export type RemoteExecLivenessState = 'reserved' | 'active' | 'outcome-unknown';

export type RemoteExecLivenessClaim = {
  nodeId: string;
  originalSessionId: string;
  agentName: string;
  execId: string;
  completionCapability: string;
  state: RemoteExecLivenessState;
  reservedAt: number;
  activatedAt?: number;
};

const records = new Map<string, RemoteExecLivenessClaim>();

function recordKey(originalSessionId: string, execId: string): string {
  return `${originalSessionId}\u0000${execId}`;
}

function exactRecord(input: {
  authenticatedNodeId: string;
  originalSessionId: string;
  execId: string;
  completionCapability: string;
}): RemoteExecLivenessClaim | undefined {
  const record = records.get(recordKey(input.originalSessionId, input.execId));
  if (!record || record.nodeId !== input.authenticatedNodeId
    || record.completionCapability !== input.completionCapability
    || !verifyRemoteExecCompletionCapability(input.completionCapability, {
      nodeId: input.authenticatedNodeId,
      sessionId: input.originalSessionId,
      execId: input.execId,
    })) return undefined;
  return record;
}

export function reserveRemoteExecIdentity(input: {
  authenticatedNodeId: string;
  canonicalSessionId: string;
  sessionIdentityIds: string[];
  agentName: string;
  execId: string;
  completionCapability: string;
}): boolean {
  const identityIds = new Set([input.canonicalSessionId, ...input.sessionIdentityIds]);
  if (!input.authenticatedNodeId || !input.canonicalSessionId || !input.agentName || !input.execId
    || !verifyRemoteExecCompletionCapability(input.completionCapability, {
      nodeId: input.authenticatedNodeId,
      sessionId: input.canonicalSessionId,
      execId: input.execId,
    })) {
    throw new Error(`Cannot reserve invalid remote exec identity for session "${input.canonicalSessionId}".`);
  }
  for (const record of records.values()) {
    if (record.execId === input.execId && identityIds.has(record.originalSessionId)) return false;
  }
  const key = recordKey(input.canonicalSessionId, input.execId);
  if (records.has(key)) return false;
  records.set(key, {
    nodeId: input.authenticatedNodeId,
    originalSessionId: input.canonicalSessionId,
    agentName: input.agentName,
    execId: input.execId,
    completionCapability: input.completionCapability,
    state: 'reserved',
    reservedAt: Date.now(),
  });
  return true;
}

export function activateRemoteExecLivenessClaim(input: {
  authenticatedNodeId: string;
  originalSessionId: string;
  execId: string;
  completionCapability: string;
}): RemoteExecLivenessClaim {
  const record = exactRecord(input);
  if (!record) {
    throw new Error(`Node "${input.authenticatedNodeId || 'unknown-node'}" supplied remote exec liveness without an exact Main reservation for session "${input.originalSessionId}".`);
  }
  if (record.state !== 'active') {
    record.state = 'active';
    record.activatedAt = Date.now();
  }
  return record;
}

export function releaseRemoteExecReservation(input: {
  authenticatedNodeId: string;
  originalSessionId: string;
  execId: string;
  completionCapability: string;
}): boolean {
  const record = exactRecord(input);
  if (!record || record.state !== 'reserved') return false;
  return records.delete(recordKey(input.originalSessionId, input.execId));
}

export function markRemoteExecOutcomeUnknown(input: {
  authenticatedNodeId: string;
  originalSessionId: string;
  execId: string;
  completionCapability: string;
}): boolean {
  const record = exactRecord(input);
  if (!record || record.state === 'active') return false;
  record.state = 'outcome-unknown';
  return true;
}

export function hasRemoteExecLivenessClaim(sessionIdentityIds: string[], agentName: string, execId: string): boolean {
  const identityIds = new Set(sessionIdentityIds);
  for (const record of records.values()) {
    if (record.state === 'active' && record.execId === execId
      && record.agentName === agentName && identityIds.has(record.originalSessionId)) return true;
  }
  return false;
}

export function clearRemoteExecLivenessClaim(input: {
  authenticatedNodeId: string;
  originalSessionId: string;
  execId: string;
  completionCapability: string;
}): boolean {
  if (!exactRecord(input)) return false;
  return records.delete(recordKey(input.originalSessionId, input.execId));
}

export function rebindRemoteExecSessionAgent(sessionIdentityIds: string[], agentName: string): void {
  const identityIds = new Set(sessionIdentityIds);
  for (const record of records.values()) {
    if (identityIds.has(record.originalSessionId)) record.agentName = agentName;
  }
}

export function clearRemoteExecStateForSession(sessionIdentityIds: string[]): number {
  const identityIds = new Set(sessionIdentityIds);
  let cleared = 0;
  for (const [key, record] of records) {
    if (!identityIds.has(record.originalSessionId)) continue;
    records.delete(key);
    cleared += 1;
  }
  return cleared;
}

export function getRemoteExecLivenessRecordsForTests(): RemoteExecLivenessClaim[] {
  return [...records.values()].map(record => ({ ...record }));
}

export function resetRemoteExecLivenessClaimsForTests(): void {
  records.clear();
}
