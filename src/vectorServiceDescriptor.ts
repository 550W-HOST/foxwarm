import { defineRpcService, rpcMethod } from './rpc';
import type * as runtime from './vectorRuntime';

export type VectorIndexStatus = {
  lastIndexedSeq: number;
  tailStartSeq: number;
  lastIndexedBlockId: number;
};

export const vectorServiceDescriptor = defineRpcService('vector', 1, {
  init: rpcMethod<Record<string, never>, { ready: true }>(),
  waitForStartupBackfill: rpcMethod<Record<string, never>, { completed: true }>(),
  search: rpcMethod<{ query: string; limit?: number; format?: boolean; options?: runtime.SearchOptions }, unknown>(),
  getContextAround: rpcMethod<{ timestamp: number; limit?: number }, unknown>(),
  getArchiveIndexStatus: rpcMethod<{ sessionId: string }, VectorIndexStatus>(),
  scheduleIndex: rpcMethod<{
    sessionId: string; latestSeqHint?: number; latestMessageTokenEstimate?: number; latestBlockIdHint?: number;
  }, { accepted: true; status: VectorIndexStatus }>(),
  forceIndexSession: rpcMethod<{
    sessionId: string; latestSeqHint?: number; latestBlockIdHint?: number;
  }, { lastIndexedSeq: number }>(),
  indexAllSessionArchives: rpcMethod<{ sessionIds?: string[] }, { completed: true }>(),
  indexMemoryFacts: rpcMethod<runtime.CompactMemoryFactIndexInput, { indexed: number }>(),
  renameSessionArchiveIndex: rpcMethod<{ oldSessionId: string; newSessionId: string }, { completed: true }>(),
  copySessionArchiveIndexCheckpoint: rpcMethod<{ sourceSessionId: string; targetSessionId: string }, { completed: true }>(),
});
