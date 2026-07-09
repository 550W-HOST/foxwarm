import * as vscode from 'vscode';
import { getWorkspaceTerminalTarget, parseFoxwarmUri } from './foxwarmUri';
export { getWorkspaceTerminalTarget, parseFoxwarmUri } from './foxwarmUri';

type TerminalRecord = {
  id: string;
  nodeId: string;
  cwd: string;
  shell: string;
  cols: number;
  rows: number;
  createdAt: number;
  pid: number;
};

type TerminalTarget = {
  nodeId: string;
  cwd: string;
};

const TERMINAL_API_PREFIX = '/api/terminals';
const TERMINAL_STREAM_PREFIX = '/api/terminals/stream';

let terminalApiBase = TERMINAL_API_PREFIX;
let terminalStreamBase = TERMINAL_STREAM_PREFIX;
let terminalRouteOrigin = '';

function deriveTerminalRouteBase(extensionUri: vscode.Uri, apiPath: string): string {
  if (extensionUri.scheme !== 'http' && extensionUri.scheme !== 'https') {
    return apiPath;
  }

  const marker = '/vscode-web/extensions/foxwarm-terminal';
  const markerIndex = extensionUri.path.indexOf(marker);
  const prefix = markerIndex >= 0 ? extensionUri.path.slice(0, markerIndex) : '';
  return `${extensionUri.scheme}://${extensionUri.authority}${prefix}${apiPath}`;
}

function deriveOrigin(extensionUri: vscode.Uri): string {
  if ((extensionUri.scheme === 'http' || extensionUri.scheme === 'https') && extensionUri.authority) {
    return `${extensionUri.scheme}://${extensionUri.authority}`;
  }
  const locationLike = (globalThis as any).location;
  return typeof locationLike?.origin === 'string' ? locationLike.origin : 'http://localhost';
}

function getApiBase(): string {
  return terminalApiBase;
}

function getTerminalWebSocketUrl(terminalId: string): string {
  const url = new URL(terminalStreamBase, terminalRouteOrigin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('terminalId', terminalId);
  return url.toString();
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const errorMessage = typeof payload?.error === 'string' ? payload.error : `HTTP ${response.status}`;
    throw new Error(errorMessage);
  }
  return payload as T;
}

async function createBackendTerminal(target: TerminalTarget, dimensions?: vscode.TerminalDimensions): Promise<TerminalRecord> {
  const response = await fetch(getApiBase(), {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      nodeId: target.nodeId,
      cwd: target.cwd,
      cols: dimensions?.columns,
      rows: dimensions?.rows,
    }),
  });
  const payload = await readJsonResponse<{ terminal?: TerminalRecord }>(response);
  if (!payload.terminal?.id) {
    throw new Error('Terminal create response did not include a terminal id.');
  }
  return payload.terminal;
}

