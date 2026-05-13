import { randomUUID } from 'crypto';
import { logger } from './common';
import * as llm from './llm';
import * as sessionManager from './sessionManager';
import { createDisplayOnlyModelMessage } from './session/messageVisibility';
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

function cloneSessionForBtw(session: Session): Session {
  return {
    id: session.id,
    agent: session.agent,
    aliases: session.aliases ? [...session.aliases] : undefined,
    history: cloneMessageArray(session.history),
    systemPromptFiles: session.systemPromptFiles ? [...session.systemPromptFiles] : undefined,
    persistentMemorySnapshot: session.persistentMemorySnapshot,
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
    childModelDefault: session.childModelDefault,
    verbose: session.verbose,
    vectorIndexPosition: session.vectorIndexPosition,
    indexingState: session.indexingState ? structuredClone(session.indexingState) : undefined,
    historyVersion: session.historyVersion,
    nextMessageSeq: session.nextMessageSeq,
    nextBlockId: session.nextBlockId,
    contextFrontier: session.contextFrontier ? structuredClone(session.contextFrontier) : undefined,
    parentSessionId: session.parentSessionId,
    goalState: session.goalState ? structuredClone(session.goalState) : undefined,
    compactThresholdTokens: session.compactThresholdTokens,
  };
}

function buildBtwRequestParts(message: string): MessagePart[] {
  return [
    { system: BTW_SIDE_REQUEST_PROMPT },
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

async function appendBtwResult(sessionId: string, payloadText: string): Promise<string> {
  const session = await sessionManager.getSession(sessionId);
  const text = formatBtwPayload(payloadText);
  await sessionManager.appendSessionMessage(session, createDisplayOnlyModelMessage(text, {
    noticeType: 'btw',
  }));

  if (session.broadcast) {
    session.broadcast(text, { excludePlatforms: ['webui'] });
  }

  return text;
}

export async function runBtwRequest(sessionId: string, message: string): Promise<{ text: string; toolDenied: boolean }> {
  const sourceSession = await sessionManager.getSession(sessionId);
  const tempSession = cloneSessionForBtw(sourceSession);
  const requestId = randomUUID();
  const appendToTempHistory = async (newMessage: Message) => {
    tempSession.history.push(structuredClone(newMessage));
  };

  let payloadText: string;
  let toolDenied = false;

  try {
    logger.info({ sessionId, requestId }, 'BTW background request started');
    const result = await llm.chat(buildBtwRequestParts(message), tempSession, 0, {
      appendMessage: appendToTempHistory,
      notifySessionEvents: false,
      registerAbortController: false,
    });

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

  const text = await appendBtwResult(sessionId, payloadText);
  logger.info({ sessionId, requestId, toolDenied }, 'BTW background request finished');
  return { text, toolDenied };
}
