import fs from 'fs-extra';
import { RpcError } from './rpc';
import { getAgentDir } from './config';
import {
    tool_run_script,
    tool_start_toolscript_run,
    tool_continue_script,
    tool_list_toolscript_runs,
    tool_get_toolscript_run,
    tool_cancel_toolscript_run,
} from './toolscript';
import {
    tool_create_child_session,
    tool_wait,
    tool_submit_compact_plan,
    tool_send_file,
    tool_session,
    tool_skill,
    tool_get_session_messages,
    tool_get_archived_messages,
    tool_get_archived_blocks,
    tool_recall,
    tool_delete_session,
    tool_set_goal,
    tool_set_session_child_model,
    tool_set_session_compact_threshold,
    tool_update_session_snapshot,
    tool_stop_session,
    tool_compact_session,
    tool_create_agent,
    tool_create_session,
    tool_set_agent_inherit,
    tool_set_agent_isolated,
    tool_move_session,
} from './toolsSessionAgent';
import {
    tool_send_to_session,
    tool_send_to_channel,
    tool_list_agents,
    tool_create_timer,
    tool_list_timers,
    tool_update_timer,
    tool_delete_timer,
} from './mainManagementTools';

// Re-export types from helpers
export type { ToolContext, ToolArgs, UnifiedToolSource } from './tools/helpers';

// Import sub-modules
import { tool_read, tool_write, tool_edit, tool_apply_patch } from './tools/fileTools';
import { tool_read_memory, tool_write_memory, tool_edit_memory, tool_delete_memory, tool_apply_patch_memory } from './tools/memoryTools';
import { tool_exec } from './tools/execTools';
import { tool_image_crop, tool_image_write_to_file } from './tools/imageTools';
import { tool_browse_open, tool_browse_list, tool_browse_get, tool_browse_close, tool_browse_interact } from './tools/browserTools';
import { tool_mcp_config, tool_call_mcp, tool_search_mcp_tools, tool_list_mcp_servers } from './tools/mcpTools';
import { tool_copy_between_nodes, tool_remote_node, tool_node, tool_node_bootstrap_info, tool_node_pair_approve, tool_node_pair_list } from './tools/nodeTools';
import { tool_get_memory_context, resolveMemorySearchOptions } from './tools/vectorTools';
import { tool_search_tools, tool_call_tool, setDefinitionsRef } from './tools/unifiedSearch';
import { definitions } from './tools/definitions';

export {
    BUILTIN_TOOL_PLACEMENTS,
    NODE_ENVIRONMENT_BUILTIN_NAMES,
    resolveBuiltinToolPlacement,
} from './tools/placement';
export type { RegisteredBuiltinToolName, ResolvedBuiltinToolPlacement, ToolPlacementMetadata, ToolPlacementOwner } from './tools/placement';

// Ensure agent dir exists
fs.ensureDirSync(getAgentDir('main'));

const TARGET_NODE_PERMISSION_TOOL_NAMES = new Set([
    'send_file',
    'image_write_to_file',
]);

export function isToolDirectlyExposedToModel(toolName: string): boolean {
    return definitions.find(def => def.name === toolName)?.defaultInject === true;
}

export function getToolPermissionNode(toolName: string, executionNode: string, targetNode: string): string {
    return TARGET_NODE_PERMISSION_TOOL_NAMES.has(toolName)
        ? targetNode
        : executionNode;
}

// Wire up the unified search module with definitions reference
setDefinitionsRef(definitions, isToolDirectlyExposedToModel, getToolPermissionNode, callTool, assertToolAvailableForPlacement);

const WORKER_UNSUPPORTED_TOOLS = new Set([
    'create_child_session', 'send_file', 'delete_session', 'compact_session',
    'node_bootstrap_info', 'node_pair_approve', 'node_pair_list',
    'create_agent', 'create_session', 'set_agent_inherit', 'set_agent_isolated', 'move_session',
    'get_memory_context',
]);

function workerUnavailable(toolName: string): never {
    throw new RpcError('SESSION_WORKER_TOOL_UNAVAILABLE', `SESSION_WORKER_TOOL_UNAVAILABLE: Tool \`${toolName}\` is not available in Session-worker placement yet.`, true);
}

