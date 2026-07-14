import * as vscode from 'vscode';
import { FoxwarmFileSystemProvider } from './provider';
import { buildFoxwarmNodeUriString, parseFoxwarmUri } from './foxwarmUri';
import { normalizeFoxwarmOpenRequest, type FoxwarmOpenRequest } from './openRequest';
export { buildFoxwarmNodeUriString, parseFoxwarmUri } from './foxwarmUri';
export { normalizeFoxwarmOpenRequest } from './openRequest';

async function waitForInitialWorkspaceFolders(): Promise<readonly vscode.WorkspaceFolder[]> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) return folders;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Code workspace folders did not finish loading.');
}

function getCurrentNodeId(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return 'master';
  }
  try {
    return parseFoxwarmUri(folder.uri).nodeId;
  } catch {
    return 'master';
  }
}

function getCurrentPath(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return '/';
  }
  try {
    return parseFoxwarmUri(folder.uri).realPath;
  } catch {
    return '/';
  }
}

async function addFoxwarmFolder(request: FoxwarmOpenRequest): Promise<{ status: 'added' | 'existing'; uri: string }> {
  const normalized = normalizeFoxwarmOpenRequest(request);
  if (normalized.kind !== 'addFolder') {
    throw new Error('Expected an addFolder request.');
  }
  const uri = vscode.Uri.parse(buildFoxwarmNodeUriString(normalized.nodeId, normalized.path));
  const uriString = uri.toString(true);
  const workspaceFolders = await waitForInitialWorkspaceFolders();
  const existing = workspaceFolders.some((folder) => {
    try {
      const target = parseFoxwarmUri(folder.uri);
      return target.nodeId === normalized.nodeId && target.realPath === normalized.path;
    } catch {
      return false;
    }
  }) ?? false;
  if (existing) {
    return { status: 'existing', uri: uriString };
  }

  let folderChangeListener: vscode.Disposable | undefined;
  let folderChangeTimeout: ReturnType<typeof setTimeout> | undefined;
  const folderAdded = new Promise<void>((resolve, reject) => {
    folderChangeTimeout = setTimeout(() => {
      folderChangeListener?.dispose();
      reject(new Error(`Timed out while adding ${normalized.path} to the current workspace.`));
    }, 15_000);
    folderChangeListener = vscode.workspace.onDidChangeWorkspaceFolders((event) => {
      if (!event.added.some((folder) => folder.uri.toString(true) === uriString)) return;
      if (folderChangeTimeout) clearTimeout(folderChangeTimeout);
      folderChangeListener?.dispose();
      resolve();
    });
  });
  const accepted = vscode.workspace.updateWorkspaceFolders(
    workspaceFolders.length,
    0,
    { uri },
  );
  if (!accepted) {
    if (folderChangeTimeout) clearTimeout(folderChangeTimeout);
    folderChangeListener?.dispose();
    throw new Error(`Could not add ${normalized.path} to the current workspace.`);
  }
  await folderAdded;
  return { status: 'added', uri: uriString };
}

async function openFoxwarmFolder(): Promise<void> {
  const value = await vscode.window.showInputBox({
    title: 'Open Foxwarm Folder',
    prompt: 'Absolute path on the current Foxwarm node.',
    value: getCurrentPath(),
    validateInput: (input) => input.startsWith('/') ? undefined : 'Use an absolute path, for example /app.',
  });
  if (!value) {
    return;
  }
  await addFoxwarmFolder({ kind: 'addFolder', nodeId: getCurrentNodeId(), path: value });
}

async function addExplorerFolderToWorkspace(uri: vscode.Uri): Promise<void> {
  const target = parseFoxwarmUri(uri);
  const stat = await vscode.workspace.fs.stat(uri);
  if ((stat.type & vscode.FileType.Directory) === 0) throw new Error(`${target.realPath} is not a directory.`);
  await addFoxwarmFolder({ kind: 'addFolder', nodeId: target.nodeId, path: target.realPath });
}

async function openFoxwarmFile(
  request: FoxwarmOpenRequest,
  provider: FoxwarmFileSystemProvider,
): Promise<{ status: 'opened'; uri: string }> {
  const normalized = normalizeFoxwarmOpenRequest(request);
  if (normalized.kind !== 'openFile') throw new Error('Expected an openFile request.');
  const uri = vscode.Uri.parse(buildFoxwarmNodeUriString(normalized.nodeId, normalized.path));
  const stat = await vscode.workspace.fs.stat(uri);
  if ((stat.type & vscode.FileType.Directory) !== 0) {
    throw new Error(`${normalized.path} is a directory, not a file.`);
  }

  const existing = vscode.workspace.textDocuments.find((document) => document.uri.toString(true) === uri.toString(true));
  if (!existing?.isDirty) provider.notifyExternalChange(uri);
  const document = existing ?? await vscode.workspace.openTextDocument(uri);
  let selection: vscode.Range | undefined;
  if (normalized.startLine !== undefined) {
    if (normalized.startLine > document.lineCount) {
      throw new Error(`Line ${normalized.startLine} is beyond the end of ${normalized.path}.`);
    }
    if (normalized.startColumn !== undefined) {
      const line = document.lineAt(normalized.startLine - 1);
      const position = new vscode.Position(normalized.startLine - 1, Math.min(normalized.startColumn - 1, line.text.length));
      selection = new vscode.Range(position, position);
    } else {
      const endLine = Math.min(normalized.endLine ?? normalized.startLine, document.lineCount);
      selection = new vscode.Range(
        new vscode.Position(normalized.startLine - 1, 0),
        document.lineAt(endLine - 1).range.end,
      );
    }
  }
  await vscode.window.showTextDocument(document, { preview: true, selection });
  if (existing?.isDirty) {
    void vscode.window.showWarningMessage(`${normalized.path} has unsaved Code changes; the external file was not reloaded.`);
  }
  return { status: 'opened', uri: uri.toString(true) };
}

async function handleOpenRequest(request: FoxwarmOpenRequest, provider: FoxwarmFileSystemProvider): Promise<unknown> {
  const normalized = normalizeFoxwarmOpenRequest(request);
  if (normalized.kind === 'addFolder') {
    return addFoxwarmFolder(normalized);
  }
  return openFoxwarmFile(normalized, provider);
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = FoxwarmFileSystemProvider.fromExtensionContext(context);
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider('foxwarm', provider, {
      isCaseSensitive: true,
      isReadonly: false,
    }),
    vscode.commands.registerCommand('foxwarm-fs.openFolder', openFoxwarmFolder),
    vscode.commands.registerCommand('foxwarm-fs.addFolderToWorkspace', addExplorerFolderToWorkspace),
    vscode.commands.registerCommand('foxwarm-fs.handleOpenRequest', (request: FoxwarmOpenRequest) => handleOpenRequest(request, provider)),
  );
  console.log('Foxwarm filesystem provider registered for foxwarm://node+<nodeId>/<absolute-path>.');
}

export function deactivate(): void {
  // No-op.
}
