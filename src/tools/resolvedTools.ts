import { resolveObjectArgWithJsonFallback } from '../jsonObjectArgs';
import * as mcpExternal from '../mcpExternalService';
import { executeRemoteNodeTool } from '../nodeExecution';
import { nodesManager } from '../nodes/manager';
import { checkToolPermission, checkToolPermissionForSession } from '../isolatedCheck';
import { isPermissionNeutralBuiltinDispatcher } from '../permissions';
import { NODE_ENVIRONMENT_BUILTIN_NAMES, resolveBuiltinToolPlacement } from './placement';
import type { ToolArgs, ToolContext, UnifiedToolSource } from './helpers';

export type ExecutionTarget =
  | { kind: 'master'; id: 'master' }
  | { kind: 'remote-node'; id: string }
  | { kind: 'sandbox'; id: string };

export type ResolvedTool = {
  invocationName: string;
  source: UnifiedToolSource;
  name: string;
  args: ToolArgs;
  executionNode: string;
  permissionNode: string;
  target?: ExecutionTarget;
  targetNode?: string;
  server?: string;
  localBuiltinName?: string;
  routingSnapshot?: { currentNode: string; cwd?: string };
};

type Runtime = {
  definitions: any[];
  dispatchBuiltin: (name: string, args: ToolArgs, ctx: ToolContext) => Promise<any>;
  guardBuiltin: (name: string, args: ToolArgs, ctx: ToolContext) => void;
};

let runtime: Runtime | undefined;
export function initializeResolvedToolRuntime(next: Runtime): void { runtime = next; }
function activeRuntime(): Runtime {
  if (!runtime) throw new Error('Resolved tool runtime is not initialized.');
  return runtime;
}

export function buildUnifiedToolId(source: UnifiedToolSource, name: string, options: { server?: string; nodeId?: string } = {}): string {
  if (source === 'builtin') return `builtin:${name}`;
  if (source === 'mcp') {
    if (!options.server) throw new Error('MCP tool IDs require server.');
    return `mcp:${options.server}/${name}`;
  }
  if (!options.nodeId) throw new Error('Node tool IDs require nodeId.');
  return `node:${options.nodeId}/${name}`;
}

function parseUnifiedToolId(toolId: string): { source: UnifiedToolSource; name: string; server?: string; nodeId?: string } {
  if (typeof toolId !== 'string' || !toolId.trim()) throw new Error('toolId is required');
  if (toolId.startsWith('builtin:')) {
    const name = toolId.slice(8).trim();
    if (!name) throw new Error(`Invalid builtin toolId: ${toolId}`);
    return { source: 'builtin', name };
  }
  for (const source of ['mcp', 'node'] as const) {
    const rest = toolId.slice(source.length + 1);
    if (!toolId.startsWith(`${source}:`) || !rest.includes('/')) continue;
    const split = rest.indexOf('/');
    if (split <= 0 || split === rest.length - 1) throw new Error(`Invalid ${source} toolId: ${toolId}`);
    return { source, name: rest.slice(split + 1), ...(source === 'mcp' ? { server: rest.slice(0, split) } : { nodeId: rest.slice(0, split) }) };
  }
  throw new Error(`Unsupported toolId source: ${toolId}`);
}

async function currentNode(ctx: ToolContext, snapshot?: { currentNode: string }): Promise<string> {
  if (snapshot?.currentNode) return snapshot.currentNode;
  if (typeof ctx.session?.currentNode === 'string' && ctx.session.currentNode.trim()) return ctx.session.currentNode.trim();
  if (ctx.session) return 'master';
  if (ctx.sessionPlacement === 'session-worker') return 'master';
  return ctx.sessionId ? await nodesManager.getCurrentNode(ctx.sessionId) || 'master' : 'master';
}

function normalizeNodeId(value: unknown, fallback: string): string {
  if (value === undefined || value === null) return fallback;
  const nodeId = String(value).trim();
  return !nodeId || nodeId.toLowerCase() === 'current' ? fallback : nodeId;
}

function nodeTarget(nodeId: string): ExecutionTarget {
  if (nodeId === 'master') return { kind: 'master', id: 'master' };
  if (nodeId.startsWith('sandbox:')) return { kind: 'sandbox', id: nodeId };
  return { kind: 'remote-node', id: nodeId };
}

function validatePlacement(resolved: ResolvedTool, ctx: ToolContext): ResolvedTool {
  const builtinName = resolved.source === 'node' ? resolved.localBuiltinName : resolved.name;
  if (builtinName) activeRuntime().guardBuiltin(builtinName, resolved.args,
    resolved.targetNode ? { ...ctx, runtimeNodeId: resolved.targetNode } : ctx);
  return resolved;
}

function resolveNode(invocationName: string, name: string, args: ToolArgs, ctx: ToolContext, nodeId: string, current: string): ResolvedTool {
  const target = nodeTarget(nodeId);
  if (target.kind === 'sandbox') throw new Error('Sandbox execution targets are not implemented.');
  const localBuiltinName = NODE_ENVIRONMENT_BUILTIN_NAMES.includes(name as any) ? name : undefined;
  if (target.kind === 'master' && !localBuiltinName) throw new Error(`Tool \`${name}\` not available on node \`master\``);
  const routingSnapshot = ctx.sessionPlacement === 'session-worker' && nodeId !== 'master' && nodeId === current
    ? { currentNode: current, ...(typeof ctx.session?.cwd === 'string' ? { cwd: ctx.session.cwd } : {}) }
    : undefined;
  return validatePlacement({ invocationName, source: 'node', name, args: { ...args }, executionNode: nodeId,
    permissionNode: nodeId, target, ...(localBuiltinName ? { localBuiltinName } : {}), ...(routingSnapshot ? { routingSnapshot } : {}) }, ctx);
}