class FoxwarmPseudoterminal implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  private readonly closeEmitter = new vscode.EventEmitter<void | number>();
  private readonly changeNameEmitter = new vscode.EventEmitter<string>();
  private socket: WebSocket | undefined;
  private terminalId: string | undefined;
  private lastDimensions: vscode.TerminalDimensions | undefined;
  private closed = false;

  readonly onDidWrite = this.writeEmitter.event;
  readonly onDidClose = this.closeEmitter.event;
  readonly onDidChangeName = this.changeNameEmitter.event;

  constructor(private readonly target: TerminalTarget) {}

  open(initialDimensions: vscode.TerminalDimensions | undefined): void {
    this.lastDimensions = initialDimensions;
    void this.start(initialDimensions);
  }

  close(): void {
    this.closed = true;
    const terminalId = this.terminalId;
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: 'close' }));
    } else if (terminalId) {
      void fetch(`${getApiBase()}/${encodeURIComponent(terminalId)}`, {
        method: 'DELETE',
        credentials: 'include',
      }).catch(() => undefined);
    }
    this.socket?.close();
    this.disposeEmitters();
  }

  handleInput(data: string): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: 'input', data }));
    }
  }

  setDimensions(dimensions: vscode.TerminalDimensions): void {
    this.lastDimensions = dimensions;
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: 'resize', cols: dimensions.columns, rows: dimensions.rows }));
    }
  }

  private async start(initialDimensions: vscode.TerminalDimensions | undefined): Promise<void> {
    try {
      this.writeEmitter.fire(`Connecting to Foxwarm terminal at ${this.target.cwd}\r\n`);
      const terminal = await createBackendTerminal(this.target, initialDimensions || this.lastDimensions);
      if (this.closed) {
        await fetch(`${getApiBase()}/${encodeURIComponent(terminal.id)}`, { method: 'DELETE', credentials: 'include' }).catch(() => undefined);
        return;
      }

      this.terminalId = terminal.id;
      this.changeNameEmitter.fire(`Foxwarm: ${terminal.cwd.split('/').filter(Boolean).pop() || terminal.cwd}`);
      this.attachSocket(terminal.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.writeEmitter.fire(`\r\nFoxwarm terminal failed: ${message}\r\n`);
      this.closeEmitter.fire(1);
      this.disposeEmitters();
    }
  }

  private attachSocket(terminalId: string): void {
    const socket = new WebSocket(getTerminalWebSocketUrl(terminalId));
    this.socket = socket;

    socket.onopen = () => {
      if (this.lastDimensions) {
        socket.send(JSON.stringify({ type: 'resize', cols: this.lastDimensions.columns, rows: this.lastDimensions.rows }));
      }
    };

    socket.onmessage = (event) => {
      try {
        const payload = JSON.parse(String(event.data));
        if (payload.type === 'ready') {
          if (typeof payload.backlog === 'string' && payload.backlog.length > 0) {
            this.writeEmitter.fire(payload.backlog);
          }
          return;
        }
        if (payload.type === 'output' && typeof payload.data === 'string') {
          this.writeEmitter.fire(payload.data);
          return;
        }
        if (payload.type === 'exit') {
          const exitCode = typeof payload.exitCode === 'number' ? payload.exitCode : undefined;
          this.closeEmitter.fire(exitCode);
          this.disposeEmitters();
          return;
        }
        if (payload.type === 'error') {
          this.writeEmitter.fire(`\r\nFoxwarm terminal error: ${payload.message || 'unknown error'}\r\n`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.writeEmitter.fire(`\r\nFoxwarm terminal protocol error: ${message}\r\n`);
      }
    };

    socket.onerror = () => {
      this.writeEmitter.fire('\r\nFoxwarm terminal websocket error\r\n');
    };

    socket.onclose = () => {
      this.socket = undefined;
    };
  }

  private disposeEmitters(): void {
    this.writeEmitter.dispose();
    this.closeEmitter.dispose();
    this.changeNameEmitter.dispose();
  }
}

function getCurrentTarget(): TerminalTarget {
  const target = getWorkspaceTerminalTarget(vscode.workspace.workspaceFolders);
  if (target.nodeId !== 'master') {
    throw new Error(`Foxwarm terminal MVP supports only node \`master\` (workspace uses \`${target.nodeId}\`).`);
  }
  return { nodeId: target.nodeId, cwd: target.realPath };
}

function createTerminalProfile(): vscode.TerminalProfile {
  const target = getCurrentTarget();
  return new vscode.TerminalProfile({
    name: 'Foxwarm Terminal',
    pty: new FoxwarmPseudoterminal(target),
  });
}

export function activate(context: vscode.ExtensionContext): void {
  terminalApiBase = deriveTerminalRouteBase(context.extensionUri, TERMINAL_API_PREFIX);
  terminalStreamBase = deriveTerminalRouteBase(context.extensionUri, TERMINAL_STREAM_PREFIX);
  terminalRouteOrigin = deriveOrigin(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerTerminalProfileProvider('foxwarm-terminal', {
      provideTerminalProfile: () => createTerminalProfile(),
    }),
    vscode.commands.registerCommand('foxwarm-terminal.newTerminal', () => {
      const terminal = vscode.window.createTerminal(createTerminalProfile().options);
      terminal.show();
    }),
  );
  console.log(`Foxwarm terminal profile registered. apiBase=${terminalApiBase} streamBase=${terminalStreamBase}`);
}

export function deactivate(): void {
  // No-op.
}
