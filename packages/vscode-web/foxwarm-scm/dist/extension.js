var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/extension.ts
var extension_exports = {};
__export(extension_exports, {
  activate: () => activate,
  buildFoxwarmNodeUriString: () => buildFoxwarmNodeUriString,
  deactivate: () => deactivate,
  normalizeGitRelativePath: () => normalizeGitRelativePath,
  parseFoxwarmUri: () => parseFoxwarmUri
});
module.exports = __toCommonJS(extension_exports);
var vscode2 = __toESM(require("vscode"));

// src/foxwarmUri.ts
function decodePathSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
function parseFoxwarmUri(uri) {
  if (uri.scheme !== "foxwarm") {
    throw new Error(`Unsupported URI scheme \`${uri.scheme}\`; expected \`foxwarm\`.`);
  }
  if (uri.authority.startsWith("node+")) {
    const nodeId2 = decodePathSegment(uri.authority.slice("node+".length));
    if (!nodeId2) {
      throw new Error(`Missing node id in foxwarm URI \`${uri.toString(true)}\`.`);
    }
    const realPathSegments2 = uri.path.split("/").filter(Boolean).map(decodePathSegment);
    return { namespace: "node", nodeId: nodeId2, realPath: `/${realPathSegments2.join("/")}` };
  }
  if (uri.authority !== "node") {
    throw new Error(`Unsupported foxwarm URI authority \`${uri.authority}\`; expected \`node+<nodeId>\`.`);
  }
  const rawSegments = uri.path.split("/").filter(Boolean);
  if (rawSegments.length === 0) {
    throw new Error(`Missing node id in foxwarm URI \`${uri.toString(true)}\`.`);
  }
  const nodeId = decodePathSegment(rawSegments[0]);
  const realPathSegments = rawSegments.slice(1).map(decodePathSegment);
  return { namespace: "node", nodeId, realPath: `/${realPathSegments.join("/")}` };
}
function buildFoxwarmNodeUriString(nodeId, realPath) {
  if (!nodeId || nodeId.includes("/")) {
    throw new Error("nodeId must be a non-empty single path segment.");
  }
  if (!realPath.startsWith("/")) {
    throw new Error("realPath must be absolute.");
  }
  const encodedPath = realPath.split("/").map((segment, index) => index === 0 ? "" : encodeURIComponent(segment)).join("/");
  return `foxwarm://node+${encodeURIComponent(nodeId)}${encodedPath}`;
}
function normalizeGitRelativePath(value) {
  const normalized = value.replace(/\\/g, "/").replace(/^\/+/, "");
  const segments = normalized.split("/").filter(Boolean);
  if (segments.includes("..")) {
    throw new Error("relative path must not contain ..");
  }
  return segments.join("/");
}

