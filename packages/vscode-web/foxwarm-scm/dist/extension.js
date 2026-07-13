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
var vscode = __toESM(require("vscode"));

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
function queryString(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== void 0) {
      search.set(key, value);
    }
  }
  return search.toString();
}
function getFoxwarmWorkspaces() {
  return (vscode.workspace.workspaceFolders || []).filter((folder) => folder.uri.scheme === "foxwarm").map((folder) => {
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
  return vscode.Uri.parse(buildFoxwarmNodeUriString(repository.workspace.nodeId, `${root}/${normalizeGitRelativePath(change.path)}`));
}
function getSubmoduleOid(change, side) {
  if (!change.submodule) return void 0;
  return side === "base" ? change.submodule.headOid : change.submodule.worktreeOid || change.submodule.indexOid;
}
function getGitContentUri(repository, change, side) {
  const relativePath = side === "base" && change.oldPath ? change.oldPath : change.path;
  const query = queryString({
    nodeId: repository.workspace.nodeId,
    workspace: repository.workspace.realPath,
    path: relativePath,
    side,
    ref: "HEAD",
    submoduleOid: getSubmoduleOid(change, side),
    submoduleDirty: side === "working" && change.submodule?.dirty ? "true" : void 0
  });
  return vscode.Uri.from({
    scheme: "foxwarm-git",
    authority: `node+${encodeURIComponent(repository.workspace.nodeId)}`,
    path: `/${side}/${normalizeGitRelativePath(relativePath)}`,
    query
  });
}
async function openChange(repository, change) {
  const left = getGitContentUri(repository, change, "base");
  const right = getGitContentUri(repository, change, "working");
  await vscode.commands.executeCommand("vscode.diff", left, right, `${getChangeLabel(change)} (HEAD \u2194 Working Tree)`);
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
  const picked = await vscode.window.showQuickPick(
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
    void vscode.window.showInformationMessage("There are no changes in this repository.");
    return;
  }
  const name = repository.workspace.realPath.split("/").filter(Boolean).pop() || "/";
  await vscode.commands.executeCommand("_workbench.openMultiDiffEditor", {
    multiDiffSourceUri: vscode.Uri.from({
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
  for (const workspace2 of getFoxwarmWorkspaces()) {
    if (discovered.some((entry) => entry.workspace.nodeId === workspace2.nodeId && isPathWithin(entry.workspace.realPath, workspace2.realPath))) {
      continue;
    }
    try {
      const url = `${gitApiBase}/status?${queryString({ nodeId: workspace2.nodeId, workspace: workspace2.realPath })}`;
      const status = await fetchJson(url);
      const topLevel = status.topLevel || status.workspace;
      const repositoryWorkspace = {
        nodeId: status.nodeId,
        realPath: topLevel,
        uri: vscode.Uri.parse(buildFoxwarmNodeUriString(status.nodeId, topLevel))
      };
      if (!discovered.some((entry) => entry.workspace.nodeId === repositoryWorkspace.nodeId && entry.workspace.realPath === repositoryWorkspace.realPath)) {
        discovered.push({ workspace: repositoryWorkspace, status });
      }
    } catch (error) {
      console.debug(`Foxwarm SCM skipped non-Git workspace ${workspace2.realPath}`, error);
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
      const sourceControl = vscode.scm.createSourceControl(id, `Foxwarm Git: ${name}`, entry.workspace.uri);
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
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider("foxwarm-git", new FoxwarmGitContentProvider()),
    vscode.commands.registerCommand("foxwarm-scm.refresh", () => refresh()),
    vscode.commands.registerCommand("foxwarm-scm.openChange", (repositoryKey, change) => {
      const repository = repositories.get(repositoryKey);
      return repository ? openChange(repository, change) : void 0;
    }),
    vscode.commands.registerCommand("foxwarm-scm.openAllChanges", (sourceControl) => openAllChanges(sourceControl)),
    vscode.workspace.onDidChangeWorkspaceFolders(() => refresh())
  );
  void refresh().catch((error) => {
    console.error("Foxwarm SCM refresh failed", error);
  });
  console.log(`Foxwarm SCM registered. apiBase=${gitApiBase}`);
}
function deactivate() {
  for (const repository of repositories.values()) repository.sourceControl.dispose();
  repositories.clear();
}
//# sourceMappingURL=extension.js.map