function resolveMcp(invocationName: string, server: string | undefined, name: string, args: ToolArgs): ResolvedTool {
  if (!server) throw new Error('MCP calls require an explicit server.');
  return { invocationName, source: 'mcp', server, name, args: { ...args }, executionNode: 'master', permissionNode: 'master' };
}

function resolveBuiltin(invocationName: string, name: string, rawArgs: ToolArgs, ctx: ToolContext, current: string): ResolvedTool {
  if (isPermissionNeutralBuiltinDispatcher(name)) {
    throw new Error(`Tool \`${name}\` is a dispatcher/container, not a concrete builtin capability.`);
  }
  if (NODE_ENVIRONMENT_BUILTIN_NAMES.includes(name as any)) {
    throw new Error(`Tool \`${name}\` is a node capability, not a builtin. Use the direct \`${name}\` tool or call_tool with source=\`node\`.`);
  }
  const definition = activeRuntime().definitions.find(item => item.name === name);
  if (!definition) throw new Error(`Unknown builtin tool: ${name}`);
  const supportsNode = Object.prototype.hasOwnProperty.call(definition.parameters?.properties || {}, 'node');
  if (!supportsNode && Object.prototype.hasOwnProperty.call(rawArgs, 'node')) {
    throw new Error(`Builtin tool \`${name}\` does not support node selection. Use call_tool with source=\`node\` for node capabilities.`);
  }
  const targetNode = supportsNode ? normalizeNodeId(rawArgs.node, current) : current;
  const args = { ...rawArgs }; if (supportsNode) delete args.node;
  const placement = resolveBuiltinToolPlacement(name, args, targetNode);
  const permissionNode = name === 'send_file' || name === 'image_write_to_file' ? targetNode : placement.executionNode;
  return validatePlacement({ invocationName, source: 'builtin', name, args, executionNode: placement.executionNode,
    permissionNode, ...(supportsNode ? { targetNode } : {}) }, ctx);
}

export async function resolveUnifiedTool(input: ToolArgs, ctx: ToolContext, invocationName = 'call_tool'): Promise<ResolvedTool> {
  const ref = input.toolId ? parseUnifiedToolId(String(input.toolId)) : {
    source: typeof input.source === 'string' ? input.source.trim() as UnifiedToolSource : undefined,
    name: typeof input.name === 'string' ? input.name : '',
    server: typeof input.server === 'string' ? input.server : undefined,
    nodeId: typeof input.nodeId === 'string' ? input.nodeId : undefined,
  };
  if (!ref.source || !['builtin', 'mcp', 'node'].includes(ref.source)) throw new Error('call_tool requires either toolId or a valid source (builtin, mcp, node).');
  if (!ref.name) throw new Error('call_tool requires a tool name.');
  const args = resolveObjectArgWithJsonFallback(input, 'args', 'argsJson', { required: true, label: 'call_tool args' })!;
  const current = await currentNode(ctx);
  if (ref.source === 'node') return resolveNode(invocationName, ref.name, args, ctx, normalizeNodeId(ref.nodeId, current), current);
  if (ref.source === 'mcp') return resolveMcp(invocationName, ref.server, ref.name, args);
  return resolveBuiltin(invocationName, ref.name, args, ctx, current);
}

export async function resolveDirectTool(name: string, args: ToolArgs, ctx: ToolContext, snapshot?: { currentNode: string; cwd?: string }): Promise<ResolvedTool> {
  if (name === 'call_tool') return resolveUnifiedTool(args, ctx, name);
  const current = await currentNode(ctx, snapshot);
  if (NODE_ENVIRONMENT_BUILTIN_NAMES.includes(name as any)) {
    const resolved = resolveNode(name, name, args, ctx, current, current);
    if (snapshot) resolved.routingSnapshot = snapshot;
    return resolved;
  }
  return resolveBuiltin(name, name, args, ctx, current);
}

async function checkPermission(resolved: ResolvedTool, ctx: ToolContext): Promise<void> {
  if (resolved.source === 'mcp') return;
  if (!ctx.sessionId) throw new Error('Tool execution requires an active source session.');
  const identity = resolved.source === 'node'
    ? { source: 'node' as const, node: resolved.executionNode, tool: resolved.name }
    : { source: 'builtin' as const, tool: resolved.name };
  if (ctx.session?.id === ctx.sessionId) {
    await checkToolPermissionForSession(ctx.session, identity, resolved.permissionNode, resolved.args,
      ctx.sessionPlacement === 'session-worker');
  } else {
    await checkToolPermission(identity, ctx.sessionId, resolved.permissionNode, resolved.args);
  }
}

export async function executeResolvedTool(resolved: ResolvedTool, ctx: ToolContext): Promise<any> {
  if (!ctx.sessionId) throw new Error('Tool execution requires an active source session.');
  if (resolved.source === 'mcp') return mcpExternal.callMcpTool(ctx.sessionId, resolved.server, resolved.name, resolved.args);
  await checkPermission(resolved, ctx);
  if (resolved.source === 'node') {
    if (resolved.target?.kind === 'remote-node') {
      return executeRemoteNodeTool(ctx.sessionId, resolved.target.id, resolved.name, resolved.args, resolved.routingSnapshot);
    }
    return activeRuntime().dispatchBuiltin(resolved.localBuiltinName!, resolved.args, { ...ctx, runtimeNodeId: 'master' });
  }
  return activeRuntime().dispatchBuiltin(resolved.name, resolved.args,
    resolved.targetNode ? { ...ctx, runtimeNodeId: resolved.targetNode } : ctx);
}
