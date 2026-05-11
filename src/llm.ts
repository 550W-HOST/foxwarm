import axios, { AxiosResponse } from 'axios';
import crypto from 'crypto';
import fs from 'fs-extra';
import path from 'path';
import { StringDecoder } from 'string_decoder';
import zlib from 'zlib';
import * as tools from './tools';
import { logger } from './common';
import { MessagePart, AnthropicContentBlock, Message, AnthropicMessage, Session, ChatResult, FunctionCall, TokenUsage, ToolDefinition } from './types';
import { LOGS_DIR, resolveModelConfig, ModelConfigEntry, MAX_OUTPUT, THINKING_BUDGET, getAgentMemoryDir, MAIN_AGENT_MEMORY_DIR, getAgentDir } from './config';
import { nodesManager } from './nodes/manager';
import * as sessionManager from './sessionManager';
import { formatTime, getRecentLogPath, moveLogsToDateErrorDir } from './logRotation';
import { listSkills } from './skills';
import { checkToolPermission, checkPathAccess } from './isolatedCheck';
import {
    collectOpenAIChatCompletionsStream as collectOpenAIChatCompletionsStreamProvider,
    collectOpenAIResponsesStream as collectOpenAIResponsesStreamProvider,
    convertToOpenAIFormat as convertToOpenAIFormatProvider,
    convertToOpenAIResponsesFormat as convertToOpenAIResponsesFormatProvider,
} from './llmProviders/openai';
import { parseFunctionCallArgs } from './toolCallArgs';
import { formatToolResponsePayload } from '../packages/shared/dist/toolResponseFormatting';
import { isSystemPayloadTextPart } from './utils/systemMessageParts';
import { appendImageGuidanceText, normalizeToolResultImages } from './toolImages';
import { guardToolOutputForModel } from './toolOutputGuard';
import { sanitizeLoneSurrogatesInPayload } from './utils/unicode';
import { isModelVisibleMessage } from './session/messageVisibility';

type LlmInteractionLogFiles = {
    requestPath: string;
    responsePath: string;
};

export function sanitizeProviderRequestPayload<T>(payload: T) {
    return sanitizeLoneSurrogatesInPayload(payload);
}

function maybeCompressLlmRequestBody(data: any, modelEntry: ModelConfigEntry) {
    if (!modelEntry.requestCompression) {
        return { requestBody: data, requestHeaders: {} as Record<string, string> };
    }

    const jsonBuffer = Buffer.from(JSON.stringify(data));
    const compressed = modelEntry.requestCompression === 'br'
        ? zlib.brotliCompressSync(jsonBuffer)
        : zlib.gzipSync(jsonBuffer);

    return {
        requestBody: compressed,
        requestHeaders: {
            'Content-Encoding': modelEntry.requestCompression,
            'Content-Length': String(compressed.length),
        },
    };
}

function makeAbortError(message = 'LLM request aborted'): Error & { code: string } {
    const error = new Error(message) as Error & { code: string };
    error.name = 'AbortError';
    error.code = 'ERR_CANCELED';
    return error;
}

function sleepWithSignal(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
        return Promise.reject(makeAbortError());
    }

    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        }, ms);

        const onAbort = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
            reject(makeAbortError());
        };

        signal.addEventListener('abort', onAbort, { once: true });
    });
}

export function isAbortError(error: any): boolean {
    return !!(
        axios.isCancel?.(error)
        || error?.code === 'ERR_CANCELED'
        || error?.name === 'AbortError'
        || error?.name === 'CanceledError'
    );
}

function getPromptCacheKey(session: Session): string {
    const sessionId = session.id || 'default';
    return crypto.createHash('md5').update(`session_${sessionId}`).digest('hex');
}

function getPromptCacheKeyForSessionId(sessionId?: string): string {
    const normalizedSessionId = sessionId || 'default';
    return crypto.createHash('md5').update(`session_${normalizedSessionId}`).digest('hex');
}

type RequestLlmOnceOptions = {
    contents: Message[];
    systemPrompt: string;
    model?: string;
    modelEntryOverride?: ModelConfigEntry;
    sessionId?: string;
    promptCacheKey?: string;
    iteration?: number;
    toolDefinitions?: ToolDefinition[];
    notifySessionEvents?: boolean;
    registerAbortController?: boolean;
    maxRetries?: number;
    timeoutMs?: number;
};

export function getOpenAIRequestApi(providerType: string): 'responses' | 'chat-completions' | null {
    if (providerType === 'openai' || providerType === 'openai-responses') {
        return 'responses';
    }

    if (providerType === 'openai-completions') {
        return 'chat-completions';
    }

    return null;
}

function readStreamAsText(stream: any, signal: AbortSignal): Promise<string> {
    if (signal.aborted) {
        return Promise.reject(makeAbortError());
    }

    return new Promise((resolve, reject) => {
        let chunks = '';
        const decoder = new StringDecoder('utf8');

        const cleanup = () => {
            signal.removeEventListener('abort', onAbort);
            stream.off?.('data', onData);
            stream.off?.('end', onEnd);
            stream.off?.('error', onError);
        };

        const onAbort = () => {
            cleanup();
            try {
                stream.destroy?.(makeAbortError());
            } catch {}
            reject(makeAbortError());
        };

        const onData = (chunk: any) => {
            chunks += typeof chunk === 'string'
                ? chunk
                : decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        };

        const onEnd = () => {
            chunks += decoder.end();
            cleanup();
            resolve(chunks);
        };

        const onError = (error: any) => {
            cleanup();
            reject(error);
        };

        signal.addEventListener('abort', onAbort, { once: true });
        stream.on('data', onData);
        stream.on('end', onEnd);
        stream.on('error', onError);
    });
}

function stripWrappingBlankLines(text: string): string {
    return text.replace(/^\s*\n/, '').replace(/\n\s*$/, '');
}

