import * as lancedb from '@lancedb/lancedb';
import fs from 'fs-extra';
import path from 'path';
import { Message } from './types';
import { estimateTokenCount } from './tokenCount';
import { DB_DIR, OLLAMA_BASE_URL, SESSION_LOGS_DIR } from './config';
import { logger } from './common';
import { formatMessageText } from './utils/messageFormat';
import {
    ArchiveBlockRecord,
    readLocalArchiveBlocksByIdRange,
} from './session/layeredContext';
import {
    ArchiveMessageRecord,
    readLocalArchiveMessagesBySeqRange,
} from './session/archive';
import {
    getVectorCheckpointSync,
    getVectorSearchLineage,
    getVectorSearchLineageSync,
    initArchiveStore,
    setVectorCheckpointSync,
} from './session/archiveStore';

const DB_PATH = DB_DIR;
const TABLE_NAME = 'messages_v7';
const LEGACY_CHECKPOINTS_PATH = path.join(DB_DIR, 'vector-index-checkpoints-v2.json');
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
let legacyCheckpoints: VectorIndexCheckpointFile = { version: 2, sessions: {} };
const indexingChains = new Map<string, Promise<number>>();
const archiveIndexBatchStates = new Map<string, SessionArchiveBatchState>();

type VectorRow = {
    id: string;
    message_id: string;
    session_id: string;
    agent: string;
    memory_kind: 'raw' | 'block';
    seq: number;
    start_seq: number;
    end_seq: number;
    raw_start_seq: number;
    raw_end_seq: number;
    message_count: number;
    role: string;
    timestamp: number;
    start_timestamp: number;
    end_timestamp: number;
    chunk_index: number;
    chunk_count: number;
    text: string;
    chunk_text: string;
    block_id: number | null;
    block_level: number | null;
    source_kind: string | null;
    source_start: number | null;
    source_end: number | null;
    vector: number[];
};

type SearchOptions = {
    sessionIds?: string[];
    agent?: string;
    lineageSessions?: Array<{ sessionId: string; maxMessageSeq?: number; maxBlockId?: number }>;
};

type ArchiveMessageLine = ArchiveMessageRecord;

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
    lastIndexedBlockId: number;
    updatedAt: number;
};

type VectorIndexCheckpointFile = {
    version: number;
    sessions: Record<string, SessionArchiveCheckpoint>;
};

type SessionArchiveBatchState = {
    latestSeqHint: number;
    latestBlockIdHint: number;
    pendingEstimatedTokens: number;
    flushQueued: boolean;
    promise?: Promise<number>;
    resolve?: (value: number) => void;
    reject?: (reason?: unknown) => void;
};

type ArchiveIndexBatchDecision = {
    shouldFlushNow: boolean;
    pendingCount: number;
    pendingBlockCount: number;
    pendingEstimatedTokens: number;
    reason?: 'message-threshold' | 'token-threshold' | 'block-pending';
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

    if (options.lineageSessions && options.lineageSessions.length > 0) {
        const lineageClauses = options.lineageSessions.map((entry) => {
            const sessionClause = `session_id = '${escapeFilterValue(entry.sessionId)}'`;
            const rawClause = typeof entry.maxMessageSeq === 'number'
                ? `(memory_kind = 'raw' AND start_seq <= ${entry.maxMessageSeq})`
                : `(memory_kind = 'raw')`;
            const blockClause = typeof entry.maxBlockId === 'number'
                ? `(memory_kind = 'block' AND block_id <= ${entry.maxBlockId})`
                : `(memory_kind = 'block')`;
            return `(${sessionClause} AND (${rawClause} OR ${blockClause}))`;
        });
        clauses.push(`(${lineageClauses.join(' OR ')})`);
    } else if (options.sessionIds && options.sessionIds.length > 0) {
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
        memory_kind: 'raw',
        seq: segment.startSeq,
        start_seq: segment.startSeq,
        end_seq: segment.endSeq,
        raw_start_seq: segment.startSeq,
        raw_end_seq: segment.endSeq,
        message_count: segment.messageCount,
        role: segment.role,
        timestamp: segment.startTimestamp,
        start_timestamp: segment.startTimestamp,
        end_timestamp: segment.endTimestamp,
        chunk_index: index,
        chunk_count: chunks.length,
        text,
        chunk_text: truncateToTokenLimit(chunkText, EMBEDDING_MAX_LENGTH),
        block_id: null as number | null,
        block_level: null as number | null,
        source_kind: null as string | null,
        source_start: null as number | null,
        source_end: null as number | null,
    }));
}

