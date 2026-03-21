import * as lancedb from '@lancedb/lancedb';
import fs from 'fs-extra';
import path from 'path';
import { Message } from './types';
import { estimateTokenCount } from './tokenCount';
import { DB_DIR, OLLAMA_BASE_URL, SESSION_LOGS_DIR, getSessionArchiveLogPath } from './config';
import { logger } from './common';
import { formatMessageText } from './utils/messageFormat';

const DB_PATH = DB_DIR;
const TABLE_NAME = 'messages_v6';
const CHECKPOINTS_PATH = path.join(DB_DIR, 'vector-index-checkpoints-v2.json');
const EMBEDDING_MODEL = 'qwen3-embedding:0.6b';

// Keep a conservative margin under the embedding model's real 4096-token limit
// because estimateTokenCount() can undercount slightly on some inputs.
const CHUNK_SIZE = 3000;
const EMBEDDING_MAX_LENGTH = 3000;
const SEGMENT_TARGET_TOKENS = 2400;
const SEGMENT_OVERLAP_TOKENS = 500;
const SEGMENT_OVERLAP_MAX_MESSAGE_TOKENS = 500;
const ARCHIVE_INDEX_MIN_PENDING_MESSAGES = 50;
const ARCHIVE_INDEX_MIN_PENDING_TOKENS = 8000;

let table: any;
let checkpoints: VectorIndexCheckpointFile = { version: 2, sessions: {} };
const indexingChains = new Map<string, Promise<number>>();
const archiveIndexBatchStates = new Map<string, SessionArchiveBatchState>();
let checkpointSaveChain: Promise<void> = Promise.resolve();

type VectorRow = {
    id: string;
    message_id: string;
    session_id: string;
    agent: string;
    seq: number;
    start_seq: number;
    end_seq: number;
    message_count: number;
    role: string;
    timestamp: number;
    start_timestamp: number;
    end_timestamp: number;
    chunk_index: number;
    chunk_count: number;
    text: string;
    chunk_text: string;
    vector: number[];
};

type SearchOptions = {
    sessionIds?: string[];
    agent?: string;
};

type ArchiveMessageLine = {
    v: number;
    kind: 'message';
    sessionId: string;
    agent: string;
    seq: number;
    timestamp: number;
    role: 'user' | 'model' | 'tool';
    message: Message;
};

type ArchiveSegmentMessage = {
    sessionId: string;
    agent: string;
    seq: number;
    timestamp: number;
    role: 'user' | 'model' | 'tool';
    text: string;
    tokenCount: number;
};

type ArchiveSegment = {
    sessionId: string;
    agent: string;
    seq: number;
    startSeq: number;
    endSeq: number;
    messageCount: number;
    role: string;
    timestamp: number;
    startTimestamp: number;
    endTimestamp: number;
    text: string;
};

type SessionArchiveCheckpoint = {
    lastIndexedSeq: number;
    tailStartSeq: number;
    updatedAt: number;
};

type VectorIndexCheckpointFile = {
    version: number;
    sessions: Record<string, SessionArchiveCheckpoint>;
};

type SessionArchiveBatchState = {
    latestSeqHint: number;
    pendingEstimatedTokens: number;
    flushQueued: boolean;
    promise?: Promise<number>;
    resolve?: (value: number) => void;
    reject?: (reason?: unknown) => void;
};

type ArchiveIndexBatchDecision = {
    shouldFlushNow: boolean;
    pendingCount: number;
    pendingEstimatedTokens: number;
    reason?: 'message-threshold' | 'token-threshold';
};

