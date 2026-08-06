import {
  defineRpcService,
  rpcMethod,
  RpcError,
  RpcServiceHandler,
} from './rpc';
import * as sessionManager from './sessionManager';
import { nodesManager } from './nodes/manager';
import type { Session } from './types';
import { getAgentDir } from './config';
import { checkToolPermission } from './isolatedCheck';

export type NodeExecutionRoutingSnapshot = {
  currentNode: string;
  cwd?: string;
};

export type NodeExecutionRequest = {
  sourceSessionId: string;
  nodeId: string;
  toolName: string;
  args: Record<string, unknown>;
  routingSnapshot?: NodeExecutionRoutingSnapshot;
};

export type NodeExecutionResponse = { result: unknown };
export type NodeTopologyListRequest = { sourceSessionId: string; nodeId?: string; currentNode?: string };
export type NodeTopologyListResponse = { nodes: Array<{ id: string; type: string; lastActivity?: number; tools: Array<{ name: string; description?: string; parameters?: unknown }> }> };
export type NodeSelectRequest = { sourceSessionId: string; nodeId: string };
export type NodeSelectResponse = { nodeId: string; defaultCwd: string };
export type NodeCopyRequest = { sourceSessionId: string; sourceNode: string; sourcePath: string; targetNode: string; targetPath: string; overwrite?: boolean };
export type NodeCopyResponse = { sourceNode: string; sourcePath: string; targetNode: string; targetPath: string; sizeBytes: number; sha256: string; overwritten: boolean; absolutePath?: string };

export const nodeExecutionServiceDescriptor = defineRpcService('node-execution', 1, {
  execute: rpcMethod<NodeExecutionRequest, NodeExecutionResponse>(),
  list: rpcMethod<NodeTopologyListRequest, NodeTopologyListResponse>(),
  select: rpcMethod<NodeSelectRequest, NodeSelectResponse>(),
  copy: rpcMethod<NodeCopyRequest, NodeCopyResponse>(),
});

function assertOnlyKeys(value: object, allowed: readonly string[], label: string): void {
  const unexpected = Object.keys(value).find(key => !allowed.includes(key));
  if (unexpected) {
    throw new RpcError('NODE_EXECUTION_INVALID_REQUEST', `${label} contains unsupported field: ${unexpected}.`);
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new RpcError('NODE_EXECUTION_INVALID_REQUEST', `${field} must be a non-empty string.`);
  }
  return value.trim();
}

function normalizeArgs(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RpcError('NODE_EXECUTION_INVALID_REQUEST', 'args must be an object.');
  }
  return value as Record<string, unknown>;
}

function normalizeRoutingSnapshot(value: unknown): NodeExecutionRoutingSnapshot | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RpcError('NODE_EXECUTION_INVALID_REQUEST', 'routingSnapshot must be an object.');
  }
  const candidate = value as Record<string, unknown>;
  assertOnlyKeys(candidate, ['currentNode', 'cwd'], 'routingSnapshot');
  const currentNode = requireString(candidate.currentNode, 'routingSnapshot.currentNode');
  if (candidate.cwd !== undefined && typeof candidate.cwd !== 'string') {
    throw new RpcError('NODE_EXECUTION_INVALID_REQUEST', 'routingSnapshot.cwd must be a string when provided.');
  }
  return { currentNode, ...(typeof candidate.cwd === 'string' ? { cwd: candidate.cwd } : {}) };
}

export async function requireNodeExecutionTarget(sourceSessionId: string, nodeId: string): Promise<Session> {
  const source = await sessionManager.getExistingSession(sourceSessionId);
  if (!source) {
    throw new RpcError('NODE_EXECUTION_SOURCE_NOT_FOUND', `Source session \`${sourceSessionId}\` was not found.`);
  }
  if (sessionManager.isSessionEffectivelyIsolated(source)) {
    const allowedNodes = Array.from(new Set([
      sessionManager.getAgentIsolationNode(source.agent || 'main') || source.currentNode || 'master',
      source.currentNode,
    ].filter((value): value is string => typeof value === 'string' && value.length > 0)));
    if (!allowedNodes.includes(nodeId)) {
      throw new RpcError('NODE_EXECUTION_ISOLATED_NODE_DENIED', `Isolated session can only call tools on its bound/current node (${allowedNodes.join(', ')}).`);
    }
  }
  return source;
}

