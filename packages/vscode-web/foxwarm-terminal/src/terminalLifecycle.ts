export type RestorableTerminalRecord = {
  id: string;
  nodeId: string;
  cwd: string;
};

export type TerminalWorkspaceTarget = {
  nodeId: string;
  realPath: string;
};

export const TERMINAL_EXIT_REASON_USER = 3;

function normalizeAbsolutePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === '/') return '/';
  return trimmed.replace(/\/+$/, '');
}

export function shouldKillBackendTerminal(exitReason: number | undefined): boolean {
  return exitReason === TERMINAL_EXIT_REASON_USER;
}

export function isTerminalInsideWorkspace(record: RestorableTerminalRecord, workspace: TerminalWorkspaceTarget): boolean {
  if (!record.id || record.nodeId !== workspace.nodeId) {
    return false;
  }
  const cwd = normalizeAbsolutePath(record.cwd);
  const root = normalizeAbsolutePath(workspace.realPath);
  return root === '/' || cwd === root || cwd.startsWith(`${root}/`);
}