function escapeFilterValue(value: string): string {
    return value.replace(/'/g, "''");
}

function buildFilterPredicate(options?: SearchOptions): string | undefined {
    if (!options) return undefined;

    const clauses: string[] = [];

    if (options.agent) {
        clauses.push(`agent = '${escapeFilterValue(options.agent)}'`);
    }

    if (options.sessionIds && options.sessionIds.length > 0) {
        const sessionClauses = [...new Set(options.sessionIds)].map(sessionId => (
            `session_id = '${escapeFilterValue(sessionId)}'`
        ));
        clauses.push(`(${sessionClauses.join(' OR ')})`);
    }

    if (clauses.length === 0) return undefined;
    return clauses.join(' AND ');
}

function normalizeMessageText(message: Message): string {
    return formatMessageText(message, {
        includeRolePrefix: true,
        skipEphemeralSystem: true,
        skipRagMemorySnippets: true,
        skipThinking: true,
    });
}

function estimateArchiveMessageTokenCount(message: Message): number {
    const text = normalizeMessageText(message);
    if (!text) {
        return 0;
    }
    return estimateTokenCount(text);
}

function truncateToTokenLimit(text: string, limit: number): string {
    if (estimateTokenCount(text) <= limit) {
        return text;
    }

    let left = 0;
    let right = text.length;
    while (left < right) {
        const mid = Math.floor((left + right + 1) / 2);
        if (estimateTokenCount(text.substring(0, mid)) <= limit) {
            left = mid;
        } else {
            right = mid - 1;
        }
    }

    return text.substring(0, left);
}

function splitTextIntoChunks(text: string): string[] {
    const normalized = text.trim();
    if (!normalized) {
        return [];
    }

    if (estimateTokenCount(normalized) <= CHUNK_SIZE) {
        return [normalized];
    }

    const chunks: string[] = [];
    let start = 0;

    while (start < normalized.length) {
        let low = start + 1;
        let high = normalized.length;
        let bestEnd = Math.min(normalized.length, start + 1);

        while (low <= high) {
            const mid = Math.floor((low + high) / 2);
            const candidate = normalized.slice(start, mid);
            if (estimateTokenCount(candidate) <= CHUNK_SIZE) {
                bestEnd = mid;
                low = mid + 1;
            } else {
                high = mid - 1;
            }
        }

        if (bestEnd < normalized.length) {
            const boundaryWindowStart = Math.max(start, bestEnd - Math.floor((bestEnd - start) * 0.2));
            const lastNewline = normalized.lastIndexOf('\n', bestEnd);
            if (lastNewline >= boundaryWindowStart) {
                bestEnd = lastNewline + 1;
            }
        }

        const chunk = normalized.slice(start, bestEnd).trim();
        if (chunk) {
            chunks.push(chunk);
        }

        if (bestEnd >= normalized.length) {
            break;
        }

        start = bestEnd;
    }

    return chunks;
}

function normalizeArchiveMessageLine(line: ArchiveMessageLine): ArchiveSegmentMessage | null {
    const text = normalizeMessageText(line.message);
    if (!text) {
        return null;
    }

    return {
        sessionId: line.sessionId,
        agent: line.agent || 'main',
        seq: line.seq,
        timestamp: Number(line.timestamp) || Date.now(),
        role: line.role,
        text,
        tokenCount: estimateTokenCount(text),
    };
}

function calculateNextSegmentStartIndex(messages: ArchiveSegmentMessage[], startIndex: number, endIndex: number): number {
    let nextStartIndex = endIndex + 1;
    let overlapText = '';

    for (let index = endIndex; index > startIndex; index -= 1) {
        const message = messages[index];
        if (message.tokenCount > SEGMENT_OVERLAP_MAX_MESSAGE_TOKENS) {
            break;
        }

        const candidateOverlapText = overlapText ? `${message.text}\n\n${overlapText}` : message.text;
        if (estimateTokenCount(candidateOverlapText) > SEGMENT_OVERLAP_TOKENS) {
            break;
        }

        overlapText = candidateOverlapText;
        nextStartIndex = index;
    }

    return nextStartIndex;
}

function buildArchiveSegments(lines: ArchiveMessageLine[]): ArchiveSegment[] {
    const messages = lines
        .map(normalizeArchiveMessageLine)
        .filter((message): message is ArchiveSegmentMessage => Boolean(message));

    if (messages.length === 0) {
        return [];
    }

    const segments: ArchiveSegment[] = [];
    let startIndex = 0;

    while (startIndex < messages.length) {
        let endIndex = startIndex;
        let segmentMessages = [messages[startIndex]];
        let segmentText = segmentMessages[0].text;
        let segmentTokenCount = estimateTokenCount(segmentText);

        while (endIndex + 1 < messages.length && segmentTokenCount < SEGMENT_TARGET_TOKENS) {
            const nextMessage = messages[endIndex + 1];
            const candidateText = `${segmentText}\n\n${nextMessage.text}`;
            const candidateTokenCount = estimateTokenCount(candidateText);
            if (candidateTokenCount > CHUNK_SIZE) {
                break;
            }

            endIndex += 1;
            segmentMessages = messages.slice(startIndex, endIndex + 1);
            segmentText = candidateText;
            segmentTokenCount = candidateTokenCount;
        }

        const firstMessage = segmentMessages[0];
        const lastMessage = segmentMessages[segmentMessages.length - 1];
        segments.push({
            sessionId: firstMessage.sessionId,
            agent: firstMessage.agent,
            seq: firstMessage.seq,
            startSeq: firstMessage.seq,
            endSeq: lastMessage.seq,
            messageCount: segmentMessages.length,
            role: firstMessage.role,
            timestamp: firstMessage.timestamp,
            startTimestamp: firstMessage.timestamp,
            endTimestamp: lastMessage.timestamp,
            text: segmentText,
        });

        if (endIndex >= messages.length - 1) {
            break;
        }

        const nextStartIndex = calculateNextSegmentStartIndex(messages, startIndex, endIndex);
        startIndex = Math.max(startIndex + 1, nextStartIndex);
    }

    return segments;
}

function createRowsFromSegment(segment: ArchiveSegment): Omit<VectorRow, 'vector'>[] {
    const text = segment.text.trim();
    if (!text) {
        return [];
    }

    const chunks = splitTextIntoChunks(text);
    const messageId = `${segment.sessionId}:${segment.startSeq}-${segment.endSeq}`;

    return chunks.map((chunkText, index) => ({
        id: `${messageId}:${index}`,
        message_id: messageId,
        session_id: segment.sessionId,
        agent: segment.agent || 'main',
        seq: segment.startSeq,
        start_seq: segment.startSeq,
        end_seq: segment.endSeq,
        message_count: segment.messageCount,
        role: segment.role,
        timestamp: segment.startTimestamp,
        start_timestamp: segment.startTimestamp,
        end_timestamp: segment.endTimestamp,
        chunk_index: index,
        chunk_count: chunks.length,
        text,
        chunk_text: truncateToTokenLimit(chunkText, EMBEDDING_MAX_LENGTH),
    }));
}

async function getEmbedding(text: string) {
    const truncated = truncateToTokenLimit(text, EMBEDDING_MAX_LENGTH);
    // Keep using the existing OLLAMA_BASE_URL config key for compatibility,
    // but send embeddings requests through the OpenAI-compatible /v1/embeddings API.
    const baseUrl = OLLAMA_BASE_URL.replace(/\/+$/, '');
    const response = await fetch(`${baseUrl}/v1/embeddings`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model: EMBEDDING_MODEL,
            input: truncated,
        }),
        signal: AbortSignal.timeout(60_000),
    });
    const responseText = await response.text();

    let body: any = {};
    try {
        body = responseText ? JSON.parse(responseText) : {};
    } catch {
        throw new Error(`Embedding service returned non-JSON response (${response.status}): ${responseText.slice(0, 500)}`);
    }

    if (!response.ok) {
        const message = body?.error?.message || body?.error || responseText || `HTTP ${response.status}`;
        throw new Error(`Embedding request failed (${response.status}): ${message}`);
    }

    const embedding = body?.data?.[0]?.embedding;
    if (!Array.isArray(embedding) || embedding.length === 0 || embedding.some((value: unknown) => typeof value !== 'number')) {
        throw new Error(`Embedding service returned invalid embeddings payload: ${responseText.slice(0, 500)}`);
    }

    return embedding;
}

