import crypto from 'crypto';
import fs from 'fs-extra';
import path from 'path';
import { nativeFileOperations } from './fileOperations';
import { resolveValidatedExecCwd } from './execCwd';
import { expandAgentPathVariable } from './agentPathVariables';
import { nativeProcessOperations, type ProcessOperations } from './processOperations';
import type { ExecStatus, RunningExecEntry, StartPersistentExecOptions, PersistentExecManagerOptions } from './persistentExec';

const MISSING_STATUS_GRACE_MS = 3000;
const EXEC_PATHS_WAIT_TIMEOUT_MS = 1000;
const EXEC_PATHS_POLL_INTERVAL_MS = 25;
export const MISSING_STATUS_ERROR = 'Process exited but no status file was written.';
interface ResolvedExecPaths { logPath: string; statusPath: string; cwdPath: string }
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function buildStatusWriterInvocationPosix(): string {
  return `"$FOXWARM_EXEC_NODE_PATH" -e 'const fs = require("fs"); const statusPath = process.argv[1]; const rawExitCode = process.argv[2]; const exitCode = rawExitCode === "null" ? null : Number(rawExitCode); fs.writeFileSync(statusPath, JSON.stringify({ exitCode, finishedAt: new Date().toISOString() }) + "\\n");'`;
}

