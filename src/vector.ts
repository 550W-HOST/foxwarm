import { Message } from './types';
import { estimateTokenCount } from './tokenCount';
import { formatMessageText } from './utils/messageFormat';
import { isModelVisibleMessage } from './session/messageVisibility';
import { RpcClient, RpcError, type RpcTransport } from './rpc';
import type { VectorServiceManager } from './vectorServiceManager';
import type * as runtime from './vectorRuntime';
import { vectorServiceDescriptor } from './vectorServiceDescriptor';
import { VECTOR_ENABLED } from './config';

let manager: VectorServiceManager | undefined;
let externalTransport: RpcTransport | undefined;
let externalClient: RpcClient<typeof vectorServiceDescriptor> | undefined;
let externalTerminal = false;
type VectorPlacement = { kind: 'disabled' } | { kind: 'owned'; useWorker: boolean } | { kind: 'external'; transport: RpcTransport };
let activePlacement: VectorPlacement | undefined;
let initializingPlacement: VectorPlacement | undefined;
let initializing: Promise<void> | undefined;
let managerFactory = async (useWorker: boolean): Promise<VectorServiceManager> => {
  const { VectorServiceManager } = await import('./vectorServiceManager');
  return new VectorServiceManager({ useWorker });
};

export type VectorInitOptions = {
  enabled?: boolean;
  useWorker?: boolean;
  transport?: RpcTransport;
  placement?: 'child-reverse';
};

export async function init(options: VectorInitOptions = {}): Promise<void> {
  if (externalTerminal) throw new RpcError('VECTOR_SHUTTING_DOWN', 'Vector facade is shutting down.', true);
  const enabled = options.enabled ?? (options.transport ? true : VECTOR_ENABLED);
  const requested: VectorPlacement = enabled === false
    ? { kind: 'disabled' }
    : options.transport
    ? { kind: 'external', transport: options.transport }
    : { kind: 'owned', useWorker: options.useWorker === true };
  const matches = (placement: VectorPlacement | undefined): boolean => {
    if (!placement || placement.kind !== requested.kind) return false;
    if (placement.kind === 'disabled') return requested.kind === 'disabled';
    if (placement.kind === 'external') return requested.kind === 'external' && placement.transport === requested.transport;
    return requested.kind === 'owned' && placement.useWorker === requested.useWorker;
  };
  if (activePlacement) {
    if (!matches(activePlacement)) throw new RpcError('VECTOR_PLACEMENT_CHANGE_REQUIRES_RESTART', 'Vector service placement cannot change after startup.');
    if (manager) await manager.start();
    return;
  }
  if (initializing) {
    if (!matches(initializingPlacement)) throw new RpcError('VECTOR_PLACEMENT_CHANGE_REQUIRES_RESTART', 'Vector service placement initialization conflicts with an in-flight owner.');
    await initializing; return;
  }
  initializingPlacement = requested;
  initializing = (async () => {
    if (requested.kind === 'disabled') {
      activePlacement = requested;
      return;
    }
    if (requested.kind === 'external') {
      externalTransport = requested.transport;
      externalClient = new RpcClient(vectorServiceDescriptor, requested.transport);
      activePlacement = requested;
      return;
    }
    const next = await managerFactory(requested.useWorker);
    manager = next;
    activePlacement = requested;
    await next.start();
  })();
  const pending = initializing;
  try { await pending; }
  finally { if (initializing === pending) { initializing = undefined; initializingPlacement = undefined; } }
}

export async function shutdown(): Promise<void> {
  if (initializing) await initializing.catch(() => {});
  if (activePlacement?.kind === 'disabled') {
    activePlacement = undefined;
    return;
  }
  if (externalClient || externalTransport) {
    externalTerminal = true; externalClient = undefined; externalTransport = undefined; activePlacement = undefined; return;
  }
  const current = manager;
  if (!current) return;
  await current.shutdown();
  // Preserve the global ownership fence until shutdown has confirmed that the
  // old child exited. A failed shutdown remains visible and blocks replacement.
  if (manager === current) { manager = undefined; activePlacement = undefined; }
}

export function getVectorServiceStatus(): { mode?: 'disabled' | 'local' | 'worker' | 'external'; ready: boolean; generation?: number; pid?: number } {
  if (activePlacement?.kind === 'disabled') return { mode: 'disabled', ready: false };
  if (externalClient) return { mode: 'external', ready: true };
  return manager?.getStatus() || { ready: false };
}

export async function search(
  query: string,
  limit = 5,
  format = true,
  options?: runtime.SearchOptions,
): Promise<any> {
  return callVector('search', { query, limit, format, options });
}

export async function waitForStartupArchiveVectorBackfill(): Promise<void> {
  await callVector('waitForStartupBackfill', {});
}

export async function getArchiveIndexStatus(sessionId: string): Promise<{
  lastIndexedSeq: number;
  tailStartSeq: number;
  lastIndexedBlockId: number;
}> {
  return callVector('getArchiveIndexStatus', { sessionId });
}

export async function scheduleSessionArchiveIndex(
  sessionId: string,
  latestSeqHint?: number,
  latestMessageTokenEstimate?: number,
  latestBlockIdHint?: number,
): Promise<number> {
  if (isDisabled()) return 0;
  const result = await callVector('scheduleIndex', {
    sessionId,
    latestSeqHint,
    latestMessageTokenEstimate,
    latestBlockIdHint,
  });
  return result.status.lastIndexedSeq;
}

