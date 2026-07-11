import fs from 'fs-extra';
import path from 'path';
import crypto from 'crypto';
import { WebSocket } from 'ws';
import * as pty from 'node-pty';
import { STATE_DIR } from './config';
import { logger } from './common';

export type TerminalRecord = {
  id: string;
  nodeId: string;
  shell: string;
  cwd: string;
  cols: number;
  rows: number;
  createdAt: number;
  pid: number;
};

type ManagedTerminal = TerminalRecord & {
  ptyProcess: pty.IPty;
  clients: Set<WebSocket>;
  closed: boolean;
  outputBuffer: string;
  rcFilePath?: string;
  cwdPath?: string;
};

const TERMINAL_OUTPUT_BUFFER_LIMIT = 200_000;
const TERMINAL_TEMP_DIR = path.join(STATE_DIR, '.temp', 'terminals');

const terminals = new Map<string, ManagedTerminal>();

async function ensureNodePtyDarwinSpawnHelperExecutable(): Promise<void> {
  if (process.platform !== 'darwin') {
    return;
  }

  try {
    const nodePtyMain = require.resolve('node-pty');
    const nodePtyDir = path.resolve(path.dirname(nodePtyMain), '..');
    const helperPath = path.join(nodePtyDir, 'prebuilds', `darwin-${process.arch}`, 'spawn-helper');
    const stat = await fs.stat(helperPath);
    if ((stat.mode & 0o111) !== 0o111) {
      await fs.chmod(helperPath, stat.mode | 0o111);
      logger.info({ helperPath }, 'Fixed node-pty macOS spawn-helper executable bit');
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to verify node-pty macOS spawn-helper executable bit');
  }
}

function getShellPath(): string {
  return process.env.SHELL && process.env.SHELL.trim().length > 0
    ? process.env.SHELL.trim()
    : '/bin/bash';
}

function sanitizeTerminalRecord(record: ManagedTerminal): TerminalRecord {
  return {
    id: record.id,
    nodeId: record.nodeId,
    shell: record.shell,
    cwd: record.cwd,
    cols: record.cols,
    rows: record.rows,
    createdAt: record.createdAt,
    pid: record.pid,
  };
}

async function buildRcFile(terminalId: string): Promise<string> {
  await fs.ensureDir(TERMINAL_TEMP_DIR);
  const rcFilePath = path.join(TERMINAL_TEMP_DIR, `${terminalId}.bashrc`);
  const script = [
    'if [ -f /etc/bash.bashrc ]; then source /etc/bash.bashrc; fi',
    'if [ -f "$HOME/.bashrc" ]; then source "$HOME/.bashrc"; fi',
    '__foxwarm_terminal_sync_cwd() {',
    '  local tmp_path="${FOXWARM_TERMINAL_CWD_PATH}.tmp.$$"',
    '  pwd > "$tmp_path" 2>/dev/null || true',
    '  mv "$tmp_path" "$FOXWARM_TERMINAL_CWD_PATH" 2>/dev/null || true',
    '}',
    'PROMPT_COMMAND="__foxwarm_terminal_sync_cwd${PROMPT_COMMAND:+;$PROMPT_COMMAND}"',
    '__foxwarm_terminal_finalize() {',
    '  __foxwarm_terminal_sync_cwd',
    '}',
    'trap __foxwarm_terminal_finalize EXIT',
    '',
  ].join('\n');
  await fs.writeFile(rcFilePath, script, { mode: 0o600 });
  return rcFilePath;
}

async function readTrackedCwd(cwdPath?: string): Promise<string | null> {
  if (!cwdPath) return null;
  try {
    const value = await fs.readFile(cwdPath, 'utf8');
    const trimmed = value.trim();
    return trimmed || null;
  } catch {
    return null;
  }
}

async function refreshTerminalCwd(record: ManagedTerminal): Promise<void> {
  const currentCwd = await readTrackedCwd(record.cwdPath);
  if (currentCwd) {
    record.cwd = currentCwd;
  }
}

async function cleanupTerminal(record: ManagedTerminal): Promise<void> {
  terminals.delete(record.id);
  await refreshTerminalCwd(record);

  for (const client of record.clients) {
    try {
      if (client.readyState === WebSocket.OPEN) {
        client.close();
      }
    } catch {}
  }
  record.clients.clear();

  await Promise.all([
    record.rcFilePath ? fs.remove(record.rcFilePath).catch(() => {}) : Promise.resolve(),
    record.cwdPath ? fs.remove(record.cwdPath).catch(() => {}) : Promise.resolve(),
  ]);
}

export async function createTerminal(options: {
  cwd: string;
  nodeId?: string;
  cols?: number;
  rows?: number;
}): Promise<TerminalRecord> {
  const nodeId = options.nodeId || 'master';
  if (nodeId !== 'master') {
    throw new Error('Terminal MVP currently supports only master.');
  }

  const requestedCwd = typeof options.cwd === 'string' && options.cwd.trim().length > 0
    ? options.cwd.trim()
    : '';
  if (!requestedCwd) {
    throw new Error('cwd is required');
  }

  const resolvedCwd = path.resolve(requestedCwd);
  let stat: fs.Stats | null = null;
  try {
    stat = await fs.stat(resolvedCwd);
  } catch {
    stat = null;
  }
  if (!stat) {
    throw new Error(`Directory does not exist: ${resolvedCwd}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Path is not a directory: ${resolvedCwd}`);
  }

  const terminalId = `term_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const shell = getShellPath();
  const cols = Math.max(20, Math.floor(options.cols || 100));
  const rows = Math.max(5, Math.floor(options.rows || 30));
  await fs.ensureDir(TERMINAL_TEMP_DIR);
  const cwdPath = path.join(TERMINAL_TEMP_DIR, `${terminalId}.cwd.txt`);
  const rcFilePath = shell.includes('bash') ? await buildRcFile(terminalId) : undefined;

  const args = rcFilePath && shell.includes('bash')
    ? ['--rcfile', rcFilePath, '-i']
    : ['-i'];

  await ensureNodePtyDarwinSpawnHelperExecutable();

  const ptyProcess = pty.spawn(shell, args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: resolvedCwd,
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      FOXWARM_TERMINAL_CWD_PATH: cwdPath,
    },
  });

  const record: ManagedTerminal = {
    id: terminalId,
    nodeId,
    shell,
    cwd: resolvedCwd,
    cols,
    rows,
    createdAt: Date.now(),
    pid: ptyProcess.pid,
    ptyProcess,
    clients: new Set(),
    closed: false,
    outputBuffer: '',
    rcFilePath,
    cwdPath,
  };

  terminals.set(record.id, record);

  ptyProcess.onData((data: string) => {
    record.outputBuffer = `${record.outputBuffer}${data}`;
    if (record.outputBuffer.length > TERMINAL_OUTPUT_BUFFER_LIMIT) {
      record.outputBuffer = record.outputBuffer.slice(record.outputBuffer.length - TERMINAL_OUTPUT_BUFFER_LIMIT);
    }

    for (const client of record.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: 'output', data }));
      }
    }
  });

  ptyProcess.onExit(({ exitCode, signal }) => {
    if (record.closed) {
      return;
    }
    record.closed = true;

    void (async () => {
      const finalCwd = await readTrackedCwd(record.cwdPath);
      for (const client of record.clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ type: 'exit', exitCode, signal, cwd: finalCwd || undefined }));
        }
      }

      await cleanupTerminal(record);
    })();
  });

  logger.info({ terminalId: record.id, cwd: record.cwd, pid: record.pid }, 'Terminal created');
  return sanitizeTerminalRecord(record);
}

export function getTerminal(terminalId: string): TerminalRecord | null {
  const record = terminals.get(terminalId);
  return record ? sanitizeTerminalRecord(record) : null;
}

export async function getTerminalRecord(terminalId: string): Promise<TerminalRecord | null> {
  const record = terminals.get(terminalId);
  if (!record) {
    return null;
  }
  await refreshTerminalCwd(record);
  return sanitizeTerminalRecord(record);
}

export async function listTerminalRecords(): Promise<TerminalRecord[]> {
  const filtered = Array.from(terminals.values());

  await Promise.all(filtered.map((record) => refreshTerminalCwd(record)));

  return filtered
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((record) => sanitizeTerminalRecord(record));
}

export async function attachTerminalClient(terminalId: string, client: WebSocket): Promise<{ terminal: TerminalRecord; backlog: string }> {
  const record = terminals.get(terminalId);
  if (!record) {
    throw new Error(`Terminal not found: ${terminalId}`);
  }

  record.clients.add(client);
  await refreshTerminalCwd(record);
  return {
    terminal: sanitizeTerminalRecord(record),
    backlog: record.outputBuffer,
  };
}

export function detachTerminalClient(terminalId: string, client: WebSocket): void {
  const record = terminals.get(terminalId);
  if (!record) {
    return;
  }

  record.clients.delete(client);
}

export function writeTerminalInput(terminalId: string, data: string): void {
  const record = terminals.get(terminalId);
  if (!record) {
    throw new Error(`Terminal not found: ${terminalId}`);
  }
  record.ptyProcess.write(data);
}

export function resizeTerminal(terminalId: string, cols: number, rows: number): void {
  const record = terminals.get(terminalId);
  if (!record) {
    throw new Error(`Terminal not found: ${terminalId}`);
  }

  const safeCols = Math.max(20, Math.floor(cols));
  const safeRows = Math.max(5, Math.floor(rows));
  record.cols = safeCols;
  record.rows = safeRows;
  record.ptyProcess.resize(safeCols, safeRows);
}

export async function closeTerminal(terminalId: string, reason: string = 'manual-close'): Promise<void> {
  const record = terminals.get(terminalId);
  if (!record) {
    return;
  }

  record.closed = true;

  logger.info({ terminalId, reason }, 'Closing terminal');
  try {
    record.ptyProcess.kill();
  } catch (err) {
    logger.warn({ err, terminalId }, 'Failed to kill terminal pty cleanly');
  }

  await cleanupTerminal(record);
}