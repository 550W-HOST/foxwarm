import * as llm from '../llm';
import { logger } from '../common';
import { COMPACT_PERCENT, resolveModelConfig } from '../config';
import { estimateSessionTokens, estimateTokenCount } from '../tokenCount';
import * as vector from '../vector';
import { appendMessagesToArchive, readArchiveMessages, readArchiveMessagesBySeqRange } from './archive';
import {
  buildBlockCandidateItem,
  buildCompactPlanValidationFeedback,
  buildCompactPromptText,
  buildMessageCandidateItem,
  COMPACT_PLAN_TOOL_DEFINITION,
  COMPACT_PLAN_TOOL_NAME,
  CompactCandidateItem,
  CompactPlan,
  CompactPlanValidationError,
  describeCreatedRanges,
  formatSeqRange,
  validateCompactPlanArgs,
} from './compactPlan';
import { Message, QueueItem, Session, TokenUsage, ContextFrontierItem } from '../types';
import { formatMessagePreviewText } from '../utils/messageFormat';
import { appendBlocksToArchive, cloneSessionFrontier, ensureContextFrontier, readArchiveBlocksByIdRange, renderHistoryFromFrontier } from './layeredContext';

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

type SessionHistoryDeps = {
  getSessionById: (sessionId: string) => Session | undefined;
  getExistingSession: (sessionId: string) => Promise<Session | null>;
  saveSession: (sessionId: string) => Promise<void>;
};

type CompactionRunOptions = {
  keepPercent?: number;
  completionMarker?: string;
  compactGuidance?: string;
  startLogMessage?: string;
  startBroadcastMessage?: string;
};

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

  return `Use get_archived_messages({sessionId: '${sessionId}'${seqArgs.length ? `, ${seqArgs.join(', ')}` : ''}}) to inspect the archived originals if needed.`;
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
    + estimateTokenCount(JSON.stringify(part.functionCall.args || {}));
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

function resolveCompactionSplitIndex(history: Message[], keepPercent: number): number {
  let splitIndex = Math.floor(history.length * (1 - keepPercent));

  if (keepPercent > 0) {
    while (splitIndex < history.length && history[splitIndex].role === 'tool') {
      splitIndex++;
    }
  } else {
    splitIndex = history.length;
  }

  return splitIndex;
}

async function buildLayeredCompactCandidateItems(session: Session, olderFrontier: ContextFrontierItem[]): Promise<CompactCandidateItem[]> {
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

  return olderFrontier.flatMap(item => {
    if (item.kind === 'message') {
      const record = messageMap.get(item.seq);
      if (!record) {
        return [];
      }
      return [buildMessageCandidateItem(item.seq, formatMessagePreviewText(record.message, 60, {
        skipEphemeralSystem: true,
        skipRagMemorySnippets: true,
        skipThinking: true,
      }).trim() || '[empty message]')];
    }

    const record = blockMap.get(item.id);
    if (!record) {
      return [];
    }

    return [buildBlockCandidateItem(record.id, record.level, record.rawStartSeq, record.rawEndSeq, record.summary)];
  });
}

