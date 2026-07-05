import {
    ToolArgs,
    ToolContext,
} from './helpers';
import * as sessionManager from '../sessionManager';
import { checkToolPermission } from '../isolatedCheck';
import { nodesManager } from '../nodes/manager';
import { buildNodeBootstrapInfo, ensureNodePairingToken } from '../nodes/bootstrapInfo';
import { logger } from '../common';
import { getAgentDir } from '../config';

export async function tool_copy_between_nodes(args: ToolArgs, ctx: ToolContext) {
    const { sourceNode, sourcePath, targetNode, targetPath, overwrite = false } = args;

    if (!ctx.sessionId) {
        throw new Error('copy_between_nodes requires an active session context.');
    }

    if (!sourceNode || !targetNode || !sourcePath || !targetPath) {
        throw new Error('copy_between_nodes requires sourceNode, sourcePath, targetNode, and targetPath.');
    }

    await checkToolPermission('copy_between_nodes', ctx.sessionId, 'master', {
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

export async function tool_remote_node(args: ToolArgs, ctx: ToolContext) {
    const { action, nodeId, tool, args: toolArgs } = args;
    
    // Get session for isolated check
    const session = ctx.sessionId ? await sessionManager.getExistingSession(ctx.sessionId) : undefined;
    
    // Isolated sessions can only call tools on their bound node
    const isolatedAllowedRemoteNodes = sessionManager.isSessionEffectivelyIsolated(session)
        ? Array.from(new Set([
            sessionManager.getAgentIsolationNode(session?.agent || 'main') || session?.currentNode || 'master',
            session?.currentNode,
        ].filter((value): value is string => typeof value === 'string' && value.length > 0)))
        : [];

    if (sessionManager.isSessionEffectivelyIsolated(session) && action === 'call') {
        if (!isolatedAllowedRemoteNodes.includes(String(nodeId || ''))) {
            throw new Error(`Isolated session can only call tools on its bound/current node (${isolatedAllowedRemoteNodes.join(', ')}).`);
        }
    }
    
    if (action === 'list') {
        // List visible nodes and their tools, with optional node filter
        const nodes = nodesManager.listNodesWithTools();
        const visibleNodes = sessionManager.isSessionEffectivelyIsolated(session)
            ? nodes.filter((n: any) => isolatedAllowedRemoteNodes.includes(n.id))
            : nodes;
        const filteredNodes = typeof nodeId === 'string' && nodeId.trim().length > 0
            ? visibleNodes.filter((n: any) => n.id === nodeId)
            : visibleNodes;
        return {
            nodes: filteredNodes.map((n: any) => ({
                id: n.id,
                type: n.type,
                tools: n.tools.map((t: any) => ({
                    name: t.name,
                    description: t.description,
                    parameters: t.parameters
                }))
            }))
        };
    }
    
    if (action === 'call') {
        // Call a specific tool on a node
        if (!nodeId || !tool) {
            throw new Error('nodeId and tool are required for call action');
        }
        
        const result = await nodesManager.executeNodeTool(
            nodeId,
            tool,
            toolArgs || {},
            ctx.sessionId
        );
        
        return result;
    }
    
    throw new Error(`Unknown action: ${action}`);
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
    const nodes = nodesManager.listNodes();
    const currentNode = await resolveCurrentNodeForList(ctx);
    
    if (nodes.length === 0) {
        return `No nodes registered. Current node: \`${currentNode}\`.`;
    }
    
    let result = `Found ${nodes.length} node(s). Current node: \`${currentNode}\`.\n\n`;
    let foundCurrentNode = false;
    for (const node of nodes) {
        const isMaster = node.id === 'master';
        const label = isMaster ? ' (local)' : ' (remote)';
        const currentMarker = node.id === currentNode ? ' ✅ current' : '';
        if (node.id === currentNode) {
            foundCurrentNode = true;
        }
        result += `- \`${node.id}\`${label}${currentMarker} - Last activity: ${new Date(node.lastActivity).toISOString()}\n`;
    }
    if (!foundCurrentNode) {
        result += `\nCurrent node \`${currentNode}\` is not currently registered/connected.\n`;
    }
    
    return result;
};

async function resolveDefaultCwdForNode(nodeId: string, sessionId: string, agentName: string): Promise<string> {
    if (nodeId === 'master') {
        return getAgentDir(agentName);
    }

    const node = nodesManager.getNode(nodeId);
    if (node?.tools?.has('get_default_cwd')) {
        try {
            const result = await nodesManager.executeTool(nodeId, 'get_default_cwd', {}, sessionId);
            const text = typeof result === 'string'
                ? result
                : (typeof (result as any)?.output === 'string' ? (result as any).output : String(result ?? ''));
            const cwd = text.trim();
            if (cwd) return cwd;
        } catch (e) {
            logger.warn({ err: e, nodeId, sessionId }, 'Failed to query node default cwd after current node change');
        }
    }

    return 'node process cwd (run `pwd` to inspect)';
}

export const tool_change_current_node = async (args: ToolArgs, ctx: ToolContext) => {
    const { nodeId } = args;
    
    if (!ctx || !ctx.sessionId) {
        throw new Error('Cannot change node: missing context');
    }

    const session = await sessionManager.getSession(ctx.sessionId);
    if (sessionManager.isSessionEffectivelyIsolated(session)) {
        throw new Error('This session is isolated and cannot switch node via tools. Use /node from the user channel.');
    }
    
    nodesManager.setCurrentNode(ctx.sessionId, nodeId);
    
    // Also update session's currentNode
    session.currentNode = nodeId;
    delete session.cwd;
    await sessionManager.saveSession(ctx.sessionId);
    const defaultCwd = await resolveDefaultCwdForNode(nodeId, ctx.sessionId, session.agent || 'main');
    
    return `Current node changed to \`${nodeId}\`. Session cwd cleared. Subsequent exec calls will use the node default cwd: \`${defaultCwd}\`.`;
};

export const tool_node_bootstrap_info = async (_args: ToolArgs = {}) => {
    const token = await ensureNodePairingToken();
    return buildNodeBootstrapInfo({ pairingToken: token });
};

export const tool_node_pair_approve = async (args: ToolArgs) => {
    const { pendingId, nodeId: requestedNodeId } = args;
    if (!pendingId) throw new Error('Missing required parameter: pendingId');

    const { approvePendingPairing } = await import('../nodes/registry');
    const result = await approvePendingPairing(pendingId, requestedNodeId || undefined);
    return `✅ Approved node \`${result.nodeId}\` (delivered live: ${result.deliveredLive})`;
};

export const tool_node_pair_list = async () => {
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
