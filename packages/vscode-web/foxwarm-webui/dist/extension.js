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
  FOXWARM_CHAT_EDITOR_VIEW_TYPE: () => FOXWARM_CHAT_EDITOR_VIEW_TYPE,
  FOXWARM_EMBED_CHANNEL: () => FOXWARM_EMBED_CHANNEL,
  FOXWARM_EMBED_VERSION: () => FOXWARM_EMBED_VERSION,
  FOXWARM_OPEN_SESSION_COMMAND: () => FOXWARM_OPEN_SESSION_COMMAND,
  FOXWARM_SIDEBAR_VIEW_ID: () => FOXWARM_SIDEBAR_VIEW_ID,
  FoxwarmWebUiController: () => FoxwarmWebUiController,
  activate: () => activate,
  buildChatEditorUri: () => buildChatEditorUri,
  buildEmbeddedWebviewHtml: () => buildEmbeddedWebviewHtml,
  deriveWebUiBaseUrl: () => deriveWebUiBaseUrl,
  normalizeOpenSessionRequest: () => normalizeOpenSessionRequest,
  parseChatEditorUri: () => parseChatEditorUri
});
module.exports = __toCommonJS(extension_exports);
var vscode = __toESM(require("vscode"));
var FOXWARM_SIDEBAR_VIEW_ID = "foxwarm-webui.sidebar";
var FOXWARM_CHAT_EDITOR_VIEW_TYPE = "foxwarm-webui.chatEditor";
var FOXWARM_OPEN_SESSION_COMMAND = "foxwarm-webui.openSession";
var FOXWARM_EMBED_CHANNEL = "foxwarm-webui-embed";
var FOXWARM_EMBED_VERSION = 1;
var CHAT_URI_SCHEME = "foxwarm-chat";
var CHAT_FILE_SUFFIX = ".foxwarm-chat";
var EXTENSION_ROUTE_MARKER = "/vscode-web/extensions/foxwarm-webui";
var OPEN_SESSIONS_STATE_KEY = "foxwarm-webui.openSessions.v1";
function normalizeText(value, maxLength) {
  if (typeof value !== "string") return void 0;
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) return void 0;
  return normalized;
}
function normalizeOpenSessionRequest(value) {
  const raw = typeof value === "string" ? { sessionId: value } : value;
  if (!raw || typeof raw !== "object") return null;
  const sessionId = normalizeText(raw.sessionId, 512);
  if (!sessionId) return null;
  const title = normalizeText(raw.title, 200);
  return { sessionId, ...title ? { title } : {} };
}
function safeEditorLabel(sessionId) {
  const segment = sessionId.split("/").filter(Boolean).pop() || "session";
  const label = segment.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return label || "session";
}
function buildChatEditorUri(sessionId) {
  const normalized = normalizeOpenSessionRequest(sessionId);
  if (!normalized) throw new Error("Invalid Foxwarm session id.");
  return vscode.Uri.from({
    scheme: CHAT_URI_SCHEME,
    path: `/sessions/${safeEditorLabel(normalized.sessionId)}${CHAT_FILE_SUFFIX}`,
    query: new URLSearchParams({ session: normalized.sessionId }).toString()
  });
}
function parseChatEditorUri(uri) {
  if (uri.scheme !== CHAT_URI_SCHEME || !uri.path.endsWith(CHAT_FILE_SUFFIX)) {
    throw new Error("Invalid Foxwarm chat editor URI.");
  }
  const sessionId = new URLSearchParams(uri.query).get("session");
  const normalized = normalizeOpenSessionRequest(sessionId || "");
  if (!normalized) throw new Error("Foxwarm chat editor URI is missing a valid session.");
  return normalized.sessionId;
}
function deriveWebUiBaseUrl(extensionUri) {
  if (extensionUri.scheme !== "http" && extensionUri.scheme !== "https" || !extensionUri.authority) return "/";
  const markerIndex = extensionUri.path.indexOf(EXTENSION_ROUTE_MARKER);
  const prefix = markerIndex >= 0 ? extensionUri.path.slice(0, markerIndex) : "";
  return `${extensionUri.scheme}://${extensionUri.authority}${prefix || ""}/`;
}
function randomNonce() {
  const bytes = new Uint8Array(18);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}
