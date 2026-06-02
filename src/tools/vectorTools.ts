import { ToolContext } from './helpers';
import * as vector from '../vector';
import * as sessionManager from '../sessionManager';
import { getVectorSearchLineage } from '../session/archiveStore';

export async function resolveMemorySearchOptions(
    request: {
        scope?: 'all' | 'current-session' | 'current-agent';
        targetSessionId?: string;
        targetAgentName?: string;
    },
    ctx?: ToolContext,
): Promise<{ searchOptions: { sessionIds?: string[]; agent?: string; lineageSessions?: Array<{ sessionId: string; maxMessageSeq?: number; maxBlockId?: number }> }; effectiveScope: 'current-session' | 'current-agent' }> {
    if (!ctx?.sessionId) {
        throw new Error('search_vector requires an active session context.');
    }

    const session = await sessionManager.getSession(ctx.sessionId);
    const agentName = session.agent || 'main';
    const effectiveIsolated = sessionManager.isSessionEffectivelyIsolated(session);

    async function buildSessionScopedSearchOptions(targetSessionId: string, extraSessionIds: string[] = []) {
        const lineage = await getVectorSearchLineage(targetSessionId);
        if (lineage.length > 0) {
            return {
                lineageSessions: lineage.map(entry => ({
                    sessionId: entry.sessionId,
                    maxMessageSeq: entry.maxMessageSeq,
                    maxBlockId: entry.maxBlockId,
                })),
            };
        }

        return {
            sessionIds: [targetSessionId, ...extraSessionIds],
        };
    }

    if (effectiveIsolated) {
        if (request.targetAgentName && request.targetAgentName !== agentName) {
            throw new Error('Isolated session can only search the current session.');
        }
        if (request.targetSessionId && request.targetSessionId !== session.id && !(session.aliases || []).includes(request.targetSessionId)) {
            throw new Error('Isolated session can only search the current session.');
        }
        return {
            searchOptions: await buildSessionScopedSearchOptions(session.id, session.aliases || []),
            effectiveScope: 'current-session',
        };
    }

    if (request.targetAgentName && request.targetAgentName !== agentName) {
        throw new Error('search_vector cannot access memories outside the current agent.');
    }

    if (request.targetSessionId) {
        const targetSession = await sessionManager.getExistingSession(request.targetSessionId);
        if (!targetSession) {
            throw new Error(`Session \`${request.targetSessionId}\` not found.`);
        }
        if ((targetSession.agent || 'main') !== agentName) {
            throw new Error('search_vector cannot access memories outside the current agent.');
        }
        return {
            searchOptions: await buildSessionScopedSearchOptions(targetSession.id, targetSession.aliases || []),
            effectiveScope: 'current-session',
        };
    }

    if (request.scope === 'current-session') {
        return {
            searchOptions: await buildSessionScopedSearchOptions(session.id, session.aliases || []),
            effectiveScope: 'current-session',
        };
    }

    return {
        searchOptions: { agent: agentName },
        effectiveScope: 'current-agent',
    };
}

