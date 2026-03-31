import * as llm from '../llm';
import { logger } from '../common';
import { COMPACT_PERCENT, resolveModelConfig } from '../config';
import { estimateSessionTokens, estimateTokenCount } from '../tokenCount';
import * as vector from '../vector';
import { appendMessagesToArchive, readArchiveMessages, readArchiveMessagesBySeqRange } from './archive';
import {
  buildBlockCandidateItem,
  buildCompactPlanValidationFeedback,
  buildCompactFlowToolDefinitions,
  buildCompactPromptText,
  buildMessageCandidateItem,
  COMPACT_PLAN_TOOL_NAME,
  CompactCandidateItem,
  CompactPlan,
  CompactPlanValidationError,
  describeCreatedRanges,
  formatSeqRange,
  validateCompactPlanArgs,
} from './compactPlan';
import { Message, MessagePart, QueueItem, Session, TokenUsage, ContextFrontierItem } from '../types';
import { stringifyFunctionCallArgs } from '../toolCallArgs';
import { formatMessagePreviewText } from '../utils/messageFormat';
import { appendBlocksToArchive, cloneSessionFrontier, ensureContextFrontier, readArchiveBlocksByIdRange, renderHistoryFromFrontier, shouldIgnoreMessageInCompactCandidates } from './layeredContext';

const TOOL_NOISE_TOKEN_THRESHOLD = 200;

export interface ArchivedMessagesQueryOptions {
  startSeq?: number;
  endSeq?: number;
}

export interface ArchivedMessagesQueryResult {
  records: Array<{ seq: number; message: Message }>;
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

type SessionHistoryDeps = {
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

type CompactJobRequest = Pick<QueueItem, 'keepPercent' | 'compactGuidance' | 'completionMarker'>;

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
  summary: string;
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
        rawStartSeq: number;
        rawEndSeq: number;
        summary: string;
      }>;
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

const ASYNC_COMPACT_DONE_NOTICE = '🗜️ Background compaction finished and has been applied. This chat stayed available while it was running.';

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
    logger.info({ sessionId, latestSeqHint }, 'Force indexing session archive');
    await vector.indexSessionArchive(sessionId, latestSeqHint);
    session.vectorIndexPosition = session.history.length;
    session.indexingState = undefined;
    await deps.saveSession(sessionId);
  } catch (e) {
    logger.error({ err: e, sessionId }, 'Failed to force index session archive');
    throw e;
  }
}

function buildArchiveLookupInstruction(sessionId: string, startSeq?: number, endSeq?: number): string {
  const seqArgs: string[] = [];
  if (typeof startSeq === 'number') {
    seqArgs.push(`startSeq: ${startSeq}`);
  }
  if (typeof endSeq === 'number') {
    seqArgs.push(`endSeq: ${endSeq}`);
  }

  return `Use get_context_archive({sessionId: '${sessionId}'${seqArgs.length ? `, ${seqArgs.join(', ')}` : ''}}) or get_archived_messages({sessionId: '${sessionId}'${seqArgs.length ? `, ${seqArgs.join(', ')}` : ''}}) to inspect the archived originals if needed.`;
}

