import crypto from 'crypto';
import { Message, MessagePart } from './types';
import { formatFoxwarmAttributes, parseFoxwarmTagLine } from './utils/promptWrappers';

export type ProviderImageProtocol = 'openai-chat-completions' | 'openai-responses' | 'anthropic' | 'gemini';

export interface DeduplicatedProviderRequestImages {
  messages: Message[];
  isDeduplicated(part: MessagePart): boolean;
}

const MAX_FALLBACK_IMAGE_BYTES = 32 * 1024 * 1024;
export const PROVIDER_IMAGE_DEDUP_MARKER = '[IMAGE: deduplicated=true] Identical image bytes were present earlier in this request and have already been read.';

function normalizedMimeType(part: MessagePart, fallbackMimeType: string): string {
  return String(part.inlineData?.mimeType || part.inlineData?.mime_type || fallbackMimeType).trim().toLowerCase();
}

function imageIdentity(part: MessagePart, fallbackMimeType: string): string | undefined {
  if (!part.inlineData?.data) return undefined;
  const mimeType = normalizedMimeType(part, fallbackMimeType);
  const compact = String(part.inlineData.data).replace(/\s+/g, '');
  if (!compact || compact.length > Math.ceil(MAX_FALLBACK_IMAGE_BYTES * 4 / 3) + 4) return undefined;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 === 1) return undefined;
  const buffer = Buffer.from(compact, 'base64');
  if (buffer.length > MAX_FALLBACK_IMAGE_BYTES) return undefined;
  const canonical = buffer.toString('base64').replace(/=+$/u, '');
  if (canonical !== compact.replace(/=+$/u, '')) return undefined;
  return `${mimeType}\0${crypto.createHash('sha256').update(buffer).digest('hex')}`;
}

function toolImageOrder(message: Message, protocol: ProviderImageProtocol): number[] {
  const parts = message.parts || [];
  if (protocol === 'anthropic') {
    const imagesByToolId = new Map<string, number[]>();
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      if (part.inlineData && part.toolUseId) {
        const indexes = imagesByToolId.get(part.toolUseId) || [];
        indexes.push(index);
        imagesByToolId.set(part.toolUseId, indexes);
      }
    }
    const order: number[] = [];
    const emittedToolIds = new Set<string>();
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      if (part.functionResponse) {
        const toolId = part.functionResponse.tool_use_id || part.toolUseId || 'unknown';
        if (!emittedToolIds.has(toolId)) {
          order.push(...(imagesByToolId.get(toolId) || []));
          emittedToolIds.add(toolId);
        }
      } else if (part.inlineData && !part.toolUseId) {
        order.push(index);
      }
    }
    return order;
  }

  const groups = new Map<string, number[]>();
  const groupOrder: string[] = [];
  let pendingWithoutId: number[] = [];
  const ensureGroup = (toolId: string) => {
    if (!groups.has(toolId)) {
      groups.set(toolId, []);
      groupOrder.push(toolId);
    }
  };
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part.inlineData) {
      if (part.toolUseId) {
        ensureGroup(part.toolUseId);
        groups.get(part.toolUseId)!.push(index);
      } else {
        pendingWithoutId.push(index);
      }
      continue;
    }
    if (part.functionResponse) {
      const toolId = part.functionResponse.tool_use_id || part.toolUseId;
      if (!toolId) continue;
      ensureGroup(toolId);
      groups.get(toolId)!.push(...pendingWithoutId);
      pendingWithoutId = [];
    }
  }
  return groupOrder.flatMap(toolId => groups.get(toolId) || []);
}

interface ProviderImageOccurrence {
  messageIndex: number;
  partIndex: number;
  fallbackMimeType: string;
}

function providerImageOrder(messages: Message[], protocol: ProviderImageProtocol): ProviderImageOccurrence[] {
  const order: ProviderImageOccurrence[] = [];
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex];
    if (message.role === 'tool') {
      const fallbackMimeType = protocol === 'anthropic' ? 'image/jpeg' : 'image/png';
      for (const partIndex of toolImageOrder(message, protocol)) {
        order.push({ messageIndex, partIndex, fallbackMimeType });
      }
      continue;
    }
    const role = message.role === 'model' ? 'assistant' : 'user';
    for (let partIndex = 0; partIndex < message.parts.length; partIndex += 1) {
      if (!message.parts[partIndex].inlineData) continue;
      if (protocol === 'openai-responses' && role === 'assistant') continue;
      order.push({ messageIndex, partIndex, fallbackMimeType: 'image/jpeg' });
    }
  }
  return order;
}

function markFoxwarmImageLine(text: string): { text: string; marked: boolean } {
  const lines = text.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const parsed = parseFoxwarmTagLine(lines[index]);
    if (!parsed || parsed.closing || parsed.tagName !== 'foxwarm-image') continue;
    const attrs = formatFoxwarmAttributes({ ...parsed.attrs, deduplicated: true });
    lines[index] = attrs ? `<foxwarm-image ${attrs} />` : '<foxwarm-image deduplicated="true" />';
    return { text: lines.join('\n'), marked: true };
  }
  return { text, marked: false };
}

function markDescriptor(messages: Message[], messageIndex: number, partIndex: number): boolean {
  const parts = messages[messageIndex].parts;
  for (const candidateIndex of [partIndex, partIndex - 1, partIndex + 1]) {
    const part = parts[candidateIndex];
    if (!part || typeof part.text !== 'string') continue;
    if (candidateIndex !== partIndex && (part.inlineData || part.inlineDataRef)) continue;
    const marked = markFoxwarmImageLine(part.text);
    if (!marked.marked) continue;
    part.text = marked.text;
    return true;
  }
  return false;
}

/**
 * Clone and prepare one concrete physical provider request. Only image parts
 * which the selected protocol will actually serialize participate in the
 * request-local seen set.
 */
export function deduplicateProviderRequestImages(
  contents: Message[],
  protocol: ProviderImageProtocol,
): DeduplicatedProviderRequestImages {
  const prepared = structuredClone(contents);
  const seen = new Set<string>();
  const deduplicatedParts = new WeakSet<MessagePart>();

  for (const { messageIndex, partIndex, fallbackMimeType } of providerImageOrder(prepared, protocol)) {
    const part = prepared[messageIndex]?.parts?.[partIndex];
    const identity = part ? imageIdentity(part, fallbackMimeType) : undefined;
    if (!part?.inlineData || !identity) continue;
    if (!seen.has(identity)) {
      seen.add(identity);
      continue;
    }

    delete part.inlineData;
    deduplicatedParts.add(part);
    const hasDescriptor = markDescriptor(prepared, messageIndex, partIndex);
    if (!hasDescriptor && (prepared[messageIndex].role !== 'tool' || !part.toolUseId)) {
      part.text = part.text ? `${part.text}\n${PROVIDER_IMAGE_DEDUP_MARKER}` : PROVIDER_IMAGE_DEDUP_MARKER;
    }
  }

  return {
    messages: prepared,
    isDeduplicated: part => deduplicatedParts.has(part),
  };
}
