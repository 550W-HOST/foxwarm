import axios, { AxiosResponse } from 'axios';
import fs from 'fs-extra';
import path from 'path';
import * as tools from './tools';
import { logger } from './common';
import { MessagePart, AnthropicContentBlock, Message, AnthropicMessage, Session, ChatResult, FunctionCall, OpenAIResponsesContent, TokenUsage } from './types';
import { LOGS_DIR, resolveModelConfig, ModelConfigEntry, MAX_OUTPUT, THINKING_BUDGET, getAgentMemoryDir, MAIN_AGENT_MEMORY_DIR, getAgentDir } from './config';
import { nodesManager } from './nodesManager';
import * as sessionManager from './sessionManager';
import { formatTime, getDatedLogPath } from './logRotation';
import { loadSkillDocuments } from './skills';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function getPromptCacheKey(session: Session): string {
    return `${session.id || 'default'}`;
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
            const { documents } = await loadSkillDocuments(skillName);
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

async function logRequest(data: any, iteration = 0) {
    try {
        const timestamp = formatTime();
        const logFile = await getDatedLogPath(LOGS_DIR, `${timestamp}_iter${iteration}_req.json`);
        await fs.writeJson(logFile, data, { spaces: 2 });
    } catch (e) {
        logger.error({ err: e }, 'Failed to log LLM interaction');
    }
}

async function logResponse(data: any, iteration = 0) {
    try {
        const timestamp = formatTime();
        const logFile = await getDatedLogPath(LOGS_DIR, `${timestamp}_iter${iteration}_res.json`);
        await fs.writeJson(logFile, data, { spaces: 2 });
    } catch (e) {
        logger.error({ err: e }, 'Failed to log LLM response');
    }
}

/**
 * Check and fix unpaired tool calls (missing responses)
 * This can happen after agent restart
 * 
 * Also fix user/system inserted messages between tool calls, insert a dummy message.
 * This fix some kv cache problem.
 */
function fixToolCalls(contents: Message[]): Message[] {
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
            if (part.thinking) {
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
                const output = resp.output ?? resp.error ?? '';
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
function convertToOpenAIFormat(contents: Message[]): any[] {
    const openaiMessages = [];
    
    for (const msg of contents) {
        let role = msg.role as any;
        if (role === 'model') role = 'assistant';
        
        // Handle tool response messages
        if (role === 'tool') {
            const groupedByToolId = new Map<string, any[]>();
            const toolIdOrder: string[] = [];
            const pendingInlineWithoutId: any[] = [];

            const pushGroupPart = (toolId: string, part: any) => {
                if (!groupedByToolId.has(toolId)) {
                    groupedByToolId.set(toolId, []);
                    toolIdOrder.push(toolId);
                }
                groupedByToolId.get(toolId)!.push(part);
            };

            for (const part of msg.parts || []) {
                // Handle inline data (images/screenshots)
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
                        // Backward compatibility: older history might miss toolUseId on inlineData.
                        // Try to attach it to the next functionResponse in this same tool message.
                        pendingInlineWithoutId.push(imagePart);
                    }
                    continue;
                }
                
                if (part.functionResponse) {
                    const resp = part.functionResponse.response || {};
                    const output = resp.output ?? resp.error ?? '';
                    const toolId = part.functionResponse.tool_use_id || part.toolUseId;
                    if (!toolId) {
                        logger.warn({ part }, 'Skipping tool response without tool_call_id');
                        continue;
                    }

                    // Attach orphaned inline images (if any) to this tool id.
                    if (pendingInlineWithoutId.length > 0) {
                        for (const imagePart of pendingInlineWithoutId) {
                            pushGroupPart(toolId, imagePart);
                        }
                        pendingInlineWithoutId.length = 0;
                    }

                    pushGroupPart(toolId, { type: 'text', text: stringifyToolOutput(output) });
                }
            }

            // Any orphaned inlineData that still has no tool id must not be sent as tool output.
            if (pendingInlineWithoutId.length > 0) {
                logger.warn({ orphanCount: pendingInlineWithoutId.length }, 'Dropping inlineData without tool_call_id in tool message');
            }

            for (const toolId of toolIdOrder) {
                const groupedParts = groupedByToolId.get(toolId) || [];
                if (groupedParts.length === 0) continue;

                const hasNonTextPart = groupedParts.some((x: any) => x.type !== 'text');
                const content = !hasNonTextPart && groupedParts.length === 1
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
            // Handle thinking/reasoning (for o1 models and compatible APIs)
            if (part.thinking) {
                reasoningContent = part.thinking;
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
                toolCalls.push({
                    id: part.functionCall.id || `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                    type: 'function',
                    function: {
                        name: part.functionCall.name,
                        arguments: JSON.stringify(part.functionCall.args || {})
                    }
                });
            }

            // Handle image data
            if (part.inlineData) {
                content.push({
                    type: 'image_url',
                    image_url: {
                        url: `data:${part.inlineData.mimeType || part.inlineData.mime_type || 'image/jpeg'};base64,${part.inlineData.data}`
                    }
                });
            }
        }
        
        // Build message
        const message: any = { role };
        
        // Add reasoning content if present (for o1 models and compatible APIs)
        // Note: Official OpenAI API may not accept this in requests, but some
        // compatible APIs (local models, etc.) might support it
        if (reasoningContent) {
            message.reasoning_content = reasoningContent;
        }
        
        // Simplify: if only one text part, use string content
        if (content.length === 1 && content[0].type === 'text') {
            message.content = content[0].text;
        } else if (content.length > 0) {
            message.content = content;
        } else {
            message.content = (msg as any).content || '';
        }
        
        // Add tool calls if present
        if (toolCalls.length > 0) {
            message.tool_calls = toolCalls;
        }
        
        openaiMessages.push(message);
    }
    
    return openaiMessages;
}

/**
 * Convert internal message format to OpenAI Responses API input items.
 * - user messages => input_text / input_image message items
 * - assistant messages => output_text message items + function_call items
 * - tool messages => function_call_output items
 */
function convertToOpenAIResponsesFormat(contents: Message[]): any[] {
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

            const pushGroupPart = (toolId: string, part: any) => {
                if (!groupedByToolId.has(toolId)) {
                    groupedByToolId.set(toolId, []);
                    toolIdOrder.push(toolId);
                }
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
                    const output = resp.output ?? resp.error ?? '';
                    const toolId = part.functionResponse.tool_use_id || part.toolUseId;

                    if (!toolId) {
                        logger.warn({ part }, 'Skipping Responses tool output without call_id');
                        continue;
                    }

                    if (pendingInlineWithoutId.length > 0) {
                        for (const imagePart of pendingInlineWithoutId) {
                            pushGroupPart(toolId, imagePart);
                        }
                        pendingInlineWithoutId.length = 0;
                    }

                    if (output !== '') {
                        pushGroupPart(toolId, { type: 'input_text', text: stringifyToolOutput(output) });
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
                    arguments: JSON.stringify(part.functionCall.args || {})
                });
            }
        }

        flushMessageContent(role, content);
    }

    return responseInput;
}

/**
 * Execute tools and return results as a single message with multiple parts
 */
export async function executeTools(functionCalls: FunctionCall[], toolContext: any, session: any): Promise<Message> {
    const parts = [];

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
        const currentNode = await nodesManager.getCurrentNode(sessionId) || 'master';
        
        // Determine target node: explicit node param > current node > master
        const targetNode = nodeParam || currentNode;
        
        // Remove node parameter from args before execution
        const toolArgs = { ...call.args };
        delete toolArgs.node;
        
        if (targetNode !== 'master') {
            // Execute on remote node
            try {
                result = normalizeToolResult(await nodesManager.executeTool(targetNode, call.name, toolArgs, sessionId));
            } catch (e: any) {
                result = { error: e.message || String(e) };
            }
        } else if (toolFn) {
            // Execute locally on master
            try {
                result = normalizeToolResult(await toolFn(toolArgs, toolContext));
            } catch (e) {
                result = { error: e.message };
            }
        } else {
            result = { error: `Unknown tool: ${call.name}` };
        }

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
    
    return {
        role: 'tool',
        parts: parts
    };
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
): Promise<ChatResult> {
    const appendMessage = async (message: Message) => {
        await sessionManager.appendSessionMessage(session, message);
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
    const modelName = modelEntry?.model || '';
    const promptCacheKey = getPromptCacheKey(session);

    if (!baseUrl) {
        throw new Error('Model config has no baseUrl');
    }

    logger.info(`Requesting LLM (${modelKey}, type ${providerType}, iteration ${iteration})...`);

    const openaiEffort = THINKING_BUDGET >= 6000 ? 'xhigh' :
                         THINKING_BUDGET >= 4000 ? 'high' :
                         THINKING_BUDGET >= 2000 ? 'medium' :
                         THINKING_BUDGET > 0 ? 'low'
                         : undefined;

    if (providerType === 'openai') {
        // OpenAI format
        messages = convertToOpenAIFormat(fixedContents);
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
            messages: [
                { role: 'system', content: systemPrompt },
                ...messages
            ],
            tools: tools.definitions.length > 0 ? tools.definitions.map(fd => ({
                type: 'function',
                function: {
                    name: fd.name,
                    description: fd.description,
                    parameters: fd.parameters
                }
            })) : undefined
        };
    } else if (providerType === 'openai-responses') {
        messages = convertToOpenAIResponsesFormat(fixedContents);
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
            reasoning: openaiEffort ? { effort: openaiEffort } : undefined,
            input: [
                {
                    type: 'message',
                    role: 'developer',
                    content: [{ type: 'input_text', text: systemPrompt }]
                },
                ...messages
            ],
            tools: tools.definitions.length > 0 ? tools.definitions.map(fd => ({
                type: 'function',
                name: fd.name,
                description: fd.description,
                parameters: fd.parameters
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
            tools: tools.definitions.length > 0 ? tools.definitions.map(fd => ({
                name: fd.name,
                description: fd.description,
                input_schema: fd.parameters
            })) : undefined
        };
    }

    Object.assign(data, modelEntry.extraFields);
    
    await logRequest(data, iteration);
    
    // Make API call with retries
    let response: AxiosResponse;
    const maxRetries = 3;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            response = await axios.post(url, data, { 
                headers: { ...headers, ...modelEntry.extraHeaders },
                timeout: 180000, // 3 minutes
                validateStatus: () => true
            });
            await logResponse({
                status: response.status + ' ' + response.statusText,
                headers: response.headers,
                body: response.data
            }, iteration);
            if (response.status !== 200) {
                logger.error({
                    status: response.status + ' ' + response.statusText,
                    headers: response.headers,
                    body: response.data
                }, `LLM API Error (Attempt ${attempt}/${maxRetries})`);
                if (attempt === maxRetries) {
                    return { text: `Error: API request failed after ${maxRetries} attempts` };
                }
                await sleep(2000);
                continue;
            }
            break;
        } catch (e: any) {
            logger.error({ status: (e as AxiosResponse)?.status }, `LLM API Network Error (Attempt ${attempt}/${maxRetries})`);
            if (attempt === maxRetries) {
                return { text: `Error: API request failed after ${maxRetries} attempts: ${e?.message || e}` };
            }
            await sleep(2000);
        }
    }
    
    const resp = response.data;
    
    // Extract response content blocks and tool calls
    let responseText = '';
    const allParts: Message['parts'] = [];

    if (providerType === 'openai') {
        // Parse OpenAI response
        const choice = resp.choices?.[0];
        if (!choice) {
            return { text: 'Error: No response from OpenAI API' };
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
    } else if (providerType === 'openai-responses') {
        const outputItems = Array.isArray(resp.output) ? resp.output : [];

        if (outputItems.length === 0) {
            return { text: 'Error: No response from OpenAI Responses API' };
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
    } else {
        // Parse Anthropic response
        if (resp.content) {
            for (const rawBlock of resp.content) {
                const block = rawBlock as AnthropicContentBlock;
                if (block.type === 'text') {
                    responseText += block.text;
                    allParts.push({ text: block.text });
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
    if (providerType === 'openai') {
        usage = resp.usage ? {
            inputTokens: resp.usage.prompt_tokens,
            outputTokens: resp.usage.completion_tokens,
            cachedTokens: 0
        } : null;
    } else if (providerType === 'openai-responses') {
        const cached = resp.usage?.input_tokens_details?.cached_tokens || 0;
        usage = resp.usage ? {
            inputTokens: resp.usage.input_tokens - cached,
            outputTokens: resp.usage.output_tokens,
            cachedTokens: cached
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
