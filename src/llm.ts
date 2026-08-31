import axios, { AxiosResponse } from 'axios';
import crypto, { randomUUID } from 'crypto';
import fs from 'fs-extra';
import path from 'path';
import yaml from 'js-yaml';
import { StringDecoder } from 'string_decoder';
import zlib from 'zlib';
import * as tools from './tools';
import { logger } from './common';
import { MessagePart, AnthropicContentBlock, Message, AnthropicMessage, Session, ChatResult, FunctionCall, TokenUsage, ToolDefinition, ModelStreamToolCall } from './types';
import { LOGS_DIR, resolveModelConfig, ModelConfigEntry, ModelsConfig, MAX_OUTPUT, getAgentMemoryDir, MAIN_AGENT_MEMORY_DIR, getAgentDir, AGENTS_SYSTEM_PROMPT_PATH, isVirtualModelConfigEntry, normalizeOpenAIWebSearchConfig, NormalizedOpenAIWebSearchConfig, ModelEffort, MODEL_EFFORTS, getConcreteModelEffortConfig } from './config';
import * as sessionManager from './sessionManager';
import { formatTime, getRecentLogPath, moveLogsToDateErrorDir } from './logRotation';
import { listSkills } from './skills';
import { checkPathAccess } from './isolatedCheck';
import type { ResolvedTool } from './tools/resolvedTools';
import { executeResolvedTool, resolveDirectTool } from './tools/resolvedTools';
import { expandHomePath } from './utils/pathResolve';
import {
    collectOpenAIChatCompletionsStream as collectOpenAIChatCompletionsStreamProvider,
    collectOpenAIResponsesStream as collectOpenAIResponsesStreamProvider,
    convertToOpenAIFormat as convertToOpenAIFormatProvider,
    convertToOpenAIResponsesFormat as convertToOpenAIResponsesFormatProvider,
} from './llmProviders/openai';
import { parseFunctionCallArgs } from './toolCallArgs';
import { formatToolResponsePayload } from '../packages/shared/dist/toolResponseFormatting';
import { isSystemPayloadTextPart } from './utils/systemMessageParts';
import { formatFoxwarmSystemTag, formatSystemPartForModel, isFoxwarmMetadataLine } from './utils/promptWrappers';
import { formatLocalTimestamp } from './utils/localTime';
import { appendImageGuidanceText, normalizeToolResultImages } from './toolImages';
import { hydrateMessagesForProvider } from './imageBlobs';
import { guardToolOutputForModel } from './toolOutputGuard';
import { sanitizeLoneSurrogatesInPayload, truncateUnicodeSafeWithEllipsis } from './utils/unicode';
import { isModelVisibleMessage } from './session/messageVisibility';
import {
    beginVirtualRoutingRequest,
    clearVirtualRoutingState,
    recordVirtualTargetFailure,
    recordVirtualTargetSuccess,
    selectVirtualTarget,
    VirtualRoutingRequest,
    VirtualTargetSelection,
} from './modelRouting';
import {
    appendLlmAttemptResult,
    appendLlmAttemptStart,
    beginLlmRequestJournal,
    LlmRequestPurpose,
} from './llmRequestJournal';
import { toPersistedLlmRequestTiming } from './llmRequestTiming';

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

function isValidStoredPromptCacheKey(value: unknown): value is string {
    return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}

export function generatePromptCacheKey(): string {
    return randomUUID();
}

export function ensurePromptCacheKey(session: Session): string {
    if (isValidStoredPromptCacheKey(session.promptCacheKey)) {
        return session.promptCacheKey;
    }

    const promptCacheKey = generatePromptCacheKey();
    session.promptCacheKey = promptCacheKey;
    return promptCacheKey;
}

function getPromptCacheKeyForSessionId(sessionId?: string): string {
    // Compatibility fallback for low-level callers that do not have a Session object.
    // Normal session chat uses the persisted per-session key from ensurePromptCacheKey().
    // Do not derive this fallback from the raw session id; prompt_cache_key should stay
    // low-sensitivity even in setup/direct test calls.
    void sessionId;
    return generatePromptCacheKey();
}

/**
 * Recursively replace `${VAR_NAME}` placeholders in strings within an object.
 * Only string values are processed; non-string values are left as-is.
 * Supported variables are defined in the `vars` map (key = variable name without `${}`).
 */
function expandTemplateVariables<T>(obj: T, vars: Record<string, string>): T {
    if (typeof obj === 'string') {
        return obj.replace(/\$\{(\w+)\}/g, (match, varName: string) => {
            return Object.prototype.hasOwnProperty.call(vars, varName) ? vars[varName] : match;
        }) as unknown as T;
    }
    if (Array.isArray(obj)) {
        return obj.map(item => expandTemplateVariables(item, vars)) as unknown as T;
    }
    if (obj !== null && typeof obj === 'object') {
        const result: Record<string, any> = {};
        for (const [key, value] of Object.entries(obj)) {
            result[key] = expandTemplateVariables(value, vars);
        }
        return result as unknown as T;
    }
    return obj;
}

type RequestLlmOnceOptions = {
    contents: Message[];
    systemPrompt: string;
    model?: string;
    effort?: ModelEffort;
    modelEntryOverride?: ModelConfigEntry;
    modelsConfigOverride?: ModelsConfig;
    sessionId?: string;
    promptCacheKey?: string;
    turnId?: string;
    iteration?: number;
    toolDefinitions?: ToolDefinition[];
    notifySessionEvents?: boolean;
    registerAbortController?: boolean;
    abortSignal?: AbortSignal;
    maxRetries?: number;
    timeoutMs?: number;
    onRetry?: (event: LlmRetryEvent) => void | Promise<void>;
    purpose?: LlmRequestPurpose;
    currentSessionEffects?: CurrentSessionEffects;
};

/** In-process current-session effects used by the normal turn path. Not an RPC contract. */
export interface CurrentSessionEffects {
    placement: 'local' | 'session-worker';
    appendMessage(session: Session, message: Message): Promise<void>;
    persistSession(session: Session): Promise<void>;
    notifySessionEvent(sessionId: string, event: import('./types').SessionStreamEvent): void;
    registerAbortController(sessionId: string, controller: AbortController): void;
    clearAbortController(sessionId: string, controller: AbortController): void;
    clearWaitById(sessionId: string | undefined, waitId: string): Promise<boolean>;
    execRuntime?: import('./execManager').ExecRuntime;
}

export interface CurrentSessionTurnEffects extends CurrentSessionEffects {
    appendMessages(session: Session, messages: Message[]): Promise<void>;
    updateBusy(session: Session, busy: boolean): Promise<void>;
    startWait(session: Session, options?: Parameters<typeof sessionManager.startSessionWaitForSession>[1]): Promise<sessionManager.SessionWaitState>;
    notifyHistoryUpdate(sessionId: string, message: Message): void;
    setRuntimeState: typeof sessionManager.setActiveSessionRuntimeState;
    clearRuntimeState: typeof sessionManager.clearActiveSessionRuntimeState;
}

export function createDefaultCurrentSessionEffects(): CurrentSessionTurnEffects {
    const clearRuntimeState = (sessionId: string) => sessionManager.clearActiveSessionRuntimeState(sessionId);
    const persistSession = async (session: Session) => {
        if (session.id && sessionManager.getAllSessions().get(session.id) === session) {
            await sessionManager.saveSession(session);
        }
    };
    return {
        placement: 'local',
        appendMessage: (session, message) => sessionManager.appendSessionMessage(session, message),
        appendMessages: (session, messages) => sessionManager.appendSessionMessages(session, messages),
        persistSession,
        updateBusy: (session, busy) => {
            if (busy) sessionManager.assertSessionDestructiveMutationAllowed([session.id], 'start new work');
            return sessionManager.updateSessionBusyStateForSession(
                session, busy, () => persistSession(session), clearRuntimeState,
            );
        },
        startWait: (session, options) => sessionManager.startSessionWaitForSession(session, options, () => persistSession(session)),
        notifyHistoryUpdate: (sessionId, message) => sessionManager.notifyHistoryUpdate(sessionId, message),
        notifySessionEvent: (sessionId, event) => sessionManager.notifySessionEvent(sessionId, event),
        setRuntimeState: (sessionId, state) => sessionManager.setActiveSessionRuntimeState(sessionId, state),
        clearRuntimeState,
        registerAbortController: (sessionId, controller) => sessionManager.registerSessionAbortController(sessionId, controller),
        clearAbortController: (sessionId, controller) => sessionManager.clearSessionAbortController(sessionId, controller),
        clearWaitById: (sessionId, waitId) => sessionManager.clearSessionWaitById(sessionId, waitId),
        execRuntime: require('./execManager').getDefaultExecRuntime(),
    };
}

export type LlmRetryEvent = {
    attempt: number;
    maxRetries: number;
    nextAttempt?: number;
    delayMs?: number;
    final?: boolean;
    kind: 'http-error' | 'request-error' | 'response-error';
    reason: string;
    status?: string;
    modelId?: string;
    virtualModelKey?: string;
};

export type LlmRequestErrorDetails = {
    modelId?: string;
    attempt?: number;
    maxRetries?: number;
    kind?: LlmRetryEvent['kind'];
    status?: string;
    attempts?: unknown[];
};

export class LlmRequestError extends Error {
    readonly modelId?: string;
    readonly attempt?: number;
    readonly maxRetries?: number;
    readonly kind?: LlmRetryEvent['kind'];
    readonly status?: string;
    readonly attempts?: unknown[];

    constructor(message: string, details: LlmRequestErrorDetails = {}) {
        super(message);
        this.name = 'LlmRequestError';
        this.modelId = details.modelId;
        this.attempt = details.attempt;
        this.maxRetries = details.maxRetries;
        this.kind = details.kind;
        this.status = details.status;
        this.attempts = details.attempts;
    }
}

export function isLlmRequestError(error: unknown): error is LlmRequestError {
    return error instanceof LlmRequestError || (typeof error === 'object' && error !== null && (error as any).name === 'LlmRequestError');
}

type ModelStreamProgressSnapshot = {
    reasoning?: string;
    text?: string;
    toolCalls?: ModelStreamToolCall[];
};

const MODEL_STREAM_EVENT_THROTTLE_MS = 80;
const DEFAULT_LLM_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
export const DEFAULT_LLM_MAX_ATTEMPTS = 6;
// Compatibility alias: maxRetries has always meant total attempts, not retries
// after an initial request. Keep the public name while making the semantics
// explicit internally.
export const DEFAULT_LLM_MAX_RETRIES = DEFAULT_LLM_MAX_ATTEMPTS;
const LLM_RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 20_000];
const MAX_RAW_STREAM_LOG_CHARS = 5 * 1024 * 1024;

export function getLlmRetryDelayMs(failedAttempt: number): number {
    const index = Math.max(0, failedAttempt - 1);
    if (index < LLM_RETRY_DELAYS_MS.length) {
        return LLM_RETRY_DELAYS_MS[index];
    }

    const lastDelay = LLM_RETRY_DELAYS_MS[LLM_RETRY_DELAYS_MS.length - 1];
    const multiplier = 2 ** (index - LLM_RETRY_DELAYS_MS.length + 1);
    return Math.min(60_000, lastDelay * multiplier);
}

