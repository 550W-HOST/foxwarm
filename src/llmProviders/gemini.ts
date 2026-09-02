import { createHash } from 'crypto';
import { StringDecoder } from 'string_decoder';
import type { Message, MessagePart } from '../types';
import { formatToolResponsePayload } from '../../packages/shared/dist/toolResponseFormatting';
import { appendImageGuidanceText } from '../toolImages';
import { formatFoxwarmSystemTag, formatSystemPartForModel } from '../utils/promptWrappers';

function makeAbortError(message = 'LLM request aborted'): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.name = 'AbortError';
  error.code = 'ERR_CANCELED';
  return error;
}

function formatPreviousLlmRequestPrefix(part: MessagePart): string | undefined {
  const timing = part.functionResponse?.previousLlmRequest;
  if (!timing || typeof timing.time !== 'string' || !Number.isFinite(timing.durationMs)) return undefined;
  return formatFoxwarmSystemTag({
    kind: 'time',
    time: timing.time,
    prevLLMReqTime: `${(Math.max(0, timing.durationMs) / 1000).toFixed(1)}s`,
  });
}

function withThoughtSignature(part: Record<string, any>, source: MessagePart): Record<string, any> {
  const signature = source.providerMeta?.signature;
  return typeof signature === 'string' && signature ? { ...part, thoughtSignature: signature } : part;
}

function normalizeFunctionResponse(value: unknown): Record<string, any> {
  return { output: formatToolResponsePayload(value) };
}

/** Convert Foxwarm's provider-neutral history into Gemini generateContent contents. */
export function convertToGeminiFormat(contents: Message[]): any[] {
  const result: any[] = [];

  for (const message of contents) {
    const role = message.role === 'model' ? 'model' : 'user';
    const parts: any[] = [];
    const imagePartsByToolUseId = new Map<string, MessagePart[]>();

    if (message.role === 'tool') {
      for (const part of message.parts || []) {
        if (!part.inlineData || !part.toolUseId) continue;
        const grouped = imagePartsByToolUseId.get(part.toolUseId) || [];
        grouped.push(part);
        imagePartsByToolUseId.set(part.toolUseId, grouped);
      }
    }

    for (const part of message.parts || []) {
      if (part.thinking) {
        parts.push(withThoughtSignature({ text: part.thinking, thought: true }, part));
      }
      if (part.system) {
        parts.push({ text: formatSystemPartForModel(part.system) });
      }
      if (part.text) {
        parts.push(withThoughtSignature({ text: part.text }, part));
      }
      if (part.functionCall) {
        parts.push(withThoughtSignature({
          functionCall: {
            ...(part.functionCall.id ? { id: part.functionCall.id } : {}),
            name: part.functionCall.name,
            args: part.functionCall.args || {},
          },
        }, part));
      }
      if (part.functionResponse) {
        const toolUseId = part.functionResponse.tool_use_id || part.toolUseId || 'unknown';
        const images = imagePartsByToolUseId.get(toolUseId) || [];
        const timingPrefix = formatPreviousLlmRequestPrefix(part);
        const responseText = appendImageGuidanceText(images, formatToolResponsePayload(part.functionResponse.response || {}));
        if (timingPrefix) parts.push({ text: timingPrefix });
        parts.push({
          functionResponse: {
            ...(toolUseId !== 'unknown' ? { id: toolUseId } : {}),
            name: part.functionResponse.name,
            response: normalizeFunctionResponse(responseText),
          },
        });
        for (const image of images) {
          parts.push({
            inlineData: {
              mimeType: image.inlineData!.mimeType || image.inlineData!.mime_type || 'image/jpeg',
              data: image.inlineData!.data,
            },
          });
        }
      }
      if (part.inlineData) {
        if (message.role === 'tool' && part.toolUseId) continue;
        parts.push({
          inlineData: {
            mimeType: part.inlineData.mimeType || part.inlineData.mime_type || 'image/jpeg',
            data: part.inlineData.data,
          },
        });
      }
    }

    if (parts.length === 0) {
      const legacyContent = (message as Message & { content?: unknown }).content;
      parts.push({ text: typeof legacyContent === 'string' && legacyContent ? legacyContent : ' ' });
    }

    const previous = result[result.length - 1];
    if (previous?.role === role) previous.parts.push(...parts);
    else result.push({ role, parts });
  }

  return result;
}

/**
 * Convert JSON Schema tool definitions to the OpenAPI-style subset accepted by
 * Gemini function declarations. Unsupported annotation/validation keywords are
 * removed while object shape, required keys, enums and unions are retained.
 */
export function convertJsonSchemaToGeminiSchema(value: unknown): any {
  const root = value;
  const omitted = new Set([
    '$schema', '$id', '$defs', 'definitions', 'additionalProperties', 'patternProperties',
    'unevaluatedProperties', 'dependentSchemas', 'propertyNames', 'examples',
  ]);
  const resolveLocalRef = (ref: string): unknown => {
    if (!ref.startsWith('#/')) return undefined;
    let cursor: any = root;
    for (const encoded of ref.slice(2).split('/')) {
      const key = encoded.replace(/~1/g, '/').replace(/~0/g, '~');
      if (!cursor || typeof cursor !== 'object' || !(key in cursor)) return undefined;
      cursor = cursor[key];
    }
    return cursor;
  };
  const visit = (node: unknown, activeRefs: Set<string>): any => {
    if (Array.isArray(node)) return node.map(item => visit(item, activeRefs));
    if (!node || typeof node !== 'object') return node;

    const source = node as Record<string, unknown>;
    const ref = typeof source.$ref === 'string' ? source.$ref : undefined;
    if (ref) {
      const target = resolveLocalRef(ref);
      if (target !== undefined && !activeRefs.has(ref)) {
        const nextRefs = new Set(activeRefs);
        nextRefs.add(ref);
        const siblings = Object.fromEntries(Object.entries(source).filter(([key]) => key !== '$ref'));
        return visit({ ...(target as Record<string, unknown>), ...siblings }, nextRefs);
      }
    }

    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(source)) {
      if (omitted.has(key) || key === '$ref') continue;
      if (key === 'const') {
        result.enum = [nested];
        continue;
      }
      if (key === 'type' && Array.isArray(nested)) {
        const nonNull = nested.filter(item => item !== 'null');
        if (nonNull.length === 1) result.type = nonNull[0];
        else if (nonNull.length > 1) result.anyOf = nonNull.map(type => ({ type }));
        if (nonNull.length !== nested.length) result.nullable = true;
        continue;
      }
      result[key] = visit(nested, activeRefs);
    }
    return result;
  };
  return visit(value, new Set());
}