async function loadCheckpoints() {
    if (await fs.pathExists(CHECKPOINTS_PATH)) {
        try {
            const loaded = await fs.readJson(CHECKPOINTS_PATH);
            if (loaded?.version === 2 && loaded?.sessions && typeof loaded.sessions === 'object') {
                checkpoints = loaded;
            } else {
                logger.warn({ path: CHECKPOINTS_PATH, version: loaded?.version }, 'Ignoring incompatible vector archive checkpoints');
                checkpoints = { version: 2, sessions: {} };
            }
        } catch (e) {
            logger.error({ err: e }, 'Failed to load vector archive checkpoints, starting fresh');
            checkpoints = { version: 2, sessions: {} };
        }
    }
}

async function saveCheckpoints() {
    checkpointSaveChain = checkpointSaveChain.then(async () => {
        await fs.ensureDir(path.dirname(CHECKPOINTS_PATH));
        await fs.writeJson(CHECKPOINTS_PATH, checkpoints, { spaces: 2 });
    });
    await checkpointSaveChain;
}

function getSessionArchiveCheckpoint(sessionId: string): SessionArchiveCheckpoint {
    return checkpoints.sessions[sessionId] || {
        lastIndexedSeq: 0,
        tailStartSeq: 0,
        updatedAt: 0,
    };
}