export function assertToolAvailableForPlacement(toolName: string, args: any, ctx: any): void {
    if (ctx?.sessionPlacement !== 'session-worker') return;
    if (WORKER_UNSUPPORTED_TOOLS.has(toolName)) workerUnavailable(toolName);
    const owner = ctx.session;
    if (!owner || owner.id !== ctx.sessionId || !ctx.persistCurrentSession) workerUnavailable(toolName);
    const currentId = owner.id;
    const isCurrent = (targetId: unknown): boolean => typeof targetId === 'string'
        && (targetId === currentId || (Array.isArray(owner.aliases) && owner.aliases.includes(targetId)));
    const fallbackTarget = args?.sessionId || currentId;
    const literalTarget = args?.sessionId;
    if (toolName === 'session') {
        const action = typeof args?.action === 'string' && args.action.trim() ? args.action.trim().toLowerCase() : 'status';
        if (action === 'list') workerUnavailable(toolName);
        if (action === 'update-display-name' && !isCurrent(fallbackTarget)) workerUnavailable(toolName);
    }
    if (toolName === 'remote_node' || toolName === 'node_tools') {
        const action = args?.action;
        if (action !== 'list') workerUnavailable(toolName);
    }
    if (toolName === 'image_write_to_file') {
        const targetNode = ctx.runtimeNodeId || owner?.currentNode || 'master';
        if (targetNode !== 'master') workerUnavailable(toolName);
    }
    if (['get_session_messages', 'stop_session'].includes(toolName) && !isCurrent(literalTarget)) workerUnavailable(toolName);
    if (['get_archived_messages', 'get_archived_blocks', 'set_session_child_model',
        'set_session_compact_threshold', 'update_session_snapshot'].includes(toolName) && !isCurrent(fallbackTarget)) workerUnavailable(toolName);
    if (toolName === 'recall') {
        const target = typeof args?.sessionId === 'string' ? (args.sessionId.trim() || currentId) : (args?.sessionId || currentId);
        const agent = typeof args?.agentName === 'string' ? args.agentName.trim() : args?.agentName;
        if (!isCurrent(target) || (agent && agent !== (owner.agent || 'main'))) workerUnavailable(toolName);
    }
}

// --- callTool dispatcher ---
export async function callTool(toolName: string, args: any, context: any): Promise<any> {
    assertToolAvailableForPlacement(toolName, args, context);
    const toolMap: Record<string, (args: any, ctx: any) => Promise<any>> = {
        read: tool_read,
        write: tool_write,
        edit: tool_edit,
        apply_patch: tool_apply_patch,
        read_memory: tool_read_memory,
        write_memory: tool_write_memory,
        edit_memory: tool_edit_memory,
        delete_memory: tool_delete_memory,
        apply_patch_memory: tool_apply_patch_memory,
        exec: tool_exec,
        image_crop: tool_image_crop,
        image_write_to_file: tool_image_write_to_file,
        copy_between_nodes: tool_copy_between_nodes,
        browse_open: tool_browse_open,
        browse_list: tool_browse_list,
        browse_get: tool_browse_get,
        browse_close: tool_browse_close,
        browse_interact: tool_browse_interact,
        mcp_config: tool_mcp_config,
        call_mcp: tool_call_mcp,
        search_mcp_tools: tool_search_mcp_tools,
        list_mcp_servers: tool_list_mcp_servers,
        remote_node: tool_remote_node,
        node_tools: tool_remote_node,
        node: tool_node,
        node_bootstrap_info: tool_node_bootstrap_info,
        node_pair_approve: tool_node_pair_approve,
        node_pair_list: tool_node_pair_list,
        get_memory_context: tool_get_memory_context,
        search_tools: tool_search_tools,
        call_tool: tool_call_tool,
        create_child_session: tool_create_child_session,
        send_to_session: tool_send_to_session,
        wait: tool_wait,
        submit_compact_plan: tool_submit_compact_plan,
        send_to_channel: tool_send_to_channel,
        send_file: tool_send_file,
        session: tool_session,
        list_agents: tool_list_agents,
        skill: tool_skill,
        get_session_messages: tool_get_session_messages,
        get_archived_messages: tool_get_archived_messages,
        get_archived_blocks: tool_get_archived_blocks,
        recall: tool_recall,
        delete_session: tool_delete_session,
        set_goal: tool_set_goal,
        set_session_child_model: tool_set_session_child_model,
        set_session_compact_threshold: tool_set_session_compact_threshold,
        update_session_snapshot: tool_update_session_snapshot,
        stop_session: tool_stop_session,
        compact_session: tool_compact_session,
        create_timer: tool_create_timer,
        list_timers: tool_list_timers,
        update_timer: tool_update_timer,
        delete_timer: tool_delete_timer,
        create_agent: tool_create_agent,
        create_session: tool_create_session,
        set_agent_inherit: tool_set_agent_inherit,
        set_agent_isolated: tool_set_agent_isolated,
        move_session: tool_move_session,
        run_script: tool_run_script,
        start_toolscript_run: tool_start_toolscript_run,
        continue_script: tool_continue_script,
        list_toolscript_runs: tool_list_toolscript_runs,
        get_toolscript_run: tool_get_toolscript_run,
        cancel_toolscript_run: tool_cancel_toolscript_run,
    };

    const handler = toolMap[toolName];
    if (!handler) {
        throw new Error(`Unknown tool: ${toolName}`);
    }

    return handler(args, context);
}

