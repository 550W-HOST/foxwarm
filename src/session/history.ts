import * as llm from '../llm';
import { logger } from '../common';
import { COMPACT_PERCENT, resolveModelConfig } from '../config';
import { estimateSessionTokens, estimateTokenCount } from '../tokenCount';
import * as vector from '../vector';
import { appendMessagesToArchive, readArchiveMessages } from './archive';
import {
  buildCompactCandidateBlocks,
  buildCompactPlanValidationFeedback,
  buildCompactPromptText,
  COMPACT_PLAN_TOOL_DEFINITION,
  COMPACT_PLAN_TOOL_NAME,
  CompactPlanValidationError,
  describeBlockRanges,
  formatSeqRange,
  validateCompactPlanArgs,
} from './compactPlan';
import { Message, QueueItem, Session, TokenUsage } from '../types';

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

async function finalizeCompaction(
  deps: SessionHistoryDeps,
  sessionId: string,
  session: Session,
  retainedMessages: Message[],
  summaryConversation: Message[],
  completionMarker: string,
  removedMessageCount: number,
): Promise<void> {
  const now = Date.now();
  const compactedMarker: Message = {
    role: 'user',
    parts: [{ system: 'This session has been compacted. Messages before this are removed.' }],
    __meta: { timestamp: now }
  };
  const completionMessage: Message = {
    role: 'user',
    parts: [{ system: completionMarker }],
    __meta: { timestamp: now }
  };
  const archiveOnlyRetainedSyntheticMessages = retainedMessages.filter(message => message.__meta?.seq === undefined);
  const archiveOnlySummaryMessages = summaryConversation.filter(message => message.__meta?.seq === undefined);
  await appendMessagesToArchive(session, [compactedMarker, ...archiveOnlyRetainedSyntheticMessages, ...archiveOnlySummaryMessages, completionMessage]);

  const summaryMessages: Message[] = [
    compactedMarker,
    ...retainedMessages,
    ...summaryConversation,
    completionMessage,
  ];

  session.persistentMemorySnapshot = await llm.getPersistentMemory(session.agent || 'main');
  session.history = summaryMessages;
  session.vectorIndexPosition = 0;
  session.historyVersion = (session.historyVersion || 0) + 1;
  session.indexingState = undefined;

  await deps.saveSession(sessionId);
  logger.info({ removedMessageCount, retainedCount: retainedMessages.length }, 'History compacted successfully');

  if (session.broadcast) {
    session.broadcast(`Compaction completed. Removed ${removedMessageCount} messages.`);
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
  const originalHistoryLength = history.length;

  logger.info({ sessionId, hasBroadcast: !!session.broadcast }, options.startLogMessage || 'Compaction starting');
  if (session.broadcast && options.startBroadcastMessage) {
    session.broadcast(options.startBroadcastMessage);
  }

  const splitIndex = resolveCompactionSplitIndex(history, keepPercent);

  if (splitIndex <= 0) {
    logger.info({ sessionId, keepPercent }, 'Compaction skipped because there are no older messages to compact');
    return;
  }

  const olderMessages = history.slice(0, splitIndex);
  const forceKeptRecentMessages = splitIndex < history.length ? history.slice(splitIndex) : [];
  const candidateBlocks = buildCompactCandidateBlocks(olderMessages);

  if (candidateBlocks.length === 0) {
    logger.info({ sessionId, splitIndex }, 'Compaction skipped because no candidate blocks were produced');
    return;
  }

  const forcedKeptStartSeq = forceKeptRecentMessages[0]?.__meta?.seq;
  const forcedKeptEndSeq = forceKeptRecentMessages[forceKeptRecentMessages.length - 1]?.__meta?.seq;
  const summaryPrompt = {
    system: buildCompactPromptText({
      forcedKeptCount: forceKeptRecentMessages.length,
      forcedKeptStartSeq,
      forcedKeptEndSeq,
      candidateBlocks,
      guidance: compactGuidance,
    })
  };

  const beforeCompactIndex = session.history.length;

  try {
    const maxCompactAttempts = 3;
    let nextPromptParts = [summaryPrompt];
    let compactPlan = null;

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
        compactPlan = validateCompactPlanArgs(result.toolCalls[0].args || {}, candidateBlocks);
        break;
      } catch (e) {
        if (!(e instanceof CompactPlanValidationError)) {
          throw e;
        }

        const attemptsRemaining = maxCompactAttempts - attempt;
        if (attemptsRemaining <= 0) {
          throw new Error(`Compaction failed after ${maxCompactAttempts} invalid ${COMPACT_PLAN_TOOL_NAME} submissions: ${e.message}`);
        }

        logger.warn({ sessionId, attempt, attemptsRemaining, validationError: e.message }, 'Compaction plan validation failed; retrying compact flow');
        nextPromptParts = [{
          system: buildCompactPlanValidationFeedback(e, attemptsRemaining),
        }];
      }
    }

    if (!compactPlan) {
      throw new Error(`Compaction failed because no valid ${COMPACT_PLAN_TOOL_NAME} plan was produced.`);
    }

    const keptBlockIds = new Set(compactPlan.keepBlockIds);
    const retainedOlderMessages: Message[] = [];
    let pendingDroppedRange: { startSeq?: number; endSeq?: number; messageCount: number } | null = null;

    const flushDroppedRange = () => {
      if (!pendingDroppedRange) {
        return;
      }

      retainedOlderMessages.push(buildDroppedRangePlaceholder(
        sessionId,
        pendingDroppedRange.startSeq,
        pendingDroppedRange.endSeq,
        pendingDroppedRange.messageCount,
      ));
      pendingDroppedRange = null;
    };

    for (const block of candidateBlocks) {
      if (keptBlockIds.has(block.id)) {
        flushDroppedRange();
        retainedOlderMessages.push(...block.messages);
        continue;
      }

      if (!pendingDroppedRange) {
        pendingDroppedRange = {
          startSeq: block.startSeq,
          endSeq: block.endSeq,
          messageCount: block.messageCount,
        };
        continue;
      }

      pendingDroppedRange.endSeq = block.endSeq;
      pendingDroppedRange.messageCount += block.messageCount;
    }

    flushDroppedRange();

    const retainedMessages = [...retainedOlderMessages, ...forceKeptRecentMessages];

    const now = Date.now();
    const summaryConversation: Message[] = [
      {
        role: 'user',
        parts: [{
          system: [
            'Compaction plan applied via submit_compact_plan.',
            `Older blocks kept verbatim: ${describeBlockRanges(candidateBlocks, compactPlan.keepBlockIds)}.`,
            `Older blocks dropped from working history only: ${describeBlockRanges(candidateBlocks, compactPlan.dropBlockIds)}.`,
            `Recent force-kept messages: ${forceKeptRecentMessages.length > 0 ? `${forceKeptRecentMessages.length} message(s), ${formatSeqRange(forcedKeptStartSeq, forcedKeptEndSeq)}` : 'none'}.`,
          ].join(' ')
        }],
        __meta: { timestamp: now }
      },
      {
        role: 'model',
        parts: [{ text: compactPlan.summary }],
        __meta: { timestamp: now }
      },
    ];

    await finalizeCompaction(deps, sessionId, session, retainedMessages, summaryConversation, completionMarker, originalHistoryLength - retainedMessages.length);
  } catch (e) {
    if (session.history.length > beforeCompactIndex) {
      session.history = session.history.slice(0, beforeCompactIndex);
      await deps.saveSession(sessionId);
    }
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

  session.history = [];
  session.queue = [];
  session.stopping = false;
  session.busy = false;
  session.vectorIndexPosition = 0;
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

  const { contextLimit } = resolveModelConfig(session.model);

  if (currentSize > contextLimit * 0.8) {
    logger.info({ currentSize, contextLimit }, 'Auto compact');
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