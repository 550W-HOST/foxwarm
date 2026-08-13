import * as llm from '../llm';
import { isDeepStrictEqual } from 'node:util';
import { logger } from '../common';
import {
  COMPACT_BLOCK_CANDIDATE_FRACTION,
  COMPACT_BLOCK_FORCE_COMPACT_FRACTION,
  COMPACT_BLOCK_LEVEL_FORCE_TOKENS,
  COMPACT_BLOCK_LEVEL_MIN_TOKENS,
  COMPACT_MESSAGE_FORCE_COMPACT_FRACTION,
  COMPACT_PERCENT,
  resolveModelConfig,
} from '../config';
import { estimateSessionTokens, estimateTokenCount } from '../tokenCount';
import * as vector from '../vector';
import { appendMessagesToArchive, readArchiveMessages, readArchiveMessagesBySeqRange, rollbackUncommittedMessages } from './archive';
import {
  buildBlockCandidateItem,
  calculateBlockCompactionWindow,
  clampCompactFraction,
  buildCompactPlanValidationFeedback,
  buildCompactPromptText,
  buildMessageCandidateItem,
  BlockCompactionPolicy,
  COMPACT_FLOW_MAX_ROUNDS,
  COMPACT_LEVEL_TOKEN_THRESHOLD,
  COMPACT_PLAN_TOOL_NAME,
  CompactCandidateItem,
  CompactPlan,
  CompactPlanValidationError,
  ExtractedMemoryFact,
  MessageCompactionPolicy,
  PreservedMessageCandidateItem,
  selectCompactCandidateTargetLevels,
  validateCompactPlanArgs,
} from './compactPlan';
import { CompactionRequest, Message, MessagePart, QueueItem, Session, TokenUsage } from '../types';
import { formatToolResponsePayload } from '../../packages/shared/dist/toolResponseFormatting';
import { formatMessagePreviewText } from '../utils/messageFormat';
import { buildSystemMessageParts } from '../utils/systemMessageParts';
import { formatFoxwarmSystemTag } from '../utils/promptWrappers';
import { formatLocalTimestamp } from '../utils/localTime';
import { formatSessionGoalReminderText } from './goal';
import { appendBlocksToArchiveWithCommitInfo, readArchiveBlocksByIdRange, renderBlockMessage, rollbackUncommittedBlocks, shouldIgnoreMessageInCompactCandidates, shouldRemoveOldCompactCompletionMessage } from './layeredContext';
import { isModelVisibleMessage } from './messageVisibility';
import { captureSessionSemanticState, restoreSessionSemanticState } from './metadataStore';
import { isSessionAuthorityPostCommitError } from './stateFile';

const TOOL_RESPONSE_RETAIN_HEAD_CHARS = 500;
const TOOL_RESPONSE_RETAIN_TAIL_CHARS = 500;
const TOOL_RESPONSE_LINE_PREFERENCE_WINDOW = 100;
const TOOL_RESPONSE_METADATA_KEYS = new Set([
  'status', 'node', 'nodeId', 'path', 'filePath', 'absolutePath', 'outputFullPath',
  'logPath', 'statusPath', 'runId', 'execId', 'sha256', 'hash', 'location',
  'sizeBytes', 'byteLength', 'outputOriginalLengthChars', 'outputOriginalLineCount',
  'exitCode', 'code', 'overwritten',
]);

export interface ArchivedMessagesQueryOptions {
  startSeq?: number;
  endSeq?: number;
}

export interface ArchivedMessagesQueryResult {
  records: Array<{ seq: number; message: Message; sourceSessionId?: string; inherited?: boolean }>;
  totalMatched: number;
  returnedCount: number;
  availableRange: { startSeq?: number; endSeq?: number };
  requestedRange: { startSeq?: number; endSeq?: number };
}

export interface ToolNoiseCompactionResult {
  replacedFunctionCalls: number;
  replacedFunctionResponses: number;
  touchedMessages: number;
  inspectedMessages: number;
  keepStartIndex: number;
  thresholdTokens: number;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  estimatedTokensSaved: number;
  retainedHeadChars: number;
  retainedTailChars: number;
  minimumResponseChars: number;
}

export function getDefaultCompactThresholdTokens(session: Pick<Session, 'model'>): number {
  const { contextLimit } = resolveModelConfig(session.model);
  return Math.max(1, Math.floor(contextLimit * 0.8));
}

export function getEffectiveCompactThresholdTokens(session: Pick<Session, 'model' | 'compactThresholdTokens'>): number {
  if (typeof session.compactThresholdTokens === 'number' && Number.isFinite(session.compactThresholdTokens) && session.compactThresholdTokens > 0) {
    return Math.floor(session.compactThresholdTokens);
  }

  return getDefaultCompactThresholdTokens(session);
}

export function isAsyncCompactEnabled(session: Pick<Session, 'model'>): boolean {
  const { modelEntry } = resolveModelConfig(session.model);
  return modelEntry?.asyncCompact !== false;
}

export function hasPendingCompactWork(sessionId: string): boolean {
  return compactJobStates.has(sessionId);
}

export function discardPendingCompactWork(sessionId: string): void {
  compactJobStates.delete(sessionId);
}

export type SessionHistoryDeps = {
  getSessionById: (sessionId: string) => Session | undefined;
  getExistingSession: (sessionId: string) => Promise<Session | null>;
  saveSession: (sessionId: string) => Promise<void>;
  enqueueSessionItem?: (sessionId: string, item: QueueItem) => Promise<void>;
  notifyHistoryUpdate?: (sessionId: string, message: Message) => void;
};

type CompactionRunOptions = {
  keepPercent?: number;
  completionMarker?: string;
  compactGuidance?: string;
  startLogMessage?: string;
  startBroadcastMessage?: string;
  completionBroadcastMessage?: string;
};

type CompactExecutionMode = 'auto' | 'await' | 'background';

type CompactJobRequest = CompactionRequest;

type CompactJobSnapshot = {
  sessionId: string;
  baseHistoryVersion: number;
  historySnapshot: Message[];
  transientSession: Session;
  keepPercent: number;
  completionMarker: string;
  completionBroadcastMessage?: string;
  compactGuidance?: string;
};

type CompactJobOperation = {
  historyStartIndex: number;
  historyEndIndex: number;
  rawStartSeq: number;
  rawEndSeq: number;
  sourceKind: 'message' | 'block';
  level: number;
  sourceStart: number;
  sourceEnd: number;
  sourceBlockIds?: number[];
  summary: string;
  memoryFacts?: ExtractedMemoryFact[];
};

type CompactJobResult =
  | {
      status: 'noop';
      reason: 'empty-history' | 'no-older-messages' | 'no-candidates';
      completionMarker: string;
      snapshotHistory: Message[];
      consumedHistoryCount: number;
    }
  | {
      status: 'ready';
      completionMarker: string;
      completionBroadcastMessage?: string;
      snapshotHistory: Message[];
      consumedHistoryCount: number;
      operations: CompactJobOperation[];
      createdBlocks: Array<{
        level: number;
        sourceKind: 'message' | 'block';
        sourceStart: number;
        sourceEnd: number;
        sourceBlockIds?: number[];
        rawStartSeq: number;
        rawEndSeq: number;
        summary: string;
        memoryFacts?: ExtractedMemoryFact[];
      }>;
      preserveMessages: Array<{ seq: number; operationIndex: number }>;
      removePreservedMessages: number[];
      replacedItemCount: number;
    };

type CompactJobState = {
  status: 'running' | 'ready' | 'failed';
  startedAt: number;
  request: CompactJobRequest;
  snapshotHistoryVersion: number;
  result?: CompactJobResult;
  error?: Error;
};

const compactJobStates = new Map<string, CompactJobState>();
const compactPreviewLastTimestamp = new Map<string, number>();

const ASYNC_COMPACT_DONE_NOTICE = '🗜️ Background compaction finished';

function nextCompactPreviewTimestamp(sessionId: string): number {
  const now = Date.now();
  const last = compactPreviewLastTimestamp.get(sessionId) || 0;
  const next = Math.max(now, last + 1);
  compactPreviewLastTimestamp.set(sessionId, next);
  return next;
}

function mirrorTemporaryCompactMessage(deps: SessionHistoryDeps, sessionId: string, message: Message): void {
  if (!deps.notifyHistoryUpdate) {
    return;
  }

  const mirrored: Message = structuredClone(message);
  mirrored.__meta = {
    ...(mirrored.__meta || {}),
    timestamp: nextCompactPreviewTimestamp(sessionId),
    temporary: true,
    compactPreview: true,
  };
  deps.notifyHistoryUpdate(sessionId, mirrored);
}

