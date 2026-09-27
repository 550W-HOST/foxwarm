import { execFile, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';

export interface ProcessSnapshotEntry {
  pid: number;
  parentPid: number;
  cmdline: string;
}

export interface ProcessLaunchRequest {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  detached: boolean;
  windowsHide: boolean;
}

/** Native process dependencies used by PersistentExecManager. */
export interface ProcessOperations {
  readonly platform: NodeJS.Platform;
  readonly nodePath: string;
  launch(request: ProcessLaunchRequest): Promise<{ pid: number }>;
  isRunning(pid: number): boolean | Promise<boolean>;
  readWorkingDirectory(pid: number): Promise<string | null>;
  inspectSnapshot(): Promise<ProcessSnapshotEntry[]>;
}

const PROCESS_INSPECTION_TIMEOUT_MS = 2000;
const PROCESS_INSPECTION_MAX_BUFFER_BYTES = 1024 * 1024;

function runProcessInspectionCommand(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      encoding: 'utf8',
      timeout: PROCESS_INSPECTION_TIMEOUT_MS,
      maxBuffer: PROCESS_INSPECTION_MAX_BUFFER_BYTES,
      windowsHide: true,
    }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(String(stdout));
    });
  });
}

async function inspectNativeProcessSnapshot(platform: NodeJS.Platform): Promise<ProcessSnapshotEntry[]> {
  if (platform === 'win32') {
    const script = [
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      '$items = @(Get-CimInstance Win32_Process | ForEach-Object {',
      '  [PSCustomObject]@{ pid = [int]$_.ProcessId; parentPid = [int]$_.ParentProcessId; cmdline = $(if ($_.CommandLine) { [string]$_.CommandLine } else { [string]$_.Name }) }',
      '})',
      'ConvertTo-Json -InputObject $items -Compress',
    ].join('\n');
    const output = await runProcessInspectionCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
    const parsed = JSON.parse(output.trim() || '[]');
    const items = Array.isArray(parsed) ? parsed : [parsed];
    return items.map(item => ({
      pid: Number(item?.pid),
      parentPid: Number(item?.parentPid),
      cmdline: typeof item?.cmdline === 'string' ? item.cmdline : '',
    }));
  }
  if (platform !== 'linux' && platform !== 'darwin' && platform !== 'freebsd' && platform !== 'openbsd') {
    throw new Error(`Process inspection is unsupported on ${platform}`);
  }

  const output = await runProcessInspectionCommand('ps', ['-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'command=']);
  const entries: ProcessSnapshotEntry[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s*(.*)$/);
    if (!match) continue;
    entries.push({ pid: Number(match[1]), parentPid: Number(match[2]), cmdline: match[3] || '' });
  }
  return entries;
}

export function createNativeProcessOperations(): ProcessOperations {
  const platform = process.platform;
  return {
    platform,
    nodePath: process.execPath,

    async launch(request) {
      const child = spawn(request.command, request.args, {
        cwd: request.cwd,
        env: request.env,
        stdio: 'ignore',
        detached: request.detached,
        windowsHide: request.windowsHide,
        shell: false,
      });
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', () => resolve());
        child.once('error', reject);
      });
      child.unref();
      if (!child.pid) throw new Error('Failed to start background process: missing pid');
      return { pid: child.pid };
    },

    isRunning(pid) {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error: any) {
        return error?.code === 'EPERM';
      }
    },

    async readWorkingDirectory(pid) {
      if (platform !== 'linux') return null;
      try {
        const raw = await fs.readlink(`/proc/${pid}/cwd`);
        const cwd = raw.trim();
        return cwd || null;
      } catch (error: any) {
        if (error?.code === 'ENOENT' || error?.code === 'ESRCH') return null;
        throw error;
      }
    },

    inspectSnapshot() {
      return inspectNativeProcessSnapshot(platform);
    },
  };
}

export const nativeProcessOperations: ProcessOperations = createNativeProcessOperations();
