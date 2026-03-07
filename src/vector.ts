import * as lancedb from '@lancedb/lancedb';
import { Ollama } from 'ollama';
import fs from 'fs-extra';
import crypto from 'crypto';
import { Message } from './types';
import { estimateTokenCount } from './tokenCount';
import { DB_DIR } from './config';
import { logger } from './common';

const DB_PATH = DB_DIR;
const ollama = new Ollama({ host: process.env.OLLAMA_BASE_URL || 'http://localhost:11434' });

const CHUNK_SIZE = 8000; // Maximum tokens per chunk
const OVERLAP_PERCENT = 0.1; // 10% overlap between chunks
const EMBEDDING_MAX_LENGTH = 4000; // Max tokens for embedding model input

let table: any;

async function init() {
    await fs.ensureDir(DB_PATH);
    const db = await lancedb.connect(DB_PATH);
    try {
        table = await db.openTable('messages_v4');
    } catch (e) {
        table = await db.createTable('messages_v4', [
            {
                id: crypto.randomUUID(),
                vector: new Array(1024).fill(0),
                text: 'init',
                chunk_text: 'init',
                start_index: 0,
                end_index: 0,
                start_timestamp: Date.now(),
                end_timestamp: Date.now()
            }
        ]);
    }
}

async function getEmbedding(text: string) {
    // Truncate based on token count, not character count
    let truncated = text;
    if (estimateTokenCount(text) > EMBEDDING_MAX_LENGTH) {
        // Binary search to find the right length
        let left = 0;
        let right = text.length;
        while (left < right) {
            const mid = Math.floor((left + right + 1) / 2);
            if (estimateTokenCount(text.substring(0, mid)) <= EMBEDDING_MAX_LENGTH) {
                left = mid;
            } else {
                right = mid - 1;
            }
        }
        truncated = text.substring(0, left);
    }
    
    const response = await ollama.embeddings({
        model: 'qwen3-embedding:0.6b',
        prompt: truncated
    });
    return response.embedding;
}

/**
 * Create chunks from messages with overlap
 */
function createChunks(messages: Message[], startIndex: number) {
    const chunks: Array<{
        text: string;
        chunk_text: string;
        start_index: number;
        end_index: number;
        start_timestamp: number;
        end_timestamp: number;
    }> = [];

    let currentChunk: string[] = [];
    let currentTokens = 0;
    let chunkStartIndex = startIndex;
    let chunkEndIndex = startIndex;
    let chunkStartTimestamp = messages[0]?.__meta?.timestamp || Date.now();
    let chunkEndTimestamp = chunkStartTimestamp;

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];

        // Filter out RAG and system parts, keep only real content
        const filteredParts = msg.parts.filter(p => {
            if (!p.text) return false;
            const text = p.text;
            // Skip RAG context
            if (text.includes('--- RELEVANT MEMORY SNIPPETS (RAG) ---')) return false;
            // Skip system time messages
            if (text.includes('[SYSTEM: current time =')) return false;
            // Skip empty text
            if (text.trim().length === 0) return false;
            return true;
        });

        // If no valid parts after filtering, skip this message
        if (filteredParts.length === 0) {
            // logger.debug(`[Vector] Skipping message ${i} (no valid content after filtering)`);
            continue;
        }

        // Extract text from filtered parts
        const textParts = filteredParts.map(p => p.text).join('\n');
        const msgText = `[${msg.role}]: ${textParts}`;
        const msgTokens = estimateTokenCount(msgText);

        // If adding this message exceeds chunk size, save current chunk
        if (currentTokens + msgTokens > CHUNK_SIZE && currentChunk.length > 0) {
            const chunkText = currentChunk.join('\n');
            const chunkTokens = estimateTokenCount(chunkText);
            
            // Truncate chunk_text based on token count
            let chunk_text = chunkText;
            if (chunkTokens > EMBEDDING_MAX_LENGTH) {
                let left = 0;
                let right = chunkText.length;
                while (left < right) {
                    const mid = Math.floor((left + right + 1) / 2);
                    if (estimateTokenCount(chunkText.substring(0, mid)) <= EMBEDDING_MAX_LENGTH) {
                        left = mid;
                    } else {
                        right = mid - 1;
                    }
                }
                chunk_text = chunkText.substring(0, left);
            }
            
            chunks.push({
                text: chunkText,
                chunk_text,
                start_index: chunkStartIndex,
                end_index: chunkEndIndex,
                start_timestamp: chunkStartTimestamp,
                end_timestamp: chunkEndTimestamp
            });

            // Calculate overlap: keep last 10% of current chunk tokens
            const overlapTokens = Math.floor(CHUNK_SIZE * OVERLAP_PERCENT);
            let currentOverlapTokens = 0;
            const overlapChunk: string[] = [];
            let overlapStartIndex = chunkEndIndex;

            // Go backwards to find messages that fit in overlap
            for (let j = currentChunk.length - 1; j >= 0; j--) {
                const msgTokenCount = estimateTokenCount(currentChunk[j]);
                if (currentOverlapTokens + msgTokenCount <= overlapTokens) {
                    overlapChunk.unshift(currentChunk[j]);
                    overlapStartIndex = chunkStartIndex + j;
                    currentOverlapTokens += msgTokenCount;
                } else {
                    break;
                }
            }

            // Start new chunk with overlap
            currentChunk = overlapChunk;
            currentTokens = currentOverlapTokens;
            chunkStartIndex = overlapStartIndex;
            chunkStartTimestamp = messages[overlapStartIndex - startIndex]?.__meta?.timestamp || msg.__meta?.timestamp || Date.now();
        }

        // Add current message to chunk
        currentChunk.push(msgText);
        chunkEndIndex = startIndex + i;
        currentTokens += msgTokens + estimateTokenCount('\n'); // +tokens for newline
        chunkEndTimestamp = msg.__meta?.timestamp || Date.now();
    }

    // Add final chunk if not empty
    if (currentChunk.length > 0) {
        const chunkText = currentChunk.join('\n');
        const chunkTokens = estimateTokenCount(chunkText);
        
        // Truncate chunk_text based on token count
        let chunk_text = chunkText;
        if (chunkTokens > EMBEDDING_MAX_LENGTH) {
            let left = 0;
            let right = chunkText.length;
            while (left < right) {
                const mid = Math.floor((left + right + 1) / 2);
                if (estimateTokenCount(chunkText.substring(0, mid)) <= EMBEDDING_MAX_LENGTH) {
                    left = mid;
                } else {
                    right = mid - 1;
                }
            }
            chunk_text = chunkText.substring(0, left);
        }
        
        chunks.push({
            text: chunkText,
            chunk_text,
            start_index: chunkStartIndex,
            end_index: chunkEndIndex,
            start_timestamp: chunkStartTimestamp,
            end_timestamp: chunkEndTimestamp
        });
    }

    return chunks;
}

