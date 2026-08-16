import * as runtime from './vectorRuntime';
import { logger } from './common';
import {
  RpcError,
  RpcServiceHandler,
} from './rpc';
import { vectorServiceDescriptor } from './vectorServiceDescriptor';
export { vectorServiceDescriptor, type VectorIndexStatus } from './vectorServiceDescriptor';

export function createVectorServiceHandler(): RpcServiceHandler<typeof vectorServiceDescriptor> {
  return {
    async init() {
      await runtime.init();
      return { ready: true };
    },
    async waitForStartupBackfill() {
      await runtime.waitForStartupArchiveVectorBackfill();
      return { completed: true };
    },
    async search(input) {
      return runtime.search(input.query, input.limit, input.format, input.options);
    },
    async getArchiveIndexStatus(input) {
      return runtime.getArchiveIndexStatus(input.sessionId);
    },
    async scheduleIndex(input) {
      // Scheduling is best-effort and may intentionally wait for a later batch
      // threshold. Accept the hint immediately instead of keeping an RPC open.
      void runtime.scheduleSessionArchiveIndex(
        input.sessionId,
        input.latestSeqHint,
        input.latestMessageTokenEstimate,
        input.latestBlockIdHint,
      ).catch((error) => {
        logger.warn({ err: error, sessionId: input.sessionId }, 'Accepted vector index schedule failed');
      });
      return { accepted: true, status: runtime.getArchiveIndexStatus(input.sessionId) };
    },
    async forceIndexSession(input) {
      const lastIndexedSeq = await runtime.indexSessionArchive(
        input.sessionId,
        input.latestSeqHint,
        input.latestBlockIdHint,
      );
      return { lastIndexedSeq };
    },
    async indexMemoryFacts(input) {
      return { indexed: await runtime.indexMemoryFactsFromCompaction(input) };
    },
    async renameSessionArchiveIndex(input) {
      await runtime.renameSessionArchiveIndex(input.oldSessionId, input.newSessionId);
      return { completed: true };
    },
    async copySessionArchiveIndexCheckpoint(input) {
      await runtime.copySessionArchiveIndexCheckpoint(input.sourceSessionId, input.targetSessionId);
      return { completed: true };
    },
  };
}

export function toVectorUnavailable(error: unknown): RpcError {
  if (error instanceof RpcError && error.code === 'VECTOR_UNAVAILABLE') return error;
  const candidate = error as any;
  return new RpcError(
    'VECTOR_UNAVAILABLE',
    `Vector service is unavailable: ${candidate?.message || String(error)}`,
    true,
  );
}
