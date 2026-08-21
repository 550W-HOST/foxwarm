import {
    ToolArgs,
    ToolContext,
} from './helpers';
import * as sessionManager from '../sessionManager';
import * as sessionRuntime from '../sessionRuntime';
import { checkToolPermission } from '../isolatedCheck';
import { nodesManager } from '../nodes/manager';
import { buildNodeBootstrapInfo, ensureNodePairingToken } from '../nodes/bootstrapInfo';
import {
    copyBetweenNodes,
    executeNodeLifecycle,
    listNodeLifecycleProviders,
    listNodeTopology,
    validateNodeSelection,
} from '../nodeExecution';
import { executeMainManagementTool } from '../mainManagementTools';
import { resolveObjectArgWithJsonFallback } from '../jsonObjectArgs';

export async function tool_copy_between_nodes(args: ToolArgs, ctx: ToolContext) {
    const { sourceNode, sourcePath, targetNode, targetPath, overwrite = false } = args;

    if (!ctx.sessionId) {
        throw new Error('copy_between_nodes requires an active session context.');
    }

    if (!sourceNode || !targetNode || !sourcePath || !targetPath) {
        throw new Error('copy_between_nodes requires sourceNode, sourcePath, targetNode, and targetPath.');
    }

    if (ctx.sessionPlacement === 'session-worker') {
        const result = await copyBetweenNodes(ctx.sessionId, { sourceNode, sourcePath, targetNode, targetPath, overwrite: overwrite === true });
        const lines = [`Copied \`${sourcePath}\` from node \`${sourceNode}\` to \`${targetPath}\` on node \`${targetNode}\`.`,
            `Size: ${result.sizeBytes} B`, `SHA256: ${result.sha256}`, `Overwrote existing file: ${result.overwritten ? 'yes' : 'no'}`];
        if (result.absolutePath) lines.push(`Target absolute path: ${result.absolutePath}`);
        return lines.join('\n');
    }

    await checkToolPermission({ source: 'builtin', tool: 'copy_between_nodes' }, ctx.sessionId, 'master', {
        sourceNode,
        sourcePath,
        targetNode,
        targetPath,
        overwrite,
    });

    const file = await nodesManager.readFileFromNode(String(sourceNode), String(sourcePath), ctx.sessionId);
    const result = await nodesManager.writeFileToNode(String(targetNode), String(targetPath), file.dataBase64, overwrite === true, ctx.sessionId);

    const lines = [
        `Copied \`${sourcePath}\` from node \`${sourceNode}\` to \`${targetPath}\` on node \`${targetNode}\`.`,
        `Size: ${file.sizeBytes} B`,
        `SHA256: ${result.sha256}`,
        `Overwrote existing file: ${result.overwritten ? 'yes' : 'no'}`,
    ];
    if (result.absolutePath) {
        lines.push(`Target absolute path: ${result.absolutePath}`);
    }
    return lines.join('\n');
}

async function resolveCurrentNodeForList(ctx?: ToolContext): Promise<string> {
    if (typeof ctx?.session?.currentNode === 'string' && ctx.session.currentNode.trim()) {
        return ctx.session.currentNode.trim();
    }

    if (ctx?.sessionId) {
        return await nodesManager.getCurrentNode(ctx.sessionId) || 'master';
    }

    return 'master';
}

export const tool_list_nodes = async (_args: ToolArgs = {}, ctx?: ToolContext) => {
    if (!ctx?.sessionId) throw new Error('Node listing requires session context.');
    if (ctx.sessionPlacement === 'session-worker' && ctx.session?.id !== ctx.sessionId) throw new Error('Node listing requires exact session context.');
    const currentNode = await resolveCurrentNodeForList(ctx);
    const nodes = await listNodeTopology(ctx.sessionId, undefined, currentNode);
    const lifecycleProviders = await listNodeLifecycleProviders(ctx.sessionId);
    const providerBody = lifecycleProviders.length > 0
        ? `\nLifecycle providers:\n${lifecycleProviders.map(provider => `- \`${provider.id}\` (${provider.actions.join(', ')})`).join('\n')}\n`
        : '';
    if (nodes.length === 0) return `No nodes registered. Current node: \`${currentNode}\`.${providerBody}`;
    const body = nodes.map(node => {
        const label = node.kind === 'master' ? 'local' : node.kind;
        return `- \`${node.id}\` (${label})${node.id === currentNode ? ' ✅ current' : ''}`
            + (typeof node.lastActivity === 'number' ? ` - Last activity: ${new Date(node.lastActivity).toISOString()}` : '');
    }).join('\n');
    return `Found ${nodes.length} node(s). Current node: \`${currentNode}\`.\n\n${body}\n${providerBody}`
        + (nodes.some(node => node.id === currentNode) ? '' : `\nCurrent node \`${currentNode}\` is not currently available.\n`);
};

