import { PassThrough } from 'stream';
import WebSocket, { RawData } from 'ws';
import { logger } from '../common';
import { hashJournalValue } from '../llmRequestJournal';
import { createStreamingAttemptWatchdog } from '../llmStreamingTimeout';
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
    connectionStartedAt: number;
    connectionOpenedAt?: number;
    activeAttempt?: OpenAIWsAttemptDiagnostics & {
        connectionMode: 'fresh' | 'reused';
        appendFromItemIndex: number;
        idleBeforeReuseMs?: number;
    };
    closeRecorded?: boolean;
    removeIdleListeners?: () => void;
};

export type OpenAIWsAttemptDiagnostics = {
    sessionId?: string;
    purpose?: string;
    llmRequestId?: string;
    iteration?: number;
    attempt?: number;
};

type OpenAIWsRequestOptions = {
    url: string;
    headers: Record<string, any>;
    concreteIdentity: string;
    data: Record<string, any>;
    placement: 'local' | 'session-worker';
    signal: AbortSignal;
    hardTimeoutMs?: number;
    diagnostics?: OpenAIWsAttemptDiagnostics;
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
type DiagnosticLogger = Pick<typeof logger, 'info' | 'warn'>;

let socketSequence = 0;
let now = () => Date.now();
let socketFactory: SocketFactory = (url, headers) => new WebSocket(url, { headers });
let diagnosticLogger: DiagnosticLogger = logger;
let idleTimers: IdleTimerHooks = {
    set: (callback, delayMs) => setTimeout(callback, delayMs),
    clear: timer => clearTimeout(timer as NodeJS.Timeout),
};

function boundedDiagnosticText(value: unknown, maxLength = 240): string | undefined {
    if (typeof value !== 'string') return undefined;
    const normalized = value.replace(/[\r\n\t]+/g, ' ').trim();
    if (!normalized) return undefined;
    return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength)}…`;
}

function emitDiagnostic(level: 'info' | 'warn', fields: Record<string, unknown>, message: string): void {
    try {
        diagnosticLogger[level](fields, message);
    } catch {
        // Lifecycle diagnostics must never change socket cleanup or retry behavior.
    }
}

function attemptDiagnosticFields(resource: OpenAIWsResource): Record<string, unknown> {
    return {
        providerType: 'openai-ws',
        socketId: resource.id,
        ...resource.activeAttempt,
        connectionStartedAt: resource.connectionStartedAt,
        ...(resource.connectionOpenedAt !== undefined ? { connectionOpenedAt: resource.connectionOpenedAt } : {}),
    };
}

function recordSocketClose(resource: OpenAIWsResource, options: {
    origin: 'local' | 'upstream';
    cause: string;
    phase: string;
    code?: number;
    reason?: unknown;
    error?: unknown;
    chain?: OpenAIWsCompletedChain<OpenAIWsResource>;
    details?: Record<string, unknown>;
}): void {
    if (resource.closeRecorded) return;
    resource.closeRecorded = true;
    const timestamp = now();
    const chain = options.chain;
    const error = options.error as any;
    const fields = {
        ...attemptDiagnosticFields(resource),
        ...options.details,
        closeOrigin: options.origin,
        closeCause: options.cause,
        closePhase: options.phase,
        ...(options.code !== undefined ? { closeCode: options.code } : {}),
        ...(boundedDiagnosticText(options.reason) ? { closeReason: boundedDiagnosticText(options.reason) } : {}),
        ...(error?.name ? { errorName: boundedDiagnosticText(error.name, 80) } : {}),
        ...(error?.code ? { errorCode: boundedDiagnosticText(String(error.code), 80) } : {}),
        connectionAgeMs: Math.max(0, timestamp - (resource.connectionOpenedAt || resource.connectionStartedAt)),
        ...(chain ? {
            chainAgeMs: Math.max(0, timestamp - chain.createdAt),
            idleDurationMs: Math.max(0, timestamp - chain.lastUsedAt),
        } : {}),
    };
    if (options.origin === 'upstream') emitDiagnostic('warn', fields, 'OpenAI Responses WebSocket closed by upstream');
    else emitDiagnostic('info', fields, 'OpenAI Responses WebSocket closed locally');
}

function closeResource(
    resource: OpenAIWsResource,
    cause = 'transport-cleanup',
    options?: { phase?: string; chain?: OpenAIWsCompletedChain<OpenAIWsResource> },
): void {
    try {
        recordSocketClose(resource, {
            origin: 'local',
            cause,
            phase: options?.phase || 'unknown',
            chain: options?.chain,
        });
        resource.removeIdleListeners?.();
        resource.removeIdleListeners = undefined;
        if (resource.socket.readyState === WebSocket.OPEN || resource.socket.readyState === WebSocket.CONNECTING) {
            resource.socket.terminate();
        }
    } catch {}
}

const completedPool = new OpenAIWsCompletedChainPool<OpenAIWsResource>((resource, cause, chain) => {
    closeResource(resource, cause, { phase: 'idle', chain });
});

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

function openSocket(
    url: string,
    headers: Record<string, any>,
    signal: AbortSignal,
    diagnostics?: OpenAIWsAttemptDiagnostics,
    abortCause?: () => string,
): Promise<OpenAIWsResource> {
    if (signal.aborted) return Promise.reject(makeAbortError());
    const socket = socketFactory(url, headers);
    const resource: OpenAIWsResource = {
        socket,
        id: `openai-ws-${process.pid}-${++socketSequence}`,
        connectionStartedAt: now(),
        activeAttempt: { ...diagnostics, connectionMode: 'fresh', appendFromItemIndex: 0 },
    };
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
            closeResource(resource, abortCause?.() || 'handshake-abort', { phase: 'handshake' });
            reject(makeAbortError());
        });
        const onOpen = () => finish(() => {
            resource.connectionOpenedAt = now();
            resolve(resource);
        });
        const onError = (error: Error) => finish(() => {
            recordSocketClose(resource, { origin: 'upstream', cause: 'handshake-error', phase: 'handshake', error });
            closeResource(resource, 'handshake-error', { phase: 'handshake' });
            reject(error);
        });
        const onClose = (code: number, reason: Buffer) => finish(() => {
            recordSocketClose(resource, { origin: 'upstream', cause: 'handshake-close', phase: 'handshake', code, reason: reason?.toString('utf8') });
            reject(new Error(
                `OpenAI Responses WebSocket closed during handshake (${code}${reason?.length ? `: ${reason.toString('utf8')}` : ''}).`,
            ));
        });
        const onUnexpectedResponse = (_request: unknown, response: any) => finish(() => {
            recordSocketClose(resource, {
                origin: 'upstream',
                cause: 'handshake-http-response',
                phase: 'handshake',
                code: response?.statusCode,
            });
            closeResource(resource, 'handshake-http-response', { phase: 'handshake' });
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
    const remove = (code?: number, reason?: Buffer) => {
        recordSocketClose(chain.resource, {
            origin: 'upstream',
            cause: 'idle-upstream-close',
            phase: 'idle',
            code,
            reason: reason?.toString('utf8'),
            chain,
        });
        completedPool.remove(chain.id);
        chain.resource.removeIdleListeners?.();
        chain.resource.removeIdleListeners = undefined;
    };
    const removeAfterError = (error: Error) => {
        recordSocketClose(chain.resource, {
            origin: 'upstream',
            cause: 'idle-upstream-error',
            phase: 'idle',
            error,
            chain,
        });
        completedPool.remove(chain.id);
        closeResource(chain.resource, 'idle-upstream-error', { phase: 'idle', chain });
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
        if (completedPool.remove(chain.id)) closeResource(chain.resource, 'idle-timeout', { phase: 'idle', chain });
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
    const attemptAbortController = new AbortController();
    const abortAttemptFromOuter = () => attemptAbortController.abort();
    if (options.signal.aborted) attemptAbortController.abort();
    else options.signal.addEventListener('abort', abortAttemptFromOuter, { once: true });
    let streamingTimeoutError: Error | undefined;
    const watchdog = createStreamingAttemptWatchdog({
        hardTimeoutMs: options.hardTimeoutMs,
        onTimeout: error => {
            streamingTimeoutError = error;
            attemptAbortController.abort();
        },
    });
    const attemptSignal = attemptAbortController.signal;
    matched?.chain.resource.removeIdleListeners?.();
    if (matched) matched.chain.resource.removeIdleListeners = undefined;
    let resource: OpenAIWsResource;
    try {
        resource = matched?.chain.resource || await openSocket(
            wsUrl,
            options.headers,
            attemptSignal,
            options.diagnostics,
            () => streamingTimeoutError ? 'handshake-timeout' : 'handshake-abort',
        );
    } catch (error) {
        watchdog.finish();
        options.signal.removeEventListener('abort', abortAttemptFromOuter);
        const failure = (streamingTimeoutError || error) as any;
        emitDiagnostic('warn', {
            providerType: 'openai-ws',
            ...options.diagnostics,
            connectionMode: 'fresh',
            appendFromItemIndex: 0,
            discardCause: streamingTimeoutError ? 'handshake-timeout' : (options.signal.aborted ? 'handshake-abort' : 'handshake-failure'),
            ...(failure?.name ? { errorName: boundedDiagnosticText(failure.name, 80) } : {}),
            ...(failure?.code ? { errorCode: boundedDiagnosticText(String(failure.code), 80) } : {}),
        }, 'OpenAI Responses WebSocket attempt discarded before dispatch');
        throw streamingTimeoutError || error;
    }
    const connectionMode = matched ? 'reused' : 'fresh';
    const appendFromItemIndex = matched?.appendFromItemIndex || 0;
    const idleBeforeReuseMs = matched ? Math.max(0, now() - matched.chain.lastUsedAt) : undefined;
    resource.activeAttempt = {
        ...options.diagnostics,
        connectionMode,
        appendFromItemIndex,
        ...(idleBeforeReuseMs !== undefined ? { idleBeforeReuseMs } : {}),
    };
    resource.socket._socket?.ref?.();
    const input = Array.isArray(options.data.input) ? options.data.input : [];
    const responseRequest: Record<string, any> = {
        ...options.data,
        input: input.slice(appendFromItemIndex),
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
    let createSentAt: number | undefined;
    let firstFrameAt: number | undefined;
    let firstContentAt: number | undefined;
    let frameCount = 0;
    let frameBytes = 0;
    let discardLogged = false;
    let failureCause: string | undefined;
    let failurePhase: string | undefined;

    const summaryFields = () => {
        const timestamp = now();
        return {
            ...attemptDiagnosticFields(resource),
            requestInputItemCount: input.length,
            sentInputItemCount: responseRequest.input.length,
            ...(createSentAt !== undefined ? {
                createSentAt,
                elapsedSinceCreateMs: Math.max(0, timestamp - createSentAt),
            } : {}),
            frameCount,
            frameBytes,
            ...(createSentAt !== undefined && firstFrameAt !== undefined
                ? { firstFrameElapsedMs: Math.max(0, firstFrameAt - createSentAt) }
                : {}),
            ...(createSentAt !== undefined && firstContentAt !== undefined
                ? { firstContentElapsedMs: Math.max(0, firstContentAt - createSentAt) }
                : {}),
        };
    };
    const logDiscard = (cause: string, error?: unknown, discardPhase: string = phase) => {
        if (discardLogged) return;
        discardLogged = true;
        const failure = error as any;
        emitDiagnostic('warn', {
            ...summaryFields(),
            discardCause: cause,
            discardPhase,
            ...(failure?.name ? { errorName: boundedDiagnosticText(failure.name, 80) } : {}),
            ...(failure?.code ? { errorCode: boundedDiagnosticText(String(failure.code), 80) } : {}),
        }, 'OpenAI Responses WebSocket attempt discarded');
    };

    const closeLeased = (cause: string, closePhase: string = phase) => {
        recordSocketClose(resource, { origin: 'local', cause, phase: closePhase, details: summaryFields() });
        closeResource(resource, cause, { phase: closePhase });
    };
    const cleanupStreaming = () => {
        watchdog.finish();
        resource.socket.off('message', onMessage as any);
    };
    const cleanupAll = () => {
        cleanupStreaming();
        attemptSignal.removeEventListener('abort', onAbort);
        options.signal.removeEventListener('abort', abortAttemptFromOuter);
        resource.socket.off('close', onClose as any);
        resource.socket.off('error', onError as any);
    };
    const invalidatePending = (close: boolean, cause: string) => {
        if (phase !== 'pending') return;
        pendingInvalidated = true;
        failureCause = cause;
        failurePhase = 'pending';
        logDiscard(cause, undefined, failurePhase);
        phase = 'finished';
        cleanupAll();
        if (close) closeLeased(cause, failurePhase);
    };
    const onAbort = () => {
        if (phase === 'finished') return;
        if (phase === 'pending') {
            invalidatePending(true, streamingTimeoutError ? 'pending-timeout' : 'pending-abort');
            return;
        }
        failureCause = streamingTimeoutError ? 'attempt-timeout' : 'attempt-abort';
        failurePhase = 'active';
        phase = 'finished';
        closeLeased(failureCause, failurePhase);
        // The shared collector observes this same AbortSignal and owns the
        // AbortError rejection. Destroying with an error here races its abort
        // cleanup: the collector can remove the stream error listener before
        // PassThrough emits the queued error, turning an ordinary Stop/Run
        // cancellation into an uncaught process exception.
        stream.destroy();
    };
    const onClose = (code: number, reason: Buffer) => {
        if (phase === 'finished') return;
        recordSocketClose(resource, {
            origin: 'upstream',
            cause: phase === 'pending' ? 'pending-upstream-close' : 'active-upstream-close',
            phase,
            code,
            reason: reason?.toString('utf8'),
            details: summaryFields(),
        });
        if (phase === 'pending') {
            invalidatePending(false, 'pending-upstream-close');
            return;
        }
        failureCause = 'active-upstream-close';
        failurePhase = 'active';
        phase = 'finished';
        stream.destroy(new Error(`OpenAI Responses WebSocket closed before completion (${code}${reason?.length ? `: ${reason.toString('utf8')}` : ''}).`));
    };
    const onError = (error: Error) => {
        if (phase === 'finished') return;
        recordSocketClose(resource, {
            origin: 'upstream',
            cause: phase === 'pending' ? 'pending-upstream-error' : 'active-upstream-error',
            phase,
            error,
            details: summaryFields(),
        });
        if (phase === 'pending') {
            invalidatePending(true, 'pending-upstream-error');
            return;
        }
        failureCause = 'active-upstream-error';
        failurePhase = 'active';
        phase = 'finished';
        stream.destroy(error);
    };
    const onMessage = (raw: RawData) => {
        if (phase !== 'active') return;
        const frame = normalizeFrame(raw);
        const frameAt = now();
        if (firstFrameAt === undefined) firstFrameAt = frameAt;
        frameCount += 1;
        frameBytes += Buffer.byteLength(frame);
        options.onRawFrame?.(frame);
        let event: any;
        try {
            event = JSON.parse(frame);
        } catch {
            failureCause = 'malformed-frame';
            failurePhase = 'active';
            phase = 'finished';
            closeLeased(failureCause, failurePhase);
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

    attemptSignal.addEventListener('abort', onAbort, { once: true });
    resource.socket.on('message', onMessage as any);
    resource.socket.once('close', onClose as any);
    resource.socket.once('error', onError as any);
    try {
        const envelope = JSON.stringify({ type: 'response.create', ...responseRequest });
        createSentAt = now();
        resource.socket.send(envelope);
        emitDiagnostic('info', {
            ...summaryFields(),
            connectionAgeMs: Math.max(0, createSentAt - (resource.connectionOpenedAt || resource.connectionStartedAt)),
        }, 'OpenAI Responses WebSocket request dispatched');
        const response = await collectOpenAIResponsesStream(stream, attemptSignal, {
            onProgress: options.onProgress,
            onMeaningfulProgress: () => {
                if (firstContentAt === undefined) firstContentAt = now();
                watchdog.markMeaningfulProgress();
            },
        });
        cleanupStreaming();
        const responseId = typeof response?.id === 'string' && response.id.trim() ? response.id.trim() : '';
        if (!completed || pendingInvalidated || options.signal.aborted
            || resource.socket.readyState !== WebSocket.OPEN
            || !responseId || (response?.status && response.status !== 'completed')) {
            const incompletePhase = phase;
            failurePhase = incompletePhase;
            failureCause = 'incomplete-completion';
            logDiscard(failureCause, undefined, failurePhase);
            phase = 'finished';
            cleanupAll();
            closeLeased(failureCause, failurePhase);
            throw new Error('OpenAI Responses WebSocket returned an incomplete completion or omitted its response id.');
        }
        emitDiagnostic('info', {
            ...summaryFields(),
            completionPhase: phase,
            responseStatus: boundedDiagnosticText(response?.status || 'completed', 80),
        }, 'OpenAI Responses WebSocket request completed');
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
                    const cause = pendingInvalidated
                        ? (failureCause || 'pending-invalidated')
                        : options.signal.aborted
                            ? 'finalizer-after-abort'
                            : resource.socket.readyState !== WebSocket.OPEN
                                ? 'finalizer-socket-not-open'
                                : 'finalizer-discard';
                    logDiscard(cause, undefined, 'pending');
                    closeLeased(cause, 'pending');
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
        const cause = failureCause
            || (streamingTimeoutError ? 'attempt-timeout' : options.signal.aborted ? 'attempt-abort' : 'collector-or-transport-error');
        logDiscard(cause, streamingTimeoutError || error, failurePhase || phase);
        phase = 'finished';
        cleanupAll();
        closeLeased(cause, failurePhase || 'active');
        throw streamingTimeoutError || error;
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
    diagnosticLogger?: DiagnosticLogger;
}): void {
    clearOpenAIWsCompletedChains();
    socketFactory = hooks?.socketFactory || ((url, headers) => new WebSocket(url, { headers }));
    now = hooks?.now || (() => Date.now());
    diagnosticLogger = hooks?.diagnosticLogger || logger;
    idleTimers = hooks?.idleTimers || {
        set: (callback, delayMs) => setTimeout(callback, delayMs),
        clear: timer => clearTimeout(timer as NodeJS.Timeout),
    };
}
