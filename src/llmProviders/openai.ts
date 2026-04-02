import { StringDecoder } from 'string_decoder';
import { logger } from '../common';
import { Message, MessagePart, OpenAIResponsesContent } from '../types';
import { stringifyFunctionCallArgs } from '../toolCallArgs';

function makeAbortError(message = 'LLM request aborted'): Error & { code: string } {
    const error = new Error(message) as Error & { code: string };
    error.name = 'AbortError';
    error.code = 'ERR_CANCELED';
    return error;
}

function stringifyToolOutput(output: unknown): string {
    if (output === undefined || output === null) {
        return '';
    }

    if (typeof output === 'string') {
        return output;
    }

    if (typeof output === 'object') {
        try {
            return JSON.stringify(output, null, 2);
        } catch {
            return '[unserializable object]';
        }
    }

    return String(output);
}

function extractToolResponseOutput(response: any): unknown {
    if (response === undefined || response === null) {
        return response;
    }

    if (Object.prototype.hasOwnProperty.call(response, 'output')) {
        return response.output;
    }

    if (Object.prototype.hasOwnProperty.call(response, 'error') && response.error) {
        return response.error;
    }

    return response;
}

function parseSseEventBlock(block: string): any | null {
    const dataLines: string[] = [];

    for (const rawLine of block.replace(/\r/g, '').split('\n')) {
        if (rawLine.startsWith('data:')) {
            dataLines.push(rawLine.slice(5).trimStart());
        }
    }

    if (dataLines.length === 0) {
        return null;
    }

    const payload = dataLines.join('\n');
    if (!payload || payload === '[DONE]') {
        return null;
    }

    return JSON.parse(payload);
}

function buildReasoningSummaryText(summaryParts: Map<string, string>): string {
    return Array.from(summaryParts.entries())
        .sort(([leftKey], [rightKey]) => {
            const [leftOutput = '0', leftSummary = '0'] = leftKey.split(':');
            const [rightOutput = '0', rightSummary = '0'] = rightKey.split(':');
            const outputDelta = Number(leftOutput) - Number(rightOutput);
            if (outputDelta !== 0) {
                return outputDelta;
            }
            return Number(leftSummary) - Number(rightSummary);
        })
        .map(([, text]) => text)
        .filter(Boolean)
        .join('\n');
}

function appendDelta(existing: string | undefined, delta: unknown): string | undefined {
    if (typeof delta !== 'string' || !delta) {
        return existing;
    }
    return `${existing || ''}${delta}`;
}

