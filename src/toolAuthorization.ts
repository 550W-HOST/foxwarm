import fs from 'fs-extra';
import { promises as fsPromises } from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { getAgentDir, getAgentMemoryDir, STATE_DIR, WORKSPACE_DIR } from './config';
import type { Session } from './types';
import { canonicalPotentialPathSync, resolveAgentPath } from './utils/pathResolve';
import { RpcError } from './rpc';
import { resolveNodeTransferPath } from './nodeFileTransfer';
import { parseApplyPatchInput } from './applyPatch';

export const TOOL_AUTH_CONFIG_PATH = path.join(STATE_DIR, 'tool-authorization.yaml');
export const TOOL_AUTH_POLICY_UNAVAILABLE = 'TOOL_AUTH_POLICY_UNAVAILABLE';
const CACHE_MAX_AGE_MS = 10_000;
const RETRY_DELAY_MS = 100;
const MAX_POLICY_BYTES = 256 * 1024;
const MAX_RULES = 256;
const MAX_ID_BYTES = 128;
const MAX_REASON_BYTES = 1024;
const MAX_MATCHER_ITEMS = 64;
const MAX_MATCHER_STRING_BYTES = 512;

export type ToolAuthorizationSource = 'builtin' | 'mcp' | 'node';
export type ToolAuthorizationAction = 'allow' | 'deny';
type Scalar = string | number | boolean | null;
export type ScalarMatcher = Scalar | Scalar[] | { equals?: Scalar; oneOf?: Scalar[]; exists?: boolean };
export type SessionTargetRelation = 'parent' | 'child';
export type SessionTargetMatcher = { self?: true; sameAgent?: true; relation?: SessionTargetRelation | SessionTargetRelation[] };
export type ArgumentMatcher = ScalarMatcher | { session: SessionTargetMatcher };
export type ToolMatcher = string | string[] | {
  source?: ScalarMatcher;
  server?: ScalarMatcher;
  name?: ScalarMatcher;
};
export type PathMatcher = {
  arg?: string | string[];
  allWithin?: string;
  anyNotWithin?: string;
};
export interface ToolAuthorizationRuleMatch {
  agent?: ScalarMatcher;
  session?: ScalarMatcher;
  tool?: ToolMatcher;
  targetNode?: ScalarMatcher;
  args?: Record<string, ArgumentMatcher>;
  path?: PathMatcher;
}
export interface ToolAuthorizationRule {
  id: string;
  enabled: boolean;
  match: ToolAuthorizationRuleMatch;
  action: ToolAuthorizationAction;
  reason?: string;
}
export interface ToolAuthorizationPolicy {
  version: 1;
  defaultAction: ToolAuthorizationAction;
  rules: ToolAuthorizationRule[];
}
export interface ToolAuthorizationToolRef {
  source: ToolAuthorizationSource;
  name: string;
  server?: string;
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
  args: Record<string, any>;
  paths: ToolAuthorizationPathRecord[];
  sourceParentSessionId?: string;
  sessionTargets?: Record<string, ToolAuthorizationSessionTarget | undefined>;
}
export interface ToolAuthorizationSessionTarget {
  id: string;
  agent: string;
  parentSessionId?: string;
}
export interface ToolAuthorizationEvaluation {
  action: ToolAuthorizationAction;
  matched: boolean;
  rule?: ToolAuthorizationRule;
}

type CachedPolicy = { policy: ToolAuthorizationPolicy; loadedAtMs: number };
let cachedPolicy: CachedPolicy | undefined;
let testPolicyOverride: ToolAuthorizationPolicy | null | undefined;
let testNow: (() => number) | undefined;
let testDelay: ((ms: number) => Promise<void>) | undefined;
let testPolicyPath: string | undefined;
function policyPath(): string { return testPolicyPath || TOOL_AUTH_CONFIG_PATH; }

export class ToolAuthorizationPolicyUnavailableError extends RpcError {
  constructor(message = 'Tool authorization policy is unavailable after two read/parse attempts.') {
    super(TOOL_AUTH_POLICY_UNAVAILABLE, message, false, { toolAuthorizationPolicyUnavailable: true });
    this.name = 'ToolAuthorizationPolicyUnavailableError';
  }
}

