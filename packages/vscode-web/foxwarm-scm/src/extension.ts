import * as vscode from 'vscode';
import { buildFoxwarmNodeUriString, normalizeGitRelativePath, parseFoxwarmUri } from './foxwarmUri';
export { buildFoxwarmNodeUriString, normalizeGitRelativePath, parseFoxwarmUri } from './foxwarmUri';

type GitSubmoduleChange = {
  headOid: string;
  indexOid: string;
  worktreeOid?: string;
  dirty: boolean;
};

type GitChange = {
  path: string;
  oldPath?: string;
  indexStatus: string;
  workingTreeStatus: string;
  kind: string;
  submoduleState?: string;
  submodule?: GitSubmoduleChange;
};

type GitStatusResponse = {
  nodeId: string;
  workspace: string;
  topLevel?: string;
  changes: GitChange[];
};

type WorkspaceTarget = {
  nodeId: string;
  realPath: string;
  uri: vscode.Uri;
};

type RepositoryState = {
  key: string;
  workspace: WorkspaceTarget;
  sourceControl: vscode.SourceControl;
  changesGroup: vscode.SourceControlResourceGroup;
  changes: GitChange[];
};

const GIT_API_PREFIX = '/api/vscode-web/git';
let gitApiBase = GIT_API_PREFIX;
let sourceControlSequence = 0;
const repositories = new Map<string, RepositoryState>();

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

function getFoxwarmWorkspaces(): WorkspaceTarget[] {
  return (vscode.workspace.workspaceFolders || [])
    .filter((folder) => folder.uri.scheme === 'foxwarm')
    .map((folder) => {
      const target = parseFoxwarmUri(folder.uri);
      return { nodeId: target.nodeId, realPath: target.realPath, uri: folder.uri };
    })
    .sort((left, right) => right.realPath.length - left.realPath.length);
}

