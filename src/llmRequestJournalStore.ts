import type { ChatResult, Message, ToolDefinition } from './types';

function canonicalize(value: any): any {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  const result: Record<string, any> = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) result[key] = canonicalize(value[key]);
  }
  return result;
}

export function canonicalJournalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export const LLM_REQUEST_JOURNAL_SCHEMA_VERSION = 1;
export const LLM_REQUEST_JOURNAL_AUTHORITY = 'foxwarm-llm-request-journal';
export const LLM_REQUEST_JOURNAL_AUTHORITY_STATE_KEY = 'authority_state';
export const LLM_REQUEST_JOURNAL_AUTHORITY_STATE_COMPLETE = 'complete';
export const LLM_REQUEST_JOURNAL_AUTHORITY_STATE_COPYING = 'copying';
export const MAX_LLM_REQUEST_DELTA_DEPTH = 8;

export type LlmRequestPurpose = 'normal-turn' | 'compact-plan' | 'btw' | 'toolscript-one-shot' | 'cli' | 'setup-test' | 'low-level';
export type LlmJournalObjectKind = 'prompt' | 'tool-schema' | 'message';
export type LlmJournalObjectRecord = { v: 1; kind: 'object'; objectId: string; objectKind: LlmJournalObjectKind; payload: string; createdAt: number };
export type LlmJournalRequestRecord = {
  v: 1; kind: 'request'; requestId: string; sessionId?: string; purpose: LlmRequestPurpose; iteration: number;
  createdAt: number; promptObjectId: string; toolSchemaObjectId: string; requestedModelKey: string;
  promptCacheKeyHash: string; messageCount: number; checkpointMessageObjectIds?: string[];
  baseRequestId?: string; commonPrefixLength?: number; appendedMessageObjectIds?: string[]; deltaDepth: number;
};
export type LlmJournalAttemptStartRecord = { v: 1; kind: 'attempt-start'; eventId: string; requestId: string; attempt: number; startedAt: number; concreteModelId: string; virtualModelKey?: string; providerType: string; semanticPayloadSha256: string };
export type LlmJournalAttemptResultRecord = { v: 1; kind: 'attempt-result'; eventId: string; requestId: string; attempt: number; completedAt: number; outcome: 'success' | 'failure' | 'abort'; result?: ChatResult; error?: Record<string, unknown> };
export type LlmJournalRecord = LlmJournalObjectRecord | LlmJournalRequestRecord | LlmJournalAttemptStartRecord | LlmJournalAttemptResultRecord;
export type LlmJournalRecordKind = LlmJournalRecord['kind'];

export type ReconstructedLlmRequest = {
  requestId: string; sessionId?: string; purpose: LlmRequestPurpose; iteration: number; createdAt: number;
  systemPrompt: string; toolDefinitions: ToolDefinition[]; messages: Message[]; requestedModelKey: string;
  promptCacheKeyHash: string; attempts: Array<{ start: LlmJournalAttemptStartRecord; result?: LlmJournalAttemptResultRecord }>;
  completeness: 'complete';
};

export type LlmRequestJournalSummary = {
  requestId: string; sessionId?: string; purpose: LlmRequestPurpose; iteration: number; createdAt: number;
  requestedModelKey: string; messageCount: number;
};
export type LlmRequestJournalCursor = { createdAt: number; requestId: string };
export type LlmJournalScanCursor = { time: number; id: string };

export interface LlmRequestJournalStore {
  readonly backend: 'sqlite' | 'postgres';
  initialize(): Promise<void>;
  close(): Promise<void>;
  appendRecords(records: LlmJournalRecord[]): Promise<void>;
  hasObject(objectId: string): Promise<boolean>;
  getObject(objectId: string): Promise<LlmJournalObjectRecord | null>;
  getRequest(requestId: string): Promise<LlmJournalRequestRecord | null>;
  getLatestRequestForSession(sessionId: string): Promise<Pick<LlmJournalRequestRecord, 'requestId' | 'deltaDepth'> | null>;
  getAttemptStarts(requestId: string): Promise<LlmJournalAttemptStartRecord[]>;
  getAttemptResults(requestId: string): Promise<LlmJournalAttemptResultRecord[]>;
  listRequests(options: { sessionId?: string; purpose?: LlmRequestPurpose; limit: number; before?: LlmRequestJournalCursor }): Promise<LlmRequestJournalSummary[]>;
  scanRecords(kind: LlmJournalRecordKind, after: LlmJournalScanCursor | undefined, limit: number): Promise<{ records: LlmJournalRecord[]; next?: LlmJournalScanCursor }>;
  getRecord(record: LlmJournalRecord): Promise<LlmJournalRecord | null>;
  getCounts(): Promise<{ objects: number; requests: number; attemptStarts: number; attemptResults: number }>;
  getMetadata(key: string): Promise<string | undefined>;
  setMetadata(key: string, value: string): Promise<void>;
  withConsistentSnapshot<T>(fn: () => Promise<T>): Promise<T>;
  checkIntegrity(): Promise<void>;
  beginMigrationCopy?(): Promise<void>;
  completeMigrationCopy?(): Promise<void>;
  replaceObjectPayloadForTests?(requestId: string, payload: string): Promise<string>;
  replaceRequestMessageCountForTests?(requestId: string, messageCount: number): Promise<number>;
  replaceRequestCreatedAtForTests?(requestIds: string[], createdAt: number): Promise<void>;
  replaceRequestIdentityForTests?(requestId: string, values: { purpose: string; promptCacheKeyHash: string; iteration: number }): Promise<{ purpose: string; promptCacheKeyHash: string; iteration: number }>;
  replaceAttemptStartHashForTests?(requestId: string, hash: string): Promise<string>;
  replaceAttemptResultOutcomeForTests?(requestId: string, outcome: string): Promise<string>;
}
