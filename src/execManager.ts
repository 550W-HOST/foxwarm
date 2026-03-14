import crypto from 'crypto';
import fs from 'fs-extra';
import path from 'path';
import { ChildProcess, spawn } from 'child_process';
import { promises as fsp } from 'fs';
import { STATE_DIR, getAgentDir } from './config';
import { logger } from './common';
import { estimateTokenCount } from './tokenCount';
import { formatTime, getDatedLogPath } from './logRotation';
import * as sessionManager from './sessionManager';

const RUNNING_EXEC_FILE = path.join(STATE_DIR, 'running-exec.json');
const RECONCILE_INTERVAL_MS = 5000;
const STATUS_POLL_INTERVAL_MS = 250;
const MISSING_STATUS_GRACE_MS = 3000;
const PARTIAL_LOG_BYTES = 4000;
const INLINE_LOG_LIMIT_BYTES = 20000;
const INLINE_EXCERPT_HALF_BYTES = 5000;

export interface ExecStatus {
  exitCode: number | null;
  finishedAt: string;
  error?: string;
}

export interface RunningExecEntry {
  id: string;
  pid: number;
  sessionId?: string;
  agentName: string;
  nodeId: string;
  command: string;
  logPath: string;
  statusPath: string;
  startedAt: number;
  notifyOnCompletion: boolean;
  recoveredAfterRestart?: boolean;
}

interface InitializeExecManagerOptions {
  completionDispatcher?: ExecCompletionDispatcher;
}

interface StartPersistentExecOptions {
  command: string;
  sessionId?: string;
  agentName?: string;
  nodeId?: string;
}

type ExecCompletionDispatcher = (entry: RunningExecEntry, status: ExecStatus, message: string) => Promise<void>;

const runningExecs = new Map<string, RunningExecEntry>();
let initialized = false;
let reconcileTimer: NodeJS.Timeout | null = null;
let reconcileChain: Promise<void> = Promise.resolve();

let completionDispatcher: ExecCompletionDispatcher = async (entry, _status, message) => {
  if (!entry.sessionId) {
    return;
  }
  await sessionManager.queueSessionSystemEvent(entry.sessionId, message, 'background');
};

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function escapeInlineCode(text: string): string {
  return text.replace(/`/g, '\\`');
}

function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    if (err?.code === 'EPERM') {
      return true;
    }
    return false;
  }
}

