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

const SEARCH_TOOLS_DEFAULT_LIMIT = 5;
const SEARCH_TOOLS_SCHEMA_DETAIL_LIMIT = 10;
export const SEARCH_TOOLS_MAX_OUTPUT_CHARS = 32_000;
const SEARCH_TOOLS_MAX_LINE_CHARS = 3_000;
const SEARCH_TOOLS_MAX_DESCRIPTION_CHARS = 240;
const SEARCH_TOOLS_MAX_WARNING_CHARS = 500;
const SEARCH_TOOLS_WARNING_RESERVE_CHARS = 4_000;
const SEARCH_TOOLS_MAX_SCHEMA_DEPTH = 4;
const SEARCH_TOOLS_MAX_PROPERTIES = 20;
const SEARCH_TOOLS_MAX_REQUIRED_SCAN = 100;
const SEARCH_TOOLS_MAX_UNION_MEMBERS = 8;
const SEARCH_TOOLS_MAX_ENUM_VALUES = 12;

type SearchToolResult = Record<string, any>;

const UNSUPPORTED_SCHEMA_KEYWORDS = [
    '$ref',
    'allOf',
    'patternProperties',
    'propertyNames',
    'dependentSchemas',
    'dependentRequired',
    'dependencies',
    'unevaluatedProperties',
    'minProperties',
    'maxProperties',
    'not',
    'if',
    'then',
    'else',
] as const;

function isUnsafeTextCodePoint(codePoint: number): boolean {
    return codePoint <= 0x1f
        || (codePoint >= 0x7f && codePoint <= 0x9f)
        || codePoint === 0x061c
        || codePoint === 0x200e
        || codePoint === 0x200f
        || codePoint === 0x2028
        || codePoint === 0x2029
        || (codePoint >= 0x202a && codePoint <= 0x202e)
        || (codePoint >= 0x2066 && codePoint <= 0x2069);
}

function unicodeEscape(codePoint: number): string {
    if (codePoint <= 0xffff) return `\\u${codePoint.toString(16).padStart(4, '0')}`;
    const adjusted = codePoint - 0x10000;
    const high = 0xd800 + (adjusted >> 10);
    const low = 0xdc00 + (adjusted & 0x3ff);
    return `\\u${high.toString(16).padStart(4, '0')}\\u${low.toString(16).padStart(4, '0')}`;
}

function escapeUnsafeTextControls(value: string): string {
    return Array.from(value, character => {
        const codePoint = character.codePointAt(0)!;
        return isUnsafeTextCodePoint(codePoint) ? unicodeEscape(codePoint) : character;
    }).join('');
}

function quoteExactString(value: string): string {
    return `"${Array.from(value, character => {
        const codePoint = character.codePointAt(0)!;
        if (isUnsafeTextCodePoint(codePoint)) return unicodeEscape(codePoint);
        if (character === '"') return '\\"';
        if (character === '\\') return '\\\\';
        return character;
    }).join('')}"`;
}

function truncateUnicode(value: string, maxChars: number): string {
    const chars = Array.from(value);
    if (chars.length <= maxChars) return value;
    return `${chars.slice(0, Math.max(0, maxChars - 1)).join('')}…`;
}

function sanitizeComment(value: unknown, maxChars = SEARCH_TOOLS_MAX_DESCRIPTION_CHARS): string {
    const collapsed = escapeUnsafeTextControls(String(value || '')).replace(/\s+/gu, ' ').trim().replace(/\*\//gu, '*\\/');
    return truncateUnicode(collapsed, maxChars);
}

function schemaLiteral(value: unknown): string {
    if (typeof value === 'string') return quoteExactString(truncateUnicode(value, 100));
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value === 'boolean' || value === null) return String(value);
    return 'unknown';
}

