import * as lancedb from '@lancedb/lancedb';
import { Ollama } from 'ollama';
import fs from 'fs-extra';
import path from 'path';
import crypto from 'crypto';
import { Message, MessagePart } from './types';
import { estimateTokenCount } from './tokenCount';
import { DB_DIR, SESSION_LOGS_DIR, getSessionArchiveLogPath } from './config';
import { logger } from './common';

const DB_PATH = DB_DIR;
const TABLE_NAME = 'messages_v5';
const CHECKPOINTS_PATH = path.join(DB_DIR, 'vector-index-checkpoints.json');
const ollama = new Ollama({ host: process.env.OLLAMA_BASE_URL || 'http://localhost:11434' });

const CHUNK_SIZE = 4000;
const EMBEDDING_MAX_LENGTH = 4000;

let table: any;
let checkpoints: VectorIndexCheckpointFile = { version: 1, sessions: {} };
const indexingChains = new Map<string, Promise<number>>();
let checkpointSaveChain: Promise<void> = Promise.resolve();

type VectorRow = {
    id: string;
    message_id: string;
    session_id: string;
    agent: string;
    seq: number;
    role: string;
    timestamp: number;
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

type SessionArchiveCheckpoint = {
    lastIndexedSeq: number;
    updatedAt: number;
};

type VectorIndexCheckpointFile = {
    version: number;
    sessions: Record<string, SessionArchiveCheckpoint>;
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

function shouldSkipText(text: string): boolean {
    if (!text || !text.trim()) return true;
    if (text.includes('--- RELEVANT MEMORY SNIPPETS (RAG) ---')) return true;
    return false;
}

function normalizeFunctionResponse(part: MessagePart): string | undefined {
    const response = part.functionResponse?.response;
    if (!response) return undefined;

    if (response.error) {
        return `[function_response:${part.functionResponse?.name || 'unknown'}] ERROR: ${response.error}`;
    }

    if (response.output) {
        return `[function_response:${part.functionResponse?.name || 'unknown'}] ${response.output}`;
    }

    return `[function_response:${part.functionResponse?.name || 'unknown'}] ${JSON.stringify(response)}`;
}

function normalizePartText(part: MessagePart): string[] {
    const lines: string[] = [];

    if (typeof part.system === 'string') {
        if (
            part.system.startsWith('current time =') ||
            part.system.startsWith('current session ID =') ||
            part.system.startsWith('FROM:') ||
            part.system.startsWith('Channel is in push-only mode.')
        ) {
            return lines;
        }
        lines.push(`[system] ${part.system}`);
    }

    if (typeof part.text === 'string' && !shouldSkipText(part.text)) {
        lines.push(part.text);
    }

    if (typeof part.thinking === 'string' && part.thinking.trim()) {
        lines.push(`[thinking] ${part.thinking}`);
    }

    if (part.functionCall) {
        let args = '';
        try {
            args = JSON.stringify(part.functionCall.args);
        } catch {
            args = '[unserializable args]';
        }
        lines.push(`[function_call:${part.functionCall.name}] ${args}`);
    }

    const functionResponse = normalizeFunctionResponse(part);
    if (functionResponse) {
        lines.push(functionResponse);
    }

    const inlineDataRef = part.inlineDataRef as any;
    if (inlineDataRef) {
        const mimeType = inlineDataRef.mimeType || 'application/octet-stream';
        const imageId = inlineDataRef.imageId || 'image';
        lines.push(`[image:${mimeType}] ${imageId}`);
    } else if (part.inlineData) {
        const mimeType = part.inlineData.mimeType || part.inlineData.mime_type || 'application/octet-stream';
        lines.push(`[image:${mimeType}]`);
    }

    return lines;
}

function normalizeMessageText(message: Message): string {
    const partLines = message.parts.flatMap(normalizePartText).filter(Boolean);
    if (partLines.length === 0) {
        return '';
    }

    const [first, ...rest] = partLines;
    const rolePrefix = `[${message.role}] `;
    return [rolePrefix + first, ...rest].join('\n').trim();
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

function createRowsFromArchiveLine(line: ArchiveMessageLine): Omit<VectorRow, 'vector'>[] {
    const text = normalizeMessageText(line.message);
    if (!text) {
        return [];
    }

    const chunks = splitTextIntoChunks(text);
    return chunks.map((chunkText, index) => ({
        id: `${line.sessionId}:${line.seq}:${index}`,
        message_id: `${line.sessionId}:${line.seq}`,
        session_id: line.sessionId,
        agent: line.agent || 'main',
        seq: line.seq,
        role: line.role,
        timestamp: Number(line.timestamp) || Date.now(),
        chunk_index: index,
        chunk_count: chunks.length,
        text,
        chunk_text: truncateToTokenLimit(chunkText, EMBEDDING_MAX_LENGTH),
    }));
}

async function getEmbedding(text: string) {
    const truncated = truncateToTokenLimit(text, EMBEDDING_MAX_LENGTH);
    const response = await ollama.embeddings({
        model: 'qwen3-embedding:0.6b',
        prompt: truncated,
    });
    return response.embedding;
}

async function loadCheckpoints() {
    if (await fs.pathExists(CHECKPOINTS_PATH)) {
        try {
            checkpoints = await fs.readJson(CHECKPOINTS_PATH);
        } catch (e) {
            logger.error({ err: e }, 'Failed to load vector archive checkpoints, starting fresh');
            checkpoints = { version: 1, sessions: {} };
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

function getLastIndexedSeq(sessionId: string): number {
    return checkpoints.sessions[sessionId]?.lastIndexedSeq || 0;
}

async function setLastIndexedSeq(sessionId: string, lastIndexedSeq: number): Promise<void> {
    checkpoints.sessions[sessionId] = {
        lastIndexedSeq,
        updatedAt: Date.now(),
    };
    await saveCheckpoints();
}

async function readArchiveLines(sessionId: string): Promise<ArchiveMessageLine[]> {
    const archivePath = getSessionArchiveLogPath(sessionId);
    if (!await fs.pathExists(archivePath)) {
        return [];
    }

    const raw = await fs.readFile(archivePath, 'utf8');
    const lines = raw.split('\n').map(line => line.trim()).filter(Boolean);
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

async function indexArchiveLine(line: ArchiveMessageLine): Promise<void> {
    const rows = createRowsFromArchiveLine(line);
    const messageId = `${line.sessionId}:${line.seq}`;
    await table.delete(`message_id = '${escapeFilterValue(messageId)}'`);

    if (rows.length === 0) {
        return;
    }

    const hydratedRows: VectorRow[] = [];
    for (const row of rows) {
        const vector = await getEmbedding(row.chunk_text);
        hydratedRows.push({ ...row, vector });
    }

    await table.add(hydratedRows);
}

async function indexSessionArchiveInternal(sessionId: string, latestSeqHint?: number): Promise<number> {
    const lastIndexedSeq = getLastIndexedSeq(sessionId);
    if (latestSeqHint !== undefined && latestSeqHint <= lastIndexedSeq) {
        return lastIndexedSeq;
    }

    const archiveLines = await readArchiveLines(sessionId);
    if (archiveLines.length === 0) {
        return lastIndexedSeq;
    }

    const pendingLines = archiveLines.filter(line => line.seq > lastIndexedSeq);
    if (pendingLines.length === 0) {
        return lastIndexedSeq;
    }

    logger.info({ sessionId, pendingCount: pendingLines.length, lastIndexedSeq }, 'Indexing session archive from JSONL');

    let newLastIndexedSeq = lastIndexedSeq;
    for (const line of pendingLines) {
        await indexArchiveLine(line);
        newLastIndexedSeq = line.seq;
    }

    await setLastIndexedSeq(sessionId, newLastIndexedSeq);
    return newLastIndexedSeq;
}

async function scheduleSessionArchiveIndex(sessionId: string, latestSeqHint?: number): Promise<number> {
    const previous = indexingChains.get(sessionId) || Promise.resolve(getLastIndexedSeq(sessionId));
    const next = previous
        .catch(() => getLastIndexedSeq(sessionId))
        .then(() => indexSessionArchiveInternal(sessionId, latestSeqHint));

    indexingChains.set(sessionId, next);
    next.finally(() => {
        if (indexingChains.get(sessionId) === next) {
            indexingChains.delete(sessionId);
        }
    });

    return next;
}

async function indexSessionArchive(sessionId: string, latestSeqHint?: number): Promise<number> {
    return scheduleSessionArchiveIndex(sessionId, latestSeqHint);
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
        checkpoints.sessions[newSessionId] = {
            lastIndexedSeq: Math.max(oldCheckpoint.lastIndexedSeq, newCheckpoint.lastIndexedSeq),
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
                seq: record.seq,
                role: record.role,
                timestamp: record.timestamp,
                chunk_index: record.chunk_index,
                chunk_count: record.chunk_count,
                text: record.text,
                chunk_text: record.chunk_text,
                _distance: record._distance,
                start_timestamp: record.timestamp,
                end_timestamp: record.timestamp,
            });
        }
    }

    if (!format) return results;
    if (results.length === 0) return '';

    return results.map(r => {
        const ts = r.timestamp != null && !isNaN(Number(r.timestamp)) ? Number(r.timestamp) : null;
        const date = ts ? new Date(ts) : null;
        const dateStr = (date && !isNaN(date.getTime())) ? date.toISOString() : 'unknown';
        return `[${dateStr}] [session: ${r.session_id}] [seq: ${r.seq}] [chunk ${Number(r.chunk_index) + 1}/${r.chunk_count}]\n${r.text}`;
    }).join('\n\n---\n\n');
}

async function getContextAround(timestamp: number, limit = 10) {
    const ts = Number(timestamp);
    const lower = ts - 1800000;
    const upper = ts + 1800000;
    const results: any[] = [];

    const iterator = await table.query()
        .where(`timestamp >= ${lower} AND timestamp <= ${upper}`)
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
                seq: record.seq,
                role: record.role,
                timestamp: record.timestamp,
                chunk_index: record.chunk_index,
                chunk_count: record.chunk_count,
                text: record.text,
                start_timestamp: record.timestamp,
                end_timestamp: record.timestamp,
            });
        }
    }

    return results.sort((a, b) => {
        const timestampDelta = Number(a.timestamp) - Number(b.timestamp);
        if (timestampDelta !== 0) return timestampDelta;
        const seqDelta = Number(a.seq) - Number(b.seq);
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
            role: 'system',
            timestamp: 0,
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

function getArchiveIndexStatus(sessionId: string): { lastIndexedSeq: number } {
    return { lastIndexedSeq: getLastIndexedSeq(sessionId) };
}

export {
    init,
    indexNewMessages,
    indexSessionArchive,
    indexAllSessionArchives,
    scheduleSessionArchiveIndex,
    renameSessionArchiveIndex,
    getArchiveIndexStatus,
    search,
    getContextAround,
};
