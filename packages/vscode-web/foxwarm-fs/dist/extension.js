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
  normalizeFoxwarmOpenRequest: () => normalizeFoxwarmOpenRequest,
  parseFoxwarmUri: () => parseFoxwarmUri
});
module.exports = __toCommonJS(extension_exports);
var vscode2 = __toESM(require("vscode"));

// src/provider.ts
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
    return {
      namespace: "node",
      nodeId: nodeId2,
      realPath: `/${realPathSegments2.join("/")}`
    };
  }
  if (uri.authority !== "node") {
    throw new Error(`Unsupported foxwarm URI authority \`${uri.authority}\`; expected \`node+<nodeId>\`.`);
  }
  const rawSegments = uri.path.split("/").filter(Boolean);
  if (rawSegments.length === 0) {
    throw new Error(`Missing node id in foxwarm URI \`${uri.toString(true)}\`.`);
  }
  const nodeId = decodePathSegment(rawSegments[0]);
  if (!nodeId) {
    throw new Error(`Missing node id in foxwarm URI \`${uri.toString(true)}\`.`);
  }
  const realPathSegments = rawSegments.slice(1).map(decodePathSegment);
  const realPath = `/${realPathSegments.join("/")}`;
  return {
    namespace: "node",
    nodeId,
    realPath
  };
}
function buildFoxwarmNodeUriString(nodeId, realPath) {
  if (!nodeId || nodeId.includes("/")) {
    throw new Error("nodeId must be a non-empty single path segment.");
  }
  if (!realPath.startsWith("/")) {
    throw new Error("realPath must be absolute.");
  }
  const encodedNodeId = encodeURIComponent(nodeId);
  const encodedPath = realPath.split("/").map((segment, index) => index === 0 ? "" : encodeURIComponent(segment)).join("/");
  return `foxwarm://node+${encodedNodeId}${encodedPath}`;
}

// src/provider.ts
var API_PREFIX = "/api/vscode-web/fs";
function deriveApiBase(extensionUri) {
  if (extensionUri.scheme !== "http" && extensionUri.scheme !== "https") {
    return API_PREFIX;
  }
  const marker = "/vscode-web/extensions/foxwarm-fs";
  const markerIndex = extensionUri.path.indexOf(marker);
  const prefix = markerIndex >= 0 ? extensionUri.path.slice(0, markerIndex) : "";
  return `${extensionUri.scheme}://${extensionUri.authority}${prefix}${API_PREFIX}`;
}
function queryString(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== void 0) {
      search.set(key, String(value));
    }
  }
  return search.toString();
}
function mapFileSystemError(uri, status, code, message) {
  switch (code || status) {
    case "FileNotFound":
    case 404:
      return vscode.FileSystemError.FileNotFound(uri);
    case "FileExists":
    case 409:
      return vscode.FileSystemError.FileExists(uri);
    case "FileNotADirectory":
      return vscode.FileSystemError.FileNotADirectory(uri);
    case "FileIsADirectory":
      return vscode.FileSystemError.FileIsADirectory(uri);
    case "NoPermissions":
    case 401:
    case 403:
      return vscode.FileSystemError.NoPermissions(uri);
    case "Unavailable":
    case 503:
      return vscode.FileSystemError.Unavailable(uri);
    default:
      return new vscode.FileSystemError(message || `Foxwarm filesystem request failed (${status}).`);
  }
}
var FoxwarmFileSystemProvider = class _FoxwarmFileSystemProvider {
  constructor(apiBase) {
    this.apiBase = apiBase;
    this.changeEmitter = new vscode.EventEmitter();
    this.onDidChangeFile = this.changeEmitter.event;
  }
  static fromExtensionContext(context) {
    return new _FoxwarmFileSystemProvider(deriveApiBase(context.extensionUri));
  }
  watch(_uri, _options) {
    return new vscode.Disposable(() => void 0);
  }
  async stat(uri) {
    return this.fetchJson(uri, "stat");
  }
  async readDirectory(uri) {
    const payload = await this.fetchJson(uri, "read-directory");
    return payload.entries.map((entry) => [entry.name, entry.type]);
  }
  async readFile(uri) {
    const response = await this.fetch(uri, "read-file");
    return new Uint8Array(await response.arrayBuffer());
  }
  async writeFile(uri, content, options) {
    await this.fetch(uri, "write-file", {
      method: "PUT",
      query: { create: options.create ? 1 : 0, overwrite: options.overwrite ? 1 : 0 },
      body: content,
      headers: { "Content-Type": "application/octet-stream" }
    });
    this.fireSoon({ type: vscode.FileChangeType.Changed, uri });
  }
  async createDirectory(uri) {
    await this.postJson(uri, "create-directory", {});
    this.fireSoon({ type: vscode.FileChangeType.Created, uri });
  }
  async delete(uri, options) {
    await this.postJson(uri, "delete", { recursive: options.recursive });
    this.fireSoon({ type: vscode.FileChangeType.Deleted, uri });
  }
  async rename(oldUri, newUri, options) {
    const oldTarget = parseFoxwarmUri(oldUri);
    const newTarget = parseFoxwarmUri(newUri);
    if (oldTarget.nodeId !== newTarget.nodeId || oldTarget.namespace !== newTarget.namespace) {
      throw vscode.FileSystemError.NoPermissions(newUri);
    }
    const response = await fetch(`${this.apiBase}/rename`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nodeId: oldTarget.nodeId,
        oldPath: oldTarget.realPath,
        newPath: newTarget.realPath,
        overwrite: options.overwrite
      })
    });
    await this.ensureOk(newUri, response);
    this.fireSoon(
      { type: vscode.FileChangeType.Deleted, uri: oldUri },
      { type: vscode.FileChangeType.Created, uri: newUri }
    );
  }
  notifyExternalChange(uri) {
    this.fireSoon({ type: vscode.FileChangeType.Changed, uri });
  }
  async fetchJson(uri, operation) {
    const response = await this.fetch(uri, operation);
    return response.json();
  }
  async postJson(uri, operation, body) {
    await this.fetch(uri, operation, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  }
  async fetch(uri, operation, init) {
    const target = parseFoxwarmUri(uri);
    const query = queryString({ nodeId: target.nodeId, path: target.realPath, ...init?.query });
    const response = await fetch(`${this.apiBase}/${operation}?${query}`, {
      ...init,
      credentials: "include"
    });
    await this.ensureOk(uri, response);
    return response;
  }
  async ensureOk(uri, response) {
    if (response.ok) {
      return;
    }
    let payload = {};
    try {
      payload = await response.json();
    } catch {
    }
    throw mapFileSystemError(uri, response.status, payload.code, payload.error);
  }
  fireSoon(...events) {
    this.changeEmitter.fire(events);
  }
};