function summarizeRetryReason(value: unknown, maxGraphemes = 240): string {
    const text = typeof value === 'string'
        ? value
        : value instanceof Error
        ? value.message
        : String(value || 'Unknown error');
    return truncateUnicodeSafeWithEllipsis(text.replace(/\s+/g, ' ').trim(), maxGraphemes);
}

function createRawStreamLogCapture(maxChars = MAX_RAW_STREAM_LOG_CHARS) {
    let rawBody = '';
    let rawBodyChars = 0;
    let rawBodyTruncated = false;
    const sseBlocks: string[] = [];
    let sseBlocksChars = 0;
    let sseBlocksTruncated = false;

    const appendText = (current: string, currentChars: number, text: string) => {
        if (!text || currentChars >= maxChars) {
            return {
                next: current,
                chars: currentChars,
                truncated: !!text,
            };
        }

        const remaining = maxChars - currentChars;
        if (text.length <= remaining) {
            return {
                next: `${current}${text}`,
                chars: currentChars + text.length,
                truncated: false,
            };
        }

        return {
            next: `${current}${text.slice(0, remaining)}`,
            chars: maxChars,
            truncated: true,
        };
    };

    return {
        appendChunk(text: string) {
            const appended = appendText(rawBody, rawBodyChars, text);
            rawBody = appended.next;
            rawBodyChars = appended.chars;
            rawBodyTruncated = rawBodyTruncated || appended.truncated;
        },
        appendSseBlock(block: string) {
            if (!block) return;
            if (sseBlocksChars >= maxChars) {
                sseBlocksTruncated = true;
                return;
            }

            const remaining = maxChars - sseBlocksChars;
            const stored = block.length <= remaining ? block : block.slice(0, remaining);
            sseBlocks.push(stored);
            sseBlocksChars += stored.length;
            if (stored.length < block.length) {
                sseBlocksTruncated = true;
            }
        },
        snapshot() {
            return {
                format: 'sse',
                body: rawBody,
                sseBlocks,
                truncated: rawBodyTruncated || sseBlocksTruncated,
                maxChars,
            };
        },
    };
}

function newModelStreamId(iteration: number): string {
    return `ms_${iteration}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeModelStreamToolCalls(toolCalls: ModelStreamToolCall[] | undefined): ModelStreamToolCall[] {
    if (!Array.isArray(toolCalls)) {
        return [];
    }

    return toolCalls.map((toolCall, fallbackIndex) => ({
        index: Number.isFinite(toolCall.index) ? toolCall.index : fallbackIndex,
        ...(typeof toolCall.id === 'string' && toolCall.id.trim() ? { id: toolCall.id.trim() } : {}),
        ...(typeof toolCall.name === 'string' && toolCall.name.trim() ? { name: toolCall.name.trim() } : {}),
    }));
}

function areModelStreamToolCallsEqual(left: ModelStreamToolCall[] = [], right: ModelStreamToolCall[] = []): boolean {
    if (left.length !== right.length) {
        return false;
    }

    return left.every((leftCall, index) => {
        const rightCall = right[index];
        return !!rightCall
            && leftCall.index === rightCall.index
            && (leftCall.id || '') === (rightCall.id || '')
            && (leftCall.name || '') === (rightCall.name || '');
    });
}

function createModelStreamEventEmitter(args: {
    enabled: boolean;
    sessionId?: string;
    iteration: number;
    currentSessionEffects?: CurrentSessionEffects;
}) {
    const streamId = newModelStreamId(args.iteration);
    let latestSnapshot: ModelStreamProgressSnapshot = { reasoning: '', text: '', toolCalls: [] };
    let timer: ReturnType<typeof setTimeout> | null = null;
    let hasPendingUpdate = false;
    let lastSentAt = 0;
    const notifySessionEvent = (event: import('./types').SessionStreamEvent) => {
        if (!args.sessionId) return;
        if (args.currentSessionEffects) args.currentSessionEffects.notifySessionEvent(args.sessionId, event);
        else sessionManager.notifySessionEvent(args.sessionId, event);
    };

    const notify = () => {
        if (!args.enabled || !args.sessionId) {
            return;
        }

        notifySessionEvent({
            type: 'model-stream-update',
            streamId,
            iteration: args.iteration,
            reasoning: latestSnapshot.reasoning || '',
            text: latestSnapshot.text || '',
            toolCalls: normalizeModelStreamToolCalls(latestSnapshot.toolCalls),
        });
        hasPendingUpdate = false;
        lastSentAt = Date.now();
    };

    const scheduleNotify = () => {
        if (!args.enabled || !args.sessionId) {
            return;
        }

        hasPendingUpdate = true;
        if (timer) {
            return;
        }

        const elapsed = Date.now() - lastSentAt;
        const delay = Math.max(0, MODEL_STREAM_EVENT_THROTTLE_MS - elapsed);
        timer = setTimeout(() => {
            timer = null;
            notify();
        }, delay);
    };

    return {
        streamId,
        reset() {
            if (!args.enabled || !args.sessionId) {
                return;
            }

            latestSnapshot = { reasoning: '', text: '', toolCalls: [] };
            hasPendingUpdate = false;
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            notifySessionEvent({
                type: 'model-stream-reset',
                streamId,
                iteration: args.iteration,
            });
            lastSentAt = Date.now();
        },
        emit(snapshot: ModelStreamProgressSnapshot) {
            const nextSnapshot = {
                reasoning: snapshot.reasoning ?? latestSnapshot.reasoning ?? '',
                text: snapshot.text ?? latestSnapshot.text ?? '',
                toolCalls: normalizeModelStreamToolCalls(snapshot.toolCalls ?? latestSnapshot.toolCalls),
            };
            const currentToolCalls = normalizeModelStreamToolCalls(latestSnapshot.toolCalls);
            if ((latestSnapshot.reasoning || '') === nextSnapshot.reasoning
                && (latestSnapshot.text || '') === nextSnapshot.text
                && areModelStreamToolCallsEqual(currentToolCalls, nextSnapshot.toolCalls)) {
                return;
            }

            latestSnapshot = nextSnapshot;
            scheduleNotify();
        },
        flush() {
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            if (hasPendingUpdate) {
                notify();
            }
        },
    };
}

async function resolvePromptCacheKeyForRequest(options: RequestLlmOnceOptions): Promise<string> {
    if (options.promptCacheKey) {
        return options.promptCacheKey;
    }

    const session = options.sessionId ? await sessionManager.getExistingSession(options.sessionId) : undefined;
    if (session) {
        const previousPromptCacheKey = session.promptCacheKey;
        const promptCacheKey = ensurePromptCacheKey(session);
        if (session.promptCacheKey !== previousPromptCacheKey) {
            await sessionManager.saveSession(session.id);
        }
        return promptCacheKey;
    }

    return getPromptCacheKeyForSessionId(options.sessionId);
}

export function getOpenAIRequestApi(providerType: string): 'responses' | 'chat-completions' | null {
    if (providerType === 'openai' || providerType === 'openai-responses') {
        return 'responses';
    }

    if (providerType === 'openai-completions') {
        return 'chat-completions';
    }

    return null;
}

function getModelIdForMetadata(modelEntry: ModelConfigEntry | undefined, fallbackModelKey: string): string {
    const canonicalModelKey = typeof modelEntry?.canonicalModelKey === 'string' ? modelEntry.canonicalModelKey.trim() : '';
    if (canonicalModelKey) return canonicalModelKey;

    const providerKey = typeof modelEntry?.providerKey === 'string' ? modelEntry.providerKey.trim() : '';
    const modelName = typeof modelEntry?.model === 'string' ? modelEntry.model.trim() : '';

    if (providerKey && modelName) {
        return `${providerKey}/${modelName}`;
    }

    if (providerKey) {
        return providerKey;
    }

    return fallbackModelKey;
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

function resolveSystemPromptFilePath(agentName: string, fileReference: string): string {
    const expandedPath = expandHomePath(fileReference);
    if (path.isAbsolute(expandedPath)) {
        return path.resolve(expandedPath);
    }

    return path.resolve(getAgentDir(agentName), expandedPath);
}

type MemoryFileFrontMatter = Record<string, unknown>;

function parseMemoryFileFrontMatter(content: string, filePath: string): { metadata: MemoryFileFrontMatter; body: string } {
    const match = content.match(/^---[ \t]*(?:\r?\n)([\s\S]*?)(?:\r?\n)---[ \t]*(?:\r?\n|$)/);
    if (!match) {
        return { metadata: {}, body: content };
    }

    const body = content.slice(match[0].length);
    try {
        const parsed = yaml.load(match[1]);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return { metadata: {}, body };
        }
        return { metadata: parsed as MemoryFileFrontMatter, body };
    } catch (err) {
        logger.warn({ err, filePath }, 'Failed to parse memory file frontmatter; ignoring metadata and injecting body');
        return { metadata: {}, body };
    }
}

function normalizeSessionGlobList(value: unknown, key: string, filePath: string): string[] | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }

    if (typeof value === 'string') {
        return value.trim() ? [value.trim()] : [];
    }

    if (Array.isArray(value)) {
        const patterns: string[] = [];
        for (const entry of value) {
            if (typeof entry !== 'string') {
                logger.warn({ filePath, key }, 'Invalid memory file frontmatter session glob entry; ignoring metadata key');
                return undefined;
            }
            const trimmed = entry.trim();
            if (trimmed) {
                patterns.push(trimmed);
            }
        }
        return patterns;
    }

    logger.warn({ filePath, key }, 'Invalid memory file frontmatter session glob value; ignoring metadata key');
    return undefined;
}

function escapeRegExpChar(ch: string): string {
    return /[\\^$+?.()|{}\[\]]/.test(ch) ? `\\${ch}` : ch;
}

function globMatchesSessionId(pattern: string, sessionId?: string): boolean {
    if (!sessionId) {
        return false;
    }

    let regex = '^';
    for (let i = 0; i < pattern.length; i++) {
        const ch = pattern[i];
        if (ch === '*') {
            if (pattern[i + 1] === '*') {
                while (pattern[i + 1] === '*') i++;
                regex += '.*';
            } else {
                regex += '[^/]*';
            }
        } else if (ch === '?') {
            regex += '[^/]';
        } else {
            regex += escapeRegExpChar(ch);
        }
    }
    regex += '$';
    return new RegExp(regex).test(sessionId);
}

function shouldInjectMemoryFileForSession(metadata: MemoryFileFrontMatter, filePath: string, sessionId?: string): boolean {
    const includeSession = normalizeSessionGlobList(metadata['include-session'], 'include-session', filePath);
    const excludeSession = normalizeSessionGlobList(metadata['exclude-session'], 'exclude-session', filePath);

    if (excludeSession?.some(pattern => globMatchesSessionId(pattern, sessionId))) {
        return false;
    }

    if (includeSession !== undefined) {
        return includeSession.some(pattern => globMatchesSessionId(pattern, sessionId));
    }

    return true;
}

async function readSessionFilteredMemoryFile(filePath: string, sessionId?: string): Promise<string | null> {
    const content = await fs.readFile(filePath, 'utf8');
    const { metadata, body } = parseMemoryFileFrontMatter(content, filePath);
    return shouldInjectMemoryFileForSession(metadata, filePath, sessionId) ? body : null;
}

async function appendConfiguredMemoryFiles(agentName: string, systemPromptFiles: string[], sessionId?: string): Promise<string> {
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

        const content = await readSessionFilteredMemoryFile(filePath, sessionId);
        if (content !== null) {
            combined += formatMemoryBlock(filePath, agentName, 'self', content);
        }
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
    combined += 'When a task matches a skill\'s description, call skill with action="load"\n';
    combined += 'and the skill\'s name to load its full instructions and resource list.\n';
    combined += 'Read listed resources only when the loaded skill or current task needs them:\n';
    combined += '<available_skills>\n';

    for (const skill of visibleSkills) {
        combined += '  <skill>';
        combined += `<name>${escapeXmlText(skill.name)}</name>`;
        combined += `<description>${escapeXmlText(skill.description || '')}</description>`;
        combined += `<source>${escapeXmlText(skill.sourceType)}</source>`;
        combined += '</skill>\n';
    }

    combined += '</available_skills>\n';
    return combined;
}

async function appendDefaultMemoryFiles(agentName: string, sessionId?: string): Promise<string> {
    const mainMemoryDir = MAIN_AGENT_MEMORY_DIR;
    let combined = '';

    if (await fs.pathExists(AGENTS_SYSTEM_PROMPT_PATH)) {
        const content = await fs.readFile(AGENTS_SYSTEM_PROMPT_PATH, 'utf8');
        combined += formatMemoryBlock(AGENTS_SYSTEM_PROMPT_PATH, 'framework', 'inherited', content);
    } else {
        const mainSystemPath = path.join(mainMemoryDir, '00_SYSTEM.md');
        if (await fs.pathExists(mainSystemPath)) {
            const content = await fs.readFile(mainSystemPath, 'utf8');
            const kind = agentName === 'main' ? 'self' : 'inherited';
            combined += formatMemoryBlock(mainSystemPath, 'main', kind, content);
        }
    }

    const inheritChain = sessionManager.getAgentInheritanceChain(agentName);
    for (const inheritedAgentName of inheritChain) {
        const kind = inheritedAgentName === agentName ? 'self' : 'inherited';
        combined += await appendMemoryFilesForAgent(inheritedAgentName, kind, sessionId);
    }

    return combined;
}

export async function buildSessionSystemPromptSnapshot(options: {
    agentName?: string;
    sessionId?: string;
    systemPromptFiles?: string[] | string;
} = {}): Promise<string> {
    const agentName = options.agentName || 'main';
    const sessionId = options.sessionId;
    const normalizedSystemPromptFiles = normalizeSystemPromptFiles(options.systemPromptFiles);
    const hasCustomMemorySources = options.systemPromptFiles !== undefined;

    const memoryBlocks = hasCustomMemorySources
        ? await appendConfiguredMemoryFiles(agentName, normalizedSystemPromptFiles || [], sessionId)
        : await appendDefaultMemoryFiles(agentName, sessionId);
    const skillCatalog = await appendSkillCatalogForAgent(agentName);
    const dirInfo = '\n\n--- DIRECTORIES ---\n- agent_folder: ' + getAgentDir(agentName) + '\n';
    const archiveInfo = [
        '',
        '',
        '--- EARLIER CONTEXT RECALL ---',
        '- Long sessions use layered context: older conversation is archived and may be compacted into CTX-BLOCK summaries to keep the active prompt small.',
        '- Compaction is system-initiated: Foxwarm forks a temporary compact thread to generate summary blocks, then the main session gets a `<foxwarm-system kind="session-boundary" event="compact-completed" ... />` identity notice and continues the agent task.',
        '- Block levels are hierarchical: lower/newer blocks are closer to raw messages; higher/older blocks are coarser summaries. Drill down step by step with `recall`.',
        '- Use `recall({"target":"overview"})` for archived ranges/examples, and `recall({"target":"B#123"})` for a CTX-BLOCK; use `msg:B#123` or `msg#100-120` only when you need raw detail.',
        '- Compaction/recall preserves traceable session history; it is not agent memory. Do not write routine process notes, temporary progress, or completed details to memory just to preserve context.',
        '- Use memory files only for long-lived stable rules, preferences, environment facts, and confirmed design decisions.',
        '- If you need lower-level archive helpers, use `search_tools(...)` and then `call_tool(...)`.',
        '',
    ].join('\n');
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