function isPathWithin(parentPath: string, childPath: string): boolean {
  const parent = parentPath.replace(/\/+$/, '') || '/';
  const child = childPath.replace(/\/+$/, '') || '/';
  return child === parent || parent === '/' || child.startsWith(`${parent}/`);
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

function shortOid(oid: string | undefined): string | undefined {
  return oid ? oid.slice(0, 12) : undefined;
}

function getChangeDescription(change: GitChange): string {
  const xy = `${change.indexStatus}${change.workingTreeStatus}`;
  if (change.submodule) {
    const oldOid = shortOid(change.submodule.headOid);
    const newOid = shortOid(change.submodule.worktreeOid || change.submodule.indexOid);
    const transition = oldOid && newOid ? ` ${oldOid} → ${newOid}${change.submodule.dirty ? '-dirty' : ''}` : '';
    return `submodule (${xy})${transition}`;
  }
  return `${change.kind} (${xy})`;
}

function getWorkingUri(repository: RepositoryState, change: GitChange): vscode.Uri {
  const root = repository.workspace.realPath.replace(/\/+$/, '');
  return vscode.Uri.parse(buildFoxwarmNodeUriString(repository.workspace.nodeId, `${root}/${normalizeGitRelativePath(change.path)}`));
}

function getSubmoduleOid(change: GitChange, side: 'base' | 'working'): string | undefined {
  if (!change.submodule) return undefined;
  return side === 'base'
    ? change.submodule.headOid
    : (change.submodule.worktreeOid || change.submodule.indexOid);
}

function getGitContentUri(repository: RepositoryState, change: GitChange, side: 'base' | 'working'): vscode.Uri {
  const relativePath = side === 'base' && change.oldPath ? change.oldPath : change.path;
  const query = queryString({
    nodeId: repository.workspace.nodeId,
    workspace: repository.workspace.realPath,
    path: relativePath,
    side,
    ref: 'HEAD',
    submoduleOid: getSubmoduleOid(change, side),
    submoduleDirty: side === 'working' && change.submodule?.dirty ? 'true' : undefined,
  });
  return vscode.Uri.from({
    scheme: 'foxwarm-git',
    authority: `node+${encodeURIComponent(repository.workspace.nodeId)}`,
    path: `/${side}/${normalizeGitRelativePath(relativePath)}`,
    query,
  });
}

async function openChange(repository: RepositoryState, change: GitChange): Promise<void> {
  const left = getGitContentUri(repository, change, 'base');
  const right = getGitContentUri(repository, change, 'working');
  await vscode.commands.executeCommand('vscode.diff', left, right, `${getChangeLabel(change)} (HEAD ↔ Working Tree)`);
}

function toResourceState(repository: RepositoryState, change: GitChange): vscode.SourceControlResourceState {
  return {
    resourceUri: getWorkingUri(repository, change),
    command: {
      command: 'foxwarm-scm.openChange',
      title: 'Open Change',
      arguments: [repository.key, change],
    },
    decorations: {
      tooltip: getChangeDescription(change),
      strikeThrough: change.kind === 'deleted',
      faded: change.kind === 'deleted',
    },
  };
}

function toMultiDiffResource(repository: RepositoryState, change: GitChange): { originalUri?: vscode.Uri; modifiedUri?: vscode.Uri } {
  if (change.kind === 'added' || change.kind === 'untracked') {
    return { modifiedUri: getGitContentUri(repository, change, 'working') };
  }
  if (change.kind === 'deleted') {
    return { originalUri: getGitContentUri(repository, change, 'base') };
  }
  return {
    originalUri: getGitContentUri(repository, change, 'base'),
    modifiedUri: getGitContentUri(repository, change, 'working'),
  };
}

async function pickRepository(): Promise<RepositoryState | undefined> {
  const available = [...repositories.values()];
  if (available.length <= 1) return available[0];
  const picked = await vscode.window.showQuickPick(
    available.map((repository) => ({
      label: repository.workspace.realPath.split('/').filter(Boolean).pop() || '/',
      description: repository.workspace.realPath,
      repository,
    })),
    { placeHolder: 'Select a Foxwarm Git repository' },
  );
  return picked?.repository;
}

function findRepository(argument: unknown): RepositoryState | undefined {
  if (typeof argument === 'string') return repositories.get(argument);
  if (argument && typeof argument === 'object') {
    const rootUri = (argument as { rootUri?: vscode.Uri }).rootUri;
    if (rootUri) {
      return [...repositories.values()].find((repository) => repository.sourceControl.rootUri?.toString() === rootUri.toString());
    }
  }
  return undefined;
}

async function openAllChanges(argument?: unknown): Promise<void> {
  const repository = findRepository(argument) || await pickRepository();
  if (!repository) return;
  if (repository.changes.length === 0) {
    void vscode.window.showInformationMessage('There are no changes in this repository.');
    return;
  }
  const name = repository.workspace.realPath.split('/').filter(Boolean).pop() || '/';
  await vscode.commands.executeCommand('_workbench.openMultiDiffEditor', {
    multiDiffSourceUri: vscode.Uri.from({
      scheme: 'foxwarm-scm',
      authority: `node+${encodeURIComponent(repository.workspace.nodeId)}`,
      path: repository.workspace.realPath,
    }),
    title: `Changes in ${name}`,
    resources: repository.changes.map((change) => toMultiDiffResource(repository, change)),
  });
}

async function discoverRepositories(): Promise<Array<{ workspace: WorkspaceTarget; status: GitStatusResponse }>> {
  const discovered: Array<{ workspace: WorkspaceTarget; status: GitStatusResponse }> = [];
  for (const workspace of getFoxwarmWorkspaces()) {
    if (discovered.some((entry) => entry.workspace.nodeId === workspace.nodeId && isPathWithin(entry.workspace.realPath, workspace.realPath))) {
      continue;
    }
    try {
      const url = `${gitApiBase}/status?${queryString({ nodeId: workspace.nodeId, workspace: workspace.realPath })}`;
      const status = await fetchJson<GitStatusResponse>(url);
      const topLevel = status.topLevel || status.workspace;
      const repositoryWorkspace = {
        nodeId: status.nodeId,
        realPath: topLevel,
        uri: vscode.Uri.parse(buildFoxwarmNodeUriString(status.nodeId, topLevel)),
      };
      if (!discovered.some((entry) => entry.workspace.nodeId === repositoryWorkspace.nodeId && entry.workspace.realPath === repositoryWorkspace.realPath)) {
        discovered.push({ workspace: repositoryWorkspace, status });
      }
    } catch (error) {
      console.debug(`Foxwarm SCM skipped non-Git workspace ${workspace.realPath}`, error);
    }
  }
  return discovered;
}

async function refresh(): Promise<void> {
  const discovered = await discoverRepositories();
  const seen = new Set<string>();
  for (const entry of discovered) {
    const key = `${entry.workspace.nodeId}:${entry.workspace.realPath}`;
    seen.add(key);
    let repository = repositories.get(key);
    if (!repository) {
      const id = `foxwarm-scm-${++sourceControlSequence}`;
      const name = entry.workspace.realPath.split('/').filter(Boolean).pop() || '/';
      const sourceControl = vscode.scm.createSourceControl(id, `Foxwarm Git: ${name}`, entry.workspace.uri);
      const changesGroup = sourceControl.createResourceGroup('changes', 'Changes');
      repository = { key, workspace: entry.workspace, sourceControl, changesGroup, changes: [] };
      repositories.set(key, repository);
    }
    repository.workspace = entry.workspace;
    repository.changes = entry.status.changes;
    repository.sourceControl.rootUri = entry.workspace.uri;
    repository.sourceControl.inputBox.placeholder = 'Foxwarm Git status is read-only';
    repository.changesGroup.resourceStates = repository.changes.map((change) => toResourceState(repository!, change));
    repository.sourceControl.count = repository.changes.length;
  }
  for (const [key, repository] of repositories) {
    if (seen.has(key)) continue;
    repository.sourceControl.dispose();
    repositories.delete(key);
  }
}

class FoxwarmGitContentProvider implements vscode.TextDocumentContentProvider {
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const params = new URLSearchParams(uri.query);
    const submoduleOid = params.get('submoduleOid');
    if (submoduleOid) {
      const dirty = params.get('submoduleDirty') === 'true' ? '-dirty' : '';
      return `Subproject commit ${submoduleOid}${dirty}\n`;
    }
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
    vscode.commands.registerCommand('foxwarm-scm.openChange', (repositoryKey: string, change: GitChange) => {
      const repository = repositories.get(repositoryKey);
      return repository ? openChange(repository, change) : undefined;
    }),
    vscode.commands.registerCommand('foxwarm-scm.openAllChanges', (sourceControl?: unknown) => openAllChanges(sourceControl)),
    vscode.workspace.onDidChangeWorkspaceFolders(() => refresh()),
  );
  void refresh().catch((error) => {
    console.error('Foxwarm SCM refresh failed', error);
  });
  console.log(`Foxwarm SCM registered. apiBase=${gitApiBase}`);
}

export function deactivate(): void {
  for (const repository of repositories.values()) repository.sourceControl.dispose();
  repositories.clear();
}
