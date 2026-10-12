import { StringDecoder } from 'string_decoder';
import { OpenAIStreamProgressSnapshot, OpenAIStreamToolCallSnapshot, parseSseEventBlock } from './openai';

/**
 * Anthropic Messages streaming collector.
 *
 * Rebuilds the ordered, indexed content blocks from server-sent events into the
 * same non-streaming message shape that parseConcreteProviderResponse already
 * consumes, so streamed and JSON responses share one canonical parser. Tool
 * input stays raw JSON text until its block closes; nothing is executed here.
 */

export type AnthropicStreamProgressOptions = {
    onProgress?: (snapshot: OpenAIStreamProgressSnapshot) => void;
    onMeaningfulProgress?: () => void;
    /** Reasoning block lifecycle; used for the watchdog's reasoning inactivity window only. */
    onReasoningPhase?: (active: boolean) => void;
    onRawChunk?: (text: string) => void;
    onRawSseBlock?: (block: string) => void;
};

type AnthropicBlockState =
    | { kind: 'text'; index: number; text: string; closed: boolean }
    | { kind: 'thinking'; index: number; thinking: string; signature?: string; closed: boolean }
    | { kind: 'redacted_thinking'; index: number; data: string; closed: boolean }
    | { kind: 'tool_use'; index: number; id: string; name: string; partialJson: string; input?: unknown; closed: boolean }
    | { kind: 'other'; index: number; raw: Record<string, unknown>; closed: boolean };

function makeAbortError(message = 'LLM request aborted'): Error & { code: string } {
    const error = new Error(message) as Error & { code: string };
    error.name = 'AbortError';
    error.code = 'ERR_CANCELED';
    return error;
}

function isRecord(value: unknown): value is Record<string, any> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toProgressString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Parses the completed tool input. Anything that is not a JSON object is kept
 * as raw text so the canonical parser reports the same argsParseError as the
 * other providers instead of executing a partial or non-object payload.
 */
function finalizeToolInput(partialJson: string): unknown {
    if (partialJson.trim() === '') return {};
    try {
        const parsed = JSON.parse(partialJson);
        return isRecord(parsed) ? parsed : partialJson;
    } catch {
        return partialJson;
    }
}

