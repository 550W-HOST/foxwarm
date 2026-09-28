import { formatMessageHeading, createMessageContextPreviewItem, renderContextPreviewItems } from './contextPreviewRenderer';
import { requireVerifiedMcpInboundExternalId, type VerifiedMcpInboundPrincipal } from './mcpInboundConfig';
import type { ExternalExecutionContext } from './mcpInboundHttp';
import * as sessionManager from './sessionManager';
import * as sessionRuntime from './sessionRuntime';
import { buildExternalToolAuthorizationRequest, evaluateToolAuthorization, evaluateToolAuthorizationSync } from './toolAuthorization';
import { formatLocalTimestamp } from './utils/localTime';
import { formatFoxwarmSystemTag } from './utils/promptWrappers';

export class ExternalSessionBeforeAdmissionError extends Error {}

const DEFAULT_LIST_COUNT = 20;
const DEFAULT_READ_COUNT = 10;
const DEFAULT_PREVIEW_LENGTH = 6000;
const MAX_SEND_MESSAGE_BYTES = 1024 * 1024 - 4096; // Keep the complete user QueueItem within Worker ingress's 1 MiB limit.

function assertActive(context: ExternalExecutionContext, principal: VerifiedMcpInboundPrincipal): void {
  if (context.externalId !== requireVerifiedMcpInboundExternalId(principal) || context.disposed) {
    throw new ExternalSessionBeforeAdmissionError('External Session context is unavailable.');
  }
}
function exactTarget(requestedId: string): string {
  if (!requestedId || requestedId === '<main>' || requestedId === '<parent>' || requestedId !== requestedId.trim()
    || Buffer.byteLength(requestedId, 'utf8') > 256) {
    throw new ExternalSessionBeforeAdmissionError('An exact internal Session ID is required.');
  }
  const session = sessionManager.getSessionCatalog(requestedId);
  if (!session) throw new ExternalSessionBeforeAdmissionError('Session is unavailable.');
  return session.id;
}
async function authorize(principal: VerifiedMcpInboundPrincipal, context: ExternalExecutionContext,
  name: 'session' | 'get_session_messages' | 'send_to_session', args: Record<string, unknown>): Promise<void> {
  assertActive(context, principal);
  const request = buildExternalToolAuthorizationRequest({ principal, sessionId: context.id,
    tool: { source: 'builtin', name }, args });
  if ((await evaluateToolAuthorization(request)).action !== 'allow') {
    throw new ExternalSessionBeforeAdmissionError('Session action is not permitted.');
  }
  assertActive(context, principal);
}

/** One global catalog capability; it is not a per-row authorization projection. */
export async function listExternalSessions(principal: VerifiedMcpInboundPrincipal, context: ExternalExecutionContext,
  start = 0, count = DEFAULT_LIST_COUNT): Promise<unknown> {
  await authorize(principal, context, 'session', { action: 'list', start, count });
  const page = await sessionRuntime.listSessionsPage({ offset: start, limit: count });
  await authorize(principal, context, 'session', { action: 'list', start, count });
  return { total: page.total, start, count: page.sessions.length,
    ...(start + page.sessions.length < page.total ? { nextStart: start + page.sessions.length } : {}),
    sessions: page.sessions.map(session => ({ id: session.id,
      ...(session.displayName ? { displayName: session.displayName } : {}),
      busy: session.busy, queueLength: session.queueLength, messageCount: session.messageCount,
      lastMessageTime: session.lastMessageTime, currentNode: session.currentNode,
    })),
  };
}

/** Read an owner-aware history snapshot, never the Main catalog stub or raw queue/prompt snapshot. */
export async function readExternalSession(principal: VerifiedMcpInboundPrincipal, context: ExternalExecutionContext,
  requestedId: string, start?: number, count = DEFAULT_READ_COUNT, previewLength = DEFAULT_PREVIEW_LENGTH): Promise<unknown> {
  assertActive(context, principal);
  const sessionId = exactTarget(requestedId);
  const permissionArgs = { sessionId, ...(start === undefined ? {} : { start }), count, previewLength };
  await authorize(principal, context, 'get_session_messages', permissionArgs);
  const history = await sessionRuntime.getHistory(sessionId);
  assertActive(context, principal);
  if (!history || history.session.id !== sessionId || exactTarget(requestedId) !== sessionId) {
    throw new ExternalSessionBeforeAdmissionError('Session is unavailable.');
  }
  await authorize(principal, context, 'get_session_messages', permissionArgs);
  const total = history.messages.length;
  const actualStart = start === undefined ? Math.max(0, total - count)
    : Math.max(0, Math.min(start < 0 ? total + start : start, total));
  const messages = history.messages.slice(actualStart, actualStart + count);
  const items = messages.map((message, index) => createMessageContextPreviewItem({
    key: `session:${actualStart + index}`,
    heading: formatMessageHeading({ label: `[${actualStart + index}]`, message }),
    message,
  }));
  const preview = renderContextPreviewItems({ items,
    title: ({ matchedCount }) => `Session \`${sessionId}\` - showing ${matchedCount} of ${total} message(s):`,
    emptyMessage: `No messages found in session \`${sessionId}\` (total: ${total} messages).`,
    options: { previewLength },
  }).text;
  return { sessionId, start: actualStart, count: messages.length, total,
    executionState: { state: history.session.runtimeState.state, busy: history.session.busy,
      queueLength: history.session.queueLength },
    preview,
  };
}

/** One ordinary user input from an external owner, not a system send or a fabricated Session message. */
export async function sendExternalSession(principal: VerifiedMcpInboundPrincipal, context: ExternalExecutionContext,
  requestedId: string, message: string): Promise<{ accepted: true; sessionId: string }> {
  assertActive(context, principal);
  if (typeof message !== 'string' || !message.trim() || Buffer.byteLength(message, 'utf8') > MAX_SEND_MESSAGE_BYTES) {
    throw new ExternalSessionBeforeAdmissionError('Message must be non-empty and fit in a bounded Session input.');
  }
  const sessionId = exactTarget(requestedId);
  const permissionArgs = { sessionId, message };
  const permission = buildExternalToolAuthorizationRequest({ principal, sessionId: context.id,
    tool: { source: 'builtin', name: 'send_to_session' }, args: permissionArgs });
  await authorize(principal, context, 'send_to_session', permissionArgs);
  const checkAdmission = () => {
    assertActive(context, principal);
    if (exactTarget(requestedId) !== sessionId) throw new ExternalSessionBeforeAdmissionError('Session is unavailable.');
    if (evaluateToolAuthorizationSync(permission).action !== 'allow') {
      throw new ExternalSessionBeforeAdmissionError('Session action is not permitted.');
    }
  };
  checkAdmission();
  const input = { type: 'user' as const, parts: [
    { system: formatFoxwarmSystemTag({ kind: 'external-input',
      externalId: requireVerifiedMcpInboundExternalId(principal), contextId: context.id,
      time: formatLocalTimestamp(Date.now()), hint: 'Message from an external MCP client.' }) },
    { text: message },
  ] };
  if (Buffer.byteLength(JSON.stringify(input), 'utf8') > 1024 * 1024) {
    throw new ExternalSessionBeforeAdmissionError('Message exceeds the Session input limit.');
  }
  await sessionManager.enqueueSessionItem(sessionId, input, checkAdmission);
  return { accepted: true, sessionId };
}
