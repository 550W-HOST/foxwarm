import { RpcError, type RpcServiceHandler } from './rpc';
import * as vector from './vector';
import { vectorServiceDescriptor } from './vectorServiceDescriptor';

/** Main-owned proxy over the already selected vector facade placement. */
export function createVectorFacadeProxyHandler(): RpcServiceHandler<typeof vectorServiceDescriptor> {
  return {
    async init() {
      if (!vector.getVectorServiceStatus().ready) throw new RpcError('VECTOR_UNAVAILABLE', 'Vector service is not ready.', true);
      return { ready: true };
    },
    async waitForStartupBackfill() { await vector.waitForStartupArchiveVectorBackfill(); return { completed: true }; },
    async search(input) { return vector.search(input.query, input.limit, input.format, input.options); },
    async getArchiveIndexStatus(input) { return vector.getArchiveIndexStatus(input.sessionId); },
    async scheduleIndex(input) {
      await vector.scheduleSessionArchiveIndex(input.sessionId, input.latestSeqHint, input.latestMessageTokenEstimate, input.latestBlockIdHint);
      return { accepted: true, status: await vector.getArchiveIndexStatus(input.sessionId) };
    },
    async forceIndexSession(input) {
      return { lastIndexedSeq: await vector.indexSessionArchive(input.sessionId, input.latestSeqHint, input.latestBlockIdHint) };
    },
    async indexAllSessionArchives(input) { await vector.indexAllSessionArchives(input.sessionIds); return { completed: true }; },
    async indexMemoryFacts(input) { return { indexed: await vector.indexMemoryFactsFromCompaction(input) }; },
    async renameSessionArchiveIndex(input) {
      await vector.renameSessionArchiveIndex(input.oldSessionId, input.newSessionId); return { completed: true };
    },
    async copySessionArchiveIndexCheckpoint(input) {
      await vector.copySessionArchiveIndexCheckpoint(input.sourceSessionId, input.targetSessionId); return { completed: true };
    },
  };
}