async function saveRunningExecs(): Promise<void> {
  await fs.ensureDir(path.dirname(RUNNING_EXEC_FILE));
  const tempPath = `${RUNNING_EXEC_FILE}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;

  try {
    await fs.writeJson(tempPath, {
      execs: Array.from(runningExecs.values()),
    }, { spaces: 2 });
    await fs.rename(tempPath, RUNNING_EXEC_FILE);
  } catch (err) {
    await fs.remove(tempPath).catch(() => {});
    throw err;
  }
}

async function loadRunningExecs(): Promise<void> {
  runningExecs.clear();

  try {
    const data = await fs.readJson(RUNNING_EXEC_FILE);
    const rawExecs = Array.isArray(data?.execs) ? data.execs : [];

    for (const raw of rawExecs) {
      if (!raw || typeof raw !== 'object') continue;
      if (typeof raw.id !== 'string' || typeof raw.logPath !== 'string' || typeof raw.statusPath !== 'string') continue;
      if (!Number.isFinite(Number(raw.pid)) || !Number.isFinite(Number(raw.startedAt))) continue;

      const entry: RunningExecEntry = {
        id: raw.id,
        pid: Number(raw.pid),
        sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : undefined,
        agentName: typeof raw.agentName === 'string' && raw.agentName.trim().length > 0 ? raw.agentName : 'main',
        nodeId: typeof raw.nodeId === 'string' && raw.nodeId.trim().length > 0 ? raw.nodeId : 'master',
        command: typeof raw.command === 'string' ? raw.command : '',
        logPath: raw.logPath,
        statusPath: raw.statusPath,
        startedAt: Number(raw.startedAt),
        notifyOnCompletion: raw.notifyOnCompletion === true,
        recoveredAfterRestart: raw.recoveredAfterRestart === true,
      };
      runningExecs.set(entry.id, entry);
    }
  } catch (err: any) {
    if (err?.code !== 'ENOENT') {
      logger.error({ err }, 'Failed to load running exec registry');
    }
  }
}

async function removeRunningExec(id: string): Promise<void> {
  if (!runningExecs.delete(id)) {
    return;
  }
  await saveRunningExecs();
}

async function updateRunningExec(id: string, updates: Partial<RunningExecEntry>): Promise<RunningExecEntry | null> {
  const current = runningExecs.get(id);
  if (!current) {
    return null;
  }

  const updated: RunningExecEntry = {
    ...current,
    ...updates,
  };
  runningExecs.set(id, updated);
  await saveRunningExecs();
  return updated;
}

function buildWrapperScript(): string {
  return [
    'set +e',
    'eval "$FOXWARM_EXEC_COMMAND"',
    'exit_code=$?',
    'finished_at="$(date -u +"%Y-%m-%dT%H:%M:%S.%3NZ")"',
    'tmp_path="${FOXWARM_EXEC_STATUS_PATH}.tmp.$$"',
    'printf "{\\"exitCode\\":%s,\\"finishedAt\\":\\"%s\\"}\\n" "$exit_code" "$finished_at" > "$tmp_path"',
    'mv "$tmp_path" "$FOXWARM_EXEC_STATUS_PATH"',
    'exit 0',
  ].join('\n');
}

async function readWindow(filePath: string, offset: number, length: number): Promise<Buffer> {
  const file = await fsp.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await file.read(buffer, 0, length, offset);
    return buffer.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}

async function readLogExcerpt(filePath: string, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const stat = await fs.stat(filePath);
  if (stat.size <= 0) {
    return { text: '', truncated: false };
  }

  if (stat.size <= maxBytes) {
    return {
      text: await fs.readFile(filePath, 'utf8'),
      truncated: false,
    };
  }

  const half = Math.max(1, Math.floor(maxBytes / 2));
  const [head, tail] = await Promise.all([
    readWindow(filePath, 0, half),
    readWindow(filePath, Math.max(0, stat.size - half), half),
  ]);

  return {
    text: `${head.toString('utf8')}\n\n[...TRUNCATED...]\n\n${tail.toString('utf8')}`,
    truncated: true,
  };
}

async function readPartialLog(logPath: string): Promise<string> {
  try {
    const excerpt = await readLogExcerpt(logPath, PARTIAL_LOG_BYTES);
    const text = excerpt.text.trim();
    if (!text) {
      return '(Command started, no output yet)';
    }
    return excerpt.truncated ? `${text}\n...(truncated)` : text;
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      return '(Command started, no output yet)';
    }
    throw err;
  }
}

async function readDisplayOutput(logPath: string): Promise<{ text: string; truncated: boolean }> {
  try {
    const excerpt = await readLogExcerpt(logPath, INLINE_LOG_LIMIT_BYTES);
    if (!excerpt.text.trim()) {
      return { text: '(No output)', truncated: false };
    }

    if (!excerpt.truncated && estimateTokenCount(excerpt.text) <= 10000) {
      return excerpt;
    }

    if (excerpt.truncated) {
      return {
        text: `[OUTPUT TOO LONG]\n${excerpt.text}`,
        truncated: true,
      };
    }

    return {
      text: `[OUTPUT TOO LONG]\n${excerpt.text.substring(0, INLINE_EXCERPT_HALF_BYTES)}\n\n[...TRUNCATED...]\n\n${excerpt.text.substring(Math.max(0, excerpt.text.length - INLINE_EXCERPT_HALF_BYTES))}`,
      truncated: true,
    };
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      return { text: '(No output)', truncated: false };
    }
    throw err;
  }
}

async function readExecStatus(statusPath: string): Promise<ExecStatus | null> {
  try {
    const raw = await fs.readJson(statusPath);
    return {
      exitCode: typeof raw?.exitCode === 'number' ? raw.exitCode : null,
      finishedAt: typeof raw?.finishedAt === 'string' && raw.finishedAt ? raw.finishedAt : new Date().toISOString(),
      error: typeof raw?.error === 'string' ? raw.error : undefined,
    };
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

async function ensureFallbackStatus(entry: RunningExecEntry): Promise<ExecStatus | null> {
  const existing = await readExecStatus(entry.statusPath);
  if (existing) {
    return existing;
  }

  if (isPidRunning(entry.pid)) {
    return null;
  }

  if (Date.now() - entry.startedAt < MISSING_STATUS_GRACE_MS) {
    return null;
  }

  const fallback: ExecStatus = {
    exitCode: null,
    finishedAt: new Date().toISOString(),
    error: 'Process exited but no status file was written.',
  };

  const tempPath = `${entry.statusPath}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  await fs.writeJson(tempPath, fallback);
  await fs.rename(tempPath, entry.statusPath);
  return fallback;
}

function buildCompletionMessage(entry: RunningExecEntry, status: ExecStatus): string {
  const exitText = status.exitCode === null ? 'unknown' : String(status.exitCode);
  const nodeLine = entry.nodeId && entry.nodeId !== 'master' ? `\nNode: \`${entry.nodeId}\`` : '';
  const errorLine = status.error ? `\nError: ${status.error}` : '';
  return `Background Process Finished\ncommand: \`${escapeInlineCode(entry.command)}\`${nodeLine}\nExit code: ${exitText}${errorLine}\nFull output in ${entry.logPath}`;
}

async function reconcileRunningExecs(): Promise<void> {
  for (const entry of Array.from(runningExecs.values())) {
    if (!entry.notifyOnCompletion) {
      continue;
    }

    let status: ExecStatus | null = null;
    try {
      status = await ensureFallbackStatus(entry);
    } catch (err) {
      logger.error({ err, execId: entry.id, statusPath: entry.statusPath }, 'Failed to inspect exec status');
      continue;
    }

    if (!status) {
      continue;
    }

    const message = buildCompletionMessage(entry, status);
    try {
      await completionDispatcher(entry, status, message);
      await removeRunningExec(entry.id);
      logger.info({ execId: entry.id, pid: entry.pid, sessionId: entry.sessionId }, 'Delivered background exec completion');
    } catch (err) {
      logger.warn({ err, execId: entry.id, sessionId: entry.sessionId }, 'Failed to deliver background exec completion; will retry');
    }
  }
}

