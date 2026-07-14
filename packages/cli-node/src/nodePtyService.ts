import crypto from 'crypto';
import fs from 'fs-extra';
import path from 'path';
import { createRequire } from 'module';
import { CodeHelperIpcServer, type CodeHelperControlResult, type CodeHelperOpenRequest } from '../../shared/dist/codeHelperIpc';

export type NodePtyTerminalRecord = {
  id: string;
  nodeId: string;
  shell: string;
  cwd: string;
  cols: number;
  rows: number;
  createdAt: number;
  pid: number;
};

export type NodePtyServiceEvent =
  | { type: 'output'; terminalId: string; data: string }
  | { type: 'exit'; terminalId: string; exitCode: number; signal?: number; cwd?: string }
  | { type: 'code-request'; terminalId: string; requestId: string; request: CodeHelperOpenRequest };

type PtyProcess = {
  pid: number;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
};

type PtyModule = {
  spawn(file: string, args: string[] | string, options: {
    name?: string;
    cols?: number;
    rows?: number;
    cwd?: string;
    env?: Record<string, string | undefined>;
  }): PtyProcess;
};

type ManagedNodePty = NodePtyTerminalRecord & {
  process: PtyProcess;
  outputBuffer: string;
  streaming: boolean;
  closed: boolean;
  rcFilePath?: string;
  cwdPath?: string;
  codeCapability?: string;
};

const OUTPUT_BUFFER_LIMIT = 200_000;
const MIN_COLS = 20;
const MIN_ROWS = 5;

function sanitizeRecord(record: ManagedNodePty): NodePtyTerminalRecord {
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

function normalizeSize(value: unknown, minimum: number, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(minimum, Math.floor(numeric)) : fallback;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function getShell(): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    return { file: process.env.FOXWARM_NODE_PTY_SHELL || 'powershell.exe', args: ['-NoLogo'] };
  }
  const file = process.env.FOXWARM_NODE_PTY_SHELL || process.env.SHELL || '/bin/bash';
  return { file, args: ['-i'] };
}

export class NodePtyService {
  private readonly terminals = new Map<string, ManagedNodePty>();
  private readonly tempDir: string;
  private readonly codeHelper: CodeHelperIpcServer;
  private readonly pendingCodeRequests = new Map<string, {
    terminalId: string;
    resolve: (result: CodeHelperControlResult) => void;
    timeout: NodeJS.Timeout;
  }>();

  constructor(
    private readonly pty: PtyModule,
    stateDir: string,
    private readonly emitEvent: (event: NodePtyServiceEvent) => void,
  ) {
    this.tempDir = path.join(stateDir, '.temp', 'vscode-pty');
    this.codeHelper = new CodeHelperIpcServer(stateDir, (terminalId, requestId, request) => this.requestCodeControl(terminalId, requestId, request));
  }

  async execute(operation: string, args: Record<string, unknown>): Promise<any> {
    switch (operation) {
      case 'create': return { terminal: await this.create(args) };
      case 'list': return { terminals: await this.list() };
      case 'get': return { terminal: await this.get(requiredString(args.terminalId, 'terminalId')) };
      case 'attach': return this.attach(requiredString(args.terminalId, 'terminalId'));
      case 'detach': return this.detach(requiredString(args.terminalId, 'terminalId'));
      case 'input': return this.input(requiredString(args.terminalId, 'terminalId'), typeof args.data === 'string' ? args.data : '');
      case 'resize': return this.resize(requiredString(args.terminalId, 'terminalId'), args.cols, args.rows);
      case 'close': return this.close(requiredString(args.terminalId, 'terminalId'));
      case 'code-result': return this.resolveCodeControl(args);
      default: throw new Error(`Unsupported vscode-pty operation: ${operation}`);
    }
  }

  async dispose(): Promise<void> {
    for (const record of [...this.terminals.values()]) await this.close(record.id);
    await this.codeHelper.close();
  }

