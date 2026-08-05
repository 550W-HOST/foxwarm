import {
  defineRpcService,
  rpcMethod,
  RpcError,
  RpcServiceHandler,
} from './rpc';
import * as sessionManager from './sessionManager';
import { nodesManager } from './nodes/manager';

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

export const nodeExecutionServiceDescriptor = defineRpcService('node-execution', 1, {
  execute: rpcMethod<NodeExecutionRequest, NodeExecutionResponse>(),
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

export function createNodeExecutionServiceHandler(): RpcServiceHandler<typeof nodeExecutionServiceDescriptor> {
  return {
    async execute(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new RpcError('NODE_EXECUTION_INVALID_REQUEST', 'Node execution request must be an object.');
      }
      assertOnlyKeys(input, ['sourceSessionId', 'nodeId', 'toolName', 'args', 'routingSnapshot'], 'request');
      const sourceSessionId = requireString(input?.sourceSessionId, 'sourceSessionId');
      const nodeId = requireString(input?.nodeId, 'nodeId');
      const toolName = requireString(input?.toolName, 'toolName');
      const args = normalizeArgs(input?.args);
      const routingSnapshot = normalizeRoutingSnapshot(input?.routingSnapshot);
      if (nodeId === 'master') {
        throw new RpcError('NODE_EXECUTION_MASTER_FORBIDDEN', 'The colocated master node must execute directly without Node execution RPC.');
      }

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
  };
}
