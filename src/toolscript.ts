import crypto from 'crypto';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { STATE_DIR, getAgentDir } from './config';
import { logger } from './common';
import * as llm from './llm';
import * as managedSessions from './managedSessions';
import * as sessionManager from './sessionManager';
import { checkPathAccess } from './isolatedCheck';
import type { Message, MessagePart, Session } from './types';

type ToolArgs = Record<string, any>;

type ToolContext = {
  sessionId?: string;
  session?: Session;
  broadcast?: (text: string, options?: any) => Promise<void>;
  runtimeNodeId?: string;
  toolScriptRunId?: string;
};

type ToolScriptRunMode = 'foreground' | 'background';
type ToolScriptRunStatus = 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
type ToolScriptWaitingReason = 'agent' | 'managed_event';

type ToolScriptManagedLeaseRef = {
  sessionId: string;
  leaseId: string;
  controllerRunId?: string;
};

type ToolScriptWaitingState = {
  reason: ToolScriptWaitingReason;
  waitingSince: number;
  continuationId?: string;
  question?: string;
  managedEvent?: {
    sessionId: string;
    leaseId: string;
    expectedRevision?: number;
    runMode?: 'idle' | 'tool';
    inboxOrder?: 'before' | 'after' | 'ignore';
  };
};

type ToolScriptRunRecord = {
  runId: string;
  mode: ToolScriptRunMode;
  status: ToolScriptRunStatus;
  ownerSessionId: string;
  agentName: string;
  filePath: string;
  scriptPath: string;
  scriptName: string;
  snapshotBase64?: string;
  stdout: string;
  executedTools: string[];
  waiting?: ToolScriptWaitingState;
  relatedManagedSessions?: ToolScriptManagedLeaseRef[];
  lastResult?: any;
  error?: string;
  createdAt: number;
  updatedAt: number;
  startedAt: number;
  completedAt?: number;
  cancelledAt?: number;
  lastWakeReason?: string;
  lastResumeAt?: number;
};

type ToolScriptResult = {
  status: ToolScriptRunStatus;
  runId: string;
  mode: ToolScriptRunMode;
  ownerSessionId: string;
  scriptPath: string;
  filePath: string;
  stdout: string;
  executedTools: string[];
  waitingReason?: ToolScriptWaitingReason;
  waitingFor?: any;
  continuationId?: string;
  question?: string;
  relatedManagedSessions?: ToolScriptManagedLeaseRef[];
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  cancelledAt?: number;
  result?: any;
  error?: string;
};

type RuntimeState = {
  stdoutParts: string[];
  executedTools: string[];
};

type MontyModule = {
  Monty: new (code: string, options?: Record<string, any>) => any;
  MontySnapshot: { load(data: Buffer, options?: Record<string, any>): any };
  MontyComplete: new (...args: any[]) => any;
  MontyNameLookup: new (...args: any[]) => any;
};

const TOOLSCRIPT_RUNS_DIR = path.join(STATE_DIR, 'toolscript-runs');
const METADATA_KEYS = new Set(['toolId', 'source', 'name', 'server', 'nodeId', 'args']);
const DEFAULT_SCRIPT_LIMITS = {
  maxAllocations: 200000,
  maxDurationSecs: 15,
  maxMemory: 64 * 1024 * 1024,
  maxRecursionDepth: 200,
};

let montyModulePromise: Promise<MontyModule> | null = null;
const activeBackgroundRuns = new Set<string>();

function nativeImport<T = any>(specifier: string): Promise<T> {
  return Function('s', 'return import(s)')(specifier) as Promise<T>;
}

