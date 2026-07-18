import * as vscode from 'vscode';
import { normalizeGitRelativePath, parseFoxwarmUri } from './foxwarmUri';

export type CommitOpenRequest = { kind: 'openCommit'; nodeId: string; path: string; commitId: string };

type CommitFile = {
  status: string;
  kind: string;
  path: string;
  oldPath?: string;
  oldOid: string;
  newOid: string;
  oldMode: string;
  newMode: string;
  additions?: number;
  deletions?: number;
  binary: boolean;
  submodule: boolean;
};

export type CommitDetails = {
  nodeId: string;
  workspace: string;
  commit: {
    oid: string;
    parents: string[];
    subject: string;
    message: string;
    author: { name: string; email: string };
    authoredAt: string;
    committedAt: string;
  };
  comparison: { parentOid: string | null; mode: 'first-parent' | 'empty-tree' };
  stats: { files: number; additions: number; deletions: number; binaryFiles: number };
  files: CommitFile[];
};

const NODE_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const SHORT_OID_RE = /^[0-9a-f]{7,64}$/i;
const FULL_OID_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const activeCommitPanels = new Map<string, vscode.WebviewPanel>();
export const COMMIT_DETAILS_VIEW_ID = 'foxwarm-scm.commitDetailsView';
export const COMMIT_DETAILS_CONTAINER_ID = 'foxwarm-commit-details';

function normalizeAbsolutePath(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.includes('\0')) throw new Error('Commit path must be an absolute POSIX path.');
  const segments: string[] = [];
  for (const segment of value.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  return `/${segments.join('/')}`;
}

export function normalizeCommitOpenRequest(value: unknown): CommitOpenRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Commit request must be an object.');
  const request = value as Partial<CommitOpenRequest>;
  if (request.kind !== 'openCommit') throw new Error('Expected an openCommit request.');
  if (typeof request.nodeId !== 'string' || !NODE_ID_RE.test(request.nodeId)) throw new Error('Commit node id is invalid.');
  if (typeof request.commitId !== 'string' || !SHORT_OID_RE.test(request.commitId)) throw new Error('Commit id must contain 7 to 64 hexadecimal characters.');
  return { kind: 'openCommit', nodeId: request.nodeId, path: normalizeAbsolutePath(request.path), commitId: request.commitId.toLowerCase() };
}

function queryString(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) if (value !== undefined) search.set(name, value);
  return search.toString();
}

async function fetchCommitDetails(gitApiBase: string, request: CommitOpenRequest): Promise<CommitDetails> {
  const response = await fetch(`${gitApiBase}/commit?${queryString({ nodeId: request.nodeId, workspace: request.path, id: request.commitId })}`, { credentials: 'include' });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof payload?.error === 'string' ? payload.error : `HTTP ${response.status}`);
  const details = payload as CommitDetails;
  if (details.nodeId !== request.nodeId || !FULL_OID_RE.test(details.commit?.oid || '') || !Array.isArray(details.files)) {
    throw new Error('Commit API returned an invalid response.');
  }
  details.workspace = normalizeAbsolutePath(details.workspace);
  details.commit.oid = details.commit.oid.toLowerCase();
  details.commit.parents = Array.isArray(details.commit.parents)
    ? details.commit.parents.map((parent) => {
      if (!FULL_OID_RE.test(parent)) throw new Error('Commit API returned an invalid parent id.');
      return parent.toLowerCase();
    })
    : [];
  details.files = details.files.map((file) => ({
    ...file,
    path: normalizeGitRelativePath(file.path),
    ...(file.oldPath ? { oldPath: normalizeGitRelativePath(file.oldPath) } : {}),
  }));
  return details;
}

function contentUri(details: CommitDetails, file: CommitFile, side: 'original' | 'modified'): vscode.Uri | undefined {
  const missing = (side === 'original' && file.kind === 'added') || (side === 'modified' && file.kind === 'deleted');
  if (missing) return undefined;
  const ref = side === 'original' ? details.comparison.parentOid : details.commit.oid;
  if (!ref) return undefined;
  const relativePath = side === 'original' && file.oldPath ? file.oldPath : file.path;
  const submoduleOid = file.submodule ? (side === 'original' ? file.oldOid : file.newOid) : undefined;
  const query = queryString({
    nodeId: details.nodeId,
    workspace: details.workspace,
    path: relativePath,
    side: 'base',
    ref,
    ...(submoduleOid && !/^0+$/.test(submoduleOid) ? { submoduleOid } : {}),
  });
  return vscode.Uri.from({
    scheme: 'foxwarm-git',
    authority: `node+${encodeURIComponent(details.nodeId)}`,
    path: `/commit/${side}/${normalizeGitRelativePath(relativePath)}`,
    query,
  });
}

