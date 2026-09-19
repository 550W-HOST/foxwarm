import { parseApplyPatchInput } from '../packages/shared/dist/applyPatch';
import type { ExternalNodeOwner } from '../packages/shared/dist/nodeProtocol';
import { requireVerifiedMcpInboundExternalId, type VerifiedMcpInboundPrincipal } from './mcpInboundConfig';
import type { ExternalExecutionContext } from './mcpInboundHttp';
import { nodeProviderRegistry } from './nodes/providers';
import { nodesManager } from './nodes/manager';
import {
  completeExternalExec, finishExternalExecForeground, getExternalExec, listExternalExec,
  markExternalExecUnknown, releaseExternalExecContext, reserveExternalExec,
} from './nodes/externalExecOwnership';
import { plainJsonWithin } from './nodeExecutionService';
import {
  buildExternalToolAuthorizationRequest,
  evaluateToolAuthorization,
  isToolAuthorizationPotentiallyVisibleSync,
  type ToolAuthorizationPathRecord,
} from './toolAuthorization';

const EXTERNAL_NODE_TOOLS = new Set(['read', 'write', 'edit', 'apply_patch', 'exec']);
const MAX_NODES = 100;
const MAX_TOOLS_PER_NODE = 200;

export class ExternalNodeBeforeEffectError extends Error {}

function owner(principal: VerifiedMcpInboundPrincipal, context: ExternalExecutionContext): ExternalNodeOwner {
  const externalId = requireVerifiedMcpInboundExternalId(principal);
  if (context.externalId !== externalId) throw new Error('External Node context owner mismatch.');
  return { kind: 'external', externalId, contextId: context.id };
}

function assertContextActive(context: ExternalExecutionContext): void {
  if (context.disposed) throw new ExternalNodeBeforeEffectError('External execution context is unavailable.');
}

