import * as vscode from 'vscode';

export const FOXWARM_SIDEBAR_VIEW_ID = 'foxwarm-webui.sidebar';
export const FOXWARM_CHAT_EDITOR_VIEW_TYPE = 'foxwarm-webui.chatEditor';
export const FOXWARM_OPEN_SESSION_COMMAND = 'foxwarm-webui.openSession';
export const FOXWARM_EMBED_CHANNEL = 'foxwarm-webui-embed';
export const FOXWARM_EMBED_VERSION = 1;
const CHAT_URI_SCHEME = 'foxwarm-chat';
const CHAT_FILE_SUFFIX = '.foxwarm-chat';
const EXTENSION_ROUTE_MARKER = '/vscode-web/extensions/foxwarm-webui';
const OPEN_SESSIONS_STATE_KEY = 'foxwarm-webui.openSessions.v1';

type OpenSessionRequest = { sessionId: string; title?: string };
type EmbedTarget = { kind: 'sidebar' } | { kind: 'chat'; sessionId: string; title?: string };

type HostMessage =
  | { type: 'open-session'; sessionId: string; title?: string }
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
  if (event.source !== frame.contentWindow) return;
  const data = event.data;
  if (!data || data.channel !== '${FOXWARM_EMBED_CHANNEL}' || data.version !== ${FOXWARM_EMBED_VERSION} || data.nonce !== bridgeNonce) return;
  if (data.type === 'open-session') {
    vscode.postMessage({ type: 'open-session', sessionId: data.sessionId, title: data.title });
  } else if (data.type === 'open-commit') {
    vscode.postMessage({ type: 'open-commit', nodeId: data.nodeId, path: data.path, commitId: data.commitId });
  }
});
</script></body></html>`;
}

function normalizeHostMessage(value: unknown): HostMessage | null {
  if (!value || typeof value !== 'object') return null;
  const type = (value as { type?: unknown }).type;
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

class FoxwarmChatDocument implements vscode.CustomDocument {
  constructor(readonly uri: vscode.Uri, readonly sessionId: string) {}
  dispose(): void {}
}

export class FoxwarmWebUiController implements vscode.WebviewViewProvider, vscode.CustomReadonlyEditorProvider<FoxwarmChatDocument> {
  private readonly webUiBaseUrl: string;
  private readonly sessionTitles = new Map<string, string>();

  constructor(private readonly context: vscode.ExtensionContext) {
    this.webUiBaseUrl = deriveWebUiBaseUrl(context.extensionUri);
  }

  private getStoredSessions(): OpenSessionRequest[] {
    const value = this.context.globalState.get<unknown>(OPEN_SESSIONS_STATE_KEY, []);
    if (!Array.isArray(value)) return [];
    return value.map(normalizeOpenSessionRequest).filter((item): item is OpenSessionRequest => !!item);
  }

  private async storeSessions(sessions: OpenSessionRequest[]): Promise<void> {
    await this.context.globalState.update(OPEN_SESSIONS_STATE_KEY, sessions);
  }

  private async rememberSession(request: OpenSessionRequest): Promise<void> {
    const stored = this.getStoredSessions().filter(item => item.sessionId !== request.sessionId);
    stored.push(request);
    await this.storeSessions(stored);
  }

  async forgetClosedTabs(closedTabs: readonly vscode.Tab[]): Promise<void> {
    const closedSessionIds = new Set<string>();
    for (const tab of closedTabs) {
      const input = tab.input as { viewType?: unknown; uri?: vscode.Uri } | undefined;
      if (input?.viewType !== FOXWARM_CHAT_EDITOR_VIEW_TYPE || !input.uri) continue;
      try { closedSessionIds.add(parseChatEditorUri(input.uri)); } catch {}
    }
    if (closedSessionIds.size === 0) return;
    await this.storeSessions(this.getStoredSessions().filter(item => !closedSessionIds.has(item.sessionId)));
  }

  async restoreSessions(): Promise<void> {
    for (const request of this.getStoredSessions()) {
      try { await this.openSession(request); } catch (error) { console.warn(`Could not restore Foxwarm session ${request.sessionId}`, error); }
    }
  }

  async openSession(value: unknown): Promise<void> {
    const request = normalizeOpenSessionRequest(value);
    if (!request) throw new Error('Expected a valid Foxwarm session id.');
    if (request.title) this.sessionTitles.set(request.sessionId, request.title);
    await this.rememberSession(request);
    await vscode.commands.executeCommand('vscode.openWith', buildChatEditorUri(request.sessionId), FOXWARM_CHAT_EDITOR_VIEW_TYPE, { preview: false });
  }

  async handleHostMessage(value: unknown): Promise<void> {
    const message = normalizeHostMessage(value);
    if (!message) return;
    if (message.type === 'open-session') {
      await this.openSession(message);
      return;
    }
    await vscode.commands.executeCommand('foxwarm-scm.openCommitDetails', {
      nodeId: message.nodeId,
      path: message.path,
      commitId: message.commitId,
    });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = { enableScripts: true };
    view.webview.html = buildEmbeddedWebviewHtml(this.webUiBaseUrl, { kind: 'sidebar' });
    this.context.subscriptions.push(view.webview.onDidReceiveMessage(message => { void this.handleHostMessage(message); }));
  }

  openCustomDocument(uri: vscode.Uri): FoxwarmChatDocument {
    return new FoxwarmChatDocument(uri, parseChatEditorUri(uri));
  }

  resolveCustomEditor(document: FoxwarmChatDocument, panel: vscode.WebviewPanel): void {
    const title = this.sessionTitles.get(document.sessionId);
    if (title) panel.title = title;
    panel.webview.options = { enableScripts: true };
    panel.webview.html = buildEmbeddedWebviewHtml(this.webUiBaseUrl, {
      kind: 'chat',
      sessionId: document.sessionId,
      ...(title ? { title } : {}),
    });
    this.context.subscriptions.push(panel.webview.onDidReceiveMessage(message => { void this.handleHostMessage(message); }));
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
    vscode.commands.registerCommand(FOXWARM_OPEN_SESSION_COMMAND, value => controller.openSession(value)),
    vscode.window.tabGroups.onDidChangeTabs(event => { void controller.forgetClosedTabs(event.closed); }),
  );
  globalThis.setTimeout(() => { void controller.restoreSessions(); }, 0);
  console.log(`Foxwarm WebUI integration registered. webUiBase=${deriveWebUiBaseUrl(context.extensionUri)}`);
}