function getLastIndexedSeq(sessionId: string): number {
    return getSessionArchiveCheckpoint(sessionId).lastIndexedSeq;
}

async function setSessionArchiveCheckpoint(sessionId: string, checkpoint: { lastIndexedSeq: number; tailStartSeq: number }): Promise<void> {
    checkpoints.sessions[sessionId] = {
        lastIndexedSeq: checkpoint.lastIndexedSeq,
        tailStartSeq: checkpoint.tailStartSeq,
        updatedAt: Date.now(),
    };
    await saveCheckpoints();
}

function getOrCreateBatchState(sessionId: string): SessionArchiveBatchState {
    let state = archiveIndexBatchStates.get(sessionId);
    if (!state) {
        state = {
            latestSeqHint: getLastIndexedSeq(sessionId),
            pendingEstimatedTokens: 0,
            flushQueued: false,
        };
        archiveIndexBatchStates.set(sessionId, state);
    }
    return state;
}

function ensureBatchPromise(state: SessionArchiveBatchState): Promise<number> {
    if (!state.promise) {
        state.promise = new Promise<number>((resolve, reject) => {
            state.resolve = resolve;
            state.reject = reject;
        });
    }

    return state.promise;
}

function clearBatchState(sessionId: string): void {
    const state = archiveIndexBatchStates.get(sessionId);
    if (!state) {
        return;
    }

    archiveIndexBatchStates.delete(sessionId);
}

function resolveBatchState(sessionId: string, value: number): void {
    const state = archiveIndexBatchStates.get(sessionId);
    if (!state) {
        return;
    }

    const resolve = state.resolve;
    clearBatchState(sessionId);
    resolve?.(value);
}

function rejectBatchState(sessionId: string, error: unknown): void {
    const state = archiveIndexBatchStates.get(sessionId);
    if (!state) {
        return;
    }

    const reject = state.reject;
    clearBatchState(sessionId);
    reject?.(error);
}

function getArchiveIndexBatchDecision({
    pendingCount,
    pendingEstimatedTokens,
}: {
    pendingCount: number;
    pendingEstimatedTokens: number;
}): ArchiveIndexBatchDecision {
    if (pendingCount >= ARCHIVE_INDEX_MIN_PENDING_MESSAGES) {
        return {
            shouldFlushNow: true,
            pendingCount,
            pendingEstimatedTokens,
            reason: 'message-threshold',
        };
    }

    if (pendingEstimatedTokens >= ARCHIVE_INDEX_MIN_PENDING_TOKENS) {
        return {
            shouldFlushNow: true,
            pendingCount,
            pendingEstimatedTokens,
            reason: 'token-threshold',
        };
    }

    return {
        shouldFlushNow: false,
        pendingCount,
        pendingEstimatedTokens,
    };
}

async function readArchiveLines(sessionId: string): Promise<ArchiveMessageLine[]> {
    const archivePath = getSessionArchiveLogPath(sessionId);
    if (!await fs.pathExists(archivePath)) {
        return [];
    }

    const raw = await fs.readFile(archivePath, 'utf8');
    const lines = raw.split('\n').map((line: string) => line.trim()).filter(Boolean);
    const parsed: ArchiveMessageLine[] = [];

    for (const line of lines) {
        try {
            const record = JSON.parse(line);
            if (record?.kind === 'message' && typeof record.sessionId === 'string' && typeof record.seq === 'number') {
                parsed.push(record as ArchiveMessageLine);
            }
        } catch (e) {
            logger.warn({ err: e, sessionId }, 'Skipping malformed archive log line');
        }
    }

    return parsed.sort((a, b) => a.seq - b.seq);
}

