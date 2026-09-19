import { parseApplyPatchInput } from '../packages/shared/dist/applyPatch';
import type { ExternalNodeOwner } from '../packages/shared/dist/nodeProtocol';
import { requireVerifiedMcpInboundExternalId, type VerifiedMcpInboundPrincipal } from './mcpInboundConfig';
import type { ExternalExecutionContext } from './mcpInboundHttp';
import { nodeProviderRegistry } from './nodes/providers';
import { nodesManager } from './nodes/manager';
import { plainJsonWithin } from './nodeExecutionService';
import {
  buildExternalToolAuthorizationRequest,
  evaluateToolAuthorization,
  isToolAuthorizationPotentiallyVisibleSync,
  type ToolAuthorizationPathRecord,
} from './toolAuthorization';

const EXTERNAL_NODE_TOOLS = new Set(['read', 'write', 'edit', 'apply_patch']);
const MAX_NODES = 100;
const MAX_TOOLS_PER_NODE = 200;

function owner(principal: VerifiedMcpInboundPrincipal, context: ExternalExecutionContext): ExternalNodeOwner {
  const externalId = requireVerifiedMcpInboundExternalId(principal);
  if (context.externalId !== externalId) throw new Error('External Node context owner mismatch.');
  return { kind: 'external', externalId, contextId: context.id };
}

function pathFacts(nodeId: string, name: string, args: Record<string, unknown>): ToolAuthorizationPathRecord[] {
  const records: ToolAuthorizationPathRecord[] = [];
  const add = (arg: string, value: unknown) => {
    if (typeof value === 'string' && value.trim()) records.push({ arg, raw: value.trim(), targetNode: nodeId });
  };
  if (['read', 'write', 'edit'].includes(name)) add('filePath', args.filePath);
  if (name === 'apply_patch' && typeof args.input === 'string') {
    for (const operation of parseApplyPatchInput(args.input)) add('input', operation.filePath);
  }
  if (name === 'exec') add('cwd', args.cwd);
  return records;
}

/** The Node registry is the only capability and target resolver; no Session-shaped Main RPC call occurs here. */
export async function listExternalNodeTools(principal: VerifiedMcpInboundPrincipal, context: ExternalExecutionContext) {
  owner(principal, context);
  const result: Array<{ nodeId: string; name: string; description: string; inputSchema?: unknown }> = [];
  for (const node of (await nodeProviderRegistry.listNodes()).slice(0, MAX_NODES)) {
    if (node.kind !== 'remote' || node.availability !== 'ready' || !nodesManager.supportsExternalOwner(node.id)) continue;
    for (const item of node.tools.slice(0, MAX_TOOLS_PER_NODE)) {
      const descriptors = Object.getOwnPropertyDescriptors(item);
      const name = descriptors.name && 'value' in descriptors.name ? descriptors.name.value : undefined;
      if (typeof name !== 'string' || !EXTERNAL_NODE_TOOLS.has(name)) continue;
      if (!isToolAuthorizationPotentiallyVisibleSync(buildExternalToolAuthorizationRequest({
        principal, sessionId: context.id, tool: { source: 'node', name }, targetNode: node.id,
      }))) continue;
      const rawDescription = descriptors.description && 'value' in descriptors.description ? descriptors.description.value : undefined;
      const rawSchema = descriptors.parameters && 'value' in descriptors.parameters ? descriptors.parameters.value : undefined;
      result.push({ nodeId: node.id, name,
        description: typeof rawDescription === 'string' ? rawDescription.slice(0, 2000) : '',
        ...(rawSchema === undefined ? {} : { inputSchema: plainJsonWithin(rawSchema, 16 * 1024) }),
      });
    }
  }
  return result;
}

export async function callExternalNodeTool(
  principal: VerifiedMcpInboundPrincipal, context: ExternalExecutionContext,
  nodeId: string, name: string, args: Record<string, unknown>,
): Promise<unknown> {
  const effectOwner = owner(principal, context);
  if (!EXTERNAL_NODE_TOOLS.has(name)) throw new Error('This Node capability is not available to external callers.');
  const authorization = buildExternalToolAuthorizationRequest({
    principal, sessionId: context.id, tool: { source: 'node', name }, targetNode: nodeId,
    args, paths: pathFacts(nodeId, name, args),
  });
  if ((await evaluateToolAuthorization(authorization)).action !== 'allow') throw new Error('Node tool is not permitted.');
  const selected = await nodeProviderRegistry.resolveNode(nodeId);
  if (!selected || selected.descriptor.availability !== 'ready' || selected.descriptor.kind !== 'remote'
    || !nodesManager.supportsExternalOwner(nodeId) || !selected.descriptor.tools.some(item => item.name === name)) {
    throw new Error('Node or Node capability is not available to external callers.');
  }
  return nodeProviderRegistry.invokeTool({ owner: effectOwner, nodeId, toolName: name, args,
    context: nodeId === context.currentNode && context.cwd ? { currentNode: nodeId, cwd: context.cwd } : {} });
}

export async function externalNodeAction(
  principal: VerifiedMcpInboundPrincipal, context: ExternalExecutionContext,
  action: 'list' | 'status' | 'select', nodeId?: string,
) {
  const effectOwner = owner(principal, context);
  if ((await evaluateToolAuthorization(buildExternalToolAuthorizationRequest({
    principal, sessionId: context.id, tool: { source: 'builtin', name: 'node' }, targetNode: 'master',
    args: { action, ...(nodeId === undefined ? {} : { nodeId }) },
  }))).action !== 'allow') throw new Error('Node action is not permitted.');
  if (action === 'status') {
    const selected = await nodeProviderRegistry.resolveNode(context.currentNode);
    return { currentNode: context.currentNode, cwd: context.cwd,
      available: !!selected && selected.descriptor.availability === 'ready' && nodesManager.supportsExternalOwner(context.currentNode) };
  }
  if (action === 'list') {
    const tools = await listExternalNodeTools(principal, context);
    const nodes = [...new Set(tools.map(tool => tool.nodeId))];
    return { currentNode: context.currentNode, nodes: nodes.slice(0, MAX_NODES) };
  }
  if (!nodeId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(nodeId)) throw new Error('Select requires an exact valid nodeId.');
  const selected = await nodeProviderRegistry.resolveNode(nodeId);
  if (!selected || selected.descriptor.availability !== 'ready' || selected.descriptor.kind !== 'remote'
    || !nodesManager.supportsExternalOwner(nodeId) || !selected.descriptor.tools.some(tool =>
      EXTERNAL_NODE_TOOLS.has(tool.name) && isToolAuthorizationPotentiallyVisibleSync(buildExternalToolAuthorizationRequest({
        principal, sessionId: context.id, tool: { source: 'node', name: tool.name }, targetNode: nodeId,
      })))) throw new Error('Node is not available to this external identity.');
  const result = await nodesManager.executeExternalTool(nodeId, 'get_default_cwd', {}, effectOwner);
  const raw = result && typeof result === 'object' && 'output' in result ? (result as { output?: unknown }).output : result;
  if (typeof raw !== 'string' || !raw || raw.length > 4096) throw new Error('Node did not return a valid default working directory.');
  if (context.currentNode !== nodeId) { context.currentNode = nodeId; context.cwd = null; }
  return { currentNode: nodeId, cwd: context.cwd, defaultCwd: raw };
}
