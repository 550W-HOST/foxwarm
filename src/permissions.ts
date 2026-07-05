import path from 'path';
import { getAgentDir, getAgentMemoryDir } from './config';

export type PermissionAction = 'accept' | 'reject';

export type PermissionArgMatcher =
  | string
  | number
  | boolean
  | {
      equals?: unknown;
      oneOf?: unknown[];
      pathWithinAgent?: boolean;
      pathWithinAgentMemory?: boolean;
    };

export interface PermissionRule {
  agent?: string;
  session?: string;
  target_node?: string;
  tool_name?: string;
  tool_args?: Record<string, PermissionArgMatcher>;
  action: PermissionAction;
  reason?: string;
}

export interface PermissionRequest {
  agent: string;
  session: string;
  target_node: string;
  tool_name: string;
  tool_args?: Record<string, any>;
}

function matchesScalar(expected: string | undefined, actual: string): boolean {
  return expected === undefined || expected === '*' || expected === actual;
}

function resolveRequestedPath(value: unknown, agentName: string, mode: 'agent' | 'memory' = 'agent'): string | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }

  const agentDir = mode === 'memory' ? getAgentMemoryDir(agentName) : getAgentDir(agentName);
  let rawPath = value.trim();
  if (mode === 'memory') {
    rawPath = rawPath.replace(/^[\\/]+/, '');
    rawPath = rawPath.replace(/^memory[\\/]+/, '');
  }
  return path.normalize(path.isAbsolute(rawPath) ? rawPath : path.resolve(agentDir, rawPath));
}

function isWithinAgentDir(resolvedPath: string, agentName: string): boolean {
  const agentDir = path.normalize(getAgentDir(agentName));
  return resolvedPath === agentDir || resolvedPath.startsWith(agentDir + path.sep);
}

function matchesArgMatcher(matcher: PermissionArgMatcher, actual: unknown, agentName: string): boolean {
  if (typeof matcher === 'string' || typeof matcher === 'number' || typeof matcher === 'boolean') {
    return actual === matcher;
  }

  if (matcher.equals !== undefined && actual !== matcher.equals) {
    return false;
  }

  if (matcher.oneOf && !matcher.oneOf.includes(actual)) {
    return false;
  }

  if (matcher.pathWithinAgent) {
    const resolvedPath = resolveRequestedPath(actual, agentName);
    if (!resolvedPath || !isWithinAgentDir(resolvedPath, agentName)) {
      return false;
    }
  }

  if (matcher.pathWithinAgentMemory) {
    const resolvedPath = resolveRequestedPath(actual, agentName, 'memory');
    const memoryDir = path.normalize(getAgentMemoryDir(agentName));
    if (!resolvedPath || !(resolvedPath === memoryDir || resolvedPath.startsWith(memoryDir + path.sep))) {
      return false;
    }
  }

  return true;
}

function buildScopedPathToolRule(agentName: string, sessionId: string, toolName: string, targetNode: string, argName = 'filePath', matcher: PermissionArgMatcher = { pathWithinAgent: true }): PermissionRule {
  return {
    agent: agentName,
    session: sessionId,
    target_node: targetNode,
    tool_name: toolName,
    tool_args: { [argName]: matcher },
    action: 'accept',
  };
}

function buildNodeToolRule(agentName: string, sessionId: string, toolName: string, targetNode: string): PermissionRule {
  return {
    agent: agentName,
    session: sessionId,
    target_node: targetNode,
    tool_name: toolName,
    action: 'accept',
  };
}

function matchesToolArgs(rule: PermissionRule, request: PermissionRequest): boolean {
  if (!rule.tool_args) {
    return true;
  }

  for (const [key, matcher] of Object.entries(rule.tool_args)) {
    if (!matchesArgMatcher(matcher, request.tool_args?.[key], request.agent)) {
      return false;
    }
  }

  return true;
}

export function findMatchingPermissionRule(rules: PermissionRule[], request: PermissionRequest): PermissionRule | undefined {
  return rules.find(rule => (
    matchesScalar(rule.agent, request.agent)
    && matchesScalar(rule.session, request.session)
    && matchesScalar(rule.target_node, request.target_node)
    && matchesScalar(rule.tool_name, request.tool_name)
    && matchesToolArgs(rule, request)
  ));
}

export function evaluatePermission(rules: PermissionRule[], request: PermissionRequest, defaultAction: PermissionAction = 'reject'): {
  action: PermissionAction;
  rule?: PermissionRule;
} {
  const rule = findMatchingPermissionRule(rules, request);
  return {
    action: rule?.action || defaultAction,
    rule,
  };
}

