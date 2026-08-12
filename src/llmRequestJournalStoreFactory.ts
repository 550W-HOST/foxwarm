import { LLM_REQUEST_JOURNAL_STORAGE_CONFIG } from './config';
import type { LlmRequestJournalStore } from './llmRequestJournalStore';
import { PostgresLlmRequestJournalStore } from './llmRequestJournalPostgresStore';
import { SqliteLlmRequestJournalStore } from './llmRequestJournalSqliteStore';
import { LLM_REQUEST_JOURNAL_DB_PATH } from './llmRequestJournalPaths';

let store: LlmRequestJournalStore | undefined;
let initializing: Promise<LlmRequestJournalStore> | undefined;

export async function getLlmRequestJournalStore(): Promise<LlmRequestJournalStore> {
  if (store) return store;
  if (!initializing) initializing = (async () => {
    const created: LlmRequestJournalStore = LLM_REQUEST_JOURNAL_STORAGE_CONFIG.backend === 'postgres'
      ? new PostgresLlmRequestJournalStore(LLM_REQUEST_JOURNAL_STORAGE_CONFIG)
      : new SqliteLlmRequestJournalStore(LLM_REQUEST_JOURNAL_DB_PATH);
    await created.initialize();
    store = created;
    return created;
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
