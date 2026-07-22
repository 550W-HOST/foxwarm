import * as vscode from 'vscode';

export const FOXWARM_SIDEBAR_VIEW_ID = 'foxwarm-webui.sidebar';
export const FOXWARM_CHAT_EDITOR_VIEW_TYPE = 'foxwarm-webui.chatEditor';
export const FOXWARM_AGENTS_EDITOR_VIEW_TYPE = 'foxwarm-webui.agentsEditor';
export const FOXWARM_SETUP_EDITOR_VIEW_TYPE = 'foxwarm-webui.setupEditor';
export const FOXWARM_OPEN_SESSION_COMMAND = 'foxwarm-webui.openSession';
export const FOXWARM_EMBED_CHANNEL = 'foxwarm-webui-embed';
export const FOXWARM_EMBED_HOST_CHANNEL = 'foxwarm-webui-host';
export const FOXWARM_EMBED_VERSION = 1;
const CHAT_URI_SCHEME = 'foxwarm-chat';
const AGENTS_URI_SCHEME = 'foxwarm-agents';
const SETUP_URI_SCHEME = 'foxwarm-setup';
const CHAT_FILE_SUFFIX = '.foxwarm-chat';
const AGENTS_FILE_PATH = '/agents.foxwarm-agents';
const SETUP_FILE_PATH = '/setup.foxwarm-setup';
const EXTENSION_ROUTE_MARKER = '/vscode-web/extensions/foxwarm-webui';
const OPEN_TABS_STATE_KEY = 'foxwarm-webui.openTabs.v2';
const LEGACY_OPEN_SESSIONS_STATE_KEY = 'foxwarm-webui.openSessions.v1';

type OpenSessionRequest = { sessionId: string; title?: string };
export type FoxwarmEditorTarget = { kind: 'session'; sessionId: string; title?: string } | { kind: 'agents' } | { kind: 'setup' };
type ActiveTarget = { kind: 'session'; sessionId: string } | { kind: 'agents' } | { kind: 'setup' };
type EmbedTarget = { kind: 'sidebar' } | { kind: 'chat'; sessionId: string; title?: string } | { kind: 'agents' } | { kind: 'setup' };

type HostMessage =
  | { type: 'sidebar-ready' }
  | { type: 'open-session'; sessionId: string; title?: string }
  | { type: 'open-agents' }
  | { type: 'open-setup'; focus?: 'models' }
  | { type: 'setup-ready' }
  | { type: 'open-terminal' }
  | { type: 'open-commit'; nodeId: string; path: string; commitId: string };

function normalizeText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) return undefined;
  return normalized;
}

export function normalizeOpenSessionRequest(value: unknown): OpenSessionRequest | null {
  const raw = typeof value === 'string' ? { sessionId: value } : value;
  if (!raw || typeof raw !== 'object') return null;
  const sessionId = normalizeText((raw as { sessionId?: unknown }).sessionId, 512);
  if (!sessionId) return null;
  const title = normalizeText((raw as { title?: unknown }).title, 200);
  return { sessionId, ...(title ? { title } : {}) };
}

function safeEditorLabel(sessionId: string): string {
  const segment = sessionId.split('/').filter(Boolean).pop() || 'session';
  const label = segment.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  return label || 'session';
}

export function buildChatEditorUri(sessionId: string): vscode.Uri {
  const normalized = normalizeOpenSessionRequest(sessionId);
  if (!normalized) throw new Error('Invalid Foxwarm session id.');
  return vscode.Uri.from({
    scheme: CHAT_URI_SCHEME,
    path: `/sessions/${safeEditorLabel(normalized.sessionId)}${CHAT_FILE_SUFFIX}`,
    query: new URLSearchParams({ session: normalized.sessionId }).toString(),
  });
}

export function parseChatEditorUri(uri: vscode.Uri): string {
  if (uri.scheme !== CHAT_URI_SCHEME || !uri.path.endsWith(CHAT_FILE_SUFFIX)) {
    throw new Error('Invalid Foxwarm chat editor URI.');
  }
  const sessionId = new URLSearchParams(uri.query).get('session');
  const normalized = normalizeOpenSessionRequest(sessionId || '');
  if (!normalized) throw new Error('Foxwarm chat editor URI is missing a valid session.');
  return normalized.sessionId;
}

export function buildAgentsEditorUri(): vscode.Uri {
  return vscode.Uri.from({ scheme: AGENTS_URI_SCHEME, path: AGENTS_FILE_PATH });
}

export function buildSetupEditorUri(): vscode.Uri {
  return vscode.Uri.from({ scheme: SETUP_URI_SCHEME, path: SETUP_FILE_PATH });
}

