import { randomUUID } from 'crypto';
import { logger } from './common';
import * as llm from './llm';
import * as sessionManager from './sessionManager';
import { createDisplayOnlyModelMessage } from './session/messageVisibility';
import { formatFoxwarmSystem } from './utils/promptWrappers';
import type { ChatResult, FunctionCall, Message, MessagePart, Session } from './types';

export const BTW_USAGE = 'Usage: /btw <message>';

const BTW_SIDE_REQUEST_PROMPT = [
  'This is a side/background BTW request, not the main conversation turn.',
  'Answer only the BTW request below, using the copied conversation context only as background.',
  'Do not call tools in BTW mode. Tool execution is disabled for this request.',
  'If reliable completion would require a tool call or external side effect, say that it cannot be completed in BTW mode and explain briefly.',
].join('\n');

function cloneMessageArray(messages: Message[]): Message[] {
  return structuredClone(messages || []);
}

export function cloneSessionForBtw(session: Session): Session {
  return {
    id: session.id,
    agent: session.agent,
    aliases: session.aliases ? [...session.aliases] : undefined,
    history: cloneMessageArray(session.history),
    systemPromptFiles: session.systemPromptFiles ? [...session.systemPromptFiles] : undefined,
    persistentMemorySnapshot: session.persistentMemorySnapshot,
    // BTW side requests reuse the real session's prompt-cache routing key.
    // The model-facing prefix/schema is copied from the real session, and the
    // temporary BTW prompt only appends to that prefix; generating a fresh key
    // here would unnecessarily miss the existing KV/prompt cache.
    promptCacheKey: session.promptCacheKey,
    stats: {
      totalCachedTokens: session.stats?.totalCachedTokens || 0,
      totalInputTokens: session.stats?.totalInputTokens || 0,
      totalOutputTokens: session.stats?.totalOutputTokens || 0,
      lastUsage: session.stats?.lastUsage || null,
    },
    busy: false,
    queue: [],
    meta: structuredClone(session.meta || { lastMessageTime: Date.now() }),
    displayName: session.displayName,
    archived: session.archived,
    currentNode: session.currentNode,
    cwd: session.cwd,
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
  };
}

function buildBtwRequestParts(message: string): MessagePart[] {
  return [
    { system: formatFoxwarmSystem({ kind: 'btw', type: 'side-request' }, BTW_SIDE_REQUEST_PROMPT) },
    { text: message },
  ];
}

function extractText(result: ChatResult): string {
  const directText = result.text?.trim();
  if (directText) {
    return directText;
  }

  const partText = result.allParts
    ?.map(part => typeof part.text === 'string' ? part.text : '')
    .filter(Boolean)
    .join('\n')
    .trim();
  return partText || '(BTW completed with no text output.)';
}

function formatToolNames(toolCalls: FunctionCall[]): string {
  const names = [...new Set(toolCalls.map(call => call.name).filter(Boolean))];
  return names.length > 0 ? names.map(name => `\`${name}\``).join(', ') : 'unknown tool';
}

function formatBtwPayload(text: string): string {
  return `📝 [BTW result]\n${text.trim() || '(empty)'}`;
}

function formatBtwToolDenied(toolCalls: FunctionCall[]): string {
  return [
    '⚠️ [BTW aborted]',
    `The side request attempted to call tool(s): ${formatToolNames(toolCalls)}.`,
    'BTW mode does not execute tools. Please ask in the main chat if tool use is needed.',
  ].join('\n');
}

function formatBtwError(error: any): string {
  const message = error?.message || String(error || 'Unknown error');
  return `⚠️ [BTW error]\n${message}`;
}

export type BtwExecutionResult = {
  payloadText: string;
  toolDenied: boolean;
  modelId?: string;
  virtualModelKey?: string;
};

export function ensureBtwPromptCacheKey(session: Session): boolean {
  const previousPromptCacheKey = session.promptCacheKey;
  llm.ensurePromptCacheKey(session);
  return session.promptCacheKey !== previousPromptCacheKey;
}

export function buildBtwDisplayResult(result: BtwExecutionResult): { text: string; message: Message } {
  const text = formatBtwPayload(result.payloadText);
  const message = createDisplayOnlyModelMessage(text, {
    noticeType: 'btw',
    ...(result.modelId ? { modelId: result.modelId } : {}),
    ...(result.virtualModelKey ? { virtualModelKey: result.virtualModelKey } : {}),
  });
  return { text, message };
}

export async function executeBtwRequest(
  snapshot: Session,
  message: string,
): Promise<BtwExecutionResult> {
  const sessionId = snapshot.id;
  const requestId = randomUUID();
  const appendToTempHistory = async (newMessage: Message) => {
    snapshot.history.push(structuredClone(newMessage));
  };

  let payloadText: string;
  let toolDenied = false;
  let modelId: string | undefined;
  let virtualModelKey: string | undefined;

  try {
    logger.info({ sessionId, requestId }, 'BTW background request started');
    const result = await llm.chat(buildBtwRequestParts(message), snapshot, 0, {
      appendMessage: appendToTempHistory,
      notifySessionEvents: false,
      registerAbortController: false,
      purpose: 'btw',
    });
    modelId = result.modelId;
    virtualModelKey = result.virtualModelKey;

    if (result.toolCalls?.length) {
      toolDenied = true;
      payloadText = formatBtwToolDenied(result.toolCalls);
      logger.info({ sessionId, requestId, toolCalls: result.toolCalls.map(call => call.name) }, 'BTW request denied tool call');
    } else {
      payloadText = extractText(result);
    }
  } catch (error: any) {
    logger.error({ err: error, sessionId, requestId }, 'BTW background request failed');
    payloadText = formatBtwError(error);
  }

  logger.info({ sessionId, requestId, toolDenied }, 'BTW background request finished');
  return {
    payloadText,
    toolDenied,
    ...(modelId ? { modelId } : {}),
    ...(virtualModelKey ? { virtualModelKey } : {}),
  };
}

async function appendBtwResult(sessionId: string, result: BtwExecutionResult): Promise<string> {
  const session = await sessionManager.getSession(sessionId);
  const { text, message } = buildBtwDisplayResult(result);
  await sessionManager.appendSessionMessage(session, message);

  if (session.broadcast) {
    session.broadcast(text, { excludePlatforms: ['webui'] });
  }

  return text;
}

export async function runBtwRequest(sessionId: string, message: string): Promise<{ text: string; toolDenied: boolean }> {
  const sourceSession = await sessionManager.getSession(sessionId);
  if (ensureBtwPromptCacheKey(sourceSession)) {
    await sessionManager.saveSession(sourceSession.id);
  }
  const result = await executeBtwRequest(cloneSessionForBtw(sourceSession), message);
  const text = await appendBtwResult(sessionId, result);
  return { text, toolDenied: result.toolDenied };
}
