import crypto from 'crypto';
import fs from 'fs-extra';
import { Message } from './types';
import { estimateTokenCount } from './tokenCount';
import { DB_DIR, VECTOR_BASE_URL, VECTOR_MAINTENANCE_CONFIG } from './config';
import { logger } from './common';
import {
    FairTableOperationGate,
    VectorMaintenanceCoordinator,
    VectorMaintenanceTrigger,
} from './vectorMaintenance';
import { formatMessageText } from './utils/messageFormat';
import * as lexicalRuntime from './vectorLexicalRuntime';
import { isModelVisibleMessage } from './session/messageVisibility';
import type { ExtractedMemoryFact, MemoryFactAttribution, MemoryFactKind } from './session/compactPlan';
import {
    ArchiveBlockRecord,
    readLocalArchiveBlocksByIdRange,
} from './session/layeredContext';
import {
    ArchiveMessageRecord,
    getLocalArchiveMessageStats,
    readLocalArchiveMessagesBySeqRange,
} from './session/archive';
import {
    getVectorCheckpointSync,
    getLocalArchiveVectorMaximaSync,
    listSessionsNeedingVectorBackfill,
    initArchiveStore,
    setVectorCheckpointSync,
} from './session/archiveStore';

const DB_PATH = DB_DIR;
const TABLE_NAME = 'messages_v7';
const EMBEDDING_MODEL = 'qwen3-embedding:0.6b';
const QUERY_RETRIEVAL_INSTRUCTION = 'Instruct: Retrieve relevant historical conversation context for the query.\nQuery: ';

// Keep a conservative margin under the embedding model's real 4096-token limit
// because estimateTokenCount() can undercount slightly on some inputs.
// Raw archive indexing now targets a noticeably finer 1500-token chunk ceiling,
// while still aggregating adjacent messages into moderately sized segments.
const CHUNK_SIZE = 1500;
const EMBEDDING_MAX_LENGTH = 1500;
const SEGMENT_TARGET_TOKENS = 1200;
const SEGMENT_OVERLAP_TOKENS = 400;
const SEGMENT_OVERLAP_MAX_MESSAGE_TOKENS = 400;
const ARCHIVE_INDEX_MIN_PENDING_MESSAGES = 50;
const ARCHIVE_INDEX_MIN_PENDING_TOKENS = 8000;
const ARCHIVE_INDEX_MAX_LATENCY_MS = 5 * 60_000;
const RAW_REBUILD_BATCH_SEGMENT_LIMIT = Math.max(1, Number(process.env.FOXWARM_VECTOR_RAW_REBUILD_BATCH_SEGMENTS || 16));
const VECTOR_MAINTENANCE_MUTATION_CHECK_EVERY = 128;
const VECTOR_MAINTENANCE_MAX_OLD_VERSIONS = 512;
const VECTOR_MAINTENANCE_MAX_SMALL_FRAGMENTS = 256;
const VECTOR_MAINTENANCE_DELAY_MS = 60_000;
const VECTOR_MAINTENANCE_PERIODIC_MS = 24 * 60 * 60_000;
const VECTOR_MAINTENANCE_RETRY_MS = 60 * 60_000;
const MAX_SEARCH_CANDIDATE_ROWS = 1024;

let connection: any;
let table: any;
const indexingChains = new Map<string, Promise<number>>();
const archiveIndexBatchStates = new Map<string, SessionArchiveBatchState>();
let startupBackfillPromise: Promise<void> | null = null;
let startupWorkCompleted = false;
let shuttingDown = false;
let tableOperationGate = new FairTableOperationGate();
let maintenanceCoordinator: VectorMaintenanceCoordinator | undefined;
type ArchiveIndexTimerHandle = { unref?: () => void };
let archiveIndexNow = () => Date.now();
let archiveIndexSetTimer = (callback: () => void, delayMs: number): ArchiveIndexTimerHandle => setTimeout(callback, delayMs);
let archiveIndexClearTimer = (handle: ArchiveIndexTimerHandle) => clearTimeout(handle as ReturnType<typeof setTimeout>);