export function parseEditorTarget(uri: vscode.Uri): FoxwarmEditorTarget {
  if (uri.scheme === CHAT_URI_SCHEME) return { kind: 'session', sessionId: parseChatEditorUri(uri) };
  if (uri.scheme === AGENTS_URI_SCHEME && uri.path === AGENTS_FILE_PATH) return { kind: 'agents' };
  if (uri.scheme === SETUP_URI_SCHEME && uri.path === SETUP_FILE_PATH) return { kind: 'setup' };
  throw new Error('Invalid Foxwarm editor URI.');
}

function normalizeStoredTarget(value: unknown): FoxwarmEditorTarget | null {
  if (!value || typeof value !== 'object') return null;
  const kind = (value as { kind?: unknown }).kind;
  if (kind === 'agents') return { kind: 'agents' };
  if (kind === 'setup') return { kind: 'setup' };
  if (kind !== 'session') return null;
  const request = normalizeOpenSessionRequest(value);
  return request ? { kind, ...request } : null;
}

function targetKey(target: FoxwarmEditorTarget): string {
  return target.kind === 'session' ? `session:${target.sessionId}` : target.kind;
}

function targetEditor(target: FoxwarmEditorTarget): { uri: vscode.Uri; viewType: string } {
  if (target.kind === 'session') return { uri: buildChatEditorUri(target.sessionId), viewType: FOXWARM_CHAT_EDITOR_VIEW_TYPE };
  if (target.kind === 'agents') return { uri: buildAgentsEditorUri(), viewType: FOXWARM_AGENTS_EDITOR_VIEW_TYPE };
  return { uri: buildSetupEditorUri(), viewType: FOXWARM_SETUP_EDITOR_VIEW_TYPE };
}

export function deriveWebUiBaseUrl(extensionUri: vscode.Uri): string {
  if ((extensionUri.scheme !== 'http' && extensionUri.scheme !== 'https') || !extensionUri.authority) return '/';
  const markerIndex = extensionUri.path.indexOf(EXTENSION_ROUTE_MARKER);
  const prefix = markerIndex >= 0 ? extensionUri.path.slice(0, markerIndex) : '';
  return `${extensionUri.scheme}://${extensionUri.authority}${prefix || ''}/`;
}

function randomNonce(): string {
  const bytes = new Uint8Array(18);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] || char);
}

function buildEmbedUrl(webUiBaseUrl: string, target: EmbedTarget, nonce: string): URL {
  const url = new URL(webUiBaseUrl, 'http://localhost/');
  url.searchParams.set('foxwarmEmbed', target.kind);
  url.searchParams.set('foxwarmEmbedNonce', nonce);
  if (target.kind === 'chat') {
    url.searchParams.set('sessionId', target.sessionId);
    if (target.title) url.searchParams.set('title', target.title);
  }
  return url;
}

