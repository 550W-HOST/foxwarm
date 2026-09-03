import { StringDecoder } from 'string_decoder';
import { logger } from '../common';
import { Message, MessagePart, OpenAIResponsesContent } from '../types';
import { stringifyFunctionCallArgs } from '../toolCallArgs';
import { formatToolResponsePayload } from '../../packages/shared/dist/toolResponseFormatting';
import { appendImageGuidanceText } from '../toolImages';
import { deduplicateProviderRequestImages } from '../providerImageDedup';
import { formatFoxwarmSystemTag } from '../utils/promptWrappers';
import { formatSystemPartForModel } from '../utils/promptWrappers';

function makeAbortError(message = 'LLM request aborted'): Error & { code: string } {
    const error = new Error(message) as Error & { code: string };
    error.name = 'AbortError';
    error.code = 'ERR_CANCELED';
    return error;
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

export type OpenAIStreamToolCallSnapshot = {
    index: number;
    id?: string;
    name?: string;
    arguments?: string;
};

export type OpenAIStreamProgressSnapshot = {
    reasoning?: string;
    text?: string;
    toolCalls?: OpenAIStreamToolCallSnapshot[];
};

type OpenAIStreamProgressOptions = {
    onProgress?: (snapshot: OpenAIStreamProgressSnapshot) => void;
    onRawChunk?: (text: string) => void;
    onRawSseBlock?: (block: string) => void;
};

function cleanSnapshotString(value: unknown): string | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
}

function formatPreviousLlmRequestPrefix(part: MessagePart): string | undefined {
    const timing = part.functionResponse?.previousLlmRequest;
    if (!timing || typeof timing.time !== 'string' || !Number.isFinite(timing.durationMs)) {
        return undefined;
    }
    return formatFoxwarmSystemTag({
        kind: 'time',
        time: timing.time,
        prevLLMReqTime: `${(Math.max(0, timing.durationMs) / 1000).toFixed(1)}s`,
    });
}

function mergeResponseContentPart(existing: any, incoming: any): any {
    if (!existing) {
        return incoming ? { ...incoming } : incoming;
    }

    if (!incoming) {
        return existing;
    }

    const merged = {
        ...existing,
        ...incoming,
    };
    if (incoming.text !== undefined || existing.text !== undefined) {
        merged.text = incoming.text ?? existing.text;
    }
    if (incoming.refusal !== undefined || existing.refusal !== undefined) {
        merged.refusal = incoming.refusal ?? existing.refusal;
    }
    if (incoming.annotations !== undefined || existing.annotations !== undefined) {
        merged.annotations = Array.isArray(incoming.annotations) && incoming.annotations.length > 0
            ? incoming.annotations
            : existing.annotations ?? incoming.annotations;
    }
    return merged;
}

function mergeResponseOutputItem(existing: any, incoming: any): any {
    if (!existing) {
        if (!incoming) return incoming;
        const initial = { ...incoming };
        if (Array.isArray(incoming.content)) initial.content = [...incoming.content];
        if (Array.isArray(incoming.summary)) initial.summary = [...incoming.summary];
        return initial;
    }

    if (!incoming) {
        return existing;
    }

    const merged = {
        ...existing,
        ...incoming,
    };

    if (Array.isArray(existing.content) || Array.isArray(incoming.content)) {
        const maxLength = Math.max(existing.content?.length || 0, incoming.content?.length || 0);
        const content = [];
        for (let index = 0; index < maxLength; index++) {
            const part = mergeResponseContentPart(existing.content?.[index], incoming.content?.[index]);
            if (part !== undefined) {
                content.push(part);
            }
        }
        merged.content = content;
    }

    if ((incoming.arguments === undefined || incoming.arguments === '') && typeof existing.arguments === 'string') {
        merged.arguments = existing.arguments;
    }

    if (Array.isArray(existing.summary) || Array.isArray(incoming.summary)) {
        merged.summary = Array.isArray(incoming.summary) && incoming.summary.length > 0
            ? [...incoming.summary]
            : Array.isArray(existing.summary)
            ? [...existing.summary]
            : incoming.summary;
    }

    return merged;
}