// src/openRequest.ts
function normalizeFoxwarmAbsolutePath(value) {
  if (typeof value !== "string") {
    throw new Error("Foxwarm path must be a string.");
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith("/") || trimmed.includes("\0")) {
    throw new Error("Foxwarm path must be an absolute POSIX path.");
  }
  const segments = [];
  for (const segment of trimmed.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return `/${segments.join("/")}`;
}
function normalizeLine(value, label) {
  if (value === void 0 || value === null) return void 0;
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return Number(value);
}
function normalizeFoxwarmOpenRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Foxwarm open request.");
  }
  const request = value;
  if (typeof request.nodeId !== "string" || !/^[A-Za-z0-9._-]+$/.test(request.nodeId)) {
    throw new Error("Foxwarm node id is invalid.");
  }
  const nodeId = request.nodeId;
  const path = normalizeFoxwarmAbsolutePath(request.path);
  if (request.kind === "addFolder") {
    return { kind: "addFolder", nodeId, path };
  }
  if (request.kind === "openFile") {
    const startLine = normalizeLine(request.startLine, "startLine");
    const endLine = normalizeLine(request.endLine, "endLine");
    if (startLine !== void 0 && endLine !== void 0 && endLine < startLine) {
      throw new Error("endLine must not be before startLine.");
    }
    return {
      kind: "openFile",
      nodeId,
      path,
      ...startLine !== void 0 ? { startLine } : {},
      ...endLine !== void 0 ? { endLine } : {}
    };
  }
  throw new Error("Unsupported Foxwarm open request kind.");
}

