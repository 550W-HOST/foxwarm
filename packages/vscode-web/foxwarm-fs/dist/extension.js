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
  if (uri.authority !== "node") {
    throw new Error(`Unsupported foxwarm URI namespace \`${uri.authority}\`; expected \`node\`.`);
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
  return `foxwarm://node/${encodedNodeId}${encodedPath}`;
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

// src/extension.ts
function activate(context) {
  const provider = FoxwarmFileSystemProvider.fromExtensionContext(context);
  context.subscriptions.push(
    vscode2.workspace.registerFileSystemProvider("foxwarm", provider, {
      isCaseSensitive: true,
      isReadonly: false
    })
  );
  console.log("Foxwarm filesystem provider registered for foxwarm://node/<nodeId>/<absolute-path>.");
}
function deactivate() {
}
//# sourceMappingURL=extension.js.map