async function appendMemoryFilesForAgent(agentName: string, kind: 'self' | 'inherited', sessionId?: string): Promise<string> {
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
        const content = await readSessionFilteredMemoryFile(filePath, sessionId);
        if (content !== null) {
            combined += formatMemoryBlock(filePath, agentName, kind, content);
        }
    }

    return combined;
}


async function logRequest(data: any, iteration = 0): Promise<LlmInteractionLogFiles | null> {
    try {
        const timestamp = formatTime();
        const requestPath = await getRecentLogPath(LOGS_DIR, `${timestamp}_iter${iteration}_req.json`);
        await fs.writeJson(requestPath, redactProviderImagesForLog(data), { spaces: 2 });
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

export function redactProviderImagesForLog(value: any): any {
    if (typeof value === 'string') {
        return /^data:image\/[a-z0-9.+-]+;base64,/iu.test(value)
            ? value.replace(/;base64,.+$/su, ';base64,[image omitted from diagnostics]')
            : value;
    }
    if (Array.isArray(value)) return value.map(item => redactProviderImagesForLog(item));
    if (!value || typeof value !== 'object') return value;

    const result: Record<string, any> = {};
    for (const [key, entry] of Object.entries(value)) {
        if (key === 'data'
            && typeof entry === 'string'
            && value.type === 'base64'
            && typeof value.media_type === 'string'
            && value.media_type.startsWith('image/')) {
            result[key] = '[image omitted from diagnostics]';
        } else {
            result[key] = redactProviderImagesForLog(entry);
        }
    }
    return result;
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
            if (part.functionCall || part.functionResponse || part.inlineData || part.inlineDataRef || part.thinking) return false;
            if (part.system) return true;
            if (isSystemPayloadTextPart(part)) return true;
            return typeof part.text === 'string' && (part.text.startsWith('[SYSTEM:') || isFoxwarmMetadataLine(part.text));
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

function getHistoricalConcreteModelId(message: Message): string | undefined {
    const modelId = message.role === 'model' ? message.__meta?.modelId : undefined;
    return typeof modelId === 'string' && modelId.length > 0 && modelId === modelId.trim()
        ? modelId
        : undefined;
}

/**
 * Build an attempt-local provider history. Internal message metadata is never
 * serialized, while model-specific reasoning artifacts are retained only when
 * their concrete source is absent/legacy or exactly matches this destination.
 */
function prepareHistoryForConcreteModel(contents: Message[], destinationModelId: string): Message[] {
    const prepared: Message[] = [];

    for (const original of contents) {
        const sourceModelId = getHistoricalConcreteModelId(original);
        const { __meta: _internalMeta, ...withoutInternalMeta } = original;
        if (!sourceModelId || sourceModelId === destinationModelId) {
            prepared.push(withoutInternalMeta);
            continue;
        }

        const { providerMeta: _messageProviderMeta, ...withoutProviderMeta } = withoutInternalMeta;
        const parts = withoutProviderMeta.parts
            .map(part => {
                const { thinking: _thinking, providerMeta, ...rest } = part;
                if (!providerMeta) return rest;
                const {
                    thinkingSummaries: _thinkingSummaries,
                    encryptedThinking: _encryptedThinking,
                    signature: _signature,
                    openaiResponses: _openaiResponses,
                    ...remainingProviderMeta
                } = providerMeta;
                return Object.keys(remainingProviderMeta).length > 0
                    ? { ...rest, providerMeta: remainingProviderMeta }
                    : rest;
            })
            .filter(part => Object.keys(part).length > 0);

        const legacyContent = (withoutProviderMeta as Message & { content?: unknown }).content;
        const hasLegacyContent = typeof legacyContent === 'string'
            ? legacyContent.length > 0
            : Array.isArray(legacyContent)
            ? legacyContent.length > 0
            : legacyContent !== undefined && legacyContent !== null;
        if (parts.length === 0 && !hasLegacyContent) {
            continue;
        }
        prepared.push({ ...withoutProviderMeta, parts });
    }

    return prepared;
}

/**
 * Convert internal message format to Anthropic/Minimax format
 * Internal format: { role: 'user'|'model'|'tool', parts: [{ text, functionCall, functionResponse }] }
 * Anthropic format: { role: 'user'|'assistant'|'user', content: string | array }
 */
function convertToAnthropicFormat(contents: Message[], config: ModelConfigEntry): AnthropicMessage[] {
    const anthropicMessages: AnthropicMessage[] = [];

    const asContentBlocks = (value: any): AnthropicContentBlock[] => {
        if (Array.isArray(value)) {
            return value;
        }
        return [{ type: 'text', text: String(value ?? '') }];
    };
    const formatPreviousLlmRequestPrefix = (part: MessagePart): string | undefined => {
        const timing = part.functionResponse?.previousLlmRequest;
        if (!timing || typeof timing.time !== 'string' || !Number.isFinite(timing.durationMs)) return undefined;
        return formatFoxwarmSystemTag({
            kind: 'time',
            time: timing.time,
            prevLLMReqTime: `${(Math.max(0, timing.durationMs) / 1000).toFixed(1)}s`,
        });
    };
    
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
                content.push({ type: 'text', text: formatSystemPartForModel(part.system) });
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
                const outputText = appendImageGuidanceText(imagePartsByToolUseId.get(toolUseId) || [], formatToolResponsePayload(resp));
                const timingPrefix = formatPreviousLlmRequestPrefix(part);
                const images = imagePartsByToolUseId.get(toolUseId) || [];
                const toolResult: any = {
                    type: 'tool_result',
                    tool_use_id: toolUseId,
                    content: timingPrefix ? `${timingPrefix}${outputText ? `\n${outputText}` : ''}` : outputText,
                };
                if (images.length > 0) {
                    toolResult.content = [
                        ...(timingPrefix ? [{ type: 'text', text: timingPrefix }] : []),
                        ...(outputText ? [{ type: 'text', text: outputText }] : []),
                        ...images.map(image => ({
                            type: 'image',
                            source: {
                                type: 'base64',
                                media_type: image.inlineData!.mimeType || image.inlineData!.mime_type || 'image/jpeg',
                                data: image.inlineData!.data,
                            },
                        })),
                    ];
                }
                if (config.baseUrl?.startsWith('https://api.kimi.com/')) {
                    if (!content.find(x => x.type === 'thinking')) {
                        (toolResult as any).reasoning_content = '';
                    }
                }
                content.push(toolResult);
            }

            // Handle image data - convert internal format to Anthropic format
            if (part.inlineData) {
                if (msg.role === 'tool' && part.toolUseId) {
                    // Tool-result images are emitted with their matching result
                    // above, so an annotated prefix remains first-visible.
                    continue;
                }
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
        
        const previous: AnthropicMessage | undefined = anthropicMessages[anthropicMessages.length - 1];
        if (previous?.role === role) {
            // Anthropic requires alternating roles. Keep canonical session
            // messages separate, and normalize only this outbound payload.
            previous.content = [...asContentBlocks(previous.content), ...asContentBlocks(content)];
        } else {
            anthropicMessages.push({ role, content });
        }
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
const PARALLEL_EXEC_LIMIT = 4;

type ToolExecutionSnapshot = {
    currentNode: string;
    cwd?: string;
};

type PreparedToolCall = {
    call: FunctionCall;
    index: number;
    toolId: string;
    resolved?: ResolvedTool;
    toolArgs: Record<string, any>;
    sessionId: string;
    executionNode: string;
    result?: any;
    sessionSnapshot?: ToolExecutionSnapshot;
    placementError?: any;
};

type ExecutedToolCall = PreparedToolCall & {
    result: any;
    imageParts: MessagePart[];
    stopCurrentTurn: boolean;
    waitForReply: boolean;
    explicitWaitId?: string;
    successfulSendToSessionTarget?: string;
    successfulWaitAfterSendTarget?: string;
    successfulFinishAfterSend: boolean;
    deferredExecCwdSync?: { nextCwd: string };
};

function normalizeExecutedToolResult(rawResult: any): any {
    if (rawResult === undefined) return { output: '(No output)' };
    if (rawResult === null) return { output: null };
    if (typeof rawResult === 'string' || typeof rawResult === 'number' || typeof rawResult === 'boolean') {
        return { output: rawResult };
    }
    if (typeof rawResult === 'object') return rawResult;
    return { output: String(rawResult) };
}

function formatToolArgPreviewValue(value: unknown): string {
    if (typeof value === 'string') return value;
    if (value === undefined) return 'undefined';
    try {
        const serialized = JSON.stringify(value);
        return typeof serialized === 'string' ? serialized : String(value);
    } catch {
        return String(value);
    }
}

function buildToolArgsPreview(call: FunctionCall): string {
    let argValue: unknown = '';
    if (call.argsParseError && typeof call.rawArgsText === 'string') {
        argValue = call.rawArgsText;
    } else if (call.name === 'exec') {
        argValue = call.args?.command;
    } else if (call.name === 'edit' || call.name === 'write' || call.name === 'edit_memory' || call.name === 'write_memory' || call.name === 'delete_memory') {
        argValue = call.args?.filePath;
    } else if (call.name === 'apply_patch' || call.name === 'apply_patch_memory') {
        argValue = typeof call.args?.input === 'string' ? call.args.input : '';
    } else if (call.name === 'read' || call.name === 'read_memory') {
        const { filePath, startLine, endLine } = call.args || {};
        argValue = (filePath ?? '') + (startLine ? ` (lines ${startLine}-${endLine})` : '');
    } else if (call.args) {
        const keys = Object.keys(call.args);
        if (keys.length === 1) {
            argValue = call.args[keys[0]];
        } else {
            argValue = keys.map(key => `${key}: ${formatToolArgPreviewValue(call.args[key])}`).join('\n');
        }
    }
    const argStr = formatToolArgPreviewValue(argValue);
    return argStr.length > 200 ? `${argStr.substring(0, 197)}...` : argStr;
}

async function prepareToolCall(
    call: FunctionCall,
    index: number,
    total: number,
    toolContext: any,
    session: Session,
    snapshot?: ToolExecutionSnapshot,
    notifyStart = true,
): Promise<PreparedToolCall> {
    const toolId = call.id || `tool_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const argsPreview = buildToolArgsPreview(call);
    const sessionId = session.id;
    let placementError: any;
    let resolved: ResolvedTool | undefined;
    try {
        if (call.argsParseError) tools.assertToolAvailableForPlacement(call.name, call.args || {}, toolContext);
        else resolved = await resolveDirectTool(call.name, call.args || {}, toolContext, snapshot);
    } catch (error) { placementError = error; }
    const toolArgs = resolved?.args || { ...(call.args || {}) };
    const executionNode = resolved?.executionNode || snapshot?.currentNode || session.currentNode || 'master';
    if (notifyStart && !placementError) {
        logger.info({ tool: call.name, args: argsPreview }, 'Executing tool');
        if (toolContext.broadcast && session.verbose) {
            toolContext.broadcast(`🛠 *[${call.name}]*: \`${argsPreview}\``, { excludePlatforms: ['webui'] });
        }
        const startedAt = Date.now();
        await Promise.resolve(toolContext.onToolStart?.({
            id: toolId,
            name: call.name,
            index,
            total,
            executionNode,
            argsPreview: argsPreview.length > 500 ? `${argsPreview.slice(0, 500)}…` : argsPreview,
            startedAt,
        }));
    }

    return {
        call,
        index,
        toolId,
        resolved,
        toolArgs,
        sessionId,
        executionNode,
        result: call.argsParseError ? buildInvalidToolArgsResult(call) : undefined,
        sessionSnapshot: resolved?.routingSnapshot,
        placementError,
    };
}

async function runPreparedToolCall(prepared: PreparedToolCall, toolContext: any): Promise<ExecutedToolCall> {
    let result = prepared.result;
    let imageParts: MessagePart[] = [];
    let stopCurrentTurn = false;
    let waitForReply = false;
    let explicitWaitId: string | undefined;
    let successfulSendToSessionTarget: string | undefined;
    let successfulWaitAfterSendTarget: string | undefined;
    let successfulFinishAfterSend = false;
    let deferredExecCwdSync: { nextCwd: string } | undefined;

    try {
        if (prepared.placementError) throw prepared.placementError;
        if (!result?.error && prepared.resolved) {
            const runtimeContext = { ...toolContext, toolUseId: prepared.toolId };
            const localToolContext = prepared.sessionSnapshot
                ? {
                    ...runtimeContext,
                    toolExecutionSnapshot: prepared.sessionSnapshot,
                    deferSessionCwdSync: prepared.call.name === 'exec',
                }
                : runtimeContext;
            result = normalizeExecutedToolResult(await executeResolvedTool(prepared.resolved, localToolContext));
        } else if (!result?.error) {
            result = { error: `Unknown tool: ${prepared.call.name}` };
        }

        if (result && typeof result === 'object') {
            if (result.__toolLoopControl && typeof result.__toolLoopControl === 'object') {
                stopCurrentTurn = !!result.__toolLoopControl.stopCurrentTurn;
            }
            if (result.__toolPostAction && typeof result.__toolPostAction === 'object') {
                waitForReply = result.__toolPostAction.waitForReply === true;
                explicitWaitId = typeof result.__toolPostAction.explicitWaitId === 'string'
                    ? result.__toolPostAction.explicitWaitId
                    : undefined;
                successfulSendToSessionTarget = (prepared.call.name === 'send_to_session' || prepared.call.name === 'create_child_session')
                    && typeof result.__toolPostAction.successfulSendToSessionTarget === 'string'
                    ? result.__toolPostAction.successfulSendToSessionTarget
                    : undefined;
                successfulWaitAfterSendTarget = successfulSendToSessionTarget
                    && (prepared.call.args?.afterSend === 'wait' || prepared.call.args?.waitAfterHandoff === true)
                    && waitForReply
                    ? successfulSendToSessionTarget : undefined;
                successfulFinishAfterSend = (prepared.call.name === 'send_to_session' || prepared.call.name === 'create_child_session')
                    && result.__toolPostAction.finishAfterSend === true;
            }
            if (result.__execBatchCwdSync && typeof result.__execBatchCwdSync.nextCwd === 'string') {
                deferredExecCwdSync = { nextCwd: result.__execBatchCwdSync.nextCwd };
            }
            const { __toolLoopControl, __toolPostAction, __execBatchCwdSync, ...visibleResult } = result;
            result = visibleResult;
        }

        const normalizedImages = await normalizeToolResultImages(
            result,
            prepared.toolId,
            `[Inline data returned by ${prepared.call.name}]`,
        );
        imageParts = normalizedImages.imageParts;
        result = normalizedImages.result;
    } catch (error: any) {
        result = { error: error?.message || String(error), ...(error?.code ? { code: error.code } : {}),
            ...(error?.retryable === true ? { retryable: true } : {}) };
        imageParts = [];
    }

    return {
        ...prepared,
        result: normalizeExecutedToolResult(result),
        imageParts,
        stopCurrentTurn,
        waitForReply,
        explicitWaitId,
        successfulSendToSessionTarget,
        successfulWaitAfterSendTarget,
        successfulFinishAfterSend,
        deferredExecCwdSync,
    };
}

async function runBoundedToolCalls(
    prepared: PreparedToolCall[],
    toolContext: any,
): Promise<Array<ExecutedToolCall | undefined>> {
    const results: Array<ExecutedToolCall | undefined> = new Array(prepared.length);
    let nextIndex = 0;
    const workers = Array.from({ length: Math.min(PARALLEL_EXEC_LIMIT, prepared.length) }, async () => {
        while (true) {
            const index = nextIndex++;
            if (index >= prepared.length) return;
            try {
                results[index] = await runPreparedToolCall(prepared[index], toolContext);
            } catch (error: any) {
                results[index] = buildFailedToolCall(prepared[index], error);
            }
        }
    });
    await Promise.allSettled(workers);
    return results;
}

function buildFailedToolCall(prepared: PreparedToolCall, error: any): ExecutedToolCall {
    return {
        ...prepared,
        result: { error: error?.message || String(error) },
        imageParts: [],
        stopCurrentTurn: false,
        waitForReply: false,
        successfulFinishAfterSend: false,
    };
}

function buildSkippedToolCall(prepared: PreparedToolCall): ExecutedToolCall {
    return {
        ...prepared,
        result: { error: 'Tool call was not started because the session was stopped.' },
        imageParts: [],
        stopCurrentTurn: false,
        waitForReply: false,
        successfulFinishAfterSend: false,
    };
}

async function replayDeferredExecCwd(execution: ExecutedToolCall, toolContext: any): Promise<ExecutedToolCall> {
    if (!execution.deferredExecCwdSync) return execution;
    try {
        const { applyDeferredExecCwdSync } = await import('./tools/execTools');
        return {
            ...execution,
            result: await applyDeferredExecCwdSync(toolContext, execution.result, execution.deferredExecCwdSync),
            deferredExecCwdSync: undefined,
        };
    } catch (error: any) {
        return {
            ...execution,
            result: { error: error?.message || String(error) },
            deferredExecCwdSync: undefined,
        };
    }
}

/**
 * Execute tools and return results as a single message with multiple parts.
 * Adjacent direct exec calls share a node/cwd snapshot and run concurrently;
 * every other tool is a serial ordering barrier.
 */
export async function executeTools(
    functionCalls: FunctionCall[],
    toolContext: any,
    session: any,
    options?: { currentSessionEffects?: CurrentSessionEffects },
): Promise<Message> {
    const requestedSourceId = typeof toolContext?.sessionId === 'string' && toolContext.sessionId.trim()
        ? toolContext.sessionId.trim()
        : undefined;
    let sourceSession: Session;
    if (options?.currentSessionEffects) {
        if (!session || typeof session.id !== 'string' || !session.id.trim()) {
            throw new Error('Tool execution with current-session effects requires an authoritative Session.');
        }
        if (requestedSourceId && requestedSourceId !== session.id) {
            throw new Error(`Tool execution source session \`${requestedSourceId}\` does not match authoritative Session \`${session.id}\`.`);
        }
        sourceSession = session;
    } else {
        if (!requestedSourceId) {
            throw new Error('Tool execution requires a source session ID when current-session effects are absent.');
        }
        const existing = await sessionManager.getExistingSession(requestedSourceId);
        if (!existing) {
            throw new Error(`Tool execution source session \`${requestedSourceId}\` was not found.`);
        }
        sourceSession = existing;
    }
    session = sourceSession;
    toolContext = {
        ...toolContext,
        sessionId: sourceSession.id,
        session: sourceSession,
        persistCurrentSession: options?.currentSessionEffects
            ? () => options.currentSessionEffects!.persistSession(sourceSession)
            : undefined,
        sessionPlacement: options?.currentSessionEffects?.placement || 'local',
        ...(options?.currentSessionEffects?.execRuntime ? { execRuntime: options.currentSessionEffects.execRuntime } : {}),
    };
    const executions: ExecutedToolCall[] = [];
    let cursor = 0;

    while (cursor < functionCalls.length) {
        if (session?.stopping) {
            for (; cursor < functionCalls.length; cursor++) {
                const prepared = await prepareToolCall(functionCalls[cursor], cursor, functionCalls.length, toolContext, session, undefined, false);
                executions.push(buildSkippedToolCall(prepared));
            }
            break;
        }

        if (functionCalls[cursor].name !== 'exec') {
            const prepared = await prepareToolCall(functionCalls[cursor], cursor, functionCalls.length, toolContext, session);
            executions.push(await runPreparedToolCall(prepared, toolContext));
            cursor++;
            continue;
        }

        const segmentStart = cursor;
        while (cursor < functionCalls.length && functionCalls[cursor].name === 'exec') cursor++;
        const snapshot: ToolExecutionSnapshot = {
            currentNode: sourceSession.currentNode || 'master',
            cwd: typeof sourceSession.cwd === 'string' ? sourceSession.cwd : undefined,
        };
        const preparedSegment: PreparedToolCall[] = [];
        for (let index = segmentStart; index < cursor; index++) {
            preparedSegment.push(await prepareToolCall(
                functionCalls[index],
                index,
                functionCalls.length,
                toolContext,
                session,
                snapshot,
            ));
        }
        const settled = await runBoundedToolCalls(preparedSegment, toolContext);
        for (let index = 0; index < preparedSegment.length; index++) {
            executions.push(await replayDeferredExecCwd(settled[index] || buildSkippedToolCall(preparedSegment[index]), toolContext));
        }
    }

    const parts: MessagePart[] = [];
    let stopCurrentTurn = false;
    let batchHasError = false;
    let waitForReply = false;
    const explicitWaitIds: string[] = [];
    const successfulSendToSessionTargets: string[] = [];
    const successfulWaitAfterSendTargets: string[] = [];
    let successfulFinishAfterSend = false;

    for (const execution of executions) {
        let result = execution.result;
        try {
            result = await guardToolOutputForModel(result, {
                sessionId: execution.sessionId,
                session,
                toolName: execution.call.name,
                toolUseId: execution.toolId,
                nodeId: execution.executionNode,
            });
        } catch (error: any) {
            result = { error: error?.message || String(error) };
        }
        parts.push(...execution.imageParts, {
            functionResponse: {
                tool_use_id: execution.toolId,
                name: execution.call.name,
                ...(execution.index === 0 && toolContext.previousLlmRequest ? {
                    previousLlmRequest: {
                        time: formatLocalTimestamp(toolContext.previousLlmRequest.completedAt),
                        durationMs: toolContext.previousLlmRequest.durationMs,
                    },
                } : {}),
                response: result,
            },
        });
        stopCurrentTurn = stopCurrentTurn || execution.stopCurrentTurn;
        batchHasError = batchHasError || !!(result && typeof result === 'object' && result.error !== undefined && result.error !== null);
        waitForReply = waitForReply || execution.waitForReply;
        if (execution.explicitWaitId) explicitWaitIds.push(execution.explicitWaitId);
        if (execution.successfulSendToSessionTarget) successfulSendToSessionTargets.push(execution.successfulSendToSessionTarget);
        if (execution.successfulWaitAfterSendTarget && !successfulWaitAfterSendTargets.includes(execution.successfulWaitAfterSendTarget)) {
            successfulWaitAfterSendTargets.push(execution.successfulWaitAfterSendTarget);
        }
        successfulFinishAfterSend = successfulFinishAfterSend || execution.successfulFinishAfterSend;
    }

    if (stopCurrentTurn && batchHasError) {
        for (const waitId of explicitWaitIds) {
            if (options?.currentSessionEffects) {
                await options.currentSessionEffects.clearWaitById(toolContext.sessionId || session?.id, waitId);
            } else {
                await sessionManager.clearSessionWaitById(toolContext.sessionId || session?.id, waitId);
            }
        }
    }

    const toolMessage: Message = { role: 'tool', parts };
    if ((stopCurrentTurn && !batchHasError) || successfulFinishAfterSend) {
        (toolMessage as any).__toolLoopControl = { stopCurrentTurn: true };
    } else if (stopCurrentTurn) {
        logger.debug({ sessionId: toolContext.sessionId || session?.id, toolCount: functionCalls.length }, 'Suppressing stopCurrentTurn because a tool in the batch returned an error');
    }
    if (waitForReply || successfulFinishAfterSend || successfulSendToSessionTargets.length || successfulWaitAfterSendTargets.length) {
        (toolMessage as any).__toolPostAction = {
            ...(waitForReply ? { waitForReply: true } : {}),
            ...(successfulFinishAfterSend ? { finishAfterSend: true } : {}),
            ...(successfulSendToSessionTargets.length ? { successfulSendToSessionTargets } : {}),
            ...(successfulWaitAfterSendTargets.length ? { successfulWaitAfterSendTargets } : {}),
        };
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
        abortSignal?: AbortSignal;
        onRetry?: (event: LlmRetryEvent) => void | Promise<void>;
        purpose?: LlmRequestPurpose;
        turnId?: string;
        currentSessionEffects?: CurrentSessionEffects;
    },
): Promise<ChatResult> {
    const currentSessionEffects = options?.currentSessionEffects || createDefaultCurrentSessionEffects();
    const appendMessage = async (message: Message) => {
        if (options?.appendMessage) {
            await options.appendMessage(message);
            return;
        }
        await currentSessionEffects.appendMessage(session, message);
    };

    // Get persistent context
    const agentName = session.agent || 'main';
    const systemPrompt = session.persistentMemorySnapshot || await buildSessionSystemPromptSnapshot({
        agentName,
        sessionId: session.id,
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
        .map((message: Message): Message => {
            const { __meta, ...msg } = message;
            const modelId = getHistoricalConcreteModelId(message);
            return modelId ? { ...msg, __meta: { modelId } } : msg;
        });
    const availableToolDefinitions = options?.toolDefinitions
        ?? tools.modelFacingDefinitions;
    const previousPromptCacheKey = session.promptCacheKey;
    const promptCacheKey = ensurePromptCacheKey(session);
    if (session.id && session.promptCacheKey !== previousPromptCacheKey) {
        await currentSessionEffects.persistSession(session);
    }
    const result = await requestLlmOnce({
        contents: contentsForLlm,
        systemPrompt,
        model: session.model,
        effort: session.effort,
        sessionId: session.id,
        promptCacheKey,
        turnId: options?.turnId,
        iteration,
        toolDefinitions: availableToolDefinitions,
        notifySessionEvents: options?.notifySessionEvents,
        registerAbortController: options?.registerAbortController,
        abortSignal: options?.abortSignal,
        onRetry: options?.onRetry,
        purpose: options?.purpose || 'normal-turn',
        currentSessionEffects: options?.currentSessionEffects,
    });

    if (result.usage) {
        logger.info(`Token Usage: Cached: ${result.usage.cachedTokens || 0} | Input: ${result.usage.inputTokens} | Output: ${result.usage.outputTokens} | Reasoning: ${result.usage.reasoningTokens ?? 'n/a'} | Calls: ${(result.toolCalls || []).length}`);

        // Update session accumulated usage stats
        session.stats.totalInputTokens += result.usage.inputTokens || 0;
        session.stats.totalCachedTokens += result.usage.cachedTokens || 0;
        session.stats.totalOutputTokens += result.usage.outputTokens || 0;
    }

    // Add assistant message to history
    if (result.allParts && result.allParts.length > 0) {
        const llmRequestTiming = toPersistedLlmRequestTiming(result.previousLlmRequest);
        const assistantMeta = {
            ...(result.modelId ? { modelId: result.modelId } : {}),
            ...(result.virtualModelKey ? { virtualModelKey: result.virtualModelKey } : {}),
            ...(result.usage ? { usage: result.usage } : {}),
            ...(llmRequestTiming ? { llmRequestTiming } : {}),
            ...(result.llmRequestId ? { llmRequestId: result.llmRequestId, llmAttempt: result.llmAttempt } : {}),
        };
        const assistantMsg: Message = {
            role: 'model',
            parts: result.allParts,
            ...(result.providerMeta ? { providerMeta: result.providerMeta } : {}),
            ...(Object.keys(assistantMeta).length > 0 ? { __meta: assistantMeta } : {}),
        };
        await appendMessage(assistantMsg);
    }

    return result;
}

type ConcreteRequestPlan = {
    modelEntry: ModelConfigEntry;
    modelKey: string;
    modelId: string;
    providerType: string;
    requestedEffort?: ModelEffort;
    effectiveEffort: ModelEffort;
    effortFallback: boolean;
    url: string;
    headers: Record<string, any>;
    data: any;
    requestBody: any;
    compressionHeaders: Record<string, string>;
    useOpenAIResponsesApi: boolean;
    useOpenAIChatCompletionsApi: boolean;
    useStreamingApi: boolean;
};

function normalizeRequestedEffort(value: unknown): ModelEffort | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value !== 'string' || !MODEL_EFFORTS.includes(value as ModelEffort)) {
        throw new Error(`Model effort must be one of: ${MODEL_EFFORTS.join(', ')}.`);
    }
    return value as ModelEffort;
}

function isPlainRequestObject(value: unknown): value is Record<string, any> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function applyFirstClassEffort(
    data: Record<string, any>,
    providerType: string,
    effort: ModelEffort,
): void {
    const openaiRequestApi = getOpenAIRequestApi(providerType);
    if (openaiRequestApi === 'responses') {
        const reasoning = isPlainRequestObject(data.reasoning) ? { ...data.reasoning } : {};
        reasoning.effort = effort;
        const include = Array.isArray(data.include) ? [...data.include] : [];
        if (effort === 'none') {
            delete reasoning.summary;
            const filteredInclude = include.filter(item => item !== 'reasoning.encrypted_content');
            if (filteredInclude.length > 0) data.include = filteredInclude;
            else delete data.include;
        } else {
            if (!Object.prototype.hasOwnProperty.call(reasoning, 'summary')) reasoning.summary = 'auto';
            if (!include.includes('reasoning.encrypted_content')) include.push('reasoning.encrypted_content');
            data.include = include;
        }
        data.reasoning = reasoning;
        return;
    }
    if (openaiRequestApi === 'chat-completions') {
        data.reasoning_effort = effort;
        return;
    }

    if (effort === 'none') {
        data.thinking = { type: 'disabled' };
        if (isPlainRequestObject(data.output_config)) {
            const outputConfig = { ...data.output_config };
            delete outputConfig.effort;
            if (Object.keys(outputConfig).length > 0) data.output_config = outputConfig;
            else delete data.output_config;
        }
        return;
    }
    data.output_config = {
        ...(isPlainRequestObject(data.output_config) ? data.output_config : {}),
        effort,
    };
}

class ConcreteAttemptFailure extends Error {
    readonly kind: LlmRetryEvent['kind'];
    readonly status?: string;
    readonly retryable: boolean;
    readonly countable: boolean;
    readonly logDetail?: Record<string, any>;

    constructor(message: string, options: {
        kind: LlmRetryEvent['kind'];
        status?: string;
        retryable: boolean;
        countable: boolean;
        logDetail?: Record<string, any>;
    }) {
        super(message);
        this.name = 'ConcreteAttemptFailure';
        this.kind = options.kind;
        this.status = options.status;
        this.retryable = options.retryable;
        this.countable = options.countable;
        this.logDetail = options.logDetail;
    }
}

function collectProviderErrorStrings(value: unknown, strings: string[], structuredCodes: string[], depth = 0): void {
    if (depth > 8 || value === null || value === undefined) return;
    if (typeof value === 'string') {
        strings.push(value);
        const trimmed = value.trim();
        if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && depth < 8) {
            try {
                const parsed = JSON.parse(trimmed);
                if (parsed && typeof parsed === 'object') {
                    collectProviderErrorStrings(parsed, strings, structuredCodes, depth + 1);
                }
            } catch {
                // Provider error bodies are frequently plain text; JSON parsing
                // is only a best-effort path for streamed structured errors.
            }
        }
        return;
    }
    if (Array.isArray(value)) {
        for (const item of value) collectProviderErrorStrings(item, strings, structuredCodes, depth + 1);
        return;
    }
    if (typeof value !== 'object') return;
    for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
        if ((key === 'code' || key === 'type') && typeof nestedValue === 'string') {
            structuredCodes.push(nestedValue);
        }
        collectProviderErrorStrings(nestedValue, strings, structuredCodes, depth + 1);
    }
}

