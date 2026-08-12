import fs from 'fs-extra';
import path from 'node:path';
import { promises as nodeFs } from 'node:fs';
import { STATE_DIR } from './config';

export const LLM_REQUEST_JOURNAL_CUTOVER_MARKER_PATH = path.join(STATE_DIR, 'llm-request-journal-cutover.json');

export type LlmRequestJournalCutoverMarker = {
  v: 1;
  store: 'llm-request-journal';
  activeBackend: 'postgres';
  completedAt: number;
  postgres: { schema: string; connectionStringEnv: string };
  source: { databaseFile: 'llm-request-journal.sqlite' };
};

let writeFaultInjector: ((phase: 'before-rename') => void) | undefined;
export function setLlmRequestJournalCutoverWriteFaultInjectorForTests(injector: ((phase: 'before-rename') => void) | undefined): void {
  writeFaultInjector = injector;
}

export async function readLlmRequestJournalCutoverMarker(): Promise<LlmRequestJournalCutoverMarker | undefined> {
  if (!await fs.pathExists(LLM_REQUEST_JOURNAL_CUTOVER_MARKER_PATH)) return undefined;
  const value = await fs.readJson(LLM_REQUEST_JOURNAL_CUTOVER_MARKER_PATH) as Partial<LlmRequestJournalCutoverMarker>;
  if (value.v !== 1 || value.store !== 'llm-request-journal' || value.activeBackend !== 'postgres'
    || !Number.isSafeInteger(value.completedAt) || value.completedAt! <= 0
    || typeof value.postgres?.schema !== 'string' || typeof value.postgres?.connectionStringEnv !== 'string'
    || value.source?.databaseFile !== 'llm-request-journal.sqlite') {
    throw new Error('Invalid LLM Request Journal cutover marker; restore a complete pre-cutover backup.');
  }
  return value as LlmRequestJournalCutoverMarker;
}

export async function writeLlmRequestJournalCutoverMarker(marker: LlmRequestJournalCutoverMarker): Promise<void> {
  await fs.ensureDir(STATE_DIR);
  const temporary = `${LLM_REQUEST_JOURNAL_CUTOVER_MARKER_PATH}.${process.pid}.${Date.now()}.tmp`;
  const handle = await nodeFs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(marker, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    writeFaultInjector?.('before-rename');
    await nodeFs.rename(temporary, LLM_REQUEST_JOURNAL_CUTOVER_MARKER_PATH);
    const directory = await nodeFs.open(STATE_DIR, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    await fs.remove(temporary).catch((): void => {});
    throw error;
  }
}