export const tool_change_current_node = async (args: ToolArgs, ctx: ToolContext) => {
    const { nodeId } = args;
    
    if (!ctx || !ctx.sessionId) {
        throw new Error('Cannot change node: missing context');
    }

    if (ctx.sessionPlacement === 'session-worker') {
        const session = ctx.session;
        if (!session || session.id !== ctx.sessionId || !ctx.persistCurrentSession) throw new Error('Node selection requires exact session context.');
        if (sessionManager.isSessionEffectivelyIsolated(session)) {
            throw new Error('This session is isolated and cannot switch node via tools. Use /node from the user channel.');
        }
        const validated = await validateNodeSelection(ctx.sessionId, nodeId);
        session.currentNode = validated.nodeId; delete session.cwd;
        await ctx.persistCurrentSession();
        return `Current node changed to \`${validated.nodeId}\`. Session cwd cleared. Subsequent exec calls will use the node default cwd: \`${validated.defaultCwd}\`.`;
    }

    const session = await sessionManager.getSession(ctx.sessionId);
    if (sessionManager.isSessionEffectivelyIsolated(session)) {
        throw new Error('This session is isolated and cannot switch node via tools. Use /node from the user channel.');
    }
    
    const validated = await validateNodeSelection(ctx.sessionId, nodeId);
    await sessionRuntime.updateSettings(ctx.sessionId, { currentNode: nodeId, cwd: null });
    return `Current node changed to \`${validated.nodeId}\`. Session cwd cleared. Subsequent exec calls will use the node default cwd: \`${validated.defaultCwd}\`.`;
};

function assertNodeActionKeys(args: ToolArgs, action: string, allowed: readonly string[]): void {
    const accepted = new Set(['action', ...allowed]);
    const unexpected = Object.keys(args || {}).find(key => !accepted.has(key));
    if (unexpected) throw new Error(`node action="${action}" does not accept ${unexpected}.`);
}

export async function tool_node(args: ToolArgs, ctx: ToolContext): Promise<any> {
    const action = typeof args?.action === 'string' ? args.action.trim().toLowerCase() : '';
    if (action === 'list') {
        assertNodeActionKeys(args, action, []);
        return tool_list_nodes(args, ctx);
    }
    if (action === 'select') {
        assertNodeActionKeys(args, action, ['nodeId']);
        if (typeof args.nodeId !== 'string' || !args.nodeId.trim()) {
            throw new Error('node.nodeId is required for action="select".');
        }
        return tool_change_current_node({ ...args, nodeId: args.nodeId.trim() }, ctx);
    }
    if (['create', 'ensure', 'inspect', 'destroy'].includes(action)) {
        if (!ctx?.sessionId) throw new Error(`node ${action} requires session context.`);
        assertNodeActionKeys(args, action, action === 'create' || action === 'ensure'
            ? ['providerId', 'nodeId', 'parameters', 'parametersJson']
            : action === 'inspect'
                ? ['nodeId', 'parameters', 'parametersJson']
                : ['nodeId', 'parameters', 'parametersJson', 'confirmation']);
        const parameters = resolveObjectArgWithJsonFallback(args, 'parameters', 'parametersJson', {
            label: `node ${action} parameters`,
        }) || {};
        if (action === 'create' || action === 'ensure') {
            if (typeof args.providerId !== 'string' || !args.providerId.trim()) {
                throw new Error(`node.providerId is required for action="${action}".`);
            }
            return executeNodeLifecycle(ctx.sessionId, {
                action,
                providerId: args.providerId.trim(),
                ...(args.nodeId === undefined ? {} : { nodeId: args.nodeId }),
                parameters,
            });
        }
        if (typeof args.nodeId !== 'string' || !args.nodeId.trim()) {
            throw new Error(`node.nodeId is required for action="${action}".`);
        }
        return executeNodeLifecycle(ctx.sessionId, {
            action: action as 'inspect' | 'destroy',
            nodeId: args.nodeId.trim(),
            parameters,
            ...(action === 'destroy' ? { confirmation: args.confirmation } : {}),
        });
    }
    throw new Error('node.action must be "list", "select", "create", "ensure", "inspect", or "destroy".');
}

export const tool_node_bootstrap_info = async (args: ToolArgs = {}, ctx?: ToolContext) => {
    if (ctx?.sessionPlacement === 'session-worker') return executeMainManagementTool('node_bootstrap_info', args, ctx);
    const token = await ensureNodePairingToken();
    return buildNodeBootstrapInfo({ pairingToken: token });
};

export const tool_node_pair_approve = async (args: ToolArgs, ctx?: ToolContext) => {
    if (ctx?.sessionPlacement === 'session-worker') return executeMainManagementTool('node_pair_approve', args, ctx);
    const { pendingId, nodeId: requestedNodeId } = args;
    if (!pendingId) throw new Error('Missing required parameter: pendingId');

    const { approvePendingPairing } = await import('../nodes/registry');
    const result = await approvePendingPairing(pendingId, requestedNodeId || undefined);
    return `✅ Approved node \`${result.nodeId}\` (delivered live: ${result.deliveredLive})`;
};

export const tool_node_pair_list = async (args: ToolArgs = {}, ctx?: ToolContext) => {
    if (ctx?.sessionPlacement === 'session-worker') return executeMainManagementTool('node_pair_list', args, ctx);
    const { listPendingPairings } = await import('../nodes/registry');
    const pendings = await listPendingPairings();
    if (pendings.length === 0) return 'No pending pairing requests.';

    let result = `${pendings.length} pending pairing(s):\n\n`;
    for (const p of pendings) {
        const status = p.approvedNodeId ? `approved→${p.approvedNodeId} (unclaimed)` : (p.connected ? 'online' : 'offline');
        result += `- \`${p.id}\` [${p.nodeType}] name=${p.requestedName || '(none)'} code=${p.pairCode} ${status}\n`;
    }
    return result;
};