function buildDroppedRangePlaceholder(sessionId: string, startSeq?: number, endSeq?: number, messageCount?: number): Message {
  const countLabel = typeof messageCount === 'number' && messageCount > 0
    ? `${messageCount} message(s)`
    : 'a compacted message range';
  const rangeLabel = formatSeqRange(startSeq, endSeq);

  return {
    role: 'user',
    parts: [{
      system: `Compacted message placeholder: ${countLabel} from ${rangeLabel} were removed from working history here. ${buildArchiveLookupInstruction(sessionId, startSeq, endSeq)}`
    }],
  };
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
  const { sessionId, seq, toolName, kind, estimatedTokens } = options;
  const rangeLabel = typeof seq === 'number' ? `#${seq}` : '(seq unavailable)';
  const kindLabel = kind === 'function_call' ? 'tool call' : 'tool response';
  const toolLabel = toolName || 'unknown';
  const lookup = typeof seq === 'number'
    ? `archive ${rangeLabel} via get_archived_messages`
    : 'see archive via get_archived_messages';
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
    todoState: session.todoState ? structuredClone(session.todoState) : undefined,
    compactThresholdTokens: session.compactThresholdTokens,
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

function appendTransientSessionMessage(session: Session, message: Message): Promise<void> {
  session.history.push(message);
  return Promise.resolve();
}

function contextFrontierItemsEqual(a: ContextFrontierItem | undefined, b: ContextFrontierItem | undefined): boolean {
  if (!a || !b || a.kind !== b.kind) {
    return false;
  }

  if (a.kind === 'message' && b.kind === 'message') {
    return a.seq === b.seq;
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

type LayeredCompactCandidateEntry = {
  item: CompactCandidateItem;
  frontierStartIndex: number;
  frontierEndIndex: number;
};

export function resolveCompactionSplitIndex(history: Message[], keepPercent: number): number {
  let splitIndex = Math.floor(history.length * (1 - keepPercent));

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
  } else {
    splitIndex = history.length;
  }

  return splitIndex;
}

async function buildLayeredCompactCandidateEntries(session: Session, olderFrontier: ContextFrontierItem[]): Promise<LayeredCompactCandidateEntry[]> {
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

  const entries: LayeredCompactCandidateEntry[] = [];

  for (let frontierIndex = 0; frontierIndex < olderFrontier.length; frontierIndex += 1) {
    const item = olderFrontier[frontierIndex];

    if (item.kind === 'block') {
      const record = blockMap.get(item.id);
      if (!record) {
        continue;
      }

      entries.push({
        item: buildBlockCandidateItem(record.id, record.level, record.rawStartSeq, record.rawEndSeq, record.summary),
        frontierStartIndex: frontierIndex,
        frontierEndIndex: frontierIndex,
      });
      continue;
    }

    const record = messageMap.get(item.seq);
    if (!record || shouldIgnoreMessageInCompactCandidates(record.message)) {
      continue;
    }

    let groupedEndFrontierIndex = frontierIndex;
    const groupedRecords = [record];
    const startsToolExchange = record.message.role === 'model'
      && record.message.parts?.some(part => !!part.functionCall);

    if (startsToolExchange) {
      for (let nextIndex = frontierIndex + 1; nextIndex < olderFrontier.length; nextIndex += 1) {
        const nextItem = olderFrontier[nextIndex];
        if (nextItem.kind !== 'message') {
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

    const preview = groupedRecords
      .map(groupRecord => formatMessagePreviewText(groupRecord.message, 40, {
        skipEphemeralSystem: true,
        skipRagMemorySnippets: true,
        skipThinking: true,
      }).trim())
      .filter(Boolean)
      .join(' | ') || '[empty message]';

    entries.push({
      item: buildMessageCandidateItem(item.seq, groupedRecords[groupedRecords.length - 1].seq, preview),
      frontierStartIndex: frontierIndex,
      frontierEndIndex: groupedEndFrontierIndex,
    });

    frontierIndex = groupedEndFrontierIndex;
  }

  return entries;
}

function resolveCreateBlockRanges(plan: CompactPlan, candidateEntries: LayeredCompactCandidateEntry[]): Array<{ planIndex: number; startIndex: number; endIndex: number; frontierStartIndex: number; frontierEndIndex: number; rawStartSeq: number; rawEndSeq: number; sourceKind: 'message' | 'block'; level: number; sourceStart: number; sourceEnd: number; summary: string; }> {
  const operations: Array<{ planIndex: number; startIndex: number; endIndex: number; frontierStartIndex: number; frontierEndIndex: number; rawStartSeq: number; rawEndSeq: number; sourceKind: 'message' | 'block'; level: number; sourceStart: number; sourceEnd: number; summary: string; }> = [];
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
      for (let index = startIndex; index < candidateItems.length; index += 1) {
        const item = candidateItems[index];
        if (item.kind !== 'message') {
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
    endIndex = startIndex + (block.sourceEnd - block.sourceStart);
    const startItem = candidateItems[startIndex];
    const endItem = candidateItems[endIndex];
    if (startItem.kind !== 'block' || endItem.kind !== 'block') {
      throw new Error(`Layered compact block range ${block.sourceStart}-${block.sourceEnd} resolved to non-block items.`);
    }
    const startEntry = candidateEntries[startIndex];
    const endEntry = candidateEntries[endIndex];
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
      summary: block.summary,
    });
  }

  return operations.sort((a, b) => a.startIndex - b.startIndex || a.planIndex - b.planIndex);
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
): Promise<void> {
  session.contextFrontier = newFrontier;
  session.persistentMemorySnapshot = await llm.getPersistentMemory(session.agent || 'main');
  session.history = await renderHistoryFromFrontier(session, newFrontier);

  const completionMessage: Message = {
    role: 'user',
    parts: [{ system: completionMarker }],
    __meta: { timestamp: Date.now() },
  };
  await appendMessagesToArchive(session, [completionMessage]);
  session.history.push(completionMessage);
  ensureContextFrontier(session).push({ kind: 'message', seq: completionMessage.__meta!.seq! });

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
  const candidateEntries = await buildLayeredCompactCandidateEntries(transientSession, olderFrontier);
  const candidateItems = candidateEntries.map(entry => entry.item);

  if (candidateItems.length === 0) {
    logger.info({ sessionId, splitIndex }, 'Compaction skipped because no layered candidate items were produced');
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
      guidance: compactGuidance,
    })
  };

  const maxCompactAttempts = 3;
  let nextPromptParts: MessagePart[] | null = [summaryPrompt];
  let compactPlan: CompactPlan | null = null;
  let compactHelperRounds = 0;
  const compactToolDefinitions = buildCompactFlowToolDefinitions();
  const compactHelperToolNames = new Set([
    'read_memory',
    'write_memory',
    'edit_memory',
    'delete_memory',
    'get_archived_messages',
    'get_archived_blocks',
    'get_context_archive',
  ]);
  const maxCompactHelperRounds = 6;

  for (let attempt = 1; attempt <= maxCompactAttempts; attempt += 1) {
    const result = await llm.chat(nextPromptParts, transientSession, attempt - 1, {
      toolDefinitions: compactToolDefinitions,
      appendMessage: async (message) => {
        await appendTransientSessionMessage(transientSession, message);
        mirrorTemporaryCompactMessage(deps, sessionId, message);
      },
      notifySessionEvents: false,
      registerAbortController: false,
    });

    if (!result.toolCalls?.length) {
      throw new Error(`Compaction failed because the model did not call ${COMPACT_PLAN_TOOL_NAME}.`);
    }

    const onlyPlanCall = result.toolCalls.length === 1 && result.toolCalls[0].name === COMPACT_PLAN_TOOL_NAME;
    if (!onlyPlanCall) {
      const invalidToolName = result.toolCalls.find(call => !compactHelperToolNames.has(call.name))?.name;
      if (invalidToolName) {
        throw new Error(`Compaction failed because the model called unexpected tool \`${invalidToolName}\` instead of finishing with ${COMPACT_PLAN_TOOL_NAME}.`);
      }
      if (compactHelperRounds >= maxCompactHelperRounds) {
        throw new Error(`Compaction failed because helper tool usage exceeded ${maxCompactHelperRounds} round(s) without producing ${COMPACT_PLAN_TOOL_NAME}.`);
      }

      const toolResultMessage = await llm.executeTools(result.toolCalls, {
        sessionId,
        session: transientSession,
      }, transientSession);
      await appendTransientSessionMessage(transientSession, {
        role: 'tool',
        parts: toolResultMessage.parts,
      });
      mirrorTemporaryCompactMessage(deps, sessionId, {
        role: 'tool',
        parts: toolResultMessage.parts,
      });
      nextPromptParts = null;
      compactHelperRounds += 1;
      attempt -= 1;
      continue;
    }

    try {
      compactPlan = validateCompactPlanArgs(result.toolCalls[0].args || {}, candidateItems);
      break;
    } catch (e) {
      if (!(e instanceof CompactPlanValidationError)) {
        throw e;
      }

      const attemptsRemaining = maxCompactAttempts - attempt;
      if (attemptsRemaining <= 0) {
        throw new Error(`Compaction failed after ${maxCompactAttempts} invalid ${COMPACT_PLAN_TOOL_NAME} submissions: ${e.message}`);
      }

      logger.warn({ sessionId, attempt, attemptsRemaining, validationError: e.message }, 'Layered compact plan validation failed; retrying compact flow');
      nextPromptParts = [{
        system: buildCompactPlanValidationFeedback(e, attemptsRemaining),
      }];
    }
  }

  if (!compactPlan) {
    throw new Error(`Compaction failed because no valid ${COMPACT_PLAN_TOOL_NAME} plan was produced.`);
  }

  const operations = resolveCreateBlockRanges(compactPlan, candidateEntries);
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
      summary: operation.summary,
    })),
    createdBlocks: operations.map(operation => ({
      level: operation.level,
      sourceKind: operation.sourceKind,
      sourceStart: operation.sourceStart,
      sourceEnd: operation.sourceEnd,
      rawStartSeq: operation.rawStartSeq,
      rawEndSeq: operation.rawEndSeq,
      summary: operation.summary,
    })),
    replacedItemCount: operations.reduce((sum, operation) => sum + (operation.frontierEndIndex - operation.frontierStartIndex + 1), 0),
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

  const rewrittenOlderFrontier: ContextFrontierItem[] = [];
  let cursor = 0;
  for (let index = 0; index < result.operations.length; index += 1) {
    const operation = result.operations[index];
    const createdRecord = createdRecords[index];
    if (cursor < operation.frontierStartIndex) {
      rewrittenOlderFrontier.push(...olderFrontier.slice(cursor, operation.frontierStartIndex));
    }
    rewrittenOlderFrontier.push({
      kind: 'block',
      id: createdRecord.id,
      level: createdRecord.level,
      rawStartSeq: createdRecord.rawStartSeq,
      rawEndSeq: createdRecord.rawEndSeq,
    });
    cursor = operation.frontierEndIndex + 1;
  }
  if (cursor < olderFrontier.length) {
    rewrittenOlderFrontier.push(...olderFrontier.slice(cursor));
  }

  const newFrontier = [...rewrittenOlderFrontier, ...currentFrontier.slice(result.consumedFrontierCount)];
  await finalizeCompaction(
    deps,
    sessionId,
    session,
    newFrontier,
    result.completionMarker,
    result.completionBroadcastMessage,
    createdRecords.length,
    result.replacedItemCount,
  );
  return true;
}

async function runCompaction(deps: SessionHistoryDeps, sessionId: string, options: CompactionRunOptions = {}): Promise<boolean> {
  const session = deps.getSessionById(sessionId);
  if (!session) return false;

  logger.info({ sessionId, hasBroadcast: !!session.broadcast }, options.startLogMessage || 'Compaction starting');
  if (session.broadcast && options.startBroadcastMessage) {
    session.broadcast(options.startBroadcastMessage);
  }

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
  session.meta = {
    ...session.meta,
    lastMessageTime: Date.now(),
    messageCount: 0,
  };

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
  item: Pick<QueueItem, 'keepPercent' | 'compactGuidance' | 'completionMarker'>,
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