export function isToolAuthorizationPolicyUnavailable(error: unknown): boolean {
  return !!error && typeof error === 'object'
    && (error as any).code === TOOL_AUTH_POLICY_UNAVAILABLE
    && (error as any).details?.toolAuthorizationPolicyUnavailable === true;
}

function defaultPolicy(): ToolAuthorizationPolicy {
  return { version: 1, defaultAction: 'allow', rules: [] };
}
function isPlainRecord(value: unknown): value is Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function assertExactFields(value: Record<string, any>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(value).find(key => !allowedSet.has(key));
  if (unexpected) throw new Error(`${label} contains unsupported field: ${unexpected}.`);
}
function boundedString(value: unknown, label: string, maxBytes = MAX_MATCHER_STRING_BYTES): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
  const normalized = value.trim();
  if (Buffer.byteLength(normalized, 'utf8') > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes.`);
  return normalized;
}
function isScalar(value: unknown): value is Scalar {
  return value === null || typeof value === 'string' || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value));
}
function normalizeScalar(value: unknown, label: string): Scalar {
  if (!isScalar(value)) throw new Error(`${label} must be a finite scalar.`);
  if (typeof value === 'string' && Buffer.byteLength(value, 'utf8') > MAX_MATCHER_STRING_BYTES) {
    throw new Error(`${label} exceeds ${MAX_MATCHER_STRING_BYTES} bytes.`);
  }
  return value;
}
function normalizeScalarList(value: unknown, label: string): Scalar[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_MATCHER_ITEMS) {
    throw new Error(`${label} must contain 1-${MAX_MATCHER_ITEMS} scalar values.`);
  }
  return value.map((item, index) => normalizeScalar(item, `${label}[${index}]`));
}
function normalizeScalarMatcher(value: unknown, label: string): ScalarMatcher {
  if (isScalar(value)) return normalizeScalar(value, label);
  if (Array.isArray(value)) return normalizeScalarList(value, label);
  if (!isPlainRecord(value)) throw new Error(`${label} must be a scalar, scalar array, or matcher object.`);
  assertExactFields(value, ['equals', 'oneOf', 'exists'], label);
  if (!Object.keys(value).length) throw new Error(`${label} matcher must not be empty.`);
  const result: { equals?: Scalar; oneOf?: Scalar[]; exists?: boolean } = {};
  if (Object.prototype.hasOwnProperty.call(value, 'equals')) result.equals = normalizeScalar(value.equals, `${label}.equals`);
  if (Object.prototype.hasOwnProperty.call(value, 'oneOf')) result.oneOf = normalizeScalarList(value.oneOf, `${label}.oneOf`);
  if (Object.prototype.hasOwnProperty.call(value, 'exists')) {
    if (typeof value.exists !== 'boolean') throw new Error(`${label}.exists must be boolean.`);
    result.exists = value.exists;
  }
  return result;
}
function normalizeArgumentMatcher(value: unknown, label: string): ArgumentMatcher {
  if (!isPlainRecord(value) || !Object.prototype.hasOwnProperty.call(value, 'session')) {
    return normalizeScalarMatcher(value, label);
  }
  assertExactFields(value, ['session'], label);
  if (!isPlainRecord(value.session)) throw new Error(`${label}.session must be an object.`);
  assertExactFields(value.session, ['self', 'sameAgent', 'relation'], `${label}.session`);
  if (!Object.keys(value.session).length) throw new Error(`${label}.session must not be empty.`);
  const result: SessionTargetMatcher = {};
  for (const key of ['self', 'sameAgent'] as const) {
    if (value.session[key] !== undefined) {
      if (value.session[key] !== true) throw new Error(`${label}.session.${key} must be true when present.`);
      result[key] = true;
    }
  }
  if (value.session.relation !== undefined) {
    const raw = Array.isArray(value.session.relation) ? value.session.relation : [value.session.relation];
    if (raw.length < 1 || raw.length > 2 || raw.some(item => item !== 'parent' && item !== 'child')) {
      throw new Error(`${label}.session.relation must be parent, child, or a non-empty list of those values.`);
    }
    if (new Set(raw).size !== raw.length) throw new Error(`${label}.session.relation must not contain duplicates.`);
    result.relation = Array.isArray(value.session.relation) ? raw as SessionTargetRelation[] : raw[0] as SessionTargetRelation;
  }
  return { session: result };
}

const SESSION_TARGET_RESOLVER_FAMILIES: Record<string, string> = {
  send_to_session: 'send-to-session', send_file: 'send-file',
  create_timer: 'timer', list_timers: 'timer', update_timer: 'timer', delete_timer: 'timer',
  recall: 'recall', get_archived_messages: 'archive', get_archived_blocks: 'archive',
  get_session_messages: 'required-session',
};
function exactToolNamesForSessionMatcher(tool: ToolMatcher | undefined, label: string): string[] {
  if (!tool || typeof tool === 'string') throw new Error(`${label} requires an exact builtin tool selector.`);
  if (Array.isArray(tool)) throw new Error(`${label} requires an exact builtin source selector.`);
  if (tool.server !== undefined || tool.source !== 'builtin') throw new Error(`${label} requires exact source builtin.`);
  const name = tool.name;
  const names = typeof name === 'string' ? [name] : Array.isArray(name) && name.every(item => typeof item === 'string') ? name as string[] : [];
  if (!names.length) throw new Error(`${label} requires an exact tool name or name list.`);
  const families = new Set(names.map(item => SESSION_TARGET_RESOLVER_FAMILIES[item]));
  if (families.has(undefined as any) || families.size !== 1) throw new Error(`${label} tool names must share one registered Session-target resolver.`);
  return names;
}
function normalizeToolMatcher(value: unknown, label: string): ToolMatcher {
  const explicitlyNames = (matcher: ScalarMatcher | undefined, expected: string): boolean => {
    if (matcher === undefined || matcher === null || typeof matcher === 'boolean' || typeof matcher === 'number') return false;
    if (typeof matcher === 'string') return matcher === expected;
    if (Array.isArray(matcher)) return matcher.includes(expected);
    return matcher.equals === expected || matcher.oneOf?.includes(expected) === true;
  };
  let normalized: ToolMatcher;
  if (typeof value === 'string') normalized = boundedString(value, label);
  else if (Array.isArray(value)) normalized = normalizeScalarList(value, label).map((item, index) => {
    if (typeof item !== 'string' || !item.trim()) throw new Error(`${label}[${index}] must be a non-empty string.`);
    return item.trim();
  });
  else {
    if (!isPlainRecord(value)) throw new Error(`${label} must be a tool name, name list, or selector object.`);
    assertExactFields(value, ['source', 'server', 'name'], label);
    if (!Object.keys(value).length) throw new Error(`${label} selector must not be empty.`);
    const selector: Exclude<ToolMatcher, string | string[]> = {};
    if (value.source !== undefined) {
      selector.source = normalizeScalarMatcher(value.source, `${label}.source`);
      const values = Array.isArray(selector.source)
        ? selector.source
        : isPlainRecord(selector.source)
          ? [selector.source.equals, ...(selector.source.oneOf || [])].filter(item => item !== undefined)
          : [selector.source];
      if (values.some(item => typeof item !== 'string' || !['builtin', 'mcp', 'node'].includes(item))) {
        throw new Error(`${label}.source values must be builtin, mcp, or node.`);
      }
    }
    if (value.server !== undefined) selector.server = normalizeScalarMatcher(value.server, `${label}.server`);
    if (value.name !== undefined) selector.name = normalizeScalarMatcher(value.name, `${label}.name`);
    normalized = selector;
  }
  const name = typeof normalized === 'string' || Array.isArray(normalized) ? normalized : normalized.name;
  if (explicitlyNames(name, 'update_session_snapshot')
    && matchesTool(normalized, { source: 'builtin', name: 'update_session_snapshot' })) {
    throw new Error(`${label} uses obsolete builtin \`update_session_snapshot\`; migrate it to \`refresh_session_snapshot\`.`);
  }
  return normalized;
}
function normalizePathMatcher(value: unknown, label: string): PathMatcher {
  if (!isPlainRecord(value)) throw new Error(`${label} must be an object.`);
  assertExactFields(value, ['arg', 'allWithin', 'anyNotWithin'], label);
  if (value.allWithin === undefined && value.anyNotWithin === undefined) {
    throw new Error(`${label} requires allWithin or anyNotWithin.`);
  }
  const result: PathMatcher = {};
  if (value.arg !== undefined) {
    if (typeof value.arg === 'string') result.arg = boundedString(value.arg, `${label}.arg`);
    else if (Array.isArray(value.arg)) result.arg = normalizeScalarList(value.arg, `${label}.arg`).map((item, index) => {
      if (typeof item !== 'string' || !item.trim()) throw new Error(`${label}.arg[${index}] must be a non-empty string.`);
      return item.trim();
    });
    else throw new Error(`${label}.arg must be a string or string array.`);
  }
  if (value.allWithin !== undefined) result.allWithin = boundedString(value.allWithin, `${label}.allWithin`);
  if (value.anyNotWithin !== undefined) result.anyNotWithin = boundedString(value.anyNotWithin, `${label}.anyNotWithin`);
  for (const pathValue of [result.allWithin, result.anyNotWithin]) {
    if (!pathValue) continue;
    const variables = pathValue.match(/\$\{[^}]+\}/g) || [];
    if (variables.some(variable => !['${agent.dir}', '${agent.memoryDir}', '${workspace}'].includes(variable))) {
      throw new Error(`${label} contains an unsupported path variable.`);
    }
  }
  return result;
}

