import { ToolArgs, ToolContext, UnifiedToolSource } from './helpers';
import * as mcpExternal from '../mcpExternalService';
import { nodesManager } from '../nodes/manager';
import { listNodeTopology } from '../nodeExecution';
import { buildUnifiedToolId, executeResolvedTool, resolveUnifiedTool } from './resolvedTools';
import { NODE_ENVIRONMENT_BUILTIN_NAMES } from './placement';
import { definitions } from './definitions';
import { isToolVisibleForSession } from '../isolatedCheck';
import * as sessionManager from '../sessionManager';
import * as agentMetadata from '../session/agentMetadata';
import { isPermissionNeutralBuiltinDispatcher } from '../permissions';

function normalizeUnifiedToolSources(rawSources: unknown): UnifiedToolSource[] {
    const allowed: UnifiedToolSource[] = ['builtin', 'mcp', 'node'];
    if (rawSources === undefined || rawSources === null) {
        return allowed;
    }

    const items = Array.isArray(rawSources) ? rawSources : [rawSources];
    const normalized = items.map(item => String(item).trim()).filter(Boolean);
    if (normalized.length === 0) {
        return allowed;
    }

    const invalid = normalized.filter((item): item is string => !allowed.includes(item as UnifiedToolSource));
    if (invalid.length > 0) {
        throw new Error(`Invalid sources: ${invalid.join(', ')}. Supported sources: ${allowed.join(', ')}`);
    }

    return Array.from(new Set(normalized as UnifiedToolSource[]));
}

function normalizeUnifiedToolQueryTerms(query: string): string[] {
    const normalizedQuery = query.trim().toLowerCase();
    return normalizedQuery ? Array.from(new Set(normalizedQuery.split(/\s+/).filter(Boolean))) : [];
}

function scoreUnifiedToolQuery(query: string, fields: Array<string | undefined>): number {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
        return 0;
    }

    const terms = normalizeUnifiedToolQueryTerms(query);
    const normalizedFields = fields.map(field => String(field || '').toLowerCase());
    const primaryField = normalizedFields[0] || '';
    let score = 0;
    let matchedTerms = 0;

    if (primaryField === normalizedQuery) {
        score += 400;
    } else if (primaryField.startsWith(normalizedQuery)) {
        score += 260;
    } else if (primaryField.includes(normalizedQuery)) {
        score += 180;
    } else if (normalizedFields.some(field => field.includes(normalizedQuery))) {
        score += 120;
    }

    for (const term of terms) {
        let matched = false;
        for (const field of normalizedFields) {
            if (!field.includes(term)) {
                continue;
            }
            matched = true;
            score += field === primaryField ? 40 : 24;
            if (field.startsWith(term)) {
                score += field === primaryField ? 16 : 8;
            }
            break;
        }

        if (matched) {
            matchedTerms += 1;
        }
    }

    if (matchedTerms === 0) {
        return -1;
    }

    if (matchedTerms === terms.length && terms.length > 1) {
        score += 90;
    }

    score += matchedTerms * 12;
    return score;
}

async function resolveDefaultNodeSearchTarget(ctx?: ToolContext): Promise<string> {
    if (typeof ctx?.session?.currentNode === 'string' && ctx.session.currentNode.trim().length > 0) {
        return ctx.session.currentNode.trim();
    }
    if (ctx?.session) return 'master';

    if (ctx?.sessionId) {
        const currentNode = await nodesManager.getCurrentNode(ctx.sessionId);
        if (typeof currentNode === 'string' && currentNode.trim().length > 0) {
            return currentNode.trim();
        }
    }

    return 'master';
}

function discoverySession(ctx?: ToolContext) {
    if (ctx?.sessionId && ctx.session?.id === ctx.sessionId) return ctx.session;
    return ctx?.sessionId ? sessionManager.getSessionCatalog(ctx.sessionId) : undefined;
}

async function collectBuiltinUnifiedSearchResults(query: string, includeSchema: boolean, ctx?: ToolContext) {
    const session = discoverySession(ctx);
    return definitions
        .filter(def => !NODE_ENVIRONMENT_BUILTIN_NAMES.includes(def.name as any))
        .filter(def => !isPermissionNeutralBuiltinDispatcher(def.name))
        .filter(def => isToolVisibleForSession(session, { source: 'builtin', tool: def.name }))
        .map(def => ({ def, score: scoreUnifiedToolQuery(query, [def.name, def.description]) }))
        .filter(entry => entry.score >= 0)
        .map(def => ({
            _score: def.score,
            source: 'builtin' as const,
            toolId: buildUnifiedToolId('builtin', def.def.name),
            name: def.def.name,
            description: def.def.description,
            ...(includeSchema ? { inputSchema: def.def.parameters } : {}),
            directExposed: def.def.defaultInject === true,
            hidden: def.def.defaultInject !== true,
        }));
}