export function buildEmbeddedWebviewHtml(webUiBaseUrl: string, target: EmbedTarget, nonce = randomNonce()): string {
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
      vscode.postMessage({ type: 'open-setup', ...(data.focus === 'models' ? { focus: 'models' } : {}) });
    } else if (data.type === 'setup-ready') {
      vscode.postMessage({ type: 'setup-ready' });
    } else if (data.type === 'open-terminal') {
      vscode.postMessage({ type: 'open-terminal' });
    } else if (data.type === 'open-commit') {
      vscode.postMessage({ type: 'open-commit', nodeId: data.nodeId, path: data.path, commitId: data.commitId });
    }
    return;
  }
  if (!data || data.channel !== '${FOXWARM_EMBED_HOST_CHANNEL}' || data.version !== ${FOXWARM_EMBED_VERSION} || data.nonce !== bridgeNonce || (data.type !== 'active-target' && data.type !== 'focus-models')) return;
  frame.contentWindow.postMessage(data, ${JSON.stringify(frameOrigin)});
});
</script></body></html>`;
}

function normalizeHostMessage(value: unknown): HostMessage | null {
  if (!value || typeof value !== 'object') return null;
  const type = (value as { type?: unknown }).type;
  if (type === 'sidebar-ready') return { type };
  if (type === 'open-agents') return { type };
  if (type === 'open-setup') return { type, ...((value as { focus?: unknown }).focus === 'models' ? { focus: 'models' as const } : {}) };
  if (type === 'setup-ready') return { type };
  if (type === 'open-terminal') return { type };
  if (type === 'open-session') {
    const request = normalizeOpenSessionRequest(value);
    return request ? { type, ...request } : null;
  }
  if (type === 'open-commit') {
    const raw = value as { nodeId?: unknown; path?: unknown; commitId?: unknown };
    const nodeId = normalizeText(raw.nodeId, 200);
    const path = normalizeText(raw.path, 4096);
    const commitId = normalizeText(raw.commitId, 64);
    if (!nodeId || !path?.startsWith('/') || !commitId || !/^[0-9a-fA-F]{7,64}$/.test(commitId)) return null;
    return { type, nodeId, path, commitId };
  }
  return null;
}

class FoxwarmDocument implements vscode.CustomDocument {
  constructor(readonly uri: vscode.Uri, readonly target: FoxwarmEditorTarget) {}
  dispose(): void {}
}

export class FoxwarmWebUiController implements vscode.WebviewViewProvider, vscode.CustomReadonlyEditorProvider<FoxwarmDocument> {
  private readonly webUiBaseUrl: string;
  private readonly sessionTitles = new Map<string, string>();
  private sidebarBridge: { webview: vscode.Webview; nonce: string } | null = null;
  private setupBridge: { webview: vscode.Webview; nonce: string; ready: boolean } | null = null;
  private pendingModelsFocus = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.webUiBaseUrl = deriveWebUiBaseUrl(context.extensionUri);
  }

  private getStoredTargets(): FoxwarmEditorTarget[] {
    const value = this.context.globalState.get<unknown>(OPEN_TABS_STATE_KEY);
    if (Array.isArray(value)) return value.map(normalizeStoredTarget).filter((item): item is FoxwarmEditorTarget => !!item);
    const legacy = this.context.globalState.get<unknown>(LEGACY_OPEN_SESSIONS_STATE_KEY, []);
    if (!Array.isArray(legacy)) return [];
    return legacy
      .map(normalizeOpenSessionRequest)
      .filter((item): item is OpenSessionRequest => !!item)
      .map(item => ({ kind: 'session' as const, ...item }));
  }

  private async storeTargets(targets: FoxwarmEditorTarget[]): Promise<void> {
    await this.context.globalState.update(OPEN_TABS_STATE_KEY, targets);
  }

  private async rememberTarget(target: FoxwarmEditorTarget): Promise<void> {
    const key = targetKey(target);
    const stored = this.getStoredTargets().filter(item => targetKey(item) !== key);
    stored.push(target);
    await this.storeTargets(stored);
  }

  async forgetClosedTabs(closedTabs: readonly vscode.Tab[]): Promise<void> {
    const closedKeys = new Set<string>();
    for (const tab of closedTabs) {
      const input = tab.input as { viewType?: unknown; uri?: vscode.Uri } | undefined;
      if (!input?.uri || ![FOXWARM_CHAT_EDITOR_VIEW_TYPE, FOXWARM_AGENTS_EDITOR_VIEW_TYPE, FOXWARM_SETUP_EDITOR_VIEW_TYPE].includes(String(input.viewType))) continue;
      try { closedKeys.add(targetKey(parseEditorTarget(input.uri))); } catch {}
    }
    if (closedKeys.size === 0) return;
    await this.storeTargets(this.getStoredTargets().filter(item => !closedKeys.has(targetKey(item))));
  }

  async restoreTargets(): Promise<void> {
    for (const target of this.getStoredTargets()) {
      try { await this.openTarget(target); } catch (error) { console.warn(`Could not restore Foxwarm ${targetKey(target)}`, error); }
    }
  }

  async openTarget(target: FoxwarmEditorTarget): Promise<void> {
    if (target.kind === 'session' && target.title) this.sessionTitles.set(target.sessionId, target.title);
    await this.rememberTarget(target);
    const editor = targetEditor(target);
    await vscode.commands.executeCommand('vscode.openWith', editor.uri, editor.viewType, { preview: false });
    this.publishActiveTarget();
  }

  async openSession(value: unknown): Promise<void> {
    const request = normalizeOpenSessionRequest(value);
    if (!request) throw new Error('Expected a valid Foxwarm session id.');
    await this.openTarget({ kind: 'session', ...request });
  }

  private publishModelsFocus(): void {
    const bridge = this.setupBridge;
    if (!this.pendingModelsFocus || !bridge?.ready) return;
    this.pendingModelsFocus = false;
    void bridge.webview.postMessage({
      channel: FOXWARM_EMBED_HOST_CHANNEL,
      version: FOXWARM_EMBED_VERSION,
      nonce: bridge.nonce,
      type: 'focus-models',
    });
  }

  async handleHostMessage(value: unknown, sourceWebview?: vscode.Webview): Promise<void> {
    const message = normalizeHostMessage(value);
    if (!message) return;
    if (message.type === 'setup-ready') {
      if (this.setupBridge?.webview === sourceWebview) {
        this.setupBridge.ready = true;
        this.publishModelsFocus();
      }
      return;
    }
    if (message.type === 'sidebar-ready') {
      this.publishActiveTarget();
      return;
    }
    if (message.type === 'open-session') {
      await this.openSession(message);
      return;
    }
    if (message.type === 'open-agents') {
      await this.openTarget({ kind: 'agents' });
      return;
    }
    if (message.type === 'open-setup') {
      if (message.focus === 'models') this.pendingModelsFocus = true;
      await this.openTarget({ kind: 'setup' });
      this.publishModelsFocus();
      return;
    }
    if (message.type === 'open-terminal') {
      await vscode.commands.executeCommand('foxwarm-terminal.newTerminal');
      return;
    }
    await vscode.commands.executeCommand('foxwarm-scm.openCommitDetails', {
      nodeId: message.nodeId,
      path: message.path,
      commitId: message.commitId,
    });
  }

  private getActiveTarget(): ActiveTarget | null {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input as { viewType?: unknown; uri?: vscode.Uri } | undefined;
    if (!input?.uri || ![FOXWARM_CHAT_EDITOR_VIEW_TYPE, FOXWARM_AGENTS_EDITOR_VIEW_TYPE, FOXWARM_SETUP_EDITOR_VIEW_TYPE].includes(String(input.viewType))) return null;
    try {
      const target = parseEditorTarget(input.uri);
      return target.kind === 'session' ? { kind: 'session', sessionId: target.sessionId } : target;
    } catch {
      return null;
    }
  }

  publishActiveTarget(): void {
    const bridge = this.sidebarBridge;
    if (!bridge) return;
    void bridge.webview.postMessage({
      channel: FOXWARM_EMBED_HOST_CHANNEL,
      version: FOXWARM_EMBED_VERSION,
      nonce: bridge.nonce,
      type: 'active-target',
      target: this.getActiveTarget(),
    });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    const nonce = randomNonce();
    this.sidebarBridge = { webview: view.webview, nonce };
    view.webview.options = { enableScripts: true };
    view.webview.html = buildEmbeddedWebviewHtml(this.webUiBaseUrl, { kind: 'sidebar' }, nonce);
    this.context.subscriptions.push(view.webview.onDidReceiveMessage(message => { void this.handleHostMessage(message, view.webview); }));
    this.context.subscriptions.push(view.onDidDispose(() => {
      if (this.sidebarBridge?.webview === view.webview) this.sidebarBridge = null;
    }));
  }

  openCustomDocument(uri: vscode.Uri): FoxwarmDocument {
    return new FoxwarmDocument(uri, parseEditorTarget(uri));
  }

  resolveCustomEditor(document: FoxwarmDocument, panel: vscode.WebviewPanel): void {
    const target = document.target;
    const title = target.kind === 'session' ? this.sessionTitles.get(target.sessionId) : target.kind === 'agents' ? 'Agents' : 'Setup';
    if (title) panel.title = title;
    const nonce = randomNonce();
    panel.webview.options = { enableScripts: true };
    panel.webview.html = buildEmbeddedWebviewHtml(this.webUiBaseUrl, target.kind === 'session'
      ? { kind: 'chat', sessionId: target.sessionId, ...(title ? { title } : {}) }
      : target, nonce);
    if (target.kind === 'setup') {
      this.setupBridge = { webview: panel.webview, nonce, ready: false };
      this.context.subscriptions.push(panel.onDidDispose(() => {
        if (this.setupBridge?.webview === panel.webview) this.setupBridge = null;
      }));
    }
    this.context.subscriptions.push(panel.webview.onDidReceiveMessage(message => { void this.handleHostMessage(message, panel.webview); }));
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const controller = new FoxwarmWebUiController(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(FOXWARM_SIDEBAR_VIEW_ID, controller),
    vscode.window.registerCustomEditorProvider(FOXWARM_CHAT_EDITOR_VIEW_TYPE, controller, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    }),
    vscode.window.registerCustomEditorProvider(FOXWARM_AGENTS_EDITOR_VIEW_TYPE, controller, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    }),
    vscode.window.registerCustomEditorProvider(FOXWARM_SETUP_EDITOR_VIEW_TYPE, controller, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    }),
    vscode.commands.registerCommand(FOXWARM_OPEN_SESSION_COMMAND, value => controller.openSession(value)),
    vscode.window.tabGroups.onDidChangeTabs(event => {
      void controller.forgetClosedTabs(event.closed).finally(() => controller.publishActiveTarget());
    }),
    vscode.window.tabGroups.onDidChangeTabGroups(() => controller.publishActiveTarget()),
  );
  globalThis.setTimeout(() => { void controller.restoreTargets(); }, 0);
  console.log(`Foxwarm WebUI integration registered. webUiBase=${deriveWebUiBaseUrl(context.extensionUri)}`);
}
