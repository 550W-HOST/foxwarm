import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import Module from 'node:module';

class MockUri {
  constructor(scheme, authority, path, query = '', fragment = '') {
    this.scheme = scheme;
    this.authority = authority;
    this.path = path;
    this.query = query;
    this.fragment = fragment;
  }
  static from(value) {
    return new MockUri(value.scheme, value.authority || '', value.path || '', value.query || '', value.fragment || '');
  }
  static parse(value) {
    const parsed = new URL(value);
    return new MockUri(parsed.protocol.slice(0, -1), parsed.host, parsed.pathname, parsed.search.slice(1), parsed.hash.slice(1));
  }
  toString() {
    return `${this.scheme}://${this.authority}${this.path}${this.query ? `?${this.query}` : ''}`;
  }
}

const commands = new Map();
const executed = [];
const customEditorProviders = new Map();
let sidebarProvider;
let tabChangeHandler;
let tabGroupChangeHandler;
const tabGroups = {
  activeTabGroup: { activeTab: null },
  all: [],
  onDidChangeTabs(handler) { tabChangeHandler = handler; return disposable(); },
  onDidChangeTabGroups(handler) { tabGroupChangeHandler = handler; return disposable(); },
};
const disposable = () => ({ dispose() {} });
const vscodeMock = {
  Uri: MockUri,
  commands: {
    registerCommand: (id, handler) => { commands.set(id, handler); return disposable(); },
    executeCommand: async (id, ...args) => {
      executed.push({ id, args });
      if (id === 'vscode.openWith') {
        const tab = { input: { uri: args[0], viewType: args[1] } };
        tabGroups.activeTabGroup.activeTab = tab;
        tabGroups.all = [{ activeTab: tab }];
        tabChangeHandler?.({ opened: [tab], closed: [], changed: [tab] });
      }
    },
  },
  window: {
    registerWebviewViewProvider: (_id, provider) => { sidebarProvider = provider; return disposable(); },
    registerCustomEditorProvider: (id, provider) => { customEditorProviders.set(id, provider); return disposable(); },
    tabGroups,
  },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'vscode') return vscodeMock;
  return originalLoad.call(this, request, parent, isMain);
};

const require = createRequire(import.meta.url);
const extension = require('../dist/extension.js');
Module._load = originalLoad;

function mockWebview() {
  let handler;
  return {
    options: {},
    html: '',
    posted: [],
    onDidReceiveMessage(next) { handler = next; return disposable(); },
    async postMessage(message) { this.posted.push(message); return true; },
    async receive(message) { return handler?.(message); },
  };
}

