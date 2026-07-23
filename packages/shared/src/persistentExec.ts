import crypto from 'crypto';
import fs from 'fs-extra';
import path from 'path';
import { ChildProcess, spawn } from 'child_process';
import { promises as fsp } from 'fs';
import { resolveValidatedExecCwd, type ExecCwdSource } from './execCwd';
import { truncateOutputForDisplay, type OutputTruncationResult } from './outputTruncation';
import { estimateTokenCount } from './tokenCount';

export const DEFAULT_EXEC_TIMEOUT_SECONDS = 15;
export const MIN_EXEC_TIMEOUT_SECONDS = 1;
export const MAX_EXEC_TIMEOUT_SECONDS = 60;

export interface ResolvedExecTimeout {
  requestedSeconds: number;
  effectiveSeconds: number;
  warning?: string;
}

export function resolveExecTimeoutSeconds(timeoutValue: unknown): ResolvedExecTimeout {
  if (timeoutValue === undefined || timeoutValue === null) {
    return {
      requestedSeconds: DEFAULT_EXEC_TIMEOUT_SECONDS,
      effectiveSeconds: DEFAULT_EXEC_TIMEOUT_SECONDS,
    };
  }
  if (typeof timeoutValue !== 'number' || !Number.isFinite(timeoutValue)) {
    throw new Error(`timeout must be a number between ${MIN_EXEC_TIMEOUT_SECONDS} and ${MAX_EXEC_TIMEOUT_SECONDS} seconds`);
  }
  if (timeoutValue < MIN_EXEC_TIMEOUT_SECONDS) {
    throw new Error(`timeout must be between ${MIN_EXEC_TIMEOUT_SECONDS} and ${MAX_EXEC_TIMEOUT_SECONDS} seconds`);
  }
  if (timeoutValue > MAX_EXEC_TIMEOUT_SECONDS) {
    return {
      requestedSeconds: timeoutValue,
      effectiveSeconds: MAX_EXEC_TIMEOUT_SECONDS,
      warning: `WARNING: Requested timeout ${formatExecTimeoutSeconds(timeoutValue)}s exceeds the ${MAX_EXEC_TIMEOUT_SECONDS}s maximum; using ${MAX_EXEC_TIMEOUT_SECONDS}s.`,
    };
  }
  return { requestedSeconds: timeoutValue, effectiveSeconds: timeoutValue };
}

const RECONCILE_INTERVAL_MS = 5000;
const STATUS_POLL_INTERVAL_MS = 250;
const MISSING_STATUS_GRACE_MS = 3000;
const PARTIAL_LOG_BYTES = 4000;
const INLINE_LOG_LIMIT_BYTES = 20000;
const INLINE_EXCERPT_HALF_BYTES = 5000;
const EXEC_PATHS_WAIT_TIMEOUT_MS = 1000;
const EXEC_PATHS_POLL_INTERVAL_MS = 25;
const BACKGROUND_COMMAND_PREVIEW_LIMIT = 100;

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
  initialCwd: string;
  cwdRaw?: string;
  cwdSource?: ExecCwdSource;
  logPath: string;
  statusPath: string;
  cwdPath: string;
  startedAt: number;
  notifyOnCompletion: boolean;
  recoveredAfterRestart?: boolean;
}

export interface StartPersistentExecOptions {
  command: string;
  sessionId?: string;
  agentName?: string;
  nodeId?: string;
  cwd?: unknown;
  sessionCwd?: unknown;
}

interface ResolvedExecPaths {
  logPath: string;
  statusPath: string;
  cwdPath: string;
}

export type ExecCompletionDispatcher = (entry: RunningExecEntry, status: ExecStatus, message: string) => Promise<void>;