export function parseToolAuthorizationPolicyBytes(bytes: Buffer | string): ToolAuthorizationPolicy {
  const size = typeof bytes === 'string' ? Buffer.byteLength(bytes, 'utf8') : bytes.byteLength;
  if (size > MAX_POLICY_BYTES) throw new Error(`Tool authorization policy exceeds ${MAX_POLICY_BYTES} bytes.`);
  const parsed = yaml.load(typeof bytes === 'string' ? bytes : bytes.toString('utf8'));
  if (!isPlainRecord(parsed)) throw new Error('Tool authorization policy must be a YAML object.');
  assertExactFields(parsed, ['version', 'defaultAction', 'rules'], 'Tool authorization policy');
  if (parsed.version !== 1) throw new Error('Tool authorization policy version must be 1.');
  const defaultAction = parsed.defaultAction === undefined ? 'allow' : parsed.defaultAction;
  if (defaultAction !== 'allow' && defaultAction !== 'deny') throw new Error('Tool authorization defaultAction must be allow or deny.');
  if (parsed.rules !== undefined && !Array.isArray(parsed.rules)) throw new Error('Tool authorization rules must be an array.');
  const rawRules = parsed.rules || [];
  if (rawRules.length > MAX_RULES) throw new Error(`Tool authorization policy exceeds ${MAX_RULES} rules.`);
  const seen = new Set<string>();
  const rules = rawRules.map((rawRule: unknown, index: number): ToolAuthorizationRule => {
    const label = `Tool authorization rule #${index + 1}`;
    if (!isPlainRecord(rawRule)) throw new Error(`${label} must be an object.`);
    assertExactFields(rawRule, ['id', 'enabled', 'match', 'action', 'reason'], label);
    const id = boundedString(rawRule.id, `${label}.id`, MAX_ID_BYTES);
    if (seen.has(id)) throw new Error(`Tool authorization rule id is duplicated: ${id}.`);
    seen.add(id);
    if (rawRule.enabled !== undefined && typeof rawRule.enabled !== 'boolean') throw new Error(`${label}.enabled must be boolean.`);
    if (rawRule.action !== 'allow' && rawRule.action !== 'deny') throw new Error(`${label}.action must be allow or deny.`);
    if (rawRule.reason !== undefined && typeof rawRule.reason !== 'string') throw new Error(`${label}.reason must be a string.`);
    if (typeof rawRule.reason === 'string' && Buffer.byteLength(rawRule.reason, 'utf8') > MAX_REASON_BYTES) {
      throw new Error(`${label}.reason exceeds ${MAX_REASON_BYTES} bytes.`);
    }
    const match: ToolAuthorizationRuleMatch = {};
    if (rawRule.match !== undefined) {
      if (!isPlainRecord(rawRule.match)) throw new Error(`${label}.match must be an object.`);
      assertExactFields(rawRule.match, ['agent', 'session', 'tool', 'targetNode', 'args', 'path'], `${label}.match`);
      if (rawRule.match.agent !== undefined) match.agent = normalizeScalarMatcher(rawRule.match.agent, `${label}.match.agent`);
      if (rawRule.match.session !== undefined) match.session = normalizeScalarMatcher(rawRule.match.session, `${label}.match.session`);
      if (rawRule.match.tool !== undefined) match.tool = normalizeToolMatcher(rawRule.match.tool, `${label}.match.tool`);
      if (rawRule.match.targetNode !== undefined) match.targetNode = normalizeScalarMatcher(rawRule.match.targetNode, `${label}.match.targetNode`);
      if (rawRule.match.args !== undefined) {
        if (!isPlainRecord(rawRule.match.args)) throw new Error(`${label}.match.args must be an object.`);
        const entries = Object.entries(rawRule.match.args);
        if (entries.length > MAX_MATCHER_ITEMS) throw new Error(`${label}.match.args exceeds ${MAX_MATCHER_ITEMS} entries.`);
        match.args = {};
        for (const [key, matcher] of entries) {
          if (!key || key.split('.').some(part => !part || ['__proto__', 'prototype', 'constructor'].includes(part))) {
            throw new Error(`${label}.match.args contains an unsafe dotted path.`);
          }
          match.args[key] = normalizeArgumentMatcher(matcher, `${label}.match.args.${key}`);
        }
        const sessionEntries = Object.entries(match.args).filter(([, matcher]) => isPlainRecord(matcher) && 'session' in matcher);
        if (sessionEntries.length) {
          if (sessionEntries.length !== 1 || sessionEntries[0][0] !== 'sessionId') {
            throw new Error(`${label}.match.args Session-target matcher is supported only for sessionId.`);
          }
          exactToolNamesForSessionMatcher(match.tool, `${label}.match.args.sessionId.session`);
        }
      }
      if (rawRule.match.path !== undefined) match.path = normalizePathMatcher(rawRule.match.path, `${label}.match.path`);
    }
    return { id, enabled: rawRule.enabled !== false, match, action: rawRule.action, ...(rawRule.reason ? { reason: rawRule.reason } : {}) };
  });
  return { version: 1, defaultAction, rules };
}