function findMatchingCallParen(source: string, openParenIndex: number): number {
  let depth = 1;
  let inQuote: 'single' | 'double' | null = null;
  let escaped = false;

  for (let i = openParenIndex + 1; i < source.length; i += 1) {
    const ch = source[i];
    if (inQuote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if ((inQuote === 'single' && ch === '\'') || (inQuote === 'double' && ch === '"')) {
        inQuote = null;
      }
      continue;
    }

    if (ch === '\'') {
      inQuote = 'single';
      continue;
    }
    if (ch === '"') {
      inQuote = 'double';
      continue;
    }
    if (ch === '(') {
      depth += 1;
      continue;
    }
    if (ch === ')') {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }

  return -1;
}

function rewriteStepAndReleaseHelperCalls(code: string): string {
  const helperToken = 'step_and_release_managed_session(';
  let cursor = 0;
  let rewritten = '';
  let counter = 0;

  while (cursor < code.length) {
    const idx = code.indexOf(helperToken, cursor);
    if (idx === -1) {
      rewritten += code.slice(cursor);
      break;
    }

    const lineStart = code.lastIndexOf('\n', idx) + 1;
    const prefix = code.slice(lineStart, idx);
    const match = prefix.match(/^([ \t]*)([A-Za-z_][A-Za-z0-9_]*)\s*=\s*$/);
    if (!match) {
      rewritten += code.slice(cursor, idx + helperToken.length);
      cursor = idx + helperToken.length;
      continue;
    }

    const openParenIndex = idx + helperToken.length - 1;
    const closeParenIndex = findMatchingCallParen(code, openParenIndex);
    if (closeParenIndex === -1) {
      throw new Error('Unclosed step_and_release_managed_session(...) call.');
    }

    const lineEndIndex = code.indexOf('\n', closeParenIndex);
    const lineEnd = lineEndIndex === -1 ? code.length : lineEndIndex;
    const trailing = code.slice(closeParenIndex + 1, lineEnd);
    if (trailing.trim()) {
      rewritten += code.slice(cursor, idx + helperToken.length);
      cursor = idx + helperToken.length;
      continue;
    }

    const indent = match[1];
    const resultVar = match[2];
    const argsText = code.slice(openParenIndex + 1, closeParenIndex);
    const stepVar = `__toolscript_step_${counter}`;
    const releaseVar = `__toolscript_release_${counter}`;
    counter += 1;

    rewritten += code.slice(cursor, lineStart);
    rewritten += `${indent}${stepVar} = session_step(${argsText})\n`;
    rewritten += `${indent}${releaseVar} = release_managed_session(${stepVar}["sessionId"], ${stepVar}["leaseId"], ${stepVar}["revision"])\n`;
    rewritten += `${indent}${stepVar}["releasedPendingInboxCount"] = ${releaseVar}["releasedPendingInboxCount"]\n`;
    rewritten += `${indent}${resultVar} = ${stepVar}`;
    if (lineEndIndex !== -1) {
      rewritten += '\n';
    }
    cursor = lineEndIndex === -1 ? code.length : lineEndIndex + 1;
  }

  return rewritten;
}

function buildToolScriptSource(code: string): string {
  return rewriteStepAndReleaseHelperCalls(code);
}

async function importMonty(): Promise<MontyModule> {
  if (!montyModulePromise) {
    montyModulePromise = nativeImport<MontyModule>('@pydantic/monty');
  }
  return await montyModulePromise;
}

function expandHomePath(filePath: string): string {
  if (filePath === '~') {
    return os.homedir();
  }
  if (filePath.startsWith('~/') || filePath.startsWith('~\\')) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}

function resolveAgentPath(filePath: string, agentName: string, sessionCwd?: string): string {
  const expandedPath = expandHomePath(filePath);
  if (path.isAbsolute(expandedPath)) {
    return path.resolve(expandedPath);
  }

  const agentDir = getAgentDir(agentName);
  const baseDir = (typeof sessionCwd === 'string' && sessionCwd.trim().length > 0)
    ? expandHomePath(sessionCwd.trim())
    : agentDir;

  return path.resolve(baseDir, expandedPath);
}

function runFilePath(runId: string): string {
  return path.join(TOOLSCRIPT_RUNS_DIR, `${runId}.json`);
}

async function saveRun(record: ToolScriptRunRecord): Promise<void> {
  await fs.ensureDir(TOOLSCRIPT_RUNS_DIR);
  const filePath = runFilePath(record.runId);
  const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.writeJson(tempPath, record, { spaces: 2 });
  await fs.rename(tempPath, filePath);
}

async function loadRun(runId: string): Promise<ToolScriptRunRecord | null> {
  const filePath = runFilePath(runId);
  try {
    return await fs.readJson(filePath);
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function listRuns(): Promise<ToolScriptRunRecord[]> {
  try {
    const entries = await fs.readdir(TOOLSCRIPT_RUNS_DIR);
    const records = await Promise.all(entries
      .filter(name => name.endsWith('.json'))
      .map(async (name) => {
        try {
          return await fs.readJson(path.join(TOOLSCRIPT_RUNS_DIR, name)) as ToolScriptRunRecord;
        } catch {
          return null;
        }
      }));
    return records.filter((record): record is ToolScriptRunRecord => !!record)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

function newRunId(): string {
  return `tsr_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

function newContinuationId(): string {
  return `cont_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
}

function normalizeMontyValue(value: any): any {
  if (value instanceof Map) {
    const normalized: Record<string, any> = {};
    for (const [key, entry] of value.entries()) {
      normalized[String(key)] = normalizeMontyValue(entry);
    }
    return normalized;
  }

  if (Array.isArray(value)) {
    return value.map(item => normalizeMontyValue(item));
  }

  if (value instanceof Set) {
    return Array.from(value.values()).map(item => normalizeMontyValue(item));
  }

  if (Buffer.isBuffer(value)) {
    return value.toString('base64');
  }

  if (value && typeof value === 'object') {
    const normalized: Record<string, any> = {};
    for (const [key, entry] of Object.entries(value)) {
      normalized[key] = normalizeMontyValue(entry);
    }
    return normalized;
  }

  return value;
}

function isPlainObject(value: any): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Map) && !(value instanceof Set) && !Buffer.isBuffer(value);
}

function extractToolNameFromToolId(toolId: string | undefined): string | undefined {
  if (!toolId || typeof toolId !== 'string') {
    return undefined;
  }
  const nodeMatch = toolId.match(/^node:[^/]+\/(.+)$/);
  if (nodeMatch) {
    return nodeMatch[1];
  }
  const mcpMatch = toolId.match(/^mcp:[^/]+\/(.+)$/);
  if (mcpMatch) {
    return mcpMatch[1];
  }
  const builtinMatch = toolId.match(/^builtin:(.+)$/);
  if (builtinMatch) {
    return builtinMatch[1];
  }
  return toolId;
}

function buildToolSummaryName(wrapperArgs: Record<string, any>): string {
  return String(wrapperArgs.name || extractToolNameFromToolId(wrapperArgs.toolId) || 'unknown');
}

function splitMetadataAndToolArgs(input: Record<string, any>): { metadata: Record<string, any>; toolArgs: Record<string, any> } {
  const metadata: Record<string, any> = {};
  const toolArgs: Record<string, any> = {};
  for (const [key, value] of Object.entries(input || {})) {
    if (METADATA_KEYS.has(key)) {
      metadata[key] = value;
    } else {
      toolArgs[key] = value;
    }
  }
  return { metadata, toolArgs };
}

function buildCallToolWrapperArgs(positionalArgs: any[], kwargs: Record<string, any>): Record<string, any> {
  const normalizedPositionals = positionalArgs.map(item => normalizeMontyValue(item));
  const normalizedKwargs = normalizeMontyValue(kwargs || {}) || {};

  if (normalizedPositionals.length === 0 && !normalizedKwargs.toolId && !normalizedKwargs.name) {
    throw new Error('call_tool requires either a tool name or a tool descriptor object.');
  }

  const first = normalizedPositionals[0];

  if (typeof first === 'string') {
    if (normalizedPositionals.length > 2) {
      throw new Error('call_tool supports at most two positional arguments: tool name and args object.');
    }

    const positionalToolArgs = normalizedPositionals.length >= 2 && normalizedPositionals[1] !== undefined
      ? normalizeMontyValue(normalizedPositionals[1])
      : {};
    if (positionalToolArgs !== undefined && !isPlainObject(positionalToolArgs)) {
      throw new Error('call_tool positional args object must be a mapping/object.');
    }

    const { metadata, toolArgs } = splitMetadataAndToolArgs(normalizedKwargs);
    const explicitArgs = metadata.args;
    if (explicitArgs !== undefined && !isPlainObject(explicitArgs)) {
      throw new Error('call_tool args must be an object.');
    }

    return {
      source: metadata.source || 'builtin',
      name: first,
      ...(metadata.toolId !== undefined ? { toolId: metadata.toolId } : {}),
      ...(metadata.server !== undefined ? { server: metadata.server } : {}),
      ...(metadata.nodeId !== undefined ? { nodeId: metadata.nodeId } : {}),
      args: {
        ...(isPlainObject(positionalToolArgs) ? positionalToolArgs : {}),
        ...(isPlainObject(explicitArgs) ? explicitArgs : {}),
        ...toolArgs,
      },
    };
  }

  if (isPlainObject(first)) {
    const descriptor = first;
    const { metadata, toolArgs } = splitMetadataAndToolArgs(descriptor);
    const { metadata: kwMetadata, toolArgs: kwToolArgs } = splitMetadataAndToolArgs(normalizedKwargs);
    const explicitArgs = kwMetadata.args !== undefined ? kwMetadata.args : metadata.args;
    if (explicitArgs !== undefined && !isPlainObject(explicitArgs)) {
      throw new Error('call_tool args must be an object.');
    }

    return {
      ...(metadata.toolId !== undefined ? { toolId: metadata.toolId } : {}),
      ...(kwMetadata.toolId !== undefined ? { toolId: kwMetadata.toolId } : {}),
      ...(metadata.source !== undefined ? { source: metadata.source } : {}),
      ...(kwMetadata.source !== undefined ? { source: kwMetadata.source } : {}),
      ...(metadata.name !== undefined ? { name: metadata.name } : {}),
      ...(kwMetadata.name !== undefined ? { name: kwMetadata.name } : {}),
      ...(metadata.server !== undefined ? { server: metadata.server } : {}),
      ...(kwMetadata.server !== undefined ? { server: kwMetadata.server } : {}),
      ...(metadata.nodeId !== undefined ? { nodeId: metadata.nodeId } : {}),
      ...(kwMetadata.nodeId !== undefined ? { nodeId: kwMetadata.nodeId } : {}),
      args: {
        ...toolArgs,
        ...(isPlainObject(explicitArgs) ? explicitArgs : {}),
        ...kwToolArgs,
      },
    };
  }

  if (!first) {
    const { metadata, toolArgs } = splitMetadataAndToolArgs(normalizedKwargs);
    const explicitArgs = metadata.args;
    if (explicitArgs !== undefined && !isPlainObject(explicitArgs)) {
      throw new Error('call_tool args must be an object.');
    }
    return {
      ...(metadata.toolId !== undefined ? { toolId: metadata.toolId } : {}),
      ...(metadata.source !== undefined ? { source: metadata.source } : {}),
      ...(metadata.name !== undefined ? { name: metadata.name } : {}),
      ...(metadata.server !== undefined ? { server: metadata.server } : {}),
      ...(metadata.nodeId !== undefined ? { nodeId: metadata.nodeId } : {}),
      args: {
        ...(isPlainObject(explicitArgs) ? explicitArgs : {}),
        ...toolArgs,
      },
    };
  }

  throw new Error('call_tool first positional argument must be a tool name string or a descriptor object.');
}

function formatQuestion(value: any): string {
  const normalized = normalizeMontyValue(value);
  if (typeof normalized === 'string') {
    return normalized;
  }
  return JSON.stringify(normalized);
}

function createRuntimeState(stdout: string, executedTools: string[]): RuntimeState {
  return {
    stdoutParts: stdout ? [stdout] : [],
    executedTools: [...executedTools],
  };
}

function currentStdout(state: RuntimeState): string {
  return state.stdoutParts.join('');
}

function printCallbackFor(state: RuntimeState) {
  return (_stream: string, text: string) => {
    state.stdoutParts.push(text);
  };
}

function buildWaitingFor(run: ToolScriptRunRecord): any {
  if (!run.waiting) {
    return undefined;
  }
  if (run.waiting.reason === 'agent') {
    return {
      continuationId: run.waiting.continuationId,
      question: run.waiting.question,
    };
  }
  if (run.waiting.reason === 'managed_event') {
    return run.waiting.managedEvent;
  }
  return undefined;
}

function buildBaseResult(run: ToolScriptRunRecord): ToolScriptResult {
  return {
    status: run.status,
    runId: run.runId,
    mode: run.mode,
    ownerSessionId: run.ownerSessionId,
    scriptPath: run.scriptPath,
    filePath: run.filePath,
    stdout: run.stdout,
    executedTools: [...run.executedTools],
    ...(run.waiting?.reason ? { waitingReason: run.waiting.reason } : {}),
    ...(buildWaitingFor(run) !== undefined ? { waitingFor: buildWaitingFor(run) } : {}),
    ...(run.waiting?.continuationId ? { continuationId: run.waiting.continuationId } : {}),
    ...(run.waiting?.question ? { question: run.waiting.question } : {}),
    ...(run.relatedManagedSessions?.length ? { relatedManagedSessions: structuredClone(run.relatedManagedSessions) } : {}),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    ...(run.completedAt ? { completedAt: run.completedAt } : {}),
    ...(run.cancelledAt ? { cancelledAt: run.cancelledAt } : {}),
    ...(run.lastResult !== undefined ? { result: run.lastResult } : {}),
    ...(run.error ? { error: run.error } : {}),
  };
}

function markRunWaiting(record: ToolScriptRunRecord, waiting: ToolScriptWaitingState, runtimeState: RuntimeState): void {
  record.status = 'waiting';
  record.waiting = waiting;
  record.stdout = currentStdout(runtimeState);
  record.executedTools = [...runtimeState.executedTools];
  record.snapshotBase64 = record.snapshotBase64;
  record.error = undefined;
  record.updatedAt = Date.now();
}

function upsertManagedLeaseRef(record: ToolScriptRunRecord, ref: ToolScriptManagedLeaseRef): void {
  const list = record.relatedManagedSessions || [];
  const idx = list.findIndex(entry => entry.sessionId === ref.sessionId && entry.leaseId === ref.leaseId);
  if (idx >= 0) {
    list[idx] = { ...list[idx], ...ref };
  } else {
    list.push(ref);
  }
  record.relatedManagedSessions = list;
}

function removeManagedLeaseRef(record: ToolScriptRunRecord, sessionId: string, leaseId: string): void {
  if (!record.relatedManagedSessions?.length) {
    return;
  }
  record.relatedManagedSessions = record.relatedManagedSessions.filter(ref => !(ref.sessionId === sessionId && ref.leaseId === leaseId));
}

function normalizeErrorMessage(error: any): string {
  if (!error) {
    return 'Unknown ToolScript error';
  }
  if (typeof error === 'string') {
    return error;
  }
  if (typeof error?.display === 'function') {
    try {
      return String(error.display('traceback'));
    } catch {}
  }
  if (typeof error?.message === 'string' && error.message) {
    return error.message;
  }
  if (typeof error?.toString === 'function') {
    return String(error.toString());
  }
  return String(error);
}

async function requestModelWithoutContext(prompt: string, session: Session): Promise<{ text: string }> {
  const result = await llm.requestLlmOnce({
    contents: [{
      role: 'user',
      parts: [{ text: prompt }],
    }],
    systemPrompt: '',
    model: session.model,
    sessionId: session.id,
    toolDefinitions: [],
    notifySessionEvents: false,
    registerAbortController: false,
  });

  return { text: result.text || '' };
}

function getToolScriptSession(ctx: ToolContext, functionName: string): Session {
  if (!ctx.session) {
    throw new Error(`${functionName} requires a session context.`);
  }
  return ctx.session;
}

function getNamedArg(positionalArgs: any[], kwargs: Record<string, any>, positionalIndex: number, names: string[]): any {
  if (positionalArgs.length > positionalIndex) {
    return positionalArgs[positionalIndex];
  }
  for (const name of names) {
    if (kwargs[name] !== undefined) {
      return kwargs[name];
    }
  }
  return undefined;
}

function requireStringArg(value: any, label: string): string {
  const normalized = normalizeMontyValue(value);
  if (typeof normalized !== 'string' || !normalized.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return normalized.trim();
}

function parseOptionalExpectedRevision(value: any): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const normalized = normalizeMontyValue(value);
  if (typeof normalized !== 'number' || !Number.isFinite(normalized)) {
    throw new Error('expected_revision must be a finite number.');
  }
  return normalized;
}

function parseManagedSessionRunMode(value: any): 'idle' | 'tool' | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const normalized = normalizeMontyValue(value);
  if (normalized === 'idle' || normalized === 'tool') {
    return normalized;
  }
  throw new Error('run_mode must be one of: idle, tool.');
}

function parseManagedSessionInboxOrder(value: any): 'before' | 'after' | 'ignore' | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const normalized = normalizeMontyValue(value);
  if (normalized === 'before' || normalized === 'after' || normalized === 'ignore') {
    return normalized;
  }
  throw new Error('inbox_order must be one of: before, after, ignore.');
}

function parseOptionalBoolean(value: any, label: string): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const normalized = normalizeMontyValue(value);
  if (typeof normalized === 'boolean') {
    return normalized;
  }
  throw new Error(`${label} must be a boolean.`);
}