export function formatMemorySearchResults(results: any): string {
    if (!results || !Array.isArray(results) || results.length === 0) return 'No relevant memories found.';

    const now = Date.now();

    function formatAgeLabel(ts: number | null): string {
        if (!ts || !Number.isFinite(ts)) return 'age: unknown';
        const deltaMs = Math.max(0, now - ts);
        const minutes = Math.floor(deltaMs / 60000);
        if (minutes < 1) return 'RECENT · just now';
        if (minutes < 60) return `RECENT · ${minutes}m ago`;
        const hours = Math.floor(minutes / 60);
        if (hours < 48) return `RECENT · ${hours}h ago`;
        const days = Math.floor(hours / 24);
        if (days < 14) return `RECENT · ${days}d ago`;
        if (days < 60) return `AGING · ${days}d ago`;
        return `OLD · ${days}d ago`;
    }

    function buildPreview(text: string, maxChars: number = 420): string {
        const normalized = String(text || '').trim().replace(/\n{3,}/g, '\n\n');
        if (normalized.length <= maxChars) return normalized;

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

    return results.map(r => {
        const tsSource = r.end_timestamp ?? r.start_timestamp ?? r.timestamp;
        const ts = tsSource != null && !isNaN(Number(tsSource)) ? Number(tsSource) : null;
        const date = ts ? new Date(ts) : null;
        const dateStr = (date && !isNaN(date.getTime())) ? date.toISOString() : 'unknown';
        const idStr = (r.id && typeof r.id === 'string') ? `${r.id.substring(0, 8)}...` : 'N/A';
        const seqLabel = r.start_seq != null && r.end_seq != null && Number(r.start_seq) !== Number(r.end_seq)
            ? `${r.start_seq}-${r.end_seq}`
            : `${r.start_seq ?? r.seq}`;
        const rawSeqLabel = r.raw_start_seq != null && r.raw_end_seq != null && Number(r.raw_start_seq) !== Number(r.raw_end_seq)
            ? `${r.raw_start_seq}-${r.raw_end_seq}`
            : `${r.raw_start_seq ?? r.start_seq ?? r.seq}`;
        const messageLabel = r.message_count > 1
            ? `[messages: ${r.message_count}]`
            : '';
        const chunkLabel = r.chunk_count > 1
            ? `[chunk ${Number(r.chunk_index) + 1}/${r.chunk_count}]`
            : '';
        const kindLabel = r.kind === 'block'
            ? `[kind: block] [B#${r.block_id ?? '?'} L${r.block_level ?? '?'}] [raw: ${rawSeqLabel}]`
            : r.kind === 'fact'
                ? `[kind: memory fact] [fact: ${r.fact_kind ?? '?'}] [source: raw ${rawSeqLabel}]${r.attributed_to ? ` [attributed: ${r.attributed_to}]` : ''}`
            : '';
        const ageLabel = `[${formatAgeLabel(ts)}]`;
        const preview = buildPreview(r.text || r.chunk_text || '');

        return [
            `[${dateStr}] [session: ${r.session_id}] [seq: ${seqLabel}]`,
            ageLabel,
            kindLabel,
            messageLabel,
            chunkLabel,
            `[ID: ${idStr}]`,
        ].filter(Boolean).join(' ') + `\n${preview}`;
    }).join('\n\n---\n\n');
}

export async function tool_search_vector({
    query,
    limit = 5,
    scope = 'all',
    sessionId,
    agentName,
    includeRegex,
    excludeRegex,
    preferBlocks,
}: {
    query: string;
    limit?: number;
    scope?: 'all' | 'current-session' | 'current-agent';
    sessionId?: string;
    agentName?: string;
    includeRegex?: string;
    excludeRegex?: string;
    preferBlocks?: boolean;
}, ctx?: ToolContext) {
    const { searchOptions } = await resolveMemorySearchOptions({
        scope,
        targetSessionId: sessionId,
        targetAgentName: agentName,
    }, ctx);

    const results = await vector.search(query, limit, false, {
        ...searchOptions,
        includeRegex,
        excludeRegex,
        preferBlocks,
    });
    return formatMemorySearchResults(results);
}

export async function tool_get_memory_context({ timestamp, limit = 10 }: { timestamp: number; limit?: number }) {
    const results = await vector.getContextAround(timestamp, limit);
    if (!results || results.length === 0) return 'No context found around this time.';

    return results.map(r => {
        const ts = r.timestamp != null && !isNaN(Number(r.timestamp)) ? Number(r.timestamp) : null;
        const date = ts ? new Date(ts) : null;
        const dateStr = (date && !isNaN(date.getTime())) ? date.toISOString() : 'unknown';
        const idStr = (r.id && typeof r.id === 'string') ? `${r.id.substring(0, 8)}...` : 'N/A';
        const seqLabel = r.start_seq != null && r.end_seq != null && Number(r.start_seq) !== Number(r.end_seq)
            ? `${r.start_seq}-${r.end_seq}`
            : `${r.start_seq ?? r.seq}`;
        const messageLabel = r.message_count > 1
            ? `[messages: ${r.message_count}]`
            : '';
        const chunkLabel = r.chunk_count > 1
            ? `[chunk ${Number(r.chunk_index) + 1}/${r.chunk_count}]`
            : '';

        return [
            `[${dateStr}] [session: ${r.session_id}] [seq: ${seqLabel}]`,
            messageLabel,
            chunkLabel,
            `[ID: ${idStr}]`,
        ].filter(Boolean).join(' ') + `\n${r.text}`;
    }).join('\n\n---\n\n');
}