async function replaceIndexedArchiveTail(sessionId: string, rewindStartSeq: number, archiveLines: ArchiveMessageLine[]): Promise<{ lastIndexedSeq: number; tailStartSeq: number; rowCount: number; segmentCount: number; }> {
    const targetLines = archiveLines.filter(line => line.seq >= rewindStartSeq);
    if (targetLines.length === 0) {
        return {
            lastIndexedSeq: getLastIndexedSeq(sessionId),
            tailStartSeq: getSessionArchiveCheckpoint(sessionId).tailStartSeq,
            rowCount: 0,
            segmentCount: 0,
        };
    }

    await table.delete(`session_id = '${escapeFilterValue(sessionId)}' AND start_seq >= ${rewindStartSeq}`);

    const segments = buildArchiveSegments(targetLines);
    const rows = segments.flatMap(createRowsFromSegment);
    const hydratedRows: VectorRow[] = [];

    for (const row of rows) {
        const vector = await getEmbedding(row.chunk_text);
        hydratedRows.push({ ...row, vector });
    }

    if (hydratedRows.length > 0) {
        await table.add(hydratedRows);
    }

    return {
        lastIndexedSeq: targetLines[targetLines.length - 1].seq,
        tailStartSeq: segments[segments.length - 1]?.startSeq || targetLines[targetLines.length - 1].seq,
        rowCount: hydratedRows.length,
        segmentCount: segments.length,
    };
}

async function indexSessionArchiveInternal(sessionId: string, latestSeqHint?: number): Promise<number> {
    const checkpoint = getSessionArchiveCheckpoint(sessionId);
    const lastIndexedSeq = checkpoint.lastIndexedSeq;
    if (latestSeqHint !== undefined && latestSeqHint <= lastIndexedSeq) {
        return lastIndexedSeq;
    }

    const archiveLines = await readArchiveLines(sessionId);
    if (archiveLines.length === 0) {
        return lastIndexedSeq;
    }

    const latestArchivedSeq = archiveLines[archiveLines.length - 1].seq;
    if (latestArchivedSeq <= lastIndexedSeq) {
        return lastIndexedSeq;
    }

    const rewindStartSeqCandidate = checkpoint.tailStartSeq > 0 ? checkpoint.tailStartSeq : archiveLines[0].seq;
    const rewindStartSeq = archiveLines.some(line => line.seq >= rewindStartSeqCandidate)
        ? rewindStartSeqCandidate
        : archiveLines[0].seq;

    logger.info({
        sessionId,
        pendingCount: Math.max(0, latestArchivedSeq - lastIndexedSeq),
        lastIndexedSeq,
        rewindStartSeq,
    }, 'Rebuilding session archive vector tail from JSONL');

    const result = await replaceIndexedArchiveTail(sessionId, rewindStartSeq, archiveLines);
    await setSessionArchiveCheckpoint(sessionId, {
        lastIndexedSeq: result.lastIndexedSeq,
        tailStartSeq: result.tailStartSeq,
    });

    logger.info({
        sessionId,
        rewindStartSeq,
        lastIndexedSeq: result.lastIndexedSeq,
        tailStartSeq: result.tailStartSeq,
        rowCount: result.rowCount,
        segmentCount: result.segmentCount,
    }, 'Completed session archive vector tail rebuild');

    return result.lastIndexedSeq;
}

function queueArchiveIndexRun(sessionId: string, targetLatestSeqHint?: number): Promise<number> {
    const previous = indexingChains.get(sessionId) || Promise.resolve(getLastIndexedSeq(sessionId));
    const next = previous
        .catch(() => getLastIndexedSeq(sessionId))
        .then(() => indexSessionArchiveInternal(sessionId, targetLatestSeqHint));

    indexingChains.set(sessionId, next);
    next.finally(() => {
        if (indexingChains.get(sessionId) === next) {
            indexingChains.delete(sessionId);
        }
    });

    return next;
}