export interface PersistentExecManagerOptions {
  getDefaultCwd: (agentName: string) => string;
  getExecTempDir: (agentName: string) => string;
  registryPath?: string;
  nodeId?: string;
  completionDispatcher?: ExecCompletionDispatcher;
  logger?: {
    info?: (payload?: any, message?: string) => void;
    warn?: (payload?: any, message?: string) => void;
    error?: (payload?: any, message?: string) => void;
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function escapeInlineCode(text: string): string {
  return text.replace(/`/g, '\\`');
}

function summarizeCommandForNotification(text: string, maxLength: number = BACKGROUND_COMMAND_PREVIEW_LIMIT): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength)}...`;
}

function formatExecTimeoutSeconds(seconds: number): string {
  return Number.isInteger(seconds) ? String(seconds) : String(seconds);
}

function buildBackgroundTimeoutShortNotice(timeoutSeconds: number): string {
  return `[Process running longer than ${formatExecTimeoutSeconds(timeoutSeconds)}s]`;
}

function buildBackgroundTimeoutFullNotice(timeoutSeconds: number): string {
  const shortNotice = buildBackgroundTimeoutShortNotice(timeoutSeconds);
  return `${shortNotice} Switched to background. The system will send a notification message when done. STOP calling tools to check status. Wait for notification (unless working on other tasks in parallel).`;
}

function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === 'EPERM';
  }
}

function buildStatusWriterInvocationPosix(): string {
  return `"$FOXWARM_EXEC_NODE_PATH" -e 'const fs = require("fs"); const statusPath = process.argv[1]; const rawExitCode = process.argv[2]; const exitCode = rawExitCode === "null" ? null : Number(rawExitCode); fs.writeFileSync(statusPath, JSON.stringify({ exitCode, finishedAt: new Date().toISOString() }) + "\\n");'`;
}

function buildManagedExecScript(command: string): string {
  if (process.platform === 'win32') {
    return [
      '$ErrorActionPreference = "Continue"',
      'chcp 65001 | Out-Null',
      '$basePath = Join-Path $env:FOXWARM_EXEC_LOG_DIR ("{0}_pid{1}" -f $env:FOXWARM_EXEC_TIME_TOKEN, $PID)',
      '$index = 0',
      'while ($true) {',
      '  if ($index -eq 0) {',
      '    $logPath = "$basePath.log"',
      '  } else {',
      '    $logPath = "${basePath}_$index.log"',
      '  }',
      '  $statusPath = "$logPath.exit.json"',
      '  $cwdPath = "$logPath.cwd.txt"',
      '  if (!(Test-Path -LiteralPath $logPath) -and !(Test-Path -LiteralPath $statusPath) -and !(Test-Path -LiteralPath $cwdPath)) { break }',
      '  $index += 1',
      '}',
      '$pathsTmp = "$env:FOXWARM_EXEC_PATHS_PATH.tmp.$PID"',
      '$paths = @{ logPath = $logPath; statusPath = $statusPath; cwdPath = $cwdPath } | ConvertTo-Json -Compress',
      'Set-Content -LiteralPath $pathsTmp -Value $paths',
      'Move-Item -LiteralPath $pathsTmp -Destination $env:FOXWARM_EXEC_PATHS_PATH -Force',
      'Start-Transcript -LiteralPath $logPath -Append | Out-Null',
      '$global:LASTEXITCODE = $null',
      '$foxwarmExecSucceeded = $true',
      'try {',
      '  & $env:FOXWARM_EXEC_COMMAND_PATH',
      '  $foxwarmExecSucceeded = $?',
      '} catch {',
      '  Write-Error $_',
      '  $foxwarmExecSucceeded = $false',
      '}',
      'if ($null -ne $global:LASTEXITCODE) {',
      '  $EXIT_CODE = [int]$global:LASTEXITCODE',
      '} elseif ($foxwarmExecSucceeded) {',
      '  $EXIT_CODE = 0',
      '} else {',
      '  $EXIT_CODE = 1',
      '}',
      '$cwdTmp = "$cwdPath.tmp.$PID"',
      '$statusTmp = "$statusPath.tmp.$PID"',
      '(Get-Location).Path | Set-Content -LiteralPath $cwdTmp -NoNewline',
      'Move-Item -LiteralPath $cwdTmp -Destination $cwdPath -Force',
      '$status = @{ exitCode = $EXIT_CODE; finishedAt = [DateTime]::UtcNow.ToString("o") } | ConvertTo-Json -Compress',
      'Set-Content -LiteralPath $statusTmp -Value $status',
      'Move-Item -LiteralPath $statusTmp -Destination $statusPath -Force',
      'Stop-Transcript | Out-Null',
      'exit $EXIT_CODE',
    ].join('\r\n');
  }

  return [
    '#!/usr/bin/env bash',
    'set +e',
    'foxwarm_exec_choose_paths() {',
    '  base_path="${FOXWARM_EXEC_LOG_DIR}/${FOXWARM_EXEC_TIME_TOKEN}_pid$$"',
    '  index=0',
    '  while :; do',
    '    if [ "$index" -eq 0 ]; then',
    '      log_path="${base_path}.log"',
    '    else',
    '      log_path="${base_path}_${index}.log"',
    '    fi',
    '    status_path="${log_path}.exit.json"',
    '    cwd_path="${log_path}.cwd.txt"',
    '    if [ ! -e "$log_path" ] && [ ! -e "$status_path" ] && [ ! -e "$cwd_path" ]; then',
    '      break',
    '    fi',
    '    index=$((index + 1))',
    '  done',
    '  export FOXWARM_EXEC_LOG_PATH="$log_path"',
    '  export FOXWARM_EXEC_STATUS_PATH="$status_path"',
    '  export FOXWARM_EXEC_CWD_PATH="$cwd_path"',
    '  paths_tmp="${FOXWARM_EXEC_PATHS_PATH}.tmp.$$"',
    "  \"$FOXWARM_EXEC_NODE_PATH\" -e '\''const fs = require(\"fs\"); fs.writeFileSync(process.argv[1], JSON.stringify({ logPath: process.argv[2], statusPath: process.argv[3], cwdPath: process.argv[4] }) + \"\\n\");'\'' \"$paths_tmp\" \"$FOXWARM_EXEC_LOG_PATH\" \"$FOXWARM_EXEC_STATUS_PATH\" \"$FOXWARM_EXEC_CWD_PATH\"",
    '  mv "$paths_tmp" "$FOXWARM_EXEC_PATHS_PATH"',
    '  exec >> "$FOXWARM_EXEC_LOG_PATH" 2>&1',
    '}',
    'foxwarm_exec_choose_paths',
    'foxwarm_exec_finalize() {',
    '  exit_code=$?',
    '  cwd_tmp="${FOXWARM_EXEC_CWD_PATH}.tmp.$$"',
    '  status_tmp="${FOXWARM_EXEC_STATUS_PATH}.tmp.$$"',
    '  pwd > "$cwd_tmp"',
    '  mv "$cwd_tmp" "$FOXWARM_EXEC_CWD_PATH"',
    `  ${buildStatusWriterInvocationPosix()} "$status_tmp" "$exit_code"`,
    '  mv "$status_tmp" "$FOXWARM_EXEC_STATUS_PATH"',
    '}',
    'trap foxwarm_exec_finalize EXIT',
    'set +e',
    command,
  ].join('\n');
}

function buildResolvedExecPaths(execDir: string, timeToken: string, pid: number, collisionIndex: number = 0): ResolvedExecPaths {
  const suffix = collisionIndex > 0 ? `_${collisionIndex}` : '';
  const logPath = path.join(execDir, `${timeToken}_pid${pid}${suffix}.log`);
  return { logPath, statusPath: `${logPath}.exit.json`, cwdPath: `${logPath}.cwd.txt` };
}

function formatDate(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function formatTime(date = new Date()): string {
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  const ms = String(date.getMilliseconds()).padStart(3, '0');
  return `${h}${m}${s}${ms}`;
}

export class PersistentExecManager {
  private runningExecs = new Map<string, RunningExecEntry>();
  private initialized = false;
  private initializationPromise: Promise<void> | null = null;
  private reconcileTimer: NodeJS.Timeout | null = null;
  private reconcileChain: Promise<void> = Promise.resolve();
  private registryMutationChain: Promise<void> = Promise.resolve();
  private readonly completionDispatcher: ExecCompletionDispatcher;

  constructor(private readonly options: PersistentExecManagerOptions) {
    this.completionDispatcher = options.completionDispatcher || (async () => {});
  }

  getDefaultCwd(agentName = 'main'): string {
    return this.options.getDefaultCwd(agentName);
  }

  private registryPath(): string | undefined {
    return this.options.registryPath;
  }

  private async saveRunningExecs(): Promise<void> {
    const registryPath = this.registryPath();
    if (!registryPath) return;
    await fs.ensureDir(path.dirname(registryPath));
    const tempPath = `${registryPath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      await fs.writeJson(tempPath, { execs: Array.from(this.runningExecs.values()) }, { spaces: 2 });
      await fs.rename(tempPath, registryPath);
    } catch (err) {
      await fs.remove(tempPath).catch(() => {});
      throw err;
    }
  }

  private async commitRegistryMutation<T>(mutate: () => T): Promise<T> {
    let result!: T;
    const operation = this.registryMutationChain.then(async () => {
      result = mutate();
      await this.saveRunningExecs();
    });
    this.registryMutationChain = operation.then(() => undefined, () => undefined);
    await operation;
    return result;
  }

  private async loadRunningExecs(): Promise<void> {
    this.runningExecs.clear();
    const registryPath = this.registryPath();
    if (!registryPath) return;

    try {
      const data = await fs.readJson(registryPath);
      const rawExecs = Array.isArray(data?.execs) ? data.execs : [];
      for (const raw of rawExecs) {
        if (!raw || typeof raw !== 'object') continue;
        if (typeof raw.id !== 'string' || typeof raw.logPath !== 'string' || typeof raw.statusPath !== 'string') continue;
        if (!Number.isFinite(Number(raw.pid)) || !Number.isFinite(Number(raw.startedAt))) continue;
        const agentName = typeof raw.agentName === 'string' && raw.agentName.trim().length > 0 ? raw.agentName : 'main';
        const entry: RunningExecEntry = {
          id: raw.id,
          pid: Number(raw.pid),
          sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : undefined,
          agentName,
          nodeId: typeof raw.nodeId === 'string' && raw.nodeId.trim().length > 0 ? raw.nodeId : (this.options.nodeId || 'master'),
          command: typeof raw.command === 'string' ? raw.command : '',
          initialCwd: typeof raw.initialCwd === 'string' && raw.initialCwd.trim().length > 0 ? raw.initialCwd : this.getDefaultCwd(agentName),
          cwdRaw: typeof raw.cwdRaw === 'string' ? raw.cwdRaw : undefined,
          cwdSource: raw.cwdSource === 'explicit' || raw.cwdSource === 'session' || raw.cwdSource === 'default' ? raw.cwdSource : undefined,
          logPath: raw.logPath,
          statusPath: raw.statusPath,
          cwdPath: typeof raw.cwdPath === 'string' && raw.cwdPath.trim().length > 0 ? raw.cwdPath : `${raw.logPath}.cwd.txt`,
          startedAt: Number(raw.startedAt),
          notifyOnCompletion: raw.notifyOnCompletion === true,
          recoveredAfterRestart: raw.recoveredAfterRestart === true,
        };
        this.runningExecs.set(entry.id, entry);
      }
    } catch (err: any) {
      if (err?.code !== 'ENOENT') this.options.logger?.error?.({ err }, 'Failed to load running exec registry');
    }
  }

  private async removeRunningExec(id: string): Promise<void> {
    await this.commitRegistryMutation(() => {
      this.runningExecs.delete(id);
    });
  }

  private async updateRunningExec(id: string, updates: Partial<RunningExecEntry>): Promise<RunningExecEntry | null> {
    return await this.commitRegistryMutation(() => {
      const current = this.runningExecs.get(id);
      if (!current) return null;
      const updated = { ...current, ...updates };
      this.runningExecs.set(id, updated);
      return updated;
    });
  }

  private async waitForResolvedExecPaths(pathsPath: string, fallback: ResolvedExecPaths): Promise<ResolvedExecPaths> {
    const deadline = Date.now() + EXEC_PATHS_WAIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const raw = await fs.readJson(pathsPath);
        if (typeof raw?.logPath === 'string' && typeof raw?.statusPath === 'string' && typeof raw?.cwdPath === 'string') {
          await fs.remove(pathsPath).catch(() => {});
          return { logPath: raw.logPath, statusPath: raw.statusPath, cwdPath: raw.cwdPath };
        }
      } catch (err: any) {
        if (err?.code !== 'ENOENT') this.options.logger?.warn?.({ err, pathsPath }, 'Failed to read exec paths metadata; retrying');
      }
      await sleep(EXEC_PATHS_POLL_INTERVAL_MS);
    }
    return fallback;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (!this.initializationPromise) {
      this.initializationPromise = this.initializeOnce().finally(() => {
        this.initializationPromise = null;
      });
    }
    await this.initializationPromise;
  }

  private async initializeOnce(): Promise<void> {
    await this.loadRunningExecs();
    let changed = false;
    for (const [id, entry] of this.runningExecs.entries()) {
      if (!entry.notifyOnCompletion) {
        this.runningExecs.set(id, { ...entry, notifyOnCompletion: true, recoveredAfterRestart: true });
        changed = true;
      }
    }
    if (changed) await this.saveRunningExecs();
    this.scheduleReconcile();
    this.initialized = true;
    this.options.logger?.info?.({ execCount: this.runningExecs.size }, 'Exec manager initialized');
    await this.queueReconcile();
  }

  private scheduleReconcile(): void {
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.reconcileTimer = setInterval(() => { void this.queueReconcile(); }, RECONCILE_INTERVAL_MS);
    this.reconcileTimer.unref?.();
  }

  private async queueReconcile(): Promise<void> {
    this.reconcileChain = this.reconcileChain.then(async () => {
      await this.reconcileRunningExecs();
    }).catch(err => {
      this.options.logger?.error?.({ err }, 'Exec reconcile loop failed');
    });
    await this.reconcileChain;
  }

  async startPersistentExec(options: StartPersistentExecOptions): Promise<RunningExecEntry> {
    const command = String(options.command || '');
    const agentName = options.agentName || 'main';
    const nodeId = options.nodeId || this.options.nodeId || 'master';
    const sessionId = options.sessionId;
    const defaultCwd = this.getDefaultCwd(agentName);
    const cwdResult = await resolveValidatedExecCwd({
      cwd: options.cwd,
      sessionCwd: options.sessionCwd,
      defaultCwd,
      nodeId,
    });
    const initialCwd = cwdResult.cwd;
    const tempDir = this.options.getExecTempDir(agentName);
    const startedAt = new Date();
    const dateDir = path.join(tempDir, formatDate(startedAt));
    const timeToken = formatTime(startedAt);

    await fs.ensureDir(tempDir);
    await fs.ensureDir(dateDir);

    const execId = `exec_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const scriptPath = `${path.join(tempDir, execId)}.command${process.platform === 'win32' ? '.ps1' : '.sh'}`;
    const commandScriptPath = process.platform === 'win32' ? `${path.join(tempDir, execId)}.user.ps1` : undefined;
    const pathsPath = path.join(tempDir, `${execId}.paths.json`);

    if (commandScriptPath) {
      await fs.writeFile(commandScriptPath, `${command}${command.endsWith('\n') ? '' : '\n'}`);
    }

    await fs.writeFile(
      scriptPath,
      `${buildManagedExecScript(command)}${command.endsWith('\n') ? '' : '\n'}`,
      process.platform === 'win32' ? undefined : { mode: 0o700 },
    );

    const launcher = process.platform === 'win32'
      ? { command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath] }
      : { command: '/bin/bash', args: [scriptPath] };

    const child: ChildProcess = spawn(launcher.command, launcher.args, {
      cwd: initialCwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        FOXWARM_EXEC_LOG_DIR: dateDir,
        FOXWARM_EXEC_TIME_TOKEN: timeToken,
        FOXWARM_EXEC_PATHS_PATH: pathsPath,
        FOXWARM_EXEC_NODE_PATH: process.execPath,
        ...(commandScriptPath ? { FOXWARM_EXEC_COMMAND_PATH: commandScriptPath } : {}),
      },
      stdio: 'ignore',
      detached: process.platform !== 'win32',
      windowsHide: true,
      shell: false,
    });

    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve());
      child.once('error', (err: any) => {
        if (err?.code === 'ENOENT') {
          reject(new Error(`Failed to start exec on node \`${nodeId}\`: ${err.message}. Working directory was validated as \`${initialCwd}\`; if you see \`spawn /bin/bash ENOENT\` with a different cwd, it is commonly a cwd issue rather than a missing shell.`));
          return;
        }
        reject(err);
      });
    });

    child.unref();
    if (!child.pid) throw new Error('Failed to start background process: missing pid');

    const resolvedPaths = await this.waitForResolvedExecPaths(pathsPath, buildResolvedExecPaths(dateDir, timeToken, child.pid));
    const entry: RunningExecEntry = {
      id: execId,
      pid: child.pid,
      sessionId,
      agentName,
      nodeId,
      command,
      initialCwd,
      cwdRaw: cwdResult.raw,
      cwdSource: cwdResult.source,
      logPath: resolvedPaths.logPath,
      statusPath: resolvedPaths.statusPath,
      cwdPath: resolvedPaths.cwdPath,
      startedAt: startedAt.getTime(),
      notifyOnCompletion: false,
    };

    await this.commitRegistryMutation(() => {
      this.runningExecs.set(entry.id, entry);
    });
    this.options.logger?.info?.({ execId: entry.id, pid: entry.pid, sessionId, nodeId }, 'Persistent exec started');
    return entry;
  }

  private async readExecCwd(cwdPath: string): Promise<string | null> {
    try {
      const raw = await fs.readFile(cwdPath, 'utf8');
      const cwd = raw.trim();
      return cwd || null;
    } catch (err: any) {
      if (err?.code === 'ENOENT') return null;
      throw err;
    }
  }

  private async readProcessCwd(pid: number): Promise<string | null> {
    if (process.platform !== 'linux') return null;
    try {
      const raw = await fsp.readlink(`/proc/${pid}/cwd`);
      const cwd = raw.trim();
      return cwd || null;
    } catch (err: any) {
      if (err?.code === 'ENOENT' || err?.code === 'ESRCH') return null;
      throw err;
    }
  }

  private async readLogExcerpt(filePath: string, maxChars: number): Promise<{ text: string; truncated: boolean; truncation?: OutputTruncationResult }> {
    const stat = await fs.stat(filePath);
    if (stat.size <= 0) return { text: '', truncated: false };
    const text = await fs.readFile(filePath, 'utf8');
    const truncation = truncateOutputForDisplay(text, {
      maxChars,
      force: text.length > maxChars,
      lineOmissionReason: 'this file is too long',
    });
    return {
      text: truncation.text,
      truncated: truncation.truncated,
      truncation: truncation.truncated ? truncation : undefined,
    };
  }

  private async readPartialLog(logPath: string): Promise<string> {
    try {
      const excerpt = await this.readLogExcerpt(logPath, PARTIAL_LOG_BYTES);
      const text = excerpt.text.trim();
      if (!text) return '(Command started, no output yet)';
      return excerpt.truncated ? `${text}\n...(truncated)` : text;
    } catch (err: any) {
      if (err?.code === 'ENOENT') return '(Command started, no output yet)';
      throw err;
    }
  }

  private async readDisplayOutput(logPath: string): Promise<{ text: string; truncated: boolean; truncation?: OutputTruncationResult }> {
    try {
      const excerpt = await this.readLogExcerpt(logPath, INLINE_LOG_LIMIT_BYTES);
      if (!excerpt.text.trim()) return { text: '(No output)', truncated: false };
      if (!excerpt.truncated && estimateTokenCount(excerpt.text) <= 10000) return excerpt;
      if (excerpt.truncated) return excerpt;
      const truncation = truncateOutputForDisplay(excerpt.text, {
        maxChars: INLINE_EXCERPT_HALF_BYTES * 2,
        force: true,
        lineOmissionReason: 'this file is too long',
      });
      return {
        text: truncation.text,
        truncated: true,
        truncation,
      };
    } catch (err: any) {
      if (err?.code === 'ENOENT') return { text: '(No output)', truncated: false };
      throw err;
    }
  }

  private buildForegroundFooter(entry: RunningExecEntry, status: ExecStatus, output: { truncated: boolean; truncation?: OutputTruncationResult }, warning?: string): string {
    const lines = ['---', `Exit code: ${status.exitCode === null ? 'unknown' : status.exitCode}`];
    if (status.error) lines.push(`Error: ${status.error}`);
    if (warning) lines.push(warning);
    if (output.truncated) {
      lines.push(`Full output saved to: ${entry.logPath}`);
      lines.push('Output was shortened for inline display.');
    }
    if (output.truncation?.footerNotes?.length) lines.push(...output.truncation.footerNotes);
    return lines.join('\n');
  }

  private async readExecStatus(statusPath: string): Promise<ExecStatus | null> {
    try {
      const raw = await fs.readJson(statusPath);
      return {
        exitCode: typeof raw?.exitCode === 'number' ? raw.exitCode : null,
        finishedAt: typeof raw?.finishedAt === 'string' && raw.finishedAt ? raw.finishedAt : new Date().toISOString(),
        error: typeof raw?.error === 'string' ? raw.error : undefined,
      };
    } catch (err: any) {
      if (err?.code === 'ENOENT') return null;
      throw err;
    }
  }

  private async ensureFallbackStatus(entry: RunningExecEntry): Promise<ExecStatus | null> {
    const existing = await this.readExecStatus(entry.statusPath);
    if (existing) return existing;
    if (isPidRunning(entry.pid)) return null;
    if (Date.now() - entry.startedAt < MISSING_STATUS_GRACE_MS) return null;
    const fallback: ExecStatus = { exitCode: null, finishedAt: new Date().toISOString(), error: 'Process exited but no status file was written.' };
    const tempPath = `${entry.statusPath}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
    await fs.writeJson(tempPath, fallback);
    await fs.rename(tempPath, entry.statusPath);
    return fallback;
  }

  async waitForExecCompletion(execId: string, timeoutMs: number): Promise<ExecStatus | null> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const entry = this.runningExecs.get(execId);
      if (!entry) return null;
      const status = await this.ensureFallbackStatus(entry);
      if (status) return status;
      await sleep(STATUS_POLL_INTERVAL_MS);
    }
    return null;
  }

  async markExecForBackgroundNotification(execId: string): Promise<RunningExecEntry | null> {
    return await this.updateRunningExec(execId, { notifyOnCompletion: true });
  }

  async finalizeForegroundExec(execId: string): Promise<void> {
    await this.removeRunningExec(execId);
  }

  async buildForegroundExecResult(entry: RunningExecEntry, status: ExecStatus, warning?: string): Promise<string> {
    const output = await this.readDisplayOutput(entry.logPath);
    const body = output.text.trim() || '(No output)';
    return `${body}\n${this.buildForegroundFooter(entry, status, output, warning)}`;
  }

  async buildBackgroundTimeoutResult(entry: RunningExecEntry, timeoutSeconds: number = DEFAULT_EXEC_TIMEOUT_SECONDS, warning?: string): Promise<string> {
    const partialOutput = await this.readPartialLog(entry.logPath);
    const shortNotice = buildBackgroundTimeoutShortNotice(timeoutSeconds);
    const fullNotice = buildBackgroundTimeoutFullNotice(timeoutSeconds);
    const nodeLine = entry.nodeId && entry.nodeId !== 'master' ? `Node: \`${entry.nodeId}\`\n` : '';
    const warningLine = warning ? `${warning}\n` : '';
    return `${shortNotice}\n\nPartial Output:\n${partialOutput}\n\n${fullNotice}\n${warningLine}${nodeLine}PID: ${entry.pid}\nLog file: ${entry.logPath}`;
  }

  buildCompletionMessage(entry: RunningExecEntry, status: ExecStatus): string {
    const exitText = status.exitCode === null ? 'unknown' : String(status.exitCode);
    const nodeLine = entry.nodeId && entry.nodeId !== 'master' ? `\nNode: \`${entry.nodeId}\`` : '';
    const errorLine = status.error ? `\nError: ${status.error}` : '';
    return `Background Process Finished\ncommand: \`${escapeInlineCode(summarizeCommandForNotification(entry.command))}\`${nodeLine}\nExit code: ${exitText}${errorLine}\nFull output in ${entry.logPath}`;
  }

  async readFinishedExecWorkingDirectory(entry: RunningExecEntry): Promise<string | null> {
    return await this.readExecCwd(entry.cwdPath);
  }

  async readLiveExecWorkingDirectory(entry: RunningExecEntry): Promise<string | null> {
    return await this.readProcessCwd(entry.pid);
  }

  listRunningExecs(): RunningExecEntry[] {
    return Array.from(this.runningExecs.values());
  }

  private async reconcileRunningExecs(): Promise<void> {
    for (const entry of Array.from(this.runningExecs.values())) {
      if (!entry.notifyOnCompletion) continue;
      let status: ExecStatus | null = null;
      try {
        status = await this.ensureFallbackStatus(entry);
      } catch (err) {
        this.options.logger?.error?.({ err, execId: entry.id, statusPath: entry.statusPath }, 'Failed to inspect exec status');
        continue;
      }
      if (!status) continue;
      const message = this.buildCompletionMessage(entry, status);
      try {
        await this.completionDispatcher(entry, status, message);
        await this.removeRunningExec(entry.id);
        this.options.logger?.info?.({ execId: entry.id, pid: entry.pid, sessionId: entry.sessionId }, 'Delivered background exec completion');
      } catch (err) {
        this.options.logger?.warn?.({ err, execId: entry.id, sessionId: entry.sessionId }, 'Failed to deliver background exec completion; will retry');
      }
    }
  }
}
