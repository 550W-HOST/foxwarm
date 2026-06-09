import crypto from 'crypto';
import fs from 'fs-extra';
import path from 'path';
import { STATE_DIR } from './config';
import { logger } from './common';
import * as llm from './llm';
import * as managedSessions from './managedSessions';
import { resolveAgentPath } from './utils/pathResolve';
import * as sessionManager from './sessionManager';
import { checkPathAccess } from './isolatedCheck';
import { resolveObjectArgWithJsonFallback } from './jsonObjectArgs';
import type { Message, MessagePart, Session, ToolScriptSubCall } from './types';

type ToolArgs = Record<string, any>;

type ToolContext = {
  sessionId?: string;
  session?: Session;
  broadcast?: (text: string, options?: any) => Promise<void>;
  runtimeNodeId?: string;
  toolScriptRunId?: string;
  toolUseId?: string;
};

type ToolScriptRunMode = 'foreground' | 'background';
type ToolScriptRunStatus = 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
type ToolScriptWaitingReason = 'agent' | 'managed_event' | 'timeout';

type ToolScriptPendingResume = {
  mode: 'return';
  value: any;
} | {
  mode: 'exception';
  exception: {
    type: string;
    message: string;
  };
};

type ToolScriptManagedLeaseRef = {
  sessionId: string;
  leaseId: string;
  controllerRunId?: string;
};