function planSessionArchiveIndex(sessionId: string): Promise<number> {
    const state = archiveIndexBatchStates.get(sessionId);
    const lastIndexedSeq = getLastIndexedSeq(sessionId);

    if (!state || state.latestSeqHint <= lastIndexedSeq) {
        resolveBatchState(sessionId, lastIndexedSeq);
        return Promise.resolve(lastIndexedSeq);
    }

    const promise = ensureBatchPromise(state);
    const pendingCount = Math.max(0, state.latestSeqHint - lastIndexedSeq);
    const decision = getArchiveIndexBatchDecision({
        pendingCount,
        pendingEstimatedTokens: state.pendingEstimatedTokens,
    });

    if (decision.shouldFlushNow) {
        if (state.flushQueued) {
            return promise;
        }

        state.flushQueued = true;

        const targetLatestSeqHint = state.latestSeqHint;
        state.pendingEstimatedTokens = 0;

        logger.info({
            sessionId,
            pendingCount: decision.pendingCount,
            pendingEstimatedTokens: decision.pendingEstimatedTokens,
            reason: decision.reason,
            targetLatestSeqHint,
            lastIndexedSeq,
        }, 'Queueing session archive indexing batch');

        queueArchiveIndexRun(sessionId, targetLatestSeqHint)
            .then((indexedSeq) => {
                const currentState = archiveIndexBatchStates.get(sessionId);
                if (!currentState) {
                    return;
                }

                currentState.flushQueued = false;

                if (indexedSeq < targetLatestSeqHint && currentState.latestSeqHint <= targetLatestSeqHint) {
                    logger.warn({ sessionId, targetLatestSeqHint, indexedSeq }, 'Archive index batch made no progress; clearing pending batch hint');
                    resolveBatchState(sessionId, indexedSeq);
                    return;
                }

                if (currentState.latestSeqHint <= indexedSeq) {
                    resolveBatchState(sessionId, indexedSeq);
                    return;
                }

                void planSessionArchiveIndex(sessionId);
            })
            .catch((err) => {
                const currentState = archiveIndexBatchStates.get(sessionId);
                if (currentState) {
                    currentState.flushQueued = false;
                }
                rejectBatchState(sessionId, err);
            });

        return promise;
    }

    return promise;
}

async function scheduleSessionArchiveIndex(sessionId: string, latestSeqHint?: number, latestMessageTokenEstimate?: number): Promise<number> {
    const lastIndexedSeq = getLastIndexedSeq(sessionId);
    if (latestSeqHint !== undefined && latestSeqHint <= lastIndexedSeq) {
        return lastIndexedSeq;
    }

    const state = getOrCreateBatchState(sessionId);
    const previousLatestSeqHint = state.latestSeqHint;

    if (latestSeqHint !== undefined && latestSeqHint > state.latestSeqHint) {
        state.latestSeqHint = latestSeqHint;

        if (typeof latestMessageTokenEstimate === 'number' && latestMessageTokenEstimate > 0) {
            const seqDelta = latestSeqHint - previousLatestSeqHint;
            if (seqDelta === 1) {
                state.pendingEstimatedTokens += latestMessageTokenEstimate;
            }
        }
    }

    return planSessionArchiveIndex(sessionId);
}

async function indexSessionArchive(sessionId: string, latestSeqHint?: number): Promise<number> {
    const lastIndexedSeq = getLastIndexedSeq(sessionId);
    const state = getOrCreateBatchState(sessionId);

    if (latestSeqHint !== undefined && latestSeqHint > state.latestSeqHint) {
        state.latestSeqHint = latestSeqHint;
    }

    if (state.latestSeqHint <= lastIndexedSeq) {
        clearBatchState(sessionId);
        return lastIndexedSeq;
    }

    ensureBatchPromise(state);
    state.pendingEstimatedTokens = 0;
    state.flushQueued = true;

    try {
        const targetLatestSeqHint = state.latestSeqHint;
        const indexedSeq = await queueArchiveIndexRun(sessionId, targetLatestSeqHint);
        const currentState = archiveIndexBatchStates.get(sessionId);

        if (indexedSeq < targetLatestSeqHint && (!currentState || currentState.latestSeqHint <= targetLatestSeqHint)) {
            logger.warn({ sessionId, targetLatestSeqHint, indexedSeq }, 'Forced archive index made no progress; clearing pending batch hint');
            resolveBatchState(sessionId, indexedSeq);
            return indexedSeq;
        }

        if (currentState && currentState.latestSeqHint > indexedSeq) {
            currentState.flushQueued = false;
            return planSessionArchiveIndex(sessionId);
        }

        resolveBatchState(sessionId, indexedSeq);
        return indexedSeq;
    } catch (err) {
        const currentState = archiveIndexBatchStates.get(sessionId);
        if (currentState) {
            currentState.flushQueued = false;
        }
        rejectBatchState(sessionId, err);
        throw err;
    }
}

