import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import * as mcpExternal from './mcpExternalService';
import type { VerifiedMcpInboundPrincipal } from './mcpInboundConfig';
import { McpInboundSafeError, type ExternalExecutionContext, type McpInboundCatalog } from './mcpInboundHttp';
import { buildUnifiedToolId, parseUnifiedToolId } from './tools/resolvedTools';
import { compareUnifiedSearchResults, scoreUnifiedToolQuery } from './tools/unifiedSearch';
import { isToolAuthorizationPolicyUnavailable } from './toolAuthorization';

const MAX_DISCOVERY_BYTES = 512 * 1024;
const MAX_DISCOVERY_LIMIT = 50;

// Inbound MCP tool names, descriptions, and input schemas.
const discoverTool: Tool = {
  name: 'foxwarm_discover',
  description: "Search available Foxwarm tools and inspect their inputs. Results identify each tool's source and exact Node or MCP server. A listed tool may still require permission for the arguments used in a call.",
  inputSchema: {
    type: 'object', additionalProperties: false,
    properties: {
      query: { type: 'string', description: 'Words to match in tool names and descriptions. Omit to list tools.' },
      sources: { type: 'array', items: { type: 'string', enum: ['builtin', 'node', 'mcp'] }, uniqueItems: true, description: 'Tool sources to include. Omit to search supported sources.' },
      nodeId: { type: 'string', description: 'Limit Node tools to this Node.' },
      server: { type: 'string', description: 'Limit outbound MCP tools to this configured server.' },
      limit: { type: 'integer', minimum: 1, maximum: 50, default: 5, description: 'Maximum number of matching tools to return.' },
      includeSchema: { type: 'boolean', default: true, description: 'Include input schemas with the returned tools.' },
    },
  },
};
const callTool: Tool = {
  name: 'foxwarm_call',
  description: "Call a tool by the exact toolId returned by foxwarm_discover. The call uses this external session's identity and checks permission for the resolved tool, target, and arguments.",
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['toolId'],
    properties: {
      toolId: { type: 'string', description: 'Exact toolId returned by foxwarm_discover.' },
      args: { type: 'object', additionalProperties: true, default: {}, description: 'Arguments accepted by the selected tool.' },
    },
  },
};

type DiscoveryArgs = {
  query: string;
  sources: string[];
  server?: string;
  limit: number;
  includeSchema: boolean;
};

function plainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function fieldsOnly(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}
function discoveryArgs(value: Record<string, unknown>): DiscoveryArgs {
  if (!fieldsOnly(value, ['query', 'sources', 'nodeId', 'server', 'limit', 'includeSchema'])
    || (value.query !== undefined && typeof value.query !== 'string')
    || (value.nodeId !== undefined && typeof value.nodeId !== 'string')
    || (value.server !== undefined && typeof value.server !== 'string')
    || (value.includeSchema !== undefined && typeof value.includeSchema !== 'boolean')
    || (value.limit !== undefined && (!Number.isInteger(value.limit) || (value.limit as number) < 1 || (value.limit as number) > MAX_DISCOVERY_LIMIT))
    || (value.sources !== undefined && (!Array.isArray(value.sources) || new Set(value.sources).size !== value.sources.length
      || value.sources.some(source => !['builtin', 'node', 'mcp'].includes(source))))) {
    throw new McpInboundSafeError('Invalid discovery arguments.');
  }
  return {
    query: value.query as string || '',
    sources: value.sources as string[] || ['mcp'],
    server: value.server as string | undefined,
    limit: value.limit as number || 5,
    includeSchema: value.includeSchema !== false,
  };
}