  private async create(args: Record<string, unknown>): Promise<NodePtyTerminalRecord> {
    const requestedCwd = requiredString(args.cwd, 'cwd');
    const cwd = path.resolve(requestedCwd);
    const stat = await fs.stat(cwd).catch((): null => null);
    if (!stat) throw new Error(`Directory does not exist: ${cwd}`);
    if (!stat.isDirectory()) throw new Error(`Path is not a directory: ${cwd}`);

    const terminalId = `term_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const cols = normalizeSize(args.cols, MIN_COLS, 100);
    const rows = normalizeSize(args.rows, MIN_ROWS, 30);
    const shell = getShell();
    await fs.ensureDir(this.tempDir);
    const codeHelper = await this.codeHelper.registerTerminal(terminalId);
    const cwdPath = process.platform === 'win32' ? undefined : path.join(this.tempDir, `${terminalId}.cwd.txt`);
    const rcFilePath = cwdPath && path.basename(shell.file).includes('bash')
      ? await this.buildBashRc(terminalId)
      : undefined;
    const shellArgs = rcFilePath ? ['--rcfile', rcFilePath, '-i'] : shell.args;
    let ptyProcess: PtyProcess;
    try {
      ptyProcess = this.pty.spawn(shell.file, shellArgs, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env: {
          ...process.env,
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
          ...codeHelper.env,
          ...(cwdPath ? { FOXWARM_TERMINAL_CWD_PATH: cwdPath } : {}),
        },
      });
    } catch (error) {
      this.codeHelper.unregisterTerminal(codeHelper.capability);
      await Promise.all([
        rcFilePath ? fs.remove(rcFilePath).catch((): undefined => undefined) : Promise.resolve(),
        cwdPath ? fs.remove(cwdPath).catch((): undefined => undefined) : Promise.resolve(),
      ]);
      throw error;
    }

    const record: ManagedNodePty = {
      id: terminalId,
      nodeId: '',
      shell: shell.file,
      cwd,
      cols,
      rows,
      createdAt: Date.now(),
      pid: ptyProcess.pid,
      process: ptyProcess,
      outputBuffer: '',
      streaming: false,
      closed: false,
      rcFilePath,
      cwdPath,
      codeCapability: codeHelper.capability,
    };
    this.terminals.set(record.id, record);

    ptyProcess.onData((data) => {
      record.outputBuffer += data;
      if (record.outputBuffer.length > OUTPUT_BUFFER_LIMIT) {
        record.outputBuffer = record.outputBuffer.slice(-OUTPUT_BUFFER_LIMIT);
      }
      if (record.streaming) this.emitEvent({ type: 'output', terminalId: record.id, data });
    });
    ptyProcess.onExit(({ exitCode, signal }) => {
      if (record.closed) return;
      record.closed = true;
      void (async () => {
        const finalCwd = await this.readTrackedCwd(record);
        this.emitEvent({ type: 'exit', terminalId: record.id, exitCode, signal, ...(finalCwd ? { cwd: finalCwd } : {}) });
        await this.cleanup(record);
      })();
    });
    return sanitizeRecord(record);
  }

  private async list(): Promise<NodePtyTerminalRecord[]> {
    await Promise.all([...this.terminals.values()].map((record) => this.refreshCwd(record)));
    return [...this.terminals.values()].sort((a, b) => b.createdAt - a.createdAt).map(sanitizeRecord);
  }

  private async get(terminalId: string): Promise<NodePtyTerminalRecord | null> {
    const record = this.terminals.get(terminalId);
    if (!record) return null;
    await this.refreshCwd(record);
    return sanitizeRecord(record);
  }

  private async attach(terminalId: string): Promise<{ terminal: NodePtyTerminalRecord; backlog: string }> {
    const record = this.requireTerminal(terminalId);
    record.streaming = true;
    await this.refreshCwd(record);
    return { terminal: sanitizeRecord(record), backlog: record.outputBuffer };
  }

  private detach(terminalId: string): { success: true } {
    this.requireTerminal(terminalId).streaming = false;
    return { success: true };
  }

  private input(terminalId: string, data: string): { success: true } {
    this.requireTerminal(terminalId).process.write(data);
    return { success: true };
  }

  private resize(terminalId: string, colsValue: unknown, rowsValue: unknown): { success: true } {
    const record = this.requireTerminal(terminalId);
    record.cols = normalizeSize(colsValue, MIN_COLS, record.cols);
    record.rows = normalizeSize(rowsValue, MIN_ROWS, record.rows);
    record.process.resize(record.cols, record.rows);
    return { success: true };
  }

  private async close(terminalId: string): Promise<{ success: true }> {
    const record = this.terminals.get(terminalId);
    if (!record) return { success: true };
    record.closed = true;
    try { record.process.kill(); } catch {}
    await this.cleanup(record);
    return { success: true };
  }

  private requireTerminal(terminalId: string): ManagedNodePty {
    const record = this.terminals.get(terminalId);
    if (!record) throw new Error(`Terminal not found: ${terminalId}`);
    return record;
  }

  private async buildBashRc(terminalId: string): Promise<string> {
    const rcFilePath = path.join(this.tempDir, `${terminalId}.bashrc`);
    const script = [
      'if [ -f /etc/bash.bashrc ]; then source /etc/bash.bashrc; fi',
      'if [ -f "$HOME/.bashrc" ]; then source "$HOME/.bashrc"; fi',
      '__foxwarm_terminal_sync_cwd() {',
      '  local tmp_path="${FOXWARM_TERMINAL_CWD_PATH}.tmp.$$"',
      '  pwd > "$tmp_path" 2>/dev/null || true',
      '  mv "$tmp_path" "$FOXWARM_TERMINAL_CWD_PATH" 2>/dev/null || true',
      '}',
      'PROMPT_COMMAND="__foxwarm_terminal_sync_cwd${PROMPT_COMMAND:+;$PROMPT_COMMAND}"',
      'trap __foxwarm_terminal_sync_cwd EXIT',
      '',
    ].join('\n');
    await fs.writeFile(rcFilePath, script, { mode: 0o600 });
    return rcFilePath;
  }

  private async readTrackedCwd(record: ManagedNodePty): Promise<string | null> {
    if (!record.cwdPath) return null;
    try { return (await fs.readFile(record.cwdPath, 'utf8')).trim() || null; } catch { return null; }
  }

  private async refreshCwd(record: ManagedNodePty): Promise<void> {
    const cwd = await this.readTrackedCwd(record);
    if (cwd) record.cwd = cwd;
  }

  private async cleanup(record: ManagedNodePty): Promise<void> {
    this.terminals.delete(record.id);
    this.codeHelper.unregisterTerminal(record.codeCapability);
    for (const [requestId, pending] of this.pendingCodeRequests) {
      if (pending.terminalId !== record.id) continue;
      clearTimeout(pending.timeout);
      pending.resolve({ ok: false, error: 'Terminal closed before Code handled the request.' });
      this.pendingCodeRequests.delete(requestId);
    }
    await Promise.all([
      record.rcFilePath ? fs.remove(record.rcFilePath).catch((): undefined => undefined) : Promise.resolve(),
      record.cwdPath ? fs.remove(record.cwdPath).catch((): undefined => undefined) : Promise.resolve(),
    ]);
  }

  private requestCodeControl(terminalId: string, requestId: string, request: CodeHelperOpenRequest): Promise<CodeHelperControlResult> {
    this.requireTerminal(terminalId);
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingCodeRequests.delete(requestId);
        resolve({ ok: false, error: 'Timed out waiting for an attached Code terminal.' });
      }, 20_000);
      this.pendingCodeRequests.set(requestId, { terminalId, resolve, timeout });
      this.emitEvent({ type: 'code-request', terminalId, requestId, request });
    });
  }

  private resolveCodeControl(args: Record<string, unknown>): { success: true } {
    const requestId = requiredString(args.requestId, 'requestId');
    const pending = this.pendingCodeRequests.get(requestId);
    if (!pending) return { success: true };
    this.pendingCodeRequests.delete(requestId);
    clearTimeout(pending.timeout);
    pending.resolve(args.ok === true
      ? { ok: true, ...(typeof args.message === 'string' ? { message: args.message } : {}) }
      : { ok: false, error: typeof args.error === 'string' ? args.error : 'Code rejected the request.' });
    return { success: true };
  }
}

export type NodePtyServiceLoadResult = {
  service?: NodePtyService;
  runtimeDir?: string;
  error?: Error;
};

function ensureDarwinSpawnHelperExecutable(resolveModule: (id: string) => string): void {
  if (process.platform !== 'darwin') return;
  const nodePtyMain = resolveModule('node-pty');
  const helperPath = path.join(path.resolve(path.dirname(nodePtyMain), '..'), 'prebuilds', `darwin-${process.arch}`, 'spawn-helper');
  const stat = fs.statSync(helperPath);
  if ((stat.mode & 0o111) !== 0o111) fs.chmodSync(helperPath, stat.mode | 0o111);
}

export function loadNodePtyService(options: {
  stateDir: string;
  emitEvent: (event: NodePtyServiceEvent) => void;
  runtimeDir?: string;
  ptyModule?: PtyModule;
}): NodePtyServiceLoadResult {
  if (options.ptyModule) {
    return { service: new NodePtyService(options.ptyModule, options.stateDir, options.emitEvent) };
  }

  const runtimeDir = path.resolve(
    options.runtimeDir
      || process.env.FOXWARM_NODE_RUNTIME_DIR
      || path.join(__dirname, '..', '..', 'cli-node-runtime'),
  );
  try {
    const runtimeRequire = createRequire(path.join(runtimeDir, 'package.json'));
    ensureDarwinSpawnHelperExecutable(runtimeRequire.resolve);
    const ptyModule = runtimeRequire('node-pty') as PtyModule;
    return { service: new NodePtyService(ptyModule, options.stateDir, options.emitEvent), runtimeDir };
  } catch (primaryError) {
    try {
      const projectRequire = createRequire(path.resolve(__dirname, '..', '..', '..', 'package.json'));
      ensureDarwinSpawnHelperExecutable(projectRequire.resolve);
      const ptyModule = projectRequire('node-pty') as PtyModule;
      return { service: new NodePtyService(ptyModule, options.stateDir, options.emitEvent), runtimeDir };
    } catch {
      return { runtimeDir, error: primaryError instanceof Error ? primaryError : new Error(String(primaryError)) };
    }
  }
}
