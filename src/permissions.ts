import path from 'path';
import { getAgentDir } from './config';

export type PermissionAction = 'accept' | 'reject';

export type PermissionArgMatcher =
  | string
  | number
  | boolean
  | {
      equals?: unknown;
      oneOf?: unknown[];
      pathWithinAgent?: boolean;
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

function resolveRequestedPath(value: unknown, agentName: string): string | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }

  const agentDir = getAgentDir(agentName);
  const rawPath = value.trim();
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

  return true;
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
  const pathToolRule = (toolName: string, targetNode: string): PermissionRule => ({
    agent: agentName,
    session: sessionId,
    target_node: targetNode,
    tool_name: toolName,
    tool_args: { filePath: { pathWithinAgent: true } },
    action: 'accept',
  });

  return [
    pathToolRule('read', 'master'),
    pathToolRule('write', 'master'),
    pathToolRule('edit', 'master'),
    pathToolRule('apply_patch', 'master'),
    pathToolRule('send_file', 'master'),
    pathToolRule('read', boundNode),
    pathToolRule('write', boundNode),
    pathToolRule('edit', boundNode),
    pathToolRule('apply_patch', boundNode),
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