// src/commitDetails.ts
var vscode = __toESM(require("vscode"));
var NODE_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
var SHORT_OID_RE = /^[0-9a-f]{7,64}$/i;
var FULL_OID_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
var activeCommitPanels = /* @__PURE__ */ new Map();
var COMMIT_DETAILS_VIEW_ID = "foxwarm-scm.commitDetailsView";
var COMMIT_DETAILS_CONTAINER_ID = "foxwarm-commit-details";
function normalizeAbsolutePath(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.includes("\0")) throw new Error("Commit path must be an absolute POSIX path.");
  const segments = [];
  for (const segment of value.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return `/${segments.join("/")}`;
}
function normalizeCommitOpenRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Commit request must be an object.");
  const request = value;
  if (request.kind !== "openCommit") throw new Error("Expected an openCommit request.");
  if (typeof request.nodeId !== "string" || !NODE_ID_RE.test(request.nodeId)) throw new Error("Commit node id is invalid.");
  if (typeof request.commitId !== "string" || !SHORT_OID_RE.test(request.commitId)) throw new Error("Commit id must contain 7 to 64 hexadecimal characters.");
  return { kind: "openCommit", nodeId: request.nodeId, path: normalizeAbsolutePath(request.path), commitId: request.commitId.toLowerCase() };
}
function queryString(params) {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) if (value !== void 0) search.set(name, value);
  return search.toString();
}
async function fetchCommitDetails(gitApiBase2, request) {
  const response = await fetch(`${gitApiBase2}/commit?${queryString({ nodeId: request.nodeId, workspace: request.path, id: request.commitId })}`, { credentials: "include" });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof payload?.error === "string" ? payload.error : `HTTP ${response.status}`);
  const details = payload;
  if (details.nodeId !== request.nodeId || !FULL_OID_RE.test(details.commit?.oid || "") || !Array.isArray(details.files)) {
    throw new Error("Commit API returned an invalid response.");
  }
  details.workspace = normalizeAbsolutePath(details.workspace);
  details.commit.oid = details.commit.oid.toLowerCase();
  details.commit.parents = Array.isArray(details.commit.parents) ? details.commit.parents.map((parent) => {
    if (!FULL_OID_RE.test(parent)) throw new Error("Commit API returned an invalid parent id.");
    return parent.toLowerCase();
  }) : [];
  details.files = details.files.map((file) => ({
    ...file,
    path: normalizeGitRelativePath(file.path),
    ...file.oldPath ? { oldPath: normalizeGitRelativePath(file.oldPath) } : {}
  }));
  return details;
}
function contentUri(details, file, side) {
  const missing = side === "original" && file.kind === "added" || side === "modified" && file.kind === "deleted";
  if (missing) return void 0;
  const ref = side === "original" ? details.comparison.parentOid : details.commit.oid;
  if (!ref) return void 0;
  const relativePath = side === "original" && file.oldPath ? file.oldPath : file.path;
  const submoduleOid = file.submodule ? side === "original" ? file.oldOid : file.newOid : void 0;
  const query = queryString({
    nodeId: details.nodeId,
    workspace: details.workspace,
    path: relativePath,
    side: "base",
    ref,
    ...submoduleOid && !/^0+$/.test(submoduleOid) ? { submoduleOid } : {}
  });
  return vscode.Uri.from({
    scheme: "foxwarm-git",
    authority: `node+${encodeURIComponent(details.nodeId)}`,
    path: `/commit/${side}/${normalizeGitRelativePath(relativePath)}`,
    query
  });
}
function emptyContentUri(details, file, side) {
  return vscode.Uri.from({
    scheme: "foxwarm-git",
    authority: `node+${encodeURIComponent(details.nodeId)}`,
    path: `/empty/${side}/${normalizeGitRelativePath(file.path)}`,
    query: queryString({ empty: "true" })
  });
}
function fileLabel(file) {
  return file.oldPath ? `${file.oldPath} \u2192 ${file.path}` : file.path;
}
async function openFileDiff(details, file) {
  if (file.binary) {
    await vscode.window.showInformationMessage(`Binary diff is not available for ${fileLabel(file)}.`);
    return;
  }
  const left = contentUri(details, file, "original") || emptyContentUri(details, file, "original");
  const right = contentUri(details, file, "modified") || emptyContentUri(details, file, "modified");
  const parent = details.comparison.parentOid?.slice(0, 12) || "empty tree";
  await vscode.commands.executeCommand("vscode.diff", left, right, `${fileLabel(file)} (${parent} \u2194 ${details.commit.oid.slice(0, 12)})`);
}
async function openAllDiffs(details) {
  const resources = details.files.filter((file) => !file.binary).map((file) => ({
    originalUri: contentUri(details, file, "original"),
    modifiedUri: contentUri(details, file, "modified")
  }));
  if (resources.length === 0) {
    await vscode.window.showInformationMessage("This commit has no text changes to open.");
    return;
  }
  await vscode.commands.executeCommand("_workbench.openMultiDiffEditor", {
    multiDiffSourceUri: vscode.Uri.from({
      scheme: "foxwarm-scm",
      authority: `node+${encodeURIComponent(details.nodeId)}`,
      path: `/commit/${details.commit.oid}`
    }),
    title: `Commit ${details.commit.oid.slice(0, 12)}: ${details.commit.subject}`,
    resources
  });
}
function nonce() {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let index = 0; index < 32; index += 1) value += alphabet[Math.floor(Math.random() * alphabet.length)];
  return value;
}
function commitHtml(webview, mode) {
  const scriptNonce = nonce();
  return `<!doctype html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${scriptNonce}'; script-src 'nonce-${scriptNonce}';">
<style nonce="${scriptNonce}">
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:20px;max-width:1100px;margin:auto}body.sidebar{padding:10px 12px;max-width:none}h1{font-size:20px;margin:0 0 6px}.sidebar h1{font-size:15px}.muted{color:var(--vscode-descriptionForeground)}code,pre{font-family:var(--vscode-editor-font-family)}.heading{display:flex;gap:8px;align-items:flex-start;justify-content:space-between}.heading-main{min-width:0}.heading h1,.heading .oid{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.meta{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:5px 14px;margin:16px 0}.sidebar .meta{font-size:12px;gap:4px 8px;margin:12px 0}.meta>div{overflow-wrap:anywhere}.stats{display:flex;gap:14px;margin:12px 0;flex-wrap:wrap}.sidebar .stats{font-size:12px;gap:8px}.add{color:var(--vscode-gitDecoration-addedResourceForeground,#3c3)}.del{color:var(--vscode-gitDecoration-deletedResourceForeground,#d55)}pre{white-space:pre-wrap;border:1px solid var(--vscode-panel-border);padding:10px;border-radius:4px}.sidebar pre{font-size:12px;max-height:180px;overflow:auto}.toolbar{display:flex;justify-content:space-between;align-items:center;gap:8px;margin:18px 0 8px}.sidebar .toolbar{margin-top:14px}.files{border-top:1px solid var(--vscode-panel-border)}.file{width:100%;display:grid;grid-template-columns:38px minmax(0,1fr) auto;gap:8px;align-items:center;text-align:left;color:inherit;background:none;border:0;border-bottom:1px solid var(--vscode-panel-border);padding:8px 4px}.sidebar .file{grid-template-columns:24px minmax(0,1fr);gap:5px;padding:7px 2px}.sidebar .file-stats{grid-column:2}.file:not(:disabled){cursor:pointer}.file:not(:disabled):hover{background:var(--vscode-list-hoverBackground)}.file:disabled{opacity:.65}.path{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.badge{font-family:var(--vscode-editor-font-family);font-weight:700}.file-stats{font-family:var(--vscode-editor-font-family);font-size:12px;white-space:nowrap}button.action{color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0;padding:6px 10px;cursor:pointer;white-space:nowrap}button.action:hover{background:var(--vscode-button-hoverBackground)}</style>
</head><body class="${mode}"><div id="root"><span class="muted">${mode === "sidebar" ? "Open a Foxwarm commit from WebUI." : "Loading commit\u2026"}</span></div>
<script nonce="${scriptNonce}">
const vscode=acquireVsCodeApi(),root=document.getElementById('root'),mode=${JSON.stringify(mode)};
const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=String(text);if(cls)n.className=cls;return n};
function row(parent,label,value){parent.append(el('div',label,'muted'),el('div',value))}
function render(d){root.replaceChildren();const heading=el('div',undefined,'heading'),headingMain=el('div',undefined,'heading-main');headingMain.append(el('h1',d.commit.subject||'(no subject)'),el('div',d.commit.oid,'muted oid'));heading.append(headingMain);root.append(heading);const meta=el('div',undefined,'meta');row(meta,'Node',d.nodeId);row(meta,'Repository',d.workspace);row(meta,'Author',d.commit.author.name+' <'+d.commit.author.email+'>');row(meta,'Authored',new Date(d.commit.authoredAt).toLocaleString());row(meta,'Committed',new Date(d.commit.committedAt).toLocaleString());row(meta,'Parents',d.commit.parents.length?d.commit.parents.join('\\n'):'(root commit)');row(meta,'Comparison',d.comparison.mode==='first-parent'?'Changes vs first parent':'Changes vs empty tree');root.append(meta);const stats=el('div',undefined,'stats');stats.append(el('span',d.stats.files+' files'),el('span','+'+d.stats.additions,'add'),el('span','-'+d.stats.deletions,'del'));if(d.stats.binaryFiles)stats.append(el('span',d.stats.binaryFiles+' binary','muted'));root.append(stats);if(d.commit.message)root.append(el('pre',d.commit.message));const toolbar=el('div',undefined,'toolbar');toolbar.append(el('strong','Changed files'));const all=el('button','Open all changes','action');all.onclick=()=>vscode.postMessage({type:'openAll'});toolbar.append(all);root.append(toolbar);const files=el('div',undefined,'files');d.files.forEach((f,index)=>{const b=el('button',undefined,'file');b.type='button';b.disabled=!!f.binary;b.title=f.binary?'Binary text diff is unavailable':'Open diff';b.onclick=()=>vscode.postMessage({type:'openDiff',index});b.append(el('span',f.status,'badge'),el('span',f.oldPath?f.oldPath+' \u2192 '+f.path:f.path,'path'));const s=el('span',undefined,'file-stats');if(f.binary)s.textContent='binary';else{s.append(el('span','+'+(f.additions||0),'add'),document.createTextNode(' '),el('span','-'+(f.deletions||0),'del'));if(f.submodule)s.append(document.createTextNode(' submodule'))}b.append(s);files.append(b)});root.append(files)}
window.addEventListener('message',e=>{if(e.data&&e.data.type==='details')render(e.data.details)});vscode.postMessage({type:'ready'});
<\/script></body></html>`;
}
async function postDetailsWithRetry(webview, details) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (await webview.postMessage({ type: "details", details })) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
function handleCommitMessage(message, details) {
  if (!message || typeof message !== "object") return;
  const typed = message;
  if (typed.type === "openAll") {
    void openAllDiffs(details);
    return;
  }
  if (typed.type === "openDiff" && Number.isInteger(typed.index) && Number(typed.index) >= 0 && Number(typed.index) < details.files.length) {
    void openFileDiff(details, details.files[Number(typed.index)]);
  }
}
async function openCommitDetailsEditor(details) {
  const panelKey = `${details.nodeId}\0${details.workspace}\0${details.commit.oid}`;
  const existingPanel = activeCommitPanels.get(panelKey);
  if (existingPanel) {
    existingPanel.reveal(vscode.ViewColumn.Active);
    return;
  }
  const panel = vscode.window.createWebviewPanel(
    "foxwarmCommitDetails",
    `Commit ${details.commit.oid.slice(0, 12)}`,
    vscode.ViewColumn.Active,
    { enableScripts: true }
  );
  activeCommitPanels.set(panelKey, panel);
  panel.onDidDispose(() => activeCommitPanels.delete(panelKey));
  panel.webview.onDidReceiveMessage((message) => {
    if (message?.type === "ready") {
      void postDetailsWithRetry(panel.webview, details);
      return;
    }
    handleCommitMessage(message, details);
  });
  panel.webview.html = commitHtml(panel.webview, "editor");
  void postDetailsWithRetry(panel.webview, details);
}
var CommitDetailsViewProvider = class {
  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.onDidReceiveMessage((message) => {
      if (!this.details) return;
      if (message?.type === "ready") {
        void postDetailsWithRetry(view.webview, this.details);
        return;
      }
      handleCommitMessage(message, this.details);
    });
    view.onDidDispose(() => {
      if (this.view === view) this.view = void 0;
    });
    view.webview.html = commitHtml(view.webview, "sidebar");
    if (this.details) void postDetailsWithRetry(view.webview, this.details);
  }
  async show(details) {
    this.details = details;
    await vscode.commands.executeCommand("setContext", "foxwarmCommitDetailsAvailable", true);
    await vscode.commands.executeCommand(`workbench.view.extension.${COMMIT_DETAILS_CONTAINER_ID}`);
    await vscode.commands.executeCommand(`${COMMIT_DETAILS_VIEW_ID}.focus`);
    if (this.view) void postDetailsWithRetry(this.view.webview, details);
  }
  async openInEditor() {
    if (this.details) await openCommitDetailsEditor(this.details);
  }
};
async function openCommitDetails(gitApiBase2, value, options = {}) {
  const request = normalizeCommitOpenRequest(value);
  const details = await fetchCommitDetails(gitApiBase2, request);
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
      kind: "openCommit",
      nodeId: details.nodeId,
      path: details.workspace,
      commitId: details.commit.oid
    });
    await vscode.commands.executeCommand("foxwarm-fs.handleOpenRequest", {
      kind: "addFolder",
      nodeId: details.nodeId,
      path: details.workspace
    });
    return { status: "reloading", workspace: details.workspace, oid: details.commit.oid };
  }
  await vscode.commands.executeCommand("foxwarm-fs.handleOpenRequest", {
    kind: "addFolder",
    nodeId: details.nodeId,
    path: details.workspace
  });
  if (options.showInSidebar) await options.showInSidebar(details);
  else await openCommitDetailsEditor(details);
  return { status: "opened", workspace: details.workspace, oid: details.commit.oid };
}