function pathFacts(nodeId: string, name: string, args: Record<string, unknown>): ToolAuthorizationPathRecord[] {
  const records: ToolAuthorizationPathRecord[] = [];
  const add = (arg: string, value: unknown) => {
    if (typeof value === 'string' && value.length > 0) records.push({ arg, raw: value, targetNode: nodeId });
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
  assertContextActive(context);
  const result: Array<{ nodeId: string; name: string; description: string; inputSchema?: unknown }> = [];
  for (const node of (await nodeProviderRegistry.listNodes()).slice(0, MAX_NODES)) {
    assertContextActive(context);
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
  assertContextActive(context);
  if (!EXTERNAL_NODE_TOOLS.has(name)) throw new ExternalNodeBeforeEffectError('This Node capability is not available to external callers.');
  const authorization = buildExternalToolAuthorizationRequest({
    principal, sessionId: context.id, tool: { source: 'node', name }, targetNode: nodeId,
    args, paths: pathFacts(nodeId, name, args),
  });
  if ((await evaluateToolAuthorization(authorization)).action !== 'allow') throw new ExternalNodeBeforeEffectError('Node tool is not permitted.');
  assertContextActive(context);
  const selected = await nodeProviderRegistry.resolveNode(nodeId);
  assertContextActive(context);
  if (!selected || selected.descriptor.availability !== 'ready' || selected.descriptor.kind !== 'remote'
    || !nodesManager.supportsExternalOwner(nodeId) || !selected.descriptor.tools.some(item => item.name === name)) {
    throw new ExternalNodeBeforeEffectError('Node or Node capability is not available to external callers.');
  }
  const contextSnapshot = nodeId === context.currentNode && context.cwd ? { currentNode: nodeId, cwd: context.cwd } : {};
  const assertActive = () => assertContextActive(context);
  if (name !== 'exec') return nodeProviderRegistry.invokeTool({ owner: effectOwner, nodeId, toolName: name, args, context: contextSnapshot },
    { assertExternalOwnerActive: assertActive });
  const selectedGeneration = context.selectionGeneration;
  const startedOnCurrentNode = context.currentNode === nodeId;
  let record;
  try { record = reserveExternalExec(effectOwner, nodeId, args, cwd => {
    if (startedOnCurrentNode && context.currentNode === nodeId && context.selectionGeneration === selectedGeneration) context.cwd = cwd;
  }); } catch { throw new ExternalNodeBeforeEffectError('External command could not be reserved; no call was sent.'); }
  (context.externalExecNodes ??= new Set()).add(nodeId);
  try {
    const result = await nodeProviderRegistry.invokeTool({ owner: effectOwner, nodeId, toolName: name, args,
      context: { ...contextSnapshot, externalExec: { execId: record.execId, completionCapability: record.capability } },
    }, { assertExternalOwnerActive: assertActive });
    const response = result && typeof result === 'object' ? result as Record<string, unknown> : {};
    if (response.execId !== record.execId || typeof response.background !== 'boolean' || typeof response.output !== 'string') {
      markExternalExecUnknown(record);
      throw new Error('External Node exec outcome is unknown; do not retry automatically.');
    }
    if (response.background === false) {
      if (!completeExternalExec(nodeId, effectOwner, record.execId, record.capability, response.output,
        typeof response.cwd === 'string' ? response.cwd : undefined)) {
        markExternalExecUnknown(record);
        throw new Error('External Node exec output could not be retained; do not retry automatically.');
      }
    }
    return response;
  } catch (error: any) {
    if (error?.execStarted === false) finishExternalExecForeground(record);
    else markExternalExecUnknown(record);
    throw error;
  }
}

export async function externalExecResult(
  principal: VerifiedMcpInboundPrincipal, context: ExternalExecutionContext, execId?: string, limit = 5,
): Promise<unknown> {
  const effectOwner = owner(principal, context);
  assertContextActive(context);
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('Invalid execution list limit.');
  const records = execId === undefined ? listExternalExec(effectOwner, limit) : [getExternalExec(effectOwner, execId)].filter((item): item is NonNullable<typeof item> => !!item);
  if (execId !== undefined && records.length !== 1) throw new Error('Execution ID is unavailable in this context.');
  const allowed: typeof records = [];
  for (const record of records) {
    const request = buildExternalToolAuthorizationRequest({
      principal, sessionId: context.id, tool: { source: 'node', name: 'exec' }, targetNode: record.nodeId,
      args: record.args, paths: pathFacts(record.nodeId, 'exec', record.args),
    });
    if ((await evaluateToolAuthorization(request)).action === 'allow') allowed.push(record);
    assertContextActive(context);
  }
  if (execId === undefined) return { executions: allowed.map(record => ({ execId: record.execId, nodeId: record.nodeId, state: record.state })) };
  if (allowed.length !== 1) throw new Error('Execution result is not permitted.');
  const record = allowed[0];
  if (record.state === 'completed') return { execId, nodeId: record.nodeId, state: 'completed', output: record.output, cwd: record.cwd };
  try {
    const snapshot = await nodesManager.queryExternalExec(record.nodeId, effectOwner, record.execId);
    if (getExternalExec(effectOwner, record.execId) !== record) {
      return { execId, nodeId: record.nodeId, state: 'unavailable', output: null };
    }
    if (!snapshot || typeof snapshot !== 'object') throw new Error('Node result unavailable.');
    const answer = snapshot as Record<string, unknown>;
    if (!['running', 'completed'].includes(String(answer.state)) || typeof answer.output !== 'string'
      || Buffer.byteLength(answer.output) > 256 * 1024) throw new Error('Node returned an invalid or oversized execution result.');
    if (answer.state === 'completed') completeExternalExec(record.nodeId, effectOwner, record.execId, record.capability, answer.output,
      typeof answer.cwd === 'string' ? answer.cwd : undefined);
    return { execId, nodeId: record.nodeId, state: answer.state, output: answer.output,
      ...(typeof answer.cwd === 'string' && answer.cwd.length <= 4096 ? { cwd: answer.cwd } : {}) };
  } catch { return { execId, nodeId: record.nodeId, state: 'unavailable', output: null }; }
}

export function releaseExternalNodeContext(principal: VerifiedMcpInboundPrincipal, context: ExternalExecutionContext): void {
  const effectOwner = owner(principal, context);
  context.disposed = true;
  const nodes = new Set([...(context.externalExecNodes || []),
    ...listExternalExec(effectOwner, 20).map(record => record.nodeId)]);
  releaseExternalExecContext(effectOwner);
  context.externalExecNodes?.clear();
  for (const nodeId of nodes) nodesManager.releaseExternalOwner(nodeId, effectOwner);
}

export async function externalNodeAction(
  principal: VerifiedMcpInboundPrincipal, context: ExternalExecutionContext,
  action: 'list' | 'status' | 'select', nodeId?: string,
) {
  const effectOwner = owner(principal, context);
  assertContextActive(context);
  if (action !== 'select' && nodeId !== undefined) throw new Error(`Node ${action} does not accept nodeId.`);
  const selectedNodeId = action === 'select' && typeof nodeId === 'string' ? nodeId.trim() : undefined;
  if (action === 'select' && (!selectedNodeId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(selectedNodeId))) {
    throw new Error('Select requires an exact valid nodeId.');
  }
  const targetNode = action === 'select' ? selectedNodeId : action === 'status' ? context.currentNode : undefined;
  if ((await evaluateToolAuthorization(buildExternalToolAuthorizationRequest({
    principal, sessionId: context.id, tool: { source: 'builtin', name: 'node' }, targetNode,
    args: { action, ...(selectedNodeId === undefined ? {} : { nodeId: selectedNodeId }) },
  }))).action !== 'allow') throw new Error('Node action is not permitted.');
  assertContextActive(context);
  if (action === 'status') {
    const selected = await nodeProviderRegistry.resolveNode(context.currentNode);
    assertContextActive(context);
    return { currentNode: context.currentNode, cwd: context.cwd,
      available: !!selected && selected.descriptor.availability === 'ready' && nodesManager.supportsExternalOwner(context.currentNode) };
  }
  if (action === 'list') {
    const tools = await listExternalNodeTools(principal, context);
    const nodes = [...new Set(tools.map(tool => tool.nodeId))];
    return { currentNode: context.currentNode, nodes: nodes.slice(0, MAX_NODES) };
  }
  const selected = await nodeProviderRegistry.resolveNode(selectedNodeId!);
  assertContextActive(context);
  if (!selected || selected.descriptor.availability !== 'ready' || selected.descriptor.kind !== 'remote'
    || !nodesManager.supportsExternalOwner(selectedNodeId!) || !selected.descriptor.tools.some(tool =>
      EXTERNAL_NODE_TOOLS.has(tool.name) && isToolAuthorizationPotentiallyVisibleSync(buildExternalToolAuthorizationRequest({
        principal, sessionId: context.id, tool: { source: 'node', name: tool.name }, targetNode: selectedNodeId,
      })))) throw new Error('Node is not available to this external identity.');
  const result = await nodesManager.executeExternalTool(selectedNodeId!, 'get_default_cwd', {}, effectOwner,
    undefined, undefined, () => assertContextActive(context));
  assertContextActive(context);
  const raw = result && typeof result === 'object' && 'output' in result ? (result as { output?: unknown }).output : result;
  if (typeof raw !== 'string' || !raw || raw.length > 4096) throw new Error('Node did not return a valid default working directory.');
  if (context.currentNode !== selectedNodeId) {
    context.currentNode = selectedNodeId!;
    context.cwd = raw; // The selected Node supplied its own default; no previous Node cwd is reused.
    context.selectionGeneration++;
  }
  return { currentNode: selectedNodeId, cwd: context.cwd, defaultCwd: raw };
}
