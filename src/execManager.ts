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

interface InitializeExecManagerOptions {
  completionDispatcher?: ExecCompletionDispatcher;
}

let completionDispatcher: ExecCompletionDispatcher = async (entry, _status, message) => {
  if (!entry.sessionId) {
    return;
  }
  await sessionManager.queueSessionSystemEvent(entry.sessionId, message, 'background');
};

const manager = new PersistentExecManager({
  getDefaultCwd: (agentName: string) => getAgentDir(agentName),
  getExecTempDir: (agentName: string) => path.join(getAgentDir(agentName), '.temp', 'exec'),
  registryPath: RUNNING_EXEC_FILE,
  nodeId: 'master',
  logger,
  completionDispatcher: async (entry, status, message) => {
    await completionDispatcher(entry, status, message);
  },
});

export async function initializeExecManager(options?: InitializeExecManagerOptions): Promise<void> {
  if (options?.completionDispatcher) {
    completionDispatcher = options.completionDispatcher;
  }
  await manager.initialize();
}

export async function startPersistentExec(options: StartPersistentExecOptions): Promise<RunningExecEntry> {
  return await manager.startPersistentExec({ ...options, nodeId: options.nodeId || 'master' });
}

export async function waitForExecCompletion(execId: string, timeoutMs: number): Promise<ExecStatus | null> {
  return await manager.waitForExecCompletion(execId, timeoutMs);
}

export async function markExecForBackgroundNotification(execId: string): Promise<RunningExecEntry | null> {
  return await manager.markExecForBackgroundNotification(execId);
}

export async function finalizeForegroundExec(execId: string): Promise<void> {
  await manager.finalizeForegroundExec(execId);
}

export async function buildForegroundExecResult(entry: RunningExecEntry, status: ExecStatus, warning?: string): Promise<string> {
  return await manager.buildForegroundExecResult(entry, status, warning);
}

export async function buildBackgroundTimeoutResult(entry: RunningExecEntry, timeoutSeconds: number = DEFAULT_EXEC_TIMEOUT_SECONDS, warning?: string): Promise<string> {
  return await manager.buildBackgroundTimeoutResult(entry, timeoutSeconds, warning);
}

export async function readFinishedExecWorkingDirectory(entry: RunningExecEntry): Promise<string | null> {
  return await manager.readFinishedExecWorkingDirectory(entry);
}

export async function readLiveExecWorkingDirectory(entry: RunningExecEntry): Promise<string | null> {
  return await manager.readLiveExecWorkingDirectory(entry);
}

export function listRunningExecs(): RunningExecEntry[] {
  return manager.listRunningExecs();
}
