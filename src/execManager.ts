import path from 'path';
import { STATE_DIR, getAgentDir } from './config';
import { logger } from './common';
import * as sessionManager from './sessionManager';
import {
  DEFAULT_EXEC_TIMEOUT_SECONDS,
  MAX_EXEC_TIMEOUT_SECONDS,
  MIN_EXEC_TIMEOUT_SECONDS,
  PersistentExecManager,
  type ExecCompletionDispatcher,
  type ExecStatus,
  type ExecOutputFiles,
  type RunningExecEntry,
  type ProgrammaticExecResult,
  type StartPersistentExecOptions,
} from '../packages/shared/dist/persistentExec';
import { nodeProviderRegistry } from './nodes/providers';
import type { ExecBackend } from '../packages/shared/dist/execBackend';
import { nativeProcessOperations, type ProcessOperations } from '../packages/shared/dist/processOperations';

const RUNNING_EXEC_FILE = path.join(STATE_DIR, 'running-exec.json');

export { DEFAULT_EXEC_TIMEOUT_SECONDS, MIN_EXEC_TIMEOUT_SECONDS, MAX_EXEC_TIMEOUT_SECONDS };
export type { ExecStatus, RunningExecEntry };

export interface InitializeExecManagerOptions {
  completionDispatcher?: ExecCompletionDispatcher;
}

export interface ExecRuntimeOptions {
  getDefaultCwd: (agentName: string) => string;
  getExecTempDir: (agentName: string) => string;
  getAgentDir?: (agentName: string) => string;
  registryPath?: string;
  nodeId?: string;
  completionDispatcher?: ExecCompletionDispatcher;
  processOperations?: ProcessOperations;
  resolveBackend?: (providerId: string, nodeId: string) => ExecBackend;
}

export interface ExecRuntime {
  initialize(options?: InitializeExecManagerOptions): Promise<void>;
  startPersistentExec(options: StartPersistentExecOptions): Promise<RunningExecEntry>;
  waitForExecCompletion(execId: string, timeoutMs: number, signal?: AbortSignal): Promise<ExecStatus | null>;
  markExecForBackgroundNotification(execId: string): Promise<RunningExecEntry | null>;
  finalizeForegroundExec(execId: string): Promise<void>;
  buildProgrammaticExecResult(entry: RunningExecEntry, status: ExecStatus | null, output: string, files?: ExecOutputFiles): Promise<ProgrammaticExecResult>;
  buildForegroundExecResult(entry: RunningExecEntry, status: ExecStatus, warning?: string, files?: ExecOutputFiles): Promise<string>;
  buildBackgroundTimeoutResult(entry: RunningExecEntry, timeoutSeconds?: number, warning?: string, waitEndedBy?: string, files?: ExecOutputFiles): Promise<string>;
  readFinishedExecWorkingDirectory(entry: RunningExecEntry): Promise<string | null>;
  readLiveExecWorkingDirectory(entry: RunningExecEntry): Promise<string | null>;
  listRunningExecs(): RunningExecEntry[];
  reconcileNow(): Promise<void>;
  shutdown(): Promise<void>;
}

export function createExecRuntime(options: ExecRuntimeOptions): ExecRuntime {
  let completionDispatcher: ExecCompletionDispatcher = options.completionDispatcher || (async () => {});
  const nodeId = options.nodeId || 'master';
  const manager = new PersistentExecManager({
    getDefaultCwd: options.getDefaultCwd,
    getExecTempDir: options.getExecTempDir,
    getAgentDir: options.getAgentDir,
    registryPath: options.registryPath,
    nodeId,
    logger,
    completionDispatcher: async (entry, status, message) => completionDispatcher(entry, status, message),
    resolveBackend: options.resolveBackend,
    processOperations: options.processOperations || nativeProcessOperations,
  });

  return {
    async initialize(initializeOptions) {
      if (initializeOptions?.completionDispatcher) completionDispatcher = initializeOptions.completionDispatcher;
      await manager.initialize();
    },
    startPersistentExec: options => manager.startPersistentExec({ ...options, nodeId: options.nodeId || nodeId }),
    waitForExecCompletion: (execId, timeoutMs, signal) => manager.waitForExecCompletion(execId, timeoutMs, signal),
    markExecForBackgroundNotification: execId => manager.markExecForBackgroundNotification(execId),
    finalizeForegroundExec: execId => manager.finalizeForegroundExec(execId),
    buildProgrammaticExecResult: (entry, status, output, files) => manager.buildProgrammaticExecResult(entry, status, output, files),
    buildForegroundExecResult: (entry, status, warning, files) => manager.buildForegroundExecResult(entry, status, warning, files),
    buildBackgroundTimeoutResult: (entry, timeoutSeconds = DEFAULT_EXEC_TIMEOUT_SECONDS, warning, waitEndedBy, files) => manager.buildBackgroundTimeoutResult(entry, timeoutSeconds, warning, waitEndedBy, files),
    readFinishedExecWorkingDirectory: entry => manager.readFinishedExecWorkingDirectory(entry),
    readLiveExecWorkingDirectory: entry => manager.readLiveExecWorkingDirectory(entry),
    listRunningExecs: () => manager.listRunningExecs(),
    reconcileNow: () => manager.reconcileNow(),
    shutdown: () => manager.shutdown(),
  };
}

