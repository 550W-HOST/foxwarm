import path from 'node:path';
import { STATE_DIR } from './config';

export const LLM_REQUEST_JOURNAL_JSONL_PATH = path.join(STATE_DIR, 'llm-request-journal.jsonl');
export const LLM_REQUEST_JOURNAL_DB_PATH = path.join(STATE_DIR, 'llm-request-journal.sqlite');
