import crypto from 'crypto';
import type { Message, MessagePart, QueueItem } from '../types';
import { formatFoxwarmMessage } from '../utils/promptWrappers';

export const MAX_QUEUED_PREVIEW_ITEMS = 20;
const MAX_QUEUED_PREVIEW_TEXT_CHARS = 4000;

function truncateQueuedPreviewText(value: string): string {
  if (value.length <= MAX_QUEUED_PREVIEW_TEXT_CHARS) return value;
  return `${value.slice(0, MAX_QUEUED_PREVIEW_TEXT_CHARS)}\n… [preview truncated]`;
}

export function sanitizeQueuedPreviewPart(part: MessagePart): MessagePart | null {
  const sanitized: MessagePart = { ...part };
  if (typeof sanitized.text === 'string') sanitized.text = truncateQueuedPreviewText(sanitized.text);
  if (typeof sanitized.system === 'string') sanitized.system = truncateQueuedPreviewText(sanitized.system);
  if (typeof sanitized.thinking === 'string') sanitized.thinking = truncateQueuedPreviewText(sanitized.thinking);
  if (sanitized.inlineData || sanitized.inlineDataRef) {
    const mimeType = sanitized.inlineData?.mimeType || sanitized.inlineData?.mime_type || sanitized.inlineDataRef?.mimeType || 'attachment';
    delete sanitized.inlineData;
    delete (sanitized as any).inlineDataRef;
    return { text: `[${mimeType} attachment preview omitted]` };
  }
  return sanitized;
}

export function sanitizeQueuedPreviewParts(parts: MessagePart[] | undefined): MessagePart[] {
  if (!Array.isArray(parts)) return [];
  return parts.map(sanitizeQueuedPreviewPart).filter((part): part is MessagePart => !!part);
}

function hashQueuedPreviewItem(index: number, item: QueueItem): string {
  const hash = crypto.createHash('sha1');
  hash.update(String(index)); hash.update('\0'); hash.update(item.type || 'unknown'); hash.update('\0');
  hash.update(JSON.stringify({ source: item.source, sourceSessionId: item.sourceSessionId, parts: item.parts, message: item.message }, (_key, value) => (
    typeof value === 'string' && value.length > 1000 ? `${value.slice(0, 1000)}…` : value
  )).slice(0, 20_000));
  return hash.digest('hex').slice(0, 12);
}

function buildQueuedPreviewMessage(item: QueueItem, index: number): Message | null {
  if (item.type === 'compact-commit') return null;
  const queuedMeta = { ...(item.message?.__meta || {}), synthetic: `queued-${index}-${item.type}-${hashQueuedPreviewItem(index, item)}`, temporary: true, queuedPreview: true, queueIndex: index, queueType: item.type };
  if (item.message) return { ...item.message, parts: sanitizeQueuedPreviewParts(item.message.parts), __meta: queuedMeta };
  const sanitizedParts = sanitizeQueuedPreviewParts(item.parts);
  let parts = sanitizedParts;
  if (item.type !== 'user' && !sanitizedParts.some(part => typeof part.system === 'string' && part.system.trim())) {
    const text = sanitizedParts.map(part => part.text || part.thinking || '').filter(Boolean).join('\n').trim();
    parts = text ? [{ system: formatFoxwarmMessage({ type: item.type || 'background', ...(item.sourceSessionId ? { sourceSessionId: item.sourceSessionId } : {}), hint: 'queued session event preview' }, truncateQueuedPreviewText(text)) }] : [];
  }
  return parts.length ? { role: 'user', parts, __meta: queuedMeta } : null;
}

export function buildQueuedPreviewMessages(queue: QueueItem[] | undefined, options: { startIndex?: number; limit?: number } = {}): Message[] {
  if (!Array.isArray(queue) || queue.length === 0) return [];
  const messages: Message[] = [];
  const startIndex = options.startIndex || 0;
  const limit = options.limit ?? MAX_QUEUED_PREVIEW_ITEMS;
  for (let index = 0; index < queue.length && messages.length < limit; index += 1) {
    const message = buildQueuedPreviewMessage(queue[index], startIndex + index);
    if (message) messages.push(message);
  }
  return messages;
}

export function composeQueuedPreviewProjection(options: {
  hotQueuedMessages: Message[];
  hotQueueLength: number;
  pendingQueue: QueueItem[];
}): { queuedMessages: Message[]; queueLength: number; queuedPreviewOmittedCount: number } {
  const queuedMessages = [
    ...options.hotQueuedMessages.slice(0, MAX_QUEUED_PREVIEW_ITEMS),
    ...buildQueuedPreviewMessages(options.pendingQueue, {
      startIndex: options.hotQueueLength,
      limit: Math.max(0, MAX_QUEUED_PREVIEW_ITEMS - options.hotQueuedMessages.length),
    }),
  ].slice(0, MAX_QUEUED_PREVIEW_ITEMS);
  const queueLength = options.hotQueueLength + options.pendingQueue.length;
  return { queuedMessages, queueLength, queuedPreviewOmittedCount: Math.max(0, queueLength - queuedMessages.length) };
}
