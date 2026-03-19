import axios, { AxiosResponse } from 'axios';
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
import { loadSkillDocuments } from './skills';
import { checkToolPermission, checkPathAccess } from './isolatedCheck';
import {
    collectOpenAIChatCompletionsStream as collectOpenAIChatCompletionsStreamProvider,
    collectOpenAIResponsesStream as collectOpenAIResponsesStreamProvider,
    convertToOpenAIFormat as convertToOpenAIFormatProvider,
    convertToOpenAIResponsesFormat as convertToOpenAIResponsesFormatProvider,
} from './llmProviders/openai';

type LlmInteractionLogFiles = {
    requestPath: string;
    responsePath: string;
};

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
    return `${session.id || 'default'}`;
}

function isOpenAIReasoningModel(modelName: string): boolean {
    return /^gpt-5(?:[.-]|$)/.test(modelName)
        || /^o[1-9](?:[.-]|$)/.test(modelName);
}

function shouldUseOpenAIResponsesApi(providerType: string, modelName: string): boolean {
    return providerType === 'openai-responses'
        || (providerType === 'openai' && isOpenAIReasoningModel(modelName));
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
    return `\nFILE: ${filePath}\n[MEMORY: agent=${agentName}; ownership=${kind}]\n${content}\n`;
}

function formatSkillBlock(filePath: string, skillName: string, content: string): string {
    return `\nFILE: ${filePath}\n[SKILL: ${skillName}]\n${content}\n`;
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

    if (Object.prototype.hasOwnProperty.call(response, 'error')) {
        return response.error;
    }

    return response;
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

async function appendSkillFilesForAgent(agentName: string): Promise<string> {
    const skills = sessionManager.getAgentSkills(agentName);
    if (skills.length === 0) {
        return '';
    }

    let combined = '';
    for (const skillName of skills) {
        try {
            const { documents } = await loadSkillDocuments(skillName, { agentName });
            for (const document of documents) {
                combined += formatSkillBlock(document.filePath, skillName, document.content);
            }
        } catch (e) {
            logger.warn({ err: e, agentName, skillName }, 'Failed to load skill documents for prompt injection');
        }
    }

    return combined;
}

export async function getPersistentMemory(agentName: string = 'main') {
    try {
        const agentMemoryDir = getAgentMemoryDir(agentName);
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

        combined += await appendSkillFilesForAgent(agentName);

        const dirInfo = '\n\n--- DIRECTORIES ---\n- agent_memory: ' + agentMemoryDir + '\n- agent_folder: ' + getAgentDir(agentName) + '\n';
        return combined.trim() + dirInfo;
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
 * Check and fix unpaired tool calls (missing responses)
 * This can happen after agent restart
 * 
 * Also fix user/system inserted messages between tool calls, insert a dummy message.
 * This fix some kv cache problem.
 */
export function fixToolCalls(contents: Message[]): Message[] {
    const fixed = [];
    
    for (let i = 0; i < contents.length; i++) {
        const msg = contents[i];
        fixed.push(msg);
        
        // Check if this is a model message with tool calls
        if (msg.role === 'model' && msg.parts) {
            const toolCalls = msg.parts.filter((p: MessagePart) => p.functionCall);
            
            if (toolCalls.length > 0) {
                // Check if next message is a tool response
                const nextMsg = i + 1 < contents.length ? contents[i + 1] : null;
                const hasToolResponse = nextMsg && nextMsg.role === 'tool';
                
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

        if (msg.role === 'user') {
            if (contents[i - 1]?.role === 'tool') {
                fixed.splice(fixed.length - 1, 0, {
                    role: 'model',
                    parts: [
                        { text: '[interrupted by user/system event]' },
                    ],
                });
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
                const output = extractToolResponseOutput(resp);
                const toolResult = {
                    type: 'tool_result',
                    tool_use_id: part.functionResponse.tool_use_id || part.toolUseId || 'unknown',
                    content: stringifyToolOutput(output)
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

    const consumeInlineData = (result: any, toolId: string, fallbackLabel: string): any => {
        if (!result || typeof result !== 'object') return result;

        const inlineItems = [
            ...(result.inlineData ? [result.inlineData] : []),
            ...(Array.isArray(result.inlineDataItems) ? result.inlineDataItems : []),
        ].filter((item: any) => item?.data);

        if (inlineItems.length === 0) return result;

        for (const item of inlineItems) {
            parts.push({
                toolUseId: toolId,
                inlineData: {
                    data: item.data,
                    mimeType: item.mimeType || item.mime_type || 'application/octet-stream'
                }
            });
        }

        const { inlineData, inlineDataItems, ...rest } = result;
        if (rest.output === undefined) {
            rest.output = fallbackLabel;
        }
        return rest;
    };

    const extractToolLoopControl = (result: any): any => {
        if (!result || typeof result !== 'object' || !result.__toolLoopControl || typeof result.__toolLoopControl !== 'object') {
            return result;
        }

        stopCurrentTurn = stopCurrentTurn || !!result.__toolLoopControl.stopCurrentTurn;
        const { __toolLoopControl, ...rest } = result;
        return rest;
    };
    
    for (const call of functionCalls) {
        const toolFn = (tools as any)[call.name];
        const toolId = call.id || `tool_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        // Log what's being executed
        let argStr = '';
        if (call.name === 'exec') {
            argStr = call.args.command;
        } else if (call.name === 'edit' || call.name === 'write') {
            argStr = call.args.filePath;
        } else if (call.name === 'read') {
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
        
        // Check if tool has node parameter
        const nodeParam = call.args?.node;
        const sessionId = toolContext.sessionId || 'main';
        
        // Get current node for this session
        const currentNode = await nodesManager.getCurrentNode(sessionId) || 'master';
        
        // Determine target node: explicit node param > current node > master.
        const targetNode = normalizeRequestedNode(nodeParam, currentNode);
        
        // Remove node parameter from args before execution
        const toolArgs = { ...call.args };
        delete toolArgs.node;
        
        // Tools that must run on master because they depend on host-local
        // session/channel/agent/vector/MCP state rather than remote node files.
        const masterOnlyTools = [
            'remote_node', 'list_nodes', 'node_tools',
            'search_memory', 'get_memory_context',
            'list_files', 'delete_file',
            'copy_between_nodes',
            'create_child_session', 'send_to_session', 'send_to_channel', 'send_file',
            'list_sessions', 'list_agents', 'list_skills',
            'attach_agent_skill', 'detach_agent_skill', 'load_skill',
            'get_session_messages', 'get_archived_messages', 'get_archived_blocks', 'delete_session',
            'update_session_name', 'set_todo', 'update_session_snapshot', 'stop_session',
            'compact_session', 'compress_session',
            'create_timer', 'list_timers', 'delete_timer',
            'mcp_config', 'call_mcp', 'search_mcp_tools',
            'change_current_node',
            'create_agent', 'create_session', 'set_agent_inherit', 'set_agent_isolated', 'move_session',
        ];
        const forceMaster = masterOnlyTools.includes(call.name);
        const executionNode = forceMaster ? 'master' : targetNode;

        // Check isolated session tool permission (includes path access check for master)
        try {
            await checkToolPermission(call.name, sessionId, executionNode, toolArgs);
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
            try {
                result = normalizeToolResult(await toolFn(toolArgs, toolContext));
            } catch (e: any) {
                result = { error: e?.message || String(e) };
            }
        } else {
            result = { error: `Unknown tool: ${call.name}` };
        }
        } // End if (result?.error)

        result = extractToolLoopControl(result);
        result = consumeInlineData(result, toolId, `[Inline data returned by ${call.name}]`);

        // Backward-compat fallback for older tools/nodes still returning marker strings.
        if (result && typeof result.output === 'string') {
            const output = result.output;

            if (output.startsWith('__IMAGE__:')) {
                const [, mimeType, base64] = output.split(':', 3);
                parts.push({
                    toolUseId: toolId,
                    inlineData: { data: base64, mimeType }
                });
                result = { ...result, output: `[Image loaded: ${call.args.filePath || 'file'}]` };
            } else if (output.startsWith('__SCREENSHOT__:')) {
                const base64 = output.substring('__SCREENSHOT__:'.length);
                parts.push({
                    toolUseId: toolId,
                    inlineData: { data: base64, mimeType: 'image/png' }
                });
                result = { ...result, output: `[Screenshot of ${call.args.tabId || 'page'}]` };
            }
        }
        
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

    if (stopCurrentTurn) {
        (toolMessage as any).__toolLoopControl = { stopCurrentTurn: true };
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
    const systemPrompt = session.persistentMemorySnapshot || await getPersistentMemory(agentName);

    // Add user message if provided
    if (parts) {
        const messageParts = typeof parts === 'string' ? [{ text: parts }] : parts;
        const newMessage: Message = { role: 'user', parts: messageParts };
        await appendMessage(newMessage);
    }
    
    // Convert to appropriate format based on provider
    const contentsForLlm = session.history.map(({ __meta, ...msg }: Message) => msg);
    const fixedContents = fixToolCalls(contentsForLlm);
    
    let messages, url, headers, data;

    const { modelEntry, currentKey: modelKey } = resolveModelConfig(session.model);

    const providerType = modelEntry?.provider || 'openai';
    const baseUrl = modelEntry?.baseUrl;
    const apiKey = modelEntry?.apiKey || '';
    const modelName = Array.isArray(modelEntry?.model)
        ? (modelEntry.model[0] || '')
        : (modelEntry?.model || '');
    const promptCacheKey = getPromptCacheKey(session);

    if (!baseUrl) {
        throw new Error('Model config has no baseUrl');
    }

    logger.info(`Requesting LLM (${modelKey}, type ${providerType}, iteration ${iteration})...`);

    const useOpenAIResponsesApi = shouldUseOpenAIResponsesApi(providerType, modelName);
    const useOpenAIChatStream = providerType === 'openai';
    const useStreamingApi = useOpenAIResponsesApi || useOpenAIChatStream;
    const availableToolDefinitions = options?.toolDefinitions ?? tools.definitions;

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
            'Authorization': `Bearer ${apiKey}`,
            'user-agent': 'foxwarm/1.0',
        };

        data = {
            model: modelName,
            include: ['reasoning.encrypted_content'],
            max_output_tokens: MAX_OUTPUT,
            prompt_cache_key: promptCacheKey,
            stream: true,
            reasoning: {
                summary: 'auto',
                ...(openaiEffort ? { effort: openaiEffort } : {}),
            },
            input: [
                {
                    type: 'message',
                    role: 'developer',
                    content: [{ type: 'input_text', text: systemPrompt }]
                },
                ...messages
            ],
            tools: availableToolDefinitions.length > 0 ? availableToolDefinitions.map(fd => ({
                type: 'function',
                name: fd.name,
                description: fd.description,
                parameters: fd.parameters
            })) : undefined
        };
    } else if (providerType === 'openai') {
        // OpenAI format
        messages = convertToOpenAIFormatProvider(fixedContents);
        url = `${baseUrl}/chat/completions`;
        headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
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
                { role: 'system', content: systemPrompt },
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
        // Anthropic format
        messages = convertToAnthropicFormat(fixedContents, modelEntry);
        url = `${baseUrl}/v1/messages`;
        headers = {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-beta': 'interleaved-thinking-2025-05-14',
            'user-agent': 'foxwarm/1.0',
        };

        data = {
            model: modelName,
            max_tokens: MAX_OUTPUT,
            thinking: THINKING_BUDGET ? { type: "enabled", budget_tokens: THINKING_BUDGET } : undefined,
            system: systemPrompt,
            messages: messages,
            tools: availableToolDefinitions.length > 0 ? availableToolDefinitions.map(fd => ({
                name: fd.name,
                description: fd.description,
                input_schema: fd.parameters
            })) : undefined
        };
    }

    const extraFields = modelEntry.extraFields || {};
    if (useOpenAIResponsesApi && extraFields.reasoning && typeof extraFields.reasoning === 'object') {
        const { reasoning: extraReasoning, ...restExtraFields } = extraFields;
        const hasSummaryOverride = Object.prototype.hasOwnProperty.call(extraReasoning, 'summary');
        Object.assign(data, restExtraFields);
        data.reasoning = {
            ...(data.reasoning || {}),
            ...extraReasoning,
            summary: hasSummaryOverride
                ? extraReasoning.summary
                : (data.reasoning?.summary || 'auto'),
        };
    } else {
        Object.assign(data, extraFields);
    }
    
    const logFiles = await logRequest(data, iteration);
    const responseAttempts: any[] = [];
    const returnWithLoggedFailure = async (text: string): Promise<ChatResult> => {
        await moveInteractionLogsToErrorDir(logFiles);
        return appendTerminalModelTextAndReturn(text);
    };
    
    // Make API call with retries
    let response: AxiosResponse;
    let resp: any;
    const maxRetries = 3;
    const abortController = new AbortController();
    const shouldRegisterAbortController = options?.registerAbortController !== false;
    const shouldNotifySessionEvents = options?.notifySessionEvents !== false;

    if (shouldRegisterAbortController) {
        sessionManager.registerSessionAbortController(session.id, abortController);
    }
    if (shouldNotifySessionEvents) {
        sessionManager.notifySessionEvent(session.id, { type: 'reasoning-summary-reset' });
    }

    try {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                response = await axios.post(url, data, {
                    headers: { ...headers, ...modelEntry.extraHeaders },
                    timeout: 180000, // 3 minutes
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
                            return appendTerminalModelTextAndReturn(`Error: API request failed after ${maxRetries} attempts`);
                        }
                        await sleepWithSignal(2000, abortController.signal);
                        continue;
                    }

                    if (useOpenAIResponsesApi) {
                        resp = await collectOpenAIResponsesStreamProvider(response.data, abortController.signal, {
                            onReasoningSummary: shouldNotifySessionEvents
                                ? (text) => {
                                    sessionManager.notifySessionEvent(session.id, {
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
            sessionManager.clearSessionAbortController(session.id, abortController);
        }
    }
    
    // Extract response content blocks and tool calls
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
                const args = JSON.parse(item.arguments || '{}');
                const callId = item.call_id || item.id;
                allParts.push({
                    functionCall: {
                        id: callId,
                        name: item.name,
                        args
                    }
                });
            }
        }
    } else if (providerType === 'openai') {
        // Parse OpenAI response
        const choice = resp.choices?.[0];
        if (!choice) {
            return appendTerminalModelTextAndReturn('Error: No response from OpenAI API');
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
                    const args = JSON.parse(toolCall.function.arguments || '{}');
                    allParts.push({ 
                        functionCall: { 
                            id: toolCall.id, 
                            name: toolCall.function.name, 
                            args: args 
                        } 
                    });
                }
            }
        }
    } else {
        // Parse Anthropic response
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
    
    // Log token usage
    let usage: TokenUsage = null;
    if (useOpenAIResponsesApi) {
        const cached = resp.usage?.input_tokens_details?.cached_tokens || 0;
        usage = resp.usage ? {
            inputTokens: resp.usage.input_tokens - cached,
            outputTokens: resp.usage.output_tokens,
            cachedTokens: cached
        } : null;
    } else if (providerType === 'openai') {
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

    if (usage) {
        logger.info(`Token Usage: Cached: ${usage.cachedTokens || 0} | Input: ${usage.inputTokens} | Output: ${usage.outputTokens} | Calls: ${toolCalls.length}`);
        
        // Update session accumulated usage stats
        session.stats.totalInputTokens += usage.inputTokens || 0;
        session.stats.totalCachedTokens += usage.cachedTokens || 0;
        session.stats.totalOutputTokens += usage.outputTokens || 0;
    }

    // Add assistant message to history
    if (allParts.length > 0) {
        const assistantMsg: Message = {
            role: 'model',
            parts: allParts
        };
        await appendMessage(assistantMsg);
    }

    // Return response with tool calls (if any)
    return { 
        text: responseText, 
        usage,
        toolCalls,
        allParts: allParts.length > 0 ? allParts : undefined
    };
}