function isModelNotFoundProviderError(body: unknown): boolean {
    const strings: string[] = [];
    const structuredCodes: string[] = [];
    collectProviderErrorStrings(body, strings, structuredCodes);

    const structuredMatch = structuredCodes.some(value => {
        const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, '_');
        return /^model_(?:not_found|does_not_exist)(?:_error)?$/.test(normalized)
            || /^unknown_model(?:_error)?$/.test(normalized);
    });
    if (structuredMatch) return true;

    const text = strings.join('\n');
    const unknownModel = strings.some(value => {
        const match = /\bunknown\s+model\b/i.exec(value);
        if (!match) return false;
        const suffix = value.slice(match.index + match[0].length).trim();
        if (!suffix || /^[.:;,"'`]/.test(suffix)) return true;
        const token = suffix.split(/\s|[,;]/, 1)[0].replace(/[.!?]+$/, '');
        return /\d/.test(token) || /[/_-]/.test(token) || /\.[A-Za-z0-9]/.test(token);
    });
    return /\bmodel(?:[\s_-]+)not(?:[\s_-]+)found\b/i.test(text)
        || /\bno\s+such\s+model\b/i.test(text)
        || /\b(?:the\s+|requested\s+)?model\s+(?:"[^"]{1,200}"|'[^']{1,200}'|`[^`]{1,200}`|[^\s,;:]{1,200})\s+(?:was\s+)?not\s+found\b/i.test(text)
        || /\b(?:the\s+|requested\s+)?model\s+(?:"[^"]{1,200}"|'[^']{1,200}'|`[^`]{1,200}`|[^\s,;:]{1,200})\s+does\s+not\s+exist\b/i.test(text)
        || unknownModel;
}

export function classifyHttpFailure(statusCode: number, body: any): { retryable: boolean; countable: boolean } {
    if (isModelNotFoundProviderError(body)) {
        return { retryable: true, countable: true };
    }
    if (statusCode === 400 || statusCode === 413 || statusCode === 422) {
        return { retryable: false, countable: false };
    }
    if (statusCode === 401 || statusCode === 403 || statusCode === 404
        || statusCode === 408 || statusCode === 429 || statusCode === 529
        || (statusCode >= 500 && statusCode <= 599)) {
        return { retryable: true, countable: true };
    }
    // Preserve the previous retry behavior for other HTTP statuses without
    // allowing an unclassified client response to poison shared route health.
    return { retryable: true, countable: false };
}

function buildOpenAIWebSearchTool(config: NormalizedOpenAIWebSearchConfig | undefined): Record<string, any> | undefined {
    if (config?.enabled !== true) {
        return undefined;
    }

    const tool: Record<string, any> = { type: 'web_search' };
    if (config.searchContextSize && ['low', 'medium', 'high'].includes(config.searchContextSize)) {
        tool.search_context_size = config.searchContextSize;
    }

    const allowedDomains = Array.isArray(config.allowedDomains)
        ? config.allowedDomains
            .filter((domain): domain is string => typeof domain === 'string' && domain.trim().length > 0)
            .map(domain => domain.trim())
        : [];
    if (allowedDomains.length > 0) {
        tool.filters = { allowed_domains: allowedDomains };
    }

    if (config.userLocation && typeof config.userLocation === 'object') {
        const userLocation: Record<string, string> = { type: 'approximate' };
        for (const key of ['country', 'city', 'region', 'timezone'] as const) {
            const value = config.userLocation[key];
            if (typeof value === 'string' && value.trim().length > 0) {
                userLocation[key] = value.trim();
            }
        }
        tool.user_location = userLocation;
    }

    return tool;
}

function buildConcreteRequestPlan(options: {
    request: RequestLlmOnceOptions;
    fixedContents: Message[];
    modelEntry: ModelConfigEntry;
    modelKey: string;
    promptCacheKey: string;
    turnId: string;
    attempt: number;
    requestedEffort?: ModelEffort;
}): ConcreteRequestPlan {
    const { request, fixedContents, modelEntry, modelKey, promptCacheKey, turnId, attempt, requestedEffort } = options;
    const providerType = modelEntry?.providerType || 'openai';
    const baseUrl = modelEntry?.baseUrl;
    const apiKey = modelEntry?.apiKey || '';
    const modelName = modelEntry?.model || '';
    const modelId = getModelIdForMetadata(modelEntry, modelKey);
    const providerContents = prepareHistoryForConcreteModel(fixedContents, modelId);
    const openaiRequestApi = getOpenAIRequestApi(providerType);
    const useOpenAIResponsesApi = openaiRequestApi === 'responses';
    const useOpenAIChatCompletionsApi = openaiRequestApi === 'chat-completions';
    const useStreamingApi = useOpenAIResponsesApi || useOpenAIChatCompletionsApi;
    const webSearchConfig = useOpenAIResponsesApi
        && request.purpose !== 'compact-plan'
        && request.purpose !== 'setup-test'
        ? normalizeOpenAIWebSearchConfig(modelEntry.webSearch)
        : undefined;
    const webSearchTool = buildOpenAIWebSearchTool(webSearchConfig);
    const webSearchToolChoice = webSearchTool
        && (webSearchConfig?.toolChoice === 'required' || webSearchConfig?.toolChoice === 'auto')
        ? webSearchConfig.toolChoice
        : 'auto';
    const effortConfig = getConcreteModelEffortConfig(modelEntry);
    const effectiveEffort = requestedEffort && effortConfig.allowed.includes(requestedEffort)
        ? requestedEffort
        : effortConfig.default;
    const effortFallback = requestedEffort !== undefined && requestedEffort !== effectiveEffort;

    if (!baseUrl) {
        throw new Error(`Model config \`${modelKey}\` has no baseUrl`);
    }

    const availableToolDefinitions = request.toolDefinitions ?? [];
    let messages: any;
    let url: string;
    let headers: Record<string, any>;
    let data: any;

    if (useOpenAIResponsesApi) {
        messages = convertToOpenAIResponsesFormatProvider(providerContents, modelId);
        url = `${baseUrl}/responses`;
        headers = {
            'Content-Type': 'application/json',
            ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}),
            'user-agent': 'codex-tui/0.118.0 (Debian 13.0.0; x86_64) xterm.js_6.1.0-beta.191_ (codex-tui; 0.118.0)',
            'originator': 'codex-tui',
            'x-codex-turn-metadata': `{"session_id":"${promptCacheKey}","turn_id":"${
                crypto.createHash('md5').update(`turn_id_${request.sessionId || 'default'}_${Date.now()}_${attempt}`).digest('hex')
            }","sandbox":"seccomp"}`,
            'x-client-request-id': crypto.createHash('md5').update(`req_id_${request.sessionId || 'default'}_${Date.now()}_${attempt}`).digest('hex'),
        };
        data = {
            model: modelName,
            instructions: request.systemPrompt,
            input: [...messages],
            tools: availableToolDefinitions.length > 0 || webSearchTool ? [
                ...availableToolDefinitions.map(fd => ({
                    type: 'function',
                    name: fd.name,
                    description: fd.description,
                    parameters: fd.parameters,
                    strict: false,
                })),
                ...(webSearchTool ? [webSearchTool] : []),
            ] : undefined,
            tool_choice: webSearchToolChoice,
            parallel_tool_calls: true,
            reasoning: effectiveEffort === 'none' ? undefined : { summary: 'auto' },
            max_output_tokens: MAX_OUTPUT,
            store: false,
            include: effectiveEffort === 'none' ? undefined : ['reasoning.encrypted_content'],
            prompt_cache_key: promptCacheKey,
            stream: true,
        };
    } else if (useOpenAIChatCompletionsApi) {
        messages = convertToOpenAIFormatProvider(
            providerContents,
            modelId,
            modelEntry.historyReasoningField || 'reasoning_content',
        );
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
            stream: true,
            stream_options: { include_usage: true },
            messages: [
                ...(request.systemPrompt?.trim() ? [{ role: 'system', content: request.systemPrompt }] : []),
                ...messages,
            ],
            tools: availableToolDefinitions.length > 0 ? availableToolDefinitions.map(fd => ({
                type: 'function',
                function: {
                    name: fd.name,
                    description: fd.description,
                    parameters: fd.parameters,
                    strict: false,
                },
            })) : undefined,
        };
    } else {
        // Preserve current custom-provider behavior: any concrete provider type
        // not recognized as OpenAI-compatible uses Anthropic serialization.
        messages = convertToAnthropicFormat(providerContents, modelEntry);
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
            system: request.systemPrompt,
            messages,
            tools: availableToolDefinitions.length > 0 ? availableToolDefinitions.map(fd => ({
                name: fd.name,
                description: fd.description,
                input_schema: fd.parameters,
            })) : undefined,
        };
    }

    const templateVars: Record<string, string> = {
        SESSION_CACHE_KEY: promptCacheKey,
        TURN_ID: turnId,
    };
    const extraFields = expandTemplateVariables(modelEntry.extraFields || {}, templateVars);
    Object.assign(data, extraFields);
    applyFirstClassEffort(data, providerType, effectiveEffort);

    const sanitizedRequestPayload = sanitizeProviderRequestPayload(data);
    if (sanitizedRequestPayload.replacementCount > 0) {
        data = sanitizedRequestPayload.value;
        logger.warn({
            replacementCount: sanitizedRequestPayload.replacementCount,
            paths: sanitizedRequestPayload.paths.slice(0, 20),
            omittedPathCount: Math.max(0, sanitizedRequestPayload.paths.length - 20),
            providerType,
            modelKey,
            sessionId: request.sessionId,
        }, 'Sanitized lone surrogate code units from provider request payload');
    }

    const { requestBody, requestHeaders: compressionHeaders } = maybeCompressLlmRequestBody(data, modelEntry);
    return {
        modelEntry,
        modelKey,
        modelId,
        providerType,
        requestedEffort,
        effectiveEffort,
        effortFallback,
        url,
        headers: {
            ...headers,
            ...expandTemplateVariables(modelEntry.extraHeaders || {}, templateVars),
        },
        data,
        requestBody,
        compressionHeaders,
        useOpenAIResponsesApi,
        useOpenAIChatCompletionsApi,
        useStreamingApi,
    };
}

