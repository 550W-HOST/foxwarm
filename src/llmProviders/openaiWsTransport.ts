import crypto from 'crypto';
import { PassThrough } from 'stream';
import WebSocket, { RawData } from 'ws';
import { hashJournalValue } from '../llmRequestJournal';
import { collectOpenAIResponsesStream, OpenAIStreamProgressSnapshot } from './openai';
import {
    extendOpenAIWsPrefix,
    fingerprintOpenAIWsRequest,
    OpenAIWsCompletedChain,
    OpenAIWsCompletedChainPool,
} from './openaiWsState';

const OPENAI_WS_MAX_CHAIN_AGE_MS = 60 * 60 * 1000;
const OPENAI_WS_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const OPENAI_WS_LOCAL_IDLE_LIMIT = 5;
const OPENAI_WS_WORKER_IDLE_LIMIT = 1;

type SocketLike = Pick<WebSocket, 'readyState' | 'send' | 'close' | 'terminate' | 'on' | 'once' | 'off'> & {
    _socket?: { ref?: () => void; unref?: () => void };
};

type OpenAIWsResource = {
    socket: SocketLike;
    id: string;
    removeIdleListeners?: () => void;
};

type OpenAIWsRequestOptions = {
    url: string;
    headers: Record<string, any>;
    concreteIdentity: string;
    data: Record<string, any>;
    placement: 'local' | 'session-worker';
    signal: AbortSignal;
    timeoutMs: number;
    onProgress?: (snapshot: OpenAIStreamProgressSnapshot) => void;
    onRawFrame?: (frame: string) => void;
};

export type OpenAIWsPendingCompletion = {
    response: any;
    finalize(replayItems: readonly unknown[] | false): void;
};

type SocketFactory = (url: string, headers: Record<string, any>) => SocketLike;
type IdleTimer = { unref?: () => void };
type IdleTimerHooks = {
    set(callback: () => void, delayMs: number): IdleTimer;
    clear(timer: IdleTimer): void;
};

let socketSequence = 0;
let now = () => Date.now();
let socketFactory: SocketFactory = (url, headers) => new WebSocket(url, { headers });
let idleTimers: IdleTimerHooks = {
    set: (callback, delayMs) => setTimeout(callback, delayMs),
    clear: timer => clearTimeout(timer as NodeJS.Timeout),
};

function closeResource(resource: OpenAIWsResource): void {
    try {
        resource.removeIdleListeners?.();
        resource.removeIdleListeners = undefined;
        if (resource.socket.readyState === WebSocket.OPEN || resource.socket.readyState === WebSocket.CONNECTING) {
            resource.socket.terminate();
        }
    } catch {}
}

const completedPool = new OpenAIWsCompletedChainPool<OpenAIWsResource>(closeResource);

function makeAbortError(message = 'The operation was aborted'): Error & { code: string } {
    const error = new Error(message) as Error & { code: string };
    error.name = 'AbortError';
    error.code = 'ABORT_ERR';
    return error;
}

function toWebSocketUrl(httpUrl: string): string {
    const url = new URL(httpUrl);
    if (url.protocol === 'https:') url.protocol = 'wss:';
    else if (url.protocol === 'http:') url.protocol = 'ws:';
    else if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
        throw new Error(`OpenAI Responses WebSocket requires an HTTP(S) or WS(S) base URL; received ${url.protocol}`);
    }
    return url.toString();
}

function connectionFingerprint(url: string, headers: Record<string, any>, concreteIdentity: string): string {
    return hashJournalValue({ url, headers, concreteIdentity });
}

function normalizeFrame(data: RawData | unknown): string {
    if (typeof data === 'string') return data;
    if (Buffer.isBuffer(data)) return data.toString('utf8');
    if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
    if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
    if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
    return String(data);
}

