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
  deactivate: () => deactivate,
  getWorkspaceTerminalTarget: () => getWorkspaceTerminalTarget,
  isTerminalInsideWorkspace: () => isTerminalInsideWorkspace,
  parseFoxwarmUri: () => parseFoxwarmUri,
  shouldKillBackendTerminal: () => shouldKillBackendTerminal
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
function getWorkspaceTerminalTarget(workspaceFolders) {
  const folder = workspaceFolders?.[0];
  if (!folder) {
    return { namespace: "node", nodeId: "master", realPath: "/" };
  }
  return parseFoxwarmUri(folder.uri);
}

// src/terminalLifecycle.ts
var TERMINAL_EXIT_REASON_USER = 3;
function normalizeAbsolutePath(value) {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "/") return "/";
  return trimmed.replace(/\/+$/, "");
}
function shouldKillBackendTerminal(exitReason) {
  return exitReason === TERMINAL_EXIT_REASON_USER;
}
function isTerminalInsideWorkspace(record, workspace2) {
  if (!record.id || record.nodeId !== workspace2.nodeId) {
    return false;
  }
  const cwd = normalizeAbsolutePath(record.cwd);
  const root = normalizeAbsolutePath(workspace2.realPath);
  return root === "/" || cwd === root || cwd.startsWith(`${root}/`);
}

