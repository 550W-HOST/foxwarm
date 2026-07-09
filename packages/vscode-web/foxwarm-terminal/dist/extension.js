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

// src/extension.ts
var TERMINAL_API_PREFIX = "/api/terminals";
var TERMINAL_STREAM_PREFIX = "/api/terminals/stream";
var terminalApiBase = TERMINAL_API_PREFIX;
var terminalStreamBase = TERMINAL_STREAM_PREFIX;
var terminalRouteOrigin = "";
function deriveTerminalRouteBase(extensionUri, apiPath) {
  if (extensionUri.scheme !== "http" && extensionUri.scheme !== "https") {
    return apiPath;
  }
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
function getApiBase() {
  return terminalApiBase;
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
    const errorMessage = typeof payload?.error === "string" ? payload.error : `HTTP ${response.status}`;
    throw new Error(errorMessage);
  }
  return payload;
}
async function createBackendTerminal(target, dimensions) {
  const response = await fetch(getApiBase(), {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      nodeId: target.nodeId,
      cwd: target.cwd,
      cols: dimensions?.columns,
      rows: dimensions?.rows
    })
  });
  const payload = await readJsonResponse(response);
  if (!payload.terminal?.id) {
    throw new Error("Terminal create response did not include a terminal id.");
  }
  return payload.terminal;
}
var FoxwarmPseudoterminal = class {
  constructor(target) {
    this.target = target;
    this.writeEmitter = new vscode.EventEmitter();
    this.closeEmitter = new vscode.EventEmitter();
    this.changeNameEmitter = new vscode.EventEmitter();
    this.closed = false;
    this.onDidWrite = this.writeEmitter.event;
    this.onDidClose = this.closeEmitter.event;
    this.onDidChangeName = this.changeNameEmitter.event;
  }
  open(initialDimensions) {
    this.lastDimensions = initialDimensions;
    void this.start(initialDimensions);
  }
  close() {
    this.closed = true;
    const terminalId = this.terminalId;
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: "close" }));
    } else if (terminalId) {
      void fetch(`${getApiBase()}/${encodeURIComponent(terminalId)}`, {
        method: "DELETE",
        credentials: "include"
      }).catch(() => void 0);
    }
    this.socket?.close();
    this.disposeEmitters();
  }
  handleInput(data) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: "input", data }));
    }
  }
  setDimensions(dimensions) {
    this.lastDimensions = dimensions;
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: "resize", cols: dimensions.columns, rows: dimensions.rows }));
    }
  }
  async start(initialDimensions) {
    try {
      this.writeEmitter.fire(`Connecting to Foxwarm terminal at ${this.target.cwd}\r
`);
      const terminal = await createBackendTerminal(this.target, initialDimensions || this.lastDimensions);
      if (this.closed) {
        await fetch(`${getApiBase()}/${encodeURIComponent(terminal.id)}`, { method: "DELETE", credentials: "include" }).catch(() => void 0);
        return;
      }
      this.terminalId = terminal.id;
      this.changeNameEmitter.fire(`Foxwarm: ${terminal.cwd.split("/").filter(Boolean).pop() || terminal.cwd}`);
      this.attachSocket(terminal.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.writeEmitter.fire(`\r
Foxwarm terminal failed: ${message}\r
`);
      this.closeEmitter.fire(1);
      this.disposeEmitters();
    }
  }
  attachSocket(terminalId) {
    const socket = new WebSocket(getTerminalWebSocketUrl(terminalId));
    this.socket = socket;
    socket.onopen = () => {
      if (this.lastDimensions) {
        socket.send(JSON.stringify({ type: "resize", cols: this.lastDimensions.columns, rows: this.lastDimensions.rows }));
      }
    };
    socket.onmessage = (event) => {
      try {
        const payload = JSON.parse(String(event.data));
        if (payload.type === "ready") {
          if (typeof payload.backlog === "string" && payload.backlog.length > 0) {
            this.writeEmitter.fire(payload.backlog);
          }
          return;
        }
        if (payload.type === "output" && typeof payload.data === "string") {
          this.writeEmitter.fire(payload.data);
          return;
        }
        if (payload.type === "exit") {
          const exitCode = typeof payload.exitCode === "number" ? payload.exitCode : void 0;
          this.closeEmitter.fire(exitCode);
          this.disposeEmitters();
          return;
        }
        if (payload.type === "error") {
          this.writeEmitter.fire(`\r
Foxwarm terminal error: ${payload.message || "unknown error"}\r
`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.writeEmitter.fire(`\r
Foxwarm terminal protocol error: ${message}\r
`);
      }
    };
    socket.onerror = () => {
      this.writeEmitter.fire("\r\nFoxwarm terminal websocket error\r\n");
    };
    socket.onclose = () => {
      this.socket = void 0;
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
  if (target.nodeId !== "master") {
    throw new Error(`Foxwarm terminal MVP supports only node \`master\` (workspace uses \`${target.nodeId}\`).`);
  }
  return { nodeId: target.nodeId, cwd: target.realPath };
}
function createTerminalProfile() {
  const target = getCurrentTarget();
  return new vscode.TerminalProfile({
    name: "Foxwarm Terminal",
    pty: new FoxwarmPseudoterminal(target)
  });
}
function activate(context) {
  terminalApiBase = deriveTerminalRouteBase(context.extensionUri, TERMINAL_API_PREFIX);
  terminalStreamBase = deriveTerminalRouteBase(context.extensionUri, TERMINAL_STREAM_PREFIX);
  terminalRouteOrigin = deriveOrigin(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerTerminalProfileProvider("foxwarm-terminal", {
      provideTerminalProfile: () => createTerminalProfile()
    }),
    vscode.commands.registerCommand("foxwarm-terminal.newTerminal", () => {
      const terminal = vscode.window.createTerminal(createTerminalProfile().options);
      terminal.show();
    })
  );
  console.log(`Foxwarm terminal profile registered. apiBase=${terminalApiBase} streamBase=${terminalStreamBase}`);
}
function deactivate() {
}
//# sourceMappingURL=extension.js.map