function cache(policy: ToolAuthorizationPolicy): ToolAuthorizationPolicy {
  cachedPolicy = { policy, loadedAtMs: (testNow || Date.now)() };
  return policy;
}
function cached(): ToolAuthorizationPolicy | undefined {
  if (!cachedPolicy) return undefined;
  return (testNow || Date.now)() - cachedPolicy.loadedAtMs < CACHE_MAX_AGE_MS ? cachedPolicy.policy : undefined;
}
async function sleep(ms: number): Promise<void> {
  if (testDelay) return testDelay(ms);
  await new Promise(resolve => setTimeout(resolve, ms));
}
function parseReadError(_error: any): never {
  throw new ToolAuthorizationPolicyUnavailableError('Tool authorization policy is unavailable after two read/parse attempts.');
}
async function readPolicyOnceAsync(): Promise<ToolAuthorizationPolicy> {
  try { return parseToolAuthorizationPolicyBytes(await fs.readFile(policyPath())); }
  catch (error: any) { if (error?.code === 'ENOENT') return defaultPolicy(); throw error; }
}
function readPolicyOnceSync(): ToolAuthorizationPolicy {
  try { return parseToolAuthorizationPolicyBytes(fs.readFileSync(policyPath())); }
  catch (error: any) { if (error?.code === 'ENOENT') return defaultPolicy(); throw error; }
}
export async function loadToolAuthorizationPolicy(): Promise<ToolAuthorizationPolicy> {
  if (testPolicyOverride !== undefined) return testPolicyOverride === null ? defaultPolicy() : testPolicyOverride;
  const hit = cached(); if (hit) return hit;
  try { return cache(await readPolicyOnceAsync()); }
  catch {
    await sleep(RETRY_DELAY_MS);
    try { return cache(await readPolicyOnceAsync()); }
    catch (error) { return parseReadError(error); }
  }
}
export function loadToolAuthorizationPolicySync(): ToolAuthorizationPolicy {
  if (testPolicyOverride !== undefined) return testPolicyOverride === null ? defaultPolicy() : testPolicyOverride;
  const hit = cached(); if (hit) return hit;
  try { return cache(readPolicyOnceSync()); }
  catch {
    try { return cache(readPolicyOnceSync()); }
    catch (error) { return parseReadError(error); }
  }
}
export function invalidateToolAuthorizationPolicyCache(): void { cachedPolicy = undefined; }
export function setToolAuthorizationPolicyForTests(policy: ToolAuthorizationPolicy | null | undefined): void {
  testPolicyOverride = policy; cachedPolicy = undefined;
}
export function setToolAuthorizationTestClockForTests(now?: () => number, delay?: (ms: number) => Promise<void>): void {
  testNow = now; testDelay = delay; cachedPolicy = undefined;
}
export function setToolAuthorizationPolicyPathForTests(filePath?: string): void {
  testPolicyPath = filePath; cachedPolicy = undefined;
}

