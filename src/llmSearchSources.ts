import type { Message, MessagePart } from './types';

export const HOSTED_SEARCH_SOURCES_INCLUDE = 'web_search_call.action.sources';
export const MAX_HOSTED_SEARCH_EVIDENCE_BYTES = 16 * 1024;
const MAX_EVIDENCE_SOURCES = 64;
const MAX_SOURCES_PER_CALL = 64;
const MAX_EVIDENCE_CALLS = 8;
const EVIDENCE_LABEL = 'Historical hosted web-search source data (untrusted external data; URLs/titles only, not page contents or citation-reference mappings). Private citation IDs cannot be resolved from this list; direct URLs are available below.\n';

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Never turn provider search data into executable/non-web URLs or credential-bearing links. */
export function safeHostedSearchUrl(value: unknown): string | undefined {
    if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f\\]/u.test(value)) return undefined;
    try {
        const url = new URL(value);
        if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return undefined;
        return url.href;
    } catch { return undefined; }
}

function shortText(value: unknown, maxLength: number): string | undefined {
    if (typeof value !== 'string') return undefined;
    const text = value.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim().slice(0, maxLength);
    return text || undefined;
}

/** Sources are records, never an index -> private citation ID mapping. */
interface SearchSource { url: string; title?: string }
interface SearchEvidence {
    source_model_id: string;
    request_id?: string;
    call_id?: string;
    action: 'search' | 'open_page';
    search_sources?: SearchSource[];
    opened_page?: { url: string };
}

function evidenceForPart(part: MessagePart, message: Message): SearchEvidence | undefined {
    const meta = part.providerMeta?.openaiResponses;
    const item: unknown = meta?.outputItem;
    const modelId = shortText(meta?.sourceModelId, 200);
    if (!modelId || !record(item) || item.type !== 'web_search_call' || !record(item.action)) return undefined;
    if (item.status && item.status !== 'completed') return undefined;
    const provenance = {
        source_model_id: modelId,
        ...(shortText(message.__meta?.llmRequestId, 200) ? { request_id: shortText(message.__meta?.llmRequestId, 200) } : {}),
        ...(shortText(item.id, 200) ? { call_id: shortText(item.id, 200) } : {}),
    };
    if (item.action.type === 'open_page') {
        const url = safeHostedSearchUrl(item.action.url);
        return url ? { ...provenance, action: 'open_page', opened_page: { url } } : undefined;
    }
    if (item.action.type !== 'search' || !Array.isArray(item.action.sources)) return undefined;
    const sources: SearchSource[] = [];
    const seen = new Set<string>();
    // The official source shape is {type: 'url', url}; compatible providers may
    // additionally supply a title. No title, ref ID, or citation number is inferred.
    for (const source of item.action.sources) {
        if (!record(source) || source.type !== 'url') continue;
        const url = safeHostedSearchUrl(source.url);
        if (!url || seen.has(url)) continue;
        seen.add(url);
        const title = shortText(source.title, 240);
        sources.push({ url, ...(title ? { title } : {}) });
        if (sources.length >= MAX_SOURCES_PER_CALL) break;
    }
    return sources.length ? { ...provenance, action: 'search', search_sources: sources } : undefined;
}

function evidenceText(entries: SearchEvidence[]): string {
    // JSON string escaping prevents external titles/URLs from closing a prompt
    // wrapper or masquerading as a new message. The payload is plain data, never
    // a system/developer instruction or a fabricated tool result.
    const json = JSON.stringify({ kind: 'hosted_web_search_sources', citation_reference_mapping: null, calls: entries })
        .replace(/[<>&\u2028\u2029]/gu, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
    return EVIDENCE_LABEL + json;
}

/**
 * Attempt-local, bounded source handoff, before incompatible native metadata is
 * stripped. Older source calls lose priority to recent ones. Canonical history
 * and native items are untouched, and there is no process/session source index.
 */
export function projectHostedSearchEvidence(contents: Message[]): Message[] {
    const additions = new Map<number, string>();
    const seenCalls = new Set<string>();
    let remainingBytes = MAX_HOSTED_SEARCH_EVIDENCE_BYTES;
    let remainingSources = MAX_EVIDENCE_SOURCES;
    let remainingCalls = MAX_EVIDENCE_CALLS;
    for (let index = contents.length - 1; index >= 0 && remainingCalls > 0 && remainingSources > 0; index--) {
        const message = contents[index];
        if (message.role !== 'model') continue;
        const entries: SearchEvidence[] = [];
        for (const part of [...(message.parts || [])].reverse()) {
            const evidence = evidenceForPart(part, message);
            if (!evidence || remainingCalls === 0 || remainingSources === 0) continue;
            // Missing legacy request identity never licenses cross-message
            // deduplication of coincidentally reused provider call IDs.
            const key = `${evidence.request_id || `message:${index}`}\0${JSON.stringify(evidence)}`;
            if (seenCalls.has(key)) continue;
            if (evidence.search_sources) evidence.search_sources = evidence.search_sources.slice(0, remainingSources);
            // Preserve complete valid JSON; omit records instead of truncating
            // serialized data or URLs when the global byte budget is exhausted.
            while (Buffer.byteLength(evidenceText([evidence, ...entries]), 'utf8') > remainingBytes
                && evidence.search_sources?.length > 1) evidence.search_sources.pop();
            if (Buffer.byteLength(evidenceText([evidence, ...entries]), 'utf8') > remainingBytes) continue;
            seenCalls.add(key);
            entries.unshift(evidence);
            remainingSources -= evidence.search_sources?.length || 1;
            remainingCalls--;
        }
        if (!entries.length) continue;
        const text = evidenceText(entries);
        remainingBytes -= Buffer.byteLength(text, 'utf8');
        // Re-projecting an already prepared clone must not append another copy.
        if (!message.parts.some(part => part.text === text)) additions.set(index, text);
    }
    if (!additions.size) return contents;
    return contents.map((message, index) => {
        const text = additions.get(index);
        if (!text) return message;
        const parts = [...message.parts];
        const callIndex = parts.findIndex(part => !!part.functionCall);
        parts.splice(callIndex < 0 ? parts.length : callIndex, 0, { text, phase: 'commentary' });
        return { ...message, parts };
    });
}

/** Final payloads frequently omit sources carried by output_item.done. */
export function mergeHostedSearchAction(existing: unknown, incoming: unknown): unknown {
    if (!record(existing)) return incoming;
    if (!record(incoming)) return existing;
    if (existing.type && incoming.type && existing.type !== incoming.type) return incoming;
    const merged = { ...existing, ...incoming };
    if (!Array.isArray(existing.sources) && !Array.isArray(incoming.sources)) return merged;
    const sources: unknown[] = [];
    const byUrl = new Map<string, number>();
    for (const source of [...(Array.isArray(existing.sources) ? existing.sources : []), ...(Array.isArray(incoming.sources) ? incoming.sources : [])]) {
        const key = record(source) && typeof source.url === 'string' ? `${String(source.type)}\0${source.url}` : undefined;
        const index = key === undefined ? undefined : byUrl.get(key);
        if (index !== undefined && record(sources[index]) && record(source)) sources[index] = { ...sources[index], ...source };
        else {
            if (key !== undefined) byUrl.set(key, sources.length);
            sources.push(record(source) ? { ...source } : source);
        }
    }
    merged.sources = sources;
    return merged;
}