// src/extension.ts
var GIT_API_PREFIX = "/api/vscode-web/git";
var gitApiBase = GIT_API_PREFIX;
var sourceControlSequence = 0;
var repositories = /* @__PURE__ */ new Map();
function deriveGitApiBase(extensionUri) {
  if (extensionUri.scheme !== "http" && extensionUri.scheme !== "https") {
    return GIT_API_PREFIX;
  }
  const marker = "/vscode-web/extensions/foxwarm-scm";
  const markerIndex = extensionUri.path.indexOf(marker);
  const prefix = markerIndex >= 0 ? extensionUri.path.slice(0, markerIndex) : "";
  return `${extensionUri.scheme}://${extensionUri.authority}${prefix}${GIT_API_PREFIX}`;
}
function queryString2(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== void 0) {
      search.set(key, value);
    }
  }
  return search.toString();
}
function getFoxwarmWorkspaces() {
  return (vscode2.workspace.workspaceFolders || []).filter((folder) => folder.uri.scheme === "foxwarm").map((folder) => {
    const target = parseFoxwarmUri(folder.uri);
    return { nodeId: target.nodeId, realPath: target.realPath, uri: folder.uri };
  }).sort((left, right) => right.realPath.length - left.realPath.length);
}
function isPathWithin(parentPath, childPath) {
  const parent = parentPath.replace(/\/+$/, "") || "/";
  const child = childPath.replace(/\/+$/, "") || "/";
  return child === parent || parent === "/" || child.startsWith(`${parent}/`);
}
async function fetchJson(url) {
  const response = await fetch(url, { credentials: "include" });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof payload?.error === "string" ? payload.error : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return payload;
}
function getChangeLabel(change) {
  return change.oldPath ? `${change.oldPath} \u2192 ${change.path}` : change.path;
}
function shortOid(oid) {
  return oid ? oid.slice(0, 12) : void 0;
}
function getChangeDescription(change) {
  const xy = `${change.indexStatus}${change.workingTreeStatus}`;
  if (change.submodule) {
    const oldOid = shortOid(change.submodule.headOid);
    const newOid = shortOid(change.submodule.worktreeOid || change.submodule.indexOid);
    const transition = oldOid && newOid ? ` ${oldOid} \u2192 ${newOid}${change.submodule.dirty ? "-dirty" : ""}` : "";
    return `submodule (${xy})${transition}`;
  }
  return `${change.kind} (${xy})`;
}
function getWorkingUri(repository, change) {
  const root = repository.workspace.realPath.replace(/\/+$/, "");
  return vscode2.Uri.parse(buildFoxwarmNodeUriString(repository.workspace.nodeId, `${root}/${normalizeGitRelativePath(change.path)}`));
}
function getSubmoduleOid(change, side) {
  if (!change.submodule) return void 0;
  return side === "base" ? change.submodule.headOid : change.submodule.worktreeOid || change.submodule.indexOid;
}
function getGitContentUri(repository, change, side) {
  const relativePath = side === "base" && change.oldPath ? change.oldPath : change.path;
  const query = queryString2({
    nodeId: repository.workspace.nodeId,
    workspace: repository.workspace.realPath,
    path: relativePath,
    side,
    ref: "HEAD",
    submoduleOid: getSubmoduleOid(change, side),
    submoduleDirty: side === "working" && change.submodule?.dirty ? "true" : void 0
  });
  return vscode2.Uri.from({
    scheme: "foxwarm-git",
    authority: `node+${encodeURIComponent(repository.workspace.nodeId)}`,
    path: `/${side}/${normalizeGitRelativePath(relativePath)}`,
    query
  });
}
async function openChange(repository, change) {
  const left = getGitContentUri(repository, change, "base");
  const right = getGitContentUri(repository, change, "working");
  await vscode2.commands.executeCommand("vscode.diff", left, right, `${getChangeLabel(change)} (HEAD \u2194 Working Tree)`);
}
function toResourceState(repository, change) {
  return {
    resourceUri: getWorkingUri(repository, change),
    command: {
      command: "foxwarm-scm.openChange",
      title: "Open Change",
      arguments: [repository.key, change]
    },
    decorations: {
      tooltip: getChangeDescription(change),
      strikeThrough: change.kind === "deleted",
      faded: change.kind === "deleted"
    }
  };
}
function toMultiDiffResource(repository, change) {
  if (change.kind === "added" || change.kind === "untracked") {
    return { modifiedUri: getGitContentUri(repository, change, "working") };
  }
  if (change.kind === "deleted") {
    return { originalUri: getGitContentUri(repository, change, "base") };
  }
  return {
    originalUri: getGitContentUri(repository, change, "base"),
    modifiedUri: getGitContentUri(repository, change, "working")
  };
}
async function pickRepository() {
  const available = [...repositories.values()];
  if (available.length <= 1) return available[0];
  const picked = await vscode2.window.showQuickPick(
    available.map((repository) => ({
      label: repository.workspace.realPath.split("/").filter(Boolean).pop() || "/",
      description: repository.workspace.realPath,
      repository
    })),
    { placeHolder: "Select a Foxwarm Git repository" }
  );
  return picked?.repository;
}
function findRepository(argument) {
  if (typeof argument === "string") return repositories.get(argument);
  if (argument && typeof argument === "object") {
    const rootUri = argument.rootUri;
    if (rootUri) {
      return [...repositories.values()].find((repository) => repository.sourceControl.rootUri?.toString() === rootUri.toString());
    }
  }
  return void 0;
}
async function openAllChanges(argument) {
  const repository = findRepository(argument) || await pickRepository();
  if (!repository) return;
  if (repository.changes.length === 0) {
    void vscode2.window.showInformationMessage("There are no changes in this repository.");
    return;
  }
  const name = repository.workspace.realPath.split("/").filter(Boolean).pop() || "/";
  await vscode2.commands.executeCommand("_workbench.openMultiDiffEditor", {
    multiDiffSourceUri: vscode2.Uri.from({
      scheme: "foxwarm-scm",
      authority: `node+${encodeURIComponent(repository.workspace.nodeId)}`,
      path: repository.workspace.realPath
    }),
    title: `Changes in ${name}`,
    resources: repository.changes.map((change) => toMultiDiffResource(repository, change))
  });
}
async function discoverRepositories() {
  const discovered = [];
  for (const workspace3 of getFoxwarmWorkspaces()) {
    if (discovered.some((entry) => entry.workspace.nodeId === workspace3.nodeId && isPathWithin(entry.workspace.realPath, workspace3.realPath))) {
      continue;
    }
    try {
      const url = `${gitApiBase}/status?${queryString2({ nodeId: workspace3.nodeId, workspace: workspace3.realPath })}`;
      const status = await fetchJson(url);
      const topLevel = status.topLevel || status.workspace;
      const repositoryWorkspace = {
        nodeId: status.nodeId,
        realPath: topLevel,
        uri: vscode2.Uri.parse(buildFoxwarmNodeUriString(status.nodeId, topLevel))
      };
      if (!discovered.some((entry) => entry.workspace.nodeId === repositoryWorkspace.nodeId && entry.workspace.realPath === repositoryWorkspace.realPath)) {
        discovered.push({ workspace: repositoryWorkspace, status });
      }
    } catch (error) {
      console.debug(`Foxwarm SCM skipped non-Git workspace ${workspace3.realPath}`, error);
    }
  }
  return discovered;
}
async function refresh() {
  const discovered = await discoverRepositories();
  const seen = /* @__PURE__ */ new Set();
  for (const entry of discovered) {
    const key = `${entry.workspace.nodeId}:${entry.workspace.realPath}`;
    seen.add(key);
    let repository = repositories.get(key);
    if (!repository) {
      const id = `foxwarm-scm-${++sourceControlSequence}`;
      const name = entry.workspace.realPath.split("/").filter(Boolean).pop() || "/";
      const sourceControl = vscode2.scm.createSourceControl(id, `Foxwarm Git: ${name}`, entry.workspace.uri);
      const changesGroup = sourceControl.createResourceGroup("changes", "Changes");
      repository = { key, workspace: entry.workspace, sourceControl, changesGroup, changes: [] };
      repositories.set(key, repository);
    }
    repository.workspace = entry.workspace;
    repository.changes = entry.status.changes;
    repository.sourceControl.rootUri = entry.workspace.uri;
    repository.sourceControl.inputBox.placeholder = "Foxwarm Git status is read-only";
    repository.changesGroup.resourceStates = repository.changes.map((change) => toResourceState(repository, change));
    repository.sourceControl.count = repository.changes.length;
  }
  for (const [key, repository] of repositories) {
    if (seen.has(key)) continue;
    repository.sourceControl.dispose();
    repositories.delete(key);
  }
}
var FoxwarmGitContentProvider = class {
  async provideTextDocumentContent(uri) {
    const params = new URLSearchParams(uri.query);
    if (params.get("empty") === "true") return "";
    const submoduleOid = params.get("submoduleOid");
    if (submoduleOid) {
      const dirty = params.get("submoduleDirty") === "true" ? "-dirty" : "";
      return `Subproject commit ${submoduleOid}${dirty}
`;
    }
    const response = await fetch(`${gitApiBase}/content?${uri.query}`, { credentials: "include" });
    if (response.status === 404) {
      return "";
    }
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(typeof payload?.error === "string" ? payload.error : `HTTP ${response.status}`);
    }
    return response.text();
  }
};
function activate(context) {
  gitApiBase = deriveGitApiBase(context.extensionUri);
  const pendingCommitKey = "foxwarm.pendingCommitOpen.v1";
  const commitDetailsView = new CommitDetailsViewProvider();
  const openCommit = async (request) => {
    await context.globalState.update(pendingCommitKey, void 0);
    return openCommitDetails(gitApiBase, request, {
      deferForWorkspaceReload: (canonicalRequest) => context.globalState.update(pendingCommitKey, canonicalRequest),
      showInSidebar: (details) => commitDetailsView.show(details)
    });
  };
  context.subscriptions.push(
    vscode2.window.registerWebviewViewProvider(COMMIT_DETAILS_VIEW_ID, commitDetailsView),
    vscode2.workspace.registerTextDocumentContentProvider("foxwarm-git", new FoxwarmGitContentProvider()),
    vscode2.commands.registerCommand("foxwarm-scm.refresh", () => refresh()),
    vscode2.commands.registerCommand("foxwarm-scm.openChange", (repositoryKey, change) => {
      const repository = repositories.get(repositoryKey);
      return repository ? openChange(repository, change) : void 0;
    }),
    vscode2.commands.registerCommand("foxwarm-scm.openAllChanges", (sourceControl) => openAllChanges(sourceControl)),
    vscode2.commands.registerCommand("foxwarm-scm.openCommitDetails", (request) => openCommit(request)),
    vscode2.commands.registerCommand("foxwarm-scm.openCommitInEditor", () => commitDetailsView.openInEditor()),
    vscode2.workspace.onDidChangeWorkspaceFolders(() => refresh())
  );
  void refresh().catch((error) => {
    console.error("Foxwarm SCM refresh failed", error);
  });
  setTimeout(() => {
    const pendingCommit = context.globalState.get(pendingCommitKey);
    if (!pendingCommit) return;
    void openCommit(pendingCommit).catch((error) => {
      void vscode2.window.showErrorMessage(`Failed to reopen Foxwarm commit: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, 1e3);
  console.log(`Foxwarm SCM registered. apiBase=${gitApiBase}`);
}
function deactivate() {
  for (const repository of repositories.values()) repository.sourceControl.dispose();
  repositories.clear();
}
//# sourceMappingURL=extension.js.map