function extractAnthropicThinkingTaggedParts(text: string): MessagePart[] | null {
    if (!text.includes('<thinking>') || !text.includes('</thinking>')) {
        return null;
    }

    const parts: MessagePart[] = [];
    const thinkingTagPattern = /<thinking>([\s\S]*?)<\/thinking>/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = thinkingTagPattern.exec(text)) !== null) {
        const textBefore = text.slice(lastIndex, match.index);
        if (textBefore.trim()) {
            parts.push({ text: stripWrappingBlankLines(textBefore) });
        }

        const thinkingText = stripWrappingBlankLines(match[1] || '');
        if (thinkingText) {
            parts.push({ thinking: thinkingText });
        }

        lastIndex = match.index + match[0].length;
    }

    const textAfter = text.slice(lastIndex);
    if (textAfter.trim()) {
        parts.push({ text: stripWrappingBlankLines(textAfter) });
    }

    return parts.length > 0 ? parts : null;
}

function formatMemoryBlock(filePath: string, agentName: string, kind: 'self' | 'inherited', content: string): string {
    return `\n<memory_file agent=${agentName}; ownership=${kind}; path=${filePath}>\n${content}\n</memory_file>`;
}

function escapeXmlText(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

export function normalizeSystemPromptFiles(value: unknown): string[] | undefined {
    if (Array.isArray(value)) {
        const normalized = value
            .filter((entry): entry is string => typeof entry === 'string')
            .map(entry => entry.trim())
            .filter(entry => entry.length > 0);
        return normalized;
    }

    if (typeof value === 'string') {
        const normalized = value
            .split(/[,\n]/)
            .map(entry => entry.trim())
            .filter(entry => entry.length > 0 && !entry.startsWith('#'));
        return normalized;
    }

    return undefined;
}

function expandHomePath(filePath: string): string {
    if (filePath === '~') {
        return process.env.HOME || filePath;
    }
    if (filePath.startsWith('~/') || filePath.startsWith('~\\')) {
        return path.join(process.env.HOME || '~', filePath.slice(2));
    }

    return filePath;
}

function resolveSystemPromptFilePath(agentName: string, fileReference: string): string {
    const expandedPath = expandHomePath(fileReference);
    if (path.isAbsolute(expandedPath)) {
        return path.resolve(expandedPath);
    }

    return path.resolve(getAgentDir(agentName), expandedPath);
}

async function appendConfiguredMemoryFiles(agentName: string, systemPromptFiles: string[]): Promise<string> {
    let combined = '';
    const restrictToAgentDir = sessionManager.isAgentIsolated(agentName);

    for (const fileReference of systemPromptFiles) {
        const filePath = resolveSystemPromptFilePath(agentName, fileReference);
        if (restrictToAgentDir) {
            checkPathAccess(filePath, agentName);
        }
        if (!await fs.pathExists(filePath)) {
            throw new Error(`systemPromptFiles entry \`${fileReference}\` not found for agent \`${agentName}\`.`);
        }

        const stats = await fs.stat(filePath);
        if (!stats.isFile()) {
            throw new Error(`systemPromptFiles entry \`${fileReference}\` is not a file.`);
        }

        const content = await fs.readFile(filePath, 'utf8');
        combined += formatMemoryBlock(filePath, agentName, 'self', content);
    }

    return combined;
}

async function appendSkillCatalogForAgent(agentName: string): Promise<string> {
    const visibleSkills = await listSkills({ agentName });
    if (visibleSkills.length === 0) {
        return '';
    }

    let combined = '';
    combined += 'The following skills provide specialized instructions for specific tasks.\n';
    combined += 'When a task matches a skill\'s description, call the load_skill tool\n';
    combined += 'with the skill\'s name to load its full instructions:\n';
    combined += '<available_skills>\n';

    for (const skill of visibleSkills) {
        combined += '  <skill>';
        combined += `    <name>${escapeXmlText(skill.name)}</name>`;
        combined += `    <description>${escapeXmlText(skill.description || '')}</description>`;
        combined += '</skill>\n';
    }

    combined += '</available_skills>\n';
    return combined;
}

async function appendDefaultMemoryFiles(agentName: string): Promise<string> {
    const mainMemoryDir = MAIN_AGENT_MEMORY_DIR;
    let combined = '';

    const mainSystemPath = path.join(mainMemoryDir, '00_SYSTEM.md');
    if (await fs.pathExists(mainSystemPath)) {
        const content = await fs.readFile(mainSystemPath, 'utf8');
        const kind = agentName === 'main' ? 'self' : 'inherited';
        combined += formatMemoryBlock(mainSystemPath, 'main', kind, content);
    }

    const inheritChain = sessionManager.getAgentInheritanceChain(agentName);
    for (const inheritedAgentName of inheritChain) {
        const kind = inheritedAgentName === agentName ? 'self' : 'inherited';
        combined += await appendMemoryFilesForAgent(inheritedAgentName, kind);
    }

    return combined;
}

export async function buildSessionSystemPromptSnapshot(options: {
    agentName?: string;
    systemPromptFiles?: string[] | string;
} = {}): Promise<string> {
    const agentName = options.agentName || 'main';
    const normalizedSystemPromptFiles = normalizeSystemPromptFiles(options.systemPromptFiles);
    const hasCustomMemorySources = options.systemPromptFiles !== undefined;

    const memoryBlocks = hasCustomMemorySources
        ? await appendConfiguredMemoryFiles(agentName, normalizedSystemPromptFiles || [])
        : await appendDefaultMemoryFiles(agentName);
    const skillCatalog = await appendSkillCatalogForAgent(agentName);
    const agentMemoryDir = getAgentMemoryDir(agentName);
    const dirInfo = '\n\n--- DIRECTORIES ---\n- agent_memory: ' + agentMemoryDir + '\n- agent_folder: ' + getAgentDir(agentName) + '\n';
    const archiveInfo = '\n\n--- COMPACTED HISTORY ACCESS ---\n- Use `get_context_archive(...)` for the normal archived-history entry point.\n- If you specifically need raw-message or block-level archive helpers, use `search_tools(...)` and then `call_tool(...)`.\n';
    return [memoryBlocks.trim(), skillCatalog.trim(), `${dirInfo}${archiveInfo}`.trim()]
        .filter(Boolean)
        .join('\n\n');
}

function buildInvalidToolArgsResult(call: FunctionCall): { error: { type: string; message: string } } {
    // Do NOT send rawArgsText in the tool response — the call's arguments
    // already carry it, so no need to duplicate.
    return {
        error: {
            type: 'invalid_tool_arguments',
            message: call.argsParseError || 'Invalid tool arguments JSON',
        }
    };
}

function normalizeRequestedNode(nodeParam: unknown, currentNode: string): string {
    if (nodeParam === undefined || nodeParam === null) {
        return currentNode;
    }

    if (typeof nodeParam !== 'string') {
        return String(nodeParam) || currentNode;
    }

    const trimmed = nodeParam.trim();
    if (!trimmed) {
        return currentNode;
    }

    if (trimmed.toLowerCase() === 'current') {
        return currentNode;
    }

    return trimmed;
}

async function appendMemoryFilesForAgent(agentName: string, kind: 'self' | 'inherited'): Promise<string> {
    const agentMemoryDir = getAgentMemoryDir(agentName);
    if (!await fs.pathExists(agentMemoryDir)) {
        return '';
    }

    const files = await fs.readdir(agentMemoryDir);
    const mdFiles = files.sort().filter(f => f.endsWith('.md') && f !== '00_SYSTEM.md');
    let combined = '';

    for (const file of mdFiles) {
        if (file.toLowerCase() === 'onboot.md') continue;
        const filePath = path.join(agentMemoryDir, file);
        const content = await fs.readFile(filePath, 'utf8');
        combined += formatMemoryBlock(filePath, agentName, kind, content);
    }

    return combined;
}


export async function getPersistentMemory(agentName: string = 'main') {
    try {
        return await buildSessionSystemPromptSnapshot({ agentName });
    } catch (e) {
        logger.error({ err: e, agentName }, 'Error reading persistent memory');
        return '';
    }
}

async function logRequest(data: any, iteration = 0): Promise<LlmInteractionLogFiles | null> {
    try {
        const timestamp = formatTime();
        const requestPath = await getRecentLogPath(LOGS_DIR, `${timestamp}_iter${iteration}_req.json`);
        await fs.writeJson(requestPath, data, { spaces: 2 });
        const responseFileName = `${timestamp}_iter${iteration}_res.json`;
        return {
            requestPath,
            responsePath: path.join(LOGS_DIR, 'recent', responseFileName),
        };
    } catch (e) {
        logger.error({ err: e }, 'Failed to log LLM interaction');
        return null;
    }
}

async function logResponse(data: any, logFiles: LlmInteractionLogFiles | null) {
    if (!logFiles) return;

    try {
        logFiles.responsePath = await getRecentLogPath(LOGS_DIR, path.basename(logFiles.responsePath));
        await fs.writeJson(logFiles.responsePath, data, { spaces: 2 });
    } catch (e) {
        logger.error({ err: e }, 'Failed to log LLM response');
    }
}

async function moveInteractionLogsToErrorDir(logFiles: LlmInteractionLogFiles | null) {
    if (!logFiles) return;
    await moveLogsToDateErrorDir(LOGS_DIR, [logFiles.requestPath, logFiles.responsePath]);
}

/**
 * Repair broken tool-call / tool-response adjacency after restart, manual edits,
 * or history compaction. We currently do three small repairs:
 * - insert placeholder tool responses when a model tool-call lost its tool message
 * - drop stray tool-response messages that no longer have a matching request nearby
 * - insert an interruption marker when a user/system turn arrives right after a tool message
 */
export function fixToolCalls(contents: Message[]): Message[] {
    const fixed = [];

    const isSkippableSystemInterruption = (message: Message | null | undefined): boolean => {
        if (!message || message.role !== 'user' || !message.parts?.length) return false;
        return message.parts.every((part: MessagePart) => {
            if (part.functionCall || part.functionResponse || part.inlineData || part.thinking) return false;
            if (part.system) return true;
            if (isSystemPayloadTextPart(part)) return true;
            return typeof part.text === 'string' && part.text.startsWith('[SYSTEM:');
        });
    };

    const hasNearbyToolCallRequest = (index: number): boolean => {
        for (let j = index - 1; j >= 0; j--) {
            const prev = contents[j];
            if (isSkippableSystemInterruption(prev)) {
                continue;
            }
            if (prev.role === 'model') {
                return !!prev.parts?.some((p: MessagePart) => p.functionCall);
            }
            return false;
        }
        return false;
    };

    const hasNearbyToolResponse = (index: number): boolean => {
        for (let j = index + 1; j < contents.length; j++) {
            const next = contents[j];
            if (isSkippableSystemInterruption(next)) {
                continue;
            }
            return next.role === 'tool';
        }
        return false;
    };
    
    for (let i = 0; i < contents.length; i++) {
        const msg = contents[i];
        fixed.push(msg);
        
        // Check if this is a model message with tool calls
        if (msg.role === 'model' && msg.parts) {
            const toolCalls = msg.parts.filter((p: MessagePart) => p.functionCall);
            
            if (toolCalls.length > 0) {
                const hasToolResponse = hasNearbyToolResponse(i);
                
                if (!hasToolResponse) {
                    // Missing tool response - insert one
                    // logger.warn({ messageIndex: i, toolCount: toolCalls.length }, 'Found unpaired tool calls, inserting placeholder responses');
                    
                    fixed.push({
                        role: 'tool',
                        parts: toolCalls.map((part: MessagePart) => ({
                            functionResponse: {
                                tool_use_id: part.functionCall!.id || 'unknown',
                                name: part.functionCall!.name,
                                response: {
                                    error: 'Tool output is lost due to agent restart or error'
                                }
                            }
                        })),
                        __meta: { timestamp: Date.now() }
                    });
                }
            }
        }

        // Drop tool-result messages that no longer have a matching tool-call request.
        // Allow pure system interruption messages in between, but do not keep a late
        // tool result after a real user/model turn boundary.
        if (msg.role === 'tool' && msg.parts) {
            const toolResponses = msg.parts.filter((p: MessagePart) => p.functionResponse);
            if (toolResponses.length > 0 && !hasNearbyToolCallRequest(i)) {
                logger.warn({ messageIndex: i, seq: msg.__meta?.seq }, 'Found unpaired tool responses, deleting');
                fixed.pop();
                continue;
            }
        }

    }
    
    return fixed as Message[];
}

/**
 * Convert internal message format to Anthropic/Minimax format
 * Internal format: { role: 'user'|'model'|'tool', parts: [{ text, functionCall, functionResponse }] }
 * Anthropic format: { role: 'user'|'assistant'|'user', content: string | array }
 */
function convertToAnthropicFormat(contents: Message[], config: ModelConfigEntry): AnthropicMessage[] {
    const anthropicMessages = [];
    
    for (const msg of contents) {
        let role = msg.role as AnthropicMessage['role'] | Message['role'];
        if (role === 'model') role = 'assistant';
        if (role === 'tool') role = 'user';

        let content = [];
        const imagePartsByToolUseId = new Map<string, MessagePart[]>();
        if (msg.role === 'tool') {
            for (const part of msg.parts || []) {
                if (!part.inlineData || !part.toolUseId) {
                    continue;
                }
                const grouped = imagePartsByToolUseId.get(part.toolUseId) || [];
                grouped.push(part);
                imagePartsByToolUseId.set(part.toolUseId, grouped);
            }
        }
        
        for (const part of msg.parts || []) {
            // Handle thinking (with signature support)
            if (part.thinking && part.providerMeta?.signature) {
                const thinkingBlock: AnthropicContentBlock = { type: 'thinking', thinking: part.thinking };
                thinkingBlock.signature = part.providerMeta?.signature;
                content.push(thinkingBlock);
            }

            // Handle system/meta parts by merging them back into user text for providers without developer messages
            if (part.system) {
                content.push({ type: 'text', text: `[SYSTEM: ${part.system}]` });
            }

            // Handle text
            if (part.text) {
                content.push({ type: 'text', text: part.text });
            }
            
            // Handle function call
            if (part.functionCall) {
                content.push({
                    type: 'tool_use',
                    id: part.functionCall.id || `tool_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                    name: part.functionCall.name,
                    input: part.functionCall.args || {}
                });
            }
            
            // Handle function response
            if (part.functionResponse) {
                const resp = part.functionResponse.response || {};
                const toolUseId = part.functionResponse.tool_use_id || part.toolUseId || 'unknown';
                const toolResult = {
                    type: 'tool_result',
                    tool_use_id: toolUseId,
                    content: appendImageGuidanceText(imagePartsByToolUseId.get(toolUseId) || [], formatToolResponsePayload(resp))
                };
                if (config.baseUrl?.startsWith('https://api.kimi.com/')) {
                    if (!content.find(x => x.type === 'thinking')) {
                        (toolResult as any).reasoning_content = '';
                    }
                }
                content.push(toolResult);
            }

            // Handle image data - convert internal format to Anthropic format
            if (part.inlineData) {
                content.push({
                    type: 'image',
                    source: {
                        type: 'base64',
                        media_type: part.inlineData.mimeType || part.inlineData.mime_type || 'image/jpeg',
                        data: part.inlineData.data
                    }
                });
            }
        }
        
        // Simplify: if only one text part, use string content
        const textOnly = content.length === 1 && content[0].type === 'text';
        if (textOnly) {
            content = (content[0] as any).text;
        }
        
        // Handle empty content
        if (content.length === 0) {
            content = (msg as any).content || ' ';
        }
        
        anthropicMessages.push({ role, content });
    }
    
    return anthropicMessages;
}

/**
 * Convert internal message format to OpenAI format
 * Internal format: { role: 'user'|'model'|'tool', parts: [{ text, thinking, functionCall, functionResponse }] }
 * OpenAI format: { role: 'user'|'assistant'|'tool', content: string | array, tool_calls?: array, reasoning_content?: string }
 */
/**
 * Convert internal message format to OpenAI Responses API input items.
 * - user messages => input_text / input_image message items
 * - assistant messages => output_text message items + function_call items
 * - tool messages => function_call_output items
 */
/**
 * Execute tools and return results as a single message with multiple parts
 */
export async function executeTools(functionCalls: FunctionCall[], toolContext: any, session: any): Promise<Message> {
    const parts = [];
    let stopCurrentTurn = false;
    let batchHasError = false;

    const normalizeToolResult = (rawResult: any): any => {
        if (rawResult === undefined) return { output: '(No output)' };
        if (rawResult === null) return { output: null };
        if (typeof rawResult === 'string' || typeof rawResult === 'number' || typeof rawResult === 'boolean') {
            return { output: rawResult };
        }
        if (typeof rawResult === 'object') {
            return rawResult;
        }
        return { output: String(rawResult) };
    };

    const consumeInlineData = async (result: any, toolId: string, fallbackLabel: string): Promise<any> => {
        if (!result || typeof result !== 'object') return result;

        const normalized = await normalizeToolResultImages(result, toolId, fallbackLabel);
        if (normalized.imageParts.length > 0) {
            parts.push(...normalized.imageParts);
        }

        return normalized.result;
    };

    const extractToolLoopControl = (result: any): any => {
        if (!result || typeof result !== 'object' || !result.__toolLoopControl || typeof result.__toolLoopControl !== 'object') {
            return result;
        }

        stopCurrentTurn = stopCurrentTurn || !!result.__toolLoopControl.stopCurrentTurn;
        const { __toolLoopControl, ...rest } = result;
        return rest;
    };

    const hasToolResponseError = (result: any): boolean => {
        if (!result || typeof result !== 'object') {
            return false;
        }
        return result.error !== undefined && result.error !== null;
    };
    
    for (const call of functionCalls) {
        const toolFn = (tools as any)[call.name];
        const toolId = call.id || `tool_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        // Log what's being executed
        let argStr = '';
        if (call.argsParseError && typeof call.rawArgsText === 'string') {
            argStr = call.rawArgsText;
        } else if (call.name === 'exec') {
            argStr = call.args.command;
        } else if (call.name === 'edit' || call.name === 'write' || call.name === 'edit_memory' || call.name === 'write_memory' || call.name === 'delete_memory') {
            argStr = call.args.filePath;
        } else if (call.name === 'apply_patch' || call.name === 'apply_patch_memory') {
            argStr = typeof call.args.input === 'string' ? call.args.input : '';
        } else if (call.name === 'read' || call.name === 'read_memory') {
            const { filePath, startLine, endLine } = call.args;
            argStr = filePath + (startLine ? ` (lines ${startLine}-${endLine})` : '');
        } else if (call.args) {
            const keys = Object.keys(call.args);
            if (keys.length === 1) {
                const value = call.args[keys[0]];
                // If value is object, stringify it
                argStr = typeof value === 'object' ? JSON.stringify(value) : value;
            } else {
                argStr = keys.map(key => {
                    const value = call.args[key];
                    const valueStr = typeof value === 'object' ? JSON.stringify(value) : value;
                    return `${key}: ${valueStr}`;
                }).join('\n');
            }
        }
        if (argStr.length > 200) argStr = argStr.substring(0, 197) + '...';
        logger.info({ tool: call.name, args: argStr }, 'Executing tool');
        if (toolContext.broadcast && session.verbose) {
            // Exclude webui as it gets updates via onHistoryUpdate
            toolContext.broadcast(`🛠 *[${call.name}]*: \`${argStr}\``, { excludePlatforms: ['webui'] });
        }

        let result;
        if (call.argsParseError) {
            result = buildInvalidToolArgsResult(call);
        }
        
        const toolDefinition = tools.definitions.find((def: any) => def.name === call.name);
        const supportsExplicitNode = Object.prototype.hasOwnProperty.call(toolDefinition?.parameters?.properties || {}, 'node');
        const nodeParam = supportsExplicitNode ? call.args?.node : undefined;
        const sessionId = toolContext.sessionId || 'main';
        
        // Get current node for this session
        const currentNode = await nodesManager.getCurrentNode(sessionId) || 'master';
        
        // Determine target node: explicit node param > current node > master.
        const targetNode = normalizeRequestedNode(nodeParam, currentNode);
        
        // Remove node parameter from args before execution
        const toolArgs = { ...call.args };
        if (supportsExplicitNode) {
            delete toolArgs.node;
        }
        
        // Tools that must run on master because they depend on host-local
        // session/channel/agent/vector/MCP state rather than remote node files.
        const forceMaster = tools.isMasterOnlyToolName(call.name);
        const executionNode = forceMaster ? 'master' : targetNode;
        const permissionNode = tools.getToolPermissionNode(call.name, executionNode, targetNode);

        // Check isolated session tool permission (includes path access check for master)
        try {
            if (!result?.error) {
                await checkToolPermission(call.name, sessionId, permissionNode, toolArgs);
            }
        } catch (e: any) {
            result = { error: e.message || String(e) };
        }
        
        if (result?.error) {
            // Skip tool execution if permission check failed
        } else {
        
        if (executionNode !== 'master') {
            // Execute on remote node
            try {
                result = normalizeToolResult(await nodesManager.executeTool(executionNode, call.name, toolArgs, sessionId));
            } catch (e: any) {
                result = { error: e.message || String(e) };
            }
        } else if (toolFn) {
            // Execute locally on master
            const localToolContext = call.name === 'send_file' || call.name === 'image_write_to_file'
                ? { ...toolContext, runtimeNodeId: targetNode }
                : toolContext;
            try {
                result = normalizeToolResult(await toolFn(toolArgs, localToolContext));
            } catch (e: any) {
                result = { error: e?.message || String(e) };
            }
        } else {
            result = { error: `Unknown tool: ${call.name}` };
        }
        } // End if (result?.error)

        result = extractToolLoopControl(result);
        result = await consumeInlineData(result, toolId, `[Inline data returned by ${call.name}]`);
        result = await guardToolOutputForModel(result, {
            sessionId,
            session,
            toolName: call.name,
            toolUseId: toolId,
            nodeId: executionNode,
        });

        batchHasError = batchHasError || hasToolResponseError(result);
        
        parts.push({
            functionResponse: {
                tool_use_id: toolId,
                name: call.name,
                response: result
            }
        });
    }
    
    const toolMessage: Message = {
        role: 'tool',
        parts: parts
    };

    if (stopCurrentTurn && !batchHasError) {
        (toolMessage as any).__toolLoopControl = { stopCurrentTurn: true };
    } else if (stopCurrentTurn && batchHasError) {
        logger.debug({ sessionId: toolContext.sessionId || session?.id, toolCount: functionCalls.length }, 'Suppressing stopCurrentTurn because a tool in the batch returned an error');
    }

    return toolMessage;
}

/**
 * Call LLM and handle tool calls
 */
/**
 * Call LLM once (single API call, no recursion)
 * Returns response with tool calls if any
 */
export async function chat(
    parts: MessagePart[] | null, 
    session: Session,
    iteration = 0,
    options?: {
        toolDefinitions?: ToolDefinition[];
        appendMessage?: (message: Message) => Promise<void>;
        notifySessionEvents?: boolean;
        registerAbortController?: boolean;
    },
): Promise<ChatResult> {
    const appendMessage = async (message: Message) => {
        if (options?.appendMessage) {
            await options.appendMessage(message);
            return;
        }
        await sessionManager.appendSessionMessage(session, message);
    };

    const appendTerminalModelTextAndReturn = async (text: string): Promise<ChatResult> => {
        await appendMessage({
            role: 'model',
            parts: [{ text }],
        });

        return { text };
    };

    // Get persistent context
    const agentName = session.agent || 'main';
    const systemPrompt = session.persistentMemorySnapshot || await buildSessionSystemPromptSnapshot({
        agentName,
        systemPromptFiles: session.systemPromptFiles,
    });

    // Add user message if provided
    if (parts) {
        const messageParts = typeof parts === 'string' ? [{ text: parts }] : parts;
        const newMessage: Message = { role: 'user', parts: messageParts };
        await appendMessage(newMessage);
    }
    
    // Convert to appropriate format based on provider
    const contentsForLlm = session.history
        .filter(isModelVisibleMessage)
        .map(({ __meta, ...msg }: Message) => msg);
    const availableToolDefinitions = options?.toolDefinitions
        ?? tools.modelFacingDefinitions;
    const result = await requestLlmOnce({
        contents: contentsForLlm,
        systemPrompt,
        model: session.model,
        sessionId: session.id,
        promptCacheKey: getPromptCacheKey(session),
        iteration,
        toolDefinitions: availableToolDefinitions,
        notifySessionEvents: options?.notifySessionEvents,
        registerAbortController: options?.registerAbortController,
    });

    if (result.usage) {
        logger.info(`Token Usage: Cached: ${result.usage.cachedTokens || 0} | Input: ${result.usage.inputTokens} | Output: ${result.usage.outputTokens} | Calls: ${(result.toolCalls || []).length}`);

        // Update session accumulated usage stats
        session.stats.totalInputTokens += result.usage.inputTokens || 0;
        session.stats.totalCachedTokens += result.usage.cachedTokens || 0;
        session.stats.totalOutputTokens += result.usage.outputTokens || 0;
    }

    // Add assistant message to history
    if (result.allParts && result.allParts.length > 0) {
        const assistantMsg: Message = {
            role: 'model',
            parts: result.allParts
        };
        await appendMessage(assistantMsg);
    }

    return result;
}

export async function requestLlmOnce(options: RequestLlmOnceOptions): Promise<ChatResult> {
    const fixedContents = fixToolCalls(options.contents || []);
    let messages, url, headers, data;

    const resolvedModel = resolveModelConfig(options.model);
    const modelEntry = options.modelEntryOverride || resolvedModel.modelEntry;
    const modelKey = options.modelEntryOverride
        ? `${options.modelEntryOverride.providerKey || 'setup'}/${options.modelEntryOverride.model || 'model'}`
        : resolvedModel.currentKey;
    const providerType = modelEntry?.providerType || 'openai';
    const baseUrl = modelEntry?.baseUrl;
    const apiKey = modelEntry?.apiKey || '';
    const modelName = modelEntry?.model || '';
    const promptCacheKey = options.promptCacheKey || getPromptCacheKeyForSessionId(options.sessionId);
    const openaiRequestApi = getOpenAIRequestApi(providerType);
    const useOpenAIResponsesApi = openaiRequestApi === 'responses';
    const useOpenAIChatCompletionsApi = openaiRequestApi === 'chat-completions';

    if (!baseUrl) {
        throw new Error('Model config has no baseUrl');
    }

    const iteration = options.iteration || 0;
    logger.info(`Requesting LLM (${modelKey}, type ${providerType}, iteration ${iteration})...`);

    const useStreamingApi = useOpenAIResponsesApi || useOpenAIChatCompletionsApi;
    const availableToolDefinitions = options.toolDefinitions ?? [];
    const openaiEffort = THINKING_BUDGET >= 6000 ? 'xhigh' :
                         THINKING_BUDGET >= 4000 ? 'high' :
                         THINKING_BUDGET >= 2000 ? 'medium' :
                         THINKING_BUDGET > 0 ? 'low'
                         : undefined;

    if (useOpenAIResponsesApi) {
        messages = convertToOpenAIResponsesFormatProvider(fixedContents);
        url = `${baseUrl}/responses`;
        headers = {
            'Content-Type': 'application/json',
            ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}),
            'user-agent': 'codex-tui/0.118.0 (Debian 13.0.0; x86_64) xterm.js_6.1.0-beta.191_ (codex-tui; 0.118.0)',
            'originator': 'codex-tui',
            'x-codex-turn-metadata': `{"session_id":"${promptCacheKey}","turn_id":"${
                crypto.createHash('md5').update(`turn_id_${options.sessionId || 'default'}_${Date.now()}`).digest('hex')
            }","sandbox":"seccomp"}`,
            'x-client-request-id': crypto.createHash('md5').update(`req_id_${options.sessionId || 'default'}_${Date.now()}`).digest('hex'),
        };

        data = {
            model: modelName,
            instructions: options.systemPrompt,
            input: [
                ...messages
            ],
            tools: availableToolDefinitions.length > 0 ? availableToolDefinitions.map(fd => ({
                type: 'function',
                name: fd.name,
                description: fd.description,
                parameters: fd.parameters
            })) : undefined,
            tool_choice: 'auto',
            parallel_tool_calls: true,
            reasoning: {
                summary: 'auto',
                ...(openaiEffort ? { effort: openaiEffort } : {}),
            },
            store: false,
            include: ['reasoning.encrypted_content'],
            prompt_cache_key: promptCacheKey,
            stream: true,
        };
    } else if (useOpenAIChatCompletionsApi) {
        messages = convertToOpenAIFormatProvider(fixedContents);
        url = `${baseUrl}/chat/completions`;
        headers = {
            'Content-Type': 'application/json',
            ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}),
            'user-agent': 'foxwarm/1.0',
        };

        data = {
            model: modelName,
            max_tokens: MAX_OUTPUT,
            prompt_cache_key: promptCacheKey,
            reasoning_effort: openaiEffort,
            stream: true,
            stream_options: { include_usage: true },
            messages: [
                { role: 'system', content: options.systemPrompt },
                ...messages
            ],
            tools: availableToolDefinitions.length > 0 ? availableToolDefinitions.map(fd => ({
                type: 'function',
                function: {
                    name: fd.name,
                    description: fd.description,
                    parameters: fd.parameters
                }
            })) : undefined
        };
    } else {
        messages = convertToAnthropicFormat(fixedContents, modelEntry);
        url = `${baseUrl}/v1/messages`;
        headers = {
            'Content-Type': 'application/json',
            ...(apiKey ? { 'x-api-key': apiKey } : {}),
            'anthropic-version': '2023-06-01',
            'anthropic-beta': 'interleaved-thinking-2025-05-14',
            'user-agent': 'foxwarm/1.0',
        };

        data = {
            model: modelName,
            max_tokens: MAX_OUTPUT,
            thinking: THINKING_BUDGET ? { type: "enabled", budget_tokens: THINKING_BUDGET } : undefined,
            system: options.systemPrompt,
            messages: messages,
            tools: availableToolDefinitions.length > 0 ? availableToolDefinitions.map(fd => ({
                name: fd.name,
                description: fd.description,
                input_schema: fd.parameters
            })) : undefined
        };
    }

    const extraFields = modelEntry.extraFields || {};
    Object.assign(data, extraFields);
    if (useOpenAIResponsesApi && extraFields.reasoning && typeof extraFields.reasoning === 'object') {
        const { reasoning: extraReasoning } = extraFields;
        const hasSummaryOverride = Object.prototype.hasOwnProperty.call(extraReasoning, 'summary');
        data.reasoning = {
            ...(data.reasoning || {}),
            ...extraReasoning,
            summary: hasSummaryOverride
                ? extraReasoning.summary
                : ((data.reasoning as any)?.summary || 'auto'),
        };
    }

    const sanitizedRequestPayload = sanitizeProviderRequestPayload(data);
    if (sanitizedRequestPayload.replacementCount > 0) {
        data = sanitizedRequestPayload.value;
        logger.warn({
            replacementCount: sanitizedRequestPayload.replacementCount,
            paths: sanitizedRequestPayload.paths.slice(0, 20),
            omittedPathCount: Math.max(0, sanitizedRequestPayload.paths.length - 20),
            providerType,
            modelKey,
            sessionId: options.sessionId,
        }, 'Sanitized lone surrogate code units from provider request payload');
    }

    const logFiles = await logRequest(data, iteration);
    const responseAttempts: any[] = [];
    const returnWithLoggedFailure = async (text: string): Promise<ChatResult> => {
        await moveInteractionLogsToErrorDir(logFiles);
        return {
            text,
            allParts: [{ text }],
        };
    };

    let response: AxiosResponse;
    let resp: any;
    const maxRetries = Math.max(1, options.maxRetries ?? 3);
    const abortController = new AbortController();
    const shouldRegisterAbortController = options.registerAbortController !== false && !!options.sessionId;
    const shouldNotifySessionEvents = options.notifySessionEvents !== false && !!options.sessionId;

    if (shouldRegisterAbortController) {
        sessionManager.registerSessionAbortController(options.sessionId!, abortController);
    }
    if (shouldNotifySessionEvents) {
        sessionManager.notifySessionEvent(options.sessionId!, { type: 'reasoning-summary-reset' });
    }

    try {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                response = await axios.post(url, data, {
                    headers: { ...headers, ...(modelEntry.extraHeaders || {}) },
                    timeout: options.timeoutMs ?? 180000,
                    validateStatus: () => true,
                    signal: abortController.signal,
                    ...(useStreamingApi ? { responseType: 'stream' as const } : {}),
                });

                if (useStreamingApi) {
                    if (response.status !== 200) {
                        const errorBody = await readStreamAsText(response.data, abortController.signal);
                        await logResponse({
                            status: response.status + ' ' + response.statusText,
                            headers: response.headers,
                            body: errorBody
                        }, logFiles);
                        logger.error({
                            status: response.status + ' ' + response.statusText,
                            headers: response.headers,
                            body: errorBody
                        }, `LLM API Error (Attempt ${attempt}/${maxRetries})`);
                        if (attempt === maxRetries) {
                            return returnWithLoggedFailure(`Error: API request failed after ${maxRetries} attempts`);
                        }
                        await sleepWithSignal(5000, abortController.signal);
                        continue;
                    }

                    if (useOpenAIResponsesApi) {
                        resp = await collectOpenAIResponsesStreamProvider(response.data, abortController.signal, {
                            onReasoningSummary: shouldNotifySessionEvents
                                ? (text) => {
                                    sessionManager.notifySessionEvent(options.sessionId!, {
                                        type: 'reasoning-summary',
                                        text,
                                    });
                                }
                                : () => {},
                        });
                    } else {
                        resp = await collectOpenAIChatCompletionsStreamProvider(response.data, abortController.signal);
                    }

                    await logResponse({
                        status: response.status + ' ' + response.statusText,
                        headers: response.headers,
                        body: resp
                    }, logFiles);
                } else {
                    resp = response.data;
                    await logResponse({
                        status: response.status + ' ' + response.statusText,
                        headers: response.headers,
                        body: resp
                    }, logFiles);
                }

                if (response.status !== 200) {
                    logger.error({
                        status: response.status + ' ' + response.statusText,
                        headers: response.headers,
                        body: resp
                    }, `LLM API Error (Attempt ${attempt}/${maxRetries})`);
                    if (attempt === maxRetries) {
                        return returnWithLoggedFailure(`Error: API request failed after ${maxRetries} attempts`);
                    }
                    await sleepWithSignal(2000, abortController.signal);
                    continue;
                }
                break;
            } catch (e: any) {
                if (isAbortError(e)) {
                    responseAttempts.push({
                        attempt,
                        kind: 'abort',
                        error: e?.message || String(e),
                        code: e?.code,
                        name: e?.name,
                    });
                    await logResponse({ attempts: responseAttempts }, logFiles);
                    await moveInteractionLogsToErrorDir(logFiles);
                    throw e;
                }

                responseAttempts.push({
                    attempt,
                    kind: 'network-error',
                    error: e?.message || String(e),
                    code: e?.code,
                    name: e?.name,
                });
                await logResponse({ attempts: responseAttempts }, logFiles);
                logger.error({ status: (e as AxiosResponse)?.status }, `LLM API Network Error (Attempt ${attempt}/${maxRetries})`);
                if (attempt === maxRetries) {
                    return returnWithLoggedFailure(`Error: API request failed after ${maxRetries} attempts: ${e?.message || e}`);
                }
                await sleepWithSignal(2000, abortController.signal);
            }
        }
    } finally {
        if (shouldRegisterAbortController) {
            sessionManager.clearSessionAbortController(options.sessionId!, abortController);
        }
    }

    let responseText = '';
    const allParts: Message['parts'] = [];

    if (useOpenAIResponsesApi) {
        const outputItems = Array.isArray(resp.output) ? resp.output : [];

        if (outputItems.length === 0) {
            return returnWithLoggedFailure('Error: No response from OpenAI Responses API');
        }

        for (const item of outputItems) {
            if (item.type === 'reasoning') {
                const summaryText = Array.isArray(item.summary)
                    ? item.summary
                        .map((entry: any) => entry?.text || entry?.summary || '')
                        .filter(Boolean)
                        .join('\n')
                    : '';
                allParts.push({
                    thinking: summaryText,
                    providerMeta: {
                        thinkingSummaries: item.summary?.map((x: any) => x.text),
                        encryptedThinking: item.encrypted_content,
                    },
                });
                continue;
            }

            if (item.type === 'message' && item.role === 'assistant') {
                for (const contentPart of item.content || []) {
                    if (contentPart.type === 'output_text' && contentPart.text) {
                        responseText += contentPart.text;
                        allParts.push({ text: contentPart.text });
                    } else if (contentPart.type === 'refusal' && contentPart.refusal) {
                        responseText += contentPart.refusal;
                        allParts.push({ text: contentPart.refusal });
                    }
                }
                continue;
            }

            if (item.type === 'function_call') {
                const parsedArgs = parseFunctionCallArgs(item.arguments);
                const callId = item.call_id || item.id;
                if (parsedArgs.argsParseError) {
                    logger.warn({ providerType, callId, toolName: item.name, rawArgsText: parsedArgs.rawArgsText }, 'Failed to parse OpenAI Responses tool arguments; converting to structured tool error');
                }
                allParts.push({
                    functionCall: {
                        id: callId,
                        name: item.name,
                        ...parsedArgs,
                    }
                });
            }
        }
    } else if (useOpenAIChatCompletionsApi) {
        const choice = resp.choices?.[0];
        if (!choice) {
            return {
                text: 'Error: No response from OpenAI API',
                allParts: [{ text: 'Error: No response from OpenAI API' }],
            };
        }

        const message = choice.message;

        if (message.reasoning_content) {
            logger.info({ reasoningLength: message.reasoning_content.length }, 'Received reasoning content from OpenAI');
            allParts.push({ thinking: message.reasoning_content });
        }

        if (message.content) {
            responseText = message.content;
            allParts.push({ text: message.content });
        }

        if (message.tool_calls) {
            for (const toolCall of message.tool_calls) {
                if (toolCall.type === 'function') {
                    const parsedArgs = parseFunctionCallArgs(toolCall.function.arguments);
                    if (parsedArgs.argsParseError) {
                        logger.warn({ providerType, callId: toolCall.id, toolName: toolCall.function.name, rawArgsText: parsedArgs.rawArgsText }, 'Failed to parse OpenAI chat tool arguments; converting to structured tool error');
                    }
                    allParts.push({
                        functionCall: {
                            id: toolCall.id,
                            name: toolCall.function.name,
                            ...parsedArgs,
                        }
                    });
                }
            }
        }
    } else {
        if (resp.content) {
            for (const rawBlock of resp.content) {
                const block = rawBlock as AnthropicContentBlock;
                if (block.type === 'text') {
                    const extractedParts = block.text ? extractAnthropicThinkingTaggedParts(block.text) : null;
                    if (extractedParts) {
                        for (const part of extractedParts) {
                            if (part.text) {
                                responseText += part.text;
                            }
                            allParts.push(part);
                        }
                    } else {
                        responseText += block.text;
                        allParts.push({ text: block.text });
                    }
                } else if (block.type === 'thinking') {
                    const thinkingPart: MessagePart = { thinking: block.thinking };
                    if (block.signature) {
                        thinkingPart.providerMeta = { signature: block.signature };
                    }
                    allParts.push(thinkingPart);
                } else if (block.type === 'tool_use') {
                    allParts.push({ functionCall: { id: block.id, name: block.name, args: block.input } });
                }
            }
        }
    }

    let usage: TokenUsage = null;
    if (useOpenAIResponsesApi) {
        const cached = resp.usage?.input_tokens_details?.cached_tokens || 0;
        usage = resp.usage ? {
            inputTokens: resp.usage.input_tokens - cached,
            outputTokens: resp.usage.output_tokens,
            cachedTokens: cached
        } : null;
    } else if (useOpenAIChatCompletionsApi) {
        usage = resp.usage ? {
            inputTokens: resp.usage.prompt_tokens,
            outputTokens: resp.usage.completion_tokens,
            cachedTokens: 0
        } : null;
    } else {
        usage = resp.usage ? {
            inputTokens: resp.usage.input_tokens,
            outputTokens: resp.usage.output_tokens,
            cachedTokens: resp.usage.cache_read_input_tokens || 0
        } : null;
    }

    const toolCalls = allParts.filter(x => x.functionCall).map(x => x.functionCall);

    return {
        text: responseText,
        usage,
        toolCalls,
        allParts: allParts.length > 0 ? allParts : undefined,
    };
}