function parseConcreteProviderResponse(plan: ConcreteRequestPlan, resp: any): ChatResult {
    let responseText = '';
    const allParts: Message['parts'] = [];
    let messageProviderMeta: ChatResult['providerMeta'];

    if (plan.useOpenAIResponsesApi) {
        const outputItems = Array.isArray(resp?.output) ? resp.output : [];
        for (const item of outputItems) {
            if (item.type === 'web_search_call') {
                // Hosted Responses tools are completed by OpenAI inside this
                // request. Keep the output item for same-model history replay,
                // but never expose it as a Foxwarm function call.
                allParts.push({
                    providerMeta: {
                        openaiResponses: {
                            sourceModelId: plan.modelId,
                            outputItem: item,
                        },
                    },
                });
                continue;
            }
            if (item.type === 'reasoning') {
                const summaryText = Array.isArray(item.summary)
                    ? item.summary.map((entry: any) => entry?.text || entry?.summary || '').filter(Boolean).join('\n')
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
                    if (contentPart.type === 'output_text' && typeof contentPart.text === 'string') {
                        responseText += contentPart.text;
                        const annotations = Array.isArray(contentPart.annotations) && contentPart.annotations.length > 0
                            ? contentPart.annotations
                            : undefined;
                        allParts.push({
                            text: contentPart.text,
                            ...(annotations ? {
                                providerMeta: {
                                    openaiResponses: {
                                        sourceModelId: plan.modelId,
                                        annotations,
                                    },
                                },
                            } : {}),
                        });
                    } else if (contentPart.type === 'refusal' && typeof contentPart.refusal === 'string') {
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
                    logger.warn({ providerType: plan.providerType, callId, toolName: item.name, rawArgsText: parsedArgs.rawArgsText }, 'Failed to parse OpenAI Responses tool arguments; converting to structured tool error');
                }
                allParts.push({ functionCall: { id: callId, name: item.name, ...parsedArgs } });
            }
        }
    } else if (plan.useOpenAIChatCompletionsApi) {
        const choice = resp?.choices?.[0];
        const message = choice?.message;
        if (
            message?.provider_specific_fields
            && typeof message.provider_specific_fields === 'object'
            && !Array.isArray(message.provider_specific_fields)
        ) {
            messageProviderMeta = {
                providerSpecificFields: message.provider_specific_fields,
                sourceModelId: plan.modelId,
            };
        }
        const reasoningContent = message?.reasoning_content
            || (typeof message?.reasoning === 'string' ? message.reasoning : undefined);
        if (reasoningContent) {
            logger.info({ reasoningLength: reasoningContent.length }, 'Received reasoning content from OpenAI');
            allParts.push({ thinking: reasoningContent });
        }
        if (typeof message?.content === 'string') {
            responseText = message.content;
            allParts.push({ text: message.content });
        }
        if (Array.isArray(message?.tool_calls)) {
            for (const toolCall of message.tool_calls) {
                if (toolCall.type === 'function') {
                    const parsedArgs = parseFunctionCallArgs(toolCall.function.arguments);
                    if (parsedArgs.argsParseError) {
                        logger.warn({ providerType: plan.providerType, callId: toolCall.id, toolName: toolCall.function.name, rawArgsText: parsedArgs.rawArgsText }, 'Failed to parse OpenAI chat tool arguments; converting to structured tool error');
                    }
                    allParts.push({
                        functionCall: { id: toolCall.id, name: toolCall.function.name, ...parsedArgs },
                    });
                }
            }
        }
    } else if (Array.isArray(resp?.content)) {
        for (const rawBlock of resp.content) {
            const block = rawBlock as AnthropicContentBlock;
            if (block.type === 'text') {
                const blockText = typeof block.text === 'string' ? block.text : '';
                const extractedParts = blockText ? extractAnthropicThinkingTaggedParts(blockText) : null;
                if (extractedParts) {
                    for (const part of extractedParts) {
                        if (part.text) responseText += part.text;
                        allParts.push(part);
                    }
                } else {
                    responseText += blockText;
                    allParts.push({ text: blockText });
                }
            } else if (block.type === 'thinking') {
                const thinkingPart: MessagePart = { thinking: block.thinking };
                if (block.signature) thinkingPart.providerMeta = { signature: block.signature };
                allParts.push(thinkingPart);
            } else if (block.type === 'tool_use') {
                allParts.push({ functionCall: { id: block.id, name: block.name, args: block.input } });
            }
        }
    }

    const toolCalls = allParts.filter(part => !!part.functionCall).map(part => part.functionCall!);
    if (!responseText.trim() && toolCalls.length === 0) {
        throw new ConcreteAttemptFailure('Model response contained no non-whitespace content or tool call', {
            kind: 'response-error',
            retryable: true,
            countable: true,
        });
    }

    const getReportedReasoningTokens = (value: unknown): number | undefined =>
        typeof value === 'number' && Number.isFinite(value) ? value : undefined;

    let usage: TokenUsage = null;
    if (plan.useOpenAIResponsesApi) {
        const cached = resp?.usage?.input_tokens_details?.cached_tokens || 0;
        // OpenAI Responses exposes this output component as
        // usage.output_tokens_details.reasoning_tokens. output_tokens remains
        // the complete output count, including reasoning.
        const reasoningTokens = getReportedReasoningTokens(resp?.usage?.output_tokens_details?.reasoning_tokens);
        usage = resp?.usage ? {
            inputTokens: resp.usage.input_tokens - cached,
            outputTokens: resp.usage.output_tokens,
            cachedTokens: cached,
            ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
        } : null;
    } else if (plan.useOpenAIChatCompletionsApi) {
        const cached = resp?.usage?.prompt_tokens_details?.cached_tokens || 0;
        // OpenAI Chat Completions exposes this output component as
        // usage.completion_tokens_details.reasoning_tokens. completion_tokens
        // remains the complete output count, including reasoning.
        const reasoningTokens = getReportedReasoningTokens(resp?.usage?.completion_tokens_details?.reasoning_tokens);
        usage = resp?.usage ? {
            inputTokens: resp.usage.prompt_tokens - cached,
            outputTokens: resp.usage.completion_tokens,
            cachedTokens: cached,
            ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
        } : null;
    } else {
        usage = resp?.usage ? {
            inputTokens: resp.usage.input_tokens,
            outputTokens: resp.usage.output_tokens,
            cachedTokens: resp.usage.cache_read_input_tokens || 0,
        } : null;
    }

    return {
        text: responseText,
        modelId: plan.modelId,
        usage,
        toolCalls,
        allParts: allParts.length > 0 ? allParts : undefined,
        ...(messageProviderMeta ? { providerMeta: messageProviderMeta } : {}),
    };
}

