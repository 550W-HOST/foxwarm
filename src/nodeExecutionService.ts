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
import { createHash } from 'node:crypto';

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

function requireBoundedString(value: unknown, field: string, maxLength: number): string {
  const result = requireString(value, field);
  if (result.length > maxLength) throw new RpcError('NODE_EXECUTION_INVALID_REQUEST', `${field} exceeds ${maxLength} characters.`);
  return result;
}

function requireBoundedPath(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') throw new RpcError('NODE_EXECUTION_INVALID_REQUEST', `${field} must be a non-empty string.`);
  if (value.length > 4096) throw new RpcError('NODE_EXECUTION_INVALID_REQUEST', `${field} exceeds 4096 characters.`);
  return value;
}

function plainJsonWithin(value: unknown, maxBytes: number): unknown | undefined {
  const seen = new WeakSet<object>();
  const copy = (item: unknown, depth: number): unknown => {
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'string') { if (Buffer.byteLength(item, 'utf8') > maxBytes) throw new Error(); return item; }
    if (typeof item === 'number') { if (!Number.isFinite(item)) throw new Error(); return item; }
    if (!item || typeof item !== 'object' || depth > 12 || seen.has(item as object)) throw new Error();
    seen.add(item as object);
    if (Array.isArray(item)) {
      if (item.length > 2048) throw new Error();
      const descriptors = Object.getOwnPropertyDescriptors(item);
      if (Object.getOwnPropertySymbols(item).some(symbol => Object.getOwnPropertyDescriptor(item, symbol)?.enumerable)) throw new Error();
      if (Object.entries(descriptors).some(([key, descriptor]) => key !== 'length' && descriptor.enumerable && !/^(0|[1-9]\d*)$/.test(key))) throw new Error();
      const result = Array.from({ length: item.length }, (_, index) => {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !('value' in descriptor)) throw new Error();
        return copy(descriptor.value, depth + 1);
      });
      seen.delete(item as object); return result;
    }
    const proto = Object.getPrototypeOf(item);
    if (proto !== Object.prototype && proto !== null) throw new Error();
    if (Reflect.ownKeys(item).length > 2048) throw new Error();
    if (Object.getOwnPropertySymbols(item).some(symbol => Object.getOwnPropertyDescriptor(item, symbol)?.enumerable)) throw new Error();
    const result: Record<string, unknown> = Object.create(proto);
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(item))) {
      if (!descriptor.enumerable) continue;
      if (!('value' in descriptor) || key.length > 256) throw new Error();
      Object.defineProperty(result, key, { value: copy(descriptor.value, depth + 1), enumerable: true, writable: true, configurable: true });
    }
    seen.delete(item as object); return result;
  };
  try {
    const result = copy(value, 0);
    return Buffer.byteLength(JSON.stringify(result), 'utf8') <= maxBytes ? result : undefined;
  } catch { return undefined; }
}

