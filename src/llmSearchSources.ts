import type { Message, MessagePart } from './types';

export const HOSTED_SEARCH_SOURCES_INCLUDE = 'web_search_call.action.sources';
// Fixed per-call bounds for a pathological single call. They depend only on
// that call's own stored data, so they never change in later requests.
export const MAX_HOSTED_SEARCH_CALL_EVIDENCE_BYTES = 16 * 1024;
export const MAX_HOSTED_SEARCH_SOURCES_PER_CALL = 64;
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
        if (sources.length >= MAX_HOSTED_SEARCH_SOURCES_PER_CALL) break;
    }
    if (!sources.length) return undefined;
    const evidence: SearchEvidence = { ...provenance, action: 'search', search_sources: sources };
    // Omit whole trailing records rather than truncating JSON or URL strings.
    while (sources.length > 1 && Buffer.byteLength(JSON.stringify(evidence), 'utf8') > MAX_HOSTED_SEARCH_CALL_EVIDENCE_BYTES) sources.pop();
    return evidence;
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
 * Attempt-local source handoff, before incompatible native metadata is stripped.
 * Prefix stability: each call's projected text depends only on that call's
 * stored item and on earlier calls (deduplication keeps the first occurrence),
 * so a later search never changes evidence already sent with an older message.
 * There is no request-wide byte, source or call budget. Canonical history and
 * native items are untouched, and there is no process/session source index.
 */
export function projectHostedSearchEvidence(contents: Message[]): Message[] {
    const additions = new Map<number, string>();
    const seenCalls = new Set<string>();
    for (let index = 0; index < contents.length; index++) {
        const message = contents[index];
        if (message.role !== 'model') continue;
        const entries: SearchEvidence[] = [];
        for (const part of message.parts || []) {
            const evidence = evidenceForPart(part, message);
            if (!evidence) continue;
            // Missing legacy request identity never licenses cross-message
            // deduplication of coincidentally reused provider call IDs.
            const key = `${evidence.request_id || `message:${index}`}\0${JSON.stringify(evidence)}`;
            if (seenCalls.has(key)) continue;
            seenCalls.add(key);
            entries.push(evidence);
        }
        if (!entries.length) continue;
        const text = evidenceText(entries);
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