function emptyContentUri(details: CommitDetails, file: CommitFile, side: 'original' | 'modified'): vscode.Uri {
  return vscode.Uri.from({
    scheme: 'foxwarm-git',
    authority: `node+${encodeURIComponent(details.nodeId)}`,
    path: `/empty/${side}/${normalizeGitRelativePath(file.path)}`,
    query: queryString({ empty: 'true' }),
  });
}

function fileLabel(file: CommitFile): string {
  return file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
}

async function openFileDiff(details: CommitDetails, file: CommitFile): Promise<void> {
  if (file.binary) {
    await vscode.window.showInformationMessage(`Binary diff is not available for ${fileLabel(file)}.`);
    return;
  }
  const left = contentUri(details, file, 'original') || emptyContentUri(details, file, 'original');
  const right = contentUri(details, file, 'modified') || emptyContentUri(details, file, 'modified');
  const parent = details.comparison.parentOid?.slice(0, 12) || 'empty tree';
  await vscode.commands.executeCommand('vscode.diff', left, right, `${fileLabel(file)} (${parent} ↔ ${details.commit.oid.slice(0, 12)})`);
}

async function openAllDiffs(details: CommitDetails): Promise<void> {
  const resources = details.files.filter((file) => !file.binary).map((file) => ({
    originalUri: contentUri(details, file, 'original'),
    modifiedUri: contentUri(details, file, 'modified'),
  }));
  if (resources.length === 0) {
    await vscode.window.showInformationMessage('This commit has no text changes to open.');
    return;
  }
  await vscode.commands.executeCommand('_workbench.openMultiDiffEditor', {
    multiDiffSourceUri: vscode.Uri.from({
      scheme: 'foxwarm-scm',
      authority: `node+${encodeURIComponent(details.nodeId)}`,
      path: `/commit/${details.commit.oid}`,
    }),
    title: `Commit ${details.commit.oid.slice(0, 12)}: ${details.commit.subject}`,
    resources,
  });
}

function nonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  for (let index = 0; index < 32; index += 1) value += alphabet[Math.floor(Math.random() * alphabet.length)];
  return value;
}

