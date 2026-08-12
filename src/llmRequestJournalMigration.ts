import { SqliteLlmRequestJournalStore } from './llmRequestJournalSqliteStore';
import type { LlmJournalRecord, LlmJournalRecordKind, LlmRequestJournalStore } from './llmRequestJournalStore';
import { LLM_REQUEST_JOURNAL_AUTHORITY, LLM_REQUEST_JOURNAL_SCHEMA_VERSION } from './llmRequestJournalStore';
import { canonicalJournalJson } from './llmRequestJournal';

const KINDS: LlmJournalRecordKind[] = ['object', 'request', 'attempt-start', 'attempt-result'];

async function copyKind(source: LlmRequestJournalStore, target: LlmRequestJournalStore, kind: LlmJournalRecordKind): Promise<number> {
  let cursor; let count = 0;
  do {
    const page = await source.scanRecords(kind, cursor, 500);
    if (page.records.length) await target.appendRecords(page.records);
    count += page.records.length;
    cursor = page.records.length === 500 ? page.next : undefined;
  } while (cursor);
  return count;
}

async function verifyKind(source: LlmRequestJournalStore, target: LlmRequestJournalStore, kind: LlmJournalRecordKind): Promise<number> {
  let cursor; let count = 0;
  do {
    const page = await source.scanRecords(kind, cursor, 500);
    for (const record of page.records) {
      const copied = await target.getRecord(record);
      if (!copied || canonicalJournalJson(copied) !== canonicalJournalJson(record)) {
        const id = record.kind === 'object' ? record.objectId : record.kind === 'request' ? record.requestId : record.eventId;
        throw new Error(`LLM Journal migration verification mismatch for ${kind} ${id}.`);
      }
    }
    count += page.records.length;
    cursor = page.records.length === 500 ? page.next : undefined;
  } while (cursor);
  return count;
}

export type LlmJournalCopyReport = {
  source: 'sqlite'; target: 'postgres';
  objects: number; requests: number; attemptStarts: number; attemptResults: number;
  reconstructedRequests: number;
};

export async function copySqliteLlmRequestJournalToStore(sqlitePath: string, target: LlmRequestJournalStore): Promise<LlmJournalCopyReport> {
  if (target.backend !== 'postgres') throw new Error('LLM Journal copy target must be PostgreSQL.');
  const source = new SqliteLlmRequestJournalStore(sqlitePath, true);
  await source.initialize();
  try {
    await target.initialize();
    const targetCounts = await target.getCounts();
    if (Object.values(targetCounts).some(value => value !== 0)) {
      throw new Error('PostgreSQL LLM request journal target is not empty; refusing copy.');
    }
    await source.checkIntegrity();
    await target.checkIntegrity();
    const sourceCounts = await source.getCounts();
    const copied: Record<LlmJournalRecordKind, number> = { object: 0, request: 0, 'attempt-start': 0, 'attempt-result': 0 };
    await source.withConsistentSnapshot(async () => {
      for (const kind of KINDS) copied[kind] = await copyKind(source, target, kind);
    });
    const finalTargetCounts = await target.getCounts();
    if (sourceCounts.objects !== finalTargetCounts.objects || sourceCounts.requests !== finalTargetCounts.requests
      || sourceCounts.attemptStarts !== finalTargetCounts.attemptStarts || sourceCounts.attemptResults !== finalTargetCounts.attemptResults) {
      throw new Error('LLM Journal migration count verification failed.');
    }
    for (const kind of KINDS) await verifyKind(source, target, kind);
    if (await target.getMetadata('authority') !== LLM_REQUEST_JOURNAL_AUTHORITY
      || await target.getMetadata('schema_version') !== String(LLM_REQUEST_JOURNAL_SCHEMA_VERSION)) {
      throw new Error('PostgreSQL LLM request journal authority/schema verification failed.');
    }
    let reconstructedRequests = 0;
    let cursor;
    do {
      const page = await source.scanRecords('request', cursor, 100);
      for (const record of page.records as Extract<LlmJournalRecord, { kind: 'request' }>[]) {
        const sourceRequest = await reconstructWithStore(source, record.requestId);
        const targetRequest = await reconstructWithStore(target, record.requestId);
        if (canonicalJournalJson(sourceRequest) !== canonicalJournalJson(targetRequest)) {
          throw new Error(`LLM Journal reconstruction verification failed for ${record.requestId}.`);
        }
        reconstructedRequests += 1;
      }
      cursor = page.records.length === 100 ? page.next : undefined;
    } while (cursor);
    return { source: 'sqlite', target: 'postgres', objects: copied.object, requests: copied.request, attemptStarts: copied['attempt-start'], attemptResults: copied['attempt-result'], reconstructedRequests };
  } finally {
    await source.close();
  }
}

async function reconstructWithStore(store: LlmRequestJournalStore, requestId: string): Promise<unknown> {
  const record = await store.getRequest(requestId);
  if (!record) throw new Error(`LLM Journal request ${requestId} is missing.`);
  const messages = await reconstructIds(store, requestId);
  const prompt = await store.getObject(record.promptObjectId);
  const tools = await store.getObject(record.toolSchemaObjectId);
  const messageObjects = await Promise.all(messages.map(id => store.getObject(id)));
  return { record, prompt, tools, messageObjects, starts: await store.getAttemptStarts(requestId), results: await store.getAttemptResults(requestId) };
}
async function reconstructIds(store: LlmRequestJournalStore, requestId: string): Promise<string[]> {
  const record = await store.getRequest(requestId);
  if (!record) throw new Error(`LLM Journal request ${requestId} is missing.`);
  if (record.checkpointMessageObjectIds) return record.checkpointMessageObjectIds;
  if (!record.baseRequestId || record.commonPrefixLength === undefined || !record.appendedMessageObjectIds) throw new Error(`LLM Journal request ${requestId} has invalid ancestry.`);
  const base = await reconstructIds(store, record.baseRequestId);
  return [...base.slice(0, record.commonPrefixLength), ...record.appendedMessageObjectIds];
}