export async function indexSessionArchive(
  sessionId: string,
  latestSeqHint?: number,
  latestBlockIdHint?: number,
): Promise<number> {
  const result = await callVector('forceIndexSession', { sessionId, latestSeqHint, latestBlockIdHint });
  return result.lastIndexedSeq;
}

export async function indexAllSessionArchives(sessionIds?: string[]): Promise<void> {
  await callVector('indexAllSessionArchives', { sessionIds });
}

export async function indexMemoryFactsFromCompaction(input: runtime.CompactMemoryFactIndexInput): Promise<number> {
  if (isDisabled()) return 0;
  const result = await callVector('indexMemoryFacts', input);
  return result.indexed;
}

export async function renameSessionArchiveIndex(oldSessionId: string, newSessionId: string): Promise<void> {
  if (isDisabled()) return;
  if (!manager && !externalClient) {
    // Startup move-journal recovery runs before vector placement starts and
    // touches only archive SQLite checkpoints, never LanceDB.
    await localRuntime().renameSessionArchiveIndex(oldSessionId, newSessionId);
    return;
  }
  await callVector('renameSessionArchiveIndex', { oldSessionId, newSessionId });
}

export async function copySessionArchiveIndexCheckpoint(sourceSessionId: string, targetSessionId: string): Promise<void> {
  if (isDisabled()) return;
  if (!manager && !externalClient) {
    await localRuntime().copySessionArchiveIndexCheckpoint(sourceSessionId, targetSessionId);
    return;
  }
  await callVector('copySessionArchiveIndexCheckpoint', { sourceSessionId, targetSessionId });
}

// Compatibility wrapper retained without sending full history through RPC.
export async function indexNewMessages(sessionId: string, history: Message[], _lastIndexedPosition = 0): Promise<number> {
  await indexSessionArchive(sessionId);
  return history.length;
}

async function callVector<MethodName extends Parameters<ReturnType<VectorServiceManager['getClient']>['call']>[0]>(
  methodName: MethodName,
  input: any,
): Promise<any> {
  const selectedClient = externalClient || manager?.getClient();
  if (!selectedClient) {
    if (isDisabled()) {
      throw new RpcError('VECTOR_DISABLED', 'Vector search is disabled by configuration.', false);
    }
    throw new RpcError('VECTOR_UNAVAILABLE', 'Vector service has not been initialized.', true);
  }
  try {
    return await selectedClient.call(methodName as any, input);
  } catch (error) {
    if (error instanceof RpcError && [
      'RPC_UNAVAILABLE',
      'RPC_CLOSED',
      'RPC_SEND_FAILED',
      'RPC_READY_TIMEOUT',
      'RPC_DRAINING',
      'RPC_PROTOCOL_MISMATCH',
      'RPC_SERVICE_NOT_FOUND',
      'RPC_SERVICE_VERSION_MISMATCH',
    ].includes(error.code)) {
      throw new RpcError('VECTOR_UNAVAILABLE', error.message, true);
    }
    throw error;
  }
}

function isDisabled(): boolean {
  return activePlacement?.kind === 'disabled'
    || (!activePlacement && !initializingPlacement && !VECTOR_ENABLED);
}

// Pure/vector-row helpers remain local and never carry a LanceDB handle.
function localRuntime(): typeof import('./vectorRuntime') { return require('./vectorRuntime'); }
export function setVectorServiceManagerFactoryForTests(factory?: (useWorker: boolean) => Promise<VectorServiceManager>): void {
  managerFactory = factory || (async useWorker => {
    const { VectorServiceManager } = await import('./vectorServiceManager');
    return new VectorServiceManager({ useWorker });
  });
}
export const buildArchiveSegments: typeof runtime.buildArchiveSegments = (...args) => localRuntime().buildArchiveSegments(...args);
export const calculateNextSegmentStartIndex: typeof runtime.calculateNextSegmentStartIndex = (...args) => localRuntime().calculateNextSegmentStartIndex(...args);
export const createRowsFromMemoryFacts: typeof runtime.createRowsFromMemoryFacts = (...args) => localRuntime().createRowsFromMemoryFacts(...args);
export const createRowsFromSegment: typeof runtime.createRowsFromSegment = (...args) => localRuntime().createRowsFromSegment(...args);
export const createRowFromBlockRecord: typeof runtime.createRowFromBlockRecord = (...args) => localRuntime().createRowFromBlockRecord(...args);
export const estimateArchiveMessageTokenCount: typeof runtime.estimateArchiveMessageTokenCount = (message) => {
  if (!isModelVisibleMessage(message)) return 0;
  const text = formatMessageText(message, {
    includeRolePrefix: true,
    skipEphemeralSystem: true,
    skipRagMemorySnippets: true,
    skipThinking: true,
  });
  return text ? estimateTokenCount(text) : 0;
};
export const getArchiveIndexBatchDecision: typeof runtime.getArchiveIndexBatchDecision = (...args) => localRuntime().getArchiveIndexBatchDecision(...args);
export const sanitizeEmbeddingInput: typeof runtime.sanitizeEmbeddingInput = (...args) => localRuntime().sanitizeEmbeddingInput(...args);
