import { ToolArgs } from './helpers';
import * as mcpClient from '../mcpClient';
import { resolveObjectArgWithJsonFallback, requireStringMapObject } from '../jsonObjectArgs';

export async function tool_mcp_config(args: ToolArgs) {
    const { name, url, command, args: commandArgs, cwd, stderr, token, description, enable, transport, type } = args;
    const env = requireStringMapObject(
        resolveObjectArgWithJsonFallback(args, 'env', 'envJson', { label: 'mcp_config env' }),
        'mcp_config envJson',
    );
    const headers = requireStringMapObject(
        resolveObjectArgWithJsonFallback(args, 'headers', 'headersJson', { label: 'mcp_config headers' }),
        'mcp_config headersJson',
    );
    const resolvedTransport = transport || type || 'auto';
    if (!name) {
        throw new Error('mcp_config requires name');
    }
    const hasConnectionUpdate = Boolean(
        url
        || command
        || commandArgs !== undefined
        || env !== undefined
        || cwd !== undefined
        || stderr !== undefined
        || token !== undefined
        || headers !== undefined
        || transport !== undefined
        || type !== undefined
        || description !== undefined
    );
    if (typeof enable === 'boolean' && !hasConnectionUpdate) {
        await mcpClient.setServerEnabled(name, enable);
        return `MCP server "${name}" ${enable ? 'enabled' : 'disabled'}.`;
    }
    if (resolvedTransport === 'stdio') {
        if (!command) {
            throw new Error('mcp_config with stdio transport requires command');
        }
    } else if (!url) {
        throw new Error('mcp_config requires url for streamable-http, sse, or auto transport');
    }
    await mcpClient.upsertServer(name, { url, command, args: commandArgs, env, cwd, stderr, token, headers, description, enable, transport, type });
    return `MCP server \"${name}\" saved${enable === false ? ' (disabled)' : ''}.`;
}

export async function tool_call_mcp(args: ToolArgs) {
    let { server, tool, args: toolArgs } = args;
    if (!tool) {
        throw new Error('call_mcp requires tool');
    }

    if (!server && typeof tool === 'string' && tool.includes('/')) {
        const [serverName, ...rest] = tool.split('/');
        if (serverName && rest.length) {
            server = serverName;
            tool = rest.join('/');
        }
    }

    return await mcpClient.callTool(server, tool, toolArgs || {});
}

export async function tool_search_mcp_tools(args: ToolArgs) {
    const { server, query } = args;
    const tools = await mcpClient.listTools(server);
    const list = Array.isArray(tools?.tools) ? tools.tools : tools;
    const items = Array.isArray(list) ? list : [];

    if (!items.length) {
        return 'No MCP tools available.';
    }

    const normalizedQuery = (query || '').toLowerCase().trim();
    const filtered = normalizedQuery
        ? items.filter((t: any) => {
            const name = String(t?.name || '').toLowerCase();
            const desc = String(t?.description || '').toLowerCase();
            return name.includes(normalizedQuery) || desc.includes(normalizedQuery);
        })
        : items;

    const limited = filtered.slice(0, 50).map((t: any) => {
        const name = t?.name || 'unknown';
        const fullName = server ? `${server}/${name}` : name;
        const desc = t?.description ? ` - ${t.description}` : '';
        return `${fullName}${desc}`;
    });

    if (!limited.length) {
        return 'No matching MCP tools.';
    }

    return `MCP tools (${limited.length}${filtered.length > limited.length ? ` of ${filtered.length}` : ''}):\n` + limited.join('\n');
}

export async function tool_list_mcp_servers(_args: ToolArgs) {
    const servers = await mcpClient.listServers();

    if (!servers.length) {
        return {
            count: 0,
            servers: [] as mcpClient.McpServerSummary[],
            message: 'No MCP servers configured.',
        };
    }

    return {
        count: servers.length,
        servers,
    };
}