function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] || char);
}
function buildEmbedUrl(webUiBaseUrl, target, nonce) {
  const url = new URL(webUiBaseUrl, "http://localhost/");
  url.searchParams.set("foxwarmEmbed", target.kind);
  url.searchParams.set("foxwarmEmbedNonce", nonce);
  if (target.kind === "chat") {
    url.searchParams.set("sessionId", target.sessionId);
    if (target.title) url.searchParams.set("title", target.title);
  }
  return url;
}
function buildEmbeddedWebviewHtml(webUiBaseUrl, target, nonce = randomNonce()) {
  const iframeUrl = buildEmbedUrl(webUiBaseUrl, target, nonce);
  const frameOrigin = iframeUrl.origin;
  const scriptNonce = randomNonce();
  const safeNonce = JSON.stringify(nonce);
  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${escapeHtml(frameOrigin)}; script-src 'nonce-${scriptNonce}'; style-src 'unsafe-inline';">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body,iframe{width:100%;height:100%;margin:0;padding:0;border:0;overflow:hidden}body{background:var(--vscode-sideBar-background)}</style>
</head><body>
<iframe id="foxwarm-frame" src="${escapeHtml(iframeUrl.toString())}" title="Foxwarm" sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-modals" allow="clipboard-read; clipboard-write; microphone" referrerpolicy="no-referrer"></iframe>
<script nonce="${scriptNonce}">
const vscode = acquireVsCodeApi();
const frame = document.getElementById('foxwarm-frame');
const bridgeNonce = ${safeNonce};
window.addEventListener('message', event => {
  if (event.source !== frame.contentWindow) return;
  const data = event.data;
  if (!data || data.channel !== '${FOXWARM_EMBED_CHANNEL}' || data.version !== ${FOXWARM_EMBED_VERSION} || data.nonce !== bridgeNonce) return;
  if (data.type === 'open-session') {
    vscode.postMessage({ type: 'open-session', sessionId: data.sessionId, title: data.title });
  } else if (data.type === 'open-commit') {
    vscode.postMessage({ type: 'open-commit', nodeId: data.nodeId, path: data.path, commitId: data.commitId });
  }
});
<\/script></body></html>`;
}
function normalizeHostMessage(value) {
  if (!value || typeof value !== "object") return null;
  const type = value.type;
  if (type === "open-session") {
    const request = normalizeOpenSessionRequest(value);
    return request ? { type, ...request } : null;
  }
  if (type === "open-commit") {
    const raw = value;
    const nodeId = normalizeText(raw.nodeId, 200);
    const path = normalizeText(raw.path, 4096);
    const commitId = normalizeText(raw.commitId, 64);
    if (!nodeId || !path?.startsWith("/") || !commitId || !/^[0-9a-fA-F]{7,64}$/.test(commitId)) return null;
    return { type, nodeId, path, commitId };
  }
  return null;
}
var FoxwarmChatDocument = class {
  constructor(uri, sessionId) {
    this.uri = uri;
    this.sessionId = sessionId;
  }
  dispose() {
  }
};
var FoxwarmWebUiController = class {
  constructor(context) {
    this.context = context;
    this.sessionTitles = /* @__PURE__ */ new Map();
    this.webUiBaseUrl = deriveWebUiBaseUrl(context.extensionUri);
  }
  getStoredSessions() {
    const value = this.context.globalState.get(OPEN_SESSIONS_STATE_KEY, []);
    if (!Array.isArray(value)) return [];
    return value.map(normalizeOpenSessionRequest).filter((item) => !!item);
  }
  async storeSessions(sessions) {
    await this.context.globalState.update(OPEN_SESSIONS_STATE_KEY, sessions);
  }
  async rememberSession(request) {
    const stored = this.getStoredSessions().filter((item) => item.sessionId !== request.sessionId);
    stored.push(request);
    await this.storeSessions(stored);
  }
  async forgetClosedTabs(closedTabs) {
    const closedSessionIds = /* @__PURE__ */ new Set();
    for (const tab of closedTabs) {
      const input = tab.input;
      if (input?.viewType !== FOXWARM_CHAT_EDITOR_VIEW_TYPE || !input.uri) continue;
      try {
        closedSessionIds.add(parseChatEditorUri(input.uri));
      } catch {
      }
    }
    if (closedSessionIds.size === 0) return;
    await this.storeSessions(this.getStoredSessions().filter((item) => !closedSessionIds.has(item.sessionId)));
  }
  async restoreSessions() {
    for (const request of this.getStoredSessions()) {
      try {
        await this.openSession(request);
      } catch (error) {
        console.warn(`Could not restore Foxwarm session ${request.sessionId}`, error);
      }
    }
  }
  async openSession(value) {
    const request = normalizeOpenSessionRequest(value);
    if (!request) throw new Error("Expected a valid Foxwarm session id.");
    if (request.title) this.sessionTitles.set(request.sessionId, request.title);
    await this.rememberSession(request);
    await vscode.commands.executeCommand("vscode.openWith", buildChatEditorUri(request.sessionId), FOXWARM_CHAT_EDITOR_VIEW_TYPE, { preview: false });
  }
  async handleHostMessage(value) {
    const message = normalizeHostMessage(value);
    if (!message) return;
    if (message.type === "open-session") {
      await this.openSession(message);
      return;
    }
    await vscode.commands.executeCommand("foxwarm-scm.openCommitDetails", {
      nodeId: message.nodeId,
      path: message.path,
      commitId: message.commitId
    });
  }
  resolveWebviewView(view) {
    view.webview.options = { enableScripts: true };
    view.webview.html = buildEmbeddedWebviewHtml(this.webUiBaseUrl, { kind: "sidebar" });
    this.context.subscriptions.push(view.webview.onDidReceiveMessage((message) => {
      void this.handleHostMessage(message);
    }));
  }
  openCustomDocument(uri) {
    return new FoxwarmChatDocument(uri, parseChatEditorUri(uri));
  }
  resolveCustomEditor(document, panel) {
    const title = this.sessionTitles.get(document.sessionId);
    if (title) panel.title = title;
    panel.webview.options = { enableScripts: true };
    panel.webview.html = buildEmbeddedWebviewHtml(this.webUiBaseUrl, {
      kind: "chat",
      sessionId: document.sessionId,
      ...title ? { title } : {}
    });
    this.context.subscriptions.push(panel.webview.onDidReceiveMessage((message) => {
      void this.handleHostMessage(message);
    }));
  }
};
function activate(context) {
  const controller = new FoxwarmWebUiController(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(FOXWARM_SIDEBAR_VIEW_ID, controller),
    vscode.window.registerCustomEditorProvider(FOXWARM_CHAT_EDITOR_VIEW_TYPE, controller, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false
    }),
    vscode.commands.registerCommand(FOXWARM_OPEN_SESSION_COMMAND, (value) => controller.openSession(value)),
    vscode.window.tabGroups.onDidChangeTabs((event) => {
      void controller.forgetClosedTabs(event.closed);
    })
  );
  globalThis.setTimeout(() => {
    void controller.restoreSessions();
  }, 0);
  console.log(`Foxwarm WebUI integration registered. webUiBase=${deriveWebUiBaseUrl(context.extensionUri)}`);
}
//# sourceMappingURL=extension.js.map
