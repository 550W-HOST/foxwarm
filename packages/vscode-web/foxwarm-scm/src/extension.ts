import * as vscode from 'vscode';
import { buildFoxwarmNodeUriString, normalizeGitRelativePath, parseFoxwarmUri } from './foxwarmUri';
export { buildFoxwarmNodeUriString, normalizeGitRelativePath, parseFoxwarmUri } from './foxwarmUri';

type GitChange = {
  path: string;
  oldPath?: string;
  indexStatus: string;
  workingTreeStatus: string;
  kind: string;
};

type GitStatusResponse = {
  nodeId: string;
  workspace: string;
  topLevel?: string;
  changes: GitChange[];
};

const GIT_API_PREFIX = '/api/vscode-web/git';
let gitApiBase = GIT_API_PREFIX;
let sourceControl: vscode.SourceControl | undefined;
let changesGroup: vscode.SourceControlResourceGroup | undefined;
let currentWorkspace: { nodeId: string; realPath: string; uri: vscode.Uri } | undefined;

function deriveGitApiBase(extensionUri: vscode.Uri): string {
  if (extensionUri.scheme !== 'http' && extensionUri.scheme !== 'https') {
    return GIT_API_PREFIX;
  }
  const marker = '/vscode-web/extensions/foxwarm-scm';
  const markerIndex = extensionUri.path.indexOf(marker);
  const prefix = markerIndex >= 0 ? extensionUri.path.slice(0, markerIndex) : '';
  return `${extensionUri.scheme}://${extensionUri.authority}${prefix}${GIT_API_PREFIX}`;
}

function queryString(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      search.set(key, value);
    }
  }
  return search.toString();
}

function getFoxwarmWorkspace(): { nodeId: string; realPath: string; uri: vscode.Uri } | undefined {
  const folder = vscode.workspace.workspaceFolders?.find((candidate) => candidate.uri.scheme === 'foxwarm');
  if (!folder) {
    return undefined;
  }
  const target = parseFoxwarmUri(folder.uri);
  return { nodeId: target.nodeId, realPath: target.realPath, uri: folder.uri };
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: 'include' });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof payload?.error === 'string' ? payload.error : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return payload as T;
}

function getChangeLabel(change: GitChange): string {
  return change.oldPath ? `${change.oldPath} → ${change.path}` : change.path;
}

function getChangeDescription(change: GitChange): string {
  const xy = `${change.indexStatus}${change.workingTreeStatus}`;
  return `${change.kind} (${xy})`;
}

function getWorkingUri(change: GitChange): vscode.Uri {
  if (!currentWorkspace) {
    throw new Error('No Foxwarm workspace is active.');
  }
  return vscode.Uri.parse(buildFoxwarmNodeUriString(currentWorkspace.nodeId, `${currentWorkspace.realPath.replace(/\/+$/, '')}/${normalizeGitRelativePath(change.path)}`));
}

function getGitContentUri(change: GitChange, side: 'base' | 'working'): vscode.Uri {
  if (!currentWorkspace) {
    throw new Error('No Foxwarm workspace is active.');
  }
  const query = queryString({
    nodeId: currentWorkspace.nodeId,
    workspace: currentWorkspace.realPath,
    path: change.path,
    side,
    ref: 'HEAD',
  });
  return vscode.Uri.from({
    scheme: 'foxwarm-git',
    authority: `node+${encodeURIComponent(currentWorkspace.nodeId)}`,
    path: `/${side}/${normalizeGitRelativePath(change.path)}`,
    query,
  });
}

async function openChange(change: GitChange): Promise<void> {
  const left = getGitContentUri(change, 'base');
  const right = getGitContentUri(change, 'working');
  await vscode.commands.executeCommand('vscode.diff', left, right, `${getChangeLabel(change)} (HEAD ↔ Working Tree)`);
}

function toResourceState(change: GitChange): vscode.SourceControlResourceState {
  return {
    resourceUri: getWorkingUri(change),
    command: {
      command: 'foxwarm-scm.openChange',
      title: 'Open Change',
      arguments: [change],
    },
    decorations: {
      tooltip: getChangeDescription(change),
      strikeThrough: change.kind === 'deleted',
      faded: change.kind === 'deleted',
    },
  };
}

async function refresh(): Promise<void> {
  const workspace = getFoxwarmWorkspace();
  currentWorkspace = workspace;
  if (!workspace) {
    if (sourceControl) {
      sourceControl.dispose();
      sourceControl = undefined;
      changesGroup = undefined;
    }
    return;
  }
  if (!sourceControl) {
    sourceControl = vscode.scm.createSourceControl('foxwarm-scm', 'Foxwarm Git', workspace.uri);
    sourceControl.acceptInputCommand = { command: 'foxwarm-scm.refresh', title: 'Refresh Git Status' };
    changesGroup = sourceControl.createResourceGroup('changes', 'Changes');
  }
  sourceControl.rootUri = workspace.uri;
  sourceControl.inputBox.placeholder = 'Foxwarm Git status is read-only in this MVP';
  const url = `${gitApiBase}/status?${queryString({ nodeId: workspace.nodeId, workspace: workspace.realPath })}`;
  const status = await fetchJson<GitStatusResponse>(url);
  changesGroup!.resourceStates = status.changes.map(toResourceState);
  sourceControl.count = status.changes.length;
}

class FoxwarmGitContentProvider implements vscode.TextDocumentContentProvider {
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const response = await fetch(`${gitApiBase}/content?${uri.query}`, { credentials: 'include' });
    if (response.status === 404) {
      return '';
    }
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(typeof payload?.error === 'string' ? payload.error : `HTTP ${response.status}`);
    }
    return response.text();
  }
}

export function activate(context: vscode.ExtensionContext): void {
  gitApiBase = deriveGitApiBase(context.extensionUri);
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider('foxwarm-git', new FoxwarmGitContentProvider()),
    vscode.commands.registerCommand('foxwarm-scm.refresh', () => refresh()),
    vscode.commands.registerCommand('foxwarm-scm.openChange', (change: GitChange) => openChange(change)),
    vscode.workspace.onDidChangeWorkspaceFolders(() => refresh()),
  );
  void refresh().catch((error) => {
    console.error('Foxwarm SCM refresh failed', error);
  });
  console.log(`Foxwarm SCM registered. apiBase=${gitApiBase}`);
}

export function deactivate(): void {
  sourceControl?.dispose();
}