export async function forceIndexSession(deps: SessionHistoryDeps, sessionId: string): Promise<void> {
  const session = deps.getSessionById(sessionId);
  if (!session) {
    throw new Error('Session not found');
  }

  try {
    const latestSeqHint = Math.max(0, (session.nextMessageSeq || 1) - 1);
    const latestBlockIdHint = Math.max(0, (session.nextBlockId || 1) - 1);
    logger.info({ sessionId, latestSeqHint }, 'Force indexing session archive');
    await vector.indexSessionArchive(sessionId, latestSeqHint, latestBlockIdHint);
    session.vectorIndexPosition = session.history.length;
    session.indexingState = undefined;
    await deps.saveSession(sessionId);
  } catch (e) {
    logger.error({ err: e, sessionId }, 'Failed to force index session archive');
    throw e;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function unicodeChars(value: string): string[] {
  return Array.from(value);
}

function takeLineAwareHead(chars: string[], limit: number): string {
  if (chars.length <= limit) return chars.join('');
  const minimumPreferred = Math.max(0, limit - TOOL_RESPONSE_LINE_PREFERENCE_WINDOW);
  for (let index = limit - 1; index >= minimumPreferred; index -= 1) {
    if (chars[index] === '\n') return chars.slice(0, index + 1).join('');
  }
  return chars.slice(0, limit).join('');
}

function takeLineAwareTail(chars: string[], limit: number): string {
  if (chars.length <= limit) return chars.join('');
  const start = chars.length - limit;
  const maximumPreferred = Math.min(chars.length - 1, start + TOOL_RESPONSE_LINE_PREFERENCE_WINDOW);
  for (let index = start; index <= maximumPreferred; index += 1) {
    if (chars[index] === '\n') return chars.slice(index + 1).join('');
  }
  return chars.slice(start).join('');
}

function buildToolResponsePrunedText(options: {
  originalText: string;
  seq: number;
  toolName?: string;
  toolUseId?: string;
}): string {
  const chars = unicodeChars(options.originalText);
  const head = takeLineAwareHead(chars, TOOL_RESPONSE_RETAIN_HEAD_CHARS);
  const tail = takeLineAwareTail(chars, TOOL_RESPONSE_RETAIN_TAIL_CHARS);
  const marker = `--- [foxwarm: historical tool response pruned; original: recall({ target: "msg#${options.seq}" }); tool=${JSON.stringify(options.toolName || 'unknown')}; tool_use_id=${JSON.stringify(options.toolUseId || 'unknown')}; kept first ${unicodeChars(head).length} and last ${unicodeChars(tail).length} Unicode characters] ---`;
  return `${head}\n\n${marker}\n\n${tail}`;
}

function isSmallMetadataValue(value: unknown): boolean {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return true;
  return typeof value === 'string' && unicodeChars(value).length <= 512;
}

function isSmallPayloadValue(value: unknown): boolean {
  try { return unicodeChars(formatToolResponsePayload({ output: value })).length <= 512; }
  catch { return false; }
}

function buildPrunedFunctionResponse(
  message: Message,
  part: MessagePart,
): { part: MessagePart; originalChars: number; prunedChars: number } | null {
  const functionResponse = part.functionResponse;
  const seq = message.__meta?.seq;
  if (!functionResponse || !Number.isSafeInteger(seq) || (seq || 0) < 1 || !isPlainRecord(functionResponse.response)) return null;

  const response = functionResponse.response;
  let originalText: string;
  try { originalText = formatToolResponsePayload(response); }
  catch { return null; }
  const originalChars = unicodeChars(originalText).length;
  if (originalChars <= TOOL_RESPONSE_RETAIN_HEAD_CHARS + TOOL_RESPONSE_RETAIN_TAIL_CHARS) return null;

  const prunedText = buildToolResponsePrunedText({
    originalText,
    seq: seq!,
    toolName: functionResponse.name,
    toolUseId: functionResponse.tool_use_id,
  });
  const prunedChars = unicodeChars(prunedText).length;
  if (prunedChars >= originalChars) return null;

  const payloadKeys = (['output', 'content', 'error'] as const).filter(key => response[key] !== undefined);
  const carrierKey = payloadKeys.find(key => !isSmallPayloadValue(response[key])) || 'output';
  const nextResponse: Record<string, unknown> = { [carrierKey]: prunedText };
  for (const key of payloadKeys) {
    if (key !== carrierKey && isSmallPayloadValue(response[key])) nextResponse[key] = structuredClone(response[key]);
  }
  for (const [key, value] of Object.entries(response)) {
    if (!Object.prototype.hasOwnProperty.call(nextResponse, key)
      && TOOL_RESPONSE_METADATA_KEYS.has(key) && isSmallMetadataValue(value)) {
      nextResponse[key] = structuredClone(value);
    }
  }

  return {
    part: {
      ...structuredClone(part),
      functionResponse: {
        ...structuredClone(functionResponse),
        response: nextResponse,
      },
    },
    originalChars,
    prunedChars,
  };
}

export type ToolResponsePrunePlan = ToolNoiseCompactionResult & {
  snapshotHistory: Message[];
  rewrittenHistory: Message[];
  validatedArchiveSeqs: number[];
};

function toolResponsePruneResult(plan: ToolResponsePrunePlan): ToolNoiseCompactionResult {
  const { snapshotHistory: _snapshotHistory, rewrittenHistory: _rewrittenHistory, validatedArchiveSeqs: _validatedArchiveSeqs, ...result } = plan;
  return result;
}

export async function buildToolResponsePrunePlan(
  sessionId: string,
  session: Pick<Session, 'history' | 'persistentMemorySnapshot'>,
  keepPercent: number = COMPACT_PERCENT,
): Promise<ToolResponsePrunePlan> {
  const snapshotHistory = structuredClone(session.history);
  const splitIndex = resolveCompactionSplitIndex(snapshotHistory, keepPercent);
  let replacedFunctionResponses = 0;
  let touchedMessages = 0;
  const validatedArchiveSeqs: number[] = [];
  const activeSeqCounts = new Map<number, number>();
  for (const message of snapshotHistory) {
    const seq = message.__meta?.seq;
    if (isPositiveSafeInteger(seq)) activeSeqCounts.set(seq, (activeSeqCounts.get(seq) || 0) + 1);
  }
  const candidateSeqs = snapshotHistory.slice(0, splitIndex).flatMap(message =>
    message.parts.some(part => !!part.functionResponse) && isPositiveSafeInteger(message.__meta?.seq) ? [message.__meta!.seq!] : []);
  const archiveRecords = candidateSeqs.length
    ? await readArchiveMessagesBySeqRange(sessionId, Math.min(...candidateSeqs), Math.max(...candidateSeqs)) : [];
  const archiveBySeq = new Map<number, typeof archiveRecords>();
  for (const record of archiveRecords) { const records = archiveBySeq.get(record.seq) || []; records.push(record); archiveBySeq.set(record.seq, records); }

  const rewrittenOlder = snapshotHistory.slice(0, splitIndex).map(message => {
    let touched = false;
    const seq = message.__meta?.seq;
    const records = isPositiveSafeInteger(seq) ? archiveBySeq.get(seq) : undefined;
    const validArchive = isPositiveSafeInteger(seq) && activeSeqCounts.get(seq) === 1
      && records?.length === 1 && isDeepStrictEqual(
      normalizedRawMessageForArchiveComparison(message),
      normalizedRawMessageForArchiveComparison(records[0].message),
    );
    const parts = message.parts.map(part => {
      if (!validArchive) return structuredClone(part);
      const pruned = buildPrunedFunctionResponse(message, part);
      if (!pruned) return structuredClone(part);
      replacedFunctionResponses += 1;
      if (isPositiveSafeInteger(seq) && !validatedArchiveSeqs.includes(seq)) validatedArchiveSeqs.push(seq);
      touched = true;
      return pruned.part;
    });
    if (touched) touchedMessages += 1;
    return { ...structuredClone(message), parts };
  });
  const rewrittenHistory = [...rewrittenOlder, ...structuredClone(snapshotHistory.slice(splitIndex))];
  const estimatedTokensBefore = estimateSessionTokens({ history: snapshotHistory, persistentMemorySnapshot: session.persistentMemorySnapshot });
  const estimatedTokensAfter = estimateSessionTokens({ history: rewrittenHistory, persistentMemorySnapshot: session.persistentMemorySnapshot });

  return {
    snapshotHistory,
    rewrittenHistory,
    validatedArchiveSeqs,
    replacedFunctionCalls: 0,
    replacedFunctionResponses,
    touchedMessages,
    inspectedMessages: splitIndex,
    keepStartIndex: splitIndex,
    thresholdTokens: 0,
    estimatedTokensBefore,
    estimatedTokensAfter,
    estimatedTokensSaved: Math.max(0, estimatedTokensBefore - estimatedTokensAfter),
    retainedHeadChars: TOOL_RESPONSE_RETAIN_HEAD_CHARS,
    retainedTailChars: TOOL_RESPONSE_RETAIN_TAIL_CHARS,
    minimumResponseChars: TOOL_RESPONSE_RETAIN_HEAD_CHARS + TOOL_RESPONSE_RETAIN_TAIL_CHARS + 1,
  };
}

export async function commitToolResponsePrunePlan(
  deps: SessionHistoryDeps,
  sessionId: string,
  plan: ToolResponsePrunePlan,
  maximumEstimatedTokens?: number,
): Promise<{ committed: boolean; result: ToolNoiseCompactionResult }> {
  const session = deps.getSessionById(sessionId);
  const baseResult = toolResponsePruneResult(plan);
  if (!session || plan.replacedFunctionResponses === 0 || !hasCompatibleHistoryPrefix(session.history, plan.snapshotHistory)) {
    return { committed: false, result: { ...baseResult, replacedFunctionResponses: 0, touchedMessages: 0, estimatedTokensSaved: 0 } };
  }
  for (const seq of plan.validatedArchiveSeqs) {
    const records = await readArchiveMessagesBySeqRange(sessionId, seq, seq);
    const active = plan.snapshotHistory.filter(message => message.__meta?.seq === seq);
    if (records.length !== 1 || active.length !== 1 || !isDeepStrictEqual(
      normalizedRawMessageForArchiveComparison(active[0]),
      normalizedRawMessageForArchiveComparison(records[0].message),
    )) return { committed: false, result: { ...baseResult, replacedFunctionResponses: 0, touchedMessages: 0, estimatedTokensSaved: 0 } };
  }

  const rewrittenHistory = [...plan.rewrittenHistory, ...structuredClone(session.history.slice(plan.snapshotHistory.length))];
  const estimatedTokensBefore = estimateSessionTokens(session);
  const estimatedTokensAfter = estimateSessionTokens({ history: rewrittenHistory, persistentMemorySnapshot: session.persistentMemorySnapshot });
  const result: ToolNoiseCompactionResult = {
    ...baseResult,
    estimatedTokensBefore,
    estimatedTokensAfter,
    estimatedTokensSaved: Math.max(0, estimatedTokensBefore - estimatedTokensAfter),
  };
  if (maximumEstimatedTokens !== undefined && estimatedTokensAfter > maximumEstimatedTokens) {
    return { committed: false, result };
  }

  const beforeCommit = captureSessionSemanticState(session);
  session.history = rewrittenHistory;
  session.historyVersion = (session.historyVersion || 0) + 1;
  session.indexingState = undefined;
  if (session.vectorIndexPosition !== undefined) session.vectorIndexPosition = Math.min(session.vectorIndexPosition, session.history.length);
  try {
    await deps.saveSession(sessionId);
    return { committed: true, result };
  } catch (error) {
    if (!isSessionAuthorityPostCommitError(error)) restoreSessionSemanticState(session, beforeCommit);
    throw error;
  }
}

function normalizeSeqRange(startSeq?: number, endSeq?: number): { startSeq?: number; endSeq?: number } {
  if (typeof startSeq === 'number' && typeof endSeq === 'number' && startSeq > endSeq) {
    return { startSeq: endSeq, endSeq: startSeq };
  }

  return { startSeq, endSeq };
}

function cloneSessionForCompactJob(session: Session, historySnapshot: Message[]): Session {
  const cloned: Session = {
    id: session.id,
    agent: session.agent,
    aliases: session.aliases ? [...session.aliases] : undefined,
    history: structuredClone(historySnapshot),
    persistentMemorySnapshot: session.persistentMemorySnapshot,
    stats: structuredClone(session.stats),
    busy: false,
    queue: [],
    meta: structuredClone(session.meta),
    displayName: session.displayName,
    archived: session.archived,
    currentNode: session.currentNode,
    model: session.model,
    effort: session.effort,
    childModelDefault: session.childModelDefault,
    childEffortDefault: session.childEffortDefault,
    verbose: session.verbose,
    vectorIndexPosition: session.vectorIndexPosition,
    indexingState: session.indexingState ? structuredClone(session.indexingState) : undefined,
    historyVersion: session.historyVersion,
    nextMessageSeq: session.nextMessageSeq,
    nextBlockId: session.nextBlockId,
    parentSessionId: session.parentSessionId,
    goalState: session.goalState ? structuredClone(session.goalState) : undefined,
    compactThresholdTokens: session.compactThresholdTokens,
    // Compact jobs are transient sessions, but their LLM requests should share
    // the real session's prompt-cache routing key so compaction can reuse the
    // same cached system/history prefix as ordinary turns.
    promptCacheKey: llm.ensurePromptCacheKey(session),
  };
  (cloned as any).__compactJob = true;
  return cloned;
}

function buildCompactJobSnapshot(session: Session, options: CompactionRunOptions = {}): CompactJobSnapshot | null {
  const keepPercent = typeof options.keepPercent === 'number' ? options.keepPercent : COMPACT_PERCENT;
  const completionMarker = options.completionMarker || 'Compaction completed.';
  const completionBroadcastMessage = options.completionBroadcastMessage?.trim() || undefined;
  const compactGuidance = options.compactGuidance?.trim();
  const historySnapshot = structuredClone(session.history);

  if (historySnapshot.length < 1) {
    return null;
  }

  return {
    sessionId: session.id,
    baseHistoryVersion: session.historyVersion || 0,
    historySnapshot,
    transientSession: cloneSessionForCompactJob(session, historySnapshot),
    keepPercent,
    completionMarker,
    completionBroadcastMessage,
    compactGuidance,
  };
}

async function ensureCompactPromptCacheKeyPersisted(deps: SessionHistoryDeps, session: Session): Promise<void> {
  const previousPromptCacheKey = session.promptCacheKey;
  llm.ensurePromptCacheKey(session);
  if (session.id && session.promptCacheKey !== previousPromptCacheKey) {
    await deps.saveSession(session.id);
  }
}

function appendTransientSessionMessage(session: Session, message: Message): Promise<void> {
  session.history.push(message);
  return Promise.resolve();
}

function hasCompatibleHistoryPrefix(currentHistory: Message[], snapshotHistory: Message[]): boolean {
  if (currentHistory.length < snapshotHistory.length) {
    return false;
  }
  for (let index = 0; index < snapshotHistory.length; index += 1) {
    if (!isDeepStrictEqual(currentHistory[index], snapshotHistory[index])) {
      return false;
    }
  }

  return true;
}

export type LayeredCompactCandidateEntry = {
  item: CompactCandidateItem;
  historyStartIndex: number;
  historyEndIndex: number;
};

type LayeredCompactCandidateBuildResult = {
  candidateEntries: LayeredCompactCandidateEntry[];
  preservedMessageCandidates: PreservedMessageCandidateItem[];
  messagePolicy: MessageCompactionPolicy;
  blockPolicies: BlockCompactionPolicy[];
};

function normalizedRawMessageForArchiveComparison(message: Message): Message {
  const normalized = structuredClone(message);
  if (normalized.__meta) {
    delete normalized.__meta.preservedFromBlockId;
    delete normalized.__meta.goalAnchorSeq;
  }
  return normalized;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

export function isSingleBlockCompactionStrandedBetweenHigherLevelBlocks(
  olderHistory: Message[],
  historyIndex: number,
): boolean {
  const current = olderHistory[historyIndex]?.__meta?.contextBlock;
  const previous = olderHistory[historyIndex - 1]?.__meta?.contextBlock;
  const next = olderHistory[historyIndex + 1]?.__meta?.contextBlock;
  return !!current && !!previous && !!next && previous.level > current.level && next.level > current.level;
}

export function resolveCompactionSplitIndex(history: Message[], keepPercent: number): number {
  let splitIndex = keepPercent > 0
    ? Math.floor(history.length * (1 - keepPercent))
    : history.length;

  if (keepPercent > 0) {
    if (splitIndex < history.length && history[splitIndex].role === 'tool') {
      let cursor = splitIndex;
      while (cursor > 0 && history[cursor].role === 'tool') {
        cursor -= 1;
      }

      if (history[cursor]?.role === 'model' && history[cursor].parts?.some(part => !!part.functionCall)) {
        splitIndex = cursor;
      }
    }
  }

  return splitIndex;
}

function isPreservedMessage(message: Message): boolean {
  return Number.isSafeInteger(message.__meta?.preservedFromBlockId) && (message.__meta?.preservedFromBlockId || 0) > 0;
}

export function buildCreatedBlockHistoryWithPreservedMessages(
  createdBlock: Parameters<typeof renderBlockMessage>[0],
  sourceMessages: Message[],
  preservedSeqs: number[],
): Message[] {
  const preserved = new Set(preservedSeqs);
  return [renderBlockMessage(createdBlock), ...sourceMessages.filter(message => preserved.has(message.__meta?.seq || 0)).map(message => ({
    ...structuredClone(message),
    __meta: { ...(message.__meta || {}), preservedFromBlockId: createdBlock.id },
  }))];
}

export function removePreservedMessages(history: Message[], removeSeqs: Set<number>): Message[] {
  if (removeSeqs.size === 0) {
    return history;
  }
  return history.filter(message => !(isPreservedMessage(message) && removeSeqs.has(message.__meta?.seq || 0)));
}

export async function buildLayeredCompactCandidateEntries(sessionId: string, olderHistory: Message[]): Promise<LayeredCompactCandidateBuildResult> {
  const [archiveMessages, archiveBlocks] = await Promise.all([
    readArchiveMessages(sessionId),
    readArchiveBlocksByIdRange(sessionId),
  ]);
  const archiveMessagesBySeq = new Map<number, typeof archiveMessages>();
  for (const record of archiveMessages) {
    const records = archiveMessagesBySeq.get(record.seq) || [];
    records.push(record); archiveMessagesBySeq.set(record.seq, records);
  }
  const archiveBlocksById = new Map<number, typeof archiveBlocks>();
  for (const record of archiveBlocks) {
    const records = archiveBlocksById.get(record.id) || [];
    records.push(record); archiveBlocksById.set(record.id, records);
  }
  const activeSeqCounts = new Map<number, number>();
  const activeBlockIdCounts = new Map<number, number>();
  for (const message of olderHistory) {
    const blockId = message.__meta?.contextBlock?.id;
    const seq = message.__meta?.seq;
    if (isPositiveSafeInteger(blockId)) activeBlockIdCounts.set(blockId, (activeBlockIdCounts.get(blockId) || 0) + 1);
    else if (isPositiveSafeInteger(seq)) activeSeqCounts.set(seq, (activeSeqCounts.get(seq) || 0) + 1);
  }

  const hasValidRawProvenance = (message: Message): boolean => {
    const seq = message.__meta?.seq;
    if (!isPositiveSafeInteger(seq) || activeSeqCounts.get(seq) !== 1) return false;
    const records = archiveMessagesBySeq.get(seq);
    return records?.length === 1 && isDeepStrictEqual(
      normalizedRawMessageForArchiveComparison(message),
      normalizedRawMessageForArchiveComparison(records[0].message),
    );
  };
  const hasValidBlockProvenance = (message: Message): boolean => {
    const block = message.__meta?.contextBlock;
    if (!block || !isPositiveSafeInteger(block.id) || activeBlockIdCounts.get(block.id) !== 1
      || !isPositiveSafeInteger(block.level) || !isPositiveSafeInteger(block.sourceStart)
      || !isPositiveSafeInteger(block.sourceEnd) || !isPositiveSafeInteger(block.rawStartSeq)
      || !isPositiveSafeInteger(block.rawEndSeq) || block.rawStartSeq > block.rawEndSeq) return false;
    const records = archiveBlocksById.get(block.id);
    if (records?.length !== 1) return false;
    const record = records[0];
    const expected = renderBlockMessage(record);
    const expectedBlock = expected.__meta!.contextBlock!;
    const activeBlock = message.__meta!.contextBlock!;
    const { sourceSessionId: expectedSourceSessionId, inherited: expectedInherited, ...expectedCore } = expectedBlock;
    const { sourceSessionId: activeSourceSessionId, inherited: activeInherited, ...activeCore } = activeBlock;
    if (message.role !== expected.role || !isDeepStrictEqual(message.parts, expected.parts)
      || message.__meta?.timestamp !== expected.__meta?.timestamp || !isDeepStrictEqual(activeCore, expectedCore)
      || (activeSourceSessionId !== undefined && activeSourceSessionId !== expectedSourceSessionId)
      || (activeInherited !== undefined && activeInherited !== expectedInherited)) return false;
    if (record.sourceKind === 'message') {
      if (record.sourceStart > record.sourceEnd) return false;
      for (let seq = record.sourceStart; seq <= record.sourceEnd; seq += 1) {
        if (archiveMessagesBySeq.get(seq)?.length !== 1) return false;
      }
      return true;
    }
    if (!Array.isArray(record.sourceBlockIds) || record.sourceBlockIds.length === 0
      || record.sourceBlockIds[0] !== record.sourceStart || record.sourceBlockIds.at(-1) !== record.sourceEnd
      || new Set(record.sourceBlockIds).size !== record.sourceBlockIds.length) return false;
    return record.sourceBlockIds.every(sourceId => {
      const sources = archiveBlocksById.get(sourceId);
      return sources?.length === 1 && sources[0].level === record.level - 1;
    });
  };
  const blockRecordsByLevel = new Map<number, Array<{ id: number; summary: string }>>();
  for (const message of olderHistory) {
    const block = message.__meta?.contextBlock;
    if (!block) continue;
    const records = blockRecordsByLevel.get(block.level) || [];
    records.push({ id: block.id, summary: formatMessagePreviewText(message, Number.MAX_SAFE_INTEGER, { skipThinking: true }) });
    blockRecordsByLevel.set(block.level, records);
  }

  const candidateBlockIdsByLevel = new Map<number, Set<number>>();
  const preliminaryBlockPolicies: BlockCompactionPolicy[] = [];
  for (const [sourceLevel, records] of blockRecordsByLevel.entries()) {
    const totalTokens = records.reduce((sum, record) => sum + estimateTokenCount(record.summary || ''), 0);
    const window = calculateBlockCompactionWindow({
      totalBlockCount: records.length, totalTokens, minTokens: COMPACT_BLOCK_LEVEL_MIN_TOKENS,
      forceTokens: COMPACT_BLOCK_LEVEL_FORCE_TOKENS, candidateFraction: COMPACT_BLOCK_CANDIDATE_FRACTION,
      forceCompactFraction: COMPACT_BLOCK_FORCE_COMPACT_FRACTION,
    });
    candidateBlockIdsByLevel.set(sourceLevel, new Set(records.slice(0, window.candidateBlockCount).map(record => record.id)));
    preliminaryBlockPolicies.push({
      sourceLevel, totalBlockCount: records.length, totalTokens,
      forcedKeepNewestCount: window.forcedKeepNewestCount, candidateBlockCount: window.candidateBlockCount,
      requestedMinBlocks: window.requestedMinBlocks, feasibleMaxBlocks: 0, effectiveMinBlocks: 0,
      ...(totalTokens < COMPACT_BLOCK_LEVEL_MIN_TOKENS
        ? { skippedReason: `below the ${COMPACT_BLOCK_LEVEL_MIN_TOKENS}-token block eligibility threshold` }
        : window.candidateBlockCount === 0 ? { skippedReason: 'the strict oldest-candidate window is empty at this level size' } : {}),
    });
  }

  const entries: LayeredCompactCandidateEntry[] = [];
  const preservedMessageCandidates: PreservedMessageCandidateItem[] = [];
  let compactSegmentId = 1;
  let priorCandidateKind: 'message' | 'block' | undefined;
  let previousRawSeq: number | undefined;
  let previousBlockRawEndSeq: number | undefined;
  for (let historyIndex = 0; historyIndex < olderHistory.length; historyIndex += 1) {
    const message = olderHistory[historyIndex];
    if (isPreservedMessage(message)) {
      if (hasValidRawProvenance(message) && !shouldIgnoreMessageInCompactCandidates(message)) {
        const seq = message.__meta!.seq!;
        preservedMessageCandidates.push({
          seq, key: `M#${seq}`, preservedFromBlockId: message.__meta!.preservedFromBlockId!,
          preview: formatMessagePreviewText(message, 300, {
            skipEphemeralSystem: true, skipRagMemorySnippets: true, skipThinking: true,
          }).trim() || '[empty message]',
        });
      }
      compactSegmentId += 1; priorCandidateKind = undefined; previousRawSeq = undefined; previousBlockRawEndSeq = undefined;
      continue;
    }
    const block = message.__meta?.contextBlock;
    if (block) {
      previousRawSeq = undefined;
      if (!hasValidBlockProvenance(message)) {
        compactSegmentId += 1; priorCandidateKind = undefined; previousBlockRawEndSeq = undefined; continue;
      }
      if (priorCandidateKind && priorCandidateKind !== 'block') compactSegmentId += 1;
      if (!candidateBlockIdsByLevel.get(block.level)?.has(block.id)) {
        compactSegmentId += 1; priorCandidateKind = undefined; previousBlockRawEndSeq = undefined; continue;
      }
      if (previousBlockRawEndSeq !== undefined && block.rawStartSeq <= previousBlockRawEndSeq) compactSegmentId += 1;
      entries.push({
        item: buildBlockCandidateItem(block.id, block.level, block.rawStartSeq, block.rawEndSeq,
          formatMessagePreviewText(message, Number.MAX_SAFE_INTEGER, { skipThinking: true }),
          estimateTokenCount(formatMessagePreviewText(message, Number.MAX_SAFE_INTEGER, { skipThinking: true })),
          isSingleBlockCompactionStrandedBetweenHigherLevelBlocks(olderHistory, historyIndex), compactSegmentId),
        historyStartIndex: historyIndex, historyEndIndex: historyIndex,
      });
      priorCandidateKind = 'block';
      previousBlockRawEndSeq = block.rawEndSeq;
      continue;
    }
    previousBlockRawEndSeq = undefined;
    const seq = message.__meta?.seq;
    if (!Number.isSafeInteger(seq) || (seq || 0) < 1) { compactSegmentId += 1; priorCandidateKind = undefined; continue; }
    if (!hasValidRawProvenance(message) || (previousRawSeq !== undefined && seq !== previousRawSeq + 1)) {
      compactSegmentId += 1; priorCandidateKind = undefined; previousRawSeq = seq; continue;
    }
    if (!isModelVisibleMessage(message) || shouldRemoveOldCompactCompletionMessage(message)) {
      previousRawSeq = seq;
      continue;
    }
    if (shouldIgnoreMessageInCompactCandidates(message)) { compactSegmentId += 1; priorCandidateKind = undefined; continue; }
    if (priorCandidateKind && priorCandidateKind !== 'message') compactSegmentId += 1;

    let groupedEndHistoryIndex = historyIndex;
    const groupedMessages = [message];
    if (message.role === 'model' && message.parts?.some(part => !!part.functionCall)) {
      for (let nextIndex = historyIndex + 1; nextIndex < olderHistory.length; nextIndex += 1) {
        const next = olderHistory[nextIndex];
        if (next.__meta?.contextBlock || isPreservedMessage(next) || next.role !== 'tool' || !Number.isSafeInteger(next.__meta?.seq)) break;
        const previousGroupedSeq = groupedMessages[groupedMessages.length - 1].__meta?.seq;
        if (!hasValidRawProvenance(next) || next.__meta!.seq !== (previousGroupedSeq || 0) + 1) break;
        groupedMessages.push(next); groupedEndHistoryIndex = nextIndex;
      }
    }
    const preview = groupedMessages.filter(isModelVisibleMessage).map(item => formatMessagePreviewText(item, 50, {
      skipEphemeralSystem: true, skipRagMemorySnippets: true, skipThinking: true,
    }).trim()).filter(Boolean).join(' | ') || '[empty message]';
    const estimatedTokens = groupedMessages.filter(isModelVisibleMessage).reduce((sum, item) => sum + estimateTokenCount(
      formatMessagePreviewText(item, Number.MAX_SAFE_INTEGER, { skipEphemeralSystem: true, skipRagMemorySnippets: true, skipThinking: true })
    ), 0);
    entries.push({
      item: buildMessageCandidateItem(seq!, groupedMessages[groupedMessages.length - 1].__meta!.seq!, preview, estimatedTokens, compactSegmentId),
      historyStartIndex: historyIndex, historyEndIndex: groupedEndHistoryIndex,
    });
    priorCandidateKind = 'message';
    previousRawSeq = groupedMessages[groupedMessages.length - 1].__meta!.seq!;
    historyIndex = groupedEndHistoryIndex;
  }

  const rawItems = entries.filter(entry => entry.item.kind === 'message').map(entry => entry.item);
  const totalRawTokens = rawItems.reduce((sum, item) => sum + Math.max(0, item.estimatedTokens || 0), 0);
  const rawEligible = selectCompactCandidateTargetLevels(rawItems).has(1);
  const candidateEntries = entries.filter(entry => entry.item.kind === 'block' || rawEligible);
  const rawFraction = clampCompactFraction(COMPACT_MESSAGE_FORCE_COMPACT_FRACTION, 0.2);
  const eligibleRawTokens = rawEligible ? totalRawTokens : 0;
  const requestedRawTokens = rawEligible ? Math.ceil(eligibleRawTokens * rawFraction) : 0;
  const messagePolicy: MessageCompactionPolicy = {
    thresholdTokens: COMPACT_LEVEL_TOKEN_THRESHOLD, totalCandidateTokens: totalRawTokens, eligibleTokens: eligibleRawTokens,
    requestedMinTokens: requestedRawTokens, feasibleMaxTokens: eligibleRawTokens,
    effectiveMinTokens: Math.min(requestedRawTokens, eligibleRawTokens),
    ...(!rawEligible ? { skippedReason: totalRawTokens > 0
      ? `~${totalRawTokens} raw-message tokens do not exceed the ${COMPACT_LEVEL_TOKEN_THRESHOLD}-token eligibility threshold`
      : 'no eligible model-visible raw message candidates' } : {}),
  };
  const blockPolicies = preliminaryBlockPolicies.map(policy => {
    const levelEntries = candidateEntries.filter(entry => entry.item.kind === 'block' && entry.item.level === policy.sourceLevel);
    let feasibleMaxBlocks = 0, runLength = 0, previousCandidateIndex = -2; let previousSegmentId: number | undefined;
    const flush = () => { if (runLength >= 2) feasibleMaxBlocks += runLength; runLength = 0; };
    for (const entry of levelEntries) {
      const candidateIndex = candidateEntries.indexOf(entry); const segmentId = entry.item.segmentId ?? 0;
      if (runLength > 0 && (candidateIndex !== previousCandidateIndex + 1 || segmentId !== previousSegmentId)) flush();
      runLength += 1; previousSegmentId = segmentId; previousCandidateIndex = candidateIndex;
    }
    flush();
    const effectiveMinBlocks = Math.min(policy.requestedMinBlocks, feasibleMaxBlocks);
    return { ...policy, feasibleMaxBlocks, effectiveMinBlocks,
      ...(policy.requestedMinBlocks > 0 && feasibleMaxBlocks === 0 ? { skippedReason: 'no legal contiguous multi-block candidate segment is available' } : {}) };
  }).sort((a, b) => a.sourceLevel - b.sourceLevel);
  return { candidateEntries, preservedMessageCandidates, messagePolicy, blockPolicies };
}

function filterRetainedHistory(history: Message[], removePreservedSeqs: Set<number>): Message[] {
  return removePreservedMessages(history, removePreservedSeqs)
    .filter(message => isModelVisibleMessage(message) && !shouldRemoveOldCompactCompletionMessage(message));
}

export function resolveCreateBlockRanges(plan: CompactPlan, candidateEntries: LayeredCompactCandidateEntry[]): Array<{ planIndex: number; startIndex: number; endIndex: number; historyStartIndex: number; historyEndIndex: number; rawStartSeq: number; rawEndSeq: number; sourceKind: 'message' | 'block'; level: number; sourceStart: number; sourceEnd: number; sourceBlockIds?: number[]; summary: string; memoryFacts?: ExtractedMemoryFact[]; }> {
  const operations: Array<{ planIndex: number; startIndex: number; endIndex: number; historyStartIndex: number; historyEndIndex: number; rawStartSeq: number; rawEndSeq: number; sourceKind: 'message' | 'block'; level: number; sourceStart: number; sourceEnd: number; sourceBlockIds?: number[]; summary: string; memoryFacts?: ExtractedMemoryFact[]; }> = [];
  const candidateItems = candidateEntries.map(entry => entry.item);

  for (let planIndex = 0; planIndex < plan.createBlocks.length; planIndex += 1) {
    const block = plan.createBlocks[planIndex];
    let startIndex = -1;
    let endIndex = -1;

    if (block.sourceKind === 'message') {
      for (let index = 0; index < candidateItems.length; index += 1) {
        const item = candidateItems[index];
        if (item.kind === 'message' && item.startSeq === block.sourceStart) {
          startIndex = index;
          break;
        }
      }
      if (startIndex < 0) {
        throw new Error(`Unable to resolve layered compact message range ${block.sourceStart}-${block.sourceEnd}.`);
      }
      const startSegmentId = candidateItems[startIndex].segmentId ?? 0;
      for (let index = startIndex; index < candidateItems.length; index += 1) {
        const item = candidateItems[index];
        if (item.kind !== 'message' || (item.segmentId ?? 0) !== startSegmentId) {
          break;
        }
        endIndex = index;
        if (item.endSeq === block.sourceEnd) {
          break;
        }
      }
      if (endIndex < startIndex || candidateItems[endIndex]?.kind !== 'message' || (candidateItems[endIndex] as Extract<CompactCandidateItem, { kind: 'message' }>).endSeq !== block.sourceEnd) {
        throw new Error(`Unable to resolve layered compact message range ${block.sourceStart}-${block.sourceEnd}.`);
      }
      const startEntry = candidateEntries[startIndex];
      const endEntry = candidateEntries[endIndex];
      operations.push({
        planIndex,
        startIndex,
        endIndex,
        historyStartIndex: startEntry.historyStartIndex,
        historyEndIndex: endEntry.historyEndIndex,
        rawStartSeq: block.sourceStart,
        rawEndSeq: block.sourceEnd,
        sourceKind: block.sourceKind,
        level: block.level,
        sourceStart: block.sourceStart,
        sourceEnd: block.sourceEnd,
        summary: block.summary,
        memoryFacts: block.memoryFacts,
      });
      continue;
    }

    for (let index = 0; index < candidateItems.length; index += 1) {
      const item = candidateItems[index];
      if (item.kind === 'block' && item.id === block.sourceStart && item.level === block.level - 1) {
        startIndex = index;
        break;
      }
    }
    if (startIndex < 0) {
      throw new Error(`Unable to resolve layered compact block range ${block.sourceStart}-${block.sourceEnd}.`);
    }
    const startSegmentId = candidateItems[startIndex].segmentId ?? 0;
    for (let index = startIndex; index < candidateItems.length; index += 1) {
      const item = candidateItems[index];
      if (item.kind !== 'block' || item.level !== block.level - 1 || (item.segmentId ?? 0) !== startSegmentId) {
        break;
      }
      endIndex = index;
      if (item.id === block.sourceEnd) {
        break;
      }
    }
    const startItem = candidateItems[startIndex];
    const endItem = candidateItems[endIndex];
    if (endIndex < startIndex || startItem.kind !== 'block' || endItem?.kind !== 'block' || endItem.id !== block.sourceEnd) {
      throw new Error(`Unable to resolve layered compact block range ${block.sourceStart}-${block.sourceEnd}.`);
    }
    const startEntry = candidateEntries[startIndex];
    const endEntry = candidateEntries[endIndex];
    const sourceBlockIds = candidateItems
      .slice(startIndex, endIndex + 1)
      .flatMap(item => item.kind === 'block' ? [item.id] : []);
    operations.push({
      planIndex,
      startIndex,
      endIndex,
      historyStartIndex: startEntry.historyStartIndex,
      historyEndIndex: endEntry.historyEndIndex,
      rawStartSeq: startItem.rawStartSeq,
      rawEndSeq: endItem.rawEndSeq,
      sourceKind: block.sourceKind,
      level: block.level,
      sourceStart: block.sourceStart,
      sourceEnd: block.sourceEnd,
      sourceBlockIds,
      summary: block.summary,
      memoryFacts: block.memoryFacts,
    });
  }

  return operations.sort((a, b) => a.startIndex - b.startIndex || a.planIndex - b.planIndex);
}

/** Extract skill names from current skill(load) and persisted legacy load_skill calls. */
function extractCompactedSkillNames(history: Message[], consumedHistoryCount: number): string[] {
  const skillNames = new Set<string>();
  // Scan messages that correspond to the consumed active-history portion.
  const scanLimit = Math.min(consumedHistoryCount, history.length);
  for (let i = 0; i < scanLimit; i++) {
    const msg = history[i];
    if (!msg.parts) continue;
    for (const part of msg.parts) {
      const call = part.functionCall;
      const isCurrentLoad = call?.name === 'skill' && call.args?.action === 'load';
      const isLegacyLoad = call?.name === 'load_skill';
      if (isCurrentLoad || isLegacyLoad) {
        const skillName = call?.args?.skillName;
        if (typeof skillName === 'string' && skillName.trim()) {
          skillNames.add(skillName.trim());
        }
      }
    }
  }
  return [...skillNames];
}

async function finalizeCompaction(
  deps: SessionHistoryDeps,
  sessionId: string,
  session: Session,
  newHistory: Message[],
  completionMarker: string,
  completionBroadcastMessage: string | undefined,
  createdBlockCount: number,
  replacedItemCount: number,
  compactedSkillNames: string[] = [],
  insertedCompletionMessages: Awaited<ReturnType<typeof appendMessagesToArchive>> = [],
): Promise<void> {
  session.persistentMemorySnapshot = await llm.buildSessionSystemPromptSnapshot({
    agentName: session.agent || 'main',
    sessionId,
    systemPromptFiles: session.systemPromptFiles,
  });
  session.history = newHistory;

  const completionText = formatCompactionCompletionMarker(sessionId, completionMarker, session.parentSessionId, compactedSkillNames, Date.now());
  const hasCompletionGoalReminder = !!session.goalState?.goal?.trim();
  const completionParts: MessagePart[] = buildSystemMessageParts(completionText);
  if (hasCompletionGoalReminder) {
    completionParts.push(...buildSystemMessageParts(formatSessionGoalReminderText(session.goalState.goal)));
  }

  const completionMessage: Message = {
    role: 'user',
    parts: completionParts,
    __meta: {
      timestamp: Date.now(),
      ...(hasCompletionGoalReminder ? { goalReminder: true, goalReminderKind: 'compact-completion' } : {}),
    },
  };
  insertedCompletionMessages.push(...await appendMessagesToArchive(session, [completionMessage]));
  session.history.push(completionMessage);
  const completionSeq = completionMessage.__meta!.seq!;
  if (hasCompletionGoalReminder && session.goalState) {
    session.goalState.anchorSeq = completionSeq;
    completionMessage.__meta!.goalAnchorSeq = completionSeq;
  }

  session.vectorIndexPosition = 0;
  session.historyVersion = (session.historyVersion || 0) + 1;
  session.indexingState = undefined;
  await deps.saveSession(sessionId);
  logger.info({ createdBlockCount, replacedItemCount, renderedCount: session.history.length }, 'Layered context compaction completed successfully');
  compactPreviewLastTimestamp.delete(sessionId);

  if (session.broadcast) {
    session.broadcast(completionBroadcastMessage || `Layered-context compaction completed. Created ${createdBlockCount} block(s) replacing ${replacedItemCount} older item(s).`);
  }
}

export function formatCompactionCompletionMarker(sessionId: string, completionMarker: string, parentSessionId?: string, compactedSkillNames: string[] = [], timestamp?: Date | number): string {
  const legacySuffixRe = /^\s*\*\*COMPACTION COMPLETED\. PARENT SESSION `[^`]*`\. CURRENT SESSION ID IS `[^`]*`\.\*\*\s*/i;
  const markerWithoutSuffix = completionMarker.replace(legacySuffixRe, '');
  const extraMarkerText = markerWithoutSuffix
    .replace(/^\s*Compaction completed\.?\s*/i, '')
    .trim();

  const hintParts: string[] = [];
  if (extraMarkerText) {
    hintParts.push(extraMarkerText);
  }
  if (compactedSkillNames.length > 0) {
    const skillList = compactedSkillNames.map(s => `\`${s}\``).join(', ');
    hintParts.push(`Note: The following skill(s) were loaded with skill(action="load") but their content was compacted away: ${skillList}. If you still need them, call skill with action="load" again.`);
  }

  return formatFoxwarmSystemTag({
    kind: 'session-boundary',
    event: 'compact-completed',
    parentSessionId: parentSessionId || '(none)',
    currentSessionId: sessionId,
    time: timestamp === undefined ? undefined : formatLocalTimestamp(timestamp),
    hint: hintParts.length > 0 ? hintParts.join(' ') : undefined,
  });
}

async function runCompactJob(deps: SessionHistoryDeps, snapshot: CompactJobSnapshot): Promise<CompactJobResult> {
  const { sessionId, transientSession, historySnapshot, keepPercent, compactGuidance, completionMarker, completionBroadcastMessage } = snapshot;
  const splitIndex = resolveCompactionSplitIndex(historySnapshot, keepPercent);
  if (splitIndex <= 0) {
    logger.info({ sessionId, keepPercent }, 'Compaction skipped because there are no older messages to compact');
    return {
      status: 'noop',
      reason: 'no-older-messages',
      completionMarker,
      snapshotHistory: historySnapshot,
      consumedHistoryCount: splitIndex,
    };
  }

  const olderHistory = historySnapshot.slice(0, splitIndex);
  const forceKeptRecentHistory = splitIndex < historySnapshot.length ? historySnapshot.slice(splitIndex) : [];
  const { candidateEntries, preservedMessageCandidates, messagePolicy, blockPolicies } = await buildLayeredCompactCandidateEntries(sessionId, olderHistory);
  const candidateItems = candidateEntries.map(entry => entry.item);

  if (candidateItems.length === 0 && preservedMessageCandidates.length === 0) {
    const droppedDisplayOnlyCount = olderHistory.filter(message => !isModelVisibleMessage(message)).length;
    if (droppedDisplayOnlyCount > 0) {
      logger.info({ sessionId, splitIndex, droppedDisplayOnlyCount }, 'Compaction will drop display-only older messages without creating compact blocks');
      return {
        status: 'ready',
        completionMarker,
        completionBroadcastMessage,
        snapshotHistory: historySnapshot,
        consumedHistoryCount: splitIndex,
        operations: [],
        createdBlocks: [],
        preserveMessages: [],
        removePreservedMessages: [],
        replacedItemCount: droppedDisplayOnlyCount,
      };
    }

    logger.info({ sessionId, splitIndex, rawMessageReason: messagePolicy.skippedReason, blockPolicies }, 'Compaction skipped because no layered candidate items were produced');
    return {
      status: 'noop',
      reason: 'no-candidates',
      completionMarker,
      snapshotHistory: historySnapshot,
      consumedHistoryCount: splitIndex,
    };
  }

  const forcedKeptMessageItems = forceKeptRecentHistory.filter(message => Number.isSafeInteger(message.__meta?.seq));
  const forcedKeptStartSeq = forcedKeptMessageItems[0]?.__meta?.seq;
  const forcedKeptEndSeq = forcedKeptMessageItems[forcedKeptMessageItems.length - 1]?.__meta?.seq;
  const summaryPrompt = {
    system: buildCompactPromptText({
      forcedKeptCount: forceKeptRecentHistory.length,
      forcedKeptStartSeq,
      forcedKeptEndSeq,
      candidateItems,
      preservedMessages: preservedMessageCandidates,
      messagePolicy,
      blockPolicies,
      guidance: compactGuidance,
    })
  };

  let nextPromptParts: MessagePart[] | null = [summaryPrompt];
  let compactPlan: CompactPlan | null = null;
  let compactRoundsUsed = 0;
  let invalidCompactPlanAttempts = 0;

  while (compactRoundsUsed < COMPACT_FLOW_MAX_ROUNDS) {
    compactRoundsUsed += 1;
    const result = await llm.chat(nextPromptParts, transientSession, invalidCompactPlanAttempts, {
      appendMessage: async (message) => {
        await appendTransientSessionMessage(transientSession, message);
        mirrorTemporaryCompactMessage(deps, sessionId, message);
      },
      notifySessionEvents: false,
      registerAbortController: false,
      purpose: 'compact-plan',
    });

    const toolCalls = result.toolCalls || [];
    const onlyPlanCall = toolCalls.length === 1 && toolCalls[0].name === COMPACT_PLAN_TOOL_NAME;
    if (!onlyPlanCall) {
      const invalidToolName = toolCalls.find(call => call.name !== COMPACT_PLAN_TOOL_NAME)?.name || COMPACT_PLAN_TOOL_NAME;
      logger.warn({ sessionId, invalidToolName, toolCallCount: toolCalls.length, compactRoundsUsed }, 'Layered compact flow rejected a missing or non-plan tool call; retrying with feedback');
      const invalidToolNotice = toolCalls.length === 0
        ? `Compact planning must be submitted by calling ${COMPACT_PLAN_TOOL_NAME}; plain text/no tool call cannot complete compaction.`
        : invalidToolName === COMPACT_PLAN_TOOL_NAME
        ? `Call ${COMPACT_PLAN_TOOL_NAME} exactly once, by itself.`
        : `Do not call \`${invalidToolName}\`; the only accepted tool call during compaction is ${COMPACT_PLAN_TOOL_NAME}.`;
      nextPromptParts = [{
        system: [
          'COMPACT TOOL CALL INVALID.',
          invalidToolNotice,
          'Do not read or write agent memory during compaction.',
          `When ready, call exactly one ${COMPACT_PLAN_TOOL_NAME} tool call by itself. Do not combine ${COMPACT_PLAN_TOOL_NAME} with any other tool call.`,
        ].join(' '),
      }];
      continue;
    }

    try {
      compactPlan = validateCompactPlanArgs(result.toolCalls[0].args || {}, candidateItems, {
        removablePreservedMessages: preservedMessageCandidates,
        messagePolicy,
        blockPolicies,
      });
      break;
    } catch (e) {
      if (!(e instanceof CompactPlanValidationError)) {
        throw e;
      }

      invalidCompactPlanAttempts += 1;

      logger.warn({ sessionId, invalidCompactPlanAttempts, compactRoundsUsed, validationError: e.message }, 'Layered compact plan validation failed; retrying compact flow');
      nextPromptParts = [{
        system: buildCompactPlanValidationFeedback(e),
      }];
    }
  }

  if (!compactPlan) {
    throw new Error(`Compaction skipped after ${compactRoundsUsed} compact planning round(s) because no valid plan was produced via ${COMPACT_PLAN_TOOL_NAME}.`);
  }

  const operations = resolveCreateBlockRanges(compactPlan, candidateEntries);
  const preserveMessages = (compactPlan.preserveMessages || [])
    .map(seq => ({
      seq,
      operationIndex: operations.findIndex(operation => operation.sourceKind === 'message' && operation.rawStartSeq <= seq && operation.rawEndSeq >= seq),
    }))
    .filter(item => item.operationIndex >= 0)
    .sort((a, b) => a.operationIndex - b.operationIndex || a.seq - b.seq);
  const removePreservedMessages = compactPlan.removePreservedMessages || [];
  return {
    status: 'ready',
    completionMarker,
      completionBroadcastMessage,
    snapshotHistory: historySnapshot,
    consumedHistoryCount: splitIndex,
    operations: operations.map(operation => ({
      historyStartIndex: operation.historyStartIndex,
      historyEndIndex: operation.historyEndIndex,
      rawStartSeq: operation.rawStartSeq,
      rawEndSeq: operation.rawEndSeq,
      sourceKind: operation.sourceKind,
      level: operation.level,
      sourceStart: operation.sourceStart,
      sourceEnd: operation.sourceEnd,
      sourceBlockIds: operation.sourceBlockIds,
      summary: operation.summary,
      memoryFacts: operation.memoryFacts,
    })),
    createdBlocks: operations.map(operation => ({
      level: operation.level,
      sourceKind: operation.sourceKind,
      sourceStart: operation.sourceStart,
      sourceEnd: operation.sourceEnd,
      sourceBlockIds: operation.sourceBlockIds,
      rawStartSeq: operation.rawStartSeq,
      rawEndSeq: operation.rawEndSeq,
      summary: operation.summary,
      memoryFacts: operation.memoryFacts,
    })),
    preserveMessages,
    removePreservedMessages,
    replacedItemCount: operations.reduce((sum, operation) => sum + (operation.historyEndIndex - operation.historyStartIndex + 1), 0) + removePreservedMessages.length,
  };
}

async function applyCompactJobResult(deps: SessionHistoryDeps, sessionId: string, result: CompactJobResult): Promise<boolean> {
  if (result.status === 'noop') {
    return false;
  }

  const session = deps.getSessionById(sessionId);
  if (!session) {
    return false;
  }

  const currentHistory = session.history;
  if (!hasCompatibleHistoryPrefix(currentHistory, result.snapshotHistory)) {
    logger.warn({ sessionId, snapshotHistoryLength: result.snapshotHistory.length, currentHistoryLength: currentHistory.length }, 'Skipping async compact commit because active history changed incompatibly');
    return false;
  }

  const beforeCommit = captureSessionSemanticState(session);
  let insertedBlocks: Awaited<ReturnType<typeof appendBlocksToArchiveWithCommitInfo>>['insertedRecords'] = [];
  let insertedCompletionMessages: Awaited<ReturnType<typeof appendMessagesToArchive>> = [];
  try {
    const olderHistory = result.snapshotHistory.slice(0, result.consumedHistoryCount);
    const appendedBlocks = await appendBlocksToArchiveWithCommitInfo(session, result.createdBlocks);
    const createdRecords = appendedBlocks.records;
    insertedBlocks = appendedBlocks.insertedRecords;
    const removePreservedSeqs = new Set(result.removePreservedMessages || []);

    const rewrittenOlderHistory: Message[] = [];
    let cursor = 0;
    for (let index = 0; index < result.operations.length; index += 1) {
      const operation = result.operations[index];
      const createdRecord = createdRecords[index];
      if (cursor < operation.historyStartIndex) {
        rewrittenOlderHistory.push(...filterRetainedHistory(olderHistory.slice(cursor, operation.historyStartIndex), removePreservedSeqs));
      }
      const preservedForBlock = (result.preserveMessages || [])
        .filter(item => item.operationIndex === index)
        .map(item => item.seq);
      rewrittenOlderHistory.push(...buildCreatedBlockHistoryWithPreservedMessages(
        createdRecord,
        olderHistory.slice(operation.historyStartIndex, operation.historyEndIndex + 1),
        preservedForBlock,
      ));
      cursor = operation.historyEndIndex + 1;
    }
    if (cursor < olderHistory.length) {
      rewrittenOlderHistory.push(...filterRetainedHistory(olderHistory.slice(cursor), removePreservedSeqs));
    }

    const newHistory = [...rewrittenOlderHistory, ...currentHistory.slice(result.consumedHistoryCount)]
      .filter(message => !shouldRemoveOldCompactCompletionMessage(message));

    // Scan compacted messages for current and persisted legacy skill-load calls.
    const compactedSkillNames = extractCompactedSkillNames(result.snapshotHistory, result.consumedHistoryCount);

    await finalizeCompaction(
      deps, sessionId, session, newHistory, result.completionMarker,
      result.completionBroadcastMessage, createdRecords.length,
      result.replacedItemCount, compactedSkillNames, insertedCompletionMessages,
    );

    for (const record of createdRecords) {
      if (!record.memoryFacts?.length) continue;
      void vector.indexMemoryFactsFromCompaction({
        sessionId, agent: session.agent || 'main', facts: record.memoryFacts,
        sourceStartSeq: record.rawStartSeq, sourceEndSeq: record.rawEndSeq,
        blockId: record.id, blockLevel: record.level, createdAt: record.createdAt,
      }).catch((err) => {
        logger.warn({ err, sessionId, blockId: record.id, factCount: record.memoryFacts?.length || 0 }, 'Failed to index compact memory facts');
      });
    }
    return true;
  } catch (error) {
    if (isSessionAuthorityPostCommitError(error)) throw error;
    restoreSessionSemanticState(session, beforeCommit);
    try {
      await rollbackUncommittedMessages(insertedCompletionMessages);
      await rollbackUncommittedBlocks(insertedBlocks);
    } catch (rollbackError) {
      const combined = new Error(`Session ${sessionId} compaction failed and its uncommitted archive rows could not be rolled back.`);
      (combined as any).errors = [error, rollbackError];
      throw combined;
    }
    throw error;
  }
}

async function runCompaction(deps: SessionHistoryDeps, sessionId: string, options: CompactionRunOptions = {}): Promise<boolean> {
  const session = deps.getSessionById(sessionId);
  if (!session) return false;

  logger.info({ sessionId, hasBroadcast: !!session.broadcast }, options.startLogMessage || 'Compaction starting');
  if (session.broadcast && options.startBroadcastMessage) {
    session.broadcast(options.startBroadcastMessage);
  }

  await ensureCompactPromptCacheKeyPersisted(deps, session);

  const snapshot = buildCompactJobSnapshot(session, options);
  if (!snapshot) {
    logger.info({ sessionId }, 'Compaction skipped because there is no compactable snapshot');
    return false;
  }

  try {
    const result = await runCompactJob(deps, snapshot);
    return await applyCompactJobResult(deps, sessionId, result);
  } catch (e) {
    logger.error(e, 'Compaction failed');
    throw e;
  }
}

async function startBackgroundCompaction(deps: SessionHistoryDeps, sessionId: string, options: CompactionRunOptions = {}): Promise<boolean> {
  if (compactJobStates.has(sessionId)) {
    logger.info({ sessionId }, 'Skipped starting background compact job because one is already pending');
    return false;
  }

  const session = deps.getSessionById(sessionId);
  if (!session) {
    return false;
  }

  logger.info({ sessionId, hasBroadcast: !!session.broadcast }, options.startLogMessage || 'Compaction starting');
  if (session.broadcast && options.startBroadcastMessage) {
    session.broadcast(options.startBroadcastMessage);
  }

  await ensureCompactPromptCacheKeyPersisted(deps, session);

  const snapshot = buildCompactJobSnapshot(session, options);
  if (!snapshot) {
    logger.info({ sessionId }, 'Background compact skipped because there is no compactable snapshot');
    return false;
  }
  if (!deps.enqueueSessionItem) {
    logger.warn({ sessionId }, 'Background compact requested without enqueueSessionItem dependency; falling back to synchronous compaction');
    return runCompaction(deps, sessionId, options);
  }

  compactJobStates.set(sessionId, {
    status: 'running',
    startedAt: Date.now(),
    request: {
      keepPercent: options.keepPercent,
      compactGuidance: options.compactGuidance,
      completionMarker: options.completionMarker,
    },
    snapshotHistoryVersion: snapshot.baseHistoryVersion,
  });

  void (async () => {
    try {
      const result = await runCompactJob(deps, snapshot);
      compactJobStates.set(sessionId, {
        status: 'ready',
        startedAt: Date.now(),
        request: {
          keepPercent: options.keepPercent,
          compactGuidance: options.compactGuidance,
          completionMarker: options.completionMarker,
        },
        snapshotHistoryVersion: snapshot.baseHistoryVersion,
        result,
      });
    } catch (error: any) {
      compactPreviewLastTimestamp.delete(sessionId);
      compactJobStates.set(sessionId, {
        status: 'failed',
        startedAt: Date.now(),
        request: {
          keepPercent: options.keepPercent,
          compactGuidance: options.compactGuidance,
          completionMarker: options.completionMarker,
        },
        snapshotHistoryVersion: snapshot.baseHistoryVersion,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }

    const liveSession = deps.getSessionById(sessionId);
    if (!liveSession) {
      compactJobStates.delete(sessionId);
      compactPreviewLastTimestamp.delete(sessionId);
      return;
    }
    if (!liveSession.queue.some(item => item.type === 'compact-commit')) {
      await deps.enqueueSessionItem!(sessionId, { type: 'compact-commit' });
    }
  })().catch(error => {
    logger.error({ err: error, sessionId }, 'Background compact job wrapper failed unexpectedly');
  });

  return true;
}

async function runCompactionWithMode(deps: SessionHistoryDeps, sessionId: string, options: CompactionRunOptions = {}, executionMode: CompactExecutionMode = 'auto'): Promise<boolean> {
  const session = deps.getSessionById(sessionId);
  if (!session) {
    return false;
  }

  if (compactJobStates.has(sessionId)) {
    logger.info({ sessionId, executionMode }, 'Skipped compaction because another compact job is already pending');
    return false;
  }

  const shouldBackground = executionMode === 'background'
    || (executionMode === 'auto' && isAsyncCompactEnabled(session));

  if (shouldBackground) {
    return startBackgroundCompaction(deps, sessionId, {
      ...options,
      completionBroadcastMessage: options.completionBroadcastMessage || ASYNC_COMPACT_DONE_NOTICE,
    });
  }

  return runCompaction(deps, sessionId, options);
}

export async function applyCompletedCompactJob(deps: SessionHistoryDeps, sessionId: string): Promise<boolean> {
  const state = compactJobStates.get(sessionId);
  if (!state || state.status === 'running') {
    return false;
  }

  compactJobStates.delete(sessionId);

  if (state.status === 'failed') {
    compactPreviewLastTimestamp.delete(sessionId);
    throw state.error || new Error('Background compact job failed.');
  }

  const applied = await applyCompactJobResult(deps, sessionId, state.result!);
  if (!applied) {
    compactPreviewLastTimestamp.delete(sessionId);
  }
  return applied;
}

export async function compactHistory(deps: SessionHistoryDeps, sessionId: string, keepPercent: number = COMPACT_PERCENT, completionMarker: string = 'Compaction completed.'): Promise<void> {
  await runCompactionWithMode(deps, sessionId, {
    keepPercent,
    completionMarker,
    startLogMessage: 'Compaction starting',
    startBroadcastMessage: '⚠️ Context size limit reached, compacting history...',
  }, 'await');
}

export async function compactHistoryWithSummary(deps: SessionHistoryDeps, sessionId: string, summary: string, keepPercent: number = COMPACT_PERCENT, completionMarker: string = 'Manual compaction completed.'): Promise<void> {
  if (!summary || !summary.trim()) {
    throw new Error('Summary is required for manual compaction.');
  }

  await runCompactionWithMode(deps, sessionId, {
    keepPercent,
    completionMarker,
    compactGuidance: `Manual compaction hint from requester: ${summary.trim()}`,
    startLogMessage: 'Manual compaction starting',
    startBroadcastMessage: '⚠️ Manual compaction starting...',
  }, 'await');
}

export async function deleteMessages(deps: SessionHistoryDeps, sessionId: string, num: number): Promise<{ deleted: number; remaining: number }> {
  const session = deps.getSessionById(sessionId);
  if (!session) return { deleted: 0, remaining: 0 };
  if (!num || isNaN(num)) return { deleted: 0, remaining: session.history.length };

  let deleted = 0;

  if (num > 0) {
    deleted = Math.min(num, session.history.length);
    session.history = session.history.slice(deleted);
    if (session.vectorIndexPosition !== undefined) {
      session.vectorIndexPosition = Math.max(0, session.vectorIndexPosition - deleted);
    }
  } else if (num < 0) {
    const absNum = Math.min(Math.abs(num), session.history.length);
    deleted = absNum;
    session.history = session.history.slice(0, session.history.length - absNum);
    if (session.vectorIndexPosition !== undefined) {
      session.vectorIndexPosition = Math.min(session.vectorIndexPosition, session.history.length);
    }
  }

  session.historyVersion = (session.historyVersion || 0) + 1;
  session.indexingState = undefined;

  await deps.saveSession(sessionId);
  return { deleted, remaining: session.history.length };
}

export async function clearSession(deps: SessionHistoryDeps, sessionId: string): Promise<void> {
  const session = await deps.getExistingSession(sessionId);
  if (!session) {
    throw new Error(`Session \`${sessionId}\` not found.`);
  }

  discardPendingCompactWork(sessionId);

  session.history = [];
  session.queue = [];
  session.stopping = false;
  session.busy = false;
  session.busyStartedAt = undefined;
  session.vectorIndexPosition = 0;
  session.nextBlockId = 1;
  session.historyVersion = (session.historyVersion || 0) + 1;
  session.indexingState = undefined;
  session.promptCacheKey = llm.generatePromptCacheKey();
  session.meta = {
    ...session.meta,
    lastMessageTime: Date.now(),
    messageCount: 0,
  };
  delete session.meta.wait;

  await deps.saveSession(session.id);
}

export async function getArchivedMessages(sessionId: string, options: ArchivedMessagesQueryOptions = {}): Promise<ArchivedMessagesQueryResult> {
  const { startSeq, endSeq } = normalizeSeqRange(options.startSeq, options.endSeq);

  const archiveMessages = await readArchiveMessages(sessionId);
  const availableRange = {
    startSeq: archiveMessages[0]?.seq,
    endSeq: archiveMessages[archiveMessages.length - 1]?.seq,
  };

  const matched = archiveMessages.filter(record => {
    if (typeof startSeq === 'number' && record.seq < startSeq) {
      return false;
    }
    if (typeof endSeq === 'number' && record.seq > endSeq) {
      return false;
    }
    return true;
  });

  const sliced = matched.map(record => ({
    seq: record.seq,
    message: record.message,
    sourceSessionId: record.sourceSessionId,
    inherited: record.inherited,
  }));

  return {
    records: sliced,
    totalMatched: matched.length,
    returnedCount: sliced.length,
    availableRange,
    requestedRange: { startSeq, endSeq },
  };
}

export async function compactToolMessages(
  deps: SessionHistoryDeps,
  sessionId: string,
  keepPercent: number = COMPACT_PERCENT,
  _thresholdTokens?: number,
): Promise<ToolNoiseCompactionResult> {
  const session = await deps.getExistingSession(sessionId);
  if (!session) {
    throw new Error(`Session \`${sessionId}\` not found.`);
  }

  const plan = await buildToolResponsePrunePlan(sessionId, session, keepPercent);
  return (await commitToolResponsePrunePlan(deps, sessionId, plan)).result;
}

export async function tryAutomaticToolResponsePruning(
  deps: SessionHistoryDeps,
  sessionId: string,
  planOverride?: ToolResponsePrunePlan,
): Promise<boolean> {
  const session = deps.getSessionById(sessionId);
  if (!session) return false;
  const plan = planOverride || await buildToolResponsePrunePlan(sessionId, session, COMPACT_PERCENT);
  if (plan.replacedFunctionResponses === 0) return false;
  const { contextLimit } = resolveModelConfig(session.model);
  const recoveryTarget = Math.max(1, Math.floor(contextLimit * 0.5));
  const commit = await commitToolResponsePrunePlan(deps, sessionId, plan, recoveryTarget);
  if (!commit.committed) {
    logger.info({
      sessionId, prunableResponses: plan.replacedFunctionResponses,
      estimatedTokensAfter: commit.result.estimatedTokensAfter, recoveryTarget,
    }, 'Automatic historical tool-response pruning did not commit; continuing to layered compaction');
    return false;
  }
  logger.info({
    sessionId, prunedResponses: commit.result.replacedFunctionResponses, touchedMessages: commit.result.touchedMessages,
    estimatedTokensBefore: commit.result.estimatedTokensBefore, estimatedTokensAfter: commit.result.estimatedTokensAfter,
    estimatedTokensSaved: commit.result.estimatedTokensSaved, recoveryTarget,
  }, 'Automatic historical tool-response pruning completed; layered compaction skipped for this trigger');
  return true;
}

export function getUsageTotalTokens(finalUsage?: Partial<TokenUsage> & {
  cachedContentTokenCount?: number;
  promptTokenCount?: number;
  candidatesTokenCount?: number;
}): number {
  if (!finalUsage) return 0;

  const cachedTokens = finalUsage.cachedTokens ?? finalUsage.cachedContentTokenCount ?? 0;
  const inputTokens = finalUsage.inputTokens ?? finalUsage.promptTokenCount ?? 0;
  const outputTokens = finalUsage.outputTokens ?? finalUsage.candidatesTokenCount ?? 0;

  return cachedTokens + inputTokens + outputTokens;
}

export async function checkAndCompactIfNeeded(deps: SessionHistoryDeps, sessionId: string, finalUsage?: Partial<TokenUsage>): Promise<void> {
  const session = deps.getSessionById(sessionId);
  if (!session) return;

  if (!finalUsage) {
    logger.debug?.({ sessionId }, 'Skipping auto compact because request usage is unavailable');
    return;
  }

  const currentSize = getUsageTotalTokens(finalUsage);
  if (currentSize <= 0) {
    logger.debug?.({ sessionId, finalUsage }, 'Skipping auto compact because request usage total is unavailable or zero');
    return;
  }

  const compactThreshold = getEffectiveCompactThresholdTokens(session);

  if (currentSize > compactThreshold) {
    logger.info({ currentSize, compactThreshold, sessionThresholdOverride: session.compactThresholdTokens }, 'Auto compact');
    if (await tryAutomaticToolResponsePruning(deps, sessionId)) return;
    await runCompactionWithMode(deps, sessionId, {
      keepPercent: COMPACT_PERCENT,
      completionMarker: 'Compaction completed.',
      startLogMessage: 'Auto compaction starting',
    }, 'auto').catch(e => logger.error(e, 'Auto-compact failed'));
  }
}

export async function processSessionCompactionRequest(
  deps: SessionHistoryDeps,
  sessionId: string,
  item: CompactionRequest,
  executionMode: CompactExecutionMode = 'auto',
): Promise<void> {
  if (item.compactGuidance?.trim()) {
    await runCompactionWithMode(deps, sessionId, {
      keepPercent: item.keepPercent,
      completionMarker: item.completionMarker || 'Compaction completed.',
      compactGuidance: `Manual compaction hint from requester: ${item.compactGuidance.trim()}`,
      startLogMessage: 'Manual compaction starting',
    }, executionMode);
    return;
  }

  if (executionMode === 'auto') {
    const session = deps.getSessionById(sessionId);
    const prunePlan = session ? await buildToolResponsePrunePlan(sessionId, session, COMPACT_PERCENT) : undefined;
    if (prunePlan && await tryAutomaticToolResponsePruning(deps, sessionId, prunePlan)) return;
    if (prunePlan && !hasCompatibleHistoryPrefix(session?.history || [], prunePlan.snapshotHistory)) {
      logger.info({ sessionId }, 'Skipping layered compaction because the automatic maintenance snapshot changed incompatibly');
      return;
    }
  }

  await runCompactionWithMode(deps, sessionId, {
    keepPercent: item.keepPercent,
    completionMarker: item.completionMarker || 'Compaction completed.',
    startLogMessage: 'Compaction starting',
  }, executionMode);
}