function schemaType(schema: unknown, depth = 0): string {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return 'unknown';
    const value = schema as Record<string, any>;
    if (depth >= SEARCH_TOOLS_MAX_SCHEMA_DEPTH) return 'unknown';

    if (UNSUPPORTED_SCHEMA_KEYWORDS.some(keyword => Object.prototype.hasOwnProperty.call(value, keyword))) {
        return value.type === 'object' || value.properties || value.patternProperties ? 'Record<string, unknown>' : 'unknown';
    }

    if (Object.prototype.hasOwnProperty.call(value, 'const')) return schemaLiteral(value.const);
    if (Array.isArray(value.enum)) {
        const members = value.enum.slice(0, SEARCH_TOOLS_MAX_ENUM_VALUES).map(schemaLiteral);
        if (value.enum.length > SEARCH_TOOLS_MAX_ENUM_VALUES) members.push('unknown');
        return members.length > 0 ? members.join(' | ') : 'unknown';
    }

    const union = Array.isArray(value.oneOf) ? value.oneOf : (Array.isArray(value.anyOf) ? value.anyOf : undefined);
    if (union) {
        const members = union.slice(0, SEARCH_TOOLS_MAX_UNION_MEMBERS).map(member => schemaType(member, depth + 1));
        if (union.length > SEARCH_TOOLS_MAX_UNION_MEMBERS) members.push('unknown');
        return Array.from(new Set(members)).join(' | ') || 'unknown';
    }

    if (Array.isArray(value.type)) {
        const members = value.type.slice(0, SEARCH_TOOLS_MAX_UNION_MEMBERS)
            .map(type => schemaType({ ...value, type }, depth + 1));
        if (value.type.length > SEARCH_TOOLS_MAX_UNION_MEMBERS) members.push('unknown');
        return Array.from(new Set(members)).join(' | ') || 'unknown';
    }

    switch (value.type) {
        case 'string': return 'string';
        case 'number': return 'number';
        case 'integer': return 'number';
        case 'boolean': return 'boolean';
        case 'null': return 'null';
        case 'array': return `Array<${schemaType(value.items, depth + 1)}>`;
        case 'object': {
            const properties = value.properties && typeof value.properties === 'object' && !Array.isArray(value.properties)
                ? Object.entries(value.properties as Record<string, unknown>)
                : [];
            const propertyNames = new Set(properties.map(([name]) => name));
            const rawRequired = Array.isArray(value.required) ? value.required : [];
            const requiredNames = Array.from(new Set(rawRequired.slice(0, SEARCH_TOOLS_MAX_REQUIRED_SCAN).map(String)));
            const requiredScanTruncated = rawRequired.length > SEARCH_TOOLS_MAX_REQUIRED_SCAN;
            if (requiredScanTruncated) return 'Record<string, unknown> /* required constraints omitted */';
            const required = new Set(requiredNames);
            const undeclaredRequired = requiredNames.filter(name => !propertyNames.has(name));
            if (value.additionalProperties === false && undeclaredRequired.length > 0) return 'never';

            const declaredRequired = properties.filter(([name]) => required.has(name));
            const optionalProperties = properties.filter(([name]) => !required.has(name));
            const otherKeyType = value.additionalProperties && typeof value.additionalProperties === 'object'
                ? schemaType(value.additionalProperties, depth + 1)
                : 'unknown';
            const preserveDeclaredOrder = properties.length <= SEARCH_TOOLS_MAX_PROPERTIES && undeclaredRequired.length === 0;
            const entries: Array<{ name: string; schema: unknown; undeclaredRequired?: boolean }> = preserveDeclaredOrder
                ? properties.map(([name, propertySchema]) => ({ name, schema: propertySchema }))
                : [
                    ...declaredRequired.map(([name, propertySchema]) => ({ name, schema: propertySchema })),
                    ...undeclaredRequired.map(name => ({ name, schema: value.additionalProperties && typeof value.additionalProperties === 'object' ? value.additionalProperties : {}, undeclaredRequired: true })),
                    ...optionalProperties.map(([name, propertySchema]) => ({ name, schema: propertySchema })),
                ];
            const shownEntries = entries.slice(0, SEARCH_TOOLS_MAX_PROPERTIES);
            const parts = shownEntries.map(({ name, schema: propertySchema, undeclaredRequired: requiredFromOtherKey }) => {
                const property = propertySchema && typeof propertySchema === 'object' && !Array.isArray(propertySchema)
                    ? propertySchema as Record<string, unknown>
                    : undefined;
                const propertyName = /^[A-Za-z_$][\w$]*$/u.test(name) ? name : quoteExactString(name);
                const optional = required.has(name) ? '' : '?';
                const description = sanitizeComment(property?.description);
                const requiredNote = requiredFromOtherKey
                    ? ` /* required; ${value.additionalProperties && typeof value.additionalProperties === 'object' ? 'other-key schema' : 'other key'} */`
                    : '';
                return `${propertyName}${optional}: ${requiredFromOtherKey ? otherKeyType : schemaType(propertySchema, depth + 1)}${description ? ` /* ${description} */` : ''}${requiredNote};`;
            });
            const shownNames = new Set(shownEntries.map(entry => entry.name));
            const omittedRequired = requiredNames.filter(name => !shownNames.has(name)).length;
            const omittedOptional = optionalProperties.filter(([name]) => !shownNames.has(name)).length;
            if (omittedRequired > 0) parts.push(`/* ${omittedRequired} required keys omitted; constraint unknown */`);
            if (omittedOptional > 0) parts.push(`/* ${omittedOptional} optional properties omitted */`);

            if (value.additionalProperties === true) {
                parts.push('/* other keys: unknown */');
            } else if (value.additionalProperties && typeof value.additionalProperties === 'object') {
                if (properties.length === 0 && requiredNames.length === 0) return `Record<string, ${schemaType(value.additionalProperties, depth + 1)}>`;
                parts.push(`/* other keys: ${schemaType(value.additionalProperties, depth + 1)} */`);
            } else if (properties.length === 0 && requiredNames.length === 0 && value.additionalProperties !== false) {
                return 'Record<string, unknown>';
            } else if (value.additionalProperties === undefined) {
                parts.push('/* other keys: unknown */');
            }
            return `{ ${parts.join(' ')} }`;
        }
        default:
            if (value.properties || value.additionalProperties) return schemaType({ ...value, type: 'object' }, depth);
            return 'unknown';
    }
}

