import { SqliteLlmRequestJournalStore } from './llmRequestJournalSqliteStore';
import path from 'node:path';
import type { LlmJournalRecord, LlmJournalRecordKind, LlmRequestJournalStore } from './llmRequestJournalStore';
import { LLM_REQUEST_JOURNAL_AUTHORITY, LLM_REQUEST_JOURNAL_AUTHORITY_STATE_COMPLETE, LLM_REQUEST_JOURNAL_AUTHORITY_STATE_KEY, LLM_REQUEST_JOURNAL_SCHEMA_VERSION } from './llmRequestJournalStore';
import { assertCurrentLlmJournalSqliteAuthority, canonicalJournalJson, reconstructLlmRequestFromStore, validateLlmRequestJournalStore } from './llmRequestJournal';
import { LLM_REQUEST_JOURNAL_DB_PATH } from './llmRequestJournalPaths';
import { writeLlmRequestJournalCutoverMarker } from './llmRequestJournalCutover';
import type { NormalizedLlmRequestJournalStorageConfig } from './config';

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

let copyFaultInjector: ((phase: string, count: number) => void) | undefined;
export function setLlmJournalCopyFaultInjectorForTests(injector: ((phase: string, count: number) => void) | undefined): void {
  copyFaultInjector = injector;
}

export async function copySqliteLlmRequestJournalToStore(
  sqlitePath: string,
  target: LlmRequestJournalStore,
  postgresConfig?: Extract<NormalizedLlmRequestJournalStorageConfig, { backend: 'postgres' }>,
): Promise<LlmJournalCopyReport> {
  if (target.backend !== 'postgres') throw new Error('LLM Journal copy target must be PostgreSQL.');
  if (path.resolve(sqlitePath) !== path.resolve(LLM_REQUEST_JOURNAL_DB_PATH)) {
    throw new Error(`LLM Journal cutover source must be the active SQLite authority ${LLM_REQUEST_JOURNAL_DB_PATH}.`);
  }
  if (!postgresConfig) throw new Error('PostgreSQL Journal cutover requires the active normalized PostgreSQL configuration.');
  const source = new SqliteLlmRequestJournalStore(sqlitePath, true);
  await source.initialize();
  try {
    assertCurrentLlmJournalSqliteAuthority(sqlitePath);
    await source.checkIntegrity();
    const sourceCounts = await validateLlmRequestJournalStore(source);
    await target.initialize();
    if (!target.beginMigrationCopy || !target.completeMigrationCopy) throw new Error('PostgreSQL LLM request journal target does not support migration authority lifecycle.');
    await target.beginMigrationCopy();
    const copied: Record<LlmJournalRecordKind, number> = { object: 0, request: 0, 'attempt-start': 0, 'attempt-result': 0 };
    await source.withConsistentSnapshot(async () => {
      for (const kind of KINDS) {
        copied[kind] = await copyKind(source, target, kind);
        copyFaultInjector?.(`after-${kind}`, copied[kind]);
      }
    });
    const targetValidation = await validateLlmRequestJournalStore(target);
    if (sourceCounts.objects !== targetValidation.objects || sourceCounts.requests !== targetValidation.requests
      || sourceCounts.attemptStarts !== targetValidation.attemptStarts || sourceCounts.attemptResults !== targetValidation.attemptResults) {
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
        const sourceRequest = await reconstructLlmRequestFromStore(source, record.requestId);
        const targetRequest = await reconstructLlmRequestFromStore(target, record.requestId);
        if (canonicalJournalJson(sourceRequest) !== canonicalJournalJson(targetRequest)) {
          throw new Error(`LLM Journal reconstruction verification failed for ${record.requestId}.`);
        }
        reconstructedRequests += 1;
      }
      cursor = page.records.length === 100 ? page.next : undefined;
    } while (cursor);
    await target.completeMigrationCopy();
    if (await target.getMetadata(LLM_REQUEST_JOURNAL_AUTHORITY_STATE_KEY) !== LLM_REQUEST_JOURNAL_AUTHORITY_STATE_COMPLETE) {
      throw new Error('PostgreSQL LLM request journal did not publish complete migration authority.');
    }
    try {
      await writeLlmRequestJournalCutoverMarker({
        v: 1,
        store: 'llm-request-journal',
        activeBackend: 'postgres',
        completedAt: Date.now(),
        postgres: { schema: postgresConfig.schema, connectionStringEnv: postgresConfig.connectionStringEnv },
        source: { databaseFile: 'llm-request-journal.sqlite' },
      });
    } catch (error: any) {
      throw new Error(`PostgreSQL Journal copy verified, but cutover was not finalized because the local marker could not be written: ${error?.message || error}. Keep PostgreSQL configured; to retry the cutover, repair the active data directory, restore the pre-cutover state, and drop or choose a fresh PostgreSQL schema.`);
    }
    return { source: 'sqlite', target: 'postgres', objects: copied.object, requests: copied.request, attemptStarts: copied['attempt-start'], attemptResults: copied['attempt-result'], reconstructedRequests };
  } finally {
    await source.close();
  }
}
