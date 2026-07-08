import * as vscode from 'vscode';
import { FoxwarmFileSystemProvider } from './provider';
export { buildFoxwarmNodeUriString, parseFoxwarmUri } from './foxwarmUri';

export function activate(context: vscode.ExtensionContext): void {
  const provider = FoxwarmFileSystemProvider.fromExtensionContext(context);
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider('foxwarm', provider, {
      isCaseSensitive: true,
      isReadonly: false,
    }),
  );
  console.log('Foxwarm filesystem provider registered for foxwarm://node/<nodeId>/<absolute-path>.');
}

export function deactivate(): void {
  // No-op.
}