async function createRowsFromBlockRecord(record: ArchiveBlockRecord): Promise<Omit<VectorRow, 'vector'>[]> {
    const text = String(record.summary || '').trim();
    if (!text) {
        return [];
    }

    const chunks = splitTextIntoChunks(text);
    const messageRecords = await readLocalArchiveMessagesBySeqRange(record.sessionId, record.rawStartSeq, record.rawEndSeq);
    const startTimestamp = Number(messageRecords[0]?.timestamp) || Number(record.createdAt) || Date.now();
    const endTimestamp = Number(messageRecords[messageRecords.length - 1]?.timestamp) || startTimestamp;
    const messageId = `${record.sessionId}:block:${record.id}`;
    const estimatedMessageCount = Math.max(1, record.rawEndSeq - record.rawStartSeq + 1);

    return chunks.map((chunkText, index) => ({
        id: `${messageId}:${index}`,
        message_id: messageId,
        session_id: record.sessionId,
        agent: record.agent || 'main',
        memory_kind: 'block',
        seq: record.rawStartSeq,
        start_seq: record.rawStartSeq,
        end_seq: record.rawEndSeq,
        raw_start_seq: record.rawStartSeq,
        raw_end_seq: record.rawEndSeq,
        message_count: estimatedMessageCount,
        role: 'model',
        timestamp: startTimestamp,
        start_timestamp: startTimestamp,
        end_timestamp: endTimestamp,
        chunk_index: index,
        chunk_count: chunks.length,
        text,
        chunk_text: truncateToTokenLimit(chunkText, EMBEDDING_MAX_LENGTH),
        block_id: record.id,
        block_level: record.level,
        source_kind: record.sourceKind,
        source_start: record.sourceStart,
        source_end: record.sourceEnd,
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
    if (await fs.pathExists(LEGACY_CHECKPOINTS_PATH)) {
        try {
            const loaded = await fs.readJson(LEGACY_CHECKPOINTS_PATH);
            if (loaded?.version === 2 && loaded?.sessions && typeof loaded.sessions === 'object') {
                legacyCheckpoints = loaded;
            } else {
                logger.warn({ path: LEGACY_CHECKPOINTS_PATH, version: loaded?.version }, 'Ignoring incompatible legacy vector archive checkpoints');
                legacyCheckpoints = { version: 2, sessions: {} };
            }
        } catch (e) {
            logger.error({ err: e }, 'Failed to load legacy vector archive checkpoints, starting fresh');
            legacyCheckpoints = { version: 2, sessions: {} };
        }
    }
}

async function migrateLegacyCheckpointsToDb(): Promise<void> {
    const sessionEntries = Object.entries(legacyCheckpoints.sessions || {});
    for (const [sessionId, checkpoint] of sessionEntries) {
        const current = getVectorCheckpointSync(sessionId);
        if (current.updatedAt > 0 || current.rawLastIndexedSeq > 0 || current.rawTailStartSeq > 0 || current.lastIndexedBlockId > 0) {
            continue;
        }

        setVectorCheckpointSync(sessionId, {
            rawLastIndexedSeq: checkpoint.lastIndexedSeq,
            rawTailStartSeq: checkpoint.tailStartSeq,
            lastIndexedBlockId: 0,
        });
    }
}

function getSessionArchiveCheckpoint(sessionId: string): SessionArchiveCheckpoint {
    const dbCheckpoint = getVectorCheckpointSync(sessionId);
    if (dbCheckpoint.updatedAt > 0 || dbCheckpoint.rawLastIndexedSeq > 0 || dbCheckpoint.lastIndexedBlockId > 0 || dbCheckpoint.rawTailStartSeq > 0) {
        return {
            lastIndexedSeq: dbCheckpoint.rawLastIndexedSeq,
            tailStartSeq: dbCheckpoint.rawTailStartSeq,
            lastIndexedBlockId: dbCheckpoint.lastIndexedBlockId,
            updatedAt: dbCheckpoint.updatedAt,
        };
    }

    const legacy = legacyCheckpoints.sessions[sessionId];
    if (legacy) {
        const migrated = setVectorCheckpointSync(sessionId, {
            rawLastIndexedSeq: legacy.lastIndexedSeq,
            rawTailStartSeq: legacy.tailStartSeq,
            lastIndexedBlockId: 0,
        });
        return {
            lastIndexedSeq: migrated.rawLastIndexedSeq,
            tailStartSeq: migrated.rawTailStartSeq,
            lastIndexedBlockId: migrated.lastIndexedBlockId,
            updatedAt: migrated.updatedAt,
        };
    }

    return {
        lastIndexedSeq: 0,
        tailStartSeq: 0,
        lastIndexedBlockId: 0,
        updatedAt: 0,
    };
}

function getLastIndexedSeq(sessionId: string): number {
    return getSessionArchiveCheckpoint(sessionId).lastIndexedSeq;
}

async function setSessionArchiveCheckpoint(sessionId: string, checkpoint: { lastIndexedSeq: number; tailStartSeq: number }): Promise<void> {
    setVectorCheckpointSync(sessionId, {
        rawLastIndexedSeq: checkpoint.lastIndexedSeq,
        rawTailStartSeq: checkpoint.tailStartSeq,
    });
}

function getOrCreateBatchState(sessionId: string): SessionArchiveBatchState {
    let state = archiveIndexBatchStates.get(sessionId);
    if (!state) {
        state = {
            latestSeqHint: getLastIndexedSeq(sessionId),
            latestBlockIdHint: getSessionArchiveCheckpoint(sessionId).lastIndexedBlockId,
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
    pendingBlockCount,
    pendingEstimatedTokens,
}: {
    pendingCount: number;
    pendingBlockCount: number;
    pendingEstimatedTokens: number;
}): ArchiveIndexBatchDecision {
    if (pendingCount >= ARCHIVE_INDEX_MIN_PENDING_MESSAGES) {
        return {
            shouldFlushNow: true,
            pendingCount,
            pendingBlockCount,
            pendingEstimatedTokens,
            reason: 'message-threshold',
        };
    }

    if (pendingEstimatedTokens >= ARCHIVE_INDEX_MIN_PENDING_TOKENS) {
        return {
            shouldFlushNow: true,
            pendingCount,
            pendingBlockCount,
            pendingEstimatedTokens,
            reason: 'token-threshold',
        };
    }

    if (pendingBlockCount > 0) {
        return {
            shouldFlushNow: true,
            pendingCount,
            pendingBlockCount,
            pendingEstimatedTokens,
            reason: 'block-pending',
        };
    }

    return {
        shouldFlushNow: false,
        pendingCount,
        pendingBlockCount,
        pendingEstimatedTokens,
    };
}

async function readArchiveLines(sessionId: string): Promise<ArchiveMessageLine[]> {
    return readLocalArchiveMessagesBySeqRange(sessionId);
}

async function readLocalBlockLines(sessionId: string): Promise<ArchiveBlockRecord[]> {
    return readLocalArchiveBlocksByIdRange(sessionId);
}

async function replaceIndexedArchiveTail(sessionId: string, rewindStartSeq: number, archiveLines: ArchiveMessageLine[]): Promise<{ lastIndexedSeq: number; tailStartSeq: number; rowCount: number; segmentCount: number; rebuiltMessageCount: number; rebuiltStartSeq: number; rebuiltEndSeq: number; }> {
    const targetLines = archiveLines.filter(line => line.seq >= rewindStartSeq);
    if (targetLines.length === 0) {
        return {
            lastIndexedSeq: getLastIndexedSeq(sessionId),
            tailStartSeq: getSessionArchiveCheckpoint(sessionId).tailStartSeq,
            rowCount: 0,
            segmentCount: 0,
            rebuiltMessageCount: 0,
            rebuiltStartSeq: 0,
            rebuiltEndSeq: 0,
        };
    }

    await table.delete(`session_id = '${escapeFilterValue(sessionId)}' AND memory_kind = 'raw' AND start_seq >= ${rewindStartSeq}`);

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
        rebuiltMessageCount: targetLines.length,
        rebuiltStartSeq: targetLines[0].seq,
        rebuiltEndSeq: targetLines[targetLines.length - 1].seq,
    };
}

async function appendIndexedBlocks(sessionId: string, lastIndexedBlockId: number, blockLines: ArchiveBlockRecord[]): Promise<{ lastIndexedBlockId: number; rowCount: number; blockCount: number; }> {
    const targetBlocks = blockLines.filter(line => line.id > lastIndexedBlockId);
    if (targetBlocks.length === 0) {
        return {
            lastIndexedBlockId,
            rowCount: 0,
            blockCount: 0,
        };
    }

    const rowGroups = await Promise.all(targetBlocks.map(createRowsFromBlockRecord));
    const rows = rowGroups.flat();
    const hydratedRows: VectorRow[] = [];

    for (const row of rows) {
        const vector = await getEmbedding(row.chunk_text);
        hydratedRows.push({ ...row, vector });
    }

    if (hydratedRows.length > 0) {
        await table.add(hydratedRows);
    }

    return {
        lastIndexedBlockId: targetBlocks[targetBlocks.length - 1].id,
        rowCount: hydratedRows.length,
        blockCount: targetBlocks.length,
    };
}

async function indexSessionArchiveInternal(sessionId: string, latestSeqHint?: number, latestBlockIdHint?: number): Promise<number> {
    const checkpoint = getSessionArchiveCheckpoint(sessionId);
    const lastIndexedSeq = checkpoint.lastIndexedSeq;
    const lastIndexedBlockId = checkpoint.lastIndexedBlockId;
    const shouldSkipRaw = latestSeqHint !== undefined && latestSeqHint <= lastIndexedSeq;
    const shouldSkipBlocks = latestBlockIdHint !== undefined && latestBlockIdHint <= lastIndexedBlockId;
    if (shouldSkipRaw && shouldSkipBlocks) {
        return lastIndexedSeq;
    }

    const archiveLines = await readArchiveLines(sessionId);
    const blockLines = await readLocalBlockLines(sessionId);

    if (archiveLines.length === 0 && blockLines.length === 0) {
        return lastIndexedSeq;
    }

    let nextLastIndexedSeq = lastIndexedSeq;
    let nextTailStartSeq = checkpoint.tailStartSeq;
    let rawRowCount = 0;
    let rawSegmentCount = 0;
    let rebuiltMessageCount = 0;
    let rebuiltStartSeq = 0;
    let rebuiltEndSeq = 0;

    const latestArchivedSeq = archiveLines[archiveLines.length - 1]?.seq || 0;
    if (archiveLines.length > 0 && latestArchivedSeq > lastIndexedSeq) {
        const rewindStartSeqCandidate = checkpoint.tailStartSeq > 0 ? checkpoint.tailStartSeq : archiveLines[0].seq;
        const rewindStartSeq = archiveLines.some(line => line.seq >= rewindStartSeqCandidate)
            ? rewindStartSeqCandidate
            : archiveLines[0].seq;

        const rebuildLines = archiveLines.filter(line => line.seq >= rewindStartSeq);
        const startTime = Date.now();

        logger.info({
            sessionId,
            latestSeqHint,
            lastIndexedSeq,
            latestArchivedSeq,
            rewindStartSeq,
            pendingMessageCount: Math.max(0, latestArchivedSeq - lastIndexedSeq),
            rebuildMessageCount: rebuildLines.length,
            rebuildStartSeq: rebuildLines[0]?.seq,
            rebuildEndSeq: rebuildLines[rebuildLines.length - 1]?.seq,
        }, 'Starting session archive vector raw index rebuild');

        const result = await replaceIndexedArchiveTail(sessionId, rewindStartSeq, archiveLines);
        nextLastIndexedSeq = result.lastIndexedSeq;
        nextTailStartSeq = result.tailStartSeq;
        rawRowCount = result.rowCount;
        rawSegmentCount = result.segmentCount;
        rebuiltMessageCount = result.rebuiltMessageCount;
        rebuiltStartSeq = result.rebuiltStartSeq;
        rebuiltEndSeq = result.rebuiltEndSeq;

        logger.info({
            sessionId,
            latestSeqHint,
            previousLastIndexedSeq: lastIndexedSeq,
            rewindStartSeq,
            lastIndexedSeq: result.lastIndexedSeq,
            tailStartSeq: result.tailStartSeq,
            advancedBy: Math.max(0, result.lastIndexedSeq - lastIndexedSeq),
            rebuiltMessageCount: result.rebuiltMessageCount,
            rebuiltStartSeq: result.rebuiltStartSeq || undefined,
            rebuiltEndSeq: result.rebuiltEndSeq || undefined,
            rowCount: result.rowCount,
            segmentCount: result.segmentCount,
            durationMs: Date.now() - startTime,
        }, 'Completed session archive vector raw index rebuild');
    }

    let nextLastIndexedBlockId = lastIndexedBlockId;
    let blockRowCount = 0;
    let blockCount = 0;
    if (blockLines.length > 0) {
        const blockResult = await appendIndexedBlocks(sessionId, lastIndexedBlockId, blockLines);
        nextLastIndexedBlockId = blockResult.lastIndexedBlockId;
        blockRowCount = blockResult.rowCount;
        blockCount = blockResult.blockCount;
        if (blockCount > 0) {
            logger.info({
                sessionId,
                latestBlockIdHint,
                previousLastIndexedBlockId: lastIndexedBlockId,
                lastIndexedBlockId: nextLastIndexedBlockId,
                blockCount,
                rowCount: blockRowCount,
            }, 'Completed session archive vector block append');
        }
    }

    logger.info({
        sessionId,
        latestSeqHint,
        latestBlockIdHint,
        lastIndexedSeq: nextLastIndexedSeq,
        tailStartSeq: nextTailStartSeq,
        lastIndexedBlockId: nextLastIndexedBlockId,
        rebuiltMessageCount,
        rebuiltStartSeq: rebuiltStartSeq || undefined,
        rebuiltEndSeq: rebuiltEndSeq || undefined,
        rawRowCount,
        rawSegmentCount,
        blockRowCount,
        blockCount,
    }, 'Completed session archive vector index cycle');

    setVectorCheckpointSync(sessionId, {
        rawLastIndexedSeq: nextLastIndexedSeq,
        rawTailStartSeq: nextTailStartSeq,
        lastIndexedBlockId: nextLastIndexedBlockId,
    });

    return nextLastIndexedSeq;
}

function queueArchiveIndexRun(sessionId: string, targetLatestSeqHint?: number, targetLatestBlockIdHint?: number): Promise<number> {
    const previous = indexingChains.get(sessionId) || Promise.resolve(getLastIndexedSeq(sessionId));
    const next = previous
        .catch(() => getLastIndexedSeq(sessionId))
        .then(() => indexSessionArchiveInternal(sessionId, targetLatestSeqHint, targetLatestBlockIdHint));

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
    const checkpoint = getSessionArchiveCheckpoint(sessionId);
    const lastIndexedSeq = checkpoint.lastIndexedSeq;
    const lastIndexedBlockId = checkpoint.lastIndexedBlockId;

    if (!state || (state.latestSeqHint <= lastIndexedSeq && state.latestBlockIdHint <= lastIndexedBlockId)) {
        resolveBatchState(sessionId, lastIndexedSeq);
        return Promise.resolve(lastIndexedSeq);
    }

    const promise = ensureBatchPromise(state);
    const pendingCount = Math.max(0, state.latestSeqHint - lastIndexedSeq);
    const pendingBlockCount = Math.max(0, state.latestBlockIdHint - lastIndexedBlockId);
    const decision = getArchiveIndexBatchDecision({
        pendingCount,
        pendingBlockCount,
        pendingEstimatedTokens: state.pendingEstimatedTokens,
    });

    if (decision.shouldFlushNow) {
        if (state.flushQueued) {
            return promise;
        }

        state.flushQueued = true;

        const targetLatestSeqHint = state.latestSeqHint;
        const targetLatestBlockIdHint = state.latestBlockIdHint;
        state.pendingEstimatedTokens = 0;

        logger.debug({
            sessionId,
            pendingCount: decision.pendingCount,
            pendingBlockCount: decision.pendingBlockCount,
            pendingEstimatedTokens: decision.pendingEstimatedTokens,
            reason: decision.reason,
            targetLatestSeqHint,
            targetLatestBlockIdHint,
            lastIndexedSeq,
            lastIndexedBlockId,
        }, 'Queueing session archive indexing batch');

        queueArchiveIndexRun(sessionId, targetLatestSeqHint, targetLatestBlockIdHint)
            .then((indexedSeq) => {
                const currentState = archiveIndexBatchStates.get(sessionId);
                if (!currentState) {
                    return;
                }

                currentState.flushQueued = false;

                const currentCheckpoint = getSessionArchiveCheckpoint(sessionId);
                if (indexedSeq < targetLatestSeqHint
                    && currentState.latestSeqHint <= targetLatestSeqHint
                    && currentCheckpoint.lastIndexedBlockId >= targetLatestBlockIdHint) {
                    logger.warn({ sessionId, targetLatestSeqHint, targetLatestBlockIdHint, indexedSeq }, 'Archive index batch made no progress; clearing pending batch hint');
                    resolveBatchState(sessionId, indexedSeq);
                    return;
                }

                if (currentState.latestSeqHint <= indexedSeq && currentState.latestBlockIdHint <= currentCheckpoint.lastIndexedBlockId) {
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

async function scheduleSessionArchiveIndex(sessionId: string, latestSeqHint?: number, latestMessageTokenEstimate?: number, latestBlockIdHint?: number): Promise<number> {
    const checkpoint = getSessionArchiveCheckpoint(sessionId);
    const lastIndexedSeq = checkpoint.lastIndexedSeq;
    if ((latestSeqHint === undefined || latestSeqHint <= lastIndexedSeq)
        && (latestBlockIdHint === undefined || latestBlockIdHint <= checkpoint.lastIndexedBlockId)) {
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

    if (latestBlockIdHint !== undefined && latestBlockIdHint > state.latestBlockIdHint) {
        state.latestBlockIdHint = latestBlockIdHint;
    }

    return planSessionArchiveIndex(sessionId);
}

async function indexSessionArchive(sessionId: string, latestSeqHint?: number, latestBlockIdHint?: number): Promise<number> {
    const checkpoint = getSessionArchiveCheckpoint(sessionId);
    const lastIndexedSeq = checkpoint.lastIndexedSeq;
    const state = getOrCreateBatchState(sessionId);

    if (latestSeqHint !== undefined && latestSeqHint > state.latestSeqHint) {
        state.latestSeqHint = latestSeqHint;
    }

    if (latestBlockIdHint !== undefined && latestBlockIdHint > state.latestBlockIdHint) {
        state.latestBlockIdHint = latestBlockIdHint;
    }

    if (state.latestSeqHint <= lastIndexedSeq && state.latestBlockIdHint <= checkpoint.lastIndexedBlockId) {
        clearBatchState(sessionId);
        return lastIndexedSeq;
    }

    ensureBatchPromise(state);
    state.pendingEstimatedTokens = 0;
    state.flushQueued = true;

    try {
        const targetLatestSeqHint = state.latestSeqHint;
        const targetLatestBlockIdHint = state.latestBlockIdHint;
        const indexedSeq = await queueArchiveIndexRun(sessionId, targetLatestSeqHint, targetLatestBlockIdHint);
        const currentState = archiveIndexBatchStates.get(sessionId);
        const currentCheckpoint = getSessionArchiveCheckpoint(sessionId);

        if (indexedSeq < targetLatestSeqHint
            && (!currentState || currentState.latestSeqHint <= targetLatestSeqHint)
            && currentCheckpoint.lastIndexedBlockId >= targetLatestBlockIdHint) {
            logger.warn({ sessionId, targetLatestSeqHint, targetLatestBlockIdHint, indexedSeq }, 'Forced archive index made no progress; clearing pending batch hint');
            resolveBatchState(sessionId, indexedSeq);
            return indexedSeq;
        }

        if (currentState && (currentState.latestSeqHint > indexedSeq || currentState.latestBlockIdHint > currentCheckpoint.lastIndexedBlockId)) {
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

            if (!entry.isFile() || !entry.name.endsWith('.jsonl') || entry.name.endsWith('.blocks.jsonl')) {
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
    const oldCheckpoint = getSessionArchiveCheckpoint(oldSessionId);
    const newCheckpoint = getSessionArchiveCheckpoint(newSessionId);

    if (oldCheckpoint.updatedAt <= 0 && newCheckpoint.updatedAt <= 0) {
        return;
    }

    setVectorCheckpointSync(newSessionId, {
        rawLastIndexedSeq: Math.max(oldCheckpoint.lastIndexedSeq, newCheckpoint.lastIndexedSeq),
        rawTailStartSeq: oldCheckpoint.lastIndexedSeq > newCheckpoint.lastIndexedSeq
            ? oldCheckpoint.tailStartSeq
            : newCheckpoint.tailStartSeq,
        lastIndexedBlockId: Math.max(oldCheckpoint.lastIndexedBlockId, newCheckpoint.lastIndexedBlockId),
    });
}

async function copySessionArchiveIndexCheckpoint(sourceSessionId: string, targetSessionId: string): Promise<void> {
    const sourceCheckpoint = getSessionArchiveCheckpoint(sourceSessionId);
    if (sourceCheckpoint.updatedAt <= 0) {
        return;
    }

    setVectorCheckpointSync(targetSessionId, {
        rawLastIndexedSeq: sourceCheckpoint.lastIndexedSeq,
        rawTailStartSeq: sourceCheckpoint.lastIndexedSeq > 0 ? sourceCheckpoint.lastIndexedSeq + 1 : 0,
        lastIndexedBlockId: sourceCheckpoint.lastIndexedBlockId,
    });
}

function formatSeqLabel(startSeq: number, endSeq: number): string {
    return startSeq === endSeq ? `${startSeq}` : `${startSeq}-${endSeq}`;
}

function getMemorySearchCandidateCount(limit: number): number {
    return Math.max(limit * 4, 20);
}

function reciprocalRank(rank: number, k: number = 60): number {
    return 1 / (k + rank + 1);
}

function rerankSearchResultsByRecency(results: any[], limit: number): any[] {
    if (results.length <= 1) {
        return results.slice(0, limit);
    }

    const semanticRank = new Map<string, number>();
    const recencyRank = new Map<string, number>();

    [...results]
        .sort((a, b) => {
            const ad = Number.isFinite(Number(a._distance)) ? Number(a._distance) : Number.POSITIVE_INFINITY;
            const bd = Number.isFinite(Number(b._distance)) ? Number(b._distance) : Number.POSITIVE_INFINITY;
            return ad - bd;
        })
        .forEach((row, index) => semanticRank.set(String(row.id), index));

    [...results]
        .sort((a, b) => Number(b.end_timestamp ?? b.start_timestamp ?? b.timestamp ?? 0) - Number(a.end_timestamp ?? a.start_timestamp ?? a.timestamp ?? 0))
        .forEach((row, index) => recencyRank.set(String(row.id), index));

    return [...results]
        .map((row) => {
            const id = String(row.id);
            const semantic = reciprocalRank(semanticRank.get(id) ?? results.length);
            const recency = reciprocalRank(recencyRank.get(id) ?? results.length);
            return {
                ...row,
                _rerankScore: semantic + (recency * 0.75),
            };
        })
        .sort((a, b) => {
            if (b._rerankScore !== a._rerankScore) {
                return b._rerankScore - a._rerankScore;
            }
            return (Number(a._distance) || 0) - (Number(b._distance) || 0);
        })
        .slice(0, limit);
}

function buildMemoryPreview(text: string, maxChars: number = 420): string {
    const normalized = String(text || '').trim().replace(/\n{3,}/g, '\n\n');
    if (normalized.length <= maxChars) {
        return normalized;
    }

    const clipped = normalized.slice(0, maxChars);
    const lastBoundary = Math.max(
        clipped.lastIndexOf('\n'),
        clipped.lastIndexOf('. '),
        clipped.lastIndexOf('。'),
        clipped.lastIndexOf('! '),
        clipped.lastIndexOf('? '),
    );

    if (lastBoundary >= Math.floor(maxChars * 0.55)) {
        return `${clipped.slice(0, lastBoundary).trim()}…`;
    }

    return `${clipped.trim()}…`;
}

async function clipResultToLineageBoundary(result: any, options?: SearchOptions): Promise<any> {
    if (!options?.lineageSessions?.length || result.kind !== 'raw') {
        return result;
    }

    const lineageEntry = options.lineageSessions.find(entry => entry.sessionId === result.session_id);
    if (!lineageEntry || typeof lineageEntry.maxMessageSeq !== 'number') {
        return result;
    }

    const maxSeq = lineageEntry.maxMessageSeq;
    const startSeq = Number(result.start_seq ?? result.seq ?? 0);
    const endSeq = Number(result.end_seq ?? result.seq ?? 0);
    if (!(startSeq <= maxSeq && endSeq > maxSeq)) {
        return result;
    }

    const allowedRecords = await readLocalArchiveMessagesBySeqRange(result.session_id, startSeq, maxSeq);
    const allowedMessages = allowedRecords
        .map(normalizeArchiveMessageLine)
        .filter((message): message is ArchiveSegmentMessage => Boolean(message));

    if (allowedMessages.length === 0) {
        return null;
    }

    const clippedText = allowedMessages.map(message => message.text).join('\n\n');
    return {
        ...result,
        seq: allowedMessages[0].seq,
        start_seq: allowedMessages[0].seq,
        end_seq: allowedMessages[allowedMessages.length - 1].seq,
        raw_start_seq: allowedMessages[0].seq,
        raw_end_seq: allowedMessages[allowedMessages.length - 1].seq,
        message_count: allowedMessages.length,
        timestamp: allowedMessages[0].timestamp,
        start_timestamp: allowedMessages[0].timestamp,
        end_timestamp: allowedMessages[allowedMessages.length - 1].timestamp,
        text: clippedText,
        chunk_text: truncateToTokenLimit(clippedText, EMBEDDING_MAX_LENGTH),
    };
}

async function search(query: string, limit = 5, format = true, options?: SearchOptions) {
    const vector = await getEmbedding(query);
    const results: any[] = [];
    const candidateLimit = getMemorySearchCandidateCount(limit);
    let searchQuery = table.search(vector);
    const predicate = buildFilterPredicate(options);
    if (predicate) {
        searchQuery = searchQuery.where(predicate);
    }
    const iterator = await searchQuery.limit(candidateLimit).execute();

    for await (const row of iterator) {
        const records = row.toArray();
        for (const record of records) {
            if (!record.text || record.session_id === '__init__') continue;
            results.push({
                id: record.id,
                kind: record.memory_kind || 'raw',
                message_id: record.message_id,
                session_id: record.session_id,
                agent: record.agent,
                seq: record.start_seq ?? record.seq,
                start_seq: record.start_seq ?? record.seq,
                end_seq: record.end_seq ?? record.seq,
                raw_start_seq: record.raw_start_seq ?? record.start_seq ?? record.seq,
                raw_end_seq: record.raw_end_seq ?? record.end_seq ?? record.seq,
                message_count: record.message_count ?? 1,
                role: record.role,
                timestamp: record.timestamp,
                start_timestamp: record.start_timestamp ?? record.timestamp,
                end_timestamp: record.end_timestamp ?? record.timestamp,
                chunk_index: record.chunk_index,
                chunk_count: record.chunk_count,
                block_id: record.block_id ?? undefined,
                block_level: record.block_level ?? undefined,
                source_kind: record.source_kind ?? undefined,
                source_start: record.source_start ?? undefined,
                source_end: record.source_end ?? undefined,
                text: record.text,
                chunk_text: record.chunk_text,
                _distance: record._distance,
            });
        }
    }

    const normalizedResults = (await Promise.all(results.map(result => clipResultToLineageBoundary(result, options))))
        .filter((result): result is any => Boolean(result));

    const reranked = rerankSearchResultsByRecency(normalizedResults, limit);

    if (!format) return reranked;
    if (reranked.length === 0) return '';

    return reranked.map(r => {
        const ts = r.start_timestamp != null && !isNaN(Number(r.start_timestamp)) ? Number(r.start_timestamp) : null;
        const date = ts ? new Date(ts) : null;
        const dateStr = (date && !isNaN(date.getTime())) ? date.toISOString() : 'unknown';
        const seqLabel = formatSeqLabel(Number(r.start_seq), Number(r.end_seq));
        const rawLabel = formatSeqLabel(Number(r.raw_start_seq ?? r.start_seq), Number(r.raw_end_seq ?? r.end_seq));
        const blockLabel = r.kind === 'block'
            ? ` [kind: block] [B#${r.block_id ?? '?'} L${r.block_level ?? '?'}] [raw: ${rawLabel}]`
            : '';
        return `[${dateStr}] [session: ${r.session_id}]${blockLabel} [seq: ${seqLabel}] [messages: ${r.message_count}] [chunk ${Number(r.chunk_index) + 1}/${r.chunk_count}]\n${buildMemoryPreview(r.text)}`;
    }).join('\n\n---\n\n');
}

async function getContextAround(timestamp: number, limit = 10) {
    const ts = Number(timestamp);
    const lower = ts - 1800000;
    const upper = ts + 1800000;
    const results: any[] = [];

    const iterator = await table.query()
        .where(`memory_kind = 'raw' AND start_timestamp <= ${upper} AND end_timestamp >= ${lower}`)
        .limit(limit)
        .execute();

    for await (const row of iterator) {
        const records = row.toArray();
        for (const record of records) {
            if (!record.text || record.session_id === '__init__') continue;
            results.push({
                id: record.id,
                kind: record.memory_kind || 'raw',
                message_id: record.message_id,
                session_id: record.session_id,
                agent: record.agent,
                seq: record.start_seq ?? record.seq,
                start_seq: record.start_seq ?? record.seq,
                end_seq: record.end_seq ?? record.seq,
                raw_start_seq: record.raw_start_seq ?? record.start_seq ?? record.seq,
                raw_end_seq: record.raw_end_seq ?? record.end_seq ?? record.seq,
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
    await initArchiveStore();
    const db = await lancedb.connect(DB_PATH);
    try {
        table = await db.openTable(TABLE_NAME);
    } catch (e) {
        table = await db.createTable(TABLE_NAME, [{
            id: '__init__',
            message_id: '__init__',
            session_id: '__init__',
            agent: '__init__',
            memory_kind: 'raw',
            seq: 0,
            start_seq: 0,
            end_seq: 0,
            raw_start_seq: 0,
            raw_end_seq: 0,
            message_count: 1,
            role: 'system',
            timestamp: 0,
            start_timestamp: 0,
            end_timestamp: 0,
            chunk_index: 0,
            chunk_count: 1,
            text: 'init',
            chunk_text: 'init',
            block_id: 0,
            block_level: 0,
            source_kind: '',
            source_start: 0,
            source_end: 0,
            vector: new Array(1024).fill(0),
        }]);
        try {
            await table.delete("id = '__init__'");
        } catch (deleteError) {
            logger.warn({ err: deleteError }, 'Failed to remove vector init row');
        }
    }

    await loadCheckpoints();
    await migrateLegacyCheckpointsToDb();
}

// Compatibility wrapper during migration away from history-based indexing.
async function indexNewMessages(sessionId: string, _history: Message[], _lastIndexedPosition: number = 0): Promise<number> {
    await indexSessionArchive(sessionId);
    return _history.length;
}

function getArchiveIndexStatus(sessionId: string): { lastIndexedSeq: number; tailStartSeq: number; lastIndexedBlockId: number } {
    const checkpoint = getSessionArchiveCheckpoint(sessionId);
    return {
        lastIndexedSeq: checkpoint.lastIndexedSeq,
        tailStartSeq: checkpoint.tailStartSeq,
        lastIndexedBlockId: checkpoint.lastIndexedBlockId,
    };
}

export {
    buildArchiveSegments,
    calculateNextSegmentStartIndex,
    copySessionArchiveIndexCheckpoint,
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
