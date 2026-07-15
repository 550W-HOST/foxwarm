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
  FOXWARM_AGENTS_EDITOR_VIEW_TYPE: () => FOXWARM_AGENTS_EDITOR_VIEW_TYPE,
  FOXWARM_CHAT_EDITOR_VIEW_TYPE: () => FOXWARM_CHAT_EDITOR_VIEW_TYPE,
  FOXWARM_EMBED_CHANNEL: () => FOXWARM_EMBED_CHANNEL,
  FOXWARM_EMBED_HOST_CHANNEL: () => FOXWARM_EMBED_HOST_CHANNEL,
  FOXWARM_EMBED_VERSION: () => FOXWARM_EMBED_VERSION,
  FOXWARM_OPEN_SESSION_COMMAND: () => FOXWARM_OPEN_SESSION_COMMAND,
  FOXWARM_SETUP_EDITOR_VIEW_TYPE: () => FOXWARM_SETUP_EDITOR_VIEW_TYPE,
  FOXWARM_SIDEBAR_VIEW_ID: () => FOXWARM_SIDEBAR_VIEW_ID,
  FoxwarmWebUiController: () => FoxwarmWebUiController,
  activate: () => activate,
  buildAgentsEditorUri: () => buildAgentsEditorUri,
  buildChatEditorUri: () => buildChatEditorUri,
  buildEmbeddedWebviewHtml: () => buildEmbeddedWebviewHtml,
  buildSetupEditorUri: () => buildSetupEditorUri,
  deriveWebUiBaseUrl: () => deriveWebUiBaseUrl,
  normalizeOpenSessionRequest: () => normalizeOpenSessionRequest,
  parseChatEditorUri: () => parseChatEditorUri,
  parseEditorTarget: () => parseEditorTarget
});
module.exports = __toCommonJS(extension_exports);
var vscode = __toESM(require("vscode"));
var FOXWARM_SIDEBAR_VIEW_ID = "foxwarm-webui.sidebar";
var FOXWARM_CHAT_EDITOR_VIEW_TYPE = "foxwarm-webui.chatEditor";
var FOXWARM_AGENTS_EDITOR_VIEW_TYPE = "foxwarm-webui.agentsEditor";
var FOXWARM_SETUP_EDITOR_VIEW_TYPE = "foxwarm-webui.setupEditor";
var FOXWARM_OPEN_SESSION_COMMAND = "foxwarm-webui.openSession";
var FOXWARM_EMBED_CHANNEL = "foxwarm-webui-embed";
var FOXWARM_EMBED_HOST_CHANNEL = "foxwarm-webui-host";
var FOXWARM_EMBED_VERSION = 1;
var CHAT_URI_SCHEME = "foxwarm-chat";
var AGENTS_URI_SCHEME = "foxwarm-agents";
var SETUP_URI_SCHEME = "foxwarm-setup";
var CHAT_FILE_SUFFIX = ".foxwarm-chat";
var AGENTS_FILE_PATH = "/agents.foxwarm-agents";
var SETUP_FILE_PATH = "/setup.foxwarm-setup";
var EXTENSION_ROUTE_MARKER = "/vscode-web/extensions/foxwarm-webui";
var OPEN_TABS_STATE_KEY = "foxwarm-webui.openTabs.v2";
var LEGACY_OPEN_SESSIONS_STATE_KEY = "foxwarm-webui.openSessions.v1";
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
function buildAgentsEditorUri() {
  return vscode.Uri.from({ scheme: AGENTS_URI_SCHEME, path: AGENTS_FILE_PATH });
}
function buildSetupEditorUri() {
  return vscode.Uri.from({ scheme: SETUP_URI_SCHEME, path: SETUP_FILE_PATH });
}
function parseEditorTarget(uri) {
  if (uri.scheme === CHAT_URI_SCHEME) return { kind: "session", sessionId: parseChatEditorUri(uri) };
  if (uri.scheme === AGENTS_URI_SCHEME && uri.path === AGENTS_FILE_PATH) return { kind: "agents" };
  if (uri.scheme === SETUP_URI_SCHEME && uri.path === SETUP_FILE_PATH) return { kind: "setup" };
  throw new Error("Invalid Foxwarm editor URI.");
}
function normalizeStoredTarget(value) {
  if (!value || typeof value !== "object") return null;
  const kind = value.kind;
  if (kind === "agents") return { kind: "agents" };
  if (kind === "setup") return { kind: "setup" };
  if (kind !== "session") return null;
  const request = normalizeOpenSessionRequest(value);
  return request ? { kind, ...request } : null;
}
function targetKey(target) {
  return target.kind === "session" ? `session:${target.sessionId}` : target.kind;
}
function targetEditor(target) {
  if (target.kind === "session") return { uri: buildChatEditorUri(target.sessionId), viewType: FOXWARM_CHAT_EDITOR_VIEW_TYPE };
  if (target.kind === "agents") return { uri: buildAgentsEditorUri(), viewType: FOXWARM_AGENTS_EDITOR_VIEW_TYPE };
  return { uri: buildSetupEditorUri(), viewType: FOXWARM_SETUP_EDITOR_VIEW_TYPE };
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
  const data = event.data;
  if (event.source === frame.contentWindow) {
    if (!data || data.channel !== '${FOXWARM_EMBED_CHANNEL}' || data.version !== ${FOXWARM_EMBED_VERSION} || data.nonce !== bridgeNonce) return;
    if (data.type === 'sidebar-ready') {
      vscode.postMessage({ type: 'sidebar-ready' });
    } else if (data.type === 'open-session') {
      vscode.postMessage({ type: 'open-session', sessionId: data.sessionId, title: data.title });
    } else if (data.type === 'open-agents') {
      vscode.postMessage({ type: 'open-agents' });
    } else if (data.type === 'open-setup') {
      vscode.postMessage({ type: 'open-setup' });
    } else if (data.type === 'open-commit') {
      vscode.postMessage({ type: 'open-commit', nodeId: data.nodeId, path: data.path, commitId: data.commitId });
    }
    return;
  }
  if (!data || data.channel !== '${FOXWARM_EMBED_HOST_CHANNEL}' || data.version !== ${FOXWARM_EMBED_VERSION} || data.nonce !== bridgeNonce || data.type !== 'active-target') return;
  frame.contentWindow.postMessage(data, ${JSON.stringify(frameOrigin)});
});
<\/script></body></html>`;
}
function normalizeHostMessage(value) {
  if (!value || typeof value !== "object") return null;
  const type = value.type;
  if (type === "sidebar-ready") return { type };
  if (type === "open-agents") return { type };
  if (type === "open-setup") return { type };
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
var FoxwarmDocument = class {
  constructor(uri, target) {
    this.uri = uri;
    this.target = target;
  }
  dispose() {
  }
};
var FoxwarmWebUiController = class {
  constructor(context) {
    this.context = context;
    this.sessionTitles = /* @__PURE__ */ new Map();
    this.sidebarBridge = null;
    this.webUiBaseUrl = deriveWebUiBaseUrl(context.extensionUri);
  }
  getStoredTargets() {
    const value = this.context.globalState.get(OPEN_TABS_STATE_KEY);
    if (Array.isArray(value)) return value.map(normalizeStoredTarget).filter((item) => !!item);
    const legacy = this.context.globalState.get(LEGACY_OPEN_SESSIONS_STATE_KEY, []);
    if (!Array.isArray(legacy)) return [];
    return legacy.map(normalizeOpenSessionRequest).filter((item) => !!item).map((item) => ({ kind: "session", ...item }));
  }
  async storeTargets(targets) {
    await this.context.globalState.update(OPEN_TABS_STATE_KEY, targets);
  }
  async rememberTarget(target) {
    const key = targetKey(target);
    const stored = this.getStoredTargets().filter((item) => targetKey(item) !== key);
    stored.push(target);
    await this.storeTargets(stored);
  }
  async forgetClosedTabs(closedTabs) {
    const closedKeys = /* @__PURE__ */ new Set();
    for (const tab of closedTabs) {
      const input = tab.input;
      if (!input?.uri || ![FOXWARM_CHAT_EDITOR_VIEW_TYPE, FOXWARM_AGENTS_EDITOR_VIEW_TYPE, FOXWARM_SETUP_EDITOR_VIEW_TYPE].includes(String(input.viewType))) continue;
      try {
        closedKeys.add(targetKey(parseEditorTarget(input.uri)));
      } catch {
      }
    }
    if (closedKeys.size === 0) return;
    await this.storeTargets(this.getStoredTargets().filter((item) => !closedKeys.has(targetKey(item))));
  }
  async restoreTargets() {
    for (const target of this.getStoredTargets()) {
      try {
        await this.openTarget(target);
      } catch (error) {
        console.warn(`Could not restore Foxwarm ${targetKey(target)}`, error);
      }
    }
  }
  async openTarget(target) {
    if (target.kind === "session" && target.title) this.sessionTitles.set(target.sessionId, target.title);
    await this.rememberTarget(target);
    const editor = targetEditor(target);
    await vscode.commands.executeCommand("vscode.openWith", editor.uri, editor.viewType, { preview: false });
    this.publishActiveTarget();
  }
  async openSession(value) {
    const request = normalizeOpenSessionRequest(value);
    if (!request) throw new Error("Expected a valid Foxwarm session id.");
    await this.openTarget({ kind: "session", ...request });
  }
  async handleHostMessage(value) {
    const message = normalizeHostMessage(value);
    if (!message) return;
    if (message.type === "sidebar-ready") {
      this.publishActiveTarget();
      return;
    }
    if (message.type === "open-session") {
      await this.openSession(message);
      return;
    }
    if (message.type === "open-agents") {
      await this.openTarget({ kind: "agents" });
      return;
    }
    if (message.type === "open-setup") {
      await this.openTarget({ kind: "setup" });
      return;
    }
    await vscode.commands.executeCommand("foxwarm-scm.openCommitDetails", {
      nodeId: message.nodeId,
      path: message.path,
      commitId: message.commitId
    });
  }
  getActiveTarget() {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (!input?.uri || ![FOXWARM_CHAT_EDITOR_VIEW_TYPE, FOXWARM_AGENTS_EDITOR_VIEW_TYPE, FOXWARM_SETUP_EDITOR_VIEW_TYPE].includes(String(input.viewType))) return null;
    try {
      const target = parseEditorTarget(input.uri);
      return target.kind === "session" ? { kind: "session", sessionId: target.sessionId } : target;
    } catch {
      return null;
    }
  }
  publishActiveTarget() {
    const bridge = this.sidebarBridge;
    if (!bridge) return;
    void bridge.webview.postMessage({
      channel: FOXWARM_EMBED_HOST_CHANNEL,
      version: FOXWARM_EMBED_VERSION,
      nonce: bridge.nonce,
      type: "active-target",
      target: this.getActiveTarget()
    });
  }
  resolveWebviewView(view) {
    const nonce = randomNonce();
    this.sidebarBridge = { webview: view.webview, nonce };
    view.webview.options = { enableScripts: true };
    view.webview.html = buildEmbeddedWebviewHtml(this.webUiBaseUrl, { kind: "sidebar" }, nonce);
    this.context.subscriptions.push(view.webview.onDidReceiveMessage((message) => {
      void this.handleHostMessage(message);
    }));
    this.context.subscriptions.push(view.onDidDispose(() => {
      if (this.sidebarBridge?.webview === view.webview) this.sidebarBridge = null;
    }));
  }
  openCustomDocument(uri) {
    return new FoxwarmDocument(uri, parseEditorTarget(uri));
  }
  resolveCustomEditor(document, panel) {
    const target = document.target;
    const title = target.kind === "session" ? this.sessionTitles.get(target.sessionId) : target.kind === "agents" ? "Agents" : "Setup";
    if (title) panel.title = title;
    panel.webview.options = { enableScripts: true };
    panel.webview.html = buildEmbeddedWebviewHtml(this.webUiBaseUrl, target.kind === "session" ? { kind: "chat", sessionId: target.sessionId, ...title ? { title } : {} } : target);
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
    vscode.window.registerCustomEditorProvider(FOXWARM_AGENTS_EDITOR_VIEW_TYPE, controller, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false
    }),
    vscode.window.registerCustomEditorProvider(FOXWARM_SETUP_EDITOR_VIEW_TYPE, controller, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false
    }),
    vscode.commands.registerCommand(FOXWARM_OPEN_SESSION_COMMAND, (value) => controller.openSession(value)),
    vscode.window.tabGroups.onDidChangeTabs((event) => {
      void controller.forgetClosedTabs(event.closed).finally(() => controller.publishActiveTarget());
    }),
    vscode.window.tabGroups.onDidChangeTabGroups(() => controller.publishActiveTarget())
  );
  globalThis.setTimeout(() => {
    void controller.restoreTargets();
  }, 0);
  console.log(`Foxwarm WebUI integration registered. webUiBase=${deriveWebUiBaseUrl(context.extensionUri)}`);
}
//# sourceMappingURL=extension.js.map
