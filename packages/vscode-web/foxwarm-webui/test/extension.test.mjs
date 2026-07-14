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
let sidebarProvider;
let customEditorProvider;
let tabChangeHandler;
const disposable = () => ({ dispose() {} });
const vscodeMock = {
  Uri: MockUri,
  commands: {
    registerCommand: (id, handler) => { commands.set(id, handler); return disposable(); },
    executeCommand: async (id, ...args) => { executed.push({ id, args }); },
  },
  window: {
    registerWebviewViewProvider: (_id, provider) => { sidebarProvider = provider; return disposable(); },
    registerCustomEditorProvider: (_id, provider) => { customEditorProvider = provider; return disposable(); },
    tabGroups: { onDidChangeTabs: (handler) => { tabChangeHandler = handler; return disposable(); } },
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
    onDidReceiveMessage(next) { handler = next; return disposable(); },
    async receive(message) { return handler?.(message); },
  };
}

test('derives a base-path-safe WebUI URL and round-trips chat editor identity', () => {
  assert.equal(extension.deriveWebUiBaseUrl(MockUri.parse('https://example.test/proxy/vscode-web/extensions/foxwarm-webui')), 'https://example.test/proxy/');
  const uri = extension.buildChatEditorUri('agent/child session');
  assert.equal(uri.scheme, 'foxwarm-chat');
  assert.match(uri.path, /child-session\.foxwarm-chat$/);
  assert.equal(extension.parseChatEditorUri(uri), 'agent/child session');
  assert.throws(() => extension.parseChatEditorUri(MockUri.from({ scheme: 'file', path: '/bad' })));
});

test('sidebar bridge opens dedupable custom chat editors and chat bridge retains commit actions', async () => {
  const context = {
    extensionUri: MockUri.parse('https://example.test/proxy/vscode-web/extensions/foxwarm-webui'),
    subscriptions: [],
    globalState: {
      values: new Map(),
      get(key, fallback) { return this.values.has(key) ? this.values.get(key) : fallback; },
      async update(key, value) { this.values.set(key, value); },
    },
  };
  extension.activate(context);
  assert.ok(sidebarProvider);
  assert.ok(customEditorProvider);

  const sidebarWebview = mockWebview();
  sidebarProvider.resolveWebviewView({ webview: sidebarWebview });
  assert.match(sidebarWebview.html, /https:\/\/example\.test\/proxy\/\?foxwarmEmbed=sidebar/);
  assert.doesNotMatch(sidebarWebview.html, /foxwarm_token|alphabot_token/);

  await sidebarWebview.receive({ type: 'open-session', sessionId: 'agent/task', title: 'Task title' });
  await new Promise(resolve => setTimeout(resolve, 0));
  const open = executed.at(-1);
  assert.equal(open.id, 'vscode.openWith');
  assert.equal(extension.parseChatEditorUri(open.args[0]), 'agent/task');
  assert.equal(open.args[1], 'foxwarm-webui.chatEditor');
  assert.deepEqual(open.args[2], { preview: false });
  assert.deepEqual(context.globalState.values.get('foxwarm-webui.openSessions.v1'), [{ sessionId: 'agent/task', title: 'Task title' }]);

  const document = customEditorProvider.openCustomDocument(open.args[0]);
  const chatWebview = mockWebview();
  const panel = { title: '', webview: chatWebview };
  customEditorProvider.resolveCustomEditor(document, panel);
  assert.equal(panel.title, 'Task title');
  assert.match(chatWebview.html, /foxwarmEmbed=chat/);
  assert.match(chatWebview.html, /sessionId=agent%2Ftask/);

  await chatWebview.receive({ type: 'open-commit', nodeId: 'master', path: '/repo', commitId: '5e1e03ac' });
  assert.deepEqual(executed.at(-1), {
    id: 'foxwarm-scm.openCommitDetails',
    args: [{ nodeId: 'master', path: '/repo', commitId: '5e1e03ac' }],
  });
  const count = executed.length;
  await chatWebview.receive({ type: 'open-commit', nodeId: 'master', path: 'relative', commitId: 'oops' });
  assert.equal(executed.length, count);

  await tabChangeHandler({ closed: [{ input: { viewType: 'foxwarm-webui.chatEditor', uri: open.args[0] } }] });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(context.globalState.values.get('foxwarm-webui.openSessions.v1'), []);
});