type ToolScriptHostCallInfo = {
  functionName: string;
  summaryName?: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  error?: string;
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
  timeout?: {
    continuationId: string;
    timeoutSecs: number;
    elapsedMs: number;
    pausedAtFunctionName?: string;
    pausedAtSummaryName?: string;
    pendingResume: ToolScriptPendingResume;
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
  subCalls?: ToolScriptSubCall[];
  waiting?: ToolScriptWaitingState;
  relatedManagedSessions?: ToolScriptManagedLeaseRef[];
  hostCallCount?: number;
  lastHostCall?: ToolScriptHostCallInfo;
  timeoutSecs?: number;
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
  subCalls?: ToolScriptSubCall[];
  waitingReason?: ToolScriptWaitingReason;
  waitingFor?: any;
  continuationId?: string;
  question?: string;
  relatedManagedSessions?: ToolScriptManagedLeaseRef[];
  hostCallCount?: number;
  lastHostCall?: ToolScriptHostCallInfo;
  timeoutSecs?: number;
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
  subCalls: ToolScriptSubCall[];
  hostCallCount: number;
  lastHostCall?: ToolScriptHostCallInfo;
};

type MontyModule = {
  Monty: new (code: string, options?: Record<string, any>) => any;
  MontySnapshot: { load(data: Buffer, options?: Record<string, any>): any };
  MontyComplete: new (...args: any[]) => any;
  MontyNameLookup: new (...args: any[]) => any;
};

const TOOLSCRIPT_RUNS_DIR = path.join(STATE_DIR, 'toolscript-runs');
const METADATA_KEYS = new Set(['toolId', 'source', 'name', 'server', 'nodeId', 'args']);
const DEFAULT_TOOLSCRIPT_TIMEOUT_SECS = 30;
const DEFAULT_SCRIPT_LIMITS = {
  maxAllocations: 200000,
  maxMemory: 64 * 1024 * 1024,
  maxRecursionDepth: 200,
};

let montyModulePromise: Promise<MontyModule> | null = null;
const activeBackgroundRuns = new Set<string>();

function nativeImport<T = any>(specifier: string): Promise<T> {
  return Function('s', 'return import(s)')(specifier) as Promise<T>;
}

function buildToolScriptSource(code: string): string {
  if (!/^\s*def\s+main\s*\(\s*args\b/m.test(code)) {
    throw new Error('ToolScript scripts must define `def main(args):` and return a result explicitly.');
  }
  return `${code.trimEnd()}\n\nmain(args)\n`;
}

function parseTimeoutSecs(value: any, fallback = DEFAULT_TOOLSCRIPT_TIMEOUT_SECS): number {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const normalized = normalizeMontyValue(value);
  if (typeof normalized !== 'number' || !Number.isFinite(normalized) || normalized <= 0) {
    throw new Error('timeoutSecs must be a positive number.');
  }
  return normalized;
}

function buildMontyLimits(timeoutSecs: number): Record<string, any> {
  return {
    ...DEFAULT_SCRIPT_LIMITS,
    maxDurationSecs: timeoutSecs,
  };
}

function getSliceStartedAt(record: ToolScriptRunRecord): number {
  return record.lastResumeAt || record.startedAt;
}

function getElapsedSliceMs(record: ToolScriptRunRecord): number {
  return Math.max(0, Date.now() - getSliceStartedAt(record));
}

function currentStdoutTail(state: RuntimeState, limit = 200): string {
  const stdout = currentStdout(state);
  return stdout.length <= limit ? stdout : stdout.slice(-limit);
}

function formatRuntimeContext(record: ToolScriptRunRecord, runtimeState: RuntimeState): string {
  const lines = [
    `ToolScript context:`,
    `- script: ${record.scriptName}`,
    `- mode: ${record.mode}`,
    `- elapsedMs: ${Date.now() - record.startedAt}`,
    `- sliceElapsedMs: ${getElapsedSliceMs(record)}`,
    `- hostCallCount: ${runtimeState.hostCallCount}`,
    `- executedTools: ${runtimeState.executedTools.length ? runtimeState.executedTools.join(', ') : '(none)'}`,
    `- limits: maxDurationSecs=${record.timeoutSecs ?? DEFAULT_TOOLSCRIPT_TIMEOUT_SECS}, maxAllocations=${DEFAULT_SCRIPT_LIMITS.maxAllocations}, maxMemory=${DEFAULT_SCRIPT_LIMITS.maxMemory}, maxRecursionDepth=${DEFAULT_SCRIPT_LIMITS.maxRecursionDepth}`,
  ];

  if (runtimeState.lastHostCall) {
    lines.push(`- lastHostCall: ${runtimeState.lastHostCall.functionName}${runtimeState.lastHostCall.summaryName ? ` (${runtimeState.lastHostCall.summaryName})` : ''}`);
    lines.push(`- lastHostCallStatus: ${runtimeState.lastHostCall.status}`);
    if (typeof runtimeState.lastHostCall.durationMs === 'number') {
      lines.push(`- lastHostCallDurationMs: ${runtimeState.lastHostCall.durationMs}`);
    }
    if (runtimeState.lastHostCall.error) {
      lines.push(`- lastHostCallError: ${runtimeState.lastHostCall.error}`);
    }
  }

  const stdoutTail = currentStdoutTail(runtimeState);
  if (stdoutTail) {
    lines.push(`- stdoutTail: ${JSON.stringify(stdoutTail)}`);
  }

  return lines.join('\n');
}

async function importMonty(): Promise<MontyModule> {
  if (!montyModulePromise) {
    montyModulePromise = nativeImport<MontyModule>('@pydantic/monty');
  }
  return await montyModulePromise;
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
    if (normalizedPositionals.length > 2) {
      throw new Error('call_tool supports at most two positional arguments when using a descriptor object: descriptor and args object.');
    }

    const descriptor = first;
    const positionalToolArgs = normalizedPositionals.length >= 2 && normalizedPositionals[1] !== undefined
      ? normalizeMontyValue(normalizedPositionals[1])
      : {};
    if (positionalToolArgs !== undefined && !isPlainObject(positionalToolArgs)) {
      throw new Error('call_tool positional args object must be a mapping/object.');
    }

    const { metadata, toolArgs } = splitMetadataAndToolArgs(descriptor);
    const { metadata: kwMetadata, toolArgs: kwToolArgs } = splitMetadataAndToolArgs(normalizedKwargs);
    const descriptorArgs = metadata.args;
    const kwExplicitArgs = kwMetadata.args;
    if (descriptorArgs !== undefined && !isPlainObject(descriptorArgs)) {
      throw new Error('call_tool args must be an object.');
    }
    if (kwExplicitArgs !== undefined && !isPlainObject(kwExplicitArgs)) {
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
        ...(isPlainObject(positionalToolArgs) ? positionalToolArgs : {}),
        ...(isPlainObject(descriptorArgs) ? descriptorArgs : {}),
        ...kwToolArgs,
        ...(isPlainObject(kwExplicitArgs) ? kwExplicitArgs : {}),
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
    subCalls: [],
    hostCallCount: 0,
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
  if (run.waiting.reason === 'timeout') {
    return run.waiting.timeout
      ? {
          timeoutSecs: run.waiting.timeout.timeoutSecs,
          elapsedMs: run.waiting.timeout.elapsedMs,
          ...(run.waiting.timeout.pausedAtFunctionName ? { pausedAtFunctionName: run.waiting.timeout.pausedAtFunctionName } : {}),
          ...(run.waiting.timeout.pausedAtSummaryName ? { pausedAtSummaryName: run.waiting.timeout.pausedAtSummaryName } : {}),
          canContinue: true,
          hint: 'ToolScript paused at a timeout checkpoint. Use continue_script(...) to keep executing.',
        }
      : { canContinue: true, hint: 'ToolScript paused at a timeout checkpoint. Use continue_script(...) to keep executing.' };
  }
  return undefined;
}

function extractAndCleanInlineData(lastResult: any): { inlineDataFields: { inlineData?: any; inlineDataItems?: any[] }; cleanedResult: any } {
  if (!lastResult || typeof lastResult !== 'object' || Array.isArray(lastResult)) {
    return { inlineDataFields: {}, cleanedResult: lastResult };
  }
  const inlineDataFields: { inlineData?: any; inlineDataItems?: any[] } = {};
  let hasInlineData = false;
  if (lastResult.inlineData && typeof lastResult.inlineData === 'object' && typeof lastResult.inlineData.data === 'string') {
    inlineDataFields.inlineData = lastResult.inlineData;
    hasInlineData = true;
  }
  if (Array.isArray(lastResult.inlineDataItems) && lastResult.inlineDataItems.length > 0) {
    inlineDataFields.inlineDataItems = lastResult.inlineDataItems;
    hasInlineData = true;
  }
  if (!hasInlineData) {
    return { inlineDataFields, cleanedResult: lastResult };
  }
  // Strip inlineData from result and replace with a placeholder so the base64 blob
  // does not bloat the text representation seen by the model.
  const { inlineData, inlineDataItems, ...rest } = lastResult;
  if (inlineData) {
    rest.inlineData = `[image promoted, mimeType=${inlineData.mimeType || 'unknown'}]`;
  }
  if (inlineDataItems) {
    rest.inlineDataItems = `[${inlineDataItems.length} image(s) promoted]`;
  }
  return { inlineDataFields, cleanedResult: rest };
}

function buildBaseResult(run: ToolScriptRunRecord): ToolScriptResult {
  // Promote inlineData / inlineDataItems from lastResult to the top-level result
  // so that the tool-result image pipeline (normalizeToolResultImages) can pick them up.
  // The cleaned result replaces raw base64 blobs with short placeholders.
  const { inlineDataFields, cleanedResult } = run.lastResult !== undefined
    ? extractAndCleanInlineData(run.lastResult)
    : { inlineDataFields: {}, cleanedResult: undefined };

  return {
    status: run.status,
    runId: run.runId,
    mode: run.mode,
    ownerSessionId: run.ownerSessionId,
    scriptPath: run.scriptPath,
    filePath: run.filePath,
    stdout: run.stdout,
    executedTools: [...run.executedTools],
    ...(run.subCalls?.length ? { subCalls: run.subCalls.map(sc => ({ ...sc })) } : {}),
    ...(run.waiting?.reason ? { waitingReason: run.waiting.reason } : {}),
    ...(buildWaitingFor(run) !== undefined ? { waitingFor: buildWaitingFor(run) } : {}),
    ...(run.waiting?.continuationId ? { continuationId: run.waiting.continuationId } : {}),
    ...(run.waiting?.question ? { question: run.waiting.question } : {}),
    ...(run.relatedManagedSessions?.length ? { relatedManagedSessions: structuredClone(run.relatedManagedSessions) } : {}),
    ...(typeof run.hostCallCount === 'number' ? { hostCallCount: run.hostCallCount } : {}),
    ...(run.lastHostCall ? { lastHostCall: structuredClone(run.lastHostCall) } : {}),
    ...(typeof run.timeoutSecs === 'number' ? { timeoutSecs: run.timeoutSecs } : {}),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    ...(run.completedAt ? { completedAt: run.completedAt } : {}),
    ...(run.cancelledAt ? { cancelledAt: run.cancelledAt } : {}),
    ...(cleanedResult !== undefined ? { result: cleanedResult } : {}),
    ...(run.error ? { error: run.error } : {}),
    ...inlineDataFields,
  };
}

function stdoutDeltaSince(previousStdout: string, currentStdout: string): string {
  if (!previousStdout) {
    return currentStdout;
  }
  if (currentStdout.startsWith(previousStdout)) {
    return currentStdout.slice(previousStdout.length);
  }
  return currentStdout;
}

function withStdoutDelta(result: ToolScriptResult, previousStdout: string): ToolScriptResult {
  return {
    ...result,
    stdout: stdoutDeltaSince(previousStdout, result.stdout),
  };
}

function markRunWaiting(record: ToolScriptRunRecord, waiting: ToolScriptWaitingState, runtimeState: RuntimeState): void {
  record.status = 'waiting';
  record.waiting = waiting;
  record.stdout = currentStdout(runtimeState);
  record.executedTools = [...runtimeState.executedTools];
  record.subCalls = runtimeState.subCalls.map(sc => ({ ...sc }));
  record.hostCallCount = runtimeState.hostCallCount;
  record.lastHostCall = runtimeState.lastHostCall ? structuredClone(runtimeState.lastHostCall) : undefined;
  record.snapshotBase64 = record.snapshotBase64;
  record.error = undefined;
  record.updatedAt = Date.now();
}

function shouldPauseForTimeout(record: ToolScriptRunRecord): boolean {
  const timeoutSecs = record.timeoutSecs ?? DEFAULT_TOOLSCRIPT_TIMEOUT_SECS;
  return getElapsedSliceMs(record) >= timeoutSecs * 1000;
}

function buildTimeoutWaitingState(record: ToolScriptRunRecord, runtimeState: RuntimeState, pendingResume: ToolScriptPendingResume): ToolScriptWaitingState {
  const continuationId = newContinuationId();
  return {
    reason: 'timeout',
    waitingSince: Date.now(),
    continuationId,
    timeout: {
      continuationId,
      timeoutSecs: record.timeoutSecs ?? DEFAULT_TOOLSCRIPT_TIMEOUT_SECS,
      elapsedMs: getElapsedSliceMs(record),
      ...(runtimeState.lastHostCall?.functionName ? { pausedAtFunctionName: runtimeState.lastHostCall.functionName } : {}),
      ...(runtimeState.lastHostCall?.summaryName ? { pausedAtSummaryName: runtimeState.lastHostCall.summaryName } : {}),
      pendingResume,
    },
  };
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

function normalizeErrorMessage(error: any, record?: ToolScriptRunRecord, runtimeState?: RuntimeState): string {
  const augmentWithContext = (message: string): string => {
    if (!record || !runtimeState) {
      return message;
    }
    return `${message}\n\n${formatRuntimeContext(record, runtimeState)}`;
  };

  if (!error) {
    return augmentWithContext('Unknown ToolScript error');
  }
  if (typeof error === 'string') {
    if (/Snapshot has already been resumed/i.test(error)) {
      return augmentWithContext(`${error}\n\nThis usually indicates a ToolScript runtime/snapshot lifecycle failure rather than a literal double-resume in user code. Repeated host calls and resource-limit exhaustion are common triggers.`);
    }
    return augmentWithContext(error);
  }
  if (typeof error?.display === 'function') {
    try {
      const displayText = String(error.display('traceback'));
      if (/Snapshot has already been resumed/i.test(displayText)) {
        return augmentWithContext(`${displayText}\n\nThis usually indicates a ToolScript runtime/snapshot lifecycle failure rather than a literal double-resume in user code. Repeated host calls and resource-limit exhaustion are common triggers.`);
      }
      return augmentWithContext(displayText);
    } catch {}
  }
  if (typeof error?.message === 'string' && error.message) {
    if (/Snapshot has already been resumed/i.test(error.message)) {
      return augmentWithContext(`${error.message}\n\nThis usually indicates a ToolScript runtime/snapshot lifecycle failure rather than a literal double-resume in user code. Repeated host calls and resource-limit exhaustion are common triggers.`);
    }
    return augmentWithContext(error.message);
  }
  if (typeof error?.toString === 'function') {
    return augmentWithContext(String(error.toString()));
  }
  return augmentWithContext(String(error));
}

async function requestModelWithoutContext(prompt: string, session: Session, model?: string): Promise<{ text: string }> {
  const result = await llm.requestLlmOnce({
    contents: [{
      role: 'user',
      parts: [{ text: prompt }],
    }],
    systemPrompt: '',
    model: model || session.model,
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

function emitToolScriptProgress(ctx: ToolContext, state: RuntimeState): void {
  if (!ctx.sessionId || !ctx.toolUseId) return;
  sessionManager.notifySessionEvent(ctx.sessionId, {
    type: 'toolscript-progress',
    runId: ctx.toolScriptRunId,
    toolUseId: ctx.toolUseId,
    subCalls: state.subCalls.map(sc => ({ ...sc })),
  });
}

function buildArgsSummary(wrapperArgs: Record<string, any>): string {
  const args = wrapperArgs.args || {};
  if (args.filePath) return String(args.filePath);
  if (args.command) {
    const cmd = String(args.command);
    return cmd.length > 80 ? cmd.slice(0, 80) + '...' : cmd;
  }
  const keys = Object.keys(args).slice(0, 2);
  if (keys.length === 0) return '';
  return keys.map(k => {
    const v = String(args[k] ?? '');
    return `${k}: ${v.length > 30 ? v.slice(0, 30) + '...' : v}`;
  }).join(', ');
}

async function executeScriptHostCall(
  functionName: string,
  positionalArgs: any[],
  kwargs: Record<string, any>,
  state: RuntimeState,
  ctx: ToolContext,
): Promise<any> {
  const startHostCall = (summaryName?: string) => {
    state.hostCallCount += 1;
    state.lastHostCall = {
      functionName,
      ...(summaryName ? { summaryName } : {}),
      status: 'running',
      startedAt: Date.now(),
    };
  };

  const finishHostCall = (status: 'completed' | 'failed', error?: any) => {
    if (!state.lastHostCall || state.lastHostCall.functionName !== functionName) {
      return;
    }
    const completedAt = Date.now();
    state.lastHostCall = {
      ...state.lastHostCall,
      status,
      completedAt,
      durationMs: completedAt - state.lastHostCall.startedAt,
      ...(error ? { error: normalizeErrorMessage(error) } : {}),
    };
  };

  if (functionName === 'call_tool') {
    const wrapperArgs = buildCallToolWrapperArgs(positionalArgs, kwargs);
    const summaryName = buildToolSummaryName(wrapperArgs);
    const toolsModule = require('./tools');
    startHostCall(summaryName);

    // Emit running progress
    const subCallId = `tss_${state.hostCallCount}`;
    state.subCalls.push({
      id: subCallId,
      name: summaryName,
      status: 'running',
      startedAt: Date.now(),
      argsSummary: buildArgsSummary(wrapperArgs),
    });
    emitToolScriptProgress(ctx, state);

    try {
      const result = await toolsModule.call_tool(wrapperArgs, ctx);
      state.executedTools.push(summaryName);
      finishHostCall('completed');

      // Emit completed progress
      const sc = state.subCalls.find(s => s.id === subCallId);
      if (sc) {
        sc.status = 'completed';
        sc.completedAt = Date.now();
        sc.durationMs = sc.completedAt - sc.startedAt;
      }
      emitToolScriptProgress(ctx, state);

      return normalizeMontyValue(result);
    } catch (error: any) {
      finishHostCall('failed', error);

      // Emit failed progress
      const sc = state.subCalls.find(s => s.id === subCallId);
      if (sc) {
        sc.status = 'failed';
        sc.completedAt = Date.now();
        sc.durationMs = sc.completedAt - sc.startedAt;
        sc.error = error?.message ? String(error.message).slice(0, 100) : 'unknown error';
      }
      emitToolScriptProgress(ctx, state);

      throw error;
    }
  }

  if (functionName === 'request_model_without_context') {
    const prompt = positionalArgs.length > 0 ? positionalArgs[0] : kwargs.prompt;
    if (typeof prompt !== 'string') {
      throw new Error('request_model_without_context requires a string prompt.');
    }
    const model = positionalArgs.length > 1 ? positionalArgs[1] : kwargs.model;
    if (model !== undefined && typeof model !== 'string') {
      throw new Error('request_model_without_context model must be a string when provided.');
    }
    const session = ctx.session || (ctx.sessionId ? await sessionManager.getSession(ctx.sessionId) : null);
    if (!session) {
      throw new Error('request_model_without_context requires a session context.');
    }
    startHostCall();
    try {
      const result = await requestModelWithoutContext(prompt, session, model);
      finishHostCall('completed');
      return normalizeMontyValue(result);
    } catch (error: any) {
      finishHostCall('failed', error);
      throw error;
    }
  }

  if (functionName === 'open_managed_session') {
    const ownerSession = getToolScriptSession(ctx, functionName);
    const targetSessionId = requireStringArg(
      getNamedArg(positionalArgs, kwargs, 0, ['session_id', 'sessionId']),
      'session_id',
    );
    startHostCall(targetSessionId);
    try {
      const result = await managedSessions.openManagedSession({
        sessionId: targetSessionId,
        ownerSessionId: ownerSession.id,
        ...(ctx.toolScriptRunId ? { controllerRunId: ctx.toolScriptRunId } : {}),
      });
      finishHostCall('completed');
      return normalizeMontyValue(result);
    } catch (error: any) {
      finishHostCall('failed', error);
      throw error;
    }
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
    startHostCall(targetSessionId);
    try {
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
      finishHostCall('completed');
      return normalizeMontyValue(safeStepResult);
    } catch (error: any) {
      finishHostCall('failed', error);
      throw error;
    }
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
    startHostCall(targetSessionId);
    try {
      const result = await managedSessions.releaseManagedSession({
        sessionId: targetSessionId,
        ownerSessionId: ownerSession.id,
        leaseId,
        expectedRevision,
        ...(ctx.toolScriptRunId ? { controllerRunId: ctx.toolScriptRunId } : {}),
      });
      finishHostCall('completed');
      return normalizeMontyValue(result);
    } catch (error: any) {
      finishHostCall('failed', error);
      throw error;
    }
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
    startHostCall(targetSessionId);
    const result = {
      __toolscriptWaitForManagedEvent: true,
      sessionId: targetSessionId,
      leaseId,
      ...(expectedRevision !== undefined ? { expectedRevision } : {}),
      ...(runMode ? { runMode } : {}),
      ...(inboxOrder ? { inboxOrder } : {}),
    };
    finishHostCall('completed');
    return result;
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
      record.subCalls = runtimeState.subCalls.map(sc => ({ ...sc }));
      record.hostCallCount = runtimeState.hostCallCount;
      record.lastHostCall = runtimeState.lastHostCall ? structuredClone(runtimeState.lastHostCall) : undefined;
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
      if (shouldPauseForTimeout(record)) {
        record.snapshotBase64 = Buffer.from(progress.dump()).toString('base64');
        markRunWaiting(record, buildTimeoutWaitingState(record, runtimeState, {
          mode: 'return',
          value: normalizeMontyValue(result),
        }), runtimeState);
        await saveRun(record);
        return buildBaseResult(record);
      }
      progress = progress.resume({ returnValue: result });
    } catch (error: any) {
      if (shouldPauseForTimeout(record)) {
        record.snapshotBase64 = Buffer.from(progress.dump()).toString('base64');
        markRunWaiting(record, buildTimeoutWaitingState(record, runtimeState, {
          mode: 'exception',
          exception: {
            type: 'RuntimeError',
            message: error?.message || String(error),
          },
        }), runtimeState);
        await saveRun(record);
        return buildBaseResult(record);
      }
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
  timeoutSecs: number;
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
    scriptName: args.scriptPath === '<inline>' ? 'inline.py' : (path.basename(args.scriptPath) || 'script.py'),
    stdout: '',
    executedTools: [],
    relatedManagedSessions: [],
    hostCallCount: 0,
    timeoutSecs: args.timeoutSecs,
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
  record.subCalls = runtimeState.subCalls.map(sc => ({ ...sc }));
  record.hostCallCount = runtimeState.hostCallCount;
  record.lastHostCall = runtimeState.lastHostCall ? structuredClone(runtimeState.lastHostCall) : undefined;
  record.snapshotBase64 = undefined;
  record.error = normalizeErrorMessage(error, record, runtimeState);
  record.updatedAt = Date.now();
  await saveRun(record);
  logger.warn({
    err: error,
    runId: record.runId,
    filePath: record.scriptPath,
    hostCallCount: runtimeState.hostCallCount,
    lastHostCall: runtimeState.lastHostCall,
    executedTools: runtimeState.executedTools,
  }, logMessage);
  return buildBaseResult(record);
}

async function startRun(record: ToolScriptRunRecord, code: string, scriptArgs: any, ctx: ToolContext): Promise<ToolScriptResult> {
  const monty = await importMonty();
  const runtimeState = createRuntimeState(record.stdout, record.executedTools);
  try {
    const runner = new monty.Monty(buildToolScriptSource(code), { scriptName: record.scriptName, inputs: ['args'] });
    const progress = runner.start({
      inputs: { args: normalizeMontyValue(scriptArgs || {}) },
      limits: buildMontyLimits(record.timeoutSecs ?? DEFAULT_TOOLSCRIPT_TIMEOUT_SECS),
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
    const resumed = resumeValue && typeof resumeValue === 'object' && (resumeValue as any).__toolscriptResumeException
      ? snapshot.resume({ exception: normalizeMontyValue((resumeValue as any).__toolscriptResumeException) })
      : snapshot.resume({ returnValue: normalizeMontyValue(resumeValue) });
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
  const { filePath, code: inlineCode } = args || {};
  const mode = parseToolScriptRunMode(args?.mode ?? args?.runMode ?? args?.background);
  const timeoutSecs = parseTimeoutSecs(args?.timeoutSecs);
  const scriptArgs = resolveObjectArgWithJsonFallback(args, 'args', 'argsJson', { label: 'run_script args' }) || {};

  let scriptPath: string;
  let code: string;

  if (typeof inlineCode === 'string' && inlineCode.trim()) {
    // Inline code mode: pass directly to Monty interpreter
    code = inlineCode;
    scriptPath = '<inline>';
  } else if (filePath && typeof filePath === 'string' && filePath.trim()) {
    const source = await readScriptSource(filePath, ctx, session);
    scriptPath = source.scriptPath;
    code = source.code;
  } else {
    throw new Error('Either filePath or code must be provided.');
  }

  const runId = newRunId();
  const record = createRunRecord({ runId, mode, session, filePath: filePath || '<inline>', scriptPath, timeoutSecs });
  return await startRun(record, code, scriptArgs, { ...ctx, sessionId, session, toolScriptRunId: runId });
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
  if (record.status !== 'waiting' || !record.snapshotBase64 || !record.waiting || (record.waiting.reason !== 'agent' && record.waiting.reason !== 'timeout')) {
    throw new Error(`ToolScript run \`${runId}\` is not waiting for continue_script.`);
  }
  if (record.waiting?.continuationId !== continuationId) {
    throw new Error('continuationId does not match the pending ToolScript continuation.');
  }

  record.timeoutSecs = parseTimeoutSecs(args?.timeoutSecs, record.timeoutSecs ?? DEFAULT_TOOLSCRIPT_TIMEOUT_SECS);
  const stdoutBeforeContinue = record.stdout || '';

  if (record.waiting.reason === 'agent') {
    return withStdoutDelta(
      await resumeRun(record, args?.input, { ...ctx, sessionId, session, toolScriptRunId: runId }, 'ToolScript continue failed'),
      stdoutBeforeContinue,
    );
  }

  if (record.waiting.reason === 'timeout') {
    const pendingResume = record.waiting.timeout?.pendingResume;
    if (!pendingResume) {
      throw new Error(`ToolScript run \`${runId}\` is waiting on timeout but has no pending resume payload.`);
    }
    if (pendingResume.mode === 'return') {
      return withStdoutDelta(
        await resumeRun(record, pendingResume.value, { ...ctx, sessionId, session, toolScriptRunId: runId }, 'ToolScript continue after timeout failed'),
        stdoutBeforeContinue,
      );
    }
    return withStdoutDelta(
      await resumeRun(record, { __toolscriptResumeException: pendingResume.exception }, { ...ctx, sessionId, session, toolScriptRunId: runId }, 'ToolScript continue after timeout failed'),
      stdoutBeforeContinue,
    );
  }

  throw new Error(`ToolScript run \`${runId}\` is not waiting for continue_script.`);
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