function isSafeBareToolId(toolId: string): boolean {
    return /^(?:builtin:[A-Za-z0-9_.:-]+|(?:mcp|node):[A-Za-z0-9_.:-]+\/[A-Za-z0-9_.:-]+)$/u.test(toolId);
}

function explicitToolDescriptor(tool: SearchToolResult): string | undefined {
    const source = tool.source;
    const name = typeof tool.name === 'string' && tool.name.length > 0 ? tool.name : undefined;
    if (!name) return undefined;
    if (source === 'builtin') return `source: "builtin", name: ${quoteExactString(name)}`;
    if (source === 'mcp' && typeof tool.server === 'string' && tool.server.length > 0) {
        return `source: "mcp", server: ${quoteExactString(tool.server)}, name: ${quoteExactString(name)}`;
    }
    if (source === 'node' && typeof tool.nodeId === 'string' && tool.nodeId.length > 0) {
        return `source: "node", nodeId: ${quoteExactString(tool.nodeId)}, name: ${quoteExactString(name)}`;
    }
    return undefined;
}

export function normalizeSearchToolsLimit(rawLimit: unknown): number {
    if (rawLimit === undefined || rawLimit === null || rawLimit === '') return SEARCH_TOOLS_DEFAULT_LIMIT;
    const numeric = Number(rawLimit);
    if (!Number.isFinite(numeric)) return SEARCH_TOOLS_DEFAULT_LIMIT;
    return Math.max(1, Math.min(Math.trunc(numeric), 200));
}