function resolveCreateBlockRanges(plan: CompactPlan, candidateItems: CompactCandidateItem[]): Array<{ planIndex: number; startIndex: number; endIndex: number; rawStartSeq: number; rawEndSeq: number; sourceKind: 'message' | 'block'; level: number; sourceStart: number; sourceEnd: number; summary: string; }> {
  const operations: Array<{ planIndex: number; startIndex: number; endIndex: number; rawStartSeq: number; rawEndSeq: number; sourceKind: 'message' | 'block'; level: number; sourceStart: number; sourceEnd: number; summary: string; }> = [];

  for (let planIndex = 0; planIndex < plan.createBlocks.length; planIndex += 1) {
    const block = plan.createBlocks[planIndex];
    let startIndex = -1;
    let endIndex = -1;

    if (block.sourceKind === 'message') {
      for (let index = 0; index < candidateItems.length; index += 1) {
        const item = candidateItems[index];
        if (item.kind === 'message' && item.seq === block.sourceStart) {
          startIndex = index;
          break;
        }
      }
      if (startIndex < 0) {
        throw new Error(`Unable to resolve layered compact message range ${block.sourceStart}-${block.sourceEnd}.`);
      }
      endIndex = startIndex + (block.sourceEnd - block.sourceStart);
      operations.push({
        planIndex,
        startIndex,
        endIndex,
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
    operations.push({
      planIndex,
      startIndex,
      endIndex,
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

  if (session.broadcast) {
    session.broadcast(`Layered-context compaction completed. Created ${createdBlockCount} block(s) replacing ${replacedItemCount} older item(s).`);
  }
}

async function runCompaction(deps: SessionHistoryDeps, sessionId: string, options: CompactionRunOptions = {}): Promise<void> {
  const session = deps.getSessionById(sessionId);
  if (!session) return;

  const keepPercent = typeof options.keepPercent === 'number' ? options.keepPercent : COMPACT_PERCENT;
  const completionMarker = options.completionMarker || 'Compaction completed.';
  const compactGuidance = options.compactGuidance?.trim();

  const history = session.history;
  if (history.length < 1) return;

  logger.info({ sessionId, hasBroadcast: !!session.broadcast }, options.startLogMessage || 'Compaction starting');
  if (session.broadcast && options.startBroadcastMessage) {
    session.broadcast(options.startBroadcastMessage);
  }

  const frontier = cloneSessionFrontier(session);
  if (frontier.length === 0) {
    logger.info({ sessionId }, 'Compaction skipped because layered frontier is empty');
    return;
  }

  const splitIndex = resolveCompactionSplitIndex(history, keepPercent);
  if (splitIndex <= 0) {
    logger.info({ sessionId, keepPercent }, 'Compaction skipped because there are no older messages to compact');
    return;
  }

  const olderFrontier = frontier.slice(0, splitIndex);
  const forceKeptRecentFrontier = splitIndex < frontier.length ? frontier.slice(splitIndex) : [];
  const candidateItems = await buildLayeredCompactCandidateItems(session, olderFrontier);

  if (candidateItems.length === 0) {
    logger.info({ sessionId, splitIndex }, 'Compaction skipped because no layered candidate items were produced');
    return;
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

  try {
    const maxCompactAttempts = 3;
    let nextPromptParts = [summaryPrompt];
    let compactPlan: CompactPlan | null = null;

    for (let attempt = 1; attempt <= maxCompactAttempts; attempt++) {
      const result = await llm.chat(nextPromptParts, session, attempt - 1, {
        toolDefinitions: [COMPACT_PLAN_TOOL_DEFINITION],
      });

      if (!result.toolCalls?.length) {
        throw new Error(`Compaction failed because the model did not call ${COMPACT_PLAN_TOOL_NAME}.`);
      }
      if (result.toolCalls.length !== 1 || result.toolCalls[0].name !== COMPACT_PLAN_TOOL_NAME) {
        throw new Error(`Compaction failed because the model returned an unexpected tool plan instead of a single ${COMPACT_PLAN_TOOL_NAME} call.`);
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

    const operations = resolveCreateBlockRanges(compactPlan, candidateItems);
    const createdRecords = await appendBlocksToArchive(session, operations.map(operation => ({
      level: operation.level,
      sourceKind: operation.sourceKind,
      sourceStart: operation.sourceStart,
      sourceEnd: operation.sourceEnd,
      rawStartSeq: operation.rawStartSeq,
      rawEndSeq: operation.rawEndSeq,
      summary: operation.summary,
    })));

    const rewrittenOlderFrontier: ContextFrontierItem[] = [];
    let cursor = 0;
    for (let index = 0; index < operations.length; index += 1) {
      const operation = operations[index];
      const createdRecord = createdRecords[index];
      if (cursor < operation.startIndex) {
        rewrittenOlderFrontier.push(...olderFrontier.slice(cursor, operation.startIndex));
      }
      rewrittenOlderFrontier.push({
        kind: 'block',
        id: createdRecord.id,
        level: createdRecord.level,
        rawStartSeq: createdRecord.rawStartSeq,
        rawEndSeq: createdRecord.rawEndSeq,
      });
      cursor = operation.endIndex + 1;
    }
    if (cursor < olderFrontier.length) {
      rewrittenOlderFrontier.push(...olderFrontier.slice(cursor));
    }

    const newFrontier = [...rewrittenOlderFrontier, ...forceKeptRecentFrontier];
    await finalizeCompaction(
      deps,
      sessionId,
      session,
      newFrontier,
      completionMarker,
      createdRecords.length,
      operations.reduce((sum, operation) => sum + (operation.endIndex - operation.startIndex + 1), 0),
    );
  } catch (e) {
    logger.error(e, 'Compaction failed');
    throw e;
  }
}

export async function compactHistory(deps: SessionHistoryDeps, sessionId: string, keepPercent: number = COMPACT_PERCENT, completionMarker: string = 'Compaction completed.'): Promise<void> {
  await runCompaction(deps, sessionId, {
    keepPercent,
    completionMarker,
    startLogMessage: 'Compaction starting',
    startBroadcastMessage: '⚠️ Context size limit reached, compacting history...',
  });
}

export async function compactHistoryWithSummary(deps: SessionHistoryDeps, sessionId: string, summary: string, keepPercent: number = COMPACT_PERCENT, completionMarker: string = 'Manual compaction completed.'): Promise<void> {
  if (!summary || !summary.trim()) {
    throw new Error('Summary is required for manual compaction.');
  }

  await runCompaction(deps, sessionId, {
    keepPercent,
    completionMarker,
    compactGuidance: `Manual compaction hint from requester: ${summary.trim()}`,
    startLogMessage: 'Manual compaction starting',
    startBroadcastMessage: '⚠️ Manual compaction starting...',
  });
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

  session.history = [];
  session.contextFrontier = [];
  session.queue = [];
  session.stopping = false;
  session.busy = false;
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
        nextPart.functionCall = {
          ...nextPart.functionCall,
          args: buildCompactedFunctionCallArgs(placeholder),
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

  const currentSize = finalUsage
    ? getUsageTotalTokens(finalUsage)
    : estimateSessionTokens(session);

  const compactThreshold = getEffectiveCompactThresholdTokens(session);

  if (currentSize > compactThreshold) {
    logger.info({ currentSize, compactThreshold, sessionThresholdOverride: session.compactThresholdTokens }, 'Auto compact');
    await compactHistory(deps, sessionId).catch(e => logger.error(e, 'Auto-compact failed'));
  }
}

export async function processSessionCompactionRequest(
  deps: SessionHistoryDeps,
  sessionId: string,
  item: Pick<QueueItem, 'keepPercent' | 'compactGuidance' | 'completionMarker'>
): Promise<void> {
  if (item.compactGuidance?.trim()) {
    await compactHistoryWithSummary(
      deps,
      sessionId,
      item.compactGuidance,
      item.keepPercent,
      item.completionMarker || 'Compaction completed.'
    );
    return;
  }

  await compactHistory(
    deps,
    sessionId,
    item.keepPercent,
    item.completionMarker || 'Compaction completed.'
  );
}