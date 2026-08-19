import path from 'path';
import { getAgentDir, getAgentMemoryDir } from './config';
import { NODE_ENVIRONMENT_BUILTIN_NAMES } from './tools/placement';

export type ToolRuleEffect = 'allow' | 'deny';
export type ToolCapabilitySource = 'builtin' | 'node' | 'mcp';

export type AgentToolRule =
  | { effect: ToolRuleEffect; source: 'builtin'; tool: string }
  | { effect: ToolRuleEffect; source: 'node'; node: string; tool: string }
  | { effect: ToolRuleEffect; source: 'mcp'; server: string; tool: string };

export interface ResolvedToolPermissionIdentity {
  source: ToolCapabilitySource;
  tool: string;
  node?: string;
  server?: string;
}

export const MAX_AGENT_TOOL_RULES = 256;
export const MAX_AGENT_TOOL_RULE_IDENTITY_UTF8_BYTES = 128;

const MASTER_PATH_TOOLS = new Set(['send_file', 'image_write_to_file']);
const MASTER_MEMORY_PATH_TOOLS = new Set(['read_memory', 'write_memory', 'edit_memory', 'delete_memory']);
const MASTER_DEFAULT_BUILTINS = new Set([
  'apply_patch_memory', 'skill', 'image_crop', 'get_archived_messages', 'get_archived_blocks',
  'recall', 'session', 'send_to_session', 'wait', 'submit_compact_plan', 'search_tools', 'call_tool',
  'create_timer', 'list_timers', 'update_timer', 'delete_timer',
]);
const REMOTE_DEFAULT_BUILTINS = new Set(['send_file', 'image_write_to_file']);
const MASTER_DEFAULT_NODE_TOOLS = new Set(['read', 'write', 'edit', 'apply_patch']);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function exactString(value: unknown, field: string, index: number): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`toolRules[${index}].${field} must be a non-empty string.`);
  }
  const normalized = value.trim();
  if (Buffer.byteLength(normalized, 'utf8') > MAX_AGENT_TOOL_RULE_IDENTITY_UTF8_BYTES) {
    throw new Error(`toolRules[${index}].${field} must be at most ${MAX_AGENT_TOOL_RULE_IDENTITY_UTF8_BYTES} UTF-8 bytes.`);
  }
  if (normalized.includes('*')) {
    throw new Error(`toolRules[${index}].${field} must be exact and cannot contain wildcards.`);
  }
  return normalized;
}

function assertExactKeys(rule: Record<string, unknown>, keys: string[], index: number): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(rule)) {
    if (!allowed.has(key)) throw new Error(`toolRules[${index}] contains unsupported field \`${key}\`.`);
  }
  for (const key of keys) {
    if (!(key in rule)) throw new Error(`toolRules[${index}].${key} is required.`);
  }
}

export function toolRuleIdentity(rule: AgentToolRule | ResolvedToolPermissionIdentity): string {
  if (rule.source === 'builtin') return JSON.stringify(['builtin', rule.tool]);
  if (rule.source === 'node') return JSON.stringify(['node', rule.node || '', rule.tool]);
  return JSON.stringify(['mcp', rule.server || '', rule.tool]);
}

