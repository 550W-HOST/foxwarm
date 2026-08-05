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
  type RunningExecEntry,
  type StartPersistentExecOptions,
} from '../packages/shared/dist/persistentExec';

const RUNNING_EXEC_FILE = path.join(STATE_DIR, 'running-exec.json');

export { DEFAULT_EXEC_TIMEOUT_SECONDS, MIN_EXEC_TIMEOUT_SECONDS, MAX_EXEC_TIMEOUT_SECONDS };
export type { ExecStatus, RunningExecEntry };

export interface InitializeExecManagerOptions {
  completionDispatcher?: ExecCompletionDispatcher;
}

export interface ExecRuntimeOptions {
  getDefaultCwd: (agentName: string) => string;
  getExecTempDir: (agentName: string) => string;
  registryPath?: string;
  nodeId?: string;
  completionDispatcher?: ExecCompletionDispatcher;
}

export interface ExecRuntime {
  initialize(options?: InitializeExecManagerOptions): Promise<void>;
  startPersistentExec(options: StartPersistentExecOptions): Promise<RunningExecEntry>;
  waitForExecCompletion(execId: string, timeoutMs: number): Promise<ExecStatus | null>;
  markExecForBackgroundNotification(execId: string): Promise<RunningExecEntry | null>;
  finalizeForegroundExec(execId: string): Promise<void>;
  buildForegroundExecResult(entry: RunningExecEntry, status: ExecStatus, warning?: string): Promise<string>;
  buildBackgroundTimeoutResult(entry: RunningExecEntry, timeoutSeconds?: number, warning?: string): Promise<string>;
  readFinishedExecWorkingDirectory(entry: RunningExecEntry): Promise<string | null>;
  readLiveExecWorkingDirectory(entry: RunningExecEntry): Promise<string | null>;
  listRunningExecs(): RunningExecEntry[];
}

export function createExecRuntime(options: ExecRuntimeOptions): ExecRuntime {
  let completionDispatcher: ExecCompletionDispatcher = options.completionDispatcher || (async () => {});
  const nodeId = options.nodeId || 'master';
  const manager = new PersistentExecManager({
    getDefaultCwd: options.getDefaultCwd,
    getExecTempDir: options.getExecTempDir,
    registryPath: options.registryPath,
    nodeId,
    logger,
    completionDispatcher: async (entry, status, message) => completionDispatcher(entry, status, message),
  });

  return {
    async initialize(initializeOptions) {
      if (initializeOptions?.completionDispatcher) completionDispatcher = initializeOptions.completionDispatcher;
      await manager.initialize();
    },
    startPersistentExec: options => manager.startPersistentExec({ ...options, nodeId: options.nodeId || nodeId }),
    waitForExecCompletion: (execId, timeoutMs) => manager.waitForExecCompletion(execId, timeoutMs),
    markExecForBackgroundNotification: execId => manager.markExecForBackgroundNotification(execId),
    finalizeForegroundExec: execId => manager.finalizeForegroundExec(execId),
    buildForegroundExecResult: (entry, status, warning) => manager.buildForegroundExecResult(entry, status, warning),
    buildBackgroundTimeoutResult: (entry, timeoutSeconds = DEFAULT_EXEC_TIMEOUT_SECONDS, warning) => manager.buildBackgroundTimeoutResult(entry, timeoutSeconds, warning),
    readFinishedExecWorkingDirectory: entry => manager.readFinishedExecWorkingDirectory(entry),
    readLiveExecWorkingDirectory: entry => manager.readLiveExecWorkingDirectory(entry),
    listRunningExecs: () => manager.listRunningExecs(),
  };
}

const defaultCompletionDispatcher: ExecCompletionDispatcher = async (entry, _status, message) => {
  if (!entry.sessionId) {
    return;
  }
  await sessionManager.queueSessionSystemEvent(entry.sessionId, message, 'background');
};

const defaultRuntime = createExecRuntime({
  getDefaultCwd: (agentName: string) => getAgentDir(agentName),
  getExecTempDir: (agentName: string) => path.join(getAgentDir(agentName), '.temp', 'exec'),
  registryPath: RUNNING_EXEC_FILE,
  nodeId: 'master',
  completionDispatcher: defaultCompletionDispatcher,
});

export async function initializeExecManager(options?: InitializeExecManagerOptions): Promise<void> {
  await defaultRuntime.initialize(options);
}

export async function startPersistentExec(options: StartPersistentExecOptions): Promise<RunningExecEntry> {
  return await defaultRuntime.startPersistentExec(options);
}

export async function waitForExecCompletion(execId: string, timeoutMs: number): Promise<ExecStatus | null> {
  return await defaultRuntime.waitForExecCompletion(execId, timeoutMs);
}

export async function markExecForBackgroundNotification(execId: string): Promise<RunningExecEntry | null> {
  return await defaultRuntime.markExecForBackgroundNotification(execId);
}

export async function finalizeForegroundExec(execId: string): Promise<void> {
  await defaultRuntime.finalizeForegroundExec(execId);
}

export async function buildForegroundExecResult(entry: RunningExecEntry, status: ExecStatus, warning?: string): Promise<string> {
  return await defaultRuntime.buildForegroundExecResult(entry, status, warning);
}

export async function buildBackgroundTimeoutResult(entry: RunningExecEntry, timeoutSeconds: number = DEFAULT_EXEC_TIMEOUT_SECONDS, warning?: string): Promise<string> {
  return await defaultRuntime.buildBackgroundTimeoutResult(entry, timeoutSeconds, warning);
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
