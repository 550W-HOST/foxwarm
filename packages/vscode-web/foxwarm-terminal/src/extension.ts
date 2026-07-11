import * as vscode from 'vscode';
import { getWorkspaceTerminalTarget, parseFoxwarmUri } from './foxwarmUri';
import { isTerminalInsideWorkspace, shouldKillBackendTerminal } from './terminalLifecycle';
export { getWorkspaceTerminalTarget, parseFoxwarmUri } from './foxwarmUri';
export { isTerminalInsideWorkspace, shouldKillBackendTerminal } from './terminalLifecycle';

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

type TerminalTarget = { nodeId: string; cwd: string };
type TerminalLocationOption = vscode.TerminalLocation | vscode.TerminalEditorLocationOptions | vscode.TerminalSplitLocationOptions;

const TERMINAL_API_PREFIX = '/api/terminals';
const TERMINAL_STREAM_PREFIX = '/api/terminals/stream';
let terminalApiBase = TERMINAL_API_PREFIX;
let terminalStreamBase = TERMINAL_STREAM_PREFIX;
let terminalRouteOrigin = '';

const terminalBindings = new Map<vscode.Terminal, FoxwarmPseudoterminal>();
const pendingPtys: FoxwarmPseudoterminal[] = [];
const representedBackendIds = new Set<string>();

function deriveTerminalRouteBase(extensionUri: vscode.Uri, apiPath: string): string {
  if (extensionUri.scheme !== 'http' && extensionUri.scheme !== 'https') return apiPath;
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

function getTerminalWebSocketUrl(terminalId: string): string {
  const url = new URL(terminalStreamBase, terminalRouteOrigin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('terminalId', terminalId);
  return url.toString();
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof payload?.error === 'string' ? payload.error : `HTTP ${response.status}`);
  }
  return payload as T;
}

async function listBackendTerminals(): Promise<TerminalRecord[]> {
  const response = await fetch(terminalApiBase, { credentials: 'include' });
  const payload = await readJsonResponse<{ terminals?: TerminalRecord[] }>(response);
  return Array.isArray(payload.terminals) ? payload.terminals : [];
}

async function createBackendTerminal(target: TerminalTarget, dimensions?: vscode.TerminalDimensions): Promise<TerminalRecord> {
  const response = await fetch(terminalApiBase, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodeId: target.nodeId, cwd: target.cwd, cols: dimensions?.columns, rows: dimensions?.rows }),
  });
  const payload = await readJsonResponse<{ terminal?: TerminalRecord }>(response);
  if (!payload.terminal?.id) throw new Error('Terminal create response did not include a terminal id.');
  return payload.terminal;
}

async function deleteBackendTerminal(terminalId: string): Promise<void> {
  const response = await fetch(`${terminalApiBase}/${encodeURIComponent(terminalId)}`, {
    method: 'DELETE',
    credentials: 'include',
  });
  if (!response.ok && response.status !== 404) {
    await readJsonResponse(response);
  }
}