export function convertToOpenAIFormat(contents: Message[]): any[] {
    const openaiMessages = [];

    for (const msg of contents) {
        let role = msg.role as any;
        if (role === 'model') role = 'assistant';

        if (role === 'tool') {
            const groupedByToolId = new Map<string, any[]>();
            const toolIdOrder: string[] = [];
            const pendingInlineWithoutId: any[] = [];

            const ensureGroup = (toolId: string) => {
                if (!groupedByToolId.has(toolId)) {
                    groupedByToolId.set(toolId, []);
                    toolIdOrder.push(toolId);
                }
            };

            const pushGroupPart = (toolId: string, part: any) => {
                ensureGroup(toolId);
                groupedByToolId.get(toolId)!.push(part);
            };

            for (const part of msg.parts || []) {
                if (part.inlineData) {
                    const imagePart = {
                        type: 'image_url',
                        image_url: {
                            url: `data:${part.inlineData.mimeType || part.inlineData.mime_type || 'image/png'};base64,${part.inlineData.data}`
                        }
                    };

                    const toolId = part.toolUseId;
                    if (toolId) {
                        pushGroupPart(toolId, imagePart);
                    } else {
                        pendingInlineWithoutId.push(imagePart);
                    }
                    continue;
                }

                if (part.functionResponse) {
                    const resp = part.functionResponse.response || {};
                    const output = extractToolResponseOutput(resp);
                    const toolId = part.functionResponse.tool_use_id || part.toolUseId;
                    if (!toolId) {
                        logger.warn({ part }, 'Skipping tool response without tool_call_id');
                        continue;
                    }

                    ensureGroup(toolId);

                    if (pendingInlineWithoutId.length > 0) {
                        for (const imagePart of pendingInlineWithoutId) {
                            pushGroupPart(toolId, imagePart);
                        }
                        pendingInlineWithoutId.length = 0;
                    }

                    const outputText = stringifyToolOutput(output);
                    if (outputText !== '') {
                        pushGroupPart(toolId, { type: 'text', text: outputText });
                    }
                }
            }

            if (pendingInlineWithoutId.length > 0) {
                logger.warn({ orphanCount: pendingInlineWithoutId.length }, 'Dropping inlineData without tool_call_id in tool message');
            }

            for (const toolId of toolIdOrder) {
                const groupedParts = groupedByToolId.get(toolId) || [];
                const hasNonTextPart = groupedParts.some((x: any) => x.type !== 'text');
                const content = groupedParts.length === 0
                    ? ''
                    : !hasNonTextPart && groupedParts.length === 1
                    ? groupedParts[0].text
                    : groupedParts;

                openaiMessages.push({
                    role: 'tool',
                    tool_call_id: toolId,
                    content,
                });
            }

            continue;
        }

        let content = [];
        let toolCalls = [];
        let reasoningContent = null;

        let parts = msg.parts || [];
        if (role === 'user' && parts.length > 1) {
            const allTextOnly = parts.every(p => (p.text !== undefined || p.system !== undefined) && !p.thinking && !p.functionCall && !p.functionResponse && !p.inlineData);
            if (allTextOnly) {
                const mergedText = parts
                    .map(p => p.system !== undefined ? `[SYSTEM: ${p.system}]` : p.text)
                    .filter(Boolean)
                    .join('\n');
                parts = [{ text: mergedText }];
            }
        }

        for (const part of parts) {
            if (part.thinking) {
                reasoningContent = part.thinking;
            }

            if (part.system) {
                content.push({ type: 'text', text: `[SYSTEM: ${part.system}]` });
            }

            if (part.text) {
                content.push({ type: 'text', text: part.text });
            }

            if (part.functionCall) {
                toolCalls.push({
                    id: part.functionCall.id || `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                    type: 'function',
                    function: {
                        name: part.functionCall.name,
                        arguments: stringifyFunctionCallArgs(part.functionCall)
                    }
                });
            }

            if (part.inlineData) {
                content.push({
                    type: 'image_url',
                    image_url: {
                        url: `data:${part.inlineData.mimeType || part.inlineData.mime_type || 'image/jpeg'};base64,${part.inlineData.data}`
                    }
                });
            }
        }

        const message: any = { role };

        if (reasoningContent) {
            message.reasoning_content = reasoningContent;
        }

        if (content.length === 1 && content[0].type === 'text') {
            message.content = content[0].text;
        } else if (content.length > 0) {
            message.content = content;
        } else {
            message.content = (msg as any).content || '';
        }

        if (toolCalls.length > 0) {
            message.tool_calls = toolCalls;
        }

        openaiMessages.push(message);
    }

    return openaiMessages;
}

export function convertToOpenAIResponsesFormat(contents: Message[]): any[] {
    const responseInput = [];

    const flushMessageContent = (
        role: 'user' | 'assistant',
        content: Array<OpenAIResponsesContent>
    ) => {
        if (content.length === 0) return;

        const message: any = {
            type: 'message',
            role,
            content: [...content]
        };

        if (role === 'assistant') {
            message.phase = 'final_answer';
        }

        responseInput.push(message);
        content.length = 0;
    };

    for (const msg of contents) {
        if (msg.role === 'tool') {
            const groupedByToolId = new Map<string, any[]>();
            const toolIdOrder: string[] = [];
            const pendingInlineWithoutId: any[] = [];

            const ensureGroup = (toolId: string) => {
                if (!groupedByToolId.has(toolId)) {
                    groupedByToolId.set(toolId, []);
                    toolIdOrder.push(toolId);
                }
            };

            const pushGroupPart = (toolId: string, part: any) => {
                ensureGroup(toolId);
                groupedByToolId.get(toolId)!.push(part);
            };

            for (const part of msg.parts || []) {
                if (part.inlineData) {
                    const imagePart = {
                        type: 'input_image',
                        image_url: `data:${part.inlineData.mimeType || part.inlineData.mime_type || 'image/png'};base64,${part.inlineData.data}`
                    };

                    const toolId = part.toolUseId;
                    if (toolId) {
                        pushGroupPart(toolId, imagePart);
                    } else {
                        pendingInlineWithoutId.push(imagePart);
                    }
                    continue;
                }

                if (part.functionResponse) {
                    const resp = part.functionResponse.response || {};
                    const output = extractToolResponseOutput(resp);
                    const toolId = part.functionResponse.tool_use_id || part.toolUseId;

                    if (!toolId) {
                        logger.warn({ part }, 'Skipping Responses tool output without call_id');
                        continue;
                    }

                    ensureGroup(toolId);

                    if (pendingInlineWithoutId.length > 0) {
                        for (const imagePart of pendingInlineWithoutId) {
                            pushGroupPart(toolId, imagePart);
                        }
                        pendingInlineWithoutId.length = 0;
                    }

                    const outputText = stringifyToolOutput(output);
                    if (outputText !== '') {
                        pushGroupPart(toolId, { type: 'input_text', text: outputText });
                    }
                }
            }

            if (pendingInlineWithoutId.length > 0) {
                logger.warn({ orphanCount: pendingInlineWithoutId.length }, 'Dropping inlineData without call_id in Responses tool output');
            }

            for (const toolId of toolIdOrder) {
                const outputParts = groupedByToolId.get(toolId) || [];
                const output = outputParts.length === 0
                    ? ''
                    : outputParts.length === 1 && outputParts[0].type === 'input_text'
                        ? outputParts[0].text
                        : outputParts;

                responseInput.push({
                    type: 'function_call_output',
                    call_id: toolId,
                    output
                });
            }

            continue;
        }

        const role = msg.role === 'model' ? 'assistant' : 'user';
        const content: Array<OpenAIResponsesContent> = [];

        for (const part of msg.parts || []) {
            if (part.system) {
                content.push({
                    type: role === 'assistant' ? 'output_text' : 'input_text',
                    text: `[SYSTEM: ${part.system}]`
                });
            }

            if (part.providerMeta?.thinkingSummaries || part.providerMeta?.encryptedThinking) {
                responseInput.push({
                    type: 'reasoning',
                    summary: part.providerMeta.thinkingSummaries.map(text => ({ text, type: 'summary_text' })),
                    encrypted_content: part.providerMeta.encryptedThinking,
                });
            }

            if (part.text) {
                content.push({
                    type: role === 'assistant' ? 'output_text' : 'input_text',
                    text: part.text
                });
            }

            if (part.inlineData) {
                if (role === 'assistant') {
                    logger.warn('Dropping assistant inlineData for Responses API history');
                } else {
                    content.push({
                        type: 'input_image',
                        image_url: `data:${part.inlineData.mimeType || part.inlineData.mime_type || 'image/jpeg'};base64,${part.inlineData.data}`
                    });
                }
            }

            if (part.functionCall) {
                flushMessageContent(role, content);
                responseInput.push({
                    type: 'function_call',
                    call_id: part.functionCall.id || `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                    name: part.functionCall.name,
                    arguments: stringifyFunctionCallArgs(part.functionCall)
                });
            }
        }

        flushMessageContent(role, content);
    }

    return responseInput;
}