type VectorRow = {
    id: string;
    message_id: string;
    session_id: string;
    agent: string;
    memory_kind: 'raw' | 'block' | 'fact';
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

type MatchedFactMetadata = {
    text: string;
    fact_kind?: MemoryFactKind;
    attributed_to?: MemoryFactAttribution;
    distance: number;
};

export type SearchOptions = {
    sessionIds?: string[];
    agent?: string;
    lineageSessions?: Array<{ sessionId: string; maxMessageSeq?: number; maxBlockId?: number }>;
    includeRegex?: string;
    excludeRegex?: string;
    preferBlocks?: boolean;
};

export type CompactMemoryFactIndexInput = {
    sessionId: string;
    agent?: string;
    facts: ExtractedMemoryFact[];
    sourceStartSeq: number;
    sourceEndSeq: number;
    blockId: number;
    blockLevel: number;
    createdAt?: number;
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

type SessionArchiveBatchState = {
    latestSeqHint: number;
    latestBlockIdHint: number;
    pendingEstimatedTokens: number;
    flushQueued: boolean;
    promise?: Promise<number>;
    resolve?: (value: number) => void;
    reject?: (reason?: unknown) => void;
    maxLatencyDeadline?: number;
    maxLatencyTimer?: ArchiveIndexTimerHandle;
};

type RawRebuildProgress = {
    lastIndexedSeq: number;
    tailStartSeq: number;
    processedSegments: number;
    totalSegments: number;
    processedRows: number;
    totalRows: number;
    processedMessageCount: number;
    totalMessageCount: number;
    batchRowCount: number;
    batchSegmentCount: number;
    batchStartSeq: number;
    batchEndSeq: number;
    batchNumber: number;
    batchCount: number;
    elapsedMs: number;
    batchDurationMs: number;
};

type ArchiveIndexBatchDecision = {
    shouldFlushNow: boolean;
    pendingCount: number;
    pendingBlockCount: number;
    pendingEstimatedTokens: number;
    reason?: 'message-threshold' | 'token-threshold' | 'block-pending';
};

type VectorTableMaintenanceSnapshot = {
    versionCount: number;
    oldVersionCount: number;
    numRows: number;
    totalBytes: number;
    numFragments: number;
    numSmallFragments: number;
};

async function readVectorTableMaintenanceSnapshot(cleanupOlderThan: Date): Promise<VectorTableMaintenanceSnapshot> {
    const [stats, versions] = await Promise.all([
        table.stats(),
        table.listVersions(),
    ]);
    return {
        versionCount: versions.length,
        oldVersionCount: versions.filter((version: any) => (
            new Date(version.timestamp).getTime() < cleanupOlderThan.getTime()
        )).length,
        numRows: Number(stats.numRows) || 0,
        totalBytes: Number(stats.totalBytes) || 0,
        numFragments: Number(stats.fragmentStats?.numFragments) || 0,
        numSmallFragments: Number(stats.fragmentStats?.numSmallFragments) || 0,
    };
}

async function runVectorMaintenanceCheck(triggers: VectorMaintenanceTrigger[]): Promise<void> {
    let denseError: unknown;
    try {
      await tableOperationGate.runExclusive(async () => {
        if (!table || shuttingDown) {
            return;
        }
        const startedAt = Date.now();
        const cleanupOlderThan = new Date(
            startedAt - (VECTOR_MAINTENANCE_CONFIG.retentionHours * 60 * 60_000),
        );
        const before = await readVectorTableMaintenanceSnapshot(cleanupOlderThan);
        const shouldOptimize = before.numSmallFragments >= VECTOR_MAINTENANCE_MAX_SMALL_FRAGMENTS
            || before.oldVersionCount >= VECTOR_MAINTENANCE_MAX_OLD_VERSIONS
            || (triggers.includes('periodic') && before.oldVersionCount > 0);
        if (!shouldOptimize) {
            logger.debug({ triggers, ...before }, 'LanceDB maintenance check skipped below thresholds');
            return;
        }

        logger.info({
            triggers,
            retentionHours: VECTOR_MAINTENANCE_CONFIG.retentionHours,
            cleanupOlderThan: cleanupOlderThan.toISOString(),
            ...before,
        }, 'Starting LanceDB maintenance');

        try {
            const result = await table.optimize({ cleanupOlderThan });
            const after = await readVectorTableMaintenanceSnapshot(cleanupOlderThan);
            logger.info({
                triggers,
                retentionHours: VECTOR_MAINTENANCE_CONFIG.retentionHours,
                durationMs: Date.now() - startedAt,
                before,
                after,
                compaction: result.compaction,
                prune: result.prune,
            }, 'Completed LanceDB maintenance');
        } catch (error) {
            logger.warn({
                err: error,
                triggers,
                retentionHours: VECTOR_MAINTENANCE_CONFIG.retentionHours,
                durationMs: Date.now() - startedAt,
                before,
            }, 'LanceDB maintenance failed');
            throw error;
        }
      });
    } catch (error) {
      denseError = error;
    }
    await lexicalRuntime.runMaintenance();
    if (denseError) throw denseError;
}

function createMaintenanceCoordinator(): VectorMaintenanceCoordinator {
    return new VectorMaintenanceCoordinator({
        enabled: VECTOR_MAINTENANCE_CONFIG.enabled,
        mutationCheckEvery: VECTOR_MAINTENANCE_MUTATION_CHECK_EVERY,
        delayMs: VECTOR_MAINTENANCE_DELAY_MS,
        periodicMs: VECTOR_MAINTENANCE_PERIODIC_MS,
        retryMs: VECTOR_MAINTENANCE_RETRY_MS,
        runCheck: runVectorMaintenanceCheck,
        onError: (error, triggers) => {
            logger.warn({ err: error, triggers, retryMs: VECTOR_MAINTENANCE_RETRY_MS }, 'Scheduled LanceDB maintenance check will retry');
        },
    });
}

async function runTableMutation<T>(run: () => Promise<T>): Promise<T> {
    const result = await run();
    maintenanceCoordinator?.recordMutation();
    return result;
}

async function upsertVectorRowsById(rows: VectorRow[]): Promise<void> {
    if (rows.length === 0) {
        return;
    }
    await runTableMutation(() => table
        .mergeInsert('id')
        .whenMatchedUpdateAll()
        .whenNotMatchedInsertAll()
        .execute(rows));
}

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
            const factClauses: string[] = [];
            if (typeof entry.maxBlockId === 'number') {
                factClauses.push(`(block_id IS NOT NULL AND block_id <= ${entry.maxBlockId})`);
            }
            if (typeof entry.maxMessageSeq === 'number') {
                // Legacy fact rows predate block identity. Their text can summarize
                // the full source span, so a crossing range must not be clipped/reused.
                factClauses.push(`(block_id IS NULL AND raw_end_seq <= ${entry.maxMessageSeq})`);
            }
            const factClause = factClauses.length > 0
                ? `(memory_kind = 'fact' AND (${factClauses.join(' OR ')}))`
                : `(memory_kind = 'fact')`;
            return `(${sessionClause} AND (${rawClause} OR ${blockClause} OR ${factClause}))`;
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
    if (!isModelVisibleMessage(message)) {
        return '';
    }

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

function sanitizeEmbeddingInput(text: string): string {
    const maybeToWellFormed = (text as string & { toWellFormed?: () => string }).toWellFormed;
    if (typeof maybeToWellFormed === 'function') {
        return maybeToWellFormed.call(text);
    }

    let result = '';
    for (let index = 0; index < text.length; index += 1) {
        const code = text.charCodeAt(index);
        if (code >= 0xD800 && code <= 0xDBFF) {
            const nextCode = index + 1 < text.length ? text.charCodeAt(index + 1) : 0;
            if (nextCode >= 0xDC00 && nextCode <= 0xDFFF) {
                result += text[index] + text[index + 1];
                index += 1;
            } else {
                result += '\uFFFD';
            }
            continue;
        }

        if (code >= 0xDC00 && code <= 0xDFFF) {
            result += '\uFFFD';
            continue;
        }

        result += text[index];
    }

    return result;
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
    const row = await createRowFromBlockRecord(record);
    return row ? [row] : [];
}

async function createRowFromBlockRecord(record: ArchiveBlockRecord): Promise<Omit<VectorRow, 'vector'> | null> {
    const text = String(record.summary || '').trim();
    if (!text) {
        return null;
    }

    const messageRecords = await readLocalArchiveMessagesBySeqRange(record.sessionId, record.rawStartSeq, record.rawEndSeq);
    const startTimestamp = Number(messageRecords[0]?.timestamp) || Number(record.createdAt) || Date.now();
    const endTimestamp = Number(messageRecords[messageRecords.length - 1]?.timestamp) || startTimestamp;
    const messageId = `${record.sessionId}:block:${record.id}`;
    const estimatedMessageCount = Math.max(1, record.rawEndSeq - record.rawStartSeq + 1);

    return {
        id: `${messageId}:0`,
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
        chunk_index: 0,
        chunk_count: 1,
        text,
        chunk_text: truncateToTokenLimit(text, EMBEDDING_MAX_LENGTH),
        block_id: record.id,
        block_level: record.level,
        source_kind: record.sourceKind,
        source_start: record.sourceStart,
        source_end: record.sourceEnd,
    };
}

function normalizeMemoryFactTextForHash(text: string): string {
    return String(text || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function buildMemoryFactHash(fact: ExtractedMemoryFact): string {
    return crypto
        .createHash('sha256')
        .update(`${fact.kind}\0${normalizeMemoryFactTextForHash(fact.text)}`)
        .digest('hex')
        .slice(0, 24);
}

function formatMemoryFactText(fact: ExtractedMemoryFact, sourceStartSeq: number, sourceEndSeq: number, blockId: number, blockLevel: number): string {
    const lines = [
        `Memory fact (${fact.kind})`,
        fact.text.trim(),
    ];

    if (fact.context?.trim()) {
        lines.push(`Context: ${fact.context.trim()}`);
    }
    if (fact.attributedTo) {
        lines.push(`Attribution: ${fact.attributedTo}`);
    }
    lines.push(`Source: CTX-BLOCK L${blockLevel} B#${blockId}, raw messages ${formatSeqLabel(sourceStartSeq, sourceEndSeq)}`);
    return lines.join('\n');
}

function parseMemoryFactKind(sourceKind: unknown): MemoryFactKind | undefined {
    if (typeof sourceKind !== 'string' || !sourceKind.startsWith('memory_fact:')) {
        return undefined;
    }
    const kind = sourceKind.slice('memory_fact:'.length);
    return ['decision', 'preference', 'fact', 'convention', 'environment'].includes(kind)
        ? kind as MemoryFactKind
        : undefined;
}

function parseMemoryFactAttribution(role: unknown): MemoryFactAttribution | undefined {
    if (typeof role !== 'string' || !role.startsWith('fact:')) {
        return undefined;
    }
    const parts = role.split(':');
    const attribution = parts[2];
    return ['user', 'assistant', 'both'].includes(attribution)
        ? attribution as MemoryFactAttribution
        : undefined;
}

function createRowsFromMemoryFacts(input: CompactMemoryFactIndexInput): Omit<VectorRow, 'vector'>[] {
    const sourceStartSeq = Number(input.sourceStartSeq);
    const sourceEndSeq = Number(input.sourceEndSeq);
    if (!Number.isFinite(sourceStartSeq) || !Number.isFinite(sourceEndSeq) || sourceStartSeq <= 0 || sourceEndSeq <= 0) {
        return [];
    }

    const startSeq = Math.min(sourceStartSeq, sourceEndSeq);
    const endSeq = Math.max(sourceStartSeq, sourceEndSeq);
    const createdAt = Number(input.createdAt) || Date.now();
    const agent = input.agent || 'main';
    const seenIds = new Set<string>();
    const rows: Omit<VectorRow, 'vector'>[] = [];

    for (const fact of input.facts || []) {
        const text = String(fact?.text || '').trim();
        if (!text) {
            continue;
        }

        const hash = buildMemoryFactHash({ ...fact, text });
        const messageId = `${input.sessionId}:fact:B${input.blockId}:${hash}`;
        const id = `${messageId}:0`;
        if (seenIds.has(id)) {
            continue;
        }
        seenIds.add(id);

        const attributedTo = fact.attributedTo || 'both';
        const rowText = formatMemoryFactText({ ...fact, text, attributedTo }, startSeq, endSeq, input.blockId, input.blockLevel);
        rows.push({
            id,
            message_id: messageId,
            session_id: input.sessionId,
            agent,
            memory_kind: 'fact',
            seq: startSeq,
            start_seq: startSeq,
            end_seq: endSeq,
            raw_start_seq: startSeq,
            raw_end_seq: endSeq,
            message_count: Math.max(1, endSeq - startSeq + 1),
            role: `fact:${fact.kind}:${attributedTo}`,
            timestamp: createdAt,
            start_timestamp: createdAt,
            end_timestamp: createdAt,
            chunk_index: 0,
            chunk_count: 1,
            text: rowText,
            chunk_text: truncateToTokenLimit(rowText, EMBEDDING_MAX_LENGTH),
            block_id: input.blockId,
            block_level: input.blockLevel,
            source_kind: `memory_fact:${fact.kind}`,
            source_start: startSeq,
            source_end: endSeq,
        });
    }

    return rows;
}

async function indexMemoryFactsFromCompaction(input: CompactMemoryFactIndexInput): Promise<number> {
    const rows = createRowsFromMemoryFacts(input);
    if (rows.length === 0) {
        return 0;
    }
    return tableOperationGate.runRegular(async () => {
        if (!table) {
            throw new Error('Vector table is not initialized.');
        }

        const hydratedRows: VectorRow[] = [];
        for (const row of rows) {
            const vector = await getEmbedding(row.chunk_text);
            hydratedRows.push({ ...row, vector });
        }

        await upsertVectorRowsById(hydratedRows);

        logger.info({
            sessionId: input.sessionId,
            factCount: hydratedRows.length,
            sourceStartSeq: input.sourceStartSeq,
            sourceEndSeq: input.sourceEndSeq,
            blockId: input.blockId,
            blockLevel: input.blockLevel,
        }, 'Indexed compact memory facts');

        return hydratedRows.length;
    });
}

function formatQueryEmbeddingInput(query: string): string {
    return `${QUERY_RETRIEVAL_INSTRUCTION}${query}`;
}

async function getEmbedding(text: string, kind: 'document' | 'query' = 'document') {
    const embeddingText = kind === 'query' ? formatQueryEmbeddingInput(text) : text;
    const truncated = truncateToTokenLimit(embeddingText, EMBEDDING_MAX_LENGTH);
    const sanitized = sanitizeEmbeddingInput(truncated);
    if (!VECTOR_BASE_URL) {
        throw new Error('Vector embedding base URL is not configured.');
    }
    const baseUrl = new URL(VECTOR_BASE_URL);
    baseUrl.pathname = `${baseUrl.pathname.replace(/\/+$/, '')}/embeddings`;
    const response = await fetch(baseUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model: EMBEDDING_MODEL,
            input: sanitized,
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

function startStartupArchiveVectorBackfill(): Promise<void> {
    if (startupWorkCompleted) {
        return Promise.resolve();
    }
    if (!startupBackfillPromise) {
        startupBackfillPromise = (async () => {
            await maintenanceCoordinator?.runStartupCheck();
            await runStartupArchiveVectorBackfill();
            startupWorkCompleted = true;
        })().finally(() => {
            startupBackfillPromise = null;
        });
    }

    return startupBackfillPromise;
}

async function waitForStartupArchiveVectorBackfill(): Promise<void> {
    await Promise.all([startStartupArchiveVectorBackfill(), lexicalRuntime.waitForStartupBackfill()]);
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

function cancelBatchDeadline(state: SessionArchiveBatchState): void {
    if (state.maxLatencyTimer) {
        archiveIndexClearTimer(state.maxLatencyTimer);
    }
    state.maxLatencyTimer = undefined;
    state.maxLatencyDeadline = undefined;
}

function armBatchDeadline(sessionId: string, state: SessionArchiveBatchState): void {
    if (state.maxLatencyTimer || shuttingDown) return;
    state.maxLatencyDeadline = archiveIndexNow() + ARCHIVE_INDEX_MAX_LATENCY_MS;
    const expectedDeadline = state.maxLatencyDeadline;
    state.maxLatencyTimer = archiveIndexSetTimer(() => {
        const currentState = archiveIndexBatchStates.get(sessionId);
        if (!currentState || currentState !== state || currentState.maxLatencyDeadline !== expectedDeadline || shuttingDown) return;
        currentState.maxLatencyTimer = undefined;
        currentState.maxLatencyDeadline = undefined;
        void indexSessionArchive(sessionId, currentState.latestSeqHint, currentState.latestBlockIdHint).catch((err) => {
            logger.warn({ err, sessionId }, 'Max-latency archive vector index flush failed');
        });
    }, ARCHIVE_INDEX_MAX_LATENCY_MS);
    state.maxLatencyTimer.unref?.();
}

function clearBatchState(sessionId: string): void {
    const state = archiveIndexBatchStates.get(sessionId);
    if (!state) {
        return;
    }

    cancelBatchDeadline(state);
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

async function readArchiveLines(sessionId: string, startSeq?: number, endSeq?: number): Promise<ArchiveMessageLine[]> {
    return readLocalArchiveMessagesBySeqRange(sessionId, startSeq, endSeq);
}

async function readLocalBlockLines(sessionId: string, startId?: number, endId?: number): Promise<ArchiveBlockRecord[]> {
    return readLocalArchiveBlocksByIdRange(sessionId, startId, endId);
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

    await runTableMutation(() => table.delete(`session_id = '${escapeFilterValue(sessionId)}' AND memory_kind = 'raw' AND start_seq >= ${rewindStartSeq}`));

    const segments = buildArchiveSegments(targetLines);
    const segmentRows = segments.map(segment => ({
        segment,
        rows: createRowsFromSegment(segment),
    }));
    const totalRowCount = segmentRows.reduce((sum, entry) => sum + entry.rows.length, 0);
    const totalMessageCount = targetLines.length;
    const batchCount = Math.max(1, Math.ceil(segmentRows.length / RAW_REBUILD_BATCH_SEGMENT_LIMIT));
    const rebuildStartTime = Date.now();

    let processedSegments = 0;
    let processedRows = 0;
    let finalLastIndexedSeq = targetLines[targetLines.length - 1].seq;
    let finalTailStartSeq = segments[segments.length - 1]?.startSeq || finalLastIndexedSeq;

    for (let batchStartIndex = 0; batchStartIndex < segmentRows.length; batchStartIndex += RAW_REBUILD_BATCH_SEGMENT_LIMIT) {
        const batchStartTime = Date.now();
        const batchEntries = segmentRows.slice(batchStartIndex, batchStartIndex + RAW_REBUILD_BATCH_SEGMENT_LIMIT);
        const hydratedRows: VectorRow[] = [];

        for (const entry of batchEntries) {
            for (const row of entry.rows) {
                const vector = await getEmbedding(row.chunk_text);
                hydratedRows.push({ ...row, vector });
            }
        }

        if (hydratedRows.length > 0) {
            await runTableMutation(() => table.add(hydratedRows));
        }

        processedSegments += batchEntries.length;
        processedRows += hydratedRows.length;

        const lastBatchSegment = batchEntries[batchEntries.length - 1].segment;
        finalLastIndexedSeq = lastBatchSegment.endSeq;
        finalTailStartSeq = lastBatchSegment.startSeq;

        await setSessionArchiveCheckpoint(sessionId, {
            lastIndexedSeq: finalLastIndexedSeq,
            tailStartSeq: finalTailStartSeq,
        });

        const progress: RawRebuildProgress = {
            lastIndexedSeq: finalLastIndexedSeq,
            tailStartSeq: finalTailStartSeq,
            processedSegments,
            totalSegments: segmentRows.length,
            processedRows,
            totalRows: totalRowCount,
            processedMessageCount: Math.max(0, finalLastIndexedSeq - targetLines[0].seq + 1),
            totalMessageCount,
            batchRowCount: hydratedRows.length,
            batchSegmentCount: batchEntries.length,
            batchStartSeq: batchEntries[0].segment.startSeq,
            batchEndSeq: finalLastIndexedSeq,
            batchNumber: Math.floor(batchStartIndex / RAW_REBUILD_BATCH_SEGMENT_LIMIT) + 1,
            batchCount,
            elapsedMs: Date.now() - rebuildStartTime,
            batchDurationMs: Date.now() - batchStartTime,
        };

        logger.info({
            sessionId,
            rewindStartSeq,
            ...progress,
        }, 'Committed session archive vector raw rebuild batch');
    }

    return {
        lastIndexedSeq: finalLastIndexedSeq,
        tailStartSeq: finalTailStartSeq,
        rowCount: totalRowCount,
        segmentCount: segments.length,
        rebuiltMessageCount: targetLines.length,
        rebuiltStartSeq: targetLines[0].seq,
        rebuiltEndSeq: targetLines[targetLines.length - 1].seq,
    };
}

async function appendIndexedBlocks(_sessionId: string, lastIndexedBlockId: number, blockLines: ArchiveBlockRecord[]): Promise<{ lastIndexedBlockId: number; rowCount: number; blockCount: number; }> {
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
        // Block row IDs are deterministic. One atomic upsert keeps a retry
        // after the Lance commit but before the SQLite checkpoint idempotent.
        await upsertVectorRowsById(hydratedRows);
    }

    return {
        lastIndexedBlockId: targetBlocks[targetBlocks.length - 1].id,
        rowCount: hydratedRows.length,
        blockCount: targetBlocks.length,
    };
}

async function indexSessionArchiveUnderLease(sessionId: string, latestSeqHint?: number, latestBlockIdHint?: number): Promise<number> {
    const checkpoint = getSessionArchiveCheckpoint(sessionId);
    const lastIndexedSeq = checkpoint.lastIndexedSeq;
    const lastIndexedBlockId = checkpoint.lastIndexedBlockId;
    const shouldSkipRaw = latestSeqHint !== undefined && latestSeqHint <= lastIndexedSeq;
    const shouldSkipBlocks = latestBlockIdHint !== undefined && latestBlockIdHint <= lastIndexedBlockId;
    if (shouldSkipRaw && shouldSkipBlocks) {
        return lastIndexedSeq;
    }

    const messageStats = await getLocalArchiveMessageStats(sessionId);
    const latestArchivedSeq = messageStats.maxSeq || 0;
    const blockLines = await readLocalBlockLines(sessionId, lastIndexedBlockId + 1);
    if (messageStats.count === 0 && blockLines.length === 0) {
        return lastIndexedSeq;
    }

    let nextLastIndexedSeq = lastIndexedSeq;
    let nextTailStartSeq = checkpoint.tailStartSeq;
    let rawRowCount = 0;
    let rawSegmentCount = 0;
    let rebuiltMessageCount = 0;
    let rebuiltStartSeq = 0;
    let rebuiltEndSeq = 0;

    if (typeof messageStats.minSeq === 'number' && latestArchivedSeq > lastIndexedSeq) {
        const rewindStartSeqCandidate = checkpoint.tailStartSeq > 0 ? checkpoint.tailStartSeq : messageStats.minSeq;
        // This mirrors the prior full-array `some(seq >= candidate)` fallback:
        // a stale tail beyond the durable local maximum safely rebuilds from
        // the first available local sequence, while an in-range gap keeps the
        // candidate and lets the bounded SQL query start at the next row.
        const rewindStartSeq = rewindStartSeqCandidate <= latestArchivedSeq
            ? rewindStartSeqCandidate
            : messageStats.minSeq;
        const rebuildLines = await readArchiveLines(sessionId, rewindStartSeq);
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

        const result = await replaceIndexedArchiveTail(sessionId, rewindStartSeq, rebuildLines);
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

    // Advance lastIndexedBlockId to latestBlockIdHint when there are no new local blocks to index,
    // preventing infinite retry loops when the hint indicates blocks exist but local data is empty
    // (e.g. blocks inherited from parent sessions via lineage).
    if (nextLastIndexedBlockId < (latestBlockIdHint ?? 0) && blockCount === 0) {
        nextLastIndexedBlockId = latestBlockIdHint!;
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

async function indexSessionArchiveInternal(sessionId: string, latestSeqHint?: number, latestBlockIdHint?: number): Promise<number> {
    return tableOperationGate.runRegular(
        () => indexSessionArchiveUnderLease(sessionId, latestSeqHint, latestBlockIdHint),
    );
}

function queueArchiveIndexRun(sessionId: string, targetLatestSeqHint?: number, targetLatestBlockIdHint?: number): Promise<number> {
    const previous = indexingChains.get(sessionId) || Promise.resolve(getLastIndexedSeq(sessionId));
    const next = previous
        .catch(() => getLastIndexedSeq(sessionId))
        .then(() => indexSessionArchiveInternal(sessionId, targetLatestSeqHint, targetLatestBlockIdHint));

    indexingChains.set(sessionId, next);
    const cleanup = () => {
        if (indexingChains.get(sessionId) === next) {
            indexingChains.delete(sessionId);
        }
    };
    void next.then(cleanup, cleanup);

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
        cancelBatchDeadline(state);
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

    armBatchDeadline(sessionId, state);
    return promise;
}

async function scheduleSessionArchiveIndex(sessionId: string, latestSeqHint?: number, latestMessageTokenEstimate?: number, latestBlockIdHint?: number): Promise<number> {
    lexicalRuntime.schedule(sessionId, latestSeqHint, latestBlockIdHint);
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
    lexicalRuntime.force(sessionId, latestSeqHint, latestBlockIdHint);
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

    cancelBatchDeadline(state);
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

async function runStartupArchiveVectorBackfill(): Promise<void> {
    const candidates = await listSessionsNeedingVectorBackfill();
    if (candidates.length === 0) {
        return;
    }

    logger.info({
        sessionCount: candidates.length,
        sessions: candidates.map(candidate => candidate.sessionId),
    }, 'Starting startup archive vector backfill for imported/pending sessions');

    for (const candidate of candidates) {
        try {
            await indexSessionArchive(candidate.sessionId, candidate.latestLocalMessageSeq, candidate.latestLocalBlockId);
        } catch (err) {
            logger.error({
                err,
                sessionId: candidate.sessionId,
                latestLocalMessageSeq: candidate.latestLocalMessageSeq,
                latestLocalBlockId: candidate.latestLocalBlockId,
                checkpointRawLastIndexedSeq: candidate.checkpointRawLastIndexedSeq,
                checkpointLastIndexedBlockId: candidate.checkpointLastIndexedBlockId,
            }, 'Startup archive vector backfill failed for session');
        }
    }

    logger.info({
        sessionCount: candidates.length,
        sessions: candidates.map(candidate => candidate.sessionId),
    }, 'Completed startup archive vector backfill for imported/pending sessions');
}

async function renameSessionArchiveIndex(oldSessionId: string, newSessionId: string): Promise<void> {
    await lexicalRuntime.disableForDeferredLifecycle();
    resolveBatchState(oldSessionId, getSessionArchiveCheckpoint(oldSessionId).lastIndexedSeq);
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
    await lexicalRuntime.disableForDeferredLifecycle();
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
    return Math.max(limit * 8, 40);
}

function buildSearchRegex(pattern: string | undefined, label: 'includeRegex' | 'excludeRegex'): RegExp | null {
    if (!pattern) {
        return null;
    }

    try {
        return new RegExp(pattern, 'i');
    } catch (err: any) {
        throw new Error(`Invalid ${label}: ${err?.message || 'failed to compile regex'}`);
    }
}

function finiteDistance(row: any): number {
    const distance = Number(row?._distance);
    return Number.isFinite(distance) ? distance : Number.POSITIVE_INFINITY;
}

function sourceFamilyKey(row: any): string {
    const sessionId = String(row.session_id || '');
    const blockId = Number(row.block_id);
    if ((row.kind === 'block' || row.kind === 'fact') && Number.isInteger(blockId) && blockId > 0) {
        return `${sessionId}:block:${blockId}`;
    }
    if (row.kind === 'raw') {
        return `${sessionId}:raw:${Number(row.start_seq ?? row.seq ?? 0)}-${Number(row.end_seq ?? row.seq ?? 0)}`;
    }
    return `${sessionId}:${String(row.kind || 'raw')}:${String(row.id || row.message_id || '')}`;
}

function buildMatchedFactMetadata(row: any): MatchedFactMetadata | undefined {
    if (row.kind !== 'fact') return undefined;
    const text = String(row.text || '').trim();
    if (!text) return undefined;
    return {
        text: text.slice(0, 1000),
        fact_kind: row.fact_kind,
        attributed_to: row.attributed_to,
        distance: finiteDistance(row),
    };
}

function groupSearchResultsBySource(results: any[]): any[] {
    const groups = new Map<string, any[]>();
    for (const row of results) {
        const key = sourceFamilyKey(row);
        const members = groups.get(key) || [];
        members.push(row);
        groups.set(key, members);
    }

    return [...groups.entries()].map(([familyKey, members]) => {
        const sortedMembers = [...members].sort((a, b) => finiteDistance(a) - finiteDistance(b) || String(a.id).localeCompare(String(b.id)));
        const representative = sortedMembers[0];
        const blockMember = sortedMembers.find(member => member.kind === 'block');
        const matchedFacts = sortedMembers
            .map(buildMatchedFactMetadata)
            .filter((fact): fact is MatchedFactMetadata => Boolean(fact))
            .sort((a, b) => a.distance - b.distance || a.text.localeCompare(b.text))
            .slice(0, 3);
        const sourceTimestamp = Number(blockMember?.end_timestamp ?? blockMember?.start_timestamp ?? blockMember?.timestamp
            ?? representative.end_timestamp ?? representative.start_timestamp ?? representative.timestamp ?? 0);
        return {
            ...representative,
            source_family: familyKey,
            source_group_size: members.length,
            source_timestamp: Number.isFinite(sourceTimestamp) ? sourceTimestamp : 0,
            has_block_source: Boolean(blockMember),
            matched_facts: matchedFacts,
            _distance: finiteDistance(representative),
        };
    });
}

function metadataTieScore(row: any, recencyRank: number, options?: SearchOptions): number {
    let score = 0;
    if (row.has_block_source || row.kind === 'block') score += options?.preferBlocks ? 4 : 1;
    if (Array.isArray(row.matched_facts) && row.matched_facts.length > 0) score += 2;
    score += 1 / (recencyRank + 2);
    return score;
}

function rankSourceGroupsBySemanticDistance(groups: any[], options?: SearchOptions): any[] {
    const recencyRanks = new Map<string, number>();
    [...groups]
        .sort((a, b) => Number(b.source_timestamp || 0) - Number(a.source_timestamp || 0) || String(a.source_family).localeCompare(String(b.source_family)))
        .forEach((row, index) => recencyRanks.set(String(row.source_family), index));

    return [...groups].sort((a, b) => {
        // Distance is the primary ordering. Metadata can only break effectively
        // equal distances after stable six-decimal quantization.
        const distanceBandA = Math.round(finiteDistance(a) * 1_000_000);
        const distanceBandB = Math.round(finiteDistance(b) * 1_000_000);
        if (distanceBandA !== distanceBandB) return distanceBandA - distanceBandB;
        const tieA = metadataTieScore(a, recencyRanks.get(String(a.source_family)) ?? groups.length, options);
        const tieB = metadataTieScore(b, recencyRanks.get(String(b.source_family)) ?? groups.length, options);
        if (tieA !== tieB) return tieB - tieA;
        const exactDistanceA = finiteDistance(a);
        const exactDistanceB = finiteDistance(b);
        if (exactDistanceA !== exactDistanceB) return exactDistanceA < exactDistanceB ? -1 : 1;
        return String(a.source_family).localeCompare(String(b.source_family));
    });
}

function rawRangeOverlapRatio(a: any, b: any): number {
    if (a.kind !== 'raw' || b.kind !== 'raw' || a.session_id !== b.session_id) return 0;
    const aStart = Number(a.start_seq ?? a.seq ?? 0);
    const aEnd = Number(a.end_seq ?? a.seq ?? 0);
    const bStart = Number(b.start_seq ?? b.seq ?? 0);
    const bEnd = Number(b.end_seq ?? b.seq ?? 0);
    const intersection = Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart) + 1);
    const smallerLength = Math.max(1, Math.min(aEnd - aStart + 1, bEnd - bStart + 1));
    return intersection / smallerLength;
}

function diversifyOverlappingRawGroups(ranked: any[], limit: number): { selected: any[]; diverseCount: number } {
    const diverse: any[] = [];
    const deferred: any[] = [];
    for (const row of ranked) {
        const overlapsSelected = row.kind === 'raw'
            && diverse.some(existing => rawRangeOverlapRatio(row, existing) >= 0.65);
        if (overlapsSelected) deferred.push(row);
        else diverse.push(row);
        if (diverse.length >= limit) {
            return { selected: diverse.slice(0, limit), diverseCount: limit };
        }
    }
    const selected = [...diverse];
    for (const row of deferred) {
        selected.push(row);
        if (selected.length >= limit) break;
    }
    return { selected, diverseCount: diverse.length };
}

function selectSearchSourceGroupsDetailed(results: any[], limit: number, options?: SearchOptions): { selected: any[]; diverseCount: number } {
    if (results.length === 0) return { selected: [], diverseCount: 0 };
    const grouped = groupSearchResultsBySource(results);
    const ranked = rankSourceGroupsBySemanticDistance(grouped, options);
    return diversifyOverlappingRawGroups(ranked, limit);
}

function selectSearchSourceGroups(results: any[], limit: number, options?: SearchOptions): any[] {
    return selectSearchSourceGroupsDetailed(results, limit, options).selected;
}

async function fetchSearchCandidatesAdaptively<T, R>({
    initialRowLimit,
    hardRowLimit,
    requiredSourceCount,
    fetchRows,
    selectSources,
}: {
    initialRowLimit: number;
    hardRowLimit: number;
    requiredSourceCount: number;
    fetchRows: (rowLimit: number) => Promise<T[]>;
    selectSources: (rows: T[]) => Promise<{ selected: R[]; diverseCount: number }>;
}): Promise<R[]> {
    const hardCap = Math.max(1, Math.floor(hardRowLimit));
    let rowLimit = Math.min(hardCap, Math.max(1, Math.floor(initialRowLimit)));

    while (true) {
        const rows = await fetchRows(rowLimit);
        const selection = await selectSources(rows);
        const saturated = rows.length >= rowLimit;
        if (selection.diverseCount >= requiredSourceCount || !saturated || rowLimit >= hardCap) {
            return selection.selected;
        }
        rowLimit = Math.min(hardCap, rowLimit * 2);
    }
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
    if (!options?.lineageSessions?.length) return result;

    const lineageEntry = options.lineageSessions.find(entry => entry.sessionId === result.session_id);
    if (!lineageEntry) return result;

    if (result.kind === 'fact') {
        const blockId = Number(result.block_id);
        if (Number.isInteger(blockId) && blockId > 0) {
            return typeof lineageEntry.maxBlockId === 'number' && blockId > lineageEntry.maxBlockId
                ? null
                : result;
        }
        const legacyEndSeq = Number(result.raw_end_seq ?? result.end_seq ?? result.seq ?? 0);
        return typeof lineageEntry.maxMessageSeq === 'number' && legacyEndSeq > lineageEntry.maxMessageSeq
            ? null
            : result;
    }

    if (result.kind !== 'raw' || typeof lineageEntry.maxMessageSeq !== 'number') {
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
    const vector = await getEmbedding(query, 'query');
    return tableOperationGate.runRegular(() => searchWithVector(vector, limit, format, options));
}

async function searchWithVector(vector: number[], limit = 5, format = true, options?: SearchOptions) {
    const initialCandidateLimit = Math.min(MAX_SEARCH_CANDIDATE_ROWS, options?.includeRegex || options?.excludeRegex || options?.preferBlocks
        ? Math.max(getMemorySearchCandidateCount(limit) * 2, 40)
        : getMemorySearchCandidateCount(limit));
    const predicate = buildFilterPredicate(options);
    const includeRegex = buildSearchRegex(options?.includeRegex, 'includeRegex');
    const excludeRegex = buildSearchRegex(options?.excludeRegex, 'excludeRegex');
    const reranked = await fetchSearchCandidatesAdaptively<any, any>({
        initialRowLimit: initialCandidateLimit,
        hardRowLimit: MAX_SEARCH_CANDIDATE_ROWS,
        requiredSourceCount: Math.max(1, Math.floor(limit)),
        fetchRows: async (candidateLimit) => {
            const results: any[] = [];
            let searchQuery = table.search(vector);
            if (predicate) searchQuery = searchQuery.where(predicate);
            const iterator = await searchQuery.limit(candidateLimit).execute();
            for await (const row of iterator) {
                for (const record of row.toArray()) {
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
                        fact_kind: parseMemoryFactKind(record.source_kind),
                        attributed_to: parseMemoryFactAttribution(record.role),
                        source_kind: record.source_kind ?? undefined,
                        source_start: record.source_start ?? undefined,
                        source_end: record.source_end ?? undefined,
                        text: record.text,
                        chunk_text: record.chunk_text,
                        _distance: record._distance,
                    });
                }
            }
            return results;
        },
        selectSources: async (results) => {
            const normalizedResults = (await Promise.all(results.map(result => clipResultToLineageBoundary(result, options))))
                .filter((result): result is any => Boolean(result));
            const filteredResults = normalizedResults.filter((result) => {
                const haystack = `${result.text || ''}\n${result.chunk_text || ''}`;
                if (includeRegex) {
                    includeRegex.lastIndex = 0;
                    if (!includeRegex.test(haystack)) return false;
                }
                if (excludeRegex) {
                    excludeRegex.lastIndex = 0;
                    if (excludeRegex.test(haystack)) return false;
                }
                return true;
            });
            return selectSearchSourceGroupsDetailed(filteredResults, limit, options);
        },
    });

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
        const factLabel = r.kind === 'fact'
            ? ` [kind: memory fact] [fact: ${r.fact_kind || '?'}] [source: raw ${rawLabel}]${r.attributed_to ? ` [attributed: ${r.attributed_to}]` : ''}`
            : '';
        return `[${dateStr}] [session: ${r.session_id}]${blockLabel}${factLabel} [seq: ${seqLabel}] [messages: ${r.message_count}] [chunk ${Number(r.chunk_index) + 1}/${r.chunk_count}]\n${buildMemoryPreview(r.text)}`;
    }).join('\n\n---\n\n');
}

async function init() {
    if (table) {
        return;
    }
    shuttingDown = false;
    startupWorkCompleted = false;
    tableOperationGate = new FairTableOperationGate();
    await fs.ensureDir(DB_PATH);
    await initArchiveStore();
    // Keep the native LanceDB module out of the main process when the vector
    // service is placed in its default child process.
    const lancedb = await import('@lancedb/lancedb');
    connection = await lancedb.connect(DB_PATH);
    try {
        table = await connection.openTable(TABLE_NAME);
    } catch (e) {
        table = await connection.createTable(TABLE_NAME, [{
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

    maintenanceCoordinator = createMaintenanceCoordinator();
    maintenanceCoordinator.start();

    await lexicalRuntime.init();

    void startStartupArchiveVectorBackfill().catch((err) => {
        logger.error({ err }, 'Startup archive vector backfill failed');
    });
}

async function shutdown(): Promise<void> {
    shuttingDown = true;
    for (const state of archiveIndexBatchStates.values()) cancelBatchDeadline(state);
    await maintenanceCoordinator?.shutdown();
    await lexicalRuntime.shutdown();
    const activeWork = [
        ...(startupBackfillPromise ? [startupBackfillPromise] : []),
        ...indexingChains.values(),
    ];
    if (activeWork.length > 0) {
        await Promise.allSettled(activeWork);
    }
    for (const [sessionId, state] of archiveIndexBatchStates.entries()) {
        state.resolve?.(getSessionArchiveCheckpoint(sessionId).lastIndexedSeq);
    }
    table?.close?.();
    connection?.close?.();
    table = undefined;
    connection = undefined;
    indexingChains.clear();
    archiveIndexBatchStates.clear();
    startupBackfillPromise = null;
    startupWorkCompleted = false;
    maintenanceCoordinator = undefined;
}

// Compatibility wrapper during migration away from history-based indexing.
async function indexNewMessages(sessionId: string, _history: Message[], _lastIndexedPosition: number = 0): Promise<number> {
    await indexSessionArchive(sessionId);
    return _history.length;
}

function getArchiveIndexStatus(sessionId: string): {
    lastIndexedSeq: number;
    tailStartSeq: number;
    lastIndexedBlockId: number;
    latestLocalMessageSeq: number;
    latestLocalBlockId: number;
    pendingMessageCount: number;
    pendingBlockCount: number;
    maxLatencyDeadline?: number;
    lexical?: lexicalRuntime.VectorLexicalStatus;
} {
    const checkpoint = getSessionArchiveCheckpoint(sessionId);
    const maxima = getLocalArchiveVectorMaximaSync(sessionId);
    const state = archiveIndexBatchStates.get(sessionId);
    return {
        lastIndexedSeq: checkpoint.lastIndexedSeq,
        tailStartSeq: checkpoint.tailStartSeq,
        lastIndexedBlockId: checkpoint.lastIndexedBlockId,
        latestLocalMessageSeq: maxima.latestLocalMessageSeq,
        latestLocalBlockId: maxima.latestLocalBlockId,
        pendingMessageCount: Math.max(0, maxima.latestLocalMessageSeq - checkpoint.lastIndexedSeq),
        pendingBlockCount: Math.max(0, maxima.latestLocalBlockId - checkpoint.lastIndexedBlockId),
        ...(state?.maxLatencyDeadline ? { maxLatencyDeadline: state.maxLatencyDeadline } : {}),
        ...(lexicalRuntime.isConfigured() ? { lexical: lexicalRuntime.getStatus(sessionId) } : {}),
    };
}

function setArchiveIndexTimerHooksForTests(hooks?: {
    now?: () => number;
    setTimer?: (callback: () => void, delayMs: number) => ArchiveIndexTimerHandle;
    clearTimer?: (handle: ArchiveIndexTimerHandle) => void;
}): void {
    archiveIndexNow = hooks?.now || (() => Date.now());
    archiveIndexSetTimer = hooks?.setTimer || ((callback, delayMs) => setTimeout(callback, delayMs));
    archiveIndexClearTimer = hooks?.clearTimer || ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
}

export {
    buildArchiveSegments,
    calculateNextSegmentStartIndex,
    copySessionArchiveIndexCheckpoint,
    createRowsFromMemoryFacts,
    createRowsFromSegment,
    createRowFromBlockRecord,
    estimateArchiveMessageTokenCount,
    fetchSearchCandidatesAdaptively,
    formatQueryEmbeddingInput,
    getArchiveIndexBatchDecision,
    getArchiveIndexStatus,
    indexMemoryFactsFromCompaction,
    indexNewMessages,
    indexSessionArchive,
    init,
    renameSessionArchiveIndex,
    sanitizeEmbeddingInput,
    selectSearchSourceGroups,
    selectSearchSourceGroupsDetailed,
    setArchiveIndexTimerHooksForTests,
    scheduleSessionArchiveIndex,
    search,
    shutdown,
    waitForStartupArchiveVectorBackfill,
};