function commitHtml(webview: vscode.Webview, mode: 'editor' | 'sidebar'): string {
  const scriptNonce = nonce();
  return `<!doctype html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${scriptNonce}'; script-src 'nonce-${scriptNonce}';">
<style nonce="${scriptNonce}">
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:20px;max-width:1100px;margin:auto}body.sidebar{padding:10px 12px;max-width:none}h1{font-size:20px;margin:0 0 6px}.sidebar h1{font-size:15px}.muted{color:var(--vscode-descriptionForeground)}code,pre{font-family:var(--vscode-editor-font-family)}.heading{display:flex;gap:8px;align-items:flex-start;justify-content:space-between}.heading-main{min-width:0}.heading h1,.heading .oid{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.meta{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:5px 14px;margin:16px 0}.sidebar .meta{font-size:12px;gap:4px 8px;margin:12px 0}.meta>div{overflow-wrap:anywhere}.stats{display:flex;gap:14px;margin:12px 0;flex-wrap:wrap}.sidebar .stats{font-size:12px;gap:8px}.add{color:var(--vscode-gitDecoration-addedResourceForeground,#3c3)}.del{color:var(--vscode-gitDecoration-deletedResourceForeground,#d55)}pre{white-space:pre-wrap;border:1px solid var(--vscode-panel-border);padding:10px;border-radius:4px}.sidebar pre{font-size:12px;max-height:180px;overflow:auto}.toolbar{display:flex;justify-content:space-between;align-items:center;gap:8px;margin:18px 0 8px}.sidebar .toolbar{margin-top:14px}.files{border-top:1px solid var(--vscode-panel-border)}.file{width:100%;display:grid;grid-template-columns:38px minmax(0,1fr) auto;gap:8px;align-items:center;text-align:left;color:inherit;background:none;border:0;border-bottom:1px solid var(--vscode-panel-border);padding:8px 4px}.sidebar .file{grid-template-columns:24px minmax(0,1fr);gap:5px;padding:7px 2px}.sidebar .file-stats{grid-column:2}.file:not(:disabled){cursor:pointer}.file:not(:disabled):hover{background:var(--vscode-list-hoverBackground)}.file:disabled{opacity:.65}.path{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.badge{font-family:var(--vscode-editor-font-family);font-weight:700}.file-stats{font-family:var(--vscode-editor-font-family);font-size:12px;white-space:nowrap}button.action{color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0;padding:6px 10px;cursor:pointer;white-space:nowrap}button.action:hover{background:var(--vscode-button-hoverBackground)}</style>
</head><body class="${mode}"><div id="root"><span class="muted">${mode === 'sidebar' ? 'Open a Foxwarm commit from WebUI.' : 'Loading commit…'}</span></div>
<script nonce="${scriptNonce}">
const vscode=acquireVsCodeApi(),root=document.getElementById('root'),mode=${JSON.stringify(mode)};
const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=String(text);if(cls)n.className=cls;return n};
function row(parent,label,value){parent.append(el('div',label,'muted'),el('div',value))}
function render(d){root.replaceChildren();const heading=el('div',undefined,'heading'),headingMain=el('div',undefined,'heading-main');headingMain.append(el('h1',d.commit.subject||'(no subject)'),el('div',d.commit.oid,'muted oid'));heading.append(headingMain);root.append(heading);const meta=el('div',undefined,'meta');row(meta,'Node',d.nodeId);row(meta,'Repository',d.workspace);row(meta,'Author',d.commit.author.name+' <'+d.commit.author.email+'>');row(meta,'Authored',new Date(d.commit.authoredAt).toLocaleString());row(meta,'Committed',new Date(d.commit.committedAt).toLocaleString());row(meta,'Parents',d.commit.parents.length?d.commit.parents.join('\\n'):'(root commit)');row(meta,'Comparison',d.comparison.mode==='first-parent'?'Changes vs first parent':'Changes vs empty tree');root.append(meta);const stats=el('div',undefined,'stats');stats.append(el('span',d.stats.files+' files'),el('span','+'+d.stats.additions,'add'),el('span','-'+d.stats.deletions,'del'));if(d.stats.binaryFiles)stats.append(el('span',d.stats.binaryFiles+' binary','muted'));root.append(stats);if(d.commit.message)root.append(el('pre',d.commit.message));const toolbar=el('div',undefined,'toolbar');toolbar.append(el('strong','Changed files'));const all=el('button','Open all changes','action');all.onclick=()=>vscode.postMessage({type:'openAll'});toolbar.append(all);root.append(toolbar);const files=el('div',undefined,'files');d.files.forEach((f,index)=>{const b=el('button',undefined,'file');b.type='button';b.disabled=!!f.binary;b.title=f.binary?'Binary text diff is unavailable':'Open diff';b.onclick=()=>vscode.postMessage({type:'openDiff',index});b.append(el('span',f.status,'badge'),el('span',f.oldPath?f.oldPath+' → '+f.path:f.path,'path'));const s=el('span',undefined,'file-stats');if(f.binary)s.textContent='binary';else{s.append(el('span','+'+(f.additions||0),'add'),document.createTextNode(' '),el('span','-'+(f.deletions||0),'del'));if(f.submodule)s.append(document.createTextNode(' submodule'))}b.append(s);files.append(b)});root.append(files)}
window.addEventListener('message',e=>{if(e.data&&e.data.type==='details')render(e.data.details)});vscode.postMessage({type:'ready'});
</script></body></html>`;
}

type OpenCommitOptions = {
  deferForWorkspaceReload?: (request: CommitOpenRequest) => Promise<void>;
  showInSidebar?: (details: CommitDetails) => Promise<void>;
};

