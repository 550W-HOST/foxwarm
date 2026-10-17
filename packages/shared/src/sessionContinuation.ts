/** Minimal history shape consumed by continuation and maintenance classification.
 * Runtime admission, persistence, and presentation belong to callers.
 */
export interface ContinuationFunctionCall {
  id?: string;
  name: string;
  args?: Record<string, unknown> | null;
}

export interface ContinuationFunctionResponse {
  tool_use_id?: string;
  name: string;
  response?: { error?: unknown; [key: string]: unknown };
}

export interface ContinuationMessagePart {
  text?: string;
  system?: string;
  thinking?: string;
  functionCall?: ContinuationFunctionCall;
  functionResponse?: ContinuationFunctionResponse;
}

export interface ContinuationMessage {
  role: string;
  parts: readonly ContinuationMessagePart[];
  modelVisible?: boolean;
  __meta?: {
    temporary?: boolean;
    optimistic?: boolean;
    noticeType?: string;
    goalReminder?: boolean;
    goalReminderKind?: string;
    llmSegment?: { complete: boolean; [key: string]: unknown };
    [key: string]: unknown;
  };
}

function isTransientClientMessage(message: ContinuationMessage): boolean {
  return message.__meta?.temporary === true || message.__meta?.optimistic === true;
}

function isLlmRetryNotice(message: ContinuationMessage): boolean {
  return message.__meta?.noticeType === 'llm-retry';
}

function isCompactCompletedText(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const marker = value.trim();
  if (!/^<foxwarm-system\b[^>]*\/>$/.test(marker)) return false;
  return /\bkind=(?:"session-boundary"|'session-boundary')/.test(marker)
    && /\bevent=(?:"compact-completed"|'compact-completed')/.test(marker);
}

function isCompactCompletedPart(part: ContinuationMessagePart): boolean {
  if (part.functionCall || part.functionResponse || (typeof part.thinking === 'string' && part.thinking.trim())) {
    return false;
  }
  const values = [part.text, part.system]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  return values.length > 0 && values.every(isCompactCompletedText);
}

function isCanonicalSystemOnlyPart(part: ContinuationMessagePart, predicate: (value: unknown) => boolean): boolean {
  return Object.keys(part).length === 1 && predicate(part.system);
}

function isCompactCompletionGoalReminderText(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const match = value.match(/^<foxwarm-system kind="goal-reminder"(?: hint="[^"]*")?>\n([\s\S]+)\n<\/foxwarm-system>$/);
  return !!match && match[1].trim().length > 0;
}

function isGeneratedCompactCompletionMessage(message: ContinuationMessage): boolean {
  return message.role === 'user'
    && message.__meta?.goalReminder === true
    && message.__meta?.goalReminderKind === 'compact-completion'
    && message.parts.length === 2
    && isCanonicalSystemOnlyPart(message.parts[0], isCompactCompletedText)
    && isCanonicalSystemOnlyPart(message.parts[1], isCompactCompletionGoalReminderText);
}

/** Canonical maintenance only; authored text and messages with extra content are not maintenance. */
export function isCompactCompletionMaintenanceMessage(message: ContinuationMessage): boolean {
  return isGeneratedCompactCompletionMessage(message)
    || message.role === 'user' && message.parts.length === 1
      && isCanonicalSystemOnlyPart(message.parts[0], isCompactCompletedText);
}

function isCompactCompletedMessage(message: ContinuationMessage): boolean {
  if (isGeneratedCompactCompletionMessage(message)) return true;
  const meaningfulParts = message.parts.filter(part => (
    part.functionCall
    || part.functionResponse
    || (typeof part.thinking === 'string' && part.thinking.trim().length > 0)
    || (typeof part.text === 'string' && part.text.trim().length > 0)
    || (typeof part.system === 'string' && part.system.trim().length > 0)
  ));
  return meaningfulParts.length > 0 && meaningfulParts.every(isCompactCompletedPart);
}

function isTransparentMessage(message: ContinuationMessage): boolean {
  if (isTransientClientMessage(message)) return true;
  if (isLlmRetryNotice(message)) return false;
  return message.modelVisible === false || isCompactCompletedMessage(message);
}

function hasSuccessfulResponse(response: ContinuationFunctionResponse): boolean {
  return response.response?.error === undefined || response.response?.error === null;
}

function hasOnlyEffectiveBareWaitArgs(args: Record<string, unknown> | null | undefined): boolean {
  if (args === undefined) return true;
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return false;
  return Object.entries(args).every(([key, value]) => {
    if (key === 'reason') return typeof value === 'string';
    if (key === 'timeoutSeconds') return value === 0;
    if (key === 'waitAllSessions' || key === 'waitExecIds') return Array.isArray(value) && value.length === 0;
    return false;
  });
}

function isTerminalCompletionCall(call: ContinuationFunctionCall): boolean {
  if (call.name === 'wait') return hasOnlyEffectiveBareWaitArgs(call.args);
  return (call.name === 'send_to_session' || call.name === 'create_child_session')
    && (call.args?.afterSend === 'wait'
      || call.args?.afterSend === 'finish'
      || call.args?.waitAfterHandoff === true
      || call.args?.noFurtherAssistantReply === true);
}

function isTerminalToolCompletion(messages: readonly ContinuationMessage[], messageIndex: number): boolean {
  let callBatchIndex = -1;
  for (let index = messageIndex - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (isTransparentMessage(message)) continue;
    if (message.role === 'tool') continue;
    const calls = message.role === 'model'
      ? message.parts.map(part => part.functionCall).filter((call): call is ContinuationFunctionCall => !!call)
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
    .filter((call): call is ContinuationFunctionCall => !!call);
  const callsById = new Map<string, ContinuationFunctionCall>();
  for (const call of calls) {
    if (typeof call.id !== 'string' || !call.id || typeof call.name !== 'string' || !call.name || callsById.has(call.id)) {
      return false;
    }
    callsById.set(call.id, call);
  }

  const responses: ContinuationFunctionResponse[] = [];
  for (let index = callBatchIndex + 1; index <= messageIndex; index += 1) {
    const message = messages[index];
    if (isTransparentMessage(message)) continue;
    if (message.role !== 'tool') return false;
    if (message.parts.some(part => !!part.functionCall)) return false;
    const messageResponses = message.parts
      .map(part => part.functionResponse)
      .filter((response): response is ContinuationFunctionResponse => !!response);
    if (messageResponses.length === 0) return false;
    responses.push(...messageResponses);
  }
  if (responses.length !== calls.length) return false;

  const responsesById = new Map<string, ContinuationFunctionResponse>();
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
export function isSessionTurnIncomplete(messages: readonly ContinuationMessage[]): boolean {
  let lastIndex = messages.length - 1;
  while (lastIndex >= 0 && isTransparentMessage(messages[lastIndex])) lastIndex -= 1;
  if (lastIndex < 0) return false;

  const lastMessage = messages[lastIndex];
  if (isLlmRetryNotice(lastMessage)) return true;
  if (lastMessage.role === 'user') return true;

  if (lastMessage.role === 'model') {
    const hasOrdinaryText = lastMessage.parts.some(part => typeof part.text === 'string' && part.text.trim().length > 0);
    const hasFunctionCall = lastMessage.parts.some(part => !!part.functionCall);
    if (lastMessage.__meta?.llmSegment?.complete === false) return true;
    if (lastMessage.__meta?.llmSegment?.complete === true) return hasFunctionCall;
    return !hasOrdinaryText || hasFunctionCall;
  }

  if (lastMessage.role === 'tool') {
    return !isTerminalToolCompletion(messages, lastIndex);
  }

  return true;
}
