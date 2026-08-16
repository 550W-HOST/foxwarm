import { ToolContext } from './helpers';
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

    const trustedSession = (ctx.persistCurrentSession || ctx.detachedReadOnlySession === true)
        && ctx.session
        && ctx.session.id === ctx.sessionId
        ? ctx.session
        : undefined;
    const session = trustedSession || await sessionManager.getSession(ctx.sessionId);
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
        const targetSession = request.targetSessionId === session.id || (session.aliases || []).includes(request.targetSessionId)
            ? session
            : sessionManager.getSessionCatalog(request.targetSessionId);
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