function toolError(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

/** Main-owned adapter: never invokes the internal Session RPC service or forges a Session ID. */
export class McpInboundMcpCatalog implements McpInboundCatalog {
  async listTools(_context: ExternalExecutionContext, _principal: VerifiedMcpInboundPrincipal): Promise<Tool[]> {
    return [discoverTool, callTool];
  }

  async callTool(
    context: ExternalExecutionContext, name: string, args: Record<string, unknown>, signal: AbortSignal,
    principal: VerifiedMcpInboundPrincipal,
  ): Promise<CallToolResult> {
    if (!plainObject(args)) return toolError('Tool arguments must be an object.');
    if (name === discoverTool.name) return this.discover(context, principal, args, signal);
    if (name === callTool.name) return this.call(context, principal, args, signal);
    return toolError('Tool is not available.');
  }

  private async discover(
    context: ExternalExecutionContext, principal: VerifiedMcpInboundPrincipal,
    args: Record<string, unknown>, signal: AbortSignal,
  ): Promise<CallToolResult> {
    const options = discoveryArgs(args);
    const collected: Array<Record<string, any>> = [];
    let totalKnown = true;
    if (options.sources.includes('mcp')) {
      const servers = (await mcpExternal.listMcpServersForExternal(principal))
        .filter(server => server.enabled && (!options.server || server.name === options.server));
      for (const server of servers) {
        if (signal.aborted) throw new McpInboundSafeError('Discovery was cancelled.');
        let tools: any[];
        try {
          tools = await mcpExternal.listMcpToolsForExternal(principal, context.id, server.name, signal);
        } catch (error) {
          if (isToolAuthorizationPolicyUnavailable(error)) throw new McpInboundSafeError('Tool policy is unavailable; discovery failed closed.');
          totalKnown = false;
          continue;
        }
        for (const tool of tools) {
          const score = scoreUnifiedToolQuery(options.query, [tool.name, tool.description, server.name]);
          if (score < 0) continue;
          collected.push({
            _score: score, source: 'mcp', server: server.name,
            toolId: buildUnifiedToolId('mcp', tool.name, { server: server.name }),
            name: tool.name, description: tool.description || '',
            ...(options.includeSchema ? { inputSchema: tool.inputSchema || null } : {}),
            ...(options.includeSchema && tool.annotations ? { annotations: tool.annotations } : {}),
          });
        }
      }
    }
    collected.sort(compareUnifiedSearchResults);
    const tools: Array<Record<string, unknown>> = [];
    let schemaOmitted = false;
    let size = 256;
    for (const { _score, ...item } of collected.slice(0, options.limit)) {
      let tool = item;
      let cost = Buffer.byteLength(JSON.stringify(tool));
      if (cost + size > MAX_DISCOVERY_BYTES && options.includeSchema) {
        const { inputSchema: _inputSchema, annotations: _annotations, ...summary } = item;
        tool = { ...summary, schemaOmitted: true };
        schemaOmitted = true;
        cost = Buffer.byteLength(JSON.stringify(tool));
      }
      if (cost + size > MAX_DISCOVERY_BYTES) break;
      tools.push(tool);
      size += cost;
    }
    const truncated = tools.length < collected.length;
    const structuredContent = { tools, returned: tools.length, total: collected.length, totalKnown, truncated, schemaOmitted };
    return {
      content: [{ type: 'text', text: `Showing ${tools.length} of ${collected.length} matching available tools${totalKnown ? '' : ' from reachable servers'}${truncated ? ' (truncated)' : ''}.` }],
      structuredContent,
    };
  }

  private async call(
    context: ExternalExecutionContext, principal: VerifiedMcpInboundPrincipal,
    args: Record<string, unknown>, signal: AbortSignal,
  ): Promise<CallToolResult> {
    if (!fieldsOnly(args, ['toolId', 'args']) || typeof args.toolId !== 'string' || !args.toolId
      || (args.args !== undefined && !plainObject(args.args))) {
      return toolError('Invalid tool call arguments.');
    }
    let resolved: ReturnType<typeof parseUnifiedToolId>;
    try { resolved = parseUnifiedToolId(args.toolId); }
    catch { return toolError('Invalid tool ID.'); }
    if (resolved.source !== 'mcp' || !resolved.server || !resolved.name
      || buildUnifiedToolId('mcp', resolved.name, { server: resolved.server }) !== args.toolId) {
      return toolError('Tool source is not available on this inbound endpoint.');
    }
    try {
      // The authoritative Main service verifies the principal and the exact concrete policy on every call.
      const result = await mcpExternal.callMcpToolForExternal(principal, context.id, resolved.server, resolved.name, args.args as Record<string, unknown> || {}, signal);
      if (result && typeof result === 'object' && Array.isArray(result.content)) return result as CallToolResult;
      const text = typeof result === 'string' ? result : JSON.stringify(result);
      return { content: [{ type: 'text', text: text || '' }] };
    } catch (error: any) {
      if (error?.code === 'MCP_EXTERNAL_DENIED') return toolError('Tool is not permitted.');
      if (error?.code === 'MCP_EXTERNAL_TOOL_NOT_FOUND') return toolError('Tool is not available on the configured server.');
      if (error?.code === 'MCP_EXTERNAL_CONFIG_UNAVAILABLE') return toolError('MCP configuration is unavailable; no tool call was sent.');
      if (error?.code === 'MCP_EXTERNAL_OUTPUT_UNAVAILABLE') return toolError('Tool may have completed; its output cannot be safely returned. Do not retry automatically.');
      if (isToolAuthorizationPolicyUnavailable(error)) return toolError('Tool policy is unavailable; no call was sent.');
      if (error?.code === 'MCP_EXTERNAL_CALL_NOT_SENT') {
        return toolError((error as Error).message.slice(0, 600));
      }
      if (signal.aborted) return toolError('Tool call was cancelled; the remote outcome may be unknown. Do not retry automatically.');
      const diagnostic = error instanceof Error ? error.message.slice(0, 400) : 'Remote MCP operation failed.';
      return toolError(`Remote MCP operation failed; the outcome may be unknown. Do not retry automatically. ${diagnostic}`);
    }
  }
}