async function postDetailsWithRetry(webview: vscode.Webview, details: CommitDetails): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (await webview.postMessage({ type: 'details', details })) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function handleCommitMessage(message: unknown, details: CommitDetails): void {
  if (!message || typeof message !== 'object') return;
  const typed = message as { type?: unknown; index?: unknown };
  if (typed.type === 'openAll') { void openAllDiffs(details); return; }
  if (typed.type === 'openDiff' && Number.isInteger(typed.index) && Number(typed.index) >= 0 && Number(typed.index) < details.files.length) {
    void openFileDiff(details, details.files[Number(typed.index)]);
  }
}

async function openCommitDetailsEditor(details: CommitDetails): Promise<void> {
  const panelKey = `${details.nodeId}\0${details.workspace}\0${details.commit.oid}`;
  const existingPanel = activeCommitPanels.get(panelKey);
  if (existingPanel) {
    existingPanel.reveal(vscode.ViewColumn.Active);
    return;
  }
  const panel = vscode.window.createWebviewPanel(
    'foxwarmCommitDetails',
    `Commit ${details.commit.oid.slice(0, 12)}`,
    vscode.ViewColumn.Active,
    { enableScripts: true },
  );
  activeCommitPanels.set(panelKey, panel);
  panel.onDidDispose(() => activeCommitPanels.delete(panelKey));
  panel.webview.onDidReceiveMessage((message) => {
    if ((message as { type?: unknown })?.type === 'ready') { void postDetailsWithRetry(panel.webview, details); return; }
    handleCommitMessage(message, details);
  });
  panel.webview.html = commitHtml(panel.webview, 'editor');
  void postDetailsWithRetry(panel.webview, details);
}

export class CommitDetailsViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private details: CommitDetails | undefined;

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.onDidReceiveMessage((message) => {
      if (!this.details) return;
      if ((message as { type?: unknown })?.type === 'ready') { void postDetailsWithRetry(view.webview, this.details); return; }
      handleCommitMessage(message, this.details);
    });
    view.onDidDispose(() => {
      if (this.view === view) this.view = undefined;
    });
    view.webview.html = commitHtml(view.webview, 'sidebar');
    if (this.details) void postDetailsWithRetry(view.webview, this.details);
  }

  async show(details: CommitDetails): Promise<void> {
    this.details = details;
    await vscode.commands.executeCommand('setContext', 'foxwarmCommitDetailsAvailable', true);
    await vscode.commands.executeCommand(`workbench.view.extension.${COMMIT_DETAILS_CONTAINER_ID}`);
    await vscode.commands.executeCommand(`${COMMIT_DETAILS_VIEW_ID}.focus`);
    if (this.view) void postDetailsWithRetry(this.view.webview, details);
  }

  async openInEditor(): Promise<void> {
    if (this.details) await openCommitDetailsEditor(this.details);
  }
}

export async function openCommitDetails(gitApiBase: string, value: unknown, options: OpenCommitOptions = {}): Promise<{ status: 'opened' | 'reloading'; workspace: string; oid: string }> {
  const request = normalizeCommitOpenRequest(value);
  const details = await fetchCommitDetails(gitApiBase, request);
  const hasExactWorkspaceFolder = (vscode.workspace.workspaceFolders || []).some((folder) => {
    try {
      const parsed = parseFoxwarmUri(folder.uri);
      return parsed.nodeId === details.nodeId && parsed.realPath === details.workspace;
    } catch {
      return false;
    }
  });
  if (!hasExactWorkspaceFolder && options.deferForWorkspaceReload) {
    await options.deferForWorkspaceReload({
      kind: 'openCommit',
      nodeId: details.nodeId,
      path: details.workspace,
      commitId: details.commit.oid,
    });
    await vscode.commands.executeCommand('foxwarm-fs.handleOpenRequest', {
      kind: 'addFolder', nodeId: details.nodeId, path: details.workspace,
    });
    return { status: 'reloading', workspace: details.workspace, oid: details.commit.oid };
  }
  await vscode.commands.executeCommand('foxwarm-fs.handleOpenRequest', {
    kind: 'addFolder', nodeId: details.nodeId, path: details.workspace,
  });
  if (options.showInSidebar) await options.showInSidebar(details);
  else await openCommitDetailsEditor(details);
  return { status: 'opened', workspace: details.workspace, oid: details.commit.oid };
}