function scheduleReconcile(): void {
  if (reconcileTimer) {
    clearInterval(reconcileTimer);
  }

  reconcileTimer = setInterval(() => {
    void queueReconcile();
  }, RECONCILE_INTERVAL_MS);
  reconcileTimer.unref?.();
}

async function queueReconcile(): Promise<void> {
  reconcileChain = reconcileChain.then(async () => {
    await reconcileRunningExecs();
  }).catch((err) => {
    logger.error({ err }, 'Exec reconcile loop failed');
  });
  await reconcileChain;
}

export async function initializeExecManager(options?: InitializeExecManagerOptions): Promise<void> {
  if (options?.completionDispatcher) {
    completionDispatcher = options.completionDispatcher;
  }

  if (initialized) {
    return;
  }

  await loadRunningExecs();

  let changed = false;
  for (const [id, entry] of runningExecs.entries()) {
    if (!entry.notifyOnCompletion) {
      runningExecs.set(id, {
        ...entry,
        notifyOnCompletion: true,
        recoveredAfterRestart: true,
      });
      changed = true;
    }
  }

  if (changed) {
    await saveRunningExecs();
  }

  scheduleReconcile();
  initialized = true;

  logger.info({ execCount: runningExecs.size }, 'Exec manager initialized');
  await queueReconcile();
}

export async function startPersistentExec(options: StartPersistentExecOptions): Promise<RunningExecEntry> {
  const command = String(options.command || '');
  const agentName = options.agentName || 'main';
  const nodeId = options.nodeId || 'master';
  const sessionId = options.sessionId;
  const agentDir = getAgentDir(agentName);
  const tempDir = path.join(agentDir, '.temp', 'exec');

  await fs.ensureDir(tempDir);
  const execId = `exec_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const logFileName = `${execId}_${formatTime()}.log`;
  const logPath = await getDatedLogPath(tempDir, logFileName);
  const statusPath = `${logPath}.exit.json`;
  const logHandle = await fsp.open(logPath, 'a');

  let child: ChildProcess;
  try {
    child = spawn('bash', ['-lc', buildWrapperScript()], {
      cwd: agentDir,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        FOXWARM_EXEC_COMMAND: command,
        FOXWARM_EXEC_STATUS_PATH: statusPath,
      },
      stdio: ['ignore', logHandle.fd, logHandle.fd],
      detached: true,
      shell: false,
    });

    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve());
      child.once('error', reject);
    });
  } finally {
    await logHandle.close().catch(() => {});
  }

  child.unref();

  if (!child.pid) {
    throw new Error('Failed to start background process: missing pid');
  }

  const entry: RunningExecEntry = {
    id: execId,
    pid: child.pid,
    sessionId,
    agentName,
    nodeId,
    command,
    logPath,
    statusPath,
    startedAt: Date.now(),
    notifyOnCompletion: false,
  };

  runningExecs.set(entry.id, entry);
  await saveRunningExecs();

  logger.info({ execId: entry.id, pid: entry.pid, sessionId, nodeId }, 'Persistent exec started');
  return entry;
}

export async function waitForExecCompletion(execId: string, timeoutMs: number): Promise<ExecStatus | null> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const entry = runningExecs.get(execId);
    if (!entry) {
      return null;
    }

    const status = await ensureFallbackStatus(entry);
    if (status) {
      return status;
    }

    await sleep(STATUS_POLL_INTERVAL_MS);
  }

  return null;
}

export async function markExecForBackgroundNotification(execId: string): Promise<RunningExecEntry | null> {
  return await updateRunningExec(execId, { notifyOnCompletion: true });
}

export async function finalizeForegroundExec(execId: string): Promise<void> {
  await removeRunningExec(execId);
}

export async function buildForegroundExecResult(entry: RunningExecEntry, status: ExecStatus): Promise<string> {
  const output = await readDisplayOutput(entry.logPath);
  const prefix = status.exitCode !== null && status.exitCode !== 0
    ? `Exit code: ${status.exitCode}${status.error ? `\nError: ${status.error}` : ''}\n`
    : status.error
      ? `Error: ${status.error}\n`
      : '';

  if (output.truncated) {
    return `${prefix}${output.text}\n\nFull output saved to: ${entry.logPath}`;
  }

  return `${prefix}${output.text}`.trim() || '(No output)';
}

export async function buildBackgroundTimeoutResult(entry: RunningExecEntry): Promise<string> {
  const partialOutput = await readPartialLog(entry.logPath);
  return `[Process running longer than 10s, switched to background. The system will send a notification message when done. STOP calling tools to check status. Wait for notification (unless working on other tasks in parallel).]\nPID: ${entry.pid}\nLog file: ${entry.logPath}\n\nPartial Output:\n${partialOutput}`;
}

export function listRunningExecs(): RunningExecEntry[] {
  return Array.from(runningExecs.values());
}