function parseToolScriptRunMode(value: any): ToolScriptRunMode {
  if (value === undefined || value === null || value === '') {
    return 'foreground';
  }
  const normalized = normalizeMontyValue(value);
  if (normalized === true || normalized === 'background') {
    return 'background';
  }
  if (normalized === false || normalized === 'foreground') {
    return 'foreground';
  }
  throw new Error('mode must be one of: foreground, background.');
}

function validateManagedSessionInputParts(parts: MessagePart[]): MessagePart[] {
  return parts.map((part: any) => {
    const normalizedPart = { ...part };
    if (normalizedPart.functionCall || normalizedPart.functionResponse) {
      throw new Error('session_step only accepts user-style input parts; functionCall/functionResponse parts are not allowed.');
    }
    if (normalizedPart.thinking || normalizedPart.providerMeta) {
      throw new Error('session_step only accepts plain user-style input parts; thinking/providerMeta parts are not allowed.');
    }
    return normalizedPart;
  });
}

function normalizeManagedSessionStepInput(positionalArgs: any[], kwargs: Record<string, any>): { parts?: MessagePart[]; message?: Message } {
  const rawParts = kwargs.parts;
  if (rawParts !== undefined) {
    const normalizedParts = normalizeMontyValue(rawParts);
    if (!Array.isArray(normalizedParts)) {
      throw new Error('session_step parts must be an array of message-part objects.');
    }
    return {
      parts: validateManagedSessionInputParts(normalizedParts),
    };
  }

  const rawMessage = kwargs.message !== undefined ? kwargs.message : kwargs.text;
  if (rawMessage === undefined) {
    return {};
  }

  const normalizedMessage = normalizeMontyValue(rawMessage);
  if (typeof normalizedMessage === 'string') {
    return { parts: [{ text: normalizedMessage }] };
  }
  if (isPlainObject(normalizedMessage) && Array.isArray((normalizedMessage as any).parts)) {
    const role = typeof (normalizedMessage as any).role === 'string' ? (normalizedMessage as any).role : 'user';
    if (role !== 'user') {
      throw new Error('session_step message.role must be `user` when passing a full message object.');
    }
    return {
      message: {
        role,
        parts: validateManagedSessionInputParts((normalizedMessage as any).parts),
      },
    };
  }

  throw new Error('session_step message must be a string or a message object with a parts array.');
}