class FoxwarmPseudoterminal implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  private readonly closeEmitter = new vscode.EventEmitter<void | number>();
  private readonly changeNameEmitter = new vscode.EventEmitter<string>();
  private socket: WebSocket | undefined;
  private terminalId: string | undefined;
  private lastDimensions: vscode.TerminalDimensions | undefined;
  private closed = false;
  private started = false;
  private killRequested = false;

  readonly onDidWrite = this.writeEmitter.event;
  readonly onDidClose = this.closeEmitter.event;
  readonly onDidChangeName = this.changeNameEmitter.event;

  constructor(private readonly target: TerminalTarget, private readonly existingTerminal?: TerminalRecord) {
    this.terminalId = existingTerminal?.id;
    if (this.terminalId) representedBackendIds.add(this.terminalId);
  }

  get backendTerminalId(): string | undefined {
    return this.terminalId;
  }

  open(initialDimensions: vscode.TerminalDimensions | undefined): void {
    this.lastDimensions = initialDimensions;
    if (this.started) return;
    this.started = true;
    void this.start(initialDimensions);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket?.close();
    this.socket = undefined;
    this.disposeEmitters();
  }

  requestBackendKill(): void {
    this.killRequested = true;
    this.close();
    const terminalId = this.terminalId;
    if (terminalId) {
      representedBackendIds.delete(terminalId);
      void deleteBackendTerminal(terminalId).catch((error) => console.error('Failed to close Foxwarm backend terminal', error));
    }
  }

  handleInput(data: string): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'input', data }));
  }

  setDimensions(dimensions: vscode.TerminalDimensions): void {
    this.lastDimensions = dimensions;
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: 'resize', cols: dimensions.columns, rows: dimensions.rows }));
    }
  }

  private async start(initialDimensions: vscode.TerminalDimensions | undefined): Promise<void> {
    try {
      this.writeEmitter.fire(`${this.existingTerminal ? 'Reattaching' : 'Connecting'} to Foxwarm terminal at ${this.target.cwd}\r\n`);
      const terminal = this.existingTerminal || await createBackendTerminal(this.target, initialDimensions || this.lastDimensions);
      this.terminalId = terminal.id;
      representedBackendIds.add(terminal.id);
      if (this.killRequested) {
        representedBackendIds.delete(terminal.id);
        await deleteBackendTerminal(terminal.id).catch(() => undefined);
        return;
      }
      if (this.closed) return;
      this.changeNameEmitter.fire(`Foxwarm: ${terminal.cwd.split('/').filter(Boolean).pop() || terminal.cwd}`);
      this.attachSocket(terminal.id);
    } catch (error) {
      if (this.closed) return;
      const message = error instanceof Error ? error.message : String(error);
      this.writeEmitter.fire(`\r\nFoxwarm terminal failed: ${message}\r\n`);
      this.closeEmitter.fire(1);
      this.disposeEmitters();
    }
  }

  private attachSocket(terminalId: string): void {
    if (this.closed || this.socket) return;
    const socket = new WebSocket(getTerminalWebSocketUrl(terminalId));
    this.socket = socket;
    socket.onopen = () => {
      if (this.lastDimensions) socket.send(JSON.stringify({ type: 'resize', cols: this.lastDimensions.columns, rows: this.lastDimensions.rows }));
    };
    socket.onmessage = (event) => {
      try {
        const payload = JSON.parse(String(event.data));
        if (payload.type === 'ready') {
          if (typeof payload.backlog === 'string' && payload.backlog) this.writeEmitter.fire(payload.backlog);
        } else if (payload.type === 'output' && typeof payload.data === 'string') {
          this.writeEmitter.fire(payload.data);
        } else if (payload.type === 'exit') {
          representedBackendIds.delete(terminalId);
          this.closeEmitter.fire(typeof payload.exitCode === 'number' ? payload.exitCode : undefined);
          this.disposeEmitters();
        } else if (payload.type === 'error') {
          this.writeEmitter.fire(`\r\nFoxwarm terminal error: ${payload.message || 'unknown error'}\r\n`);
        }
      } catch (error) {
        this.writeEmitter.fire(`\r\nFoxwarm terminal protocol error: ${error instanceof Error ? error.message : String(error)}\r\n`);
      }
    };
    socket.onerror = () => this.writeEmitter.fire('\r\nFoxwarm terminal websocket error\r\n');
    socket.onclose = () => { if (this.socket === socket) this.socket = undefined; };
  }

  private disposeEmitters(): void {
    this.writeEmitter.dispose();
    this.closeEmitter.dispose();
    this.changeNameEmitter.dispose();
  }
}

function getCurrentTarget(): TerminalTarget {
  const target = getWorkspaceTerminalTarget(vscode.workspace.workspaceFolders);
  if (target.nodeId !== 'master') throw new Error(`Foxwarm terminal MVP supports only node \`master\` (workspace uses \`${target.nodeId}\`).`);
  return { nodeId: target.nodeId, cwd: target.realPath };
}

function getActiveWorkspaceTarget(): { nodeId: string; realPath: string } | undefined {
  const folder = vscode.workspace.workspaceFolders?.find((candidate) => candidate.uri.scheme === 'foxwarm');
  if (!folder) return undefined;
  const target = parseFoxwarmUri(folder.uri);
  return { nodeId: target.nodeId, realPath: target.realPath };
}

function ensureSupportedTarget(target: TerminalTarget): TerminalTarget {
  if (target.nodeId !== 'master') throw new Error(`Foxwarm terminal MVP supports only node \`master\` (target uses \`${target.nodeId}\`).`);
  return target;
}

function queuePty(pty: FoxwarmPseudoterminal): FoxwarmPseudoterminal {
  pendingPtys.push(pty);
  return pty;
}

function removePendingPty(pty: FoxwarmPseudoterminal): void {
  const index = pendingPtys.indexOf(pty);
  if (index >= 0) pendingPtys.splice(index, 1);
}

