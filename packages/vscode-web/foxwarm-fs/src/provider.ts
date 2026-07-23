import * as vscode from 'vscode';
import { parseFoxwarmUri } from './foxwarmUri';
import { normalizeWorkspaceRootsResponse, type FoxwarmWorkspaceRootKind, type FoxwarmWorkspaceRoot } from './workspaceRoots';

const API_PREFIX = '/api/vscode-web/fs';

function deriveApiBase(extensionUri: vscode.Uri): string {
  if (extensionUri.scheme !== 'http' && extensionUri.scheme !== 'https') {
    return API_PREFIX;
  }

  const marker = '/vscode-web/extensions/foxwarm-fs';
  const markerIndex = extensionUri.path.indexOf(marker);
  const prefix = markerIndex >= 0 ? extensionUri.path.slice(0, markerIndex) : '';
  return `${extensionUri.scheme}://${extensionUri.authority}${prefix}${API_PREFIX}`;
}

function queryString(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      search.set(key, String(value));
    }
  }
  return search.toString();
}

function mapFileSystemError(uri: vscode.Uri, status: number, code?: string, message?: string): vscode.FileSystemError {
  switch (code || status) {
    case 'FileNotFound':
    case 404:
      return vscode.FileSystemError.FileNotFound(uri);
    case 'FileExists':
    case 409:
      return vscode.FileSystemError.FileExists(uri);
    case 'FileNotADirectory':
      return vscode.FileSystemError.FileNotADirectory(uri);
    case 'FileIsADirectory':
      return vscode.FileSystemError.FileIsADirectory(uri);
    case 'NoPermissions':
    case 401:
    case 403:
      return vscode.FileSystemError.NoPermissions(uri);
    case 'Unavailable':
    case 503:
      return vscode.FileSystemError.Unavailable(uri);
    default:
      return new vscode.FileSystemError(message || `Foxwarm filesystem request failed (${status}).`);
  }
}

export class FoxwarmFileSystemProvider implements vscode.FileSystemProvider {
  private readonly changeEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.changeEmitter.event;

  constructor(private readonly apiBase: string) {}

  static fromExtensionContext(context: vscode.ExtensionContext): FoxwarmFileSystemProvider {
    return new FoxwarmFileSystemProvider(deriveApiBase(context.extensionUri));
  }

  watch(_uri: vscode.Uri, _options: { readonly recursive: boolean; readonly excludes: readonly string[] }): vscode.Disposable {
    // MVP: no backend watch channel yet. VS Code still functions with explicit
    // refreshes and events emitted for writes through this provider.
    return new vscode.Disposable(() => undefined);
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    return this.fetchJson(uri, 'stat');
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const payload = await this.fetchJson<{ entries: Array<{ name: string; type: vscode.FileType }> }>(uri, 'read-directory');
    return payload.entries.map((entry) => [entry.name, entry.type]);
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const response = await this.fetch(uri, 'read-file');
    return new Uint8Array(await response.arrayBuffer());
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array, options: { readonly create: boolean; readonly overwrite: boolean }): Promise<void> {
    await this.fetch(uri, 'write-file', {
      method: 'PUT',
      query: { create: options.create ? 1 : 0, overwrite: options.overwrite ? 1 : 0 },
      body: content,
      headers: { 'Content-Type': 'application/octet-stream' },
    });
    this.fireSoon({ type: vscode.FileChangeType.Changed, uri });
  }

  async createDirectory(uri: vscode.Uri): Promise<void> {
    await this.postJson(uri, 'create-directory', {});
    this.fireSoon({ type: vscode.FileChangeType.Created, uri });
  }

  async delete(uri: vscode.Uri, options: { readonly recursive: boolean }): Promise<void> {
    await this.postJson(uri, 'delete', { recursive: options.recursive });
    this.fireSoon({ type: vscode.FileChangeType.Deleted, uri });
  }

  async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { readonly overwrite: boolean }): Promise<void> {
    const oldTarget = parseFoxwarmUri(oldUri);
    const newTarget = parseFoxwarmUri(newUri);
    if (oldTarget.nodeId !== newTarget.nodeId || oldTarget.namespace !== newTarget.namespace) {
      throw vscode.FileSystemError.NoPermissions(newUri);
    }

    const response = await fetch(`${this.apiBase}/rename`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nodeId: oldTarget.nodeId,
        oldPath: oldTarget.realPath,
        newPath: newTarget.realPath,
        overwrite: options.overwrite,
      }),
    });
    await this.ensureOk(newUri, response);
    this.fireSoon(
      { type: vscode.FileChangeType.Deleted, uri: oldUri },
      { type: vscode.FileChangeType.Created, uri: newUri },
    );
  }

  notifyExternalChange(uri: vscode.Uri): void {
    this.fireSoon({ type: vscode.FileChangeType.Changed, uri });
  }

  async getWorkspaceRoots(): Promise<Record<FoxwarmWorkspaceRootKind, FoxwarmWorkspaceRoot>> {
    const response = await fetch(`${this.apiBase}/workspace-roots`, { credentials: 'include' });
    if (!response.ok) {
      let message = `Foxwarm workspace root request failed (${response.status}).`;
      try {
        const payload = await response.json() as { error?: unknown };
        if (typeof payload.error === 'string' && payload.error) message = payload.error;
      } catch {
        // Keep the status-based error for non-JSON responses.
      }
      throw new Error(message);
    }
    return normalizeWorkspaceRootsResponse(await response.json());
  }

  private async fetchJson<T>(uri: vscode.Uri, operation: string): Promise<T> {
    const response = await this.fetch(uri, operation);
    return response.json() as Promise<T>;
  }

  private async postJson(uri: vscode.Uri, operation: string, body: Record<string, unknown>): Promise<void> {
    await this.fetch(uri, operation, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  private async fetch(uri: vscode.Uri, operation: string, init?: RequestInit & { query?: Record<string, string | number | boolean | undefined> }): Promise<Response> {
    const target = parseFoxwarmUri(uri);
    const query = queryString({ nodeId: target.nodeId, path: target.realPath, ...init?.query });
    const response = await fetch(`${this.apiBase}/${operation}?${query}`, {
      ...init,
      credentials: 'include',
    });
    await this.ensureOk(uri, response);
    return response;
  }

  private async ensureOk(uri: vscode.Uri, response: Response): Promise<void> {
    if (response.ok) {
      return;
    }

    let payload: { code?: string; error?: string } = {};
    try {
      payload = await response.json();
    } catch {
      // ignore non-json error bodies
    }
    throw mapFileSystemError(uri, response.status, payload.code, payload.error);
  }

  private fireSoon(...events: vscode.FileChangeEvent[]): void {
    this.changeEmitter.fire(events);
  }
}