async function getAllArchiveSessionIds(): Promise<string[]> {
    if (!await fs.pathExists(SESSION_LOGS_DIR)) {
        return [];
    }

    const sessionIds: string[] = [];

    const walk = async (dir: string) => {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                await walk(fullPath);
                continue;
            }

            if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
                continue;
            }

            const relativePath = path.relative(SESSION_LOGS_DIR, fullPath);
            const sessionId = relativePath.slice(0, -'.jsonl'.length).split(path.sep).join('/');
            sessionIds.push(sessionId);
        }
    };

    await walk(SESSION_LOGS_DIR);
    return sessionIds.sort();
}

async function indexAllSessionArchives(sessionIds?: string[]): Promise<void> {
    const targetSessionIds = sessionIds && sessionIds.length > 0
        ? [...new Set(sessionIds)]
        : await getAllArchiveSessionIds();

    for (const sessionId of targetSessionIds) {
        await indexSessionArchive(sessionId);
    }
}

async function renameSessionArchiveIndex(oldSessionId: string, newSessionId: string): Promise<void> {
    const oldCheckpoint = checkpoints.sessions[oldSessionId];
    const newCheckpoint = checkpoints.sessions[newSessionId];

    if (!oldCheckpoint && !newCheckpoint) {
        return;
    }

    if (oldCheckpoint && newCheckpoint) {
        const preferOld = oldCheckpoint.lastIndexedSeq > newCheckpoint.lastIndexedSeq;
        const preferCheckpoint = preferOld ? oldCheckpoint : newCheckpoint;
        checkpoints.sessions[newSessionId] = {
            lastIndexedSeq: Math.max(oldCheckpoint.lastIndexedSeq, newCheckpoint.lastIndexedSeq),
            tailStartSeq: preferCheckpoint.tailStartSeq,
            updatedAt: Date.now(),
        };
    } else if (oldCheckpoint) {
        checkpoints.sessions[newSessionId] = {
            ...oldCheckpoint,
            updatedAt: Date.now(),
        };
    }

    delete checkpoints.sessions[oldSessionId];
    await saveCheckpoints();
}

function formatSeqLabel(startSeq: number, endSeq: number): string {
    return startSeq === endSeq ? `${startSeq}` : `${startSeq}-${endSeq}`;
}

async function search(query: string, limit = 5, format = true, options?: SearchOptions) {
    const vector = await getEmbedding(query);
    const results: any[] = [];
    let searchQuery = table.search(vector);
    const predicate = buildFilterPredicate(options);
    if (predicate) {
        searchQuery = searchQuery.where(predicate);
    }
    const iterator = await searchQuery.limit(limit).execute();

    for await (const row of iterator) {
        const records = row.toArray();
        for (const record of records) {
            if (!record.text || record.session_id === '__init__') continue;
            results.push({
                id: record.id,
                message_id: record.message_id,
                session_id: record.session_id,
                agent: record.agent,
                seq: record.start_seq ?? record.seq,
                start_seq: record.start_seq ?? record.seq,
                end_seq: record.end_seq ?? record.seq,
                message_count: record.message_count ?? 1,
                role: record.role,
                timestamp: record.timestamp,
                start_timestamp: record.start_timestamp ?? record.timestamp,
                end_timestamp: record.end_timestamp ?? record.timestamp,
                chunk_index: record.chunk_index,
                chunk_count: record.chunk_count,
                text: record.text,
                chunk_text: record.chunk_text,
                _distance: record._distance,
            });
        }
    }

    if (!format) return results;
    if (results.length === 0) return '';

    return results.map(r => {
        const ts = r.start_timestamp != null && !isNaN(Number(r.start_timestamp)) ? Number(r.start_timestamp) : null;
        const date = ts ? new Date(ts) : null;
        const dateStr = (date && !isNaN(date.getTime())) ? date.toISOString() : 'unknown';
        const seqLabel = formatSeqLabel(Number(r.start_seq), Number(r.end_seq));
        return `[${dateStr}] [session: ${r.session_id}] [seq: ${seqLabel}] [messages: ${r.message_count}] [chunk ${Number(r.chunk_index) + 1}/${r.chunk_count}]\n${r.text}`;
    }).join('\n\n---\n\n');
}