export async function collectAnthropicMessagesStream(
    stream: any,
    signal: AbortSignal,
    options?: AnthropicStreamProgressOptions,
): Promise<any> {
    if (signal.aborted) {
        throw makeAbortError();
    }

    return new Promise((resolve, reject) => {
        let settled = false;
        let buffer = '';
        const decoder = new StringDecoder('utf8');
        const blocks = new Map<number, AnthropicBlockState>();
        let message: Record<string, any> | null = null;
        let usage: Record<string, any> | undefined;
        let stopReason: string | null | undefined;
        let stopSequence: string | null | undefined;
        let stopDetails: unknown;
        let sawMessageStop = false;

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

        const orderedBlocks = () => Array.from(blocks.values()).sort((left, right) => left.index - right.index);

        const buildProgressSnapshot = (): OpenAIStreamProgressSnapshot => {
            const reasoning = orderedBlocks()
                .filter((block): block is Extract<AnthropicBlockState, { kind: 'thinking' }> => block.kind === 'thinking')
                .map(block => block.thinking)
                .filter(value => value.length > 0)
                .join('\n');
            const text = orderedBlocks()
                .filter((block): block is Extract<AnthropicBlockState, { kind: 'text' }> => block.kind === 'text')
                .map(block => block.text)
                .join('');
            const toolCalls: OpenAIStreamToolCallSnapshot[] = orderedBlocks()
                .filter((block): block is Extract<AnthropicBlockState, { kind: 'tool_use' }> => block.kind === 'tool_use')
                .map(block => ({
                    index: block.index,
                    ...(toProgressString(block.id) ? { id: block.id } : {}),
                    ...(toProgressString(block.name) ? { name: block.name } : {}),
                    arguments: block.partialJson,
                }));
            return { reasoning, text, toolCalls };
        };

        const emitProgress = () => {
            options?.onProgress?.(buildProgressSnapshot());
        };

        const requireBlock = (index: unknown): AnthropicBlockState => {
            const block = typeof index === 'number' ? blocks.get(index) : undefined;
            if (!block) {
                throw new Error(`Anthropic stream referenced unknown content block index ${String(index)}.`);
            }
            if (block.closed) {
                throw new Error(`Anthropic stream sent content for closed content block ${block.index}.`);
            }
            return block;
        };

        const handleEvent = (event: any) => {
            switch (event?.type) {
                case 'message_start': {
                    message = isRecord(event.message) ? event.message : {};
                    usage = isRecord(message.usage) ? { ...message.usage } : undefined;
                    return;
                }
                case 'content_block_start': {
                    const index = event.index;
                    if (typeof index !== 'number' || blocks.has(index)) {
                        throw new Error(`Anthropic stream started an invalid or duplicate content block index ${String(index)}.`);
                    }
                    const content = isRecord(event.content_block) ? event.content_block : {};
                    if (content.type === 'text') {
                        const text = typeof content.text === 'string' ? content.text : '';
                        blocks.set(index, { kind: 'text', index, text, closed: false });
                        if (text) options?.onMeaningfulProgress?.();
                    } else if (content.type === 'thinking') {
                        blocks.set(index, {
                            kind: 'thinking',
                            index,
                            thinking: typeof content.thinking === 'string' ? content.thinking : '',
                            ...(typeof content.signature === 'string' ? { signature: content.signature } : {}),
                            closed: false,
                        });
                        options?.onReasoningPhase?.(true);
                    } else if (content.type === 'redacted_thinking') {
                        blocks.set(index, { kind: 'redacted_thinking', index, data: typeof content.data === 'string' ? content.data : '', closed: false });
                        options?.onReasoningPhase?.(true);
                    } else if (content.type === 'tool_use') {
                        blocks.set(index, {
                            kind: 'tool_use',
                            index,
                            id: typeof content.id === 'string' ? content.id : '',
                            name: typeof content.name === 'string' ? content.name : '',
                            partialJson: '',
                            closed: false,
                        });
                    } else {
                        blocks.set(index, { kind: 'other', index, raw: { ...content }, closed: false });
                    }
                    emitProgress();
                    return;
                }
                case 'content_block_delta': {
                    const block = requireBlock(event.index);
                    const delta = isRecord(event.delta) ? event.delta : {};
                    if (delta.type === 'text_delta' && block.kind === 'text') {
                        const text = typeof delta.text === 'string' ? delta.text : '';
                        block.text += text;
                        if (text) options?.onMeaningfulProgress?.();
                        emitProgress();
                        return;
                    }
                    if (delta.type === 'thinking_delta' && block.kind === 'thinking') {
                        const thinking = typeof delta.thinking === 'string' ? delta.thinking : '';
                        block.thinking += thinking;
                        if (thinking) options?.onMeaningfulProgress?.();
                        emitProgress();
                        return;
                    }
                    if (delta.type === 'signature_delta' && block.kind === 'thinking') {
                        // Signatures are opaque round-trip data; they never reach progress snapshots.
                        block.signature = `${block.signature || ''}${typeof delta.signature === 'string' ? delta.signature : ''}`;
                        return;
                    }
                    if (delta.type === 'input_json_delta' && block.kind === 'tool_use') {
                        const partial = typeof delta.partial_json === 'string' ? delta.partial_json : '';
                        block.partialJson += partial;
                        if (partial) options?.onMeaningfulProgress?.();
                        emitProgress();
                        return;
                    }
                    if (block.kind === 'other' || delta.type === undefined) return;
                    throw new Error(`Anthropic stream sent ${String(delta.type)} for a ${block.kind} content block.`);
                }
                case 'content_block_stop': {
                    const block = requireBlock(event.index);
                    block.closed = true;
                    if (block.kind === 'tool_use') {
                        block.input = finalizeToolInput(block.partialJson);
                        emitProgress();
                    } else if (block.kind === 'thinking' || block.kind === 'redacted_thinking') {
                        options?.onReasoningPhase?.(false);
                    }
                    return;
                }
                case 'message_delta': {
                    const delta = isRecord(event.delta) ? event.delta : {};
                    if ('stop_reason' in delta) stopReason = delta.stop_reason;
                    if ('stop_sequence' in delta) stopSequence = delta.stop_sequence;
                    if ('stop_details' in delta) stopDetails = delta.stop_details;
                    // message_delta usage carries cumulative totals, so later fields replace earlier ones.
                    if (isRecord(event.usage)) usage = { ...(usage || {}), ...event.usage };
                    return;
                }
                case 'message_stop': {
                    sawMessageStop = true;
                    return;
                }
                case 'ping':
                    return;
                case 'error': {
                    const error = isRecord(event.error) ? event.error : {};
                    const type = typeof error.type === 'string' ? error.type : 'error';
                    const detail = typeof error.message === 'string' ? error.message : 'Anthropic stream error.';
                    throw new Error(`Anthropic stream error (${type}): ${detail}`);
                }
                default:
                    // Unknown event types are ignored for forward compatibility.
                    return;
            }
        };

        const completeMessage = () => {
            if (!message) {
                throw new Error('Anthropic message stream ended before message_start.');
            }
            if (stopReason === undefined) {
                throw new Error('Anthropic message stream ended without a message_delta stop_reason.');
            }
            const content = orderedBlocks().map(block => {
                if (!block.closed) {
                    throw new Error(`Anthropic message stream ended with content block ${block.index} still open.`);
                }
                switch (block.kind) {
                    case 'text':
                        return { type: 'text', text: block.text };
                    case 'thinking':
                        return {
                            type: 'thinking',
                            thinking: block.thinking,
                            ...(block.signature !== undefined ? { signature: block.signature } : {}),
                        };
                    case 'redacted_thinking':
                        return { type: 'redacted_thinking', data: block.data };
                    case 'tool_use':
                        return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
                    default:
                        return block.raw;
                }
            });
            return {
                ...message,
                type: 'message',
                role: 'assistant',
                content,
                stop_reason: stopReason,
                stop_sequence: stopSequence,
                ...(stopDetails !== undefined ? { stop_details: stopDetails } : {}),
                ...(usage ? { usage } : {}),
            };
        };

        const appendDecodedText = (text: string) => {
            if (!text) return;

            options?.onRawChunk?.(text);
            buffer += text;
            drainEventBlocks();
        };

        const drainEventBlocks = () => {
            if (settled) return;
            buffer = buffer.replace(/\r\n/g, '\n');

            let boundaryIndex = buffer.indexOf('\n\n');
            while (boundaryIndex !== -1) {
                const block = buffer.slice(0, boundaryIndex);
                buffer = buffer.slice(boundaryIndex + 2);
                options?.onRawSseBlock?.(block);

                try {
                    const event = parseSseEventBlock(block);
                    if (event) handleEvent(event);
                } catch (error) {
                    finish(() => reject(error));
                    return;
                }
                if (sawMessageStop) {
                    // message_stop is terminal; anything after it is not part of this message.
                    finish(() => {
                        try {
                            resolve(completeMessage());
                        } catch (error) {
                            reject(error);
                        }
                    });
                    return;
                }

                boundaryIndex = buffer.indexOf('\n\n');
            }
        };

        const onAbort = () => {
            const error = makeAbortError();
            finish(() => reject(error));
            try {
                // This collector owns the abort rejection. Destroy without an
                // error after removing listeners so Node cannot emit a queued
                // unhandled stream error after the promise has settled.
                stream.destroy?.();
            } catch {}
        };

        const onData = (chunk: any) => {
            appendDecodedText(typeof chunk === 'string' ? chunk : decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        };

        const onEnd = () => {
            appendDecodedText(decoder.end());
            // A final event without a trailing blank line is still a complete event at end of stream.
            if (buffer.trim() !== '') {
                buffer += '\n\n';
                drainEventBlocks();
            }
            finish(() => reject(new Error('Anthropic message stream ended before message_stop.')));
        };

        const onError = (error: any) => {
            finish(() => reject(error));
        };

        signal.addEventListener('abort', onAbort, { once: true });
        stream.on('data', onData);
        stream.on('end', onEnd);
        stream.on('error', onError);
    });
}
