import fs from 'fs-extra';
import path from 'path';
import crypto from 'crypto';
import { WebSocket } from 'ws';
import * as pty from 'node-pty';
import { getAgentDir } from './config';
import { logger } from './common';
import * as sessionManager from './sessionManager';

const ORPHAN_TERMINAL_TTL_MS = 30_000;

export type TerminalRecord = {
  id: string;
  sessionId: string;
  agentName: string;
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
  closeTimer: NodeJS.Timeout | null;
  closed: boolean;
  rcFilePath?: string;
  cwdPath?: string;
};

const terminals = new Map<string, ManagedTerminal>();

function getShellPath(): string {
  return process.env.SHELL && process.env.SHELL.trim().length > 0
    ? process.env.SHELL.trim()
    : '/bin/bash';
}

function sanitizeTerminalRecord(record: ManagedTerminal): TerminalRecord {
  return {
    id: record.id,
    sessionId: record.sessionId,
    agentName: record.agentName,
    nodeId: record.nodeId,
    shell: record.shell,
    cwd: record.cwd,
    cols: record.cols,
    rows: record.rows,
    createdAt: record.createdAt,
    pid: record.pid,
  };
}

async function buildRcFile(agentName: string, terminalId: string, cwdPath: string): Promise<string> {
  const tempDir = path.join(getAgentDir(agentName), '.temp', 'terminals');
  await fs.ensureDir(tempDir);
  const rcFilePath = path.join(tempDir, `${terminalId}.bashrc`);
  const script = [
    'if [ -f /etc/bash.bashrc ]; then source /etc/bash.bashrc; fi',
    'if [ -f "$HOME/.bashrc" ]; then source "$HOME/.bashrc"; fi',
    '__foxwarm_terminal_finalize() {',
    '  local tmp_path="${FOXWARM_TERMINAL_CWD_PATH}.tmp.$$"',
    '  pwd > "$tmp_path" 2>/dev/null || true',
    '  mv "$tmp_path" "$FOXWARM_TERMINAL_CWD_PATH" 2>/dev/null || true',
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

async function updateSessionCwdFromTerminal(record: ManagedTerminal): Promise<void> {
  const finalCwd = await readTrackedCwd(record.cwdPath);
  if (!finalCwd) {
    return;
  }

  try {
    await sessionManager.setSessionCwd(record.sessionId, finalCwd);
  } catch (err) {
    logger.warn({ err, terminalId: record.id, sessionId: record.sessionId, finalCwd }, 'Failed to sync session cwd from terminal');
  }
}

async function cleanupTerminal(record: ManagedTerminal): Promise<void> {
  if (record.closeTimer) {
    clearTimeout(record.closeTimer);
    record.closeTimer = null;
  }

  terminals.delete(record.id);
  await updateSessionCwdFromTerminal(record);

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

function scheduleOrphanClose(record: ManagedTerminal): void {
  if (record.closeTimer || record.closed) {
    return;
  }

  record.closeTimer = setTimeout(() => {
    record.closeTimer = null;
    void closeTerminal(record.id, 'orphan-timeout');
  }, ORPHAN_TERMINAL_TTL_MS);
}

export async function createTerminal(options: {
  sessionId: string;
  cwd?: string;
  nodeId?: string;
  cols?: number;
  rows?: number;
}): Promise<TerminalRecord> {
  const session = await sessionManager.getSession(options.sessionId);
  const nodeId = options.nodeId || session.currentNode || 'master';
  if (nodeId !== 'master') {
    throw new Error('Terminal MVP currently supports only master.');
  }

  const agentName = session.agent || 'main';
  const requestedCwd = typeof options.cwd === 'string' && options.cwd.trim().length > 0
    ? options.cwd.trim()
    : (typeof session.cwd === 'string' && session.cwd.trim().length > 0 ? session.cwd.trim() : getAgentDir(agentName));

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
  const tempDir = path.join(getAgentDir(agentName), '.temp', 'terminals');
  await fs.ensureDir(tempDir);
  const cwdPath = path.join(tempDir, `${terminalId}.cwd.txt`);
  const rcFilePath = shell.includes('bash') ? await buildRcFile(agentName, terminalId, cwdPath) : undefined;

  const args = rcFilePath && shell.includes('bash')
    ? ['--rcfile', rcFilePath, '-i']
    : ['-i'];

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
    sessionId: session.id,
    agentName,
    nodeId,
    shell,
    cwd: resolvedCwd,
    cols,
    rows,
    createdAt: Date.now(),
    pid: ptyProcess.pid,
    ptyProcess,
    clients: new Set(),
    closeTimer: null,
    closed: false,
    rcFilePath,
    cwdPath,
  };

  terminals.set(record.id, record);

  ptyProcess.onData((data: string) => {
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

  logger.info({ terminalId: record.id, sessionId: record.sessionId, cwd: record.cwd, pid: record.pid }, 'Terminal created');
  return sanitizeTerminalRecord(record);
}

export function getTerminal(terminalId: string): TerminalRecord | null {
  const record = terminals.get(terminalId);
  return record ? sanitizeTerminalRecord(record) : null;
}

export function attachTerminalClient(terminalId: string, client: WebSocket): TerminalRecord {
  const record = terminals.get(terminalId);
  if (!record) {
    throw new Error(`Terminal not found: ${terminalId}`);
  }

  if (record.closeTimer) {
    clearTimeout(record.closeTimer);
    record.closeTimer = null;
  }

  record.clients.add(client);
  return sanitizeTerminalRecord(record);
}

export function detachTerminalClient(terminalId: string, client: WebSocket): void {
  const record = terminals.get(terminalId);
  if (!record) {
    return;
  }

  record.clients.delete(client);
  if (record.clients.size === 0) {
    scheduleOrphanClose(record);
  }
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
  if (record.closeTimer) {
    clearTimeout(record.closeTimer);
    record.closeTimer = null;
  }

  logger.info({ terminalId, reason }, 'Closing terminal');
  try {
    record.ptyProcess.kill();
  } catch (err) {
    logger.warn({ err, terminalId }, 'Failed to kill terminal pty cleanly');
  }

  await cleanupTerminal(record);
}