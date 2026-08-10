import type { FunctionCall, FunctionResponse, Message, MessagePart } from './types';

export class SessionContinuationUnavailableError extends Error {
  readonly code = 'SESSION_CONTINUATION_NOT_AVAILABLE';

  constructor(message = 'Session has no interrupted turn to continue.') {
    super(message);
    this.name = 'SessionContinuationUnavailableError';
  }
}

function isTransientClientMessage(message: Message): boolean {
  return message.__meta?.temporary === true || message.__meta?.optimistic === true;
}

function isLlmRetryNotice(message: Message): boolean {
  return message.__meta?.noticeType === 'llm-retry';
}

function isCompactCompletedText(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const marker = value.trim();
  if (!/^<foxwarm-system\b[^>]*\/>$/.test(marker)) return false;
  return /\bkind=(?:"session-boundary"|'session-boundary')/.test(marker)
    && /\bevent=(?:"compact-completed"|'compact-completed')/.test(marker);
}

function isCompactCompletedPart(part: MessagePart): boolean {
  if (part.functionCall || part.functionResponse || (typeof part.thinking === 'string' && part.thinking.trim())) {
    return false;
  }
  const values = [part.text, part.system]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  return values.length > 0 && values.every(isCompactCompletedText);
}

function isCompactCompletedMessage(message: Message): boolean {
  const meaningfulParts = message.parts.filter(part => (
    part.functionCall
    || part.functionResponse
    || (typeof part.thinking === 'string' && part.thinking.trim().length > 0)
    || (typeof part.text === 'string' && part.text.trim().length > 0)
    || (typeof part.system === 'string' && part.system.trim().length > 0)
  ));
  return meaningfulParts.length > 0 && meaningfulParts.every(isCompactCompletedPart);
}

function isTransparentMessage(message: Message): boolean {
  if (isTransientClientMessage(message)) return true;
  if (isLlmRetryNotice(message)) return false;
  return message.modelVisible === false || isCompactCompletedMessage(message);
}

function hasSuccessfulResponse(response: FunctionResponse): boolean {
  return response.response?.error === undefined || response.response?.error === null;
}

function hasOnlyBareWaitArgs(args: Record<string, any> | undefined): boolean {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return true;
  return Object.keys(args).every(key => key === 'reason');
}

function isTerminalCompletionCall(call: FunctionCall): boolean {
  if (call.name === 'wait') return hasOnlyBareWaitArgs(call.args);
  return (call.name === 'send_to_session' || call.name === 'create_child_session')
    && call.args?.waitAfterHandoff === true;
}

function isTerminalToolCompletion(messages: readonly Message[], messageIndex: number): boolean {
  let callBatchIndex = -1;
  for (let index = messageIndex - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (isTransparentMessage(message)) continue;
    if (message.role === 'tool') continue;
    const calls = message.role === 'model'
      ? message.parts.map(part => part.functionCall).filter((call): call is FunctionCall => !!call)
      : [];
    if (calls.length === 0) return false;
    callBatchIndex = index;
    break;
  }
  if (callBatchIndex < 0) return false;

  const callBatch = messages[callBatchIndex];
  if (callBatch.parts.some(part => !!part.functionResponse)) return false;
  const calls = callBatch.parts
    .map(part => part.functionCall)
    .filter((call): call is FunctionCall => !!call);
  const callsById = new Map<string, FunctionCall>();
  for (const call of calls) {
    if (typeof call.id !== 'string' || !call.id || typeof call.name !== 'string' || !call.name || callsById.has(call.id)) {
      return false;
    }
    callsById.set(call.id, call);
  }

  const responses: FunctionResponse[] = [];
  for (let index = callBatchIndex + 1; index <= messageIndex; index += 1) {
    const message = messages[index];
    if (isTransparentMessage(message)) continue;
    if (message.role !== 'tool') return false;
    if (message.parts.some(part => !!part.functionCall)) return false;
    const messageResponses = message.parts
      .map(part => part.functionResponse)
      .filter((response): response is FunctionResponse => !!response);
    if (messageResponses.length === 0) return false;
    responses.push(...messageResponses);
  }
  if (responses.length !== calls.length) return false;

  const responsesById = new Map<string, FunctionResponse>();
  for (const response of responses) {
    const id = response.tool_use_id;
    if (typeof id !== 'string' || !id || typeof response.name !== 'string' || !response.name || responsesById.has(id)) {
      return false;
    }
    const call = callsById.get(id);
    if (!call || call.name !== response.name) return false;
    responsesById.set(id, response);
  }

  return calls.some(call => {
    if (typeof call.id !== 'string') return false;
    const response = responsesById.get(call.id);
    return !!response && isTerminalCompletionCall(call) && hasSuccessfulResponse(response);
  });
}

/**
 * Derives whether committed history ends inside an unfinished turn. Runtime
 * idle/waiting/active admission is intentionally checked by the caller.
 */
export function isSessionTurnIncomplete(messages: readonly Message[]): boolean {
  let lastIndex = messages.length - 1;
  while (lastIndex >= 0 && isTransparentMessage(messages[lastIndex])) lastIndex -= 1;
  if (lastIndex < 0) return false;

  const lastMessage = messages[lastIndex];
  if (isLlmRetryNotice(lastMessage)) return true;
  if (lastMessage.role === 'user') return true;

  if (lastMessage.role === 'model') {
    const hasOrdinaryText = lastMessage.parts.some(part => typeof part.text === 'string' && part.text.trim().length > 0);
    const hasFunctionCall = lastMessage.parts.some(part => !!part.functionCall);
    return !hasOrdinaryText || hasFunctionCall;
  }

  if (lastMessage.role === 'tool') {
    return !isTerminalToolCompletion(messages, lastIndex);
  }

  return true;
}
