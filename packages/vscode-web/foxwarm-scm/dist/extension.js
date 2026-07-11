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
var sourceControl;
var changesGroup;
var currentWorkspace;
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
function getFoxwarmWorkspace() {
  const folder = vscode.workspace.workspaceFolders?.find((candidate) => candidate.uri.scheme === "foxwarm");
  if (!folder) {
    return void 0;
  }
  const target = parseFoxwarmUri(folder.uri);
  return { nodeId: target.nodeId, realPath: target.realPath, uri: folder.uri };
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
function getChangeDescription(change) {
  const xy = `${change.indexStatus}${change.workingTreeStatus}`;
  return `${change.kind} (${xy})`;
}
function getWorkingUri(change) {
  if (!currentWorkspace) {
    throw new Error("No Foxwarm workspace is active.");
  }
  return vscode.Uri.parse(buildFoxwarmNodeUriString(currentWorkspace.nodeId, `${currentWorkspace.realPath.replace(/\/+$/, "")}/${normalizeGitRelativePath(change.path)}`));
}
function getGitContentUri(change, side) {
  if (!currentWorkspace) {
    throw new Error("No Foxwarm workspace is active.");
  }
  const query = queryString({
    nodeId: currentWorkspace.nodeId,
    workspace: currentWorkspace.realPath,
    path: change.path,
    side,
    ref: "HEAD"
  });
  return vscode.Uri.from({
    scheme: "foxwarm-git",
    authority: `node+${encodeURIComponent(currentWorkspace.nodeId)}`,
    path: `/${side}/${normalizeGitRelativePath(change.path)}`,
    query
  });
}
async function openChange(change) {
  const left = getGitContentUri(change, "base");
  const right = getGitContentUri(change, "working");
  await vscode.commands.executeCommand("vscode.diff", left, right, `${getChangeLabel(change)} (HEAD \u2194 Working Tree)`);
}
function toResourceState(change) {
  return {
    resourceUri: getWorkingUri(change),
    command: {
      command: "foxwarm-scm.openChange",
      title: "Open Change",
      arguments: [change]
    },
    decorations: {
      tooltip: getChangeDescription(change),
      strikeThrough: change.kind === "deleted",
      faded: change.kind === "deleted"
    }
  };
}
async function refresh() {
  const workspace2 = getFoxwarmWorkspace();
  currentWorkspace = workspace2;
  if (!workspace2) {
    if (sourceControl) {
      sourceControl.dispose();
      sourceControl = void 0;
      changesGroup = void 0;
    }
    return;
  }
  if (!sourceControl) {
    sourceControl = vscode.scm.createSourceControl("foxwarm-scm", "Foxwarm Git", workspace2.uri);
    sourceControl.acceptInputCommand = { command: "foxwarm-scm.refresh", title: "Refresh Git Status" };
    changesGroup = sourceControl.createResourceGroup("changes", "Changes");
  }
  sourceControl.rootUri = workspace2.uri;
  sourceControl.inputBox.placeholder = "Foxwarm Git status is read-only in this MVP";
  const url = `${gitApiBase}/status?${queryString({ nodeId: workspace2.nodeId, workspace: workspace2.realPath })}`;
  const status = await fetchJson(url);
  changesGroup.resourceStates = status.changes.map(toResourceState);
  sourceControl.count = status.changes.length;
}
var FoxwarmGitContentProvider = class {
  async provideTextDocumentContent(uri) {
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
    vscode.commands.registerCommand("foxwarm-scm.openChange", (change) => openChange(change)),
    vscode.workspace.onDidChangeWorkspaceFolders(() => refresh())
  );
  void refresh().catch((error) => {
    console.error("Foxwarm SCM refresh failed", error);
  });
  console.log(`Foxwarm SCM registered. apiBase=${gitApiBase}`);
}
function deactivate() {
  sourceControl?.dispose();
}
//# sourceMappingURL=extension.js.map