async function executeScriptHostCall(
  functionName: string,
  positionalArgs: any[],
  kwargs: Record<string, any>,
  state: RuntimeState,
  ctx: ToolContext,
): Promise<any> {
  if (functionName === 'call_tool') {
    const wrapperArgs = buildCallToolWrapperArgs(positionalArgs, kwargs);
    const summaryName = buildToolSummaryName(wrapperArgs);
    const toolsModule = require('./tools');
    const result = await toolsModule.call_tool(wrapperArgs, ctx);
    state.executedTools.push(summaryName);
    return normalizeMontyValue(result);
  }

  if (functionName === 'request_model_without_context') {
    const prompt = positionalArgs.length > 0 ? positionalArgs[0] : kwargs.prompt;
    if (typeof prompt !== 'string') {
      throw new Error('request_model_without_context requires a string prompt.');
    }
    const session = ctx.session || (ctx.sessionId ? await sessionManager.getSession(ctx.sessionId) : null);
    if (!session) {
      throw new Error('request_model_without_context requires a session context.');
    }
    return normalizeMontyValue(await requestModelWithoutContext(prompt, session));
  }

  if (functionName === 'open_managed_session') {
    const ownerSession = getToolScriptSession(ctx, functionName);
    const targetSessionId = requireStringArg(
      getNamedArg(positionalArgs, kwargs, 0, ['session_id', 'sessionId']),
      'session_id',
    );
    return normalizeMontyValue(await managedSessions.openManagedSession({
      sessionId: targetSessionId,
      ownerSessionId: ownerSession.id,
      ...(ctx.toolScriptRunId ? { controllerRunId: ctx.toolScriptRunId } : {}),
    }));
  }

  if (functionName === 'session_step') {
    const ownerSession = getToolScriptSession(ctx, functionName);
    const targetSessionId = requireStringArg(
      getNamedArg(positionalArgs, kwargs, 0, ['session_id', 'sessionId']),
      'session_id',
    );
    const leaseId = requireStringArg(
      getNamedArg(positionalArgs, kwargs, 1, ['lease_id', 'leaseId']),
      'lease_id',
    );
    const expectedRevision = parseOptionalExpectedRevision(
      getNamedArg(positionalArgs, kwargs, 2, ['expected_revision', 'expectedRevision']),
    );
    const runMode = parseManagedSessionRunMode(
      getNamedArg(positionalArgs, kwargs, 3, ['run_mode', 'runMode']),
    );
    const inboxOrder = parseManagedSessionInboxOrder(
      getNamedArg(positionalArgs, kwargs, 4, ['inbox_order', 'inboxOrder']),
    );
    const includeMessages = parseOptionalBoolean(
      getNamedArg(positionalArgs, kwargs, 5, ['include_messages', 'includeMessages']),
      'include_messages',
    );
    const normalizedInput = normalizeManagedSessionStepInput(positionalArgs, kwargs);
    const stepResult = await managedSessions.managedSessionStep({
      sessionId: targetSessionId,
      ownerSessionId: ownerSession.id,
      leaseId,
      expectedRevision,
      ...(ctx.toolScriptRunId ? { controllerRunId: ctx.toolScriptRunId } : {}),
      ...(runMode ? { runMode } : {}),
      ...(inboxOrder ? { inboxOrder } : {}),
      ...normalizedInput,
    });
    const safeStepResult: Record<string, any> = includeMessages
      ? stepResult as any
      : {
          ...stepResult,
          newMessagesCount: stepResult.newMessages.length,
          newMessages: [] as Message[],
        };
    return normalizeMontyValue(safeStepResult);
  }

  if (functionName === 'release_managed_session') {
    const ownerSession = getToolScriptSession(ctx, functionName);
    const targetSessionId = requireStringArg(
      getNamedArg(positionalArgs, kwargs, 0, ['session_id', 'sessionId']),
      'session_id',
    );
    const leaseId = requireStringArg(
      getNamedArg(positionalArgs, kwargs, 1, ['lease_id', 'leaseId']),
      'lease_id',
    );
    const expectedRevision = parseOptionalExpectedRevision(
      getNamedArg(positionalArgs, kwargs, 2, ['expected_revision', 'expectedRevision']),
    );
    return normalizeMontyValue(await managedSessions.releaseManagedSession({
      sessionId: targetSessionId,
      ownerSessionId: ownerSession.id,
      leaseId,
      expectedRevision,
      ...(ctx.toolScriptRunId ? { controllerRunId: ctx.toolScriptRunId } : {}),
    }));
  }

  if (functionName === 'wait_for_managed_event') {
    const targetSessionId = requireStringArg(
      getNamedArg(positionalArgs, kwargs, 0, ['session_id', 'sessionId']),
      'session_id',
    );
    const leaseId = requireStringArg(
      getNamedArg(positionalArgs, kwargs, 1, ['lease_id', 'leaseId']),
      'lease_id',
    );
    const expectedRevision = parseOptionalExpectedRevision(
      getNamedArg(positionalArgs, kwargs, 2, ['expected_revision', 'expectedRevision']),
    );
    const runMode = parseManagedSessionRunMode(
      getNamedArg(positionalArgs, kwargs, 3, ['run_mode', 'runMode']),
    );
    const inboxOrder = parseManagedSessionInboxOrder(
      getNamedArg(positionalArgs, kwargs, 4, ['inbox_order', 'inboxOrder']),
    );
    return {
      __toolscriptWaitForManagedEvent: true,
      sessionId: targetSessionId,
      leaseId,
      ...(expectedRevision !== undefined ? { expectedRevision } : {}),
      ...(runMode ? { runMode } : {}),
      ...(inboxOrder ? { inboxOrder } : {}),
    };
  }

  throw new Error(`Unsupported ToolScript host function: ${functionName}`);
}