// --- Named exports for direct access (preserves existing import patterns) ---
export const read = tool_read;
export const write = tool_write;
export const edit = tool_edit;
export const read_memory = tool_read_memory;
export const write_memory = tool_write_memory;
export const edit_memory = tool_edit_memory;
export const delete_memory = tool_delete_memory;
export const apply_patch_memory = tool_apply_patch_memory;
export const apply_patch = tool_apply_patch;
export const copy_between_nodes = tool_copy_between_nodes;
export const image_crop = tool_image_crop;
export const image_write_to_file = tool_image_write_to_file;
export const exec = tool_exec;
export const get_memory_context = tool_get_memory_context;
export const create_child_session = tool_create_child_session;
export const create_agent = tool_create_agent;
export const create_session = tool_create_session;
export const set_agent_inherit = tool_set_agent_inherit;
export const set_agent_isolated = tool_set_agent_isolated;
export const move_session = tool_move_session;
export const send_to_session = tool_send_to_session;
export const wait = tool_wait;
export const submit_compact_plan = tool_submit_compact_plan;
export const send_to_channel = tool_send_to_channel;
export const send_file = tool_send_file;
export const session = tool_session;
export const list_agents = tool_list_agents;
export const skill = tool_skill;
export const get_session_messages = tool_get_session_messages;
export const get_archived_messages = tool_get_archived_messages;
export const get_archived_blocks = tool_get_archived_blocks;
export const recall = tool_recall;
export const delete_session = tool_delete_session;
export const set_goal = tool_set_goal;
export const set_session_child_model = tool_set_session_child_model;
export const set_session_compact_threshold = tool_set_session_compact_threshold;
export const update_session_snapshot = tool_update_session_snapshot;
export const stop_session = tool_stop_session;
export const compact_session = tool_compact_session;
export const create_timer = tool_create_timer;
export const list_timers = tool_list_timers;
export const update_timer = tool_update_timer;
export const delete_timer = tool_delete_timer;
export const browse_open = tool_browse_open;
export const browse_list = tool_browse_list;
export const browse_get = tool_browse_get;
export const browse_close = tool_browse_close;
export const browse_interact = tool_browse_interact;
export const remote_node = tool_remote_node;
export const node_tools = tool_remote_node;
export const mcp_config = tool_mcp_config;
export const call_mcp = tool_call_mcp;
export const search_mcp_tools = tool_search_mcp_tools;
export const list_mcp_servers = tool_list_mcp_servers;
export const search_tools = tool_search_tools;
export const call_tool = tool_call_tool;
export const run_script = tool_run_script;
export const start_toolscript_run = tool_start_toolscript_run;
export const continue_script = tool_continue_script;
export const list_toolscript_runs = tool_list_toolscript_runs;
export const get_toolscript_run = tool_get_toolscript_run;
export const cancel_toolscript_run = tool_cancel_toolscript_run;
export const node = tool_node;
export const node_bootstrap_info = tool_node_bootstrap_info;
export const node_pair_approve = tool_node_pair_approve;
export const node_pair_list = tool_node_pair_list;

// Re-export definitions and model-facing subset
export { definitions };
export const modelFacingDefinitions = definitions.filter(def => isToolDirectlyExposedToModel(def.name));

// Re-export utilities used by other modules
export { resolveMemorySearchOptions };
