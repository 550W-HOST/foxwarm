import { readEffectiveArchiveMessagePage } from '../session/archiveStore';

/** Runtime seq bounds are snapshot bounds, never a replacement for realtime publication ordering. */
export async function readContinuousHistoryPage(sessionId: string, options: { beforeSeq?: number; afterSeq?: number }, latestSeq: number) {
  const page = await readEffectiveArchiveMessagePage(sessionId, {
    ...options, endSeq: latestSeq, limit: 100,
    ...(options.afterSeq === undefined ? { beforeSeq: options.beforeSeq ?? latestSeq + 1 } : {}),
  });
  return {
    latestSeq,
    messages: page.records.map(record => ({
      ...record.message,
      __meta: { ...record.message.__meta, seq: record.seq, timestamp: record.message.__meta?.timestamp || record.timestamp },
    })),
    firstSeq: page.records[0]?.seq,
    lastSeq: page.records.at(-1)?.seq,
    hasMore: page.hasMore,
  };
}
