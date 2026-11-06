import { codeWorkspaceNode } from '../../../shared/src/codeWorkspace';
import * as vscode from 'vscode';
import { FoxwarmFileSystemProvider } from './provider';
import { buildFoxwarmNodeUriString, parseFoxwarmUri } from './foxwarmUri';
import { normalizeFoxwarmOpenRequest, type FoxwarmOpenRequest } from './openRequest';
import { registerFoxwarmConfigSchemas } from './configSchemas';
import {
  normalizeWorkspaceRootsResponse,
  type FoxwarmWorkspaceRootKind,
} from './workspaceRoots';
export { buildFoxwarmNodeUriString, parseFoxwarmUri } from './foxwarmUri';
export { normalizeFoxwarmOpenRequest } from './openRequest';
export {
  FOXWARM_APP_SCHEMA_URI,
  FOXWARM_MODELS_SCHEMA_URI,
  getFoxwarmConfigSchemaContent,
  getFoxwarmConfigSchemaUri,
  registerFoxwarmConfigSchemas,
} from './configSchemas';
export { isExactWorkspaceRoot, normalizeConfigFilesResponse, normalizeWorkspaceRootsResponse } from './workspaceRoots';

function getCurrentNodeId(): string {
  const workspaceFile = vscode.workspace.workspaceFile;
  if (workspaceFile?.scheme === 'foxwarm') {
    const nodeId = codeWorkspaceNode(parseFoxwarmUri(workspaceFile).realPath);
    if (nodeId) return nodeId;
  }
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

async function loadedWorkspaceFolders(): Promise<readonly vscode.WorkspaceFolder[]> {
  const workspaceFile = vscode.workspace.workspaceFile;
  if (vscode.workspace.workspaceFolders?.length || !workspaceFile) return vscode.workspace.workspaceFolders ?? [];
  // The custom provider activates before Code has read its workspace file. An
  // initial empty folder snapshot is not an empty saved workspace.
  const content = new TextDecoder().decode(await vscode.workspace.fs.readFile(workspaceFile));
  try {
    if (JSON.parse(content).folders?.length === 0) return [];
  } catch {
    // Code itself reads commented workspace files; wait for its folder snapshot.
  }
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (vscode.workspace.workspaceFolders?.length) return vscode.workspace.workspaceFolders;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Code workspace folders did not finish loading.');
}

function containsPath(root: string, path: string): boolean {
  return path === root || path.startsWith(root.replace(/\/$/, '') + '/');
}

async function addFoxwarmFolder(request: FoxwarmOpenRequest, name?: string): Promise<{ status: 'added' | 'existing'; uri: string }> {
  const normalized = normalizeFoxwarmOpenRequest(request);
  if (normalized.kind !== 'addFolder') throw new Error('Expected an addFolder request.');
  const uri = vscode.Uri.parse(buildFoxwarmNodeUriString(normalized.nodeId, normalized.path));
  const folders = await loadedWorkspaceFolders();
  const targetOf = (folder: vscode.WorkspaceFolder) => {
    try { return parseFoxwarmUri(folder.uri); } catch { return undefined; }
  };
  const covering = folders.find(folder => {
    const target = targetOf(folder);
    return target?.nodeId === normalized.nodeId && containsPath(target.realPath, normalized.path);
  });
  const relabel = covering && name && targetOf(covering)?.realPath === normalized.path && covering.name !== name;
  if (covering && !relabel) {
    await revealWorkspaceRoot(uri);
    return { status: 'existing', uri: uri.toString(true) };
  }
  const retained = folders.filter(folder => {
    const target = targetOf(folder);
    return target?.nodeId !== normalized.nodeId || !containsPath(normalized.path, target.realPath);
  }).map(folder => ({ uri: folder.uri, name: folder.name }));
  const insertAt = folders.findIndex(folder => !retained.some(item => item.uri === folder.uri));
  retained.splice(insertAt < 0 ? retained.length : insertAt, 0, { uri, name: name || normalized.path.split('/').filter(Boolean).pop() || '/' });
  let listener: vscode.Disposable | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const changed = new Promise<void>((resolve, reject) => {
    timer = setTimeout(() => { listener?.dispose(); reject(new Error(`Timed out while adding ${normalized.path} to the current workspace.`)); }, 15_000);
    listener = vscode.workspace.onDidChangeWorkspaceFolders(() => {
      if (!vscode.workspace.workspaceFolders?.some(folder => folder.uri.toString(true) === uri.toString(true))) return;
      clearTimeout(timer);
      listener?.dispose();
      resolve();
    });
  });
  if (!vscode.workspace.updateWorkspaceFolders(0, folders.length, ...retained)) {
    clearTimeout(timer);
    listener?.dispose();
    throw new Error(`Could not update ${name || normalized.path} in the current workspace.`);
  }
  await changed;
  await revealWorkspaceRoot(uri);
  return { status: covering ? 'existing' : 'added', uri: uri.toString(true) };
}

async function revealWorkspaceRoot(uri: vscode.Uri): Promise<void> {
  await vscode.commands.executeCommand('workbench.view.explorer');
  await vscode.commands.executeCommand('revealInExplorer', uri);
}

async function openManagedWorkspaceRoot(
  kind: FoxwarmWorkspaceRootKind,
  provider: FoxwarmFileSystemProvider,
): Promise<{ status: 'added' | 'existing'; uri: string }> {
  await loadedWorkspaceFolders();
  const target = (await provider.getWorkspaceRoots())[kind];
  const uri = vscode.Uri.parse(buildFoxwarmNodeUriString(target.nodeId, target.path));
  const stat = await vscode.workspace.fs.stat(uri);
  if ((stat.type & vscode.FileType.Directory) === 0) {
    throw new Error(`${target.name} is not a directory: ${target.path}`);
  }

  if (getCurrentNodeId() !== 'master') {
    await vscode.commands.executeCommand('foxwarm.routeCodeRequest', { kind: 'openManagedRoot', nodeId: 'master', path: target.path, root: kind });
    return { status: 'added', uri: uri.toString(true) };
  }
  return addFoxwarmFolder({ kind: 'addFolder', nodeId: 'master', path: target.path }, target.name);
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

  const covered = vscode.workspace.workspaceFolders?.some(folder => {
    try {
      const root = parseFoxwarmUri(folder.uri);
      return root.nodeId === normalized.nodeId && containsPath(root.realPath, normalized.path);
    } catch { return false; }
  });
  if (!covered) {
    const path = normalized.cwd && containsPath(normalized.cwd, normalized.path)
      ? normalized.cwd : normalized.path.slice(0, normalized.path.lastIndexOf('/')) || '/';
    await addFoxwarmFolder({ kind: 'addFolder', nodeId: normalized.nodeId, path });
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
  await revealWorkspaceRoot(uri);
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
    vscode.commands.registerCommand('foxwarm-fs.openAppFolder', () => openManagedWorkspaceRoot('app', provider)),
    vscode.commands.registerCommand('foxwarm-fs.openDataFolder', () => openManagedWorkspaceRoot('data', provider)),
    vscode.commands.registerCommand('foxwarm-fs.addFolderToWorkspace', addExplorerFolderToWorkspace),
    vscode.commands.registerCommand('foxwarm-fs.handleOpenRequest', (request: FoxwarmOpenRequest) => handleOpenRequest(request, provider)),
  );
  void provider.getConfigFiles()
    .then((files) => registerFoxwarmConfigSchemas(files))
    .catch((error) => console.warn(`Foxwarm config schema support could not start: ${error instanceof Error ? error.message : String(error)}`));
  console.log('Foxwarm filesystem provider registered for foxwarm://node+<nodeId>/<absolute-path>.');
}

export function deactivate(): void {
  // No-op.
}