const defaultCompletionDispatcher: ExecCompletionDispatcher = async (entry, _status, message) => {
  if (!entry.sessionId) {
    return;
  }
  await sessionManager.queueSessionSystemEvent(entry.sessionId, message, 'background', `exec-completion:${entry.id}`, Date.parse(_status.finishedAt), entry.id);
};

const defaultRuntime = createExecRuntime({
  resolveBackend: (providerId, nodeId) => nodeProviderRegistry.execBackend(providerId, nodeId),
  getDefaultCwd: (agentName: string) => getAgentDir(agentName),
  getExecTempDir: (agentName: string) => path.join(getAgentDir(agentName), '.temp', 'exec'),
  getAgentDir,
  registryPath: RUNNING_EXEC_FILE,
  nodeId: 'master',
  completionDispatcher: defaultCompletionDispatcher,
});

export function getDefaultExecRuntime(): ExecRuntime {
  return defaultRuntime;
}

export async function initializeExecManager(options?: InitializeExecManagerOptions): Promise<void> {
  await defaultRuntime.initialize(options);
}

export async function startPersistentExec(options: StartPersistentExecOptions): Promise<RunningExecEntry> {
  return await defaultRuntime.startPersistentExec(options);
}

export async function waitForExecCompletion(execId: string, timeoutMs: number, signal?: AbortSignal): Promise<ExecStatus | null> {
  return await defaultRuntime.waitForExecCompletion(execId, timeoutMs, signal);
}

export async function markExecForBackgroundNotification(execId: string): Promise<RunningExecEntry | null> {
  return await defaultRuntime.markExecForBackgroundNotification(execId);
}

export async function finalizeForegroundExec(execId: string): Promise<void> {
  await defaultRuntime.finalizeForegroundExec(execId);
}

export async function buildProgrammaticExecResult(entry: RunningExecEntry, status: ExecStatus | null, output: string, files?: ExecOutputFiles): Promise<ProgrammaticExecResult> {
  return defaultRuntime.buildProgrammaticExecResult(entry, status, output, files);
}

export async function buildForegroundExecResult(entry: RunningExecEntry, status: ExecStatus, warning?: string, files?: ExecOutputFiles): Promise<string> {
  return await defaultRuntime.buildForegroundExecResult(entry, status, warning, files);
}

export async function buildBackgroundTimeoutResult(entry: RunningExecEntry, timeoutSeconds: number = DEFAULT_EXEC_TIMEOUT_SECONDS, warning?: string, waitEndedBy?: string, files?: ExecOutputFiles): Promise<string> {
  return await defaultRuntime.buildBackgroundTimeoutResult(entry, timeoutSeconds, warning, waitEndedBy, files);
}

export async function readFinishedExecWorkingDirectory(entry: RunningExecEntry): Promise<string | null> {
  return await defaultRuntime.readFinishedExecWorkingDirectory(entry);
}

export async function readLiveExecWorkingDirectory(entry: RunningExecEntry): Promise<string | null> {
  return await defaultRuntime.readLiveExecWorkingDirectory(entry);
}

export function listRunningExecs(): RunningExecEntry[] {
  return defaultRuntime.listRunningExecs();
}