function createTerminalProfile(target: TerminalTarget = getCurrentTarget(), location?: TerminalLocationOption, existing?: TerminalRecord): vscode.TerminalProfile {
  const supportedTarget = ensureSupportedTarget(target);
  const pty = queuePty(new FoxwarmPseudoterminal(supportedTarget, existing));
  return new vscode.TerminalProfile({ name: 'Foxwarm Terminal', pty, location });
}

function ptyFromTerminal(terminal: vscode.Terminal): FoxwarmPseudoterminal | undefined {
  const candidate = (terminal.creationOptions as vscode.ExtensionTerminalOptions | undefined)?.pty;
  if (candidate instanceof FoxwarmPseudoterminal) {
    return candidate;
  }
  return terminal.name === 'Foxwarm Terminal' ? pendingPtys[0] : undefined;
}

function bindTerminal(terminal: vscode.Terminal, pty: FoxwarmPseudoterminal): void {
  removePendingPty(pty);
  terminalBindings.set(terminal, pty);
}

function openNewTerminal(target: TerminalTarget = getCurrentTarget(), location?: TerminalLocationOption, existing?: TerminalRecord, show = true): vscode.Terminal {
  const profile = createTerminalProfile(target, location, existing);
  const terminal = vscode.window.createTerminal(profile.options);
  const pty = (profile.options as vscode.ExtensionTerminalOptions).pty as FoxwarmPseudoterminal;
  bindTerminal(terminal, pty);
  if (show) terminal.show();
  return terminal;
}

function toggleTerminal(): void {
  if (vscode.window.activeTerminal) void vscode.commands.executeCommand('workbench.action.terminal.toggleTerminal');
  else openNewTerminal();
}

function dirname(realPath: string): string {
  const normalized = realPath.replace(/\/+$/, '') || '/';
  if (normalized === '/') return '/';
  const index = normalized.lastIndexOf('/');
  return index <= 0 ? '/' : normalized.slice(0, index);
}

async function getTargetForResource(uri: vscode.Uri | undefined): Promise<TerminalTarget> {
  if (!uri || uri.scheme !== 'foxwarm') return getCurrentTarget();
  const target = parseFoxwarmUri(uri);
  const stat = await vscode.workspace.fs.stat(uri).catch(() => undefined);
  return ensureSupportedTarget({ nodeId: target.nodeId, cwd: stat?.type === vscode.FileType.Directory ? target.realPath : dirname(target.realPath) });
}

async function restoreBackendTerminals(): Promise<void> {
  const workspace = getActiveWorkspaceTarget();
  if (!workspace || workspace.nodeId !== 'master') return;
  const records = await listBackendTerminals();
  for (const record of records) {
    if (!isTerminalInsideWorkspace(record, workspace) || representedBackendIds.has(record.id)) continue;
    openNewTerminal({ nodeId: record.nodeId, cwd: record.cwd }, undefined, record, false);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  terminalApiBase = deriveTerminalRouteBase(context.extensionUri, TERMINAL_API_PREFIX);
  terminalStreamBase = deriveTerminalRouteBase(context.extensionUri, TERMINAL_STREAM_PREFIX);
  terminalRouteOrigin = deriveOrigin(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerTerminalProfileProvider('foxwarm-terminal', { provideTerminalProfile: () => createTerminalProfile() }),
    vscode.window.onDidOpenTerminal((terminal) => {
      const pty = ptyFromTerminal(terminal);
      if (pty) bindTerminal(terminal, pty);
    }),
    vscode.window.onDidCloseTerminal((terminal) => {
      const pty = terminalBindings.get(terminal);
      terminalBindings.delete(terminal);
      if (!pty) return;
      if (shouldKillBackendTerminal(terminal.exitStatus?.reason)) pty.requestBackendKill();
      else pty.close();
    }),
    vscode.commands.registerCommand('foxwarm-terminal.newTerminal', () => openNewTerminal()),
    vscode.commands.registerCommand('foxwarm-terminal.toggleTerminal', toggleTerminal),
    vscode.commands.registerCommand('foxwarm-terminal.openInEditorArea', () => openNewTerminal(getCurrentTarget(), vscode.TerminalLocation.Editor)),
    vscode.commands.registerCommand('foxwarm-terminal.openHere', async (uri?: vscode.Uri) => openNewTerminal(await getTargetForResource(uri))),
  );
  void restoreBackendTerminals().catch((error) => console.error('Failed to restore Foxwarm terminals', error));
  console.log(`Foxwarm terminal profile registered. apiBase=${terminalApiBase} streamBase=${terminalStreamBase}`);
}

export function deactivate(): void {
  for (const pty of terminalBindings.values()) pty.close();
  terminalBindings.clear();
  pendingPtys.length = 0;
}
