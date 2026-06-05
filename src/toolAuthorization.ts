import fs from 'fs-extra';
import path from 'path';
import yaml from 'js-yaml';
import { getAgentDir, getAgentMemoryDir, STATE_DIR, WORKSPACE_DIR } from './config';
import { Session } from './types';
import { resolveAgentPath } from './utils/pathResolve';

const TOOL_AUTH_CONFIG_PATH = path.join(STATE_DIR, 'tool-authorization.yaml');

export type ToolAuthorizationSource = 'builtin' | 'mcp' | 'node';
export type ToolAuthorizationAction = 'allow' | 'deny';

export interface ToolAuthorizationRule {
  id: string;
  enabled?: boolean;
  match?: ToolAuthorizationRuleMatch;
  action: ToolAuthorizationAction | { effect?: ToolAuthorizationAction };
  reason?: string;
}

export interface ToolAuthorizationPolicy {
  version?: number;
  defaultAction?: ToolAuthorizationAction;
  rules?: ToolAuthorizationRule[];
}

export interface ToolAuthorizationRuleMatch {
  agent?: unknown;
  session?: unknown;
  tool?: unknown;
  targetNode?: unknown;
  args?: Record<string, unknown>;
  path?: unknown;
}

export interface ToolAuthorizationToolRef {
  source?: ToolAuthorizationSource;
  name: string;
}

export interface ToolAuthorizationPathRecord {
  arg: string;
  raw: string;
  resolved?: string;
  targetNode: string;
}

export interface ToolAuthorizationRequest {
  agent: string;
  session: string;
  tool: ToolAuthorizationToolRef;
  targetNode: string;
  args?: Record<string, any>;
  paths: ToolAuthorizationPathRecord[];
}

export interface BuildToolAuthorizationRequestOptions {
  session?: Pick<Session, 'id' | 'agent' | 'cwd'> | null;
  sessionId?: string;
  tool: ToolAuthorizationToolRef | string;
  targetNode?: string;
  args?: Record<string, any>;
}

export interface ToolAuthorizationEvaluation {
  action: ToolAuthorizationAction;
  matched: boolean;
  rule?: ToolAuthorizationRule;
}

const FILE_PATH_TOOL_NAMES = new Set([
  'read',
  'write',
  'edit',
  'delete_file',
  'send_file',
  'image_write_to_file',
]);

const MEMORY_FILE_TOOL_NAMES = new Set([
  'read_memory',
  'write_memory',
  'edit_memory',
  'delete_memory',
]);

let testPolicyOverride: ToolAuthorizationPolicy | null | undefined;

export function setToolAuthorizationPolicyForTests(policy: ToolAuthorizationPolicy | null | undefined): void {
  testPolicyOverride = policy;
}

function normalizeAction(action: ToolAuthorizationRule['action']): ToolAuthorizationAction {
  if (action === 'allow' || action === 'deny') {
    return action;
  }
  if (action && typeof action === 'object' && (action.effect === 'allow' || action.effect === 'deny')) {
    return action.effect;
  }
  throw new Error('Tool authorization rule action must be allow or deny.');
}

function normalizePolicyPayload(raw: any): ToolAuthorizationPolicy {
  if (!raw) {
    return { version: 1, defaultAction: 'allow', rules: [] };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Tool authorization config must be a YAML object.');
  }
  const defaultAction = raw.defaultAction === 'deny' ? 'deny' : 'allow';
  const rules = Array.isArray(raw.rules) ? raw.rules : [];
  return {
    version: typeof raw.version === 'number' ? raw.version : 1,
    defaultAction,
    rules: rules.map((rule: any, index: number) => {
      if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
        throw new Error(`Tool authorization rule #${index + 1} must be an object.`);
      }
      const id = typeof rule.id === 'string' && rule.id.trim()
        ? rule.id.trim()
        : `rule-${index + 1}`;
      return {
        id,
        enabled: rule.enabled !== false,
        match: rule.match && typeof rule.match === 'object' && !Array.isArray(rule.match) ? rule.match : {},
        action: normalizeAction(rule.action),
        reason: typeof rule.reason === 'string' ? rule.reason : undefined,
      };
    }),
  };
}

