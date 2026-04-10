import { MessagePart, Message, InlineData } from './types';
import { stringifyFunctionCallArgs } from './toolCallArgs';

export interface TokenEstimateSummary {
    tokens: number;
    imageCount: number;
}

function isImageMimeType(mimeType?: string): boolean {
    return typeof mimeType === 'string' && mimeType.startsWith('image/');
}

function isImageInlineData(value: unknown): value is InlineData {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as InlineData;
    return typeof candidate.data === 'string' && isImageMimeType(candidate.mimeType || candidate.mime_type);
}

function sanitizeValueForTokenEstimate(value: unknown): { sanitized: unknown; imageCount: number } {
    if (Array.isArray(value)) {
        let imageCount = 0;
        const sanitized = value.map((entry) => {
            const result = sanitizeValueForTokenEstimate(entry);
            imageCount += result.imageCount;
            return result.sanitized;
        });
        return { sanitized, imageCount };
    }

    if (isImageInlineData(value)) {
        return {
            sanitized: {
                mimeType: value.mimeType || value.mime_type,
                data: '[image omitted]',
            },
            imageCount: 1,
        };
    }

    if (!value || typeof value !== 'object') {
        return { sanitized: value, imageCount: 0 };
    }

    let imageCount = 0;
    const sanitizedEntries = Object.entries(value as Record<string, unknown>).map(([key, entry]) => {
        const result = sanitizeValueForTokenEstimate(entry);
        imageCount += result.imageCount;
        return [key, result.sanitized];
    });

    return {
        sanitized: Object.fromEntries(sanitizedEntries),
        imageCount,
    };
}

/**
 * Estimate token count based on codepoint values
 * - ASCII characters (< 128): 0.33 tokens each
 * - Other characters: 1 token each
 * - Result is rounded up
 */
export function estimateTokenCount(text: string): number {
    if (!text) return 0;
    
    let count = 0;
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (code < 128) {
            count += 0.33;
        } else {
            count += 1;
        }
    }
    
    return Math.ceil(count);
}

/**
 * Estimate token count for a complete message part including all content types.
 * Image payload bytes/base64 are not counted as tokens; callers should track
 * the returned imageCount separately for status/debug display.
 */
export function estimateMessagePartSummary(part: MessagePart): TokenEstimateSummary {
    let tokens = 0;
    let imageCount = 0;
    
    // Text content
    tokens += estimateTokenCount(part.text || '');
    
    // Thinking content
    tokens += estimateTokenCount(part.thinking || '');
    
    // Function calls
    if (part.functionCall) {
        tokens += estimateTokenCount(part.functionCall.name || '');
        tokens += estimateTokenCount(stringifyFunctionCallArgs(part.functionCall));
    }
    
    // Function responses
    if (part.functionResponse) {
        tokens += estimateTokenCount(part.functionResponse.name || '');
        const sanitized = sanitizeValueForTokenEstimate(part.functionResponse.response || {});
        imageCount += sanitized.imageCount;
        tokens += estimateTokenCount(JSON.stringify(sanitized.sanitized || {}));
    }
    
    // Inline data (images, etc.)
    if (part.inlineData) {
        if (isImageInlineData(part.inlineData)) {
            imageCount += 1;
        } else {
            const sanitized = sanitizeValueForTokenEstimate(part.inlineData);
            imageCount += sanitized.imageCount;
            tokens += estimateTokenCount(JSON.stringify(sanitized.sanitized));
        }
    }
    
    return { tokens, imageCount };
}

export function estimateMessagePartTokens(part: MessagePart): number {
    return estimateMessagePartSummary(part).tokens;
}

export function estimateMessageSummary(message: Message): TokenEstimateSummary {
    const total: TokenEstimateSummary = { tokens: 0, imageCount: 0 };
    for (const part of message.parts) {
        const partSummary = estimateMessagePartSummary(part);
        total.tokens += partSummary.tokens;
        total.imageCount += partSummary.imageCount;
    }
    return total;
}

/**
 * Estimate token count for a complete message including all parts
 */
export function estimateMessageTokens(message: Message): number {
    return estimateMessageSummary(message).tokens;
}

export function estimateSessionSummary(session: { history: Message[], persistentMemorySnapshot?: string }): TokenEstimateSummary {
    const total: TokenEstimateSummary = { tokens: 0, imageCount: 0 };
    for (const message of session.history) {
        const messageSummary = estimateMessageSummary(message);
        total.tokens += messageSummary.tokens;
        total.imageCount += messageSummary.imageCount;
    }

    if (session.persistentMemorySnapshot) {
        total.tokens += estimateTokenCount(session.persistentMemorySnapshot);
    }

    return total;
}

/**
 * Estimate token count for an entire session (all messages + snapshot)
 */
export function estimateSessionTokens(session: { history: Message[], persistentMemorySnapshot?: string }): number {
    return estimateSessionSummary(session).tokens;
}

/**
 * Estimate token count for a subset of session messages (from startIndex to end)
 */
export function estimateSessionRangeTokens(session: { history: Message[] }, startIndex: number = 0): number {
    let totalTokens = 0;
    for (let i = startIndex; i < session.history.length; i++) {
        totalTokens += estimateMessageTokens(session.history[i]);
    }
    return totalTokens;
}
