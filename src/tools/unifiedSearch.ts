import { ToolArgs, ToolContext, UnifiedToolSource } from './helpers';
import { checkToolPermission } from '../isolatedCheck';
import * as mcpClient from '../mcpClient';
import { nodesManager } from '../nodes/manager';
import { resolveObjectArgWithJsonFallback } from '../jsonObjectArgs';
import { tool_remote_node } from './nodeTools';

// Forward reference - will be set by the main tools module after definitions are created
let _definitions: any[] = [];
let _isToolDirectlyExposedToModel: (toolName: string) => boolean = () => false;
let _isMasterOnlyToolName: (toolName: string) => boolean = () => false;
let _getToolPermissionNode: (toolName: string, executionNode: string, targetNode: string) => string = (_t, e) => e;

export function setDefinitionsRef(defs: any[], isExposed: (n: string) => boolean, isMasterOnly: (n: string) => boolean, getPermNode: (t: string, e: string, tn: string) => string) {
    _definitions = defs;
    _isToolDirectlyExposedToModel = isExposed;
    _isMasterOnlyToolName = isMasterOnly;
    _getToolPermissionNode = getPermNode;
}

export function buildUnifiedToolId(source: UnifiedToolSource, name: string, options: { server?: string; nodeId?: string } = {}): string {
    if (source === 'builtin') {
        return `builtin:${name}`;
    }

    if (source === 'mcp') {
        if (!options.server) {
            throw new Error('MCP tool IDs require server.');
        }
        return `mcp:${options.server}/${name}`;
    }

    if (!options.nodeId) {
        throw new Error('Node tool IDs require nodeId.');
    }

    return `node:${options.nodeId}/${name}`;
}

function parseUnifiedToolId(toolId: string): { source: UnifiedToolSource; name: string; server?: string; nodeId?: string } {
    if (typeof toolId !== 'string' || toolId.trim().length === 0) {
        throw new Error('toolId is required');
    }

    if (toolId.startsWith('builtin:')) {
        const name = toolId.slice('builtin:'.length).trim();
        if (!name) throw new Error(`Invalid builtin toolId: ${toolId}`);
        return { source: 'builtin', name };
    }

    if (toolId.startsWith('mcp:')) {
        const remainder = toolId.slice('mcp:'.length);
        const separator = remainder.indexOf('/');
        if (separator <= 0 || separator === remainder.length - 1) {
            throw new Error(`Invalid MCP toolId: ${toolId}`);
        }
        return {
            source: 'mcp',
            server: remainder.slice(0, separator),
            name: remainder.slice(separator + 1),
        };
    }

    if (toolId.startsWith('node:')) {
        const remainder = toolId.slice('node:'.length);
        const separator = remainder.indexOf('/');
        if (separator <= 0 || separator === remainder.length - 1) {
            throw new Error(`Invalid node toolId: ${toolId}`);
        }
        return {
            source: 'node',
            nodeId: remainder.slice(0, separator),
            name: remainder.slice(separator + 1),
        };
    }

    throw new Error(`Unsupported toolId source: ${toolId}`);
}

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

function normalizeRequestedNodeForToolCall(nodeParam: unknown, currentNode: string): string {
    if (nodeParam === undefined || nodeParam === null) {
        return currentNode;
    }

    if (typeof nodeParam !== 'string') {
        return String(nodeParam) || currentNode;
    }

    const trimmed = nodeParam.trim();
    if (!trimmed || trimmed.toLowerCase() === 'current') {
        return currentNode;
    }

    return trimmed;
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

    if (ctx?.sessionId) {
        const currentNode = await nodesManager.getCurrentNode(ctx.sessionId);
        if (typeof currentNode === 'string' && currentNode.trim().length > 0) {
            return currentNode.trim();
        }
    }

    return 'master';
}

async function executeBuiltinToolViaUnifiedCall(toolName: string, rawArgs: ToolArgs, ctx: ToolContext): Promise<any> {
    const toolDefinition = _definitions.find(def => def.name === toolName);
    if (!toolDefinition) {
        throw new Error(`Unknown builtin tool: ${toolName}`);
    }

    const supportsExplicitNode = Object.prototype.hasOwnProperty.call(toolDefinition.parameters?.properties || {}, 'node');
    if (!supportsExplicitNode && rawArgs && Object.prototype.hasOwnProperty.call(rawArgs, 'node')) {
        throw new Error(`Builtin tool \`${toolName}\` does not support node selection. Use call_tool with source=\`node\` for remote-node execution.`);
    }

    const sessionId = ctx.sessionId || 'main';
    const currentNode = ctx.sessionId
        ? (await nodesManager.getCurrentNode(sessionId) || 'master')
        : (ctx.session?.currentNode || 'master');
    const targetNode = supportsExplicitNode
        ? normalizeRequestedNodeForToolCall(rawArgs?.node, currentNode)
        : currentNode;
    const toolArgs = { ...(rawArgs || {}) };
    delete toolArgs.node;

    const executionNode = _isMasterOnlyToolName(toolName) ? 'master' : targetNode;
    const permissionNode = _getToolPermissionNode(toolName, executionNode, targetNode);

    if (ctx.sessionId) {
        await checkToolPermission(toolName, sessionId, permissionNode, toolArgs);
    }

    if (executionNode !== 'master') {
        return await nodesManager.executeTool(executionNode, toolName, toolArgs, sessionId);
    }

    if (toolName === 'send_file' || toolName === 'image_write_to_file') {
        return await nodesManager.executeToolLocally(toolName, { ...toolArgs, __runtimeNodeId: targetNode }, sessionId);
    }

    return await nodesManager.executeToolLocally(toolName, toolArgs, sessionId);
}