export function normalizeAgentToolRules(value: unknown): AgentToolRule[] {
  if (!Array.isArray(value)) throw new Error('toolRules must be an array.');
  if (value.length > MAX_AGENT_TOOL_RULES) {
    throw new Error(`toolRules must contain at most ${MAX_AGENT_TOOL_RULES} rules.`);
  }
  const seen = new Set<string>();
  return value.map((raw, index) => {
    if (!isPlainRecord(raw)) throw new Error(`toolRules[${index}] must be an object.`);
    const effect = raw.effect;
    if (effect !== 'allow' && effect !== 'deny') {
      throw new Error(`toolRules[${index}].effect must be \`allow\` or \`deny\`.`);
    }
    const source = raw.source;
    if (source !== 'builtin' && source !== 'node' && source !== 'mcp') {
      throw new Error(`toolRules[${index}].source must be \`builtin\`, \`node\`, or \`mcp\`.`);
    }
    let normalized: AgentToolRule;
    if (source === 'builtin') {
      assertExactKeys(raw, ['effect', 'source', 'tool'], index);
      normalized = { effect, source, tool: exactString(raw.tool, 'tool', index) };
    } else if (source === 'node') {
      assertExactKeys(raw, ['effect', 'source', 'node', 'tool'], index);
      normalized = {
        effect, source,
        node: exactString(raw.node, 'node', index),
        tool: exactString(raw.tool, 'tool', index),
      };
    } else {
      assertExactKeys(raw, ['effect', 'source', 'server', 'tool'], index);
      normalized = {
        effect, source,
        server: exactString(raw.server, 'server', index),
        tool: exactString(raw.tool, 'tool', index),
      };
    }
    const identity = toolRuleIdentity(normalized);
    if (seen.has(identity)) throw new Error(`toolRules contains duplicate or conflicting identity \`${identity}\`.`);
    seen.add(identity);
    return normalized;
  });
}

export function findExactAgentToolRule(rules: AgentToolRule[], identity: ResolvedToolPermissionIdentity): AgentToolRule | undefined {
  const requested = toolRuleIdentity(identity);
  return rules.find(rule => toolRuleIdentity(rule) === requested);
}

function resolveRequestedPath(value: unknown, agentName: string, memory = false): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const root = memory ? getAgentMemoryDir(agentName) : getAgentDir(agentName);
  let rawPath = value.trim();
  if (memory) rawPath = rawPath.replace(/^[\\/]+/, '').replace(/^memory[\\/]+/, '');
  return path.normalize(path.isAbsolute(rawPath) ? rawPath : path.resolve(root, rawPath));
}

function pathWithin(value: unknown, root: string, agentName: string, memory = false): boolean {
  const resolved = resolveRequestedPath(value, agentName, memory);
  const normalizedRoot = path.normalize(root);
  return !!resolved && (resolved === normalizedRoot || resolved.startsWith(normalizedRoot + path.sep));
}

export function isDefaultIsolatedCapabilityAllowed(
  identity: ResolvedToolPermissionIdentity,
  agentName: string,
  boundNode: string,
  currentNode: string | undefined,
  executionNode: string,
  args: Record<string, any> = {},
  discovery = false,
): boolean {
  const runtimeNodes = new Set([boundNode, currentNode].filter((value): value is string => !!value));
  if (identity.source === 'mcp') return false;

  if (identity.source === 'node') {
    const node = identity.node || executionNode;
    if (node === 'master') {
      if (identity.tool === 'exec') return false;
      if (!MASTER_DEFAULT_NODE_TOOLS.has(identity.tool)) return false;
      return discovery || pathWithin(args.filePath, getAgentDir(agentName), agentName);
    }
    return runtimeNodes.has(node) || !NODE_ENVIRONMENT_BUILTIN_NAMES.includes(identity.tool as any);
  }

  if (identity.tool === 'session') {
    const action = args.action;
    return discovery || action === undefined || action === null || action === '' || action === 'status';
  }
  if (MASTER_DEFAULT_BUILTINS.has(identity.tool)) return true;
  if (MASTER_PATH_TOOLS.has(identity.tool)) {
    if (executionNode !== 'master') return runtimeNodes.has(executionNode) && REMOTE_DEFAULT_BUILTINS.has(identity.tool);
    return discovery || pathWithin(args.filePath, getAgentDir(agentName), agentName);
  }
  if (MASTER_MEMORY_PATH_TOOLS.has(identity.tool)) {
    return discovery || pathWithin(args.filePath, getAgentMemoryDir(agentName), agentName, true);
  }
  return false;
}