export function createNodeExecutionServiceHandler(options: { expectedSourceSessionId?: string } = {}): RpcServiceHandler<typeof nodeExecutionServiceDescriptor> {
  const requireSource = async (input: any, allowed: readonly string[], label: string): Promise<{ sourceSessionId: string; source: Session }> => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new RpcError('NODE_EXECUTION_INVALID_REQUEST', `${label} must be an object.`);
    assertOnlyKeys(input, allowed, label);
    const sourceSessionId = requireString(input.sourceSessionId, 'sourceSessionId');
    if (options.expectedSourceSessionId && sourceSessionId !== options.expectedSourceSessionId) {
      throw new RpcError('NODE_EXECUTION_SOURCE_MISMATCH', `Node execution reverse source must be \`${options.expectedSourceSessionId}\`.`);
    }
    const source = await sessionManager.getExistingSession(sourceSessionId);
    if (!source) throw new RpcError('NODE_EXECUTION_SOURCE_NOT_FOUND', `Source session \`${sourceSessionId}\` was not found.`);
    return { sourceSessionId, source };
  };
  return {
    async execute(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new RpcError('NODE_EXECUTION_INVALID_REQUEST', 'Node execution request must be an object.');
      }
      assertOnlyKeys(input, ['sourceSessionId', 'nodeId', 'toolName', 'args', 'routingSnapshot'], 'request');
      const sourceSessionId = requireString(input?.sourceSessionId, 'sourceSessionId');
      if (options.expectedSourceSessionId && sourceSessionId !== options.expectedSourceSessionId) {
        throw new RpcError('NODE_EXECUTION_SOURCE_MISMATCH', `Node execution reverse source must be \`${options.expectedSourceSessionId}\`.`);
      }
      const nodeId = requireString(input?.nodeId, 'nodeId');
      const toolName = requireString(input?.toolName, 'toolName');
      const args = normalizeArgs(input?.args);
      const routingSnapshot = normalizeRoutingSnapshot(input?.routingSnapshot);
      if (nodeId === 'master') {
        throw new RpcError('NODE_EXECUTION_MASTER_FORBIDDEN', 'The colocated master node must execute directly without Node execution RPC.');
      }

      await requireNodeExecutionTarget(sourceSessionId, nodeId);

      const node = nodesManager.getNode(nodeId);
      if (!node || !node.ws) {
        throw new RpcError('NODE_EXECUTION_NODE_UNAVAILABLE', `Remote node \`${nodeId}\` is not connected.`, true);
      }
      if (!node.tools.has(toolName)) {
        throw new RpcError('NODE_EXECUTION_TOOL_UNAVAILABLE', `Tool \`${toolName}\` not available on node \`${nodeId}\`.`);
      }

      return {
        result: await nodesManager.executeTool(nodeId, toolName, args, sourceSessionId, routingSnapshot),
      };
    },
    async list(input) {
      const { source } = await requireSource(input, ['sourceSessionId', 'nodeId', 'currentNode'], 'Node list request');
      const filter = input.nodeId === undefined ? undefined : requireString(input.nodeId, 'nodeId');
      const currentNode = input.currentNode === undefined ? source.currentNode : requireString(input.currentNode, 'currentNode');
      const isolated = sessionManager.isSessionEffectivelyIsolated(source);
      const allowed = isolated ? new Set([sessionManager.getAgentIsolationNode(source.agent || 'main') || currentNode || 'master', currentNode].filter(Boolean)) : null;
      const nodes = nodesManager.listNodesWithTools().filter(node => (!filter || node.id === filter) && (!allowed || allowed.has(node.id))).slice(0, 100);
      const activity = new Map(nodesManager.listNodes().map(node => [node.id, node.lastActivity]));
      return { nodes: nodes.map(node => ({ id: node.id, type: node.type, ...(activity.has(node.id) ? { lastActivity: activity.get(node.id) } : {}), tools: node.tools.slice(0, 200).map(tool => ({
        name: String(tool.name), ...(tool.description ? { description: String(tool.description).slice(0, 2000) } : {}),
        ...(tool.parameters ? { parameters: structuredClone(tool.parameters) } : {}),
      })) })) };
    },
    async select(input) {
      const { sourceSessionId, source } = await requireSource(input, ['sourceSessionId', 'nodeId'], 'Node select request');
      const nodeId = requireString(input.nodeId, 'nodeId');
      await requireNodeExecutionTarget(sourceSessionId, nodeId);
      nodesManager.setCurrentNode(sourceSessionId, nodeId);
      if (nodeId === 'master') return { nodeId, defaultCwd: getAgentDir(source.agent || 'main') };
      const node = nodesManager.getNode(nodeId);
      if (node?.ws && node.tools.has('get_default_cwd')) {
        try {
          const value = await nodesManager.executeTool(nodeId, 'get_default_cwd', {}, sourceSessionId);
          const cwd = String(typeof value === 'object' && value && 'output' in value ? (value as any).output : value || '').trim();
          if (cwd) return { nodeId, defaultCwd: cwd };
        } catch { /* preserve the existing bounded fallback */ }
      }
      return { nodeId, defaultCwd: 'node process cwd (run `pwd` to inspect)' };
    },
    async copy(input) {
      const { sourceSessionId } = await requireSource(input,
        ['sourceSessionId', 'sourceNode', 'sourcePath', 'targetNode', 'targetPath', 'overwrite'], 'Node copy request');
      const sourceNode = requireString(input.sourceNode, 'sourceNode'); const sourcePath = requireString(input.sourcePath, 'sourcePath');
      const targetNode = requireString(input.targetNode, 'targetNode'); const targetPath = requireString(input.targetPath, 'targetPath');
      if (input.overwrite !== undefined && typeof input.overwrite !== 'boolean') throw new RpcError('NODE_EXECUTION_INVALID_REQUEST', 'overwrite must be a boolean.');
      await checkToolPermission('copy_between_nodes', sourceSessionId, 'master', { sourceNode, sourcePath, targetNode, targetPath, overwrite: input.overwrite === true });
      await requireNodeExecutionTarget(sourceSessionId, sourceNode); await requireNodeExecutionTarget(sourceSessionId, targetNode);
      const file = await nodesManager.readFileFromNode(sourceNode, sourcePath, sourceSessionId);
      const written = await nodesManager.writeFileToNode(targetNode, targetPath, file.dataBase64, input.overwrite === true, sourceSessionId);
      return { sourceNode, sourcePath, targetNode, targetPath, sizeBytes: file.sizeBytes, sha256: written.sha256,
        overwritten: written.overwritten, ...(written.absolutePath ? { absolutePath: written.absolutePath } : {}) };
    },
  };
}
