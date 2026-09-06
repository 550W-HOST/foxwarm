import fs from 'fs-extra';
import { promises as fsPromises } from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { getAgentDir, getAgentMemoryDir, STATE_DIR, WORKSPACE_DIR } from './config';
import type { Session } from './types';
import { resolveAgentPath } from './utils/pathResolve';
import { RpcError } from './rpc';

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
  args?: Record<string, ScalarMatcher>;
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
function normalizeToolMatcher(value: unknown, label: string): ToolMatcher {
  if (typeof value === 'string') return boundedString(value, label);
  if (Array.isArray(value)) return normalizeScalarList(value, label).map((item, index) => {
    if (typeof item !== 'string' || !item.trim()) throw new Error(`${label}[${index}] must be a non-empty string.`);
    return item.trim();
  });
  if (!isPlainRecord(value)) throw new Error(`${label} must be a tool name, name list, or selector object.`);
  assertExactFields(value, ['source', 'server', 'name'], label);
  if (!Object.keys(value).length) throw new Error(`${label} selector must not be empty.`);
  const normalized: Exclude<ToolMatcher, string | string[]> = {};
  if (value.source !== undefined) {
    normalized.source = normalizeScalarMatcher(value.source, `${label}.source`);
    const values = Array.isArray(normalized.source)
      ? normalized.source
      : isPlainRecord(normalized.source)
        ? [normalized.source.equals, ...(normalized.source.oneOf || [])].filter(item => item !== undefined)
        : [normalized.source];
    if (values.some(item => typeof item !== 'string' || !['builtin', 'mcp', 'node'].includes(item))) {
      throw new Error(`${label}.source values must be builtin, mcp, or node.`);
    }
  }
  if (value.server !== undefined) normalized.server = normalizeScalarMatcher(value.server, `${label}.server`);
  if (value.name !== undefined) normalized.name = normalizeScalarMatcher(value.name, `${label}.name`);
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
          match.args[key] = normalizeScalarMatcher(matcher, `${label}.match.args.${key}`);
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
function matchesArgs(matchers: Record<string, ScalarMatcher> | undefined, args: Record<string, any>): boolean {
  return !matchers || Object.entries(matchers).every(([key, matcher]) => matchesScalar(matcher, getValueByPath(args, key)));
}
function expandPathVariables(value: string, agentName: string): string {
  return value.replace(/\$\{agent\.dir\}/g, getAgentDir(agentName))
    .replace(/\$\{agent\.memoryDir\}/g, getAgentMemoryDir(agentName))
    .replace(/\$\{workspace\}/g, WORKSPACE_DIR);
}
function normalizeBasePath(value: string, agentName: string): string {
  return path.normalize(path.resolve(expandPathVariables(value, agentName)));
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
    && matchesArgs(rule.match.args, request.args)
    && matchesPath(rule.match.path, request);
}
export async function evaluateToolAuthorization(request: ToolAuthorizationRequest): Promise<ToolAuthorizationEvaluation> {
  return evaluatePolicy(await loadToolAuthorizationPolicy(), request);
}
export function evaluateToolAuthorizationSync(request: ToolAuthorizationRequest): ToolAuthorizationEvaluation {
  return evaluatePolicy(loadToolAuthorizationPolicySync(), request);
}
function evaluatePolicy(policy: ToolAuthorizationPolicy, request: ToolAuthorizationRequest): ToolAuthorizationEvaluation {
  for (const rule of policy.rules) {
    if (!rule.enabled || !matchesRule(rule, request)) continue;
    return { action: rule.action, matched: true, rule };
  }
  return { action: policy.defaultAction, matched: false };
}

const FILE_PATH_TOOLS = new Set(['read', 'write', 'edit', 'send_file', 'image_write_to_file', 'set_tool_rules']);
const MEMORY_PATH_TOOLS = new Set(['read_memory', 'write_memory', 'edit_memory', 'delete_memory']);
function resolveMemoryPath(raw: string, agentName: string): string {
  const normalized = raw.trim().replace(/^[\\/]+/, '').replace(/^memory[\\/]+/, '');
  return path.resolve(getAgentMemoryDir(agentName), normalized);
}
function addPath(records: ToolAuthorizationPathRecord[], options: {
  arg: string; raw: unknown; targetNode: string; agentName: string; session?: Pick<Session, 'cwd'> | null; memory?: boolean;
}): void {
  if (typeof options.raw !== 'string' || !options.raw.trim()) return;
  const raw = options.raw.trim();
  records.push({
    arg: options.arg,
    raw,
    targetNode: options.targetNode,
    ...(options.targetNode === 'master' ? {
      resolved: options.memory ? resolveMemoryPath(raw, options.agentName) : resolveAgentPath(raw, options.agentName, options.session?.cwd),
    } : {}),
  });
}
function extractPatchPaths(input: unknown): string[] {
  if (typeof input !== 'string') return [];
  const paths: string[] = [];
  for (const line of input.split(/\r?\n/)) {
    const match = line.match(/^\*\*\*\s+(?:Add|Update|Delete) File:\s+(.+)\s*$/);
    if (match?.[1]) paths.push(match[1].trim());
  }
  return paths;
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
  if (FILE_PATH_TOOLS.has(options.tool.name)) addPath(paths, { arg: 'filePath', raw: args.filePath, targetNode, agentName, session: options.session });
  if (MEMORY_PATH_TOOLS.has(options.tool.name)) addPath(paths, { arg: 'filePath', raw: args.filePath, targetNode: 'master', agentName, session: options.session, memory: true });
  if (options.tool.name === 'exec') addPath(paths, { arg: 'cwd', raw: args.cwd, targetNode, agentName, session: options.session });
  if (options.tool.name === 'copy_between_nodes') {
    addPath(paths, { arg: 'sourcePath', raw: args.sourcePath, targetNode: typeof args.sourceNode === 'string' ? args.sourceNode : targetNode, agentName, session: options.session });
    addPath(paths, { arg: 'targetPath', raw: args.targetPath, targetNode: typeof args.targetNode === 'string' ? args.targetNode : targetNode, agentName, session: options.session });
  }
  if (options.tool.name === 'apply_patch' || options.tool.name === 'apply_patch_memory') {
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