async function advanceExecution(args: {
  progress: any;
  record: ToolScriptRunRecord;
  runtimeState: RuntimeState;
  ctx: ToolContext;
  monty: MontyModule;
}): Promise<ToolScriptResult> {
  let { progress } = args;
  const { record, runtimeState, ctx, monty } = args;

  while (true) {
    if (progress instanceof monty.MontyComplete) {
      record.status = 'completed';
      record.waiting = undefined;
      record.stdout = currentStdout(runtimeState);
      record.executedTools = [...runtimeState.executedTools];
      record.snapshotBase64 = undefined;
      record.lastResult = normalizeMontyValue(progress.output);
      record.error = undefined;
      record.updatedAt = Date.now();
      record.completedAt = record.updatedAt;
      await saveRun(record);
      return buildBaseResult(record);
    }

    if (progress instanceof monty.MontyNameLookup) {
      progress = progress.resume();
      continue;
    }

    if (!progress || typeof progress !== 'object' || typeof progress.resume !== 'function') {
      throw new Error('ToolScript execution returned an unexpected Monty state.');
    }

    const functionName = String(progress.functionName || '');
    const positionalArgs = Array.isArray(progress.args) ? progress.args : [];
    const kwargs = progress.kwargs && typeof progress.kwargs === 'object' ? progress.kwargs : {};

    if (functionName === 'ask_agent') {
      const questionValue = positionalArgs.length > 0 ? positionalArgs[0] : kwargs.question;
      const question = formatQuestion(questionValue);
      record.snapshotBase64 = Buffer.from(progress.dump()).toString('base64');
      markRunWaiting(record, {
        reason: 'agent',
        waitingSince: Date.now(),
        question,
        continuationId: newContinuationId(),
      }, runtimeState);
      await saveRun(record);
      return buildBaseResult(record);
    }

    try {
      const result = await executeScriptHostCall(functionName, positionalArgs, kwargs, runtimeState, ctx);
      if (functionName === 'open_managed_session' && result && typeof result === 'object' && (result as any).sessionId && (result as any).leaseId) {
        upsertManagedLeaseRef(record, {
          sessionId: String((result as any).sessionId),
          leaseId: String((result as any).leaseId),
          ...(ctx.toolScriptRunId ? { controllerRunId: ctx.toolScriptRunId } : {}),
        });
      }
      if (functionName === 'release_managed_session' && result && typeof result === 'object' && (result as any).sessionId) {
        const leaseId = kwargs.lease_id ?? kwargs.leaseId ?? positionalArgs[1];
        if (typeof leaseId === 'string') {
          removeManagedLeaseRef(record, String((result as any).sessionId), leaseId);
        }
      }
      if (result && typeof result === 'object' && (result as any).__toolscriptWaitForManagedEvent) {
        record.snapshotBase64 = Buffer.from(progress.dump()).toString('base64');
        markRunWaiting(record, {
          reason: 'managed_event',
          waitingSince: Date.now(),
          managedEvent: {
            sessionId: String((result as any).sessionId),
            leaseId: String((result as any).leaseId),
            ...(typeof (result as any).expectedRevision === 'number' ? { expectedRevision: (result as any).expectedRevision } : {}),
            ...((result as any).runMode ? { runMode: (result as any).runMode } : {}),
            ...((result as any).inboxOrder ? { inboxOrder: (result as any).inboxOrder } : {}),
          },
        }, runtimeState);
        if ((result as any).sessionId && (result as any).leaseId) {
          upsertManagedLeaseRef(record, {
            sessionId: String((result as any).sessionId),
            leaseId: String((result as any).leaseId),
            ...(ctx.toolScriptRunId ? { controllerRunId: ctx.toolScriptRunId } : {}),
          });
        }
        await saveRun(record);
        return buildBaseResult(record);
      }
      progress = progress.resume({ returnValue: result });
    } catch (error: any) {
      progress = progress.resume({
        exception: {
          type: 'RuntimeError',
          message: error?.message || String(error),
        },
      });
    }
  }
}