function openSocket(url: string, headers: Record<string, any>, signal: AbortSignal): Promise<OpenAIWsResource> {
    if (signal.aborted) return Promise.reject(makeAbortError());
    const socket = socketFactory(url, headers);
    const resource = { socket, id: `openai-ws-${process.pid}-${++socketSequence}-${crypto.randomUUID()}` };
    return new Promise((resolve, reject) => {
        let settled = false;
        const cleanup = () => {
            signal.removeEventListener('abort', onAbort);
            socket.off('open', onOpen);
            socket.off('error', onError);
            socket.off('close', onClose);
            socket.off('unexpected-response', onUnexpectedResponse as any);
        };
        const finish = (callback: () => void) => {
            if (settled) return;
            settled = true;
            cleanup();
            callback();
        };
        const onAbort = () => finish(() => {
            closeResource(resource);
            reject(makeAbortError());
        });
        const onOpen = () => finish(() => {
            resolve(resource);
        });
        const onError = (error: Error) => finish(() => {
            closeResource(resource);
            reject(error);
        });
        const onClose = (code: number, reason: Buffer) => finish(() => reject(new Error(
            `OpenAI Responses WebSocket closed during handshake (${code}${reason?.length ? `: ${reason.toString('utf8')}` : ''}).`,
        )));
        const onUnexpectedResponse = (_request: unknown, response: any) => finish(() => {
            closeResource(resource);
            const error: any = new Error(`OpenAI Responses WebSocket handshake failed with HTTP ${response?.statusCode || 'unknown'}.`);
            error.statusCode = response?.statusCode;
            reject(error);
        });
        signal.addEventListener('abort', onAbort, { once: true });
        socket.once('open', onOpen);
        socket.once('error', onError);
        socket.once('close', onClose);
        socket.once('unexpected-response', onUnexpectedResponse as any);
    });
}

function installIdleRemoval(chain: OpenAIWsCompletedChain<OpenAIWsResource>): void {
    let idleTimer: IdleTimer | undefined;
    const remove = () => {
        completedPool.remove(chain.id);
        chain.resource.removeIdleListeners?.();
        chain.resource.removeIdleListeners = undefined;
    };
    const removeAfterError = () => {
        remove();
        closeResource(chain.resource);
    };
    chain.resource.socket.once('close', remove);
    chain.resource.socket.once('error', removeAfterError);
    chain.resource.removeIdleListeners = () => {
        chain.resource.socket.off('close', remove);
        chain.resource.socket.off('error', removeAfterError);
        if (idleTimer) {
            idleTimers.clear(idleTimer);
            idleTimer = undefined;
        }
    };
    idleTimer = idleTimers.set(() => {
        idleTimer = undefined;
        if (completedPool.remove(chain.id)) closeResource(chain.resource);
    }, OPENAI_WS_IDLE_TIMEOUT_MS);
    idleTimer.unref?.();
    chain.resource.socket._socket?.unref?.();
}

