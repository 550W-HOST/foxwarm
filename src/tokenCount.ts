import { MessagePart, Message } from './types';

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
 * Estimate token count for a complete message part including all content types
 */
export function estimateMessagePartTokens(part: MessagePart): number {
    let tokens = 0;
    
    // Text content
    tokens += estimateTokenCount(part.text || '');
    
    // Thinking content
    tokens += estimateTokenCount(part.thinking || '');
    
    // Function calls
    if (part.functionCall) {
        tokens += estimateTokenCount(part.functionCall.name || '');
        tokens += estimateTokenCount(JSON.stringify(part.functionCall.args || {}));
    }
    
    // Function responses
    if (part.functionResponse) {
        tokens += estimateTokenCount(part.functionResponse.name || '');
        tokens += estimateTokenCount(JSON.stringify(part.functionResponse.response || {}));
    }
    
    // Inline data (images, etc.)
    if (part.inlineData) {
        if (part.inlineData.data && part.inlineData.mimeType?.startsWith('image/')) {
            // For images, estimate based on base64 length (rough approximation)
            // Base64 encoding increases size by ~33%, each token ~4 characters
            tokens += Math.ceil(part.inlineData.data.length * 0.75 / 4);
        } else {
            // For other inline data, use JSON string length
            tokens += estimateTokenCount(JSON.stringify(part.inlineData));
        }
    }
    
    return tokens;
}

/**
 * Estimate token count for a complete message including all parts
 */
export function estimateMessageTokens(message: Message): number {
    return message.parts.reduce((total, part) => total + estimateMessagePartTokens(part), 0);
}

/**
 * Estimate token count for an entire session (all messages + snapshot)
 */
export function estimateSessionTokens(session: { history: Message[], persistentMemorySnapshot?: string }): number {
    let total = session.history.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
    if (session.persistentMemorySnapshot) {
        total += estimateTokenCount(session.persistentMemorySnapshot);
    }
    return total;
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