function invalidResponse(message: string): never {
  throw new RpcError('NODE_EXECUTION_INVALID_RESPONSE', message);
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
  const source = sessionManager.getSessionCatalog(sourceSessionId);
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
    const source = sessionManager.getSessionCatalog(sourceSessionId);
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
      const filter = input.nodeId === undefined ? undefined : requireBoundedString(input.nodeId, 'nodeId', 128);
      if (input.currentNode !== undefined) requireBoundedString(input.currentNode, 'currentNode', 128);
      const isolated = sessionManager.isSessionEffectivelyIsolated(source);
      const allowed = isolated ? new Set([sessionManager.getAgentIsolationNode(source.agent || 'main') || source.currentNode || 'master', source.currentNode].filter(Boolean)) : null;
      const nodes = nodesManager.listNodesWithTools().filter(node => (!filter || node.id === filter) && (!allowed || allowed.has(node.id))).slice(0, 100);
      const activity = new Map(nodesManager.listNodes().map(node => [node.id, node.lastActivity]));
      const output: NodeTopologyListResponse['nodes'] = []; let totalBytes = Buffer.byteLength('{"nodes":[]}', 'utf8');
      for (const node of nodes) {
        if (typeof node.id !== 'string' || !node.id || node.id.length > 128 || typeof node.type !== 'string' || !node.type || node.type.length > 64) continue;
        const tools: NodeTopologyListResponse['nodes'][number]['tools'] = [];
        for (const tool of node.tools.slice(0, 200)) {
          const descriptors = Object.getOwnPropertyDescriptors(tool);
          const name = descriptors.name && 'value' in descriptors.name ? descriptors.name.value : undefined;
          if (typeof name !== 'string' || !name || name.length > 128) continue;
          const descriptionValue = descriptors.description && 'value' in descriptors.description ? descriptors.description.value : undefined;
          const description = typeof descriptionValue === 'string' ? descriptionValue.slice(0, 2000) : undefined;
          const parametersValue = descriptors.parameters && 'value' in descriptors.parameters ? descriptors.parameters.value : undefined;
          const parameters = parametersValue === undefined ? undefined : plainJsonWithin(parametersValue, 16 * 1024);
          tools.push({ name, ...(description ? { description } : {}), ...(parameters !== undefined ? { parameters } : {}) });
        }
        const lastActivity = activity.get(node.id);
        const candidate = { id: node.id, type: node.type,
          ...(typeof lastActivity === 'number' && Number.isFinite(lastActivity) && lastActivity >= 0 ? { lastActivity } : {}), tools };
        const size = Buffer.byteLength(JSON.stringify(candidate), 'utf8') + (output.length ? 1 : 0);
        if (totalBytes + size > 256 * 1024) break;
        totalBytes += size; output.push(candidate);
      }
      return { nodes: output };
    },
    async select(input) {
      const { sourceSessionId, source } = await requireSource(input, ['sourceSessionId', 'nodeId'], 'Node select request');
      const nodeId = requireBoundedString(input.nodeId, 'nodeId', 128);
      await requireNodeExecutionTarget(sourceSessionId, nodeId);
      nodesManager.setCurrentNode(sourceSessionId, nodeId);
      if (nodeId === 'master') return { nodeId, defaultCwd: getAgentDir(source.agent || 'main').slice(0, 4096) };
      const node = nodesManager.getNode(nodeId);
      if (node?.ws && node.tools.has('get_default_cwd')) {
        try {
          const value = await nodesManager.executeTool(nodeId, 'get_default_cwd', {}, sourceSessionId);
          const descriptor = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, 'output') : undefined;
          const raw = descriptor && 'value' in descriptor ? descriptor.value : value;
          const cwd = typeof raw === 'string' ? raw.trim().slice(0, 4096) : '';
          if (cwd) return { nodeId, defaultCwd: cwd };
        } catch { /* preserve the existing bounded fallback */ }
      }
      return { nodeId, defaultCwd: 'node process cwd (run `pwd` to inspect)' };
    },
    async copy(input) {
      const { sourceSessionId } = await requireSource(input,
        ['sourceSessionId', 'sourceNode', 'sourcePath', 'targetNode', 'targetPath', 'overwrite'], 'Node copy request');
      const sourceNode = requireBoundedString(input.sourceNode, 'sourceNode', 128); const sourcePath = requireBoundedPath(input.sourcePath, 'sourcePath');
      const targetNode = requireBoundedString(input.targetNode, 'targetNode', 128); const targetPath = requireBoundedPath(input.targetPath, 'targetPath');
      if (input.overwrite !== undefined && typeof input.overwrite !== 'boolean') throw new RpcError('NODE_EXECUTION_INVALID_REQUEST', 'overwrite must be a boolean.');
      await checkToolPermission('copy_between_nodes', sourceSessionId, 'master', { sourceNode, sourcePath, targetNode, targetPath, overwrite: input.overwrite === true });
      if (sourceNode !== 'master') await requireNodeExecutionTarget(sourceSessionId, sourceNode);
      if (targetNode !== 'master') await requireNodeExecutionTarget(sourceSessionId, targetNode);
      const file = await nodesManager.readFileFromNode(sourceNode, sourcePath, sourceSessionId);
      if (typeof file.dataBase64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.dataBase64)) {
        invalidResponse('Node copy source returned invalid base64 data.');
      }
      const decoded = Buffer.from(file.dataBase64, 'base64');
      if (decoded.toString('base64') !== file.dataBase64) invalidResponse('Node copy source returned non-canonical base64 data.');
      if (!Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0 || file.sizeBytes !== decoded.length) invalidResponse('Node copy source returned an invalid sizeBytes.');
      if (typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(file.sha256)
        || createHash('sha256').update(decoded).digest('hex').toLowerCase() !== file.sha256.toLowerCase()) {
        invalidResponse('Node copy source returned an invalid sha256.');
      }
      const written = await nodesManager.writeFileToNode(targetNode, targetPath, file.dataBase64, input.overwrite === true, sourceSessionId);
      if (typeof written.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(written.sha256)) invalidResponse('Node copy returned an invalid sha256.');
      if (typeof written.overwritten !== 'boolean') invalidResponse('Node copy returned an invalid overwritten flag.');
      if (written.absolutePath !== undefined && (typeof written.absolutePath !== 'string' || written.absolutePath.length > 4096)) invalidResponse('Node copy returned an invalid absolutePath.');
      return { sourceNode, sourcePath, targetNode, targetPath, sizeBytes: file.sizeBytes, sha256: written.sha256,
        overwritten: written.overwritten, ...(written.absolutePath ? { absolutePath: written.absolutePath } : {}) };
    },
  };
}