async function requireSessionContext(ctx: ToolContext): Promise<{ sessionId: string; session: Session }> {
  const sessionId = typeof ctx?.sessionId === 'string' && ctx.sessionId.trim()
    ? ctx.sessionId.trim()
    : undefined;
  if (!sessionId) {
    throw new Error('ToolScript tools require a session context.');
  }

  const session = ctx.session || await sessionManager.getSession(sessionId);
  return { sessionId, session };
}

async function readScriptSource(filePath: string, ctx: ToolContext, session: Session): Promise<{ scriptPath: string; code: string }> {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('filePath is required');
  }
  const agentName = session.agent || 'main';
  const scriptPath = resolveAgentPath(filePath, agentName, session.cwd);

  if (sessionManager.isSessionEffectivelyIsolated(session)) {
    checkPathAccess(scriptPath, agentName);
  }

  const code = await fs.readFile(scriptPath, 'utf8');
  return { scriptPath, code };
}

function createRunRecord(args: {
  runId: string;
  mode: ToolScriptRunMode;
  session: Session;
  filePath: string;
  scriptPath: string;
}): ToolScriptRunRecord {
  const now = Date.now();
  return {
    runId: args.runId,
    mode: args.mode,
    status: 'running',
    ownerSessionId: args.session.id,
    agentName: args.session.agent || 'main',
    filePath: args.filePath,
    scriptPath: args.scriptPath,
    scriptName: path.basename(args.scriptPath) || 'script.py',
    stdout: '',
    executedTools: [],
    relatedManagedSessions: [],
    createdAt: now,
    updatedAt: now,
    startedAt: now,
  };
}