async function collectBuiltinUnifiedSearchResults(query: string, includeSchema: boolean) {
    return _definitions
        .map(def => ({ def, score: scoreUnifiedToolQuery(query, [def.name, def.description]) }))
        .filter(entry => entry.score >= 0)
        .map(def => ({
            _score: def.score,
            source: 'builtin' as const,
            toolId: buildUnifiedToolId('builtin', def.def.name),
            name: def.def.name,
            description: def.def.description,
            ...(includeSchema ? { inputSchema: def.def.parameters } : {}),
            directExposed: _isToolDirectlyExposedToModel(def.def.name),
            hidden: !_isToolDirectlyExposedToModel(def.def.name),
        }));
}

async function collectMcpUnifiedSearchResults(query: string, includeSchema: boolean, serverFilter: string | undefined, ctx?: ToolContext, warnings?: string[]) {
    if (ctx?.sessionId) {
        await checkToolPermission('search_mcp_tools', ctx.sessionId, 'master', { server: serverFilter, query });
    }

    const servers = serverFilter
        ? [serverFilter]
        : (await mcpClient.listServers())
            .filter(server => server.enabled)
            .map(server => server.name);

    const results: Array<Record<string, any>> = [];
    for (const serverName of servers) {
        let tools: any;
        try {
            tools = await mcpClient.listTools(serverName);
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
    const effectiveNodeId = nodeFilter || await resolveDefaultNodeSearchTarget(ctx);
    const nodeListing = await tool_remote_node({ action: 'list', nodeId: effectiveNodeId }, (ctx || ({} as ToolContext))) as any;
    const nodes = Array.isArray(nodeListing?.nodes) ? nodeListing.nodes : [];

    const results: Array<Record<string, any>> = [];
    for (const node of nodes) {
        for (const item of Array.isArray(node?.tools) ? node.tools : []) {
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
    const query = typeof args?.query === 'string' ? args.query : '';
    const sources = normalizeUnifiedToolSources(args?.sources);
    const server = typeof args?.server === 'string' && args.server.trim() ? args.server.trim() : undefined;
    const nodeId = typeof args?.nodeId === 'string' && args.nodeId.trim() ? args.nodeId.trim() : undefined;
    const includeSchema = args?.includeSchema !== false;
    const limit = Math.max(1, Math.min(Number(args?.limit) || 20, 200));
    const warnings: string[] = [];

    const collected: Array<Record<string, any>> = [];

    if (sources.includes('builtin')) {
        collected.push(...await collectBuiltinUnifiedSearchResults(query, includeSchema));
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
    const explicitSource = typeof args?.source === 'string' ? args.source.trim() : undefined;
    const ref = args?.toolId
        ? parseUnifiedToolId(String(args.toolId))
        : {
            source: explicitSource as UnifiedToolSource,
            name: typeof args?.name === 'string' ? args.name : '',
            server: typeof args?.server === 'string' ? args.server : undefined,
            nodeId: typeof args?.nodeId === 'string' ? args.nodeId : undefined,
        };

    if (!ref?.source || !['builtin', 'mcp', 'node'].includes(ref.source)) {
        throw new Error('call_tool requires either toolId or a valid source (builtin, mcp, node).');
    }
    if (!ref.name) {
        throw new Error('call_tool requires a tool name.');
    }

    const toolArgs = resolveObjectArgWithJsonFallback(args, 'args', 'argsJson', {
        required: true,
        label: 'call_tool args',
    })!;

    if (ref.source === 'builtin') {
        return await executeBuiltinToolViaUnifiedCall(ref.name, toolArgs, ctx);
    }

    if (ref.source === 'mcp') {
        if (!ref.server) {
            throw new Error('call_tool for MCP source requires server unless toolId includes it.');
        }
        if (!ctx?.sessionId) {
            throw new Error('call_tool for MCP requires session context.');
        }
        await checkToolPermission('call_tool', ctx.sessionId, 'master', {
            source: 'mcp',
            server: ref.server,
            name: ref.name,
            args: toolArgs,
        });
        return await mcpClient.callTool(ref.server, ref.name, toolArgs);
    }

    if (!ref.nodeId) {
        throw new Error('call_tool for node source requires nodeId.');
    }

    return await tool_remote_node({
        action: 'call',
        nodeId: ref.nodeId,
        tool: ref.name,
        args: toolArgs,
    }, ctx);
}