export type GeminiStreamProgressSnapshot = {
  reasoning?: string;
  text?: string;
  toolCalls?: Array<{ index: number; id?: string; name?: string }>;
};

type GeminiStreamProgressOptions = {
  onProgress?: (snapshot: GeminiStreamProgressSnapshot) => void;
  onRawChunk?: (text: string) => void;
  onRawSseBlock?: (block: string) => void;
};

function parseSseBlock(block: string): any | null {
  const dataLines: string[] = [];
  for (const line of block.replace(/\r/g, '').split('\n')) {
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return null;
  const payload = dataLines.join('\n');
  if (!payload || payload === '[DONE]') return null;
  return JSON.parse(payload);
}

function stableGeneratedCallId(part: any, index: number): string {
  const serialized = JSON.stringify([part?.functionCall?.name || '', part?.functionCall?.args || {}, index]);
  return `gemini_${createHash('sha256').update(serialized).digest('hex').slice(0, 20)}`;
}

/** Collect Gemini streamGenerateContent SSE into one generateContent response. */
export async function collectGeminiStream(
  stream: any,
  signal: AbortSignal,
  options?: GeminiStreamProgressOptions,
): Promise<any> {
  if (signal.aborted) throw makeAbortError();

  return new Promise((resolve, reject) => {
    let settled = false;
    let buffer = '';
    const decoder = new StringDecoder('utf8');
    const accumulatedParts: any[] = [];
    let usageMetadata: any;
    let finishReason: string | undefined;

    const cleanup = () => {
      signal.removeEventListener('abort', onAbort);
      stream.off?.('data', onData);
      stream.off?.('end', onEnd);
      stream.off?.('error', onError);
    };
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const snapshot = (): GeminiStreamProgressSnapshot => ({
      reasoning: accumulatedParts.filter(part => part?.thought === true && typeof part.text === 'string').map(part => part.text).join(''),
      text: accumulatedParts.filter(part => part?.thought !== true && typeof part.text === 'string').map(part => part.text).join(''),
      toolCalls: accumulatedParts
        .map((part, index) => ({ part, index }))
        .filter(({ part }) => !!part?.functionCall)
        .map(({ part, index }) => ({ index, id: part.functionCall.id, name: part.functionCall.name })),
    });
    const processResponse = (response: any) => {
      if (response?.error) throw new Error(response.error.message || JSON.stringify(response.error));
      if (response?.usageMetadata) usageMetadata = response.usageMetadata;
      const candidate = response?.candidates?.[0];
      if (candidate?.finishReason) finishReason = candidate.finishReason;
      const incoming = candidate?.content?.parts;
      if (!Array.isArray(incoming)) return;
      for (const rawPart of incoming) {
        const part = { ...rawPart };
        if (part.functionCall) {
          part.functionCall = { ...part.functionCall };
          if (!part.functionCall.id) part.functionCall.id = stableGeneratedCallId(part, accumulatedParts.length);
        }
        accumulatedParts.push(part);
      }
      options?.onProgress?.(snapshot());
    };
    const processBlock = (block: string) => {
      const normalized = block.trim();
      if (!normalized) return;
      options?.onRawSseBlock?.(normalized);
      const parsed = parseSseBlock(normalized);
      if (parsed) processResponse(parsed);
    };
    const drain = (flush = false) => {
      const normalized = buffer.replace(/\r\n/g, '\n');
      let boundary = normalized.indexOf('\n\n');
      let consumed = 0;
      while (boundary >= 0) {
        processBlock(normalized.slice(consumed, boundary));
        consumed = boundary + 2;
        boundary = normalized.indexOf('\n\n', consumed);
      }
      buffer = normalized.slice(consumed);
      if (flush && buffer.trim()) {
        processBlock(buffer);
        buffer = '';
      }
    };
    const onData = (chunk: Buffer | string) => {
      try {
        const text = typeof chunk === 'string' ? chunk : decoder.write(chunk);
        options?.onRawChunk?.(text);
        buffer += text;
        drain();
      } catch (error) {
        finish(() => reject(error));
      }
    };
    const onEnd = () => {
      try {
        const tail = decoder.end();
        if (tail) {
          options?.onRawChunk?.(tail);
          buffer += tail;
        }
        drain(true);
        finish(() => resolve({
          candidates: [{ content: { role: 'model', parts: accumulatedParts }, ...(finishReason ? { finishReason } : {}) }],
          ...(usageMetadata ? { usageMetadata } : {}),
        }));
      } catch (error) {
        finish(() => reject(error));
      }
    };
    const onError = (error: Error) => finish(() => reject(error));
    const onAbort = () => {
      stream.destroy?.();
      finish(() => reject(makeAbortError()));
    };

    signal.addEventListener('abort', onAbort, { once: true });
    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onError);
  });
}