function scalarEquals(expected: unknown, actual: unknown): boolean { return actual === expected; }
function matchesScalar(matcher: ScalarMatcher | undefined, actual: unknown): boolean {
  if (matcher === undefined) return true;
  if (Array.isArray(matcher)) return matcher.some(item => scalarEquals(item, actual));
  if (isPlainRecord(matcher)) {
    if (matcher.exists !== undefined && matcher.exists !== (actual !== undefined)) return false;
    if (matcher.equals !== undefined && !scalarEquals(matcher.equals, actual)) return false;
    if (matcher.oneOf !== undefined && !matcher.oneOf.some(item => scalarEquals(item, actual))) return false;
    return true;
  }
  return scalarEquals(matcher, actual);
}
function matchesTool(matcher: ToolMatcher | undefined, tool: ToolAuthorizationToolRef): boolean {
  if (matcher === undefined) return true;
  if (typeof matcher === 'string' || Array.isArray(matcher)) return matchesScalar(matcher, tool.name);
  return matchesScalar(matcher.source, tool.source)
    && matchesScalar(matcher.server, tool.server)
    && matchesScalar(matcher.name, tool.name);
}
function getValueByPath(input: Record<string, any>, dottedPath: string): unknown {
  let current: any = input;
  for (const part of dottedPath.split('.')) {
    if (!current || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, part)) return undefined;
    current = current[part];
  }
  return current;
}
function matchesSessionTarget(matcher: SessionTargetMatcher, source: ToolAuthorizationRequest, target: ToolAuthorizationSessionTarget | undefined): boolean {
  if (!target) return false;
  if (matcher.self && target.id !== source.session) return false;
  if (matcher.sameAgent && target.agent !== source.agent) return false;
  if (matcher.relation) {
    const relations = Array.isArray(matcher.relation) ? matcher.relation : [matcher.relation];
    const matched = relations.some(relation => relation === 'parent'
      ? target.id === source.sourceParentSessionId
      : target.parentSessionId === source.session);
    if (!matched) return false;
  }
  return true;
}
function matchesArgs(matchers: Record<string, ArgumentMatcher> | undefined, request: ToolAuthorizationRequest): boolean {
  return !matchers || Object.entries(matchers).every(([key, matcher]) => {
    if (isPlainRecord(matcher) && 'session' in matcher) {
      return matchesSessionTarget((matcher as { session: SessionTargetMatcher }).session, request, request.sessionTargets?.[key]);
    }
    return matchesScalar(matcher as ScalarMatcher, getValueByPath(request.args, key));
  });
}
function expandPathVariables(value: string, agentName: string): string {
  return value.replace(/\$\{agent\.dir\}/g, getAgentDir(agentName))
    .replace(/\$\{agent\.memoryDir\}/g, getAgentMemoryDir(agentName))
    .replace(/\$\{workspace\}/g, WORKSPACE_DIR);
}
function normalizeBasePath(value: string, agentName: string): string {
  return canonicalPotentialPathSync(expandPathVariables(value, agentName));
}
function isWithinPath(candidate: string | undefined, base: string): boolean {
  if (!candidate) return false;
  const normalized = path.normalize(path.resolve(candidate));
  return normalized === base || normalized.startsWith(base + path.sep);
}
function matchesPath(matcher: PathMatcher | undefined, request: ToolAuthorizationRequest): boolean {
  if (!matcher) return true;
  const args = matcher.arg === undefined ? undefined : (Array.isArray(matcher.arg) ? matcher.arg : [matcher.arg]);
  const records = args ? request.paths.filter(record => args.includes(record.arg)) : request.paths;
  if (!records.length) return false;
  if (matcher.allWithin !== undefined) {
    const base = normalizeBasePath(matcher.allWithin, request.agent);
    if (!records.every(record => record.targetNode === 'master' && isWithinPath(record.resolved, base))) return false;
  }
  if (matcher.anyNotWithin !== undefined) {
    const base = normalizeBasePath(matcher.anyNotWithin, request.agent);
    if (!records.some(record => record.targetNode !== 'master' || !isWithinPath(record.resolved, base))) return false;
  }
  return true;
}
function matchesRule(rule: ToolAuthorizationRule, request: ToolAuthorizationRequest): boolean {
  return matchesScalar(rule.match.agent, request.agent)
    && matchesScalar(rule.match.session, request.session)
    && matchesTool(rule.match.tool, request.tool)
    && matchesScalar(rule.match.targetNode, request.targetNode)
    && matchesArgs(rule.match.args, request)
    && matchesPath(rule.match.path, request);
}
function matchesRuleIdentity(rule: ToolAuthorizationRule, request: ToolAuthorizationRequest): boolean {
  return matchesScalar(rule.match.agent, request.agent)
    && matchesScalar(rule.match.session, request.session)
    && matchesTool(rule.match.tool, request.tool)
    && matchesScalar(rule.match.targetNode, request.targetNode);
}
export async function evaluateToolAuthorization(request: ToolAuthorizationRequest): Promise<ToolAuthorizationEvaluation> {
  return evaluateToolAuthorizationPolicy(await loadToolAuthorizationPolicy(), request);
}
export function evaluateToolAuthorizationSync(request: ToolAuthorizationRequest): ToolAuthorizationEvaluation {
  return evaluateToolAuthorizationPolicy(loadToolAuthorizationPolicySync(), request);
}
export function toolAuthorizationNeedsSessionTarget(policy: ToolAuthorizationPolicy, request: ToolAuthorizationRequest): boolean {
  return policy.rules.some(rule => rule.enabled && matchesRuleIdentity(rule, request)
    && !!rule.match.args && Object.values(rule.match.args).some(matcher => isPlainRecord(matcher) && 'session' in matcher));
}
export function isToolAuthorizationPotentiallyVisibleSync(request: ToolAuthorizationRequest): boolean {
  const policy = loadToolAuthorizationPolicySync();
  for (const rule of policy.rules) {
    if (!rule.enabled || !matchesRuleIdentity(rule, request)) continue;
    const conditional = rule.match.path !== undefined
      || (rule.match.args !== undefined && Object.keys(rule.match.args).length > 0);
    if (!conditional) return rule.action === 'allow';
    if (rule.action === 'allow') return true;
  }
  return policy.defaultAction === 'allow';
}
export function evaluateToolAuthorizationPolicy(policy: ToolAuthorizationPolicy, request: ToolAuthorizationRequest): ToolAuthorizationEvaluation {
  for (const rule of policy.rules) {
    if (!rule.enabled || !matchesRule(rule, request)) continue;
    return { action: rule.action, matched: true, rule };
  }
  return { action: policy.defaultAction, matched: false };
}

