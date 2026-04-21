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
};

type ToolScriptRunStatus = 'paused_for_agent' | 'completed' | 'failed';

type ToolScriptRunRecord = {
  runId: string;
  sessionId: string;
  agentName: string;
  filePath: string;
  scriptPath: string;
  scriptName: string;
  status: ToolScriptRunStatus;
  continuationId?: string;
  pendingQuestion?: string;
  snapshotBase64?: string;
  stdout: string;
  executedTools: string[];
  lastResult?: any;
  error?: string;
  createdAt: number;
  updatedAt: number;
};

type ToolScriptResult = {
  status: ToolScriptRunStatus;
  runId: string;
  continuationId?: string;
  question?: string;
  stdout: string;
  executedTools: string[];
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

function nativeImport<T = any>(specifier: string): Promise<T> {
  return Function('s', 'return import(s)')(specifier) as Promise<T>;
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

function buildBaseResult(run: ToolScriptRunRecord): ToolScriptResult {
  return {
    status: run.status,
    runId: run.runId,
    continuationId: run.continuationId,
    question: run.pendingQuestion,
    stdout: run.stdout,
    executedTools: [...run.executedTools],
    ...(run.lastResult !== undefined ? { result: run.lastResult } : {}),
    ...(run.error ? { error: run.error } : {}),
  };
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
    const normalizedInput = normalizeManagedSessionStepInput(positionalArgs, kwargs);
    return normalizeMontyValue(await managedSessions.managedSessionStep({
      sessionId: targetSessionId,
      ownerSessionId: ownerSession.id,
      leaseId,
      expectedRevision,
      ...(runMode ? { runMode } : {}),
      ...(inboxOrder ? { inboxOrder } : {}),
      ...normalizedInput,
    }));
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
    }));
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
      record.stdout = currentStdout(runtimeState);
      record.executedTools = [...runtimeState.executedTools];
      record.continuationId = undefined;
      record.pendingQuestion = undefined;
      record.snapshotBase64 = undefined;
      record.lastResult = normalizeMontyValue(progress.output);
      record.error = undefined;
      record.updatedAt = Date.now();
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
      record.status = 'paused_for_agent';
      record.stdout = currentStdout(runtimeState);
      record.executedTools = [...runtimeState.executedTools];
      record.pendingQuestion = question;
      record.continuationId = newContinuationId();
      record.snapshotBase64 = Buffer.from(progress.dump()).toString('base64');
      record.error = undefined;
      record.updatedAt = Date.now();
      await saveRun(record);
      return buildBaseResult(record);
    }

    try {
      const result = await executeScriptHostCall(functionName, positionalArgs, kwargs, runtimeState, ctx);
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

export async function tool_run_script(args: ToolArgs, ctx: ToolContext): Promise<ToolScriptResult> {
  const { sessionId, session } = await requireSessionContext(ctx);
  const { filePath } = args || {};
  const { scriptPath, code } = await readScriptSource(filePath, ctx, session);
  const monty = await importMonty();
  const runtimeState = createRuntimeState('', []);
  const runId = newRunId();
  const scriptName = path.basename(scriptPath) || 'script.py';

  const record: ToolScriptRunRecord = {
    runId,
    sessionId,
    agentName: session.agent || 'main',
    filePath,
    scriptPath,
    scriptName,
    status: 'completed',
    stdout: '',
    executedTools: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  try {
    const runner = new monty.Monty(code, { scriptName, inputs: ['args'] });
    const progress = runner.start({
      inputs: { args: normalizeMontyValue(args?.args || {}) },
      limits: DEFAULT_SCRIPT_LIMITS,
      printCallback: printCallbackFor(runtimeState),
    });
    return await advanceExecution({ progress, record, runtimeState, ctx: { ...ctx, sessionId, session }, monty });
  } catch (error: any) {
    record.status = 'failed';
    record.stdout = currentStdout(runtimeState);
    record.executedTools = [...runtimeState.executedTools];
    record.error = normalizeErrorMessage(error);
    record.updatedAt = Date.now();
    await saveRun(record);
    logger.warn({ err: error, runId, filePath: scriptPath }, 'ToolScript run failed during startup');
    return buildBaseResult(record);
  }
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
  if (record.sessionId !== sessionId) {
    throw new Error('ToolScript runs may only be continued from their owning session.');
  }
  if (record.status !== 'paused_for_agent' || !record.snapshotBase64) {
    throw new Error(`ToolScript run \`${runId}\` is not waiting for continue_script.`);
  }
  if (record.continuationId !== continuationId) {
    throw new Error('continuationId does not match the pending ToolScript continuation.');
  }

  const monty = await importMonty();
  const runtimeState = createRuntimeState(record.stdout, record.executedTools);

  try {
    const snapshot = monty.MontySnapshot.load(Buffer.from(record.snapshotBase64, 'base64'), {
      printCallback: printCallbackFor(runtimeState),
    });
    const resumed = snapshot.resume({ returnValue: normalizeMontyValue(args?.input) });
    return await advanceExecution({ progress: resumed, record, runtimeState, ctx: { ...ctx, sessionId, session }, monty });
  } catch (error: any) {
    record.status = 'failed';
    record.stdout = currentStdout(runtimeState);
    record.executedTools = [...runtimeState.executedTools];
    record.continuationId = undefined;
    record.pendingQuestion = undefined;
    record.snapshotBase64 = undefined;
    record.error = normalizeErrorMessage(error);
    record.updatedAt = Date.now();
    await saveRun(record);
    logger.warn({ err: error, runId }, 'ToolScript continue failed');
    return buildBaseResult(record);
  }
}

export async function getToolScriptRunForTests(runId: string): Promise<ToolScriptRunRecord | null> {
  return await loadRun(runId);
}

export async function resetToolScriptRunsForTests(): Promise<void> {
  await fs.remove(TOOLSCRIPT_RUNS_DIR);
}