export async function requestLlmOnce(options: RequestLlmOnceOptions): Promise<ChatResult> {
    // Repair the provider-neutral source form first. This exact canonical
    // array is journaled before clone-only provider hydration, so durable
    // session image references are never expanded into provider base64 here.
    const canonicalContents = fixToolCalls(structuredClone(options.contents || []));
    const fixedContents = await hydrateMessagesForProvider(canonicalContents);
    const resolvedModel = options.modelsConfigOverride
        ? (() => {
            const modelsConfig = options.modelsConfigOverride!;
            const defaultKey = modelsConfig.default;
            const currentKey = options.model && modelsConfig.models[options.model] ? options.model : defaultKey;
            return {
                modelsConfig,
                defaultKey,
                currentKey,
                modelEntry: modelsConfig.models[currentKey] || modelsConfig.models[defaultKey],
            };
        })()
        : resolveModelConfig(options.model);
    const routeEntry = options.modelEntryOverride || resolvedModel.modelEntry;
    const routeKey = options.modelEntryOverride
        ? `${options.modelEntryOverride.providerKey || 'setup'}/${options.modelEntryOverride.model || 'model'}`
        : resolvedModel.currentKey;
    if (!routeEntry) {
        throw new Error(`Unable to resolve model config for \`${routeKey}\`.`);
    }
    if (options.modelEntryOverride && isVirtualModelConfigEntry(routeEntry)) {
        throw new Error('modelEntryOverride does not support virtual model routing; select a configured model key instead.');
    }

    // Activation is an independent-request boundary. Retries use this captured
    // generation and cannot reactivate an obsolete configuration fingerprint.
    const virtualRoutingRequest: VirtualRoutingRequest | undefined = isVirtualModelConfigEntry(routeEntry)
        ? beginVirtualRoutingRequest(routeKey, routeEntry)
        : undefined;
    if (!virtualRoutingRequest) clearVirtualRoutingState(routeKey);

    // Resolve once per outer request. Every retry attempt, including virtual
    // failover attempts, shares this prefix-lineage routing key.
    const promptCacheKey = await resolvePromptCacheKeyForRequest(options);
    // A low-level caller may omit the turn identity. Keep one generated value
    // for this whole request so retries expand `${TURN_ID}` consistently;
    // normal session turns provide their own value from SessionTurnRunner.
    const turnId = options.turnId || randomUUID();
    // Resolve the provider-neutral requested effort once for this entire outer
    // request. Each physical concrete attempt may fall back independently to
    // its leaf default when the selected leaf does not allow that request.
    const requestedEffort = normalizeRequestedEffort(options.effort);
    // Completeness boundary: all content-addressed canonical inputs and the
    // request manifest are durable before any provider attempt can be sent.
    const { requestId } = await beginLlmRequestJournal({
        sessionId: options.sessionId,
        purpose: options.purpose || 'low-level',
        iteration: options.iteration || 0,
        systemPrompt: options.systemPrompt || '',
        toolDefinitions: options.toolDefinitions || [],
        messages: canonicalContents,
        requestedModelKey: routeKey,
        promptCacheKey,
    });
    const requestedMaxAttempts = options.maxRetries ?? DEFAULT_LLM_MAX_ATTEMPTS;
    const maxAttempts = Number.isFinite(requestedMaxAttempts)
        ? Math.max(1, Math.floor(requestedMaxAttempts))
        : DEFAULT_LLM_MAX_ATTEMPTS;
    const iteration = options.iteration || 0;
    const responseAttempts: any[] = [];
    const abortController = new AbortController();
    const abortFromCaller = () => abortController.abort();
    if (options.abortSignal?.aborted) abortController.abort();
    else options.abortSignal?.addEventListener('abort', abortFromCaller, { once: true });
    const shouldRegisterAbortController = options.registerAbortController !== false && !!options.sessionId;
    const shouldNotifySessionEvents = options.notifySessionEvents !== false && !!options.sessionId;
    const modelStreamEmitter = createModelStreamEventEmitter({
        enabled: shouldNotifySessionEvents,
        sessionId: options.sessionId,
        iteration,
        currentSessionEffects: options.currentSessionEffects,
    });
    let logFiles: LlmInteractionLogFiles | null = null;
    const virtualRequestSelections: Array<{
        attempt: number;
        modelId: string;
        requestedEffort?: ModelEffort;
        effectiveEffort: ModelEffort;
        effortFallback: boolean;
    }> = [];
    let requestStartedAt: number | undefined;

    const notifyRetry = async (event: LlmRetryEvent): Promise<void> => {
        if (!options.onRetry) return;
        try {
            await options.onRetry(event);
        } catch (error) {
            logger.warn({ err: error, sessionId: options.sessionId, attempt: event.attempt }, 'LLM retry notification failed');
        }
    };

    if (shouldRegisterAbortController) {
        if (options.currentSessionEffects) options.currentSessionEffects.registerAbortController(options.sessionId!, abortController);
        else sessionManager.registerSessionAbortController(options.sessionId!, abortController);
    }
    if (shouldNotifySessionEvents) modelStreamEmitter.reset();

    try {
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            if (attempt > 1 && shouldNotifySessionEvents) modelStreamEmitter.reset();

            let selection: VirtualTargetSelection | undefined;
            let modelEntry = routeEntry;
            let modelKey = routeKey;
            if (virtualRoutingRequest) {
                selection = selectVirtualTarget(virtualRoutingRequest, promptCacheKey);
                modelKey = selection.targetKey;
                const concreteEntry = resolvedModel.modelsConfig.models[modelKey];
                if (!concreteEntry || isVirtualModelConfigEntry(concreteEntry)) {
                    throw new Error(`Virtual model \`${routeKey}\` resolved invalid concrete target \`${modelKey}\`.`);
                }
                modelEntry = concreteEntry;
            }

            const plan = buildConcreteRequestPlan({
                request: options,
                fixedContents,
                modelEntry,
                modelKey,
                promptCacheKey,
                turnId,
                attempt,
                requestedEffort,
            });
            await appendLlmAttemptStart({
                requestId,
                attempt,
                concreteModelId: plan.modelId,
                ...(isVirtualModelConfigEntry(routeEntry) ? { virtualModelKey: routeKey } : {}),
                providerType: plan.providerType,
                semanticPayload: plan.data,
            });
            logger.info({
                modelKey,
                providerType: plan.providerType,
                requestedEffort: plan.requestedEffort || 'default',
                effectiveEffort: plan.effectiveEffort,
                effortFallback: plan.effortFallback,
                iteration,
                attempt,
                maxAttempts,
                ...(isVirtualModelConfigEntry(routeEntry) ? { virtualModelKey: routeKey } : {}),
            }, 'Requesting LLM');
            if (isVirtualModelConfigEntry(routeEntry)) {
                virtualRequestSelections.push({
                    attempt,
                    modelId: plan.modelId,
                    requestedEffort: plan.requestedEffort,
                    effectiveEffort: plan.effectiveEffort,
                    effortFallback: plan.effortFallback,
                });
                const virtualRequestLog = {
                    virtualModelKey: routeKey,
                    selections: virtualRequestSelections,
                    selectedModelId: plan.modelId,
                    request: plan.data,
                };
                if (!logFiles) {
                    logFiles = await logRequest(virtualRequestLog, iteration);
                } else {
                    await fs.writeJson(logFiles.requestPath, redactProviderImagesForLog(virtualRequestLog), { spaces: 2 }).catch(error => {
                        logger.warn({ err: error, virtualModelKey: routeKey, attempt }, 'Failed to update virtual LLM request log');
                    });
                }
            } else if (!logFiles) {
                logFiles = await logRequest(plan.data, iteration);
            }

            let attemptRawStreamLog: ReturnType<typeof createRawStreamLogCapture> | null = null;
            let resp: any;
            let response: AxiosResponse | undefined;
            try {
                if (requestStartedAt === undefined) {
                    requestStartedAt = performance.now();
                }
                logger.debug({ modelKey, iteration, attempt, url: plan.url }, 'Dispatching LLM HTTP request');
                response = await axios.post(plan.url, plan.requestBody, {
                    headers: { ...plan.headers, ...plan.compressionHeaders },
                    timeout: options.timeoutMs ?? DEFAULT_LLM_REQUEST_TIMEOUT_MS,
                    validateStatus: () => true,
                    signal: abortController.signal,
                    ...(plan.useStreamingApi ? { responseType: 'stream' as const } : {}),
                });

                if (response.status !== 200) {
                    const errorBody = plan.useStreamingApi
                        ? await readStreamAsText(response.data, abortController.signal)
                        : response.data;
                    const status = `${response.status} ${response.statusText}`.trim();
                    const classification = classifyHttpFailure(response.status, errorBody);
                    throw new ConcreteAttemptFailure(summarizeRetryReason(errorBody || status), {
                        kind: 'http-error',
                        status,
                        ...classification,
                        logDetail: { headers: response.headers, body: errorBody },
                    });
                }

                if (plan.useStreamingApi) {
                    attemptRawStreamLog = createRawStreamLogCapture();
                    const streamCollectOptions = {
                        onProgress: shouldNotifySessionEvents
                            ? (snapshot: any) => modelStreamEmitter.emit(snapshot)
                            : undefined,
                        onRawChunk: (text: string) => attemptRawStreamLog?.appendChunk(text),
                        onRawSseBlock: (block: string) => attemptRawStreamLog?.appendSseBlock(block),
                    };
                    resp = plan.useOpenAIResponsesApi
                        ? await collectOpenAIResponsesStreamProvider(response.data, abortController.signal, streamCollectOptions)
                        : await collectOpenAIChatCompletionsStreamProvider(response.data, abortController.signal, streamCollectOptions);
                } else {
                    resp = response.data;
                }

                const result = parseConcreteProviderResponse(plan, resp);
                const completedAt = Date.now();
                const durationMs = Math.max(0, performance.now() - requestStartedAt);
                if (virtualRoutingRequest && selection) {
                    recordVirtualTargetSuccess(virtualRoutingRequest, selection.targetKey);
                }
                await logResponse({
                    status: `${response.status} ${response.statusText}`.trim(),
                    headers: response.headers,
                    body: resp,
                    ...(attemptRawStreamLog ? { rawStream: attemptRawStreamLog.snapshot() } : {}),
                    ...(responseAttempts.length > 0 ? { attempts: responseAttempts } : {}),
                }, logFiles);
                // A post-response journal failure must never enter the provider
                // retry path and generate a duplicate successful completion.
                // Attempt-start remains durable and exposes the incomplete
                // result; normal session delivery proceeds.
                const previousLlmRequest = { completedAt, durationMs };
                const completedResult: ChatResult = virtualRoutingRequest
                    ? { ...result, virtualModelKey: routeKey, previousLlmRequest, llmRequestId: requestId, llmAttempt: attempt }
                    : { ...result, previousLlmRequest, llmRequestId: requestId, llmAttempt: attempt };
                await appendLlmAttemptResult({
                    requestId,
                    attempt,
                    outcome: 'success',
                    result: completedResult,
                }).catch(error => logger.error({ err: error, requestId, attempt }, 'Failed to append successful LLM attempt result after provider response'));
                return completedResult;
            } catch (error: any) {
                if (isAbortError(error)) {
                    responseAttempts.push({
                        attempt,
                        modelId: plan.modelId,
                        requestedEffort: plan.requestedEffort || 'default',
                        effectiveEffort: plan.effectiveEffort,
                        effortFallback: plan.effortFallback,
                        ...(isVirtualModelConfigEntry(routeEntry) ? { virtualModelKey: routeKey } : {}),
                        kind: 'abort',
                        error: error?.message || String(error),
                        code: error?.code,
                        name: error?.name,
                        ...(attemptRawStreamLog ? { rawStream: attemptRawStreamLog.snapshot() } : {}),
                    });
                    await logResponse({ attempts: responseAttempts }, logFiles);
                    await appendLlmAttemptResult({ requestId, attempt, outcome: 'abort', error: { message: error?.message || String(error), code: error?.code, name: error?.name } })
                        .catch(journalError => logger.error({ err: journalError, requestId, attempt }, 'Failed to append aborted LLM attempt result'));
                    await moveInteractionLogsToErrorDir(logFiles);
                    throw error;
                }

                const failure = error instanceof ConcreteAttemptFailure
                    ? error
                    : new ConcreteAttemptFailure(summarizeRetryReason(error), {
                        kind: 'request-error',
                        status: (error as AxiosResponse)?.status ? String((error as AxiosResponse).status) : undefined,
                        retryable: true,
                        countable: true,
                        logDetail: {
                            error: error?.message || String(error),
                            code: error?.code,
                            name: error?.name,
                            ...(attemptRawStreamLog ? { rawStream: attemptRawStreamLog.snapshot() } : {}),
                        },
                    });

                responseAttempts.push({
                    attempt,
                    modelId: plan.modelId,
                    requestedEffort: plan.requestedEffort || 'default',
                    effectiveEffort: plan.effectiveEffort,
                    effortFallback: plan.effortFallback,
                    ...(isVirtualModelConfigEntry(routeEntry) ? { virtualModelKey: routeKey } : {}),
                    kind: failure.kind,
                    status: failure.status,
                    error: failure.message,
                    ...(failure.logDetail || (failure.kind === 'response-error' ? {
                        headers: response?.headers,
                        body: resp,
                        ...(attemptRawStreamLog ? { rawStream: attemptRawStreamLog.snapshot() } : {}),
                    } : {})),
                });
                await logResponse({ attempts: responseAttempts }, logFiles);
                await appendLlmAttemptResult({
                    requestId,
                    attempt,
                    outcome: 'failure',
                    error: { kind: failure.kind, status: failure.status, message: failure.message, retryable: failure.retryable, countable: failure.countable },
                }).catch(journalError => logger.error({ err: journalError, requestId, attempt }, 'Failed to append failed LLM attempt result'));
                logger.error({
                    modelId: plan.modelId,
                    virtualModelKey: isVirtualModelConfigEntry(routeEntry) ? routeKey : undefined,
                    kind: failure.kind,
                    status: failure.status,
                }, `LLM attempt failed (${attempt}/${maxAttempts})`);

                let routeTerminal = false;
                if (failure.countable && virtualRoutingRequest && selection) {
                    routeTerminal = recordVirtualTargetFailure(virtualRoutingRequest, selection).terminal;
                }
                const final = !failure.retryable || routeTerminal || attempt === maxAttempts;
                const retryEvent: LlmRetryEvent = {
                    attempt,
                    maxRetries: maxAttempts,
                    kind: failure.kind,
                    reason: failure.message,
                    status: failure.status,
                    modelId: plan.modelId,
                    ...(isVirtualModelConfigEntry(routeEntry) ? { virtualModelKey: routeKey } : {}),
                };
                if (final) {
                    await notifyRetry({ ...retryEvent, final: true });
                    await moveInteractionLogsToErrorDir(logFiles);
                    throw new LlmRequestError(`API request failed after ${attempt} attempts: ${failure.message}`, {
                        modelId: plan.modelId,
                        attempt,
                        maxRetries: maxAttempts,
                        kind: failure.kind,
                        status: failure.status,
                        attempts: responseAttempts,
                    });
                }

                const delayMs = getLlmRetryDelayMs(attempt);
                await notifyRetry({
                    ...retryEvent,
                    nextAttempt: attempt + 1,
                    delayMs,
                });
                await sleepWithSignal(delayMs, abortController.signal);
            }
        }
    } finally {
        options.abortSignal?.removeEventListener('abort', abortFromCaller);
        modelStreamEmitter.flush();
        if (shouldRegisterAbortController) {
            if (options.currentSessionEffects) options.currentSessionEffects.clearAbortController(options.sessionId!, abortController);
            else sessionManager.clearSessionAbortController(options.sessionId!, abortController);
        }
    }

    throw new LlmRequestError(`API request failed after ${maxAttempts} attempts`, {
        maxRetries: maxAttempts,
        attempts: responseAttempts,
    });
}