async function failRun(record: ToolScriptRunRecord, runtimeState: RuntimeState, error: any, logMessage: string): Promise<ToolScriptResult> {
  record.status = 'failed';
  record.waiting = undefined;
  record.stdout = currentStdout(runtimeState);
  record.executedTools = [...runtimeState.executedTools];
  record.snapshotBase64 = undefined;
  record.error = normalizeErrorMessage(error);
  record.updatedAt = Date.now();
  await saveRun(record);
  logger.warn({ err: error, runId: record.runId, filePath: record.scriptPath }, logMessage);
  return buildBaseResult(record);
}

async function startRun(record: ToolScriptRunRecord, code: string, scriptArgs: any, ctx: ToolContext): Promise<ToolScriptResult> {
  const monty = await importMonty();
  const runtimeState = createRuntimeState(record.stdout, record.executedTools);
  try {
    const runner = new monty.Monty(buildToolScriptSource(code), { scriptName: record.scriptName, inputs: ['args'] });
    const progress = runner.start({
      inputs: { args: normalizeMontyValue(scriptArgs || {}) },
      limits: DEFAULT_SCRIPT_LIMITS,
      printCallback: printCallbackFor(runtimeState),
    });
    return await advanceExecution({ progress, record, runtimeState, ctx: { ...ctx, toolScriptRunId: record.runId }, monty });
  } catch (error: any) {
    return await failRun(record, runtimeState, error, 'ToolScript run failed during startup');
  }
}

async function resumeRun(record: ToolScriptRunRecord, resumeValue: any, ctx: ToolContext, logMessage: string): Promise<ToolScriptResult> {
  const monty = await importMonty();
  const runtimeState = createRuntimeState(record.stdout, record.executedTools);
  try {
    if (!record.snapshotBase64) {
      throw new Error(`ToolScript run \`${record.runId}\` has no resumable snapshot.`);
    }
    record.status = 'running';
    record.lastResumeAt = Date.now();
    record.updatedAt = record.lastResumeAt;
    await saveRun(record);
    const snapshot = monty.MontySnapshot.load(Buffer.from(record.snapshotBase64, 'base64'), {
      printCallback: printCallbackFor(runtimeState),
    });
    const resumed = snapshot.resume({ returnValue: normalizeMontyValue(resumeValue) });
    return await advanceExecution({ progress: resumed, record, runtimeState, ctx: { ...ctx, toolScriptRunId: record.runId }, monty });
  } catch (error: any) {
    return await failRun(record, runtimeState, error, logMessage);
  }
}

function ensureRunOwnedBySession(record: ToolScriptRunRecord, sessionId: string): void {
  if (record.ownerSessionId !== sessionId) {
    throw new Error('ToolScript runs may only be accessed from their owning session.');
  }
}

export async function tool_run_script(args: ToolArgs, ctx: ToolContext): Promise<ToolScriptResult> {
  const { sessionId, session } = await requireSessionContext(ctx);
  const { filePath } = args || {};
  const mode = parseToolScriptRunMode(args?.mode ?? args?.runMode ?? args?.background);
  const { scriptPath, code } = await readScriptSource(filePath, ctx, session);
  const runId = newRunId();
  const record = createRunRecord({ runId, mode, session, filePath, scriptPath });
  return await startRun(record, code, args?.args || {}, { ...ctx, sessionId, session, toolScriptRunId: runId });
}

export async function tool_start_toolscript_run(args: ToolArgs, ctx: ToolContext): Promise<ToolScriptResult> {
  return await tool_run_script({ ...args, mode: args?.mode || 'background' }, ctx);
}

