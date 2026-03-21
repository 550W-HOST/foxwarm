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

export function buildIsolatedToolRules(agentName: string, sessionId: string, boundNode: string): PermissionRule[] {
  return [
    buildScopedPathToolRule(agentName, sessionId, 'read', 'master'),
    buildScopedPathToolRule(agentName, sessionId, 'write', 'master'),
    buildScopedPathToolRule(agentName, sessionId, 'edit', 'master'),
    buildScopedPathToolRule(agentName, sessionId, 'apply_patch', 'master'),
    buildScopedPathToolRule(agentName, sessionId, 'send_file', 'master'),
    buildScopedPathToolRule(agentName, sessionId, 'read_memory', 'master', 'filePath', { pathWithinAgentMemory: true }),
    buildScopedPathToolRule(agentName, sessionId, 'write_memory', 'master', 'filePath', { pathWithinAgentMemory: true }),
    buildScopedPathToolRule(agentName, sessionId, 'edit_memory', 'master', 'filePath', { pathWithinAgentMemory: true }),
    buildScopedPathToolRule(agentName, sessionId, 'delete_memory', 'master', 'filePath', { pathWithinAgentMemory: true }),
    buildScopedPathToolRule(agentName, sessionId, 'read', boundNode),
    buildScopedPathToolRule(agentName, sessionId, 'write', boundNode),
    buildScopedPathToolRule(agentName, sessionId, 'edit', boundNode),
    buildScopedPathToolRule(agentName, sessionId, 'apply_patch', boundNode),
    {
      agent: agentName,
      session: sessionId,
      target_node: boundNode,
      tool_name: 'browse_open',
      action: 'accept',
    },
    {
      agent: agentName,
      session: sessionId,
      target_node: boundNode,
      tool_name: 'browse_list',
      action: 'accept',
    },
    {
      agent: agentName,
      session: sessionId,
      target_node: boundNode,
      tool_name: 'browse_get',
      action: 'accept',
    },
    {
      agent: agentName,
      session: sessionId,
      target_node: boundNode,
      tool_name: 'browse_close',
      action: 'accept',
    },
    {
      agent: agentName,
      session: sessionId,
      target_node: boundNode,
      tool_name: 'browse_interact',
      action: 'accept',
    },
    {
      agent: agentName,
      session: sessionId,
      target_node: 'master',
      tool_name: 'list_files',
      action: 'accept',
    },
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
        sourceNode: { oneOf: ['master', boundNode] },
        sourcePath: { pathWithinAgent: true },
        targetNode: { oneOf: ['master', boundNode] },
        targetPath: { pathWithinAgent: true },
      },
      action: 'accept',
    },
    {
      agent: agentName,
      session: sessionId,
      target_node: boundNode,
      tool_name: 'exec',
      action: 'accept',
    },
    {
      agent: agentName,
      session: sessionId,
      target_node: 'master',
      tool_name: 'search_memory',
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
      target_node: '*',
      tool_name: '*',
      action: 'reject',
      reason: `Isolated agent sessions are restricted to agent-level allowed tools on master or their bound node (${boundNode}).`,
    },
  ];
}