function toolDeclaration(tool: SearchToolResult, index: number, includeSchema: boolean): string | undefined {
    const toolId = String(tool.toolId || '');
    const schemaIncluded = includeSchema && index < SEARCH_TOOLS_SCHEMA_DETAIL_LIMIT;
    const schema = schemaIncluded ? tool.inputSchema : undefined;
    let argsText: string;
    if (!schemaIncluded) {
        argsText = '/* schema omitted */';
    } else if (!schema || typeof schema !== 'object') {
        argsText = '/* schema unavailable */';
    } else if ((schema as Record<string, any>).type === 'object' || (schema as Record<string, any>).properties) {
        const rendered = schemaType(schema);
        argsText = rendered.startsWith('Record<') ? `args: ${rendered}` : rendered;
    } else {
        argsText = `args: ${schemaType(schema)}`;
    }

    const description = sanitizeComment(tool.description);
    const suffix = description ? ` // ${description}` : '';
    let declaration: string;
    if (isSafeBareToolId(toolId)) {
        declaration = `${toolId}(${argsText});${suffix}`;
    } else {
        const descriptor = explicitToolDescriptor(tool);
        if (!descriptor) return undefined;
        const descriptorArgs = argsText.startsWith('/*')
            ? `unknown ${argsText}`
            : (argsText.startsWith('args: ') ? argsText.slice('args: '.length) : argsText);
        declaration = `call_tool({ ${descriptor}, args: ${descriptorArgs} });${suffix}`;
    }
    if (declaration.length > SEARCH_TOOLS_MAX_LINE_CHARS) return undefined;
    return declaration;
}

export function formatSearchToolsOutput(
    tools: SearchToolResult[],
    totalMatched: number,
    warnings: string[],
    includeSchema: boolean,
): string {
    const candidateLines: string[] = [];
    let invalidLineCount = 0;
    for (let index = 0; index < tools.length; index += 1) {
        const declaration = toolDeclaration(tools[index], index, includeSchema);
        if (declaration) candidateLines.push(declaration);
        else invalidLineCount += 1;
    }

    const safeWarnings = warnings.map(warning => sanitizeComment(warning, SEARCH_TOOLS_MAX_WARNING_CHARS) || 'Unknown discovery warning');
    if (invalidLineCount > 0) safeWarnings.push(`${invalidLineCount} matching tool${invalidLineCount === 1 ? '' : 's'} omitted because an unambiguous explicit descriptor was unavailable or the declaration exceeded the per-line formatter limit.`);
    const warningReserve = safeWarnings.length > 0 ? SEARCH_TOOLS_WARNING_RESERVE_CHARS : 0;
    const declarationBudget = SEARCH_TOOLS_MAX_OUTPUT_CHARS - warningReserve - 200;
    const emittedDeclarations: string[] = [];
    let declarationChars = 0;
    for (const declaration of candidateLines) {
        if (declarationChars + declaration.length + 1 > declarationBudget) break;
        emittedDeclarations.push(declaration);
        declarationChars += declaration.length + 1;
    }

    const budgetOmitted = candidateLines.length - emittedDeclarations.length;
    const lines = [`Showing ${emittedDeclarations.length} of ${totalMatched} matching tools.`, ...emittedDeclarations];
    if (budgetOmitted > 0) lines.push(`[${budgetOmitted} selected tool${budgetOmitted === 1 ? '' : 's'} omitted by the global formatter budget.]`);

    if (safeWarnings.length > 0) {
        lines.push('Warnings:');
        let emittedWarnings = 0;
        for (const warning of safeWarnings.slice(0, 20)) {
            const line = `- ${warning}`;
            const omittedAfter = safeWarnings.length - emittedWarnings - 1;
            const reserve = omittedAfter > 0 ? `\n- ${omittedAfter} additional warnings omitted.`.length : 0;
            if (lines.join('\n').length + line.length + reserve + 1 > SEARCH_TOOLS_MAX_OUTPUT_CHARS) break;
            lines.push(line);
            emittedWarnings += 1;
        }
        const omittedWarnings = safeWarnings.length - emittedWarnings;
        if (omittedWarnings > 0) {
            const notice = `- ${omittedWarnings} additional warnings omitted.`;
            if (lines.join('\n').length + notice.length + 1 <= SEARCH_TOOLS_MAX_OUTPUT_CHARS) lines.push(notice);
        }
    }
    return lines.join('\n');
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
    const limit = normalizeSearchToolsLimit(args?.limit);
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
        if (!includeSchema || index < SEARCH_TOOLS_SCHEMA_DETAIL_LIMIT) {
            return tool;
        }

        const { inputSchema, annotations, ...summaryTool } = tool;
        return summaryTool;
    });

    return { output: formatSearchToolsOutput(tools, collected.length, warnings, includeSchema) };
}

export async function tool_call_tool(args: ToolArgs, ctx: ToolContext) {
    return executeResolvedTool(await resolveUnifiedTool(args, ctx), ctx);
}
