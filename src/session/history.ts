import * as llm from '../llm';
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
import { estimateTokenCount } from '../tokenCount';
import * as vector from '../vector';
import { appendMessagesToArchive, readArchiveMessages, readArchiveMessagesBySeqRange } from './archive';
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
import { CompactionRequest, Message, MessagePart, QueueItem, Session, TokenUsage, ContextFrontierItem } from '../types';
import { stringifyFunctionCallArgs } from '../toolCallArgs';
import { formatMessagePreviewText } from '../utils/messageFormat';
import { buildSystemMessageParts } from '../utils/systemMessageParts';
import { formatFoxwarmSystemTag } from '../utils/promptWrappers';
import { formatLocalTimestamp } from '../utils/localTime';
import { formatSessionGoalReminderText } from './goal';
import { appendBlocksToArchive, cloneSessionFrontier, ensureContextFrontier, readArchiveBlocksByIdRange, renderHistoryFromFrontier, shouldIgnoreMessageInCompactCandidates, shouldRemoveOldCompactCompletionMessage } from './layeredContext';
import { isModelVisibleMessage } from './messageVisibility';

const TOOL_NOISE_TOKEN_THRESHOLD = 200;

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
  frontierSnapshot: ContextFrontierItem[];
  transientSession: Session;
  keepPercent: number;
  completionMarker: string;
  completionBroadcastMessage?: string;
  compactGuidance?: string;
};