export function buildIsolatedToolRules(agentName: string, sessionId: string, boundNode: string, extraRuntimeNodes: string[] = []): PermissionRule[] {
  const allowedRuntimeNodes = Array.from(new Set([boundNode, ...extraRuntimeNodes].filter((value): value is string => typeof value === 'string' && value.length > 0)));
  const allowedCopyNodes = Array.from(new Set(['master', ...allowedRuntimeNodes]));
  return [
    buildScopedPathToolRule(agentName, sessionId, 'read', 'master'),
    buildScopedPathToolRule(agentName, sessionId, 'write', 'master'),
    buildScopedPathToolRule(agentName, sessionId, 'edit', 'master'),
    buildScopedPathToolRule(agentName, sessionId, 'apply_patch', 'master'),
    buildScopedPathToolRule(agentName, sessionId, 'send_file', 'master'),
    buildScopedPathToolRule(agentName, sessionId, 'image_write_to_file', 'master'),
    buildScopedPathToolRule(agentName, sessionId, 'read_memory', 'master', 'filePath', { pathWithinAgentMemory: true }),
    buildScopedPathToolRule(agentName, sessionId, 'write_memory', 'master', 'filePath', { pathWithinAgentMemory: true }),
    buildScopedPathToolRule(agentName, sessionId, 'edit_memory', 'master', 'filePath', { pathWithinAgentMemory: true }),
    buildScopedPathToolRule(agentName, sessionId, 'delete_memory', 'master', 'filePath', { pathWithinAgentMemory: true }),
    buildNodeToolRule(agentName, sessionId, 'apply_patch_memory', 'master'),
    buildNodeToolRule(agentName, sessionId, 'list_skills', 'master'),
    buildNodeToolRule(agentName, sessionId, 'load_skill', 'master'),
    ...allowedRuntimeNodes.flatMap(targetNode => [
      buildNodeToolRule(agentName, sessionId, 'read', targetNode),
      buildNodeToolRule(agentName, sessionId, 'write', targetNode),
      buildNodeToolRule(agentName, sessionId, 'edit', targetNode),
      buildNodeToolRule(agentName, sessionId, 'apply_patch', targetNode),
      buildNodeToolRule(agentName, sessionId, 'delete_file', targetNode),
      buildNodeToolRule(agentName, sessionId, 'browse_open', targetNode),
      buildNodeToolRule(agentName, sessionId, 'browse_list', targetNode),
      buildNodeToolRule(agentName, sessionId, 'browse_get', targetNode),
      buildNodeToolRule(agentName, sessionId, 'browse_close', targetNode),
      buildNodeToolRule(agentName, sessionId, 'browse_interact', targetNode),
      buildNodeToolRule(agentName, sessionId, 'exec', targetNode),
      buildNodeToolRule(agentName, sessionId, 'send_file', targetNode),
      buildNodeToolRule(agentName, sessionId, 'image_write_to_file', targetNode),
    ]),
    {
      agent: agentName,
      session: sessionId,
      target_node: 'master',
      tool_name: 'delete_file',
      tool_args: { filePath: { pathWithinAgent: true } },
      action: 'accept',
    },
    {
      agent: agentName,
      session: sessionId,
      target_node: 'master',
      tool_name: 'copy_between_nodes',
      tool_args: {
        sourceNode: { oneOf: allowedCopyNodes },
        targetNode: { oneOf: allowedCopyNodes },
      },
      action: 'accept',
    },
    {
      agent: agentName,
      session: sessionId,
      target_node: 'master',
      tool_name: 'image_crop',
      action: 'accept',
    },
    {
      agent: agentName,
      session: sessionId,
      target_node: 'master',
      tool_name: 'get_archived_messages',
      action: 'accept',
    },
    {
      agent: agentName,
      session: sessionId,
      target_node: 'master',
      tool_name: 'get_archived_blocks',
      action: 'accept',
    },
    {
      agent: agentName,
      session: sessionId,
      target_node: 'master',
      tool_name: 'recall',
      action: 'accept',
    },
    {
      agent: agentName,
      session: sessionId,
      target_node: 'master',
      tool_name: 'session',
      tool_args: { action: { oneOf: [undefined, null, '', 'status'] } },
      action: 'accept',
    },
    {
      agent: agentName,
      session: sessionId,
      target_node: 'master',
      tool_name: 'session',
      tool_args: { action: 'status' },
      action: 'accept',
    },
    {
      agent: agentName,
      session: sessionId,
      target_node: 'master',
      tool_name: 'send_to_session',
      action: 'accept',
    },
    {
      agent: agentName,
      session: sessionId,
      target_node: 'master',
      tool_name: 'wait',
      action: 'accept',
    },
    {
      agent: agentName,
      session: sessionId,
      target_node: 'master',
      tool_name: 'submit_compact_plan',
      action: 'accept',
    },
    {
      agent: agentName,
      session: sessionId,
      target_node: 'master',
      tool_name: 'remote_node',
      action: 'accept',
    },
    {
      agent: agentName,
      session: sessionId,
      target_node: 'master',
      tool_name: 'search_tools',
      action: 'accept',
    },
    {
      agent: agentName,
      session: sessionId,
      target_node: 'master',
      tool_name: 'call_tool',
      action: 'accept',
    },
    {
      agent: agentName,
      session: sessionId,
      target_node: '*',
      tool_name: '*',
      action: 'reject',
      reason: `Isolated agent sessions are restricted to agent-level allowed tools on master or their bound/current node (${allowedRuntimeNodes.join(', ') || boundNode}).`,
    },
  ];
}