function mockContext(values = new Map()) {
  return {
    extensionUri: MockUri.parse('https://example.test/proxy/vscode-web/extensions/foxwarm-webui'),
    subscriptions: [],
    globalState: {
      values,
      get(key, fallback) { return this.values.has(key) ? this.values.get(key) : fallback; },
      async update(key, value) { this.values.set(key, value); },
    },
  };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('derives base-path-safe URLs and round-trips stable editor identities', () => {
  assert.equal(extension.deriveWebUiBaseUrl(MockUri.parse('https://example.test/proxy/vscode-web/extensions/foxwarm-webui')), 'https://example.test/proxy/');
  const chat = extension.buildChatEditorUri('agent/child session');
  assert.equal(chat.scheme, 'foxwarm-chat');
  assert.match(chat.path, /child-session\.foxwarm-chat$/);
  assert.deepEqual(extension.parseEditorTarget(chat), { kind: 'session', sessionId: 'agent/child session' });
  assert.deepEqual(extension.parseEditorTarget(extension.buildAgentsEditorUri()), { kind: 'agents' });
  assert.deepEqual(extension.parseEditorTarget(extension.buildSetupEditorUri()), { kind: 'setup' });
  assert.throws(() => extension.parseEditorTarget(MockUri.from({ scheme: 'file', path: '/bad' })));
});

test('fixed bridges open, restore, activate, and explicitly close session/Agents/Setup editors', async () => {
  tabGroups.activeTabGroup.activeTab = null;
  executed.length = 0;
  const context = mockContext();
  extension.activate(context);
  assert.ok(sidebarProvider);
  assert.equal(customEditorProviders.size, 3);

  const sidebarWebview = mockWebview();
  let disposeSidebar;
  sidebarProvider.resolveWebviewView({
    webview: sidebarWebview,
    onDidDispose(handler) { disposeSidebar = handler; return disposable(); },
  });
  assert.match(sidebarWebview.html, /https:\/\/example\.test\/proxy\/\?foxwarmEmbed=sidebar/);
  assert.match(sidebarWebview.html, /foxwarm-webui-host/);
  assert.doesNotMatch(sidebarWebview.html, /foxwarm_token/);
  await sidebarWebview.receive({ type: 'sidebar-ready' });
  await tick();
  assert.equal(sidebarWebview.posted.at(-1).target, null);
  assert.deepEqual(sidebarWebview.posted.at(-1).visibleSessionIds, []);

  await sidebarWebview.receive({ type: 'open-terminal' });
  assert.deepEqual(executed.at(-1), { id: 'foxwarm-terminal.newTerminal', args: [] });

  await sidebarWebview.receive({ type: 'open-session', sessionId: 'agent/task', title: 'Task title' });
  await tick();
  let open = executed.filter(item => item.id === 'vscode.openWith').at(-1);
  assert.equal(extension.parseChatEditorUri(open.args[0]), 'agent/task');
  assert.equal(open.args[1], 'foxwarm-webui.chatEditor');
  assert.deepEqual(sidebarWebview.posted.at(-1).target, { kind: 'session', sessionId: 'agent/task' });
  assert.deepEqual(sidebarWebview.posted.at(-1).visibleSessionIds, ['agent/task']);

  const secondSessionTab = { input: { uri: extension.buildChatEditorUri('agent/other'), viewType: 'foxwarm-webui.chatEditor' } };
  tabGroups.all = [{ activeTab: tabGroups.activeTabGroup.activeTab }, { activeTab: secondSessionTab }];
  tabGroupChangeHandler?.();
  await tick();
  assert.deepEqual(sidebarWebview.posted.at(-1).visibleSessionIds, ['agent/task', 'agent/other']);

  const chatProvider = customEditorProviders.get('foxwarm-webui.chatEditor');
  const chatDocument = chatProvider.openCustomDocument(open.args[0]);
  const chatWebview = mockWebview();
  const chatPanel = { title: '', webview: chatWebview };
  chatProvider.resolveCustomEditor(chatDocument, chatPanel);
  assert.equal(chatPanel.title, 'Task title');
  assert.match(chatWebview.html, /foxwarmEmbed=chat/);

  await sidebarWebview.receive({ type: 'open-agents' });
  await tick();
  open = executed.filter(item => item.id === 'vscode.openWith').at(-1);
  assert.equal(open.args[1], 'foxwarm-webui.agentsEditor');
  assert.deepEqual(sidebarWebview.posted.at(-1).target, { kind: 'agents' });
  const agentsProvider = customEditorProviders.get('foxwarm-webui.agentsEditor');
  const agentsDocument = agentsProvider.openCustomDocument(open.args[0]);
  const agentsPanel = { title: '', webview: mockWebview() };
  agentsProvider.resolveCustomEditor(agentsDocument, agentsPanel);
  assert.equal(agentsPanel.title, 'Agents');
  assert.match(agentsPanel.webview.html, /foxwarmEmbed=agents/);

  await sidebarWebview.receive({ type: 'open-setup' });
  await tick();
  open = executed.filter(item => item.id === 'vscode.openWith').at(-1);
  assert.equal(open.args[1], 'foxwarm-webui.setupEditor');
  assert.deepEqual(sidebarWebview.posted.at(-1).target, { kind: 'setup' });
  const setupProvider = customEditorProviders.get('foxwarm-webui.setupEditor');
  const setupDocument = setupProvider.openCustomDocument(open.args[0]);
  let disposeSetup;
  const setupPanel = {
    title: '',
    webview: mockWebview(),
    onDidDispose(handler) { disposeSetup = handler; return disposable(); },
  };
  setupProvider.resolveCustomEditor(setupDocument, setupPanel);
  assert.equal(setupPanel.title, 'Setup');
  assert.match(setupPanel.webview.html, /foxwarmEmbed=setup/);
  assert.match(setupPanel.webview.html, /focus-models/);

  await chatWebview.receive({ type: 'open-setup', focus: 'models' });
  await tick();
  open = executed.filter(item => item.id === 'vscode.openWith').at(-1);
  assert.equal(open.args[1], 'foxwarm-webui.setupEditor');
  assert.equal(setupPanel.webview.posted.length, 0);
  await setupPanel.webview.receive({ type: 'setup-ready' });
  await tick();
  const focusMessage = setupPanel.webview.posted.at(-1);
  assert.match(focusMessage.nonce, /^[0-9a-f]{36}$/);
  assert.deepEqual({ ...focusMessage, nonce: '<nonce>' }, {
    channel: 'foxwarm-webui-host',
    version: 1,
    nonce: '<nonce>',
    type: 'focus-models',
  });

  assert.deepEqual(context.globalState.values.get('foxwarm-webui.openTabs.v2'), [
    { kind: 'session', sessionId: 'agent/task', title: 'Task title' },
    { kind: 'agents' },
    { kind: 'setup' },
  ]);

  const setupTab = tabGroups.activeTabGroup.activeTab;
  tabGroups.activeTabGroup.activeTab = { input: { viewType: 'default', uri: MockUri.from({ scheme: 'file', path: '/readme' }) } };
  tabChangeHandler({ opened: [], closed: [], changed: [tabGroups.activeTabGroup.activeTab] });
  await tick();
  assert.equal(sidebarWebview.posted.at(-1).target, null);

  tabGroups.activeTabGroup.activeTab = null;
  tabChangeHandler({ opened: [], closed: [setupTab], changed: [] });
  await tick();
  assert.deepEqual(context.globalState.values.get('foxwarm-webui.openTabs.v2'), [
    { kind: 'session', sessionId: 'agent/task', title: 'Task title' },
    { kind: 'agents' },
  ]);

  await chatWebview.receive({ type: 'open-commit', nodeId: 'master', path: '/repo', commitId: '5e1e03ac' });
  assert.deepEqual(executed.at(-1), {
    id: 'foxwarm-scm.openCommitDetails',
    args: [{ nodeId: 'master', path: '/repo', commitId: '5e1e03ac' }],
  });
  const count = executed.length;
  await chatWebview.receive({ type: 'open-commit', nodeId: 'master', path: 'relative', commitId: 'oops' });
  assert.equal(executed.length, count);

  tabGroupChangeHandler();
  disposeSetup();
  disposeSidebar();
});

test('restores stored session, Agents, and Setup targets in stable order', async () => {
  tabGroups.activeTabGroup.activeTab = null;
  executed.length = 0;
  const values = new Map([
    ['foxwarm-webui.openTabs.v2', [
      { kind: 'session', sessionId: 'agent/restored', title: 'Restored' },
      { kind: 'agents' },
      { kind: 'setup' },
    ]],
  ]);
  extension.activate(mockContext(values));
  await tick();
  await tick();
  assert.deepEqual(executed.filter(item => item.id === 'vscode.openWith').map(item => item.args[1]), [
    'foxwarm-webui.chatEditor',
    'foxwarm-webui.agentsEditor',
    'foxwarm-webui.setupEditor',
  ]);
});

test('reads legacy open-session restore state and writes the generalized target state', async () => {
  tabGroups.activeTabGroup.activeTab = null;
  executed.length = 0;
  const values = new Map([
    ['foxwarm-webui.openSessions.v1', [{ sessionId: 'agent/legacy', title: 'Legacy' }]],
  ]);
  extension.activate(mockContext(values));
  await tick();
  await tick();
  assert.equal(executed.filter(item => item.id === 'vscode.openWith').at(-1).args[1], 'foxwarm-webui.chatEditor');
  assert.deepEqual(values.get('foxwarm-webui.openTabs.v2'), [{ kind: 'session', sessionId: 'agent/legacy', title: 'Legacy' }]);
});