/**
 * Index new messages from history
 * @param sessionId Session ID (for ID prefix)
 * @param history Full message history
 * @param lastIndexedPosition Last indexed message position (from session metadata)
 * @returns New lastIndexedPosition
 */
async function indexNewMessages(sessionId: string, history: Message[], lastIndexedPosition: number = 0): Promise<number> {
    if (lastIndexedPosition >= history.length) {
        return lastIndexedPosition; // Nothing new to index
    }

    const newMessages = history.slice(lastIndexedPosition);
    if (newMessages.length === 0) return lastIndexedPosition;

    const chunks = createChunks(newMessages, lastIndexedPosition);

    logger.info(`[Vector] Indexed ${newMessages.length} messages → ${chunks.length} chunks (pos ${lastIndexedPosition} → ${history.length})`);

    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const vector = await getEmbedding(chunk.chunk_text);

        // Generate sortable ID: sessionid_timestamp_random
        const timestamp = Date.now();
        const random = crypto.randomBytes(4).toString('hex');
        const id = `${sessionId}_${timestamp}_${random}`;

        await table.add([{
            id,
            vector,
            text: chunk.text,
            chunk_text: chunk.chunk_text,
            start_index: chunk.start_index,
            end_index: chunk.end_index,
            start_timestamp: chunk.start_timestamp,
            end_timestamp: chunk.end_timestamp
        }]);
    }

    return history.length; // Return new position
}

async function search(query: string, limit = 5, format = true) {
    const vector = await getEmbedding(query);
    const results: any[] = [];
    const iterator = await table.search(vector).limit(limit).execute();

    for await (const row of iterator) {
        // Use toArray() to convert RecordBatch to plain objects
        const records = row.toArray();
        for (const record of records) {
            const { id, text, start_index, end_index, start_timestamp, end_timestamp, _distance } = record;

            if (text) {
                results.push({ id, text, start_index, end_index, start_timestamp, end_timestamp, _distance });
            }
        }
    }

    if (!format) return results;
    if (results.length === 0) return '';

    return results.map(r => {
        // Safely handle timestamps - check if they exist and are valid numbers
        const startTs = r.start_timestamp != null && !isNaN(Number(r.start_timestamp)) ? Number(r.start_timestamp) : null;
        const endTs = r.end_timestamp != null && !isNaN(Number(r.end_timestamp)) ? Number(r.end_timestamp) : null;

        const startDate = startTs ? new Date(startTs) : null;
        const endDate = endTs ? new Date(endTs) : null;

        const startStr = (startDate && !isNaN(startDate.getTime())) ? startDate.toISOString() : 'unknown';
        const endStr = (endDate && !isNaN(endDate.getTime())) ? endDate.toISOString() : 'unknown';

        const idStr = r.id ? ` [ID: ${r.id}]` : '';
        const textStr = String(r.text || '');
        return `[${startStr} - ${endStr}]${idStr}\n${textStr}`;
    }).join('\n\n---\n\n');
}

async function getContextAround(timestamp: number, limit = 10) {
    const ts = Number(timestamp);
    const results: any[] = [];

    const iterator = await table.query()
        .filter(`start_timestamp <= ${ts + 1800000} AND end_timestamp >= ${ts - 1800000}`)
        .limit(limit)
        .execute();

    for await (const row of iterator) {
        // Use toArray() to convert RecordBatch to plain objects
        const records = row.toArray();
        for (const record of records) {
            const { id, text, start_timestamp, end_timestamp } = record;
            results.push({ id, text, start_timestamp, end_timestamp });
        }
    }

    return results.sort((a, b) => Number(a.start_timestamp) - Number(b.start_timestamp));
}

export { init, indexNewMessages, search, getContextAround };