export async function collectOpenAIResponsesStream(
    stream: any,
    signal: AbortSignal,
    options?: {
        onReasoningSummary?: (text: string) => void;
    },
): Promise<any> {
    if (signal.aborted) {
        throw makeAbortError();
    }

    return new Promise((resolve, reject) => {
        let settled = false;
        let buffer = '';
        let completedResponse: any = null;
        let lastSummaryText = '';
        const summaryParts = new Map<string, string>();
        const decoder = new StringDecoder('utf8');

        const cleanup = () => {
            signal.removeEventListener('abort', onAbort);
            stream.off?.('data', onData);
            stream.off?.('end', onEnd);
            stream.off?.('error', onError);
        };

        const finish = (callback: () => void) => {
            if (settled) {
                return;
            }

            settled = true;
            cleanup();
            callback();
        };

        const emitSummaryUpdate = () => {
            const nextText = buildReasoningSummaryText(summaryParts);
            if (nextText === lastSummaryText) {
                return;
            }

            lastSummaryText = nextText;
            options?.onReasoningSummary?.(nextText);
        };

        const handleEvent = (event: any) => {
            const key = `${event.output_index ?? 0}:${event.summary_index ?? 0}`;

            switch (event.type) {
                case 'response.reasoning_summary_part.done':
                    if (event.part?.text) {
                        summaryParts.set(key, event.part.text);
                        emitSummaryUpdate();
                    }
                    return;
                case 'response.reasoning_summary_text.delta':
                    summaryParts.set(key, `${summaryParts.get(key) || ''}${event.delta || ''}`);
                    emitSummaryUpdate();
                    return;
                case 'response.reasoning_summary_text.done':
                    summaryParts.set(key, event.text || summaryParts.get(key) || '');
                    emitSummaryUpdate();
                    return;
                case 'response.completed':
                    completedResponse = event.response;
                    return;
                case 'response.failed':
                    finish(() => reject(new Error(event.response?.error?.message || 'OpenAI Responses request failed.')));
                    return;
                case 'response.error':
                    finish(() => reject(new Error(event.error?.message || 'OpenAI Responses stream error.')));
                    return;
                default:
                    return;
            }
        };

        const appendDecodedText = (text: string) => {
            if (!text) {
                return;
            }

            buffer += text;
            buffer = buffer.replace(/\r\n/g, '\n');

            let boundaryIndex = buffer.indexOf('\n\n');
            while (boundaryIndex !== -1) {
                const block = buffer.slice(0, boundaryIndex);
                buffer = buffer.slice(boundaryIndex + 2);

                try {
                    const event = parseSseEventBlock(block);
                    if (event) {
                        handleEvent(event);
                    }
                } catch (error) {
                    finish(() => reject(error));
                    return;
                }

                boundaryIndex = buffer.indexOf('\n\n');
            }
        };

        const onAbort = () => {
            try {
                stream.destroy?.(makeAbortError());
            } catch {}
            finish(() => reject(makeAbortError()));
        };

        const onData = (chunk: any) => {
            appendDecodedText(typeof chunk === 'string' ? chunk : decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        };

        const onEnd = () => {
            appendDecodedText(decoder.end());
            finish(() => {
                if (completedResponse) {
                    resolve(completedResponse);
                    return;
                }

                reject(new Error('OpenAI Responses stream ended before response.completed.'));
            });
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

export async function collectOpenAIChatCompletionsStream(
    stream: any,
    signal: AbortSignal,
): Promise<any> {
    if (signal.aborted) {
        throw makeAbortError();
    }

    return new Promise((resolve, reject) => {
        let settled = false;
        let buffer = '';
        let finishReason: string | null = null;
        let usage: any = null;
        let sawChoice = false;
        const decoder = new StringDecoder('utf8');
        const toolCalls = new Map<number, any>();
        const message: any = {
            role: 'assistant',
            content: '',
        };

        const cleanup = () => {
            signal.removeEventListener('abort', onAbort);
            stream.off?.('data', onData);
            stream.off?.('end', onEnd);
            stream.off?.('error', onError);
        };

        const finish = (callback: () => void) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            callback();
        };

        const ensureToolCall = (index: number) => {
            if (!toolCalls.has(index)) {
                toolCalls.set(index, {
                    id: '',
                    type: 'function',
                    function: {
                        name: '',
                        arguments: '',
                    },
                });
            }
            return toolCalls.get(index);
        };

        const handleEvent = (event: any) => {
            if (event?.error) {
                finish(() => reject(new Error(event.error?.message || 'OpenAI chat stream error.')));
                return;
            }

            if (event?.usage) {
                usage = event.usage;
            }

            for (const choice of event?.choices || []) {
                if ((choice?.index ?? 0) !== 0) {
                    continue;
                }

                sawChoice = true;
                const delta = choice.delta || {};

                if (delta.role) {
                    message.role = delta.role;
                }

                message.content = appendDelta(message.content, delta.content) || '';
                message.reasoning_content = appendDelta(message.reasoning_content, delta.reasoning_content);
                message.reasoning = appendDelta(message.reasoning, delta.reasoning);

                if (Array.isArray(delta.tool_calls)) {
                    for (const toolCallDelta of delta.tool_calls) {
                        const entry = ensureToolCall(toolCallDelta.index ?? 0);
                        if (toolCallDelta.id) {
                            entry.id = appendDelta(entry.id, toolCallDelta.id) || entry.id;
                        }
                        if (toolCallDelta.type) {
                            entry.type = toolCallDelta.type;
                        }
                        if (toolCallDelta.function) {
                            entry.function.name = appendDelta(entry.function.name, toolCallDelta.function.name) || entry.function.name;
                            entry.function.arguments = appendDelta(entry.function.arguments, toolCallDelta.function.arguments) || entry.function.arguments;
                        }
                    }
                }

                if (choice.finish_reason) {
                    finishReason = choice.finish_reason;
                }
            }
        };

        const appendDecodedText = (text: string) => {
            if (!text) {
                return;
            }

            buffer += text;
            buffer = buffer.replace(/\r\n/g, '\n');

            let boundaryIndex = buffer.indexOf('\n\n');
            while (boundaryIndex !== -1) {
                const block = buffer.slice(0, boundaryIndex);
                buffer = buffer.slice(boundaryIndex + 2);

                try {
                    const event = parseSseEventBlock(block);
                    if (event) {
                        handleEvent(event);
                    }
                } catch (error) {
                    finish(() => reject(error));
                    return;
                }

                boundaryIndex = buffer.indexOf('\n\n');
            }
        };

        const onAbort = () => {
            try {
                stream.destroy?.(makeAbortError());
            } catch {}
            finish(() => reject(makeAbortError()));
        };

        const onData = (chunk: any) => {
            appendDecodedText(typeof chunk === 'string' ? chunk : decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        };

        const onEnd = () => {
            appendDecodedText(decoder.end());
            finish(() => {
                if (!sawChoice && !usage) {
                    reject(new Error('OpenAI chat stream ended before any choices were received.'));
                    return;
                }

                const sortedToolCalls = Array.from(toolCalls.entries())
                    .sort(([left], [right]) => left - right)
                    .map(([, toolCall]) => toolCall);

                if (sortedToolCalls.length > 0) {
                    message.tool_calls = sortedToolCalls;
                }

                resolve({
                    choices: [{ message, finish_reason: finishReason }],
                    usage,
                });
            });
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