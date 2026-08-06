import { Message } from './types';
import { RpcClient, RpcError, type RpcTransport } from './rpc';
import type { VectorServiceManager } from './vectorServiceManager';
import type * as runtime from './vectorRuntime';
import { vectorServiceDescriptor } from './vectorServiceDescriptor';

let manager: VectorServiceManager | undefined;
let externalTransport: RpcTransport | undefined;
let externalClient: RpcClient<typeof vectorServiceDescriptor> | undefined;
let externalTerminal = false;

export type VectorInitOptions = {
  useWorker?: boolean;
  transport?: RpcTransport;
  placement?: 'child-reverse';
};

export async function init(options: VectorInitOptions = {}): Promise<void> {
  if (externalTerminal) throw new RpcError('VECTOR_SHUTTING_DOWN', 'Vector facade is shutting down.', true);
  if (options.transport) {
    if (manager || (externalTransport && externalTransport !== options.transport)) {
      throw new RpcError('VECTOR_PLACEMENT_CHANGE_REQUIRES_RESTART', 'Vector service placement cannot change after startup.');
    }
    externalTransport = options.transport;
    externalClient = new RpcClient(vectorServiceDescriptor, options.transport);
    return;
  }
  if (externalClient) throw new RpcError('VECTOR_PLACEMENT_CHANGE_REQUIRES_RESTART', 'Vector service placement cannot change after startup.');
  const useWorker = options.useWorker === true;
  if (!manager) {
    const { VectorServiceManager } = await import('./vectorServiceManager');
    manager = new VectorServiceManager({ useWorker });
  }
  await manager.start();
}

export async function shutdown(): Promise<void> {
  if (externalClient || externalTransport) {
    externalTerminal = true; externalClient = undefined; externalTransport = undefined; return;
  }
  const current = manager;
  if (!current) return;
  await current.shutdown();
  // Preserve the global ownership fence until shutdown has confirmed that the
  // old child exited. A failed shutdown remains visible and blocks replacement.
  if (manager === current) manager = undefined;
}

export function getVectorServiceStatus(): { mode?: 'local' | 'worker' | 'external'; ready: boolean; generation?: number; pid?: number } {
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

export async function getContextAround(
  timestamp: number,
  limit = 10,
): Promise<Awaited<ReturnType<typeof runtime.getContextAround>>> {
  return callVector('getContextAround', { timestamp, limit });
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
  const result = await callVector('indexMemoryFacts', input);
  return result.indexed;
}

export async function renameSessionArchiveIndex(oldSessionId: string, newSessionId: string): Promise<void> {
  if (!manager && !externalClient) {
    // Startup move-journal recovery runs before vector placement starts and
    // touches only archive SQLite checkpoints, never LanceDB.
    await localRuntime().renameSessionArchiveIndex(oldSessionId, newSessionId);
    return;
  }
  await callVector('renameSessionArchiveIndex', { oldSessionId, newSessionId });
}

export async function copySessionArchiveIndexCheckpoint(sourceSessionId: string, targetSessionId: string): Promise<void> {
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
      'RPC_SERVICE_UNAVAILABLE',
      'RPC_SERVICE_VERSION_MISMATCH',
    ].includes(error.code)) {
      throw new RpcError('VECTOR_UNAVAILABLE', error.message, true);
    }
    throw error;
  }
}

// Pure/vector-row helpers remain local and never carry a LanceDB handle.
function localRuntime(): typeof import('./vectorRuntime') { return require('./vectorRuntime'); }
export const buildArchiveSegments: typeof runtime.buildArchiveSegments = (...args) => localRuntime().buildArchiveSegments(...args);
export const calculateNextSegmentStartIndex: typeof runtime.calculateNextSegmentStartIndex = (...args) => localRuntime().calculateNextSegmentStartIndex(...args);
export const createRowsFromMemoryFacts: typeof runtime.createRowsFromMemoryFacts = (...args) => localRuntime().createRowsFromMemoryFacts(...args);
export const createRowsFromSegment: typeof runtime.createRowsFromSegment = (...args) => localRuntime().createRowsFromSegment(...args);
export const createRowFromBlockRecord: typeof runtime.createRowFromBlockRecord = (...args) => localRuntime().createRowFromBlockRecord(...args);
export const estimateArchiveMessageTokenCount: typeof runtime.estimateArchiveMessageTokenCount = (...args) => localRuntime().estimateArchiveMessageTokenCount(...args);
export const getArchiveIndexBatchDecision: typeof runtime.getArchiveIndexBatchDecision = (...args) => localRuntime().getArchiveIndexBatchDecision(...args);
export const sanitizeEmbeddingInput: typeof runtime.sanitizeEmbeddingInput = (...args) => localRuntime().sanitizeEmbeddingInput(...args);