// src/extension.ts
var TERMINAL_API_PREFIX = "/api/terminals";
var TERMINAL_STREAM_PREFIX = "/api/terminals/stream";
var terminalApiBase = TERMINAL_API_PREFIX;
var terminalStreamBase = TERMINAL_STREAM_PREFIX;
var terminalRouteOrigin = "";
var terminalBindings = /* @__PURE__ */ new Map();
var pendingPtys = [];
var representedBackendIds = /* @__PURE__ */ new Set();
function deriveTerminalRouteBase(extensionUri, apiPath) {
  if (extensionUri.scheme !== "http" && extensionUri.scheme !== "https") return apiPath;
  const marker = "/vscode-web/extensions/foxwarm-terminal";
  const markerIndex = extensionUri.path.indexOf(marker);
  const prefix = markerIndex >= 0 ? extensionUri.path.slice(0, markerIndex) : "";
  return `${extensionUri.scheme}://${extensionUri.authority}${prefix}${apiPath}`;
}
function deriveOrigin(extensionUri) {
  if ((extensionUri.scheme === "http" || extensionUri.scheme === "https") && extensionUri.authority) {
    return `${extensionUri.scheme}://${extensionUri.authority}`;
  }
  const locationLike = globalThis.location;
  return typeof locationLike?.origin === "string" ? locationLike.origin : "http://localhost";
}
function getTerminalWebSocketUrl(terminalId) {
  const url = new URL(terminalStreamBase, terminalRouteOrigin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("terminalId", terminalId);
  return url.toString();
}
async function readJsonResponse(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof payload?.error === "string" ? payload.error : `HTTP ${response.status}`);
  }
  return payload;
}
async function listBackendTerminals() {
  const response = await fetch(terminalApiBase, { credentials: "include" });
  const payload = await readJsonResponse(response);
  return Array.isArray(payload.terminals) ? payload.terminals : [];
}
async function createBackendTerminal(target, dimensions) {
  const response = await fetch(terminalApiBase, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nodeId: target.nodeId, cwd: target.cwd, cols: dimensions?.columns, rows: dimensions?.rows })
  });
  const payload = await readJsonResponse(response);
  if (!payload.terminal?.id) throw new Error("Terminal create response did not include a terminal id.");
  return payload.terminal;
}
async function deleteBackendTerminal(terminalId) {
  const response = await fetch(`${terminalApiBase}/${encodeURIComponent(terminalId)}`, {
    method: "DELETE",
    credentials: "include"
  });
  if (!response.ok && response.status !== 404) {
    await readJsonResponse(response);
  }
}
var FoxwarmPseudoterminal = class {
  constructor(target, existingTerminal) {
    this.target = target;
    this.existingTerminal = existingTerminal;
    this.writeEmitter = new vscode.EventEmitter();
    this.closeEmitter = new vscode.EventEmitter();
    this.changeNameEmitter = new vscode.EventEmitter();
    this.closed = false;
    this.started = false;
    this.killRequested = false;
    this.onDidWrite = this.writeEmitter.event;
    this.onDidClose = this.closeEmitter.event;
    this.onDidChangeName = this.changeNameEmitter.event;
    this.terminalId = existingTerminal?.id;
    if (this.terminalId) representedBackendIds.add(this.terminalId);
  }
  get backendTerminalId() {
    return this.terminalId;
  }
  open(initialDimensions) {
    this.lastDimensions = initialDimensions;
    if (this.started) return;
    this.started = true;
    void this.start(initialDimensions);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.socket?.close();
    this.socket = void 0;
    this.disposeEmitters();
  }
  requestBackendKill() {
    this.killRequested = true;
    this.close();
    const terminalId = this.terminalId;
    if (terminalId) {
      representedBackendIds.delete(terminalId);
      void deleteBackendTerminal(terminalId).catch((error) => console.error("Failed to close Foxwarm backend terminal", error));
    }
  }
  handleInput(data) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: "input", data }));
  }
  setDimensions(dimensions) {
    this.lastDimensions = dimensions;
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: "resize", cols: dimensions.columns, rows: dimensions.rows }));
    }
  }
  async start(initialDimensions) {
    try {
      this.writeEmitter.fire(`${this.existingTerminal ? "Reattaching" : "Connecting"} to Foxwarm terminal at ${this.target.cwd}\r
`);
      const terminal = this.existingTerminal || await createBackendTerminal(this.target, initialDimensions || this.lastDimensions);
      this.terminalId = terminal.id;
      representedBackendIds.add(terminal.id);
      if (this.killRequested) {
        representedBackendIds.delete(terminal.id);
        await deleteBackendTerminal(terminal.id).catch(() => void 0);
        return;
      }
      if (this.closed) return;
      this.changeNameEmitter.fire(`Foxwarm: ${terminal.cwd.split("/").filter(Boolean).pop() || terminal.cwd}`);
      this.attachSocket(terminal.id);
    } catch (error) {
      if (this.closed) return;
      const message = error instanceof Error ? error.message : String(error);
      this.writeEmitter.fire(`\r
Foxwarm terminal failed: ${message}\r
`);
      this.closeEmitter.fire(1);
      this.disposeEmitters();
    }
  }
  attachSocket(terminalId) {
    if (this.closed || this.socket) return;
    const socket = new WebSocket(getTerminalWebSocketUrl(terminalId));
    this.socket = socket;
    socket.onopen = () => {
      if (this.lastDimensions) socket.send(JSON.stringify({ type: "resize", cols: this.lastDimensions.columns, rows: this.lastDimensions.rows }));
    };
    socket.onmessage = (event) => {
      try {
        const payload = JSON.parse(String(event.data));
        if (payload.type === "ready") {
          if (typeof payload.backlog === "string" && payload.backlog) this.writeEmitter.fire(payload.backlog);
        } else if (payload.type === "output" && typeof payload.data === "string") {
          this.writeEmitter.fire(payload.data);
        } else if (payload.type === "exit") {
          representedBackendIds.delete(terminalId);
          this.closeEmitter.fire(typeof payload.exitCode === "number" ? payload.exitCode : void 0);
          this.disposeEmitters();
        } else if (payload.type === "error") {
          this.writeEmitter.fire(`\r
Foxwarm terminal error: ${payload.message || "unknown error"}\r
`);
        }
      } catch (error) {
        this.writeEmitter.fire(`\r
Foxwarm terminal protocol error: ${error instanceof Error ? error.message : String(error)}\r
`);
      }
    };
    socket.onerror = () => this.writeEmitter.fire("\r\nFoxwarm terminal websocket error\r\n");
    socket.onclose = () => {
      if (this.socket === socket) this.socket = void 0;
    };
  }
  disposeEmitters() {
    this.writeEmitter.dispose();
    this.closeEmitter.dispose();
    this.changeNameEmitter.dispose();
  }
};
function getCurrentTarget() {
  const target = getWorkspaceTerminalTarget(vscode.workspace.workspaceFolders);
  if (target.nodeId !== "master") throw new Error(`Foxwarm terminal MVP supports only node \`master\` (workspace uses \`${target.nodeId}\`).`);
  return { nodeId: target.nodeId, cwd: target.realPath };
}
function getActiveWorkspaceTarget() {
  const folder = vscode.workspace.workspaceFolders?.find((candidate) => candidate.uri.scheme === "foxwarm");
  if (!folder) return void 0;
  const target = parseFoxwarmUri(folder.uri);
  return { nodeId: target.nodeId, realPath: target.realPath };
}
function ensureSupportedTarget(target) {
  if (target.nodeId !== "master") throw new Error(`Foxwarm terminal MVP supports only node \`master\` (target uses \`${target.nodeId}\`).`);
  return target;
}
function queuePty(pty) {
  pendingPtys.push(pty);
  return pty;
}
function removePendingPty(pty) {
  const index = pendingPtys.indexOf(pty);
  if (index >= 0) pendingPtys.splice(index, 1);
}
function createTerminalProfile(target = getCurrentTarget(), location, existing) {
  const supportedTarget = ensureSupportedTarget(target);
  const pty = queuePty(new FoxwarmPseudoterminal(supportedTarget, existing));
  return new vscode.TerminalProfile({ name: "Foxwarm Terminal", pty, location });
}
function ptyFromTerminal(terminal) {
  const candidate = terminal.creationOptions?.pty;
  if (candidate instanceof FoxwarmPseudoterminal) {
    return candidate;
  }
  return terminal.name === "Foxwarm Terminal" ? pendingPtys[0] : void 0;
}
function bindTerminal(terminal, pty) {
  removePendingPty(pty);
  terminalBindings.set(terminal, pty);
}
function openNewTerminal(target = getCurrentTarget(), location, existing, show = true) {
  const profile = createTerminalProfile(target, location, existing);
  const terminal = vscode.window.createTerminal(profile.options);
  const pty = profile.options.pty;
  bindTerminal(terminal, pty);
  if (show) terminal.show();
  return terminal;
}
function toggleTerminal() {
  if (vscode.window.activeTerminal) void vscode.commands.executeCommand("workbench.action.terminal.toggleTerminal");
  else openNewTerminal();
}
function dirname(realPath) {
  const normalized = realPath.replace(/\/+$/, "") || "/";
  if (normalized === "/") return "/";
  const index = normalized.lastIndexOf("/");
  return index <= 0 ? "/" : normalized.slice(0, index);
}
async function getTargetForResource(uri) {
  if (!uri || uri.scheme !== "foxwarm") return getCurrentTarget();
  const target = parseFoxwarmUri(uri);
  const stat = await vscode.workspace.fs.stat(uri).catch(() => void 0);
  return ensureSupportedTarget({ nodeId: target.nodeId, cwd: stat?.type === vscode.FileType.Directory ? target.realPath : dirname(target.realPath) });
}
async function restoreBackendTerminals() {
  const workspace2 = getActiveWorkspaceTarget();
  if (!workspace2 || workspace2.nodeId !== "master") return;
  const records = await listBackendTerminals();
  for (const record of records) {
    if (!isTerminalInsideWorkspace(record, workspace2) || representedBackendIds.has(record.id)) continue;
    openNewTerminal({ nodeId: record.nodeId, cwd: record.cwd }, void 0, record, false);
  }
}
function activate(context) {
  terminalApiBase = deriveTerminalRouteBase(context.extensionUri, TERMINAL_API_PREFIX);
  terminalStreamBase = deriveTerminalRouteBase(context.extensionUri, TERMINAL_STREAM_PREFIX);
  terminalRouteOrigin = deriveOrigin(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerTerminalProfileProvider("foxwarm-terminal", { provideTerminalProfile: () => createTerminalProfile() }),
    vscode.window.onDidOpenTerminal((terminal) => {
      const pty = ptyFromTerminal(terminal);
      if (pty) bindTerminal(terminal, pty);
    }),
    vscode.window.onDidCloseTerminal((terminal) => {
      const pty = terminalBindings.get(terminal);
      terminalBindings.delete(terminal);
      if (!pty) return;
      if (shouldKillBackendTerminal(terminal.exitStatus?.reason)) pty.requestBackendKill();
      else pty.close();
    }),
    vscode.commands.registerCommand("foxwarm-terminal.newTerminal", () => openNewTerminal()),
    vscode.commands.registerCommand("foxwarm-terminal.toggleTerminal", toggleTerminal),
    vscode.commands.registerCommand("foxwarm-terminal.openInEditorArea", () => openNewTerminal(getCurrentTarget(), vscode.TerminalLocation.Editor)),
    vscode.commands.registerCommand("foxwarm-terminal.openHere", async (uri) => openNewTerminal(await getTargetForResource(uri))),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void restoreBackendTerminals().catch((error) => console.error("Failed to restore Foxwarm terminals after workspace change", error));
    })
  );
  void restoreBackendTerminals().catch((error) => console.error("Failed to restore Foxwarm terminals", error));
  console.log(`Foxwarm terminal profile registered. apiBase=${terminalApiBase} streamBase=${terminalStreamBase}`);
}
function deactivate() {
  for (const pty of terminalBindings.values()) pty.close();
  terminalBindings.clear();
  pendingPtys.length = 0;
}
//# sourceMappingURL=extension.js.map