async function getContextAround(timestamp: number, limit = 10) {
    const ts = Number(timestamp);
    const lower = ts - 1800000;
    const upper = ts + 1800000;
    const results: any[] = [];

    const iterator = await table.query()
        .where(`start_timestamp <= ${upper} AND end_timestamp >= ${lower}`)
        .limit(limit)
        .execute();

    for await (const row of iterator) {
        const records = row.toArray();
        for (const record of records) {
            if (!record.text || record.session_id === '__init__') continue;
            results.push({
                id: record.id,
                message_id: record.message_id,
                session_id: record.session_id,
                agent: record.agent,
                seq: record.start_seq ?? record.seq,
                start_seq: record.start_seq ?? record.seq,
                end_seq: record.end_seq ?? record.seq,
                message_count: record.message_count ?? 1,
                role: record.role,
                timestamp: record.timestamp,
                start_timestamp: record.start_timestamp ?? record.timestamp,
                end_timestamp: record.end_timestamp ?? record.timestamp,
                chunk_index: record.chunk_index,
                chunk_count: record.chunk_count,
                text: record.text,
                chunk_text: record.chunk_text,
            });
        }
    }

    return results.sort((a, b) => {
        const timestampDelta = Number(a.start_timestamp) - Number(b.start_timestamp);
        if (timestampDelta !== 0) return timestampDelta;
        const seqDelta = Number(a.start_seq) - Number(b.start_seq);
        if (seqDelta !== 0) return seqDelta;
        return Number(a.chunk_index) - Number(b.chunk_index);
    });
}

async function init() {
    await fs.ensureDir(DB_PATH);
    await fs.ensureDir(SESSION_LOGS_DIR);
    const db = await lancedb.connect(DB_PATH);
    try {
        table = await db.openTable(TABLE_NAME);
    } catch (e) {
        table = await db.createTable(TABLE_NAME, [{
            id: '__init__',
            message_id: '__init__',
            session_id: '__init__',
            agent: '__init__',
            seq: 0,
            start_seq: 0,
            end_seq: 0,
            message_count: 1,
            role: 'system',
            timestamp: 0,
            start_timestamp: 0,
            end_timestamp: 0,
            chunk_index: 0,
            chunk_count: 1,
            text: 'init',
            chunk_text: 'init',
            vector: new Array(1024).fill(0),
        }]);
        try {
            await table.delete("id = '__init__'");
        } catch (deleteError) {
            logger.warn({ err: deleteError }, 'Failed to remove vector init row');
        }
    }

    await loadCheckpoints();
}

// Compatibility wrapper during migration away from history-based indexing.
async function indexNewMessages(sessionId: string, _history: Message[], _lastIndexedPosition: number = 0): Promise<number> {
    await indexSessionArchive(sessionId);
    return _history.length;
}

function getArchiveIndexStatus(sessionId: string): { lastIndexedSeq: number; tailStartSeq: number } {
    const checkpoint = getSessionArchiveCheckpoint(sessionId);
    return {
        lastIndexedSeq: checkpoint.lastIndexedSeq,
        tailStartSeq: checkpoint.tailStartSeq,
    };
}

export {
    buildArchiveSegments,
    calculateNextSegmentStartIndex,
    createRowsFromSegment,
    estimateArchiveMessageTokenCount,
    getArchiveIndexBatchDecision,
    getArchiveIndexStatus,
    indexAllSessionArchives,
    indexNewMessages,
    indexSessionArchive,
    init,
    renameSessionArchiveIndex,
    scheduleSessionArchiveIndex,
    search,
    getContextAround,
};