const NODE_FILE_PATH_TOOLS = new Set(['read', 'write', 'edit']);
const BUILTIN_FILE_PATH_TOOLS = new Set(['send_file', 'image_write_to_file', 'set_tool_rules']);
const MEMORY_PATH_TOOLS = new Set(['read_memory', 'write_memory', 'edit_memory', 'delete_memory']);
function resolveMemoryPath(raw: string, agentName: string): string {
  const normalized = raw.trim().replace(/^[\\/]+/, '').replace(/^memory[\\/]+/, '');
  return path.resolve(getAgentMemoryDir(agentName), normalized);
}
function addPath(records: ToolAuthorizationPathRecord[], options: {
  arg: string; raw: unknown; targetNode: string; agentName: string; session?: Pick<Session, 'cwd'> | null;
  memory?: boolean; resolveMasterPath?: (raw: string) => string;
}): void {
  if (typeof options.raw !== 'string' || !options.raw.trim()) return;
  const raw = options.raw.trim();
  records.push({
    arg: options.arg,
    raw,
    targetNode: options.targetNode,
    ...(options.targetNode === 'master' ? {
      resolved: canonicalPotentialPathSync(options.resolveMasterPath
        ? options.resolveMasterPath(raw)
        : options.memory ? resolveMemoryPath(raw, options.agentName) : resolveAgentPath(raw, options.agentName, options.session?.cwd)),
    } : {}),
  });
}
function extractPatchPaths(input: unknown): string[] {
  if (typeof input !== 'string') return [];
  return parseApplyPatchInput(input).map(operation => operation.filePath);
}
export function buildToolAuthorizationRequest(options: {
  session?: Pick<Session, 'id' | 'agent' | 'cwd'> | null;
  sessionId?: string;
  tool: ToolAuthorizationToolRef;
  targetNode?: string;
  args?: Record<string, any>;
}): ToolAuthorizationRequest {
  const sessionId = options.session?.id || options.sessionId || 'main';
  const agentName = options.session?.agent || sessionId.split('/')[0] || 'main';
  const targetNode = options.targetNode || 'master';
  const args = options.args || {};
  const paths: ToolAuthorizationPathRecord[] = [];
  if (options.tool.source === 'node' && NODE_FILE_PATH_TOOLS.has(options.tool.name)) {
    addPath(paths, { arg: 'filePath', raw: args.filePath, targetNode, agentName, session: options.session });
  }
  if (options.tool.source === 'builtin' && BUILTIN_FILE_PATH_TOOLS.has(options.tool.name)) {
    addPath(paths, { arg: 'filePath', raw: args.filePath, targetNode, agentName, session: options.session });
  }
  if (options.tool.source === 'builtin' && MEMORY_PATH_TOOLS.has(options.tool.name)) {
    addPath(paths, { arg: 'filePath', raw: args.filePath, targetNode: 'master', agentName, session: options.session, memory: true });
  }
  if (options.tool.source === 'node' && options.tool.name === 'exec') {
    addPath(paths, { arg: 'cwd', raw: args.cwd, targetNode, agentName, session: options.session });
  }
  if (options.tool.source === 'builtin' && options.tool.name === 'copy_between_nodes') {
    const transferResolver = (raw: string) => resolveNodeTransferPath(raw, agentName, false);
    addPath(paths, { arg: 'sourcePath', raw: args.sourcePath, targetNode: typeof args.sourceNode === 'string' ? args.sourceNode : targetNode, agentName, resolveMasterPath: transferResolver });
    addPath(paths, { arg: 'targetPath', raw: args.targetPath, targetNode: typeof args.targetNode === 'string' ? args.targetNode : targetNode, agentName, resolveMasterPath: transferResolver });
  }
  if ((options.tool.source === 'node' && options.tool.name === 'apply_patch')
    || (options.tool.source === 'builtin' && options.tool.name === 'apply_patch_memory')) {
    for (const patchPath of extractPatchPaths(args.input)) addPath(paths, {
      arg: 'input', raw: patchPath, targetNode: options.tool.name === 'apply_patch_memory' ? 'master' : targetNode,
      agentName, session: options.session, memory: options.tool.name === 'apply_patch_memory',
    });
  }
  return { agent: agentName, session: sessionId, tool: options.tool, targetNode, args, paths };
}

export async function installToolAuthorizationPolicyBytes(bytes: Buffer): Promise<void> {
  parseToolAuthorizationPolicyBytes(bytes);
  const destination = policyPath();
  await fs.ensureDir(path.dirname(destination));
  const tempPath = path.join(path.dirname(destination), `.${path.basename(destination)}.${process.pid}.${Date.now()}.tmp`);
  try {
    const handle = await fsPromises.open(tempPath, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(tempPath, destination);
    invalidateToolAuthorizationPolicyCache();
  } catch (error) {
    await fs.remove(tempPath).catch(() => {});
    throw error;
  }
}

export const TOOL_AUTH_POLICY_LIMITS = Object.freeze({ maxPolicyBytes: MAX_POLICY_BYTES, maxRules: MAX_RULES, cacheMaxAgeMs: CACHE_MAX_AGE_MS, retryDelayMs: RETRY_DELAY_MS });
