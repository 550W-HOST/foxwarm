import * as vscode from 'vscode';
import { FoxwarmFileSystemProvider } from './provider';
import { buildFoxwarmNodeUriString, parseFoxwarmUri } from './foxwarmUri';
export { buildFoxwarmNodeUriString, parseFoxwarmUri } from './foxwarmUri';

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
  await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.parse(buildFoxwarmNodeUriString(getCurrentNodeId(), value)), {
    forceNewWindow: false,
  });
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = FoxwarmFileSystemProvider.fromExtensionContext(context);
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider('foxwarm', provider, {
      isCaseSensitive: true,
      isReadonly: false,
    }),
    vscode.commands.registerCommand('foxwarm-fs.openFolder', openFoxwarmFolder),
  );
  console.log('Foxwarm filesystem provider registered for foxwarm://node+<nodeId>/<absolute-path>.');
}

export function deactivate(): void {
  // No-op.
}
