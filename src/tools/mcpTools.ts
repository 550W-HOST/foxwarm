import { ToolArgs, ToolContext } from './helpers';
import * as mcpExternal from '../mcpExternalService';
import type { McpServerSummary } from '../mcpClient';
import { resolveObjectArgWithJsonFallback, requireStringMapObject } from '../jsonObjectArgs';

function requireSourceSessionId(ctx?: ToolContext): string {
    if (!ctx?.sessionId) throw new Error('MCP tools require an active source session.');
    return ctx.sessionId;
}

export async function tool_mcp_config(args: ToolArgs, ctx?: ToolContext) {
    const { name, url, command, args: commandArgs, cwd, stderr, token, description, enable, transport, type, timeoutSeconds } = args;
    const env = requireStringMapObject(
        resolveObjectArgWithJsonFallback(args, 'env', 'envJson', { label: 'mcp_config env' }),
        'mcp_config envJson',
    );
    const headers = requireStringMapObject(
        resolveObjectArgWithJsonFallback(args, 'headers', 'headersJson', { label: 'mcp_config headers' }),
        'mcp_config headersJson',
    );
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
        || timeoutSeconds !== undefined
    );
    if (typeof enable === 'boolean' && !hasConnectionUpdate) {
        await mcpExternal.configureMcpServer({ sourceSessionId: requireSourceSessionId(ctx), name, action: 'set-enabled', enabled: enable });
        return `MCP server "${name}" ${enable ? 'enabled' : 'disabled'}.`;
    }
    const config = Object.fromEntries(Object.entries({
        url, command, args: commandArgs, env, cwd, stderr, token, headers, description, enable, transport, type, timeoutSeconds,
    }).filter(([, value]) => value !== undefined));
    await mcpExternal.configureMcpServer({ sourceSessionId: requireSourceSessionId(ctx), name, action: 'upsert', config });
    const timeoutMessage = timeoutSeconds === 0
        ? ' Tool-call timeout reset to the MCP SDK default.'
        : typeof timeoutSeconds === 'number'
            ? ` Tool-call timeout: ${timeoutSeconds} second(s).`
            : '';
    return `MCP server \"${name}\" saved${enable === false ? ' (disabled)' : ''}.${timeoutMessage}`;
}

export async function tool_list_mcp_servers(_args: ToolArgs, ctx?: ToolContext) {
    const servers = await mcpExternal.listMcpServers(requireSourceSessionId(ctx));

    if (!servers.length) {
        return {
            count: 0,
            servers: [] as McpServerSummary[],
            message: 'No MCP servers configured.',
        };
    }

    return {
        count: servers.length,
        servers,
    };
}