type CompactJobOperation = {
  frontierStartIndex: number;
  frontierEndIndex: number;
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
      reason: 'empty-history' | 'empty-frontier' | 'no-older-messages' | 'no-candidates';
      completionMarker: string;
      snapshotFrontier: ContextFrontierItem[];
      consumedFrontierCount: number;
    }
  | {
      status: 'ready';
      completionMarker: string;
      completionBroadcastMessage?: string;
      snapshotFrontier: ContextFrontierItem[];
      consumedFrontierCount: number;
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

function getFunctionCallTokenCount(part: Message['parts'][number]): number {
  if (!part.functionCall) {
    return 0;
  }

  return estimateTokenCount(part.functionCall.name || '')
    + estimateTokenCount(stringifyFunctionCallArgs(part.functionCall));
}

function getFunctionResponseTokenCount(part: Message['parts'][number]): number {
  if (!part.functionResponse) {
    return 0;
  }

  return estimateTokenCount(part.functionResponse.name || '')
    + estimateTokenCount(JSON.stringify(part.functionResponse.response || {}));
}

function buildToolNoisePlaceholder(options: {
  sessionId: string;
  seq?: number;
  toolName?: string;
  kind: 'function_call' | 'function_response';
  estimatedTokens: number;
}): string {
  const { seq, toolName, kind } = options;
  const rangeLabel = typeof seq === 'number' ? `#${seq}` : '(seq unavailable)';
  const kindLabel = kind === 'function_call' ? 'tool call' : 'tool response';
  const toolLabel = toolName || 'unknown';
  const lookup = typeof seq === 'number'
    ? `message log msg${rangeLabel} via recall`
    : 'see earlier message log via recall';
  return `[compacted ${kindLabel}: ${toolLabel}] ${lookup}`;
}

function buildCompactedFunctionCallArgs(placeholder: string): Record<string, any> {
  return {
    __compacted: true,
    placeholder,
  };
}

function buildCompactedFunctionResponse(placeholder: string): Record<string, any> {
  return {
    __compacted: true,
    output: placeholder,
  };
}

function normalizeSeqRange(startSeq?: number, endSeq?: number): { startSeq?: number; endSeq?: number } {
  if (typeof startSeq === 'number' && typeof endSeq === 'number' && startSeq > endSeq) {
    return { startSeq: endSeq, endSeq: startSeq };
  }

  return { startSeq, endSeq };
}

function cloneSessionForCompactJob(session: Session, historySnapshot: Message[], frontierSnapshot: ContextFrontierItem[]): Session {
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
    verbose: session.verbose,
    vectorIndexPosition: session.vectorIndexPosition,
    indexingState: session.indexingState ? structuredClone(session.indexingState) : undefined,
    historyVersion: session.historyVersion,
    nextMessageSeq: session.nextMessageSeq,
    nextBlockId: session.nextBlockId,
    contextFrontier: structuredClone(frontierSnapshot),
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

  const frontierSnapshot = cloneSessionFrontier(session);
  if (frontierSnapshot.length === 0) {
    return null;
  }

  return {
    sessionId: session.id,
    baseHistoryVersion: session.historyVersion || 0,
    historySnapshot,
    frontierSnapshot,
    transientSession: cloneSessionForCompactJob(session, historySnapshot, frontierSnapshot),
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

function contextFrontierItemsEqual(a: ContextFrontierItem | undefined, b: ContextFrontierItem | undefined): boolean {
  if (!a || !b || a.kind !== b.kind) {
    return false;
  }

  if (a.kind === 'message' && b.kind === 'message') {
    return a.seq === b.seq
      && (a.preservedFromBlockId ?? 0) === (b.preservedFromBlockId ?? 0);
  }

  if (a.kind === 'block' && b.kind === 'block') {
    return a.id === b.id
      && a.level === b.level
      && a.rawStartSeq === b.rawStartSeq
      && a.rawEndSeq === b.rawEndSeq;
  }

  return false;
}

function hasCompatibleFrontierPrefix(currentFrontier: ContextFrontierItem[], snapshotFrontier: ContextFrontierItem[]): boolean {
  if (currentFrontier.length < snapshotFrontier.length) {
    return false;
  }

  for (let index = 0; index < snapshotFrontier.length; index += 1) {
    if (!contextFrontierItemsEqual(currentFrontier[index], snapshotFrontier[index])) {
      return false;
    }
  }

  return true;
}

export type LayeredCompactCandidateEntry = {
  item: CompactCandidateItem;
  frontierStartIndex: number;
  frontierEndIndex: number;
};

type LayeredCompactCandidateBuildResult = {
  candidateEntries: LayeredCompactCandidateEntry[];
  messagePolicy: MessageCompactionPolicy;
  blockPolicies: BlockCompactionPolicy[];
};

export function isSingleBlockCompactionStrandedBetweenHigherLevelBlocks(
  olderFrontier: ContextFrontierItem[],
  frontierIndex: number,
): boolean {
  const current = olderFrontier[frontierIndex];
  const previous = olderFrontier[frontierIndex - 1];
  const next = olderFrontier[frontierIndex + 1];

  return current?.kind === 'block'
    && previous?.kind === 'block'
    && next?.kind === 'block'
    && previous.level > current.level
    && next.level > current.level;
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

function isPreservedMessageFrontierItem(item: ContextFrontierItem): item is Extract<ContextFrontierItem, { kind: 'message' }> & { preservedFromBlockId: number } {
  return item.kind === 'message' && typeof item.preservedFromBlockId === 'number' && Number.isInteger(item.preservedFromBlockId) && item.preservedFromBlockId > 0;
}

export function buildCreatedBlockFrontierItemsWithPreservedMessages(
  createdBlock: { id: number; level: number; rawStartSeq: number; rawEndSeq: number },
  preservedMessages: Array<{ seq: number }>,
): ContextFrontierItem[] {
  return [
    {
      kind: 'block',
      id: createdBlock.id,
      level: createdBlock.level,
      rawStartSeq: createdBlock.rawStartSeq,
      rawEndSeq: createdBlock.rawEndSeq,
    },
    ...preservedMessages
      .slice()
      .sort((a, b) => a.seq - b.seq)
      .map((preserved): ContextFrontierItem => ({
        kind: 'message',
        seq: preserved.seq,
        preservedFromBlockId: createdBlock.id,
      })),
  ];
}

export function removePreservedMessageFrontierItems(frontier: ContextFrontierItem[], removeSeqs: Set<number>): ContextFrontierItem[] {
  if (removeSeqs.size === 0) {
    return frontier;
  }

  return frontier.filter(item => !(isPreservedMessageFrontierItem(item) && removeSeqs.has(item.seq)));
}

async function buildLayeredCompactCandidateEntries(session: Session, olderFrontier: ContextFrontierItem[]): Promise<LayeredCompactCandidateBuildResult> {
  const messageSeqs = olderFrontier
    .filter((item): item is Extract<ContextFrontierItem, { kind: 'message' }> => item.kind === 'message')
    .map(item => item.seq);
  const blockIds = olderFrontier
    .filter((item): item is Extract<ContextFrontierItem, { kind: 'block' }> => item.kind === 'block')
    .map(item => item.id);

  const messageRecords = messageSeqs.length > 0
    ? await readArchiveMessagesBySeqRange(session.id, Math.min(...messageSeqs), Math.max(...messageSeqs))
    : [];
  const blockRecords = blockIds.length > 0
    ? await readArchiveBlocksByIdRange(session.id, Math.min(...blockIds), Math.max(...blockIds))
    : [];

  const messageMap = new Map(messageRecords.map(record => [record.seq, record]));
  const blockMap = new Map(blockRecords.map(record => [record.id, record]));

  const blockRecordsByLevel = new Map<number, Array<{ id: number; summary: string }>>();
  for (const item of olderFrontier) {
    if (item.kind !== 'block') continue;
    const record = blockMap.get(item.id);
    if (!record) continue;
    const records = blockRecordsByLevel.get(record.level) || [];
    records.push({ id: record.id, summary: record.summary });
    blockRecordsByLevel.set(record.level, records);
  }

  const candidateBlockIdsByLevel = new Map<number, Set<number>>();
  const preliminaryBlockPolicies: BlockCompactionPolicy[] = [];
  for (const [sourceLevel, records] of blockRecordsByLevel.entries()) {
    const totalTokens = records.reduce((sum, record) => sum + estimateTokenCount(record.summary || ''), 0);
    const window = calculateBlockCompactionWindow({
      totalBlockCount: records.length,
      totalTokens,
      minTokens: COMPACT_BLOCK_LEVEL_MIN_TOKENS,
      forceTokens: COMPACT_BLOCK_LEVEL_FORCE_TOKENS,
      candidateFraction: COMPACT_BLOCK_CANDIDATE_FRACTION,
      forceCompactFraction: COMPACT_BLOCK_FORCE_COMPACT_FRACTION,
    });
    candidateBlockIdsByLevel.set(sourceLevel, new Set(records.slice(0, window.candidateBlockCount).map(record => record.id)));
    preliminaryBlockPolicies.push({
      sourceLevel,
      totalBlockCount: records.length,
      totalTokens,
      forcedKeepNewestCount: window.forcedKeepNewestCount,
      candidateBlockCount: window.candidateBlockCount,
      requestedMinBlocks: window.requestedMinBlocks,
      feasibleMaxBlocks: 0,
      effectiveMinBlocks: 0,
      ...(totalTokens < COMPACT_BLOCK_LEVEL_MIN_TOKENS
        ? { skippedReason: `below the ${COMPACT_BLOCK_LEVEL_MIN_TOKENS}-token block eligibility threshold` }
        : window.candidateBlockCount === 0
        ? { skippedReason: 'the strict oldest-candidate window is empty at this level size' }
        : {}),
    });
  }

  const entries: LayeredCompactCandidateEntry[] = [];
  let compactSegmentId = 1;

  for (let frontierIndex = 0; frontierIndex < olderFrontier.length; frontierIndex += 1) {
    const item = olderFrontier[frontierIndex];

    if (isPreservedMessageFrontierItem(item)) {
      compactSegmentId += 1;
      continue;
    }

    if (item.kind === 'block') {
      const record = blockMap.get(item.id);
      if (!record || !candidateBlockIdsByLevel.get(record.level)?.has(record.id)) {
        // Non-candidate blocks are hard boundaries. Otherwise two eligible
        // same-level blocks could form a range whose frontier replacement
        // silently consumes a force-kept/different-level block between them.
        compactSegmentId += 1;
        continue;
      }

      entries.push({
        item: buildBlockCandidateItem(
          record.id,
          record.level,
          record.rawStartSeq,
          record.rawEndSeq,
          record.summary,
          estimateTokenCount(record.summary),
          isSingleBlockCompactionStrandedBetweenHigherLevelBlocks(olderFrontier, frontierIndex),
          compactSegmentId,
        ),
        frontierStartIndex: frontierIndex,
        frontierEndIndex: frontierIndex,
      });
      continue;
    }

    const record = messageMap.get(item.seq);
    if (!record) {
      compactSegmentId += 1;
      continue;
    }
    if (!isModelVisibleMessage(record.message)) {
      // Display-only items are intentionally transparent to compact ranges;
      // they are dropped when an enclosing visible range is rewritten.
      continue;
    }
    if (shouldRemoveOldCompactCompletionMessage(record.message)) {
      // A previous compact-completed notice is replaced by the one emitted at
      // the end of this successful commit. It is transparent here so it does
      // not split otherwise legal ranges or enter a summary.
      continue;
    }
    if (shouldIgnoreMessageInCompactCandidates(record.message)) {
      // Model-visible lifecycle/session-boundary messages are protected hard
      // boundaries even though they are not useful summary candidates.
      compactSegmentId += 1;
      continue;
    }

    let groupedEndFrontierIndex = frontierIndex;
    const groupedRecords = [record];
    const startsToolExchange = record.message.role === 'model'
      && record.message.parts?.some(part => !!part.functionCall);

    if (startsToolExchange) {
      for (let nextIndex = frontierIndex + 1; nextIndex < olderFrontier.length; nextIndex += 1) {
        const nextItem = olderFrontier[nextIndex];
        if (nextItem.kind !== 'message' || isPreservedMessageFrontierItem(nextItem)) {
          break;
        }

        const nextRecord = messageMap.get(nextItem.seq);
        if (!nextRecord || nextRecord.message.role !== 'tool') {
          break;
        }

        groupedRecords.push(nextRecord);
        groupedEndFrontierIndex = nextIndex;
      }
    }

    const visibleGroupedRecords = groupedRecords.filter(groupRecord => isModelVisibleMessage(groupRecord.message));
    const preview = visibleGroupedRecords
      .map(groupRecord => formatMessagePreviewText(groupRecord.message, 50, {
        skipEphemeralSystem: true,
        skipRagMemorySnippets: true,
        skipThinking: true,
      }).trim())
      .filter(Boolean)
      .join(' | ') || '[empty message]';

    const estimatedTokens = visibleGroupedRecords.reduce((sum, groupRecord) => {
      return sum + estimateTokenCount(formatMessagePreviewText(groupRecord.message, Number.MAX_SAFE_INTEGER, {
        skipEphemeralSystem: true,
        skipRagMemorySnippets: true,
        skipThinking: true,
      }));
    }, 0);

    entries.push({
      item: buildMessageCandidateItem(item.seq, groupedRecords[groupedRecords.length - 1].seq, preview, estimatedTokens, compactSegmentId),
      frontierStartIndex: frontierIndex,
      frontierEndIndex: groupedEndFrontierIndex,
    });

    frontierIndex = groupedEndFrontierIndex;
  }

  const rawEntries = entries.filter(entry => entry.item.kind === 'message');
  const rawItems = rawEntries.map(entry => entry.item);
  const totalRawTokens = rawItems.reduce((sum, item) => sum + Math.max(0, item.estimatedTokens || 0), 0);
  const rawEligible = selectCompactCandidateTargetLevels(rawItems).has(1);
  const candidateEntries = entries.filter(entry => entry.item.kind === 'block' || rawEligible);

  const rawFraction = clampCompactFraction(COMPACT_MESSAGE_FORCE_COMPACT_FRACTION, 0.2);
  const eligibleRawTokens = rawEligible ? totalRawTokens : 0;
  const requestedRawTokens = rawEligible ? Math.ceil(eligibleRawTokens * rawFraction) : 0;
  const messagePolicy: MessageCompactionPolicy = {
    thresholdTokens: COMPACT_LEVEL_TOKEN_THRESHOLD,
    totalCandidateTokens: totalRawTokens,
    eligibleTokens: eligibleRawTokens,
    requestedMinTokens: requestedRawTokens,
    feasibleMaxTokens: eligibleRawTokens,
    effectiveMinTokens: Math.min(requestedRawTokens, eligibleRawTokens),
    ...(!rawEligible
      ? { skippedReason: totalRawTokens > 0
        ? `~${totalRawTokens} raw-message tokens do not exceed the ${COMPACT_LEVEL_TOKEN_THRESHOLD}-token eligibility threshold`
        : 'no eligible model-visible raw message candidates' }
      : {}),
  };

  const blockPolicies = preliminaryBlockPolicies
    .map(policy => {
      const levelEntries = candidateEntries.filter(entry => entry.item.kind === 'block' && entry.item.level === policy.sourceLevel);
      let feasibleMaxBlocks = 0;
      let runLength = 0;
      let previousSegmentId: number | undefined;
      let previousCandidateIndex = -2;
      const flushRun = () => {
        if (runLength >= 2) feasibleMaxBlocks += runLength;
        runLength = 0;
      };

      for (const entry of levelEntries) {
        const candidateIndex = candidateEntries.indexOf(entry);
        const segmentId = entry.item.segmentId ?? 0;
        if (runLength > 0 && (candidateIndex !== previousCandidateIndex + 1 || segmentId !== previousSegmentId)) {
          flushRun();
        }
        runLength += 1;
        previousSegmentId = segmentId;
        previousCandidateIndex = candidateIndex;
      }
      flushRun();

      const effectiveMinBlocks = Math.min(policy.requestedMinBlocks, feasibleMaxBlocks);
      return {
        ...policy,
        feasibleMaxBlocks,
        effectiveMinBlocks,
        ...(policy.requestedMinBlocks > 0 && feasibleMaxBlocks === 0
          ? { skippedReason: 'no legal contiguous multi-block candidate segment is available' }
          : {}),
      };
    })
    .sort((a, b) => a.sourceLevel - b.sourceLevel);

  return { candidateEntries, messagePolicy, blockPolicies };
}

async function getDisplayOnlyMessageSeqsForFrontier(sessionId: string, frontier: ContextFrontierItem[]): Promise<Set<number>> {
  const messageSeqs = frontier
    .filter((item): item is Extract<ContextFrontierItem, { kind: 'message' }> => item.kind === 'message')
    .map(item => item.seq);

  if (messageSeqs.length === 0) {
    return new Set();
  }

  const records = await readArchiveMessagesBySeqRange(sessionId, Math.min(...messageSeqs), Math.max(...messageSeqs));
  return new Set(records
    .filter(record => !isModelVisibleMessage(record.message))
    .map(record => record.seq));
}

async function filterDisplayOnlyMessageFrontierItems(sessionId: string, frontier: ContextFrontierItem[]): Promise<ContextFrontierItem[]> {
  const displayOnlySeqs = await getDisplayOnlyMessageSeqsForFrontier(sessionId, frontier);

  if (displayOnlySeqs.size === 0) {
    return frontier;
  }

  return frontier.filter(item => item.kind !== 'message' || !displayOnlySeqs.has(item.seq));
}

async function buildPreservedMessageCandidateItems(session: Session, olderFrontier: ContextFrontierItem[]): Promise<PreservedMessageCandidateItem[]> {
  const preservedItems = olderFrontier.filter(isPreservedMessageFrontierItem);
  if (preservedItems.length === 0) {
    return [];
  }

  const seqs = preservedItems.map(item => item.seq);
  const records = await readArchiveMessagesBySeqRange(session.id, Math.min(...seqs), Math.max(...seqs));
  const messageMap = new Map(records.map(record => [record.seq, record]));

  return preservedItems.flatMap((item): PreservedMessageCandidateItem[] => {
    const record = messageMap.get(item.seq);
    if (!record || shouldIgnoreMessageInCompactCandidates(record.message)) {
      return [];
    }

    const preview = formatMessagePreviewText(record.message, 300, {
      skipEphemeralSystem: true,
      skipRagMemorySnippets: true,
      skipThinking: true,
    }).trim() || '[empty message]';

    return [{
      seq: item.seq,
      key: `M#${item.seq}`,
      preservedFromBlockId: item.preservedFromBlockId,
      preview,
    }];
  });
}

async function filterDisplayOnlyAndRemovedPreservedMessageFrontierItems(sessionId: string, frontier: ContextFrontierItem[], removePreservedSeqs: Set<number>): Promise<ContextFrontierItem[]> {
  const visibleFrontier = await filterDisplayOnlyMessageFrontierItems(sessionId, frontier);
  if (removePreservedSeqs.size === 0) {
    return visibleFrontier;
  }

  return removePreservedMessageFrontierItems(visibleFrontier, removePreservedSeqs);
}

async function removeOldCompactCompletionFrontierItems(sessionId: string, frontier: ContextFrontierItem[]): Promise<ContextFrontierItem[]> {
  const messageSeqs = frontier
    .filter((item): item is Extract<ContextFrontierItem, { kind: 'message' }> => item.kind === 'message')
    .map(item => item.seq);
  if (messageSeqs.length === 0) {
    return frontier;
  }

  const records = await readArchiveMessagesBySeqRange(sessionId, Math.min(...messageSeqs), Math.max(...messageSeqs));
  const removableSeqs = new Set(records
    .filter(record => shouldRemoveOldCompactCompletionMessage(record.message))
    .map(record => record.seq));
  if (removableSeqs.size === 0) {
    return frontier;
  }

  return frontier.filter(item => item.kind !== 'message' || !removableSeqs.has(item.seq));
}

export function resolveCreateBlockRanges(plan: CompactPlan, candidateEntries: LayeredCompactCandidateEntry[]): Array<{ planIndex: number; startIndex: number; endIndex: number; frontierStartIndex: number; frontierEndIndex: number; rawStartSeq: number; rawEndSeq: number; sourceKind: 'message' | 'block'; level: number; sourceStart: number; sourceEnd: number; sourceBlockIds?: number[]; summary: string; memoryFacts?: ExtractedMemoryFact[]; }> {
  const operations: Array<{ planIndex: number; startIndex: number; endIndex: number; frontierStartIndex: number; frontierEndIndex: number; rawStartSeq: number; rawEndSeq: number; sourceKind: 'message' | 'block'; level: number; sourceStart: number; sourceEnd: number; sourceBlockIds?: number[]; summary: string; memoryFacts?: ExtractedMemoryFact[]; }> = [];
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
        frontierStartIndex: startEntry.frontierStartIndex,
        frontierEndIndex: endEntry.frontierEndIndex,
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
      frontierStartIndex: startEntry.frontierStartIndex,
      frontierEndIndex: endEntry.frontierEndIndex,
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
function extractCompactedSkillNames(history: Message[], consumedFrontierCount: number): string[] {
  const skillNames = new Set<string>();
  // Scan messages that correspond to the consumed frontier portion
  const scanLimit = Math.min(consumedFrontierCount, history.length);
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
  newFrontier: ContextFrontierItem[],
  completionMarker: string,
  completionBroadcastMessage: string | undefined,
  createdBlockCount: number,
  replacedItemCount: number,
  compactedSkillNames: string[] = [],
): Promise<void> {
  session.contextFrontier = newFrontier;
  session.persistentMemorySnapshot = await llm.buildSessionSystemPromptSnapshot({
    agentName: session.agent || 'main',
    sessionId,
    systemPromptFiles: session.systemPromptFiles,
  });
  session.history = await renderHistoryFromFrontier(session, newFrontier);

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
  await appendMessagesToArchive(session, [completionMessage]);
  session.history.push(completionMessage);
  const completionSeq = completionMessage.__meta!.seq!;
  ensureContextFrontier(session).push({ kind: 'message', seq: completionSeq });
  if (hasCompletionGoalReminder && session.goalState) {
    session.goalState.anchorSeq = completionSeq;
    completionMessage.__meta!.goalAnchorSeq = completionSeq;
  }

  session.vectorIndexPosition = 0;
  session.historyVersion = (session.historyVersion || 0) + 1;
  session.indexingState = undefined;
  // Compact planning itself reuses the live session's cache key, but a
  // successful compact commit rewrites the model-facing frontier/prefix. Route
  // subsequent turns to a fresh prompt-cache namespace so they do not compete
  // with requests built against the pre-compact prefix.
  session.promptCacheKey = llm.generatePromptCacheKey();

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
  const { sessionId, transientSession, historySnapshot, frontierSnapshot, keepPercent, compactGuidance, completionMarker, completionBroadcastMessage } = snapshot;
  const splitIndex = resolveCompactionSplitIndex(historySnapshot, keepPercent);
  if (splitIndex <= 0) {
    logger.info({ sessionId, keepPercent }, 'Compaction skipped because there are no older messages to compact');
    return {
      status: 'noop',
      reason: 'no-older-messages',
      completionMarker,
      snapshotFrontier: frontierSnapshot,
      consumedFrontierCount: splitIndex,
    };
  }

  const olderFrontier = frontierSnapshot.slice(0, splitIndex);
  const forceKeptRecentFrontier = splitIndex < frontierSnapshot.length ? frontierSnapshot.slice(splitIndex) : [];
  const preservedMessageCandidates = await buildPreservedMessageCandidateItems(transientSession, olderFrontier);
  const { candidateEntries, messagePolicy, blockPolicies } = await buildLayeredCompactCandidateEntries(transientSession, olderFrontier);
  const candidateItems = candidateEntries.map(entry => entry.item);

  if (candidateItems.length === 0 && preservedMessageCandidates.length === 0) {
    const droppedDisplayOnlyCount = (await getDisplayOnlyMessageSeqsForFrontier(sessionId, olderFrontier)).size;
    if (droppedDisplayOnlyCount > 0) {
      logger.info({ sessionId, splitIndex, droppedDisplayOnlyCount }, 'Compaction will drop display-only older messages without creating compact blocks');
      return {
        status: 'ready',
        completionMarker,
        completionBroadcastMessage,
        snapshotFrontier: frontierSnapshot,
        consumedFrontierCount: splitIndex,
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
      snapshotFrontier: frontierSnapshot,
      consumedFrontierCount: splitIndex,
    };
  }

  const forcedKeptMessageItems = forceKeptRecentFrontier.filter((item): item is Extract<ContextFrontierItem, { kind: 'message' }> => item.kind === 'message');
  const forcedKeptStartSeq = forcedKeptMessageItems[0]?.seq;
  const forcedKeptEndSeq = forcedKeptMessageItems[forcedKeptMessageItems.length - 1]?.seq;
  const summaryPrompt = {
    system: buildCompactPromptText({
      forcedKeptCount: forceKeptRecentFrontier.length,
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
    snapshotFrontier: frontierSnapshot,
    consumedFrontierCount: splitIndex,
    operations: operations.map(operation => ({
      frontierStartIndex: operation.frontierStartIndex,
      frontierEndIndex: operation.frontierEndIndex,
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
    replacedItemCount: operations.reduce((sum, operation) => sum + (operation.frontierEndIndex - operation.frontierStartIndex + 1), 0) + removePreservedMessages.length,
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

  const currentFrontier = cloneSessionFrontier(session);
  if (!hasCompatibleFrontierPrefix(currentFrontier, result.snapshotFrontier)) {
    logger.warn({ sessionId, snapshotFrontierLength: result.snapshotFrontier.length, currentFrontierLength: currentFrontier.length }, 'Skipping async compact commit because session frontier changed incompatibly');
    return false;
  }

  const olderFrontier = result.snapshotFrontier.slice(0, result.consumedFrontierCount);
  const createdRecords = await appendBlocksToArchive(session, result.createdBlocks);
  const removePreservedSeqs = new Set(result.removePreservedMessages || []);

  const rewrittenOlderFrontier: ContextFrontierItem[] = [];
  let cursor = 0;
  for (let index = 0; index < result.operations.length; index += 1) {
    const operation = result.operations[index];
    const createdRecord = createdRecords[index];
    if (cursor < operation.frontierStartIndex) {
      rewrittenOlderFrontier.push(...await filterDisplayOnlyAndRemovedPreservedMessageFrontierItems(sessionId, olderFrontier.slice(cursor, operation.frontierStartIndex), removePreservedSeqs));
    }
    const preservedForBlock = (result.preserveMessages || [])
      .filter(item => item.operationIndex === index)
      .sort((a, b) => a.seq - b.seq);
    rewrittenOlderFrontier.push(...buildCreatedBlockFrontierItemsWithPreservedMessages(createdRecord, preservedForBlock));
    cursor = operation.frontierEndIndex + 1;
  }
  if (cursor < olderFrontier.length) {
    rewrittenOlderFrontier.push(...await filterDisplayOnlyAndRemovedPreservedMessageFrontierItems(sessionId, olderFrontier.slice(cursor), removePreservedSeqs));
  }

  const newFrontier = await removeOldCompactCompletionFrontierItems(
    sessionId,
    [...rewrittenOlderFrontier, ...currentFrontier.slice(result.consumedFrontierCount)],
  );

  // Scan compacted messages for current and persisted legacy skill-load calls.
  const compactedSkillNames = extractCompactedSkillNames(session.history, result.consumedFrontierCount);

  await finalizeCompaction(
    deps,
    sessionId,
    session,
    newFrontier,
    result.completionMarker,
    result.completionBroadcastMessage,
    createdRecords.length,
    result.replacedItemCount,
    compactedSkillNames,
  );

  for (const record of createdRecords) {
    if (!record.memoryFacts?.length) continue;
    void vector.indexMemoryFactsFromCompaction({
      sessionId,
      agent: session.agent || 'main',
      facts: record.memoryFacts,
      sourceStartSeq: record.rawStartSeq,
      sourceEndSeq: record.rawEndSeq,
      blockId: record.id,
      blockLevel: record.level,
      createdAt: record.createdAt,
    }).catch((err) => {
      logger.warn({ err, sessionId, blockId: record.id, factCount: record.memoryFacts?.length || 0 }, 'Failed to index compact memory facts');
    });
  }
  return true;
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
    if (Array.isArray(session.contextFrontier)) {
      session.contextFrontier = session.contextFrontier.slice(deleted);
    }
    if (session.vectorIndexPosition !== undefined) {
      session.vectorIndexPosition = Math.max(0, session.vectorIndexPosition - deleted);
    }
  } else if (num < 0) {
    const absNum = Math.min(Math.abs(num), session.history.length);
    deleted = absNum;
    session.history = session.history.slice(0, session.history.length - absNum);
    if (Array.isArray(session.contextFrontier)) {
      session.contextFrontier = session.contextFrontier.slice(0, session.contextFrontier.length - absNum);
    }
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
  session.contextFrontier = [];
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
  thresholdTokens: number = TOOL_NOISE_TOKEN_THRESHOLD,
): Promise<ToolNoiseCompactionResult> {
  const session = await deps.getExistingSession(sessionId);
  if (!session) {
    throw new Error(`Session \`${sessionId}\` not found.`);
  }

  const splitIndex = resolveCompactionSplitIndex(session.history, keepPercent);
  const targetMessages = session.history.slice(0, splitIndex);
  let replacedFunctionCalls = 0;
  let replacedFunctionResponses = 0;
  let touchedMessages = 0;

  const rewrittenMessages = targetMessages.map(message => {
    let touched = false;
    const rewrittenParts = message.parts.map(part => {
      const nextPart = structuredClone(part);

      const functionCallTokens = getFunctionCallTokenCount(part);
      if (part.functionCall && functionCallTokens > thresholdTokens) {
        const placeholder = buildToolNoisePlaceholder({
          sessionId,
          seq: message.__meta?.seq,
          toolName: part.functionCall.name,
          kind: 'function_call',
          estimatedTokens: functionCallTokens,
        });
        const compactedArgs = buildCompactedFunctionCallArgs(placeholder);
        nextPart.functionCall = {
          ...nextPart.functionCall,
          args: compactedArgs,
          rawArgsText: JSON.stringify(compactedArgs),
          argsParseError: undefined,
        };
        replacedFunctionCalls += 1;
        touched = true;
      }

      const functionResponseTokens = getFunctionResponseTokenCount(part);
      if (part.functionResponse && functionResponseTokens > thresholdTokens) {
        const placeholder = buildToolNoisePlaceholder({
          sessionId,
          seq: message.__meta?.seq,
          toolName: part.functionResponse.name,
          kind: 'function_response',
          estimatedTokens: functionResponseTokens,
        });
        nextPart.functionResponse = {
          ...nextPart.functionResponse,
          response: buildCompactedFunctionResponse(placeholder),
        };
        replacedFunctionResponses += 1;
        touched = true;
      }

      return nextPart;
    });

    if (touched) {
      touchedMessages += 1;
    }

    return {
      ...message,
      parts: rewrittenParts,
    };
  });

  session.history = [
    ...rewrittenMessages,
    ...session.history.slice(splitIndex),
  ];
  session.historyVersion = (session.historyVersion || 0) + 1;
  session.indexingState = undefined;
  if (session.vectorIndexPosition !== undefined) {
    session.vectorIndexPosition = Math.min(session.vectorIndexPosition, session.history.length);
  }

  await deps.saveSession(sessionId);

  return {
    replacedFunctionCalls,
    replacedFunctionResponses,
    touchedMessages,
    inspectedMessages: targetMessages.length,
    keepStartIndex: splitIndex,
    thresholdTokens,
  };
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

  await runCompactionWithMode(deps, sessionId, {
    keepPercent: item.keepPercent,
    completionMarker: item.completionMarker || 'Compaction completed.',
    startLogMessage: 'Compaction starting',
  }, executionMode);
}