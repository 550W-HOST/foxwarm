import * as llm from '../llm';
import { logger } from '../common';
import { COMPACT_PERCENT, resolveModelConfig } from '../config';
import { estimateSessionTokens } from '../tokenCount';
import * as vector from '../vector';
import { appendMessagesToArchive } from './archive';
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
} from '../compactPlan';
import { Message, QueueItem, Session, TokenUsage } from '../types';

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
  const archiveOnlySummaryMessages = summaryConversation.filter(message => message.__meta?.seq === undefined);
  await appendMessagesToArchive(session, [compactedMarker, ...archiveOnlySummaryMessages, completionMessage]);

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

  let splitIndex = Math.floor(history.length * (1 - keepPercent));

  if (keepPercent > 0) {
    while (splitIndex < history.length && history[splitIndex].role === 'tool') {
      splitIndex++;
    }
  } else {
    splitIndex = history.length;
  }

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

    const candidateById = new Map(candidateBlocks.map(block => [block.id, block]));
    const keptOlderMessages = compactPlan.keepBlockIds.flatMap(blockId => candidateById.get(blockId)?.messages || []);
    const retainedMessages = [...keptOlderMessages, ...forceKeptRecentMessages];

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