async function collectMcpUnifiedSearchResults(query: string, includeSchema: boolean, serverFilter: string | undefined, ctx?: ToolContext, warnings?: string[]) {
    if (!ctx?.sessionId) throw new Error('MCP discovery requires session context.');

    const session = discoverySession(ctx);
    const isolatedServers = session && sessionManager.isSessionEffectivelyIsolated(session)
        ? Array.from(new Set(sessionManager.getAgentToolRules(session.agent || 'main')
            .filter((rule): rule is Extract<typeof rule, { source: 'mcp' }> => rule.effect === 'allow' && rule.source === 'mcp')
            .map(rule => rule.server)))
        : undefined;
    const servers = serverFilter
        ? [serverFilter]
        : isolatedServers || (await mcpExternal.listMcpServers(ctx.sessionId))
            .filter(server => server.enabled)
            .map(server => server.name);

    const results: Array<Record<string, any>> = [];
    for (const serverName of servers) {
        let tools: any;
        try {
            tools = await mcpExternal.listMcpTools(ctx.sessionId, serverName);
        } catch (e: any) {
            warnings?.push(`MCP server ${serverName}: ${e?.message || String(e)}`);
            continue;
        }

        const items = Array.isArray((tools as any)?.tools)
            ? (tools as any).tools
            : (Array.isArray(tools) ? tools as any[] : []);

        for (const item of items) {
            const score = scoreUnifiedToolQuery(query, [item?.name, item?.description, serverName]);
            if (score < 0) {
                continue;
            }

            results.push({
                _score: score,
                source: 'mcp',
                toolId: buildUnifiedToolId('mcp', String(item?.name || ''), { server: serverName }),
                name: item?.name || 'unknown',
                description: item?.description || '',
                server: serverName,
                ...(includeSchema ? { inputSchema: item?.inputSchema || null } : {}),
                ...(includeSchema && item?.annotations ? { annotations: item.annotations } : {}),
            });
        }
    }

    return results;
}

async function collectNodeUnifiedSearchResults(query: string, includeSchema: boolean, nodeFilter: string | undefined, ctx?: ToolContext) {
    if (!ctx?.sessionId) throw new Error('Node discovery requires session context.');
    const currentNode = await resolveDefaultNodeSearchTarget(ctx);
    const effectiveNodeId = nodeFilter || currentNode;
    const nodes = await listNodeTopology(ctx.sessionId, effectiveNodeId, currentNode);

    const results: Array<Record<string, any>> = [];
    const session = discoverySession(ctx);
    for (const node of nodes) {
        for (const item of Array.isArray(node?.tools) ? node.tools : []) {
            if (!isToolVisibleForSession(session, { source: 'node', node: String(node?.id || ''), tool: String(item?.name || '') }, String(node?.id || ''))) continue;
            const score = scoreUnifiedToolQuery(query, [item?.name, item?.description, node?.id, node?.type]);
            if (score < 0) {
                continue;
            }

            results.push({
                _score: score,
                source: 'node',
                toolId: buildUnifiedToolId('node', String(item?.name || ''), { nodeId: String(node?.id || '') }),
                name: item?.name || 'unknown',
                description: item?.description || '',
                nodeId: node?.id || '',
                nodeType: node?.type || '',
                ...(includeSchema ? { inputSchema: item?.parameters || null } : {}),
            });
        }
    }

    return results;
}

export async function tool_search_tools(args: ToolArgs, ctx?: ToolContext) {
    if (ctx?.sessionPlacement === 'session-worker' && ctx.session && sessionManager.isSessionEffectivelyIsolated(ctx.session)) {
        await agentMetadata.refreshAgentMetadata(ctx.session.agent || 'main');
    }
    const query = typeof args?.query === 'string' ? args.query : '';
    const sources = normalizeUnifiedToolSources(args?.sources);
    const server = typeof args?.server === 'string' && args.server.trim() ? args.server.trim() : undefined;
    const nodeId = typeof args?.nodeId === 'string' && args.nodeId.trim() ? args.nodeId.trim() : undefined;
    const includeSchema = args?.includeSchema !== false;
    const limit = Math.max(1, Math.min(Number(args?.limit) || 20, 200));
    const warnings: string[] = [];

    const collected: Array<Record<string, any>> = [];

    if (sources.includes('builtin')) {
        collected.push(...await collectBuiltinUnifiedSearchResults(query, includeSchema, ctx));
    }

    if (sources.includes('mcp')) {
        try {
            collected.push(...await collectMcpUnifiedSearchResults(query, includeSchema, server, ctx, warnings));
        } catch (e: any) {
            warnings.push(e?.message || String(e));
        }
    }

    if (sources.includes('node')) {
        try {
            collected.push(...await collectNodeUnifiedSearchResults(query, includeSchema, nodeId, ctx));
        } catch (e: any) {
            warnings.push(e?.message || String(e));
        }
    }

    collected.sort((a, b) => {
        const scoreCompare = Number(b._score || 0) - Number(a._score || 0);
        if (scoreCompare !== 0) return scoreCompare;
        const sourceCompare = String(a.source).localeCompare(String(b.source));
        if (sourceCompare !== 0) return sourceCompare;
        const scopeA = String(a.server || a.nodeId || '');
        const scopeB = String(b.server || b.nodeId || '');
        const scopeCompare = scopeA.localeCompare(scopeB);
        if (scopeCompare !== 0) return scopeCompare;
        return String(a.name || '').localeCompare(String(b.name || ''));
    });

    const tools = collected.slice(0, limit).map(({ _score, ...tool }, index) => {
        if (!includeSchema || index < 10) {
            return tool;
        }

        const { inputSchema, annotations, ...summaryTool } = tool;
        return summaryTool;
    });

    return {
        count: Math.min(collected.length, limit),
        totalMatched: collected.length,
        tools,
        ...(warnings.length > 0 ? { warnings } : {}),
    };
}

export async function tool_call_tool(args: ToolArgs, ctx: ToolContext) {
    return executeResolvedTool(await resolveUnifiedTool(args, ctx), ctx);
}