export async function loadToolAuthorizationPolicy(): Promise<ToolAuthorizationPolicy> {
  if (testPolicyOverride !== undefined) {
    return normalizePolicyPayload(testPolicyOverride);
  }

  if (!await fs.pathExists(TOOL_AUTH_CONFIG_PATH)) {
    return { version: 1, defaultAction: 'allow', rules: [] };
  }

  const rawText = await fs.readFile(TOOL_AUTH_CONFIG_PATH, 'utf8');
  const parsed = yaml.load(rawText);
  return normalizePolicyPayload(parsed);
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function scalarEquals(expected: unknown, actual: unknown): boolean {
  return actual === expected || String(actual) === String(expected);
}

function matchScalar(matcher: unknown, actual: unknown): boolean {
  if (matcher === undefined || matcher === null) {
    return true;
  }
  if (Array.isArray(matcher)) {
    return matcher.some(item => matchScalar(item, actual));
  }
  if (isPlainObject(matcher)) {
    if (Object.prototype.hasOwnProperty.call(matcher, 'exists')) {
      const exists = actual !== undefined && actual !== null;
      if (Boolean(matcher.exists) !== exists) return false;
    }
    if (Array.isArray(matcher.oneOf) && !matcher.oneOf.some(item => scalarEquals(item, actual))) {
      return false;
    }
    if (Array.isArray(matcher.notOneOf) && matcher.notOneOf.some(item => scalarEquals(item, actual))) {
      return false;
    }
    if (matcher.regex !== undefined) {
      if (actual === undefined || actual === null) return false;
      const regex = new RegExp(String(matcher.regex));
      if (!regex.test(String(actual))) return false;
    }
    if (Object.prototype.hasOwnProperty.call(matcher, 'equals') && !scalarEquals(matcher.equals, actual)) {
      return false;
    }
    return true;
  }
  return scalarEquals(matcher, actual);
}

function matchTool(matcher: unknown, tool: ToolAuthorizationToolRef): boolean {
  if (matcher === undefined || matcher === null) {
    return true;
  }
  if (typeof matcher === 'string' || Array.isArray(matcher)) {
    return matchScalar(matcher, tool.name);
  }
  if (!isPlainObject(matcher)) {
    return false;
  }
  if (!matchScalar(matcher.source, tool.source || 'builtin')) {
    return false;
  }
  if (!matchScalar(matcher.name, tool.name)) {
    return false;
  }
  return true;
}

function getValueByPath(input: Record<string, any> | undefined, dottedPath: string): unknown {
  if (!input || typeof dottedPath !== 'string' || dottedPath.length === 0) {
    return undefined;
  }
  const parts = dottedPath.split('.').filter(Boolean);
  let current: any = input;
  for (const part of parts) {
    if (current === undefined || current === null || typeof current !== 'object') {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

function matchArgs(matchers: Record<string, unknown> | undefined, args: Record<string, any> | undefined): boolean {
  if (!matchers) {
    return true;
  }
  for (const [key, matcher] of Object.entries(matchers)) {
    if (!matchScalar(matcher, getValueByPath(args, key))) {
      return false;
    }
  }
  return true;
}

function expandPathVariables(value: string, agentName: string): string {
  return value
    .replace(/\$\{agent\.dir\}/g, getAgentDir(agentName))
    .replace(/\$\{agent\.memoryDir\}/g, getAgentMemoryDir(agentName))
    .replace(/\$\{workspace\}/g, WORKSPACE_DIR);
}

function normalizeBasePath(value: unknown, agentName: string): string | undefined {
  if (typeof value !== 'string' || !value.trim()) {
    return undefined;
  }
  const expanded = expandPathVariables(value.trim(), agentName);
  return path.normalize(path.resolve(expanded));
}

function isWithinPath(candidate: string | undefined, base: string | undefined): boolean {
  if (!candidate || !base) {
    return false;
  }
  const normalizedCandidate = path.normalize(path.resolve(candidate));
  const normalizedBase = path.normalize(path.resolve(base));
  return normalizedCandidate === normalizedBase || normalizedCandidate.startsWith(normalizedBase + path.sep);
}

function resolveMemoryPath(rawPath: string, agentName: string): string {
  const memoryDir = getAgentMemoryDir(agentName);
  let normalized = rawPath.trim().replace(/^[\\/]+/, '');
  normalized = normalized.replace(/^memory[\\/]+/, '');
  return path.resolve(memoryDir, normalized);
}

function resolveToolPath(rawPath: string, args: { agentName: string; session?: Pick<Session, 'cwd'> | null; targetNode: string; memory?: boolean }): string | undefined {
  if (typeof rawPath !== 'string' || !rawPath.trim()) {
    return undefined;
  }
  if (args.memory) {
    return resolveMemoryPath(rawPath, args.agentName);
  }
  if (args.targetNode === 'master') {
    return resolveAgentPath(rawPath.trim(), args.agentName, args.session?.cwd);
  }
  if (path.isAbsolute(rawPath.trim())) {
    return path.normalize(path.resolve(rawPath.trim()));
  }
  return path.normalize(resolveAgentPath(rawPath.trim(), args.agentName, args.session?.cwd));
}

function extractPatchPaths(input: unknown): string[] {
  if (typeof input !== 'string') {
    return [];
  }
  const results: string[] = [];
  for (const line of input.split(/\r?\n/)) {
    const match = line.match(/^\*\*\*\s+(?:Add|Update|Delete) File:\s+(.+)\s*$/);
    if (match?.[1]) {
      results.push(match[1].trim());
    }
  }
  return results;
}

function pushPathRecord(records: ToolAuthorizationPathRecord[], options: {
  arg: string;
  raw: unknown;
  agentName: string;
  session?: Pick<Session, 'cwd'> | null;
  targetNode: string;
  memory?: boolean;
}) {
  if (typeof options.raw !== 'string' || !options.raw.trim()) {
    return;
  }
  records.push({
    arg: options.arg,
    raw: options.raw,
    resolved: resolveToolPath(options.raw, {
      agentName: options.agentName,
      session: options.session,
      targetNode: options.targetNode,
      memory: options.memory,
    }),
    targetNode: options.targetNode,
  });
}

export function extractToolAuthorizationPaths(options: {
  toolName: string;
  args?: Record<string, any>;
  agentName: string;
  session?: Pick<Session, 'cwd'> | null;
  targetNode: string;
}): ToolAuthorizationPathRecord[] {
  const records: ToolAuthorizationPathRecord[] = [];
  const toolName = options.toolName;
  const args = options.args || {};

  if (FILE_PATH_TOOL_NAMES.has(toolName)) {
    pushPathRecord(records, { ...options, arg: 'filePath', raw: args.filePath });
  }

  if (MEMORY_FILE_TOOL_NAMES.has(toolName)) {
    pushPathRecord(records, { ...options, arg: 'filePath', raw: args.filePath, memory: true });
  }

  if (toolName === 'exec') {
    pushPathRecord(records, { ...options, arg: 'cwd', raw: args.cwd });
  }

  if (toolName === 'copy_between_nodes') {
    pushPathRecord(records, { ...options, arg: 'sourcePath', raw: args.sourcePath, targetNode: typeof args.sourceNode === 'string' ? args.sourceNode : options.targetNode });
    pushPathRecord(records, { ...options, arg: 'targetPath', raw: args.targetPath, targetNode: typeof args.targetNode === 'string' ? args.targetNode : options.targetNode });
  }

  if (toolName === 'apply_patch') {
    for (const patchPath of extractPatchPaths(args.input)) {
      pushPathRecord(records, { ...options, arg: 'input', raw: patchPath });
    }
  }

  if (toolName === 'apply_patch_memory') {
    for (const patchPath of extractPatchPaths(args.input)) {
      pushPathRecord(records, { ...options, arg: 'input', raw: patchPath, memory: true });
    }
  }

  return records;
}

export function buildToolAuthorizationRequest(options: BuildToolAuthorizationRequestOptions): ToolAuthorizationRequest {
  const tool = typeof options.tool === 'string'
    ? { source: 'builtin' as const, name: options.tool }
    : { source: options.tool.source || 'builtin', name: options.tool.name };
  const sessionId = options.session?.id || options.sessionId || 'main';
  const agentName = options.session?.agent || sessionId.split('/')[0] || 'main';
  const targetNode = options.targetNode || 'master';
  const args = options.args || {};
  return {
    agent: agentName,
    session: sessionId,
    tool,
    targetNode,
    args,
    paths: extractToolAuthorizationPaths({
      toolName: tool.name,
      args,
      agentName,
      session: options.session,
      targetNode,
    }),
  };
}

function filterPathRecords(records: ToolAuthorizationPathRecord[], argMatcher: unknown): ToolAuthorizationPathRecord[] {
  if (argMatcher === undefined || argMatcher === null) {
    return records;
  }
  const args = Array.isArray(argMatcher) ? argMatcher.map(String) : [String(argMatcher)];
  return records.filter(record => args.includes(record.arg));
}

function matchPath(pathMatcher: unknown, request: ToolAuthorizationRequest): boolean {
  if (pathMatcher === undefined || pathMatcher === null) {
    return true;
  }
  if (!isPlainObject(pathMatcher)) {
    return false;
  }
  const records = filterPathRecords(request.paths, pathMatcher.arg);
  if (records.length === 0) {
    return false;
  }

  if (pathMatcher.allWithin !== undefined) {
    const base = normalizeBasePath(pathMatcher.allWithin, request.agent);
    if (!records.every(record => isWithinPath(record.resolved, base))) {
      return false;
    }
  }

  if (pathMatcher.anyNotWithin !== undefined) {
    const base = normalizeBasePath(pathMatcher.anyNotWithin, request.agent);
    if (!records.some(record => !isWithinPath(record.resolved, base))) {
      return false;
    }
  }

  return true;
}

function matchesRule(rule: ToolAuthorizationRule, request: ToolAuthorizationRequest): boolean {
  const match = rule.match || {};
  return matchScalar(match.agent, request.agent)
    && matchScalar(match.session, request.session)
    && matchTool(match.tool, request.tool)
    && matchScalar(match.targetNode, request.targetNode)
    && matchArgs(match.args, request.args)
    && matchPath(match.path, request);
}

export async function evaluateToolAuthorization(request: ToolAuthorizationRequest): Promise<ToolAuthorizationEvaluation> {
  const policy = await loadToolAuthorizationPolicy();
  const rules = Array.isArray(policy.rules) ? policy.rules : [];
  for (const rule of rules) {
    if (rule.enabled === false) {
      continue;
    }
    if (!matchesRule(rule, request)) {
      continue;
    }
    return {
      action: normalizeAction(rule.action),
      matched: true,
      rule,
    };
  }
  return {
    action: policy.defaultAction === 'deny' ? 'deny' : 'allow',
    matched: false,
  };
}

export function formatToolAuthorizationDeniedMessage(evaluation: ToolAuthorizationEvaluation): string {
  if (evaluation.rule) {
    const reason = evaluation.rule.reason ? `: ${evaluation.rule.reason}` : '';
    return `Tool authorization denied by rule ${evaluation.rule.id}${reason}`;
  }
  return 'Tool authorization denied by default policy';
}

export async function assertToolAuthorization(request: ToolAuthorizationRequest): Promise<ToolAuthorizationEvaluation> {
  const evaluation = await evaluateToolAuthorization(request);
  if (evaluation.action === 'deny') {
    throw new Error(formatToolAuthorizationDeniedMessage(evaluation));
  }
  return evaluation;
}