function buildManagedExecScript(command: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    return [
      '$ErrorActionPreference = "Continue"',
      '$utf8 = New-Object System.Text.UTF8Encoding $false',
      '[Console]::InputEncoding = $utf8',
      '[Console]::OutputEncoding = $utf8',
      '$OutputEncoding = $utf8',
      '$statusPath = $env:FOXWARM_EXEC_STATUS_PATH',
      '$cwdPath = $env:FOXWARM_EXEC_CWD_PATH',
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
      '[System.IO.File]::WriteAllText($cwdTmp, (Get-Location).Path, $utf8)',
      'Move-Item -LiteralPath $cwdTmp -Destination $cwdPath -Force',
      '$status = @{ exitCode = $EXIT_CODE; finishedAt = [DateTime]::UtcNow.ToString("o") } | ConvertTo-Json -Compress',
      '[System.IO.File]::WriteAllText($statusTmp, $status, $utf8)',
      'Move-Item -LiteralPath $statusTmp -Destination $statusPath -Force',
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

export class NativeExecBackend {
  readonly files = nativeFileOperations;
  constructor(private readonly options: PersistentExecManagerOptions) {}
  private get processOperations(): ProcessOperations { return this.options.processOperations || nativeProcessOperations; }
  private getDefaultCwd(agentName: string): string { return this.options.getDefaultCwd(agentName); }
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

  async start(options: StartPersistentExecOptions & { execId: string }): Promise<RunningExecEntry> {
    const command = String(options.command || '');
    const externalOwner = options.externalOwner;
    if (externalOwner && (options.agentName !== undefined || options.sessionId !== undefined
      || externalOwner.kind !== 'external' || !externalOwner.externalId || !externalOwner.contextId
      || !this.options.getExternalDefaultCwd || !this.options.getExternalExecTempDir)) {
      throw new Error('External exec owner cannot use a Session or Agent namespace.');
    }
    const agentName = externalOwner ? undefined : (options.agentName || 'main');
    const nodeId = options.nodeId || this.options.nodeId || 'master';
    const sessionId = options.sessionId;
    const agentDir = !externalOwner ? this.options.getAgentDir?.(agentName!) : undefined;
    if (agentDir) await fs.ensureDir(path.join(agentDir, 'tmp'));
    const expandCwd = (cwd: unknown): unknown => typeof cwd === 'string' ? expandAgentPathVariable(cwd.trim(), agentDir) : cwd;
    const defaultCwd = externalOwner ? this.options.getExternalDefaultCwd!(externalOwner) : this.getDefaultCwd(agentName!);
    const cwdResult = await resolveValidatedExecCwd({
      cwd: expandCwd(options.cwd),
      sessionCwd: expandCwd(options.sessionCwd),
      defaultCwd,
      nodeId,
    });
    const initialCwd = cwdResult.cwd;
    const tempDir = externalOwner ? this.options.getExternalExecTempDir!(externalOwner) : this.options.getExecTempDir(agentName!);
    const startedAt = new Date();
    const dateDir = path.join(tempDir, formatDate(startedAt));
    const timeToken = formatTime(startedAt);

    await fs.ensureDir(tempDir);
    await fs.ensureDir(dateDir);

    const execId = options.execId;
    const processOperations = this.processOperations;
    const platform = processOperations.platform;
    const scriptPath = `${path.join(dateDir, execId)}.command${platform === 'win32' ? '.ps1' : '.sh'}`;
    const commandScriptPath = platform === 'win32' ? `${path.join(dateDir, execId)}.user.ps1` : undefined;
    const pathsPath = path.join(dateDir, `${execId}.paths.json`);
    // Windows must know its log before spawn so both inherited output handles
    // can point at it. POSIX keeps choosing its PID-based paths in the wrapper.
    const windowsLogPath = platform === 'win32' ? path.join(dateDir, `${timeToken}_${execId}.log`) : undefined;
    const windowsPaths = windowsLogPath ? {
      logPath: windowsLogPath, statusPath: `${windowsLogPath}.exit.json`, cwdPath: `${windowsLogPath}.cwd.txt`,
    } : undefined;

    if (commandScriptPath) {
      await fs.writeFile(commandScriptPath, `\uFEFF${command}${command.endsWith('\n') ? '' : '\n'}`, 'utf8');
    }

    await fs.writeFile(
      scriptPath,
      `${platform === 'win32' ? '\uFEFF' : ''}${buildManagedExecScript(command, platform)}${command.endsWith('\n') ? '' : '\n'}`,
      platform === 'win32' ? undefined : { mode: 0o700 },
    );

    const launcher = platform === 'win32'
      ? { command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath] }
      : { command: '/bin/bash', args: [scriptPath] };

    let launched: { pid: number };
    let processStartedAt: number;
    try {
      options.onBeforeProcessLaunch?.();
      // Reserved names belong to this launch, not to the host process or a prior Agent.
      const hostEnv = { ...process.env };
      for (const key of Object.keys(hostEnv)) {
        const name = platform === 'win32' ? key.toLowerCase() : key;
        if (name === 'fw_agentdir' || name === 'fw_tmp') delete hostEnv[key];
      }
      processStartedAt = Date.now();
      launched = await processOperations.launch({
        command: launcher.command,
        args: launcher.args,
        cwd: initialCwd,
        env: {
          ...hostEnv,
          ...(platform === 'win32' ? {} : { PWD: initialCwd }),
          ...(agentDir ? { fw_agentdir: agentDir, fw_tmp: path.join(agentDir, 'tmp') } : {}),
          TERM: 'xterm-256color',
          FOXWARM_EXEC_LOG_DIR: dateDir,
          FOXWARM_EXEC_TIME_TOKEN: timeToken,
          FOXWARM_EXEC_PATHS_PATH: pathsPath,
          FOXWARM_EXEC_NODE_PATH: processOperations.nodePath,
          ...(windowsPaths ? { FOXWARM_EXEC_STATUS_PATH: windowsPaths.statusPath, FOXWARM_EXEC_CWD_PATH: windowsPaths.cwdPath } : {}),
          ...(commandScriptPath ? { FOXWARM_EXEC_COMMAND_PATH: commandScriptPath } : {}),
        },
        detached: platform !== 'win32',
        windowsHide: true,
        ...(windowsLogPath ? { outputPath: windowsLogPath } : {}),
      });
      options.onProcessStarted?.();
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        throw new Error(`Failed to start exec on node \`${nodeId}\`: ${err.message}. Working directory was validated as \`${initialCwd}\`.`);
      }
      throw err;
    }

    const resolvedPaths = windowsPaths || await this.waitForResolvedExecPaths(pathsPath, buildResolvedExecPaths(dateDir, timeToken, launched.pid));
    const entry: RunningExecEntry = {
      id: execId,
      pid: launched.pid,
      sessionId,
      ...(externalOwner ? { externalOwner } : { agentName }),
      nodeId,
      command,
      initialCwd,
      cwdRaw: cwdResult.raw,
      cwdSource: cwdResult.source,
      logPath: resolvedPaths.logPath,
      statusPath: resolvedPaths.statusPath,
      cwdPath: resolvedPaths.cwdPath,
      startedAt: processStartedAt,
      notifyOnCompletion: false,
      completionCapability: options.completionCapability,
    };

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

  private async readExecStatus(statusPath: string): Promise<ExecStatus | null> {
    try {
      const raw = await fs.readJson(statusPath);
      return {
        exitCode: typeof raw?.exitCode === 'number' ? raw.exitCode : null,
        finishedAt: typeof raw?.finishedAt === 'string' && raw.finishedAt ? raw.finishedAt : new Date().toISOString(),
        ...(typeof raw?.finishedAt === 'string' && raw.finishedAt ? {} : { finishedAtIsEstimated: true }),
        error: typeof raw?.error === 'string' ? raw.error : undefined,
      };
    } catch (err: any) {
      if (err?.code === 'ENOENT') return null;
      throw err;
    }
  }

  async poll(entry: RunningExecEntry): Promise<ExecStatus | null> {
    const existing = await this.readExecStatus(entry.statusPath!);
    if (existing) return existing;
    if (await this.processOperations.isRunning(entry.pid!)) return null;
    if (Date.now() - entry.startedAt < MISSING_STATUS_GRACE_MS) return null;
    const fallback: ExecStatus = { exitCode: null, finishedAt: new Date().toISOString(), error: MISSING_STATUS_ERROR };
    await fs.ensureDir(path.dirname(entry.statusPath!));
    const tempPath = `${entry.statusPath}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
    await fs.writeJson(tempPath, fallback);
    await fs.rename(tempPath, entry.statusPath!);
    return fallback;
  }


  async readFinishedWorkingDirectory(entry: RunningExecEntry): Promise<string | null> {
    return this.readExecCwd(entry.cwdPath!);
  }
  async readLiveWorkingDirectory(entry: RunningExecEntry): Promise<string | null> {
    return this.processOperations.readWorkingDirectory(entry.pid!);
  }
  async inspectSnapshot() {
    return (this.options.processSnapshotProvider || (() => this.processOperations.inspectSnapshot()))();
  }
}