export async function requestOpenAIResponsesWs(options: OpenAIWsRequestOptions): Promise<OpenAIWsPendingCompletion> {
    if (options.signal.aborted) throw makeAbortError();
    const wsUrl = toWebSocketUrl(options.url);
    const fingerprint = fingerprintOpenAIWsRequest(options.data);
    const connectionId = connectionFingerprint(wsUrl, options.headers, options.concreteIdentity);
    const matched = completedPool.takeLongest(connectionId, fingerprint, {
        now: now(),
        maxAgeMs: OPENAI_WS_MAX_CHAIN_AGE_MS,
    });
    matched?.chain.resource.removeIdleListeners?.();
    if (matched) matched.chain.resource.removeIdleListeners = undefined;
    const resource = matched?.chain.resource || await openSocket(wsUrl, options.headers, options.signal);
    resource.socket._socket?.ref?.();
    const input = Array.isArray(options.data.input) ? options.data.input : [];
    const responseRequest: Record<string, any> = {
        ...options.data,
        input: input.slice(matched?.appendFromItemIndex || 0),
    };
    delete responseRequest.stream;
    delete responseRequest.previous_response_id;
    if (matched) {
        responseRequest.previous_response_id = matched.chain.previousResponseId;
        delete responseRequest.max_output_tokens;
    }

    const stream = new PassThrough();
    let phase: 'active' | 'pending' | 'finished' = 'active';
    let pendingInvalidated = false;
    let completed = false;
    let timer: NodeJS.Timeout | undefined;

    const closeLeased = () => closeResource(resource);
    const cleanupStreaming = () => {
        if (timer) clearTimeout(timer);
        resource.socket.off('message', onMessage as any);
    };
    const cleanupAll = () => {
        cleanupStreaming();
        options.signal.removeEventListener('abort', onAbort);
        resource.socket.off('close', onClose as any);
        resource.socket.off('error', onError as any);
    };
    const invalidatePending = (close: boolean) => {
        if (phase !== 'pending') return;
        pendingInvalidated = true;
        phase = 'finished';
        cleanupAll();
        if (close) closeLeased();
    };
    const onAbort = () => {
        if (phase === 'finished') return;
        if (phase === 'pending') {
            invalidatePending(true);
            return;
        }
        phase = 'finished';
        closeLeased();
        stream.destroy(makeAbortError());
    };
    const onClose = (code: number, reason: Buffer) => {
        if (phase === 'finished') return;
        if (phase === 'pending') {
            invalidatePending(false);
            return;
        }
        phase = 'finished';
        stream.destroy(new Error(`OpenAI Responses WebSocket closed before completion (${code}${reason?.length ? `: ${reason.toString('utf8')}` : ''}).`));
    };
    const onError = (error: Error) => {
        if (phase === 'finished') return;
        if (phase === 'pending') {
            invalidatePending(true);
            return;
        }
        phase = 'finished';
        stream.destroy(error);
    };
    const onMessage = (raw: RawData) => {
        if (phase !== 'active') return;
        const frame = normalizeFrame(raw);
        options.onRawFrame?.(frame);
        let event: any;
        try {
            event = JSON.parse(frame);
        } catch {
            phase = 'finished';
            closeLeased();
            stream.destroy(new Error('OpenAI Responses WebSocket received a malformed JSON frame.'));
            return;
        }
        stream.write(`data: ${frame}\n\n`);
        if (event?.type === 'response.completed') {
            completed = true;
            phase = 'pending';
            cleanupStreaming();
            stream.end();
        }
    };

    options.signal.addEventListener('abort', onAbort, { once: true });
    resource.socket.on('message', onMessage as any);
    resource.socket.once('close', onClose as any);
    resource.socket.once('error', onError as any);
    timer = setTimeout(() => {
        if (phase !== 'active') return;
        phase = 'finished';
        closeLeased();
        stream.destroy(new Error(`OpenAI Responses WebSocket request timed out after ${options.timeoutMs}ms.`));
    }, options.timeoutMs);
    timer.unref?.();

    try {
        const envelope = JSON.stringify({ type: 'response.create', ...responseRequest });
        resource.socket.send(envelope);
        const response = await collectOpenAIResponsesStream(stream, options.signal, {
            onProgress: options.onProgress,
        });
        cleanupStreaming();
        const responseId = typeof response?.id === 'string' && response.id.trim() ? response.id.trim() : '';
        if (!completed || pendingInvalidated || options.signal.aborted
            || resource.socket.readyState !== WebSocket.OPEN
            || !responseId || (response?.status && response.status !== 'completed')) {
            phase = 'finished';
            cleanupAll();
            closeLeased();
            throw new Error('OpenAI Responses WebSocket returned an incomplete completion or omitted its response id.');
        }
        let finalized = false;
        return {
            response,
            finalize(replayItems) {
                if (finalized) return;
                finalized = true;
                const reusable = replayItems !== false
                    && !pendingInvalidated
                    && !options.signal.aborted
                    && resource.socket.readyState === WebSocket.OPEN;
                phase = 'finished';
                cleanupAll();
                if (!reusable) {
                    closeLeased();
                    return;
                }
                const expected = extendOpenAIWsPrefix(fingerprint.finalPrefix, replayItems as readonly unknown[]);
                const timestamp = now();
                const chain: OpenAIWsCompletedChain<OpenAIWsResource> = {
                    id: resource.id,
                    resource,
                    connectionFingerprint: connectionId,
                    invariantHash: fingerprint.invariantHash,
                    expectedPrefixHash: expected.hash,
                    expectedPrefixItemCount: expected.itemCount,
                    previousResponseId: responseId,
                    createdAt: matched?.chain.createdAt || timestamp,
                    lastUsedAt: timestamp,
                };
                installIdleRemoval(chain);
                completedPool.release(chain, options.placement === 'session-worker'
                    ? OPENAI_WS_WORKER_IDLE_LIMIT
                    : OPENAI_WS_LOCAL_IDLE_LIMIT);
            },
        };
    } catch (error) {
        phase = 'finished';
        cleanupAll();
        closeLeased();
        throw error;
    }
}

export function clearOpenAIWsCompletedChains(): void {
    completedPool.clear();
}

export function getOpenAIWsCompletedChainCountForTests(): number {
    return completedPool.size;
}

export function setOpenAIWsTransportTestHooks(hooks?: {
    socketFactory?: SocketFactory;
    now?: () => number;
    idleTimers?: IdleTimerHooks;
}): void {
    clearOpenAIWsCompletedChains();
    socketFactory = hooks?.socketFactory || ((url, headers) => new WebSocket(url, { headers }));
    now = hooks?.now || (() => Date.now());
    idleTimers = hooks?.idleTimers || {
        set: (callback, delayMs) => setTimeout(callback, delayMs),
        clear: timer => clearTimeout(timer as NodeJS.Timeout),
    };
}
