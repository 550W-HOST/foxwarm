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
        throw new Error('recall vector_query requires an active session context.');
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
        throw new Error('recall vector_query cannot access memories outside the current agent.');
    }

    if (request.targetSessionId) {
        const targetSession = await sessionManager.getExistingSession(request.targetSessionId);
        if (!targetSession) {
            throw new Error(`Session \`${request.targetSessionId}\` not found.`);
        }
        if ((targetSession.agent || 'main') !== agentName) {
            throw new Error('recall vector_query cannot access memories outside the current agent.');
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
