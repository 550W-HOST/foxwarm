import { Message } from './types';
import { RpcError } from './rpc';
import { VectorServiceManager } from './vectorServiceManager';
import * as runtime from './vectorRuntime';

let manager: VectorServiceManager | undefined;

export type VectorInitOptions = {
  useWorker?: boolean;
};

export async function init(options: VectorInitOptions = {}): Promise<void> {
  const useWorker = options.useWorker === true;
  if (!manager) manager = new VectorServiceManager({ useWorker });
  await manager.start();
}

export async function shutdown(): Promise<void> {
  const current = manager;
  manager = undefined;
  await current?.shutdown();
}

export function getVectorServiceStatus(): ReturnType<VectorServiceManager['getStatus']> {
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
  if (!manager) {
    // Startup move-journal recovery runs before vector placement starts and
    // touches only archive SQLite checkpoints, never LanceDB.
    await runtime.renameSessionArchiveIndex(oldSessionId, newSessionId);
    return;
  }
  await callVector('renameSessionArchiveIndex', { oldSessionId, newSessionId });
}

export async function copySessionArchiveIndexCheckpoint(sourceSessionId: string, targetSessionId: string): Promise<void> {
  if (!manager) {
    await runtime.copySessionArchiveIndexCheckpoint(sourceSessionId, targetSessionId);
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
  if (!manager) {
    throw new RpcError('VECTOR_UNAVAILABLE', 'Vector service has not been initialized.', true);
  }
  try {
    return await manager.getClient().call(methodName as any, input);
  } catch (error) {
    if (error instanceof RpcError && [
      'RPC_UNAVAILABLE',
      'RPC_CLOSED',
      'RPC_SEND_FAILED',
      'RPC_READY_TIMEOUT',
      'RPC_DRAINING',
    ].includes(error.code)) {
      throw new RpcError('VECTOR_UNAVAILABLE', error.message, true);
    }
    throw error;
  }
}

// Pure/vector-row helpers remain local and never carry a LanceDB handle.
export const buildArchiveSegments = runtime.buildArchiveSegments;
export const calculateNextSegmentStartIndex = runtime.calculateNextSegmentStartIndex;
export const createRowsFromMemoryFacts = runtime.createRowsFromMemoryFacts;
export const createRowsFromSegment = runtime.createRowsFromSegment;
export const createRowFromBlockRecord = runtime.createRowFromBlockRecord;
export const estimateArchiveMessageTokenCount = runtime.estimateArchiveMessageTokenCount;
export const getArchiveIndexBatchDecision = runtime.getArchiveIndexBatchDecision;
export const sanitizeEmbeddingInput = runtime.sanitizeEmbeddingInput;