// src/extension.ts
async function waitForInitialWorkspaceFolders() {
  const deadline = Date.now() + 15e3;
  while (Date.now() < deadline) {
    const folders = vscode2.workspace.workspaceFolders;
    if (folders && folders.length > 0) return folders;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Code workspace folders did not finish loading.");
}
function getCurrentNodeId() {
  const folder = vscode2.workspace.workspaceFolders?.[0];
  if (!folder) {
    return "master";
  }
  try {
    return parseFoxwarmUri(folder.uri).nodeId;
  } catch {
    return "master";
  }
}
function getCurrentPath() {
  const folder = vscode2.workspace.workspaceFolders?.[0];
  if (!folder) {
    return "/";
  }
  try {
    return parseFoxwarmUri(folder.uri).realPath;
  } catch {
    return "/";
  }
}
async function addFoxwarmFolder(request) {
  const normalized = normalizeFoxwarmOpenRequest(request);
  if (normalized.kind !== "addFolder") {
    throw new Error("Expected an addFolder request.");
  }
  const uri = vscode2.Uri.parse(buildFoxwarmNodeUriString(normalized.nodeId, normalized.path));
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
    return { status: "existing", uri: uriString };
  }
  let folderChangeListener;
  let folderChangeTimeout;
  const folderAdded = new Promise((resolve, reject) => {
    folderChangeTimeout = setTimeout(() => {
      folderChangeListener?.dispose();
      reject(new Error(`Timed out while adding ${normalized.path} to the current workspace.`));
    }, 15e3);
    folderChangeListener = vscode2.workspace.onDidChangeWorkspaceFolders((event) => {
      if (!event.added.some((folder) => folder.uri.toString(true) === uriString)) return;
      if (folderChangeTimeout) clearTimeout(folderChangeTimeout);
      folderChangeListener?.dispose();
      resolve();
    });
  });
  const accepted = vscode2.workspace.updateWorkspaceFolders(
    workspaceFolders.length,
    0,
    { uri }
  );
  if (!accepted) {
    if (folderChangeTimeout) clearTimeout(folderChangeTimeout);
    folderChangeListener?.dispose();
    throw new Error(`Could not add ${normalized.path} to the current workspace.`);
  }
  await folderAdded;
  return { status: "added", uri: uriString };
}
async function openFoxwarmFolder() {
  const value = await vscode2.window.showInputBox({
    title: "Open Foxwarm Folder",
    prompt: "Absolute path on the current Foxwarm node.",
    value: getCurrentPath(),
    validateInput: (input) => input.startsWith("/") ? void 0 : "Use an absolute path, for example /app."
  });
  if (!value) {
    return;
  }
  await addFoxwarmFolder({ kind: "addFolder", nodeId: getCurrentNodeId(), path: value });
}
async function openFoxwarmFile(request, provider) {
  const normalized = normalizeFoxwarmOpenRequest(request);
  if (normalized.kind !== "openFile") throw new Error("Expected an openFile request.");
  const uri = vscode2.Uri.parse(buildFoxwarmNodeUriString(normalized.nodeId, normalized.path));
  const stat = await vscode2.workspace.fs.stat(uri);
  if ((stat.type & vscode2.FileType.Directory) !== 0) {
    throw new Error(`${normalized.path} is a directory, not a file.`);
  }
  const existing = vscode2.workspace.textDocuments.find((document2) => document2.uri.toString(true) === uri.toString(true));
  if (!existing?.isDirty) provider.notifyExternalChange(uri);
  const document = existing ?? await vscode2.workspace.openTextDocument(uri);
  let selection;
  if (normalized.startLine !== void 0) {
    if (normalized.startLine > document.lineCount) {
      throw new Error(`Line ${normalized.startLine} is beyond the end of ${normalized.path}.`);
    }
    const endLine = Math.min(normalized.endLine ?? normalized.startLine, document.lineCount);
    selection = new vscode2.Range(
      new vscode2.Position(normalized.startLine - 1, 0),
      document.lineAt(endLine - 1).range.end
    );
  }
  await vscode2.window.showTextDocument(document, { preview: true, selection });
  if (existing?.isDirty) {
    void vscode2.window.showWarningMessage(`${normalized.path} has unsaved Code changes; the external file was not reloaded.`);
  }
  return { status: "opened", uri: uri.toString(true) };
}
async function handleOpenRequest(request, provider) {
  const normalized = normalizeFoxwarmOpenRequest(request);
  if (normalized.kind === "addFolder") {
    return addFoxwarmFolder(normalized);
  }
  return openFoxwarmFile(normalized, provider);
}
function activate(context) {
  const provider = FoxwarmFileSystemProvider.fromExtensionContext(context);
  context.subscriptions.push(
    vscode2.workspace.registerFileSystemProvider("foxwarm", provider, {
      isCaseSensitive: true,
      isReadonly: false
    }),
    vscode2.commands.registerCommand("foxwarm-fs.openFolder", openFoxwarmFolder),
    vscode2.commands.registerCommand("foxwarm-fs.handleOpenRequest", (request) => handleOpenRequest(request, provider))
  );
  console.log("Foxwarm filesystem provider registered for foxwarm://node+<nodeId>/<absolute-path>.");
}
function deactivate() {
}
//# sourceMappingURL=extension.js.map