export async function tool_continue_script(args: ToolArgs, ctx: ToolContext): Promise<ToolScriptResult> {
  const { sessionId, session } = await requireSessionContext(ctx);
  const runId = typeof args?.runId === 'string' && args.runId.trim() ? args.runId.trim() : '';
  const continuationId = typeof args?.continuationId === 'string' && args.continuationId.trim() ? args.continuationId.trim() : '';
  if (!runId) {
    throw new Error('runId is required');
  }
  if (!continuationId) {
    throw new Error('continuationId is required');
  }

  const record = await loadRun(runId);
  if (!record) {
    throw new Error(`ToolScript run \`${runId}\` not found.`);
  }
  ensureRunOwnedBySession(record, sessionId);
  if (record.status !== 'waiting' || record.waiting?.reason !== 'agent' || !record.snapshotBase64) {
    throw new Error(`ToolScript run \`${runId}\` is not waiting for continue_script.`);
  }
  if (record.waiting?.continuationId !== continuationId) {
    throw new Error('continuationId does not match the pending ToolScript continuation.');
  }
  return await resumeRun(record, args?.input, { ...ctx, sessionId, session, toolScriptRunId: runId }, 'ToolScript continue failed');
}

export async function tool_list_toolscript_runs(args: ToolArgs, ctx: ToolContext): Promise<{ runs: ToolScriptResult[] }> {
  const { sessionId } = await requireSessionContext(ctx);
  const limit = typeof args?.limit === 'number' && Number.isFinite(args.limit)
    ? Math.max(1, Math.min(200, Math.trunc(args.limit)))
    : 20;
  const statusFilter = typeof args?.status === 'string' && args.status.trim() ? args.status.trim() : undefined;
  const records = await listRuns();
  return {
    runs: records
      .filter(record => record.ownerSessionId === sessionId)
      .filter(record => !statusFilter || record.status === statusFilter)
      .slice(0, limit)
      .map(buildBaseResult),
  };
}

export async function tool_get_toolscript_run(args: ToolArgs, ctx: ToolContext): Promise<ToolScriptResult> {
  const { sessionId } = await requireSessionContext(ctx);
  const runId = requireStringArg(args?.runId, 'runId');
  const record = await loadRun(runId);
  if (!record) {
    throw new Error(`ToolScript run \`${runId}\` not found.`);
  }
  ensureRunOwnedBySession(record, sessionId);
  return buildBaseResult(record);
}

export async function tool_cancel_toolscript_run(args: ToolArgs, ctx: ToolContext): Promise<ToolScriptResult> {
  const { sessionId } = await requireSessionContext(ctx);
  const runId = requireStringArg(args?.runId, 'runId');
  const record = await loadRun(runId);
  if (!record) {
    throw new Error(`ToolScript run \`${runId}\` not found.`);
  }
  ensureRunOwnedBySession(record, sessionId);
  if (record.status === 'completed' || record.status === 'failed' || record.status === 'cancelled') {
    return buildBaseResult(record);
  }

  for (const ref of record.relatedManagedSessions || []) {
    try {
      await managedSessions.releaseManagedSession({
        sessionId: ref.sessionId,
        ownerSessionId: record.ownerSessionId,
        leaseId: ref.leaseId,
        ...(record.runId ? { controllerRunId: record.runId } : {}),
      });
    } catch (error: any) {
      logger.warn({ err: error, runId: record.runId, managedSessionId: ref.sessionId }, 'Failed to release managed session during ToolScript cancel');
    }
  }

  activeBackgroundRuns.delete(record.runId);
  record.status = 'cancelled';
  record.waiting = undefined;
  record.snapshotBase64 = undefined;
  record.cancelledAt = Date.now();
  record.updatedAt = record.cancelledAt;
  await saveRun(record);
  return buildBaseResult(record);
}

export async function resumeBackgroundToolScriptRunForManagedSession(args: {
  runId: string;
  sessionId: string;
  leaseId?: string;
  revision?: number;
  pendingInboxCount?: number;
  wakeReason?: string;
}): Promise<ToolScriptResult | null> {
  const record = await loadRun(args.runId);
  if (!record || record.mode !== 'background' || record.status !== 'waiting' || record.waiting?.reason !== 'managed_event') {
    return null;
  }
  const managedWait = record.waiting.managedEvent;
  if (!managedWait || managedWait.sessionId !== args.sessionId) {
    return null;
  }
  if (managedWait.leaseId && args.leaseId && managedWait.leaseId !== args.leaseId) {
    return null;
  }
  if (activeBackgroundRuns.has(record.runId)) {
    return null;
  }
  activeBackgroundRuns.add(record.runId);
  try {
    record.lastWakeReason = args.wakeReason || 'managed-event';
    const ownerSession = await sessionManager.getSession(record.ownerSessionId);
    return await resumeRun(record, {
      type: 'managed_event',
      sessionId: args.sessionId,
      leaseId: managedWait.leaseId,
      ...(typeof args.revision === 'number' ? { revision: args.revision } : {}),
      ...(typeof args.pendingInboxCount === 'number' ? { pendingInboxCount: args.pendingInboxCount } : {}),
      wakeReason: args.wakeReason || 'managed-event',
    }, { sessionId: record.ownerSessionId, session: ownerSession, toolScriptRunId: record.runId }, 'ToolScript background resume failed');
  } finally {
    activeBackgroundRuns.delete(record.runId);
  }
}

export async function getToolScriptRunForTests(runId: string): Promise<ToolScriptRunRecord | null> {
  return await loadRun(runId);
}

export async function resetToolScriptRunsForTests(): Promise<void> {
  await fs.remove(TOOLSCRIPT_RUNS_DIR);
}
