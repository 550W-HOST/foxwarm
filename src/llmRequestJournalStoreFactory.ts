import { LLM_REQUEST_JOURNAL_STORAGE_CONFIG } from './config';
import type { LlmRequestJournalStore } from './llmRequestJournalStore';
import { PostgresLlmRequestJournalStore } from './llmRequestJournalPostgresStore';
import { SqliteLlmRequestJournalStore } from './llmRequestJournalSqliteStore';
import { LLM_REQUEST_JOURNAL_DB_PATH } from './llmRequestJournalPaths';
import { readLlmRequestJournalCutoverMarker } from './llmRequestJournalCutover';

let store: LlmRequestJournalStore | undefined;
let initializing: Promise<LlmRequestJournalStore> | undefined;

export function createConfiguredLlmRequestJournalStore(options: { requireExistingAuthority?: boolean } = {}): LlmRequestJournalStore {
  return LLM_REQUEST_JOURNAL_STORAGE_CONFIG.backend === 'postgres'
    ? new PostgresLlmRequestJournalStore(LLM_REQUEST_JOURNAL_STORAGE_CONFIG, options)
    : new SqliteLlmRequestJournalStore(LLM_REQUEST_JOURNAL_DB_PATH);
}

export async function getLlmRequestJournalStore(): Promise<LlmRequestJournalStore> {
  if (store) return store;
  if (!initializing) initializing = (async () => {
    const cutover = await readLlmRequestJournalCutoverMarker();
    if (LLM_REQUEST_JOURNAL_STORAGE_CONFIG.backend === 'sqlite' && cutover) {
      throw new Error('LLM_JOURNAL_SQLITE_RETIRED: a completed PostgreSQL cutover exists; reverse migration is unsupported. Keep PostgreSQL configured or restore a complete pre-cutover backup.');
    }
    if (LLM_REQUEST_JOURNAL_STORAGE_CONFIG.backend === 'postgres' && cutover
      && (cutover.postgres.schema !== LLM_REQUEST_JOURNAL_STORAGE_CONFIG.schema
        || cutover.postgres.connectionStringEnv !== LLM_REQUEST_JOURNAL_STORAGE_CONFIG.connectionStringEnv)) {
      throw new Error('Configured PostgreSQL LLM Request Journal does not match the completed local cutover marker.');
    }
    const created = createConfiguredLlmRequestJournalStore({ requireExistingAuthority: !!cutover });
    try {
      await created.initialize();
      store = created;
      return created;
    } catch (error) {
      await created.close().catch((): void => {});
      throw error;
    }
  })();
  try { return await initializing; }
  finally { initializing = undefined; }
}

export async function closeLlmRequestJournalStore(): Promise<void> {
  const current = store;
  store = undefined;
  if (current) await current.close();
}

export function resetLlmRequestJournalStoreForTests(): void { store = undefined; initializing = undefined; }