function hasUsableReasoningSummary(summary: unknown): summary is any[] {
    return Array.isArray(summary) && summary.some((entry: any) =>
        typeof (entry?.text ?? entry?.summary) === 'string'
        && (entry.text ?? entry.summary).length > 0,
    );
}

function isProviderSpecificFields(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

interface ToolImageAssociations {
    byResponsePartIndex: Map<number, MessagePart[]>;
    orphanImagePartIndexes: Set<number>;
}

function associateToolImagesByOccurrence(
    parts: MessagePart[],
    isDeduplicated: (part: MessagePart) => boolean,
): ToolImageAssociations {
    const responseIndexesByToolId = new Map<string, number[]>();
    for (let index = 0; index < parts.length; index += 1) {
        const part = parts[index];
        const toolId = part.functionResponse?.tool_use_id || (part.functionResponse ? part.toolUseId : undefined);
        if (!toolId) continue;
        const indexes = responseIndexesByToolId.get(toolId) || [];
        indexes.push(index);
        responseIndexesByToolId.set(toolId, indexes);
    }

    const byResponsePartIndex = new Map<number, MessagePart[]>();
    const orphanImagePartIndexes = new Set<number>();
    for (let imageIndex = 0; imageIndex < parts.length; imageIndex += 1) {
        const image = parts[imageIndex];
        if (!image.toolUseId || (!image.inlineData && !isDeduplicated(image))) continue;
        const responseIndexes = responseIndexesByToolId.get(image.toolUseId) || [];
        if (responseIndexes.length === 0) {
            orphanImagePartIndexes.add(imageIndex);
            continue;
        }

        let selected = responseIndexes[0];
        let selectedDistance = Math.abs(selected - imageIndex);
        for (const responseIndex of responseIndexes.slice(1)) {
            const distance = Math.abs(responseIndex - imageIndex);
            const selectedIsFollowing = selected > imageIndex;
            const candidateIsPreceding = responseIndex < imageIndex;
            if (distance < selectedDistance
                || (distance === selectedDistance && selectedIsFollowing && candidateIsPreceding)) {
                selected = responseIndex;
                selectedDistance = distance;
            }
        }
        const associated = byResponsePartIndex.get(selected) || [];
        associated.push(image);
        byResponsePartIndex.set(selected, associated);
    }
    return { byResponsePartIndex, orphanImagePartIndexes };
}

export function convertToOpenAIFormat(
    contents: Message[],
    concreteModelId?: string,
    historyReasoningField: 'reasoning_content' | 'reasoning' = 'reasoning_content',
): any[] {
    const preparedImages = deduplicateProviderRequestImages(contents, 'openai-chat-completions');
    contents = preparedImages.messages;
    const isDeduplicated = preparedImages.isDeduplicated;
    const openaiMessages = [];

    for (const msg of contents) {
        let role = msg.role as any;
        if (role === 'model') role = 'assistant';

        if (role === 'tool') {
            const groupedByToolId = new Map<string, any[]>();
            const toolIdOrder: string[] = [];
            const pendingInlineWithoutId: any[] = [];
            const pendingDeduplicatedWithoutId: MessagePart[] = [];
            const associations = associateToolImagesByOccurrence(msg.parts || [], isDeduplicated);

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
            const prependGroupPart = (toolId: string, part: any) => {
                ensureGroup(toolId);
                groupedByToolId.get(toolId)!.unshift(part);
            };

            for (let partIndex = 0; partIndex < (msg.parts || []).length; partIndex += 1) {
                const part = msg.parts[partIndex];
                if (part.inlineData || isDeduplicated(part)) {
                    const toolId = part.toolUseId;
                    if (!part.inlineData) {
                        if (!toolId) {
                            pendingDeduplicatedWithoutId.push(part);
                        } else if (associations.orphanImagePartIndexes.has(partIndex)) {
                            const marker = appendImageGuidanceText([part], '', isDeduplicated);
                            if (marker) pushGroupPart(toolId, { type: 'text', text: marker });
                        }
                        continue;
                    }
                    const imagePart = {
                        type: 'image_url',
                        image_url: {
                            url: `data:${part.inlineData.mimeType || part.inlineData.mime_type || 'image/png'};base64,${part.inlineData.data}`
                        }
                    };

                    if (toolId) {
                        pushGroupPart(toolId, imagePart);
                    } else {
                        pendingInlineWithoutId.push(imagePart);
                    }
                    continue;
                }

                if (part.functionResponse) {
                    const resp = part.functionResponse.response || {};
                    const toolId = part.functionResponse.tool_use_id || part.toolUseId;
                    if (!toolId) {
                        logger.warn({ part }, 'Skipping tool response without tool_call_id');
                        continue;
                    }

                    ensureGroup(toolId);

                    const timingPrefix = formatPreviousLlmRequestPrefix(part);
                    if (timingPrefix) {
                        prependGroupPart(toolId, { type: 'text', text: timingPrefix });
                    }

                    if (pendingInlineWithoutId.length > 0) {
                        for (const imagePart of pendingInlineWithoutId) {
                            pushGroupPart(toolId, imagePart);
                        }
                        pendingInlineWithoutId.length = 0;
                    }
                    const responseImageParts = [
                        ...(associations.byResponsePartIndex.get(partIndex) || []),
                        ...pendingDeduplicatedWithoutId,
                    ];
                    pendingDeduplicatedWithoutId.length = 0;
                    const outputText = appendImageGuidanceText(
                        responseImageParts,
                        formatToolResponsePayload(resp),
                        isDeduplicated,
                    );
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
                    .map(p => p.system !== undefined ? formatSystemPartForModel(p.system) : p.text)
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
                content.push({ type: 'text', text: formatSystemPartForModel(part.system) });
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
            message[historyReasoningField] = reasoningContent;
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

        if (
            role === 'assistant'
            && concreteModelId
            && msg.providerMeta?.sourceModelId === concreteModelId
            && isProviderSpecificFields(msg.providerMeta.providerSpecificFields)
        ) {
            message.provider_specific_fields = msg.providerMeta.providerSpecificFields;
        }

        openaiMessages.push(message);
    }

    return openaiMessages;
}

export function convertToOpenAIResponsesFormat(contents: Message[], concreteModelId?: string): any[] {
    const preparedImages = deduplicateProviderRequestImages(contents, 'openai-responses');
    contents = preparedImages.messages;
    const isDeduplicated = preparedImages.isDeduplicated;
    const responseInput = [];

    const getCompatibleResponsesMeta = (part: MessagePart) => {
        const metadata = part.providerMeta?.openaiResponses;
        return concreteModelId && metadata?.sourceModelId === concreteModelId
            ? metadata
            : undefined;
    };

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
            const pendingDeduplicatedWithoutId: MessagePart[] = [];
            const associations = associateToolImagesByOccurrence(msg.parts || [], isDeduplicated);

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
            const prependGroupPart = (toolId: string, part: any) => {
                ensureGroup(toolId);
                groupedByToolId.get(toolId)!.unshift(part);
            };

            for (let partIndex = 0; partIndex < (msg.parts || []).length; partIndex += 1) {
                const part = msg.parts[partIndex];
                if (part.inlineData || isDeduplicated(part)) {
                    const toolId = part.toolUseId;
                    if (!part.inlineData) {
                        if (!toolId) {
                            pendingDeduplicatedWithoutId.push(part);
                        } else if (associations.orphanImagePartIndexes.has(partIndex)) {
                            const marker = appendImageGuidanceText([part], '', isDeduplicated);
                            if (marker) pushGroupPart(toolId, { type: 'input_text', text: marker });
                        }
                        continue;
                    }
                    const imagePart = {
                        type: 'input_image',
                        image_url: `data:${part.inlineData.mimeType || part.inlineData.mime_type || 'image/png'};base64,${part.inlineData.data}`
                    };

                    if (toolId) {
                        pushGroupPart(toolId, imagePart);
                    } else {
                        pendingInlineWithoutId.push(imagePart);
                    }
                    continue;
                }

                if (part.functionResponse) {
                    const resp = part.functionResponse.response || {};
                    const toolId = part.functionResponse.tool_use_id || part.toolUseId;

                    if (!toolId) {
                        logger.warn({ part }, 'Skipping Responses tool output without call_id');
                        continue;
                    }

                    ensureGroup(toolId);

                    const timingPrefix = formatPreviousLlmRequestPrefix(part);
                    if (timingPrefix) {
                        prependGroupPart(toolId, { type: 'input_text', text: timingPrefix });
                    }

                    if (pendingInlineWithoutId.length > 0) {
                        for (const imagePart of pendingInlineWithoutId) {
                            pushGroupPart(toolId, imagePart);
                        }
                        pendingInlineWithoutId.length = 0;
                    }
                    const responseImageParts = [
                        ...(associations.byResponsePartIndex.get(partIndex) || []),
                        ...pendingDeduplicatedWithoutId,
                    ];
                    pendingDeduplicatedWithoutId.length = 0;
                    const outputText = appendImageGuidanceText(
                        responseImageParts,
                        formatToolResponsePayload(resp),
                        isDeduplicated,
                    );
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
            const responsesMeta = getCompatibleResponsesMeta(part);

            if (responsesMeta?.outputItem) {
                flushMessageContent(role, content);
                responseInput.push(structuredClone(responsesMeta.outputItem));
            }

            if (part.system) {
                content.push({
                    type: role === 'assistant' ? 'output_text' : 'input_text',
                    text: formatSystemPartForModel(part.system)
                });
            }

            if (part.providerMeta?.thinkingSummaries || part.providerMeta?.encryptedThinking) {
                flushMessageContent(role, content);
                responseInput.push({
                    type: 'reasoning',
                    summary: (part.providerMeta.thinkingSummaries || []).map(text => ({ text, type: 'summary_text' })),
                    encrypted_content: part.providerMeta.encryptedThinking,
                });
            }

            if (part.text) {
                const outputTextPart: any = {
                    type: role === 'assistant' ? 'output_text' : 'input_text',
                    text: part.text
                };
                if (role === 'assistant' && responsesMeta?.annotations) {
                    outputTextPart.annotations = structuredClone(responsesMeta.annotations);
                }
                content.push(outputTextPart);
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
    options?: OpenAIStreamProgressOptions,
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
        const outputItems = new Map<number, any>();
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

        const ensureOutputItem = (outputIndex: number, initial?: any) => {
            const existing = outputItems.get(outputIndex);
            const next = mergeResponseOutputItem(existing, initial);
            if (next !== undefined) {
                outputItems.set(outputIndex, next);
            }
            return outputItems.get(outputIndex);
        };

        const ensureContentPart = (outputIndex: number, contentIndex: number, initial?: any) => {
            const item = ensureOutputItem(outputIndex, { type: 'message', role: 'assistant', content: [] });
            if (!item) {
                return null;
            }

            if (!Array.isArray(item.content)) {
                item.content = [];
            }

            item.content[contentIndex] = mergeResponseContentPart(item.content[contentIndex], initial);
            return item.content[contentIndex];
        };

        const buildTextSnapshot = (): string =>
            Array.from(outputItems.entries())
                .sort(([leftIndex], [rightIndex]) => leftIndex - rightIndex)
                .map(([, item]) => {
                    if (item?.type !== 'message' || item.role !== 'assistant' || !Array.isArray(item.content)) {
                        return '';
                    }
                    return item.content
                        .map((part: any) => {
                            if (part?.type === 'output_text' && typeof part.text === 'string') {
                                return part.text;
                            }
                            if (part?.type === 'refusal' && typeof part.refusal === 'string') {
                                return part.refusal;
                            }
                            return '';
                        })
                        .join('');
                })
                .join('');

        const buildToolCallSnapshot = (): OpenAIStreamToolCallSnapshot[] =>
            Array.from(outputItems.entries())
                .sort(([leftIndex], [rightIndex]) => leftIndex - rightIndex)
                .filter(([, item]) => item?.type === 'function_call')
                .map(([outputIndex, item]) => ({
                    index: outputIndex,
                    ...(cleanSnapshotString(item.call_id || item.id) ? { id: cleanSnapshotString(item.call_id || item.id) } : {}),
                    ...(cleanSnapshotString(item.name) ? { name: cleanSnapshotString(item.name) } : {}),
                    ...(typeof item.arguments === 'string' ? { arguments: item.arguments } : {}),
                }));

        const buildProgressSnapshot = (): OpenAIStreamProgressSnapshot => ({
            reasoning: buildReasoningSummaryText(summaryParts),
            text: buildTextSnapshot(),
            toolCalls: buildToolCallSnapshot(),
        });

        const emitProgressUpdate = () => {
            options?.onProgress?.(buildProgressSnapshot());
        };

        const emitSummaryUpdate = () => {
            const nextText = buildReasoningSummaryText(summaryParts);
            if (nextText === lastSummaryText) {
                return;
            }

            lastSummaryText = nextText;
            emitProgressUpdate();
        };

        const buildOutputEntries = () =>
            Array.from(outputItems.entries())
                .sort(([leftIndex], [rightIndex]) => leftIndex - rightIndex)
                .map(([outputIndex, item]) => {
                    const mergedItem = mergeResponseOutputItem(undefined, item) || item;

                    if (Array.isArray(mergedItem?.content)) {
                        mergedItem.content = mergedItem.content.filter((part: any) => part !== undefined);
                    }

                    const reasoningSummary = Array.from(summaryParts.entries())
                        .map(([key, text]) => {
                            const [summaryOutput = '0', summaryIndex = '0'] = key.split(':');
                            return {
                                outputIndex: Number(summaryOutput),
                                summaryIndex: Number(summaryIndex),
                                text,
                            };
                        })
                        .filter((entry) => entry.outputIndex === outputIndex && entry.text)
                        .sort((left, right) => left.summaryIndex - right.summaryIndex)
                        .map((entry) => ({
                            type: 'summary_text',
                            text: entry.text,
                        }));

                    if (mergedItem?.type === 'reasoning' && reasoningSummary.length > 0) {
                        mergedItem.summary = reasoningSummary;
                    }

                    return { outputIndex, item: mergedItem };
                })
                .filter(Boolean);

        const mergeCompletedOutputItems = (completedOutput: unknown) => {
            const streamedEntries = buildOutputEntries();
            if (streamedEntries.length === 0) {
                return Array.isArray(completedOutput) ? completedOutput : [];
            }

            const completedItems = Array.isArray(completedOutput) ? completedOutput : [];
            const isPositionallyAligned = streamedEntries.length === completedItems.length
                && streamedEntries.every((entry, index) => {
                    if (entry.outputIndex !== index) {
                        return false;
                    }
                    const streamedItem = entry.item;
                    const completedItem = completedItems[index];
                    if (!streamedItem || !completedItem || typeof streamedItem.type !== 'string' || streamedItem.type !== completedItem.type) {
                        return false;
                    }
                    const streamedId = streamedItem.id || streamedItem.call_id;
                    const completedId = completedItem.id || completedItem.call_id;
                    return !streamedId || !completedId || streamedId === completedId;
                });

            if (!isPositionallyAligned) {
                // Hosted Responses tools may be present in the streamed
                // output-item sequence but omitted from response.completed's
                // compact output array. In that case ordinal merging would
                // attach the final message to an earlier search call and
                // duplicate the text. The stream's indexed order is the
                // authoritative sequence whenever alignment is unproven.
                return streamedEntries.map(entry => entry.item);
            }

            return streamedEntries.map((entry, index) => {
                // The completed payload is authoritative when the complete
                // arrays are proven aligned; the streamed item fills fields
                // omitted by compatible gateways and preserves annotations.
                const mergedItem = mergeResponseOutputItem(entry.item, completedItems[index]);
                if (entry.item?.type === 'reasoning' && hasUsableReasoningSummary(entry.item.summary)) {
                    // Indexed streamed summary parts preserve boundaries that
                    // response.completed may condense into one string.
                    mergedItem.summary = [...entry.item.summary];
                }
                return mergedItem;
            });
        };

        const handleEvent = (event: any) => {
            const key = `${event.output_index ?? 0}:${event.summary_index ?? 0}`;

            switch (event.type) {
                case 'response.output_item.added':
                case 'response.output_item.done':
                    if (typeof event.output_index === 'number' && event.item) {
                        ensureOutputItem(event.output_index, event.item);
                        emitProgressUpdate();
                    }
                    return;
                case 'response.content_part.added':
                case 'response.content_part.done':
                    if (typeof event.output_index === 'number' && typeof event.content_index === 'number') {
                        ensureContentPart(event.output_index, event.content_index, event.part);
                        emitProgressUpdate();
                    }
                    return;
                case 'response.output_text.delta':
                    if (typeof event.output_index === 'number' && typeof event.content_index === 'number') {
                        const part = ensureContentPart(event.output_index, event.content_index, { type: 'output_text' });
                        if (part) {
                            part.text = `${part.text || ''}${event.delta || ''}`;
                            emitProgressUpdate();
                        }
                    }
                    return;
                case 'response.output_text.done':
                    if (typeof event.output_index === 'number' && typeof event.content_index === 'number') {
                        const part = ensureContentPart(event.output_index, event.content_index, {
                            type: 'output_text',
                            text: event.text || '',
                        });
                        if (part && typeof event.text === 'string') {
                            part.text = event.text;
                            emitProgressUpdate();
                        }
                    }
                    return;
                case 'response.output_text.annotation.added':
                    if (typeof event.output_index === 'number' && typeof event.content_index === 'number' && event.annotation) {
                        const part = ensureContentPart(event.output_index, event.content_index, { type: 'output_text' });
                        if (part) {
                            if (!Array.isArray(part.annotations)) {
                                part.annotations = [];
                            }
                            const annotationIndex = typeof event.annotation_index === 'number'
                                ? event.annotation_index
                                : part.annotations.length;
                            part.annotations[annotationIndex] = event.annotation;
                            emitProgressUpdate();
                        }
                    }
                    return;
                case 'response.refusal.delta':
                    if (typeof event.output_index === 'number' && typeof event.content_index === 'number') {
                        const part = ensureContentPart(event.output_index, event.content_index, { type: 'refusal' });
                        if (part) {
                            part.refusal = `${part.refusal || ''}${event.delta || ''}`;
                            emitProgressUpdate();
                        }
                    }
                    return;
                case 'response.refusal.done':
                    if (typeof event.output_index === 'number' && typeof event.content_index === 'number') {
                        const part = ensureContentPart(event.output_index, event.content_index, {
                            type: 'refusal',
                            refusal: event.refusal || '',
                        });
                        if (part && typeof event.refusal === 'string') {
                            part.refusal = event.refusal;
                            emitProgressUpdate();
                        }
                    }
                    return;
                case 'response.function_call_arguments.delta':
                    if (typeof event.output_index === 'number') {
                        const item = ensureOutputItem(event.output_index, { type: 'function_call' });
                        if (item) {
                            item.arguments = `${item.arguments || ''}${event.delta || ''}`;
                            emitProgressUpdate();
                        }
                    }
                    return;
                case 'response.function_call_arguments.done':
                    if (typeof event.output_index === 'number') {
                        const item = ensureOutputItem(event.output_index, {
                            type: 'function_call',
                            arguments: event.arguments || '',
                        });
                        if (item && typeof event.arguments === 'string') {
                            item.arguments = event.arguments;
                            emitProgressUpdate();
                        }
                    }
                    return;
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
                    if (completedResponse) {
                        completedResponse.output = mergeCompletedOutputItems(completedResponse.output);
                        emitProgressUpdate();
                    }
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

            options?.onRawChunk?.(text);
            buffer += text;
            buffer = buffer.replace(/\r\n/g, '\n');

            let boundaryIndex = buffer.indexOf('\n\n');
            while (boundaryIndex !== -1) {
                const block = buffer.slice(0, boundaryIndex);
                buffer = buffer.slice(boundaryIndex + 2);
                options?.onRawSseBlock?.(block);

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
    options?: OpenAIStreamProgressOptions,
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
        const toolCallEntries: Array<{ streamIndex: number; progressIndex: number; sequence: number; toolCall: any }> = [];
        const toolCallByIndex = new Map<number, { streamIndex: number; progressIndex: number; sequence: number; toolCall: any }>();
        const usedProgressIndices = new Set<number>();
        let nextToolCallSequence = 0;
        let nextFallbackProgressIndex = 0;
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

        const makeToolCall = () => ({
            id: '',
            type: 'function',
            function: {
                name: '',
                arguments: '',
            },
        });

        const addToolCall = (index: number) => {
            let progressIndex = index;
            if (usedProgressIndices.has(progressIndex)) {
                while (usedProgressIndices.has(nextFallbackProgressIndex)) {
                    nextFallbackProgressIndex++;
                }
                progressIndex = nextFallbackProgressIndex++;
            }
            usedProgressIndices.add(progressIndex);
            const entry = {
                streamIndex: index,
                progressIndex,
                sequence: nextToolCallSequence++,
                toolCall: makeToolCall(),
            };
            toolCallEntries.push(entry);
            toolCallByIndex.set(index, entry);
            return entry;
        };

        const ensureToolCall = (index: number, id?: string, hasInitialIdentity = false) => {
            let entry = toolCallByIndex.get(index);
            if (!entry) {
                return addToolCall(index).toolCall;
            }
            // Some providers reuse the same index for each parallel tool call
            // instead of incrementing it. Only split when the differing id is
            // accompanied by the initial function identity/type expected at a
            // genuinely new call; an id-only delta may be a normal fragment.
            if (id && entry.toolCall.id && id !== entry.toolCall.id && hasInitialIdentity) {
                entry = addToolCall(index);
            }
            return entry.toolCall;
        };

        const getOrderedToolCallEntries = () => [...toolCallEntries]
            .sort((left, right) => left.streamIndex - right.streamIndex || left.sequence - right.sequence);

        const getOrderedToolCalls = () => getOrderedToolCallEntries().map(entry => entry.toolCall);

        const buildReasoningSnapshot = (): string => [message.reasoning_content, message.reasoning]
            .filter((value: unknown): value is string => typeof value === 'string' && value.length > 0)
            .join('\n');

        const buildToolCallSnapshot = (): OpenAIStreamToolCallSnapshot[] =>
            getOrderedToolCallEntries().map(entry => {
                const toolCall = entry.toolCall;
                return {
                    index: entry.progressIndex,
                    ...(cleanSnapshotString(toolCall.id) ? { id: cleanSnapshotString(toolCall.id) } : {}),
                    ...(cleanSnapshotString(toolCall.function?.name) ? { name: cleanSnapshotString(toolCall.function?.name) } : {}),
                    ...(typeof toolCall.function?.arguments === 'string' ? { arguments: toolCall.function.arguments } : {}),
                };
            });

        const emitProgressUpdate = () => {
            options?.onProgress?.({
                reasoning: buildReasoningSnapshot(),
                text: typeof message.content === 'string' ? message.content : '',
                toolCalls: buildToolCallSnapshot(),
            });
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
                let changed = false;

                if (delta.role) {
                    message.role = delta.role;
                }

                const nextContent = appendDelta(message.content, delta.content);
                if (nextContent !== message.content) {
                    message.content = nextContent || '';
                    changed = true;
                } else {
                    message.content = message.content || '';
                }
                const nextReasoningContent = appendDelta(message.reasoning_content, delta.reasoning_content);
                if (nextReasoningContent !== message.reasoning_content) {
                    message.reasoning_content = nextReasoningContent;
                    changed = true;
                }
                const nextReasoning = appendDelta(message.reasoning, delta.reasoning);
                if (nextReasoning !== message.reasoning) {
                    message.reasoning = nextReasoning;
                    changed = true;
                }

                // Opaque provider fields (e.g. reasoning_signature) are captured
                // verbatim so later requests to the same concrete model can
                // echo them back unchanged.
                if (isProviderSpecificFields(delta.provider_specific_fields)) {
                    message.provider_specific_fields = delta.provider_specific_fields;
                }

                if (Array.isArray(delta.tool_calls)) {
                    for (const toolCallDelta of delta.tool_calls) {
                        const hasInitialIdentity = !!(
                            toolCallDelta.type
                            || (typeof toolCallDelta.function?.name === 'string' && toolCallDelta.function.name.length > 0)
                        );
                        const entry = ensureToolCall(toolCallDelta.index ?? 0, toolCallDelta.id, hasInitialIdentity);
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
                        changed = true;
                    }
                }

                if (changed) {
                    emitProgressUpdate();
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

            options?.onRawChunk?.(text);
            buffer += text;
            buffer = buffer.replace(/\r\n/g, '\n');

            let boundaryIndex = buffer.indexOf('\n\n');
            while (boundaryIndex !== -1) {
                const block = buffer.slice(0, boundaryIndex);
                buffer = buffer.slice(boundaryIndex + 2);
                options?.onRawSseBlock?.(block);

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

                const orderedToolCalls = getOrderedToolCalls();
                if (orderedToolCalls.length > 0) {
                    message.tool_calls = orderedToolCalls;
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