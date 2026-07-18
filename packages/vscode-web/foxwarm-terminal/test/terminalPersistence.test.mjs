import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import Module from 'node:module';
import packageJson from '../package.json' with { type: 'json' };

class MockEventEmitter {
  listeners = [];
  event = (listener) => {
    this.listeners.push(listener);
    return { dispose: () => {} };
  };
  fire(value) {
    for (const listener of this.listeners) listener(value);
  }
  dispose() {
    this.listeners = [];
  }
}

class MockTerminalProfile {
  constructor(options) {
    this.options = options;
  }
}

const openedHandlers = [];
const closedHandlers = [];
const terminals = [];
const commands = new Map();
const executedCommands = [];
const disposables = () => ({ dispose() {} });
const workspaceFoldersChanged = new MockEventEmitter();

const workspaceUri = {
  scheme: 'foxwarm',
  authority: 'node+master',
  path: '/app',
  toString: () => 'foxwarm://node+master/app',
};

const vscodeMock = {
  EventEmitter: MockEventEmitter,
  TerminalProfile: MockTerminalProfile,
  TerminalLocation: { Panel: 1, Editor: 2 },
  TerminalExitReason: { Unknown: 0, Shutdown: 1, Process: 2, User: 3, Extension: 4 },
  FileType: { Directory: 2 },
  window: {
    activeTerminal: undefined,
    terminals,
    registerTerminalProfileProvider: () => disposables(),
    onDidOpenTerminal: (handler) => { openedHandlers.push(handler); return disposables(); },
    onDidCloseTerminal: (handler) => { closedHandlers.push(handler); return disposables(); },
    createTerminal: (creationOptions) => {
      const terminal = {
        name: creationOptions.name,
        creationOptions,
        exitStatus: undefined,
        showCalls: 0,
        show() { this.showCalls += 1; },
      };
      terminals.push(terminal);
      for (const handler of openedHandlers) handler(terminal);
      return terminal;
    },
  },
  workspace: {
    workspaceFolders: [{ uri: workspaceUri }],
    fs: { stat: async () => ({ type: 2 }) },
    onDidChangeWorkspaceFolders: workspaceFoldersChanged.event,
  },
  commands: {
    registerCommand: (id, handler) => { commands.set(id, handler); return disposables(); },
    executeCommand: async (id, ...args) => {
      executedCommands.push({ id, args });
      if (id === 'foxwarm-fs.handleOpenRequest') return { status: 'opened' };
      return undefined;
    },
  },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'vscode') return vscodeMock;
  return originalLoad.call(this, request, parent, isMain);
};

const fetchCalls = [];
const backendTerminals = [
  { id: 'term-root', nodeId: 'master', cwd: '/app', shell: '/bin/bash', cols: 100, rows: 30, createdAt: 1, pid: 10 },
  { id: 'term-src', nodeId: 'master', cwd: '/app/src', shell: '/bin/bash', cols: 100, rows: 30, createdAt: 2, pid: 11 },
  { id: 'term-outside', nodeId: 'master', cwd: '/other', shell: '/bin/bash', cols: 100, rows: 30, createdAt: 3, pid: 12 },
  { id: 'term-worker', nodeId: 'worker', cwd: '/app', shell: '/bin/bash', cols: 100, rows: 30, createdAt: 4, pid: 13 },
];

globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  const method = init.method || 'GET';
  fetchCalls.push({ url, method });
  if (method === 'GET' && url.endsWith('/api/terminals')) {
    return new Response(JSON.stringify({ terminals: backendTerminals }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (method === 'DELETE') {
    return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  throw new Error(`Unexpected fetch ${method} ${url}`);
};

const sockets = [];
class MockWebSocket {
  static OPEN = 1;
  readyState = 1;
  constructor(url) {
    this.url = url;
    sockets.push(this);
  }
  sent = [];
  send(value) { this.sent.push(JSON.parse(value)); }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}
globalThis.WebSocket = MockWebSocket;

const require = createRequire(import.meta.url);
const extension = require('../dist/extension.js');

test('terminal extension restores persisted backend terminals after Code startup', () => {
  assert.ok(packageJson.activationEvents.includes('onStartupFinished'));
});

async function flushAsync() {
  await new Promise((resolve) => setTimeout(resolve, 150));
}

test('activation restores workspace terminals by attachment without creating duplicates', async () => {
  const context = {
    extensionUri: { scheme: 'http', authority: 'example.test', path: '/proxy/vscode-web/extensions/foxwarm-terminal' },
    subscriptions: [],
  };
  extension.activate(context);
  await flushAsync();

  assert.equal(terminals.length, 2);
  assert.equal(fetchCalls.filter((call) => call.method === 'POST').length, 0);
  assert.equal(fetchCalls.filter((call) => call.method === 'GET').length, 1);
  assert.equal(terminals.filter((terminal) => terminal.showCalls === 1).length, 1);

  workspaceFoldersChanged.fire({ added: [], removed: [] });
  await flushAsync();
  assert.equal(terminals.length, 2);

  for (const terminal of terminals) {
    terminal.creationOptions.pty.open(undefined);
  }
  await flushAsync();

  assert.equal(fetchCalls.filter((call) => call.method === 'POST').length, 0);
  assert.equal(sockets.length, 2);
  assert.ok(sockets.some((socket) => socket.url.includes('terminalId=term-root')));
  assert.ok(sockets.some((socket) => socket.url.includes('terminalId=term-src')));
  assert.ok(sockets.every((socket) => socket.url.includes('control=code')));

  const controlSocket = sockets.find((socket) => socket.url.includes('terminalId=term-root'));
  controlSocket.onmessage({ data: JSON.stringify({
    type: 'control',
    requestId: 'request-1',
    command: 'open',
    request: { kind: 'openFile', nodeId: 'master', path: '/app/index.ts' },
  }) });
  await flushAsync();
  assert.deepEqual(executedCommands.at(-1), {
    id: 'foxwarm-fs.handleOpenRequest',
    args: [{ kind: 'openFile', nodeId: 'master', path: '/app/index.ts' }],
  });
  assert.deepEqual(controlSocket.sent.at(-1), {
    type: 'control-result',
    requestId: 'request-1',
    ok: true,
    message: 'Opened: /app/index.ts',
  });

  const [shutdownTerminal, userClosedTerminal] = terminals;

  shutdownTerminal.creationOptions.pty.close();
  shutdownTerminal.exitStatus = { reason: vscodeMock.TerminalExitReason.Shutdown };
  for (const handler of closedHandlers) handler(shutdownTerminal);
  await flushAsync();
  assert.equal(fetchCalls.filter((call) => call.method === 'DELETE').length, 0);

  userClosedTerminal.creationOptions.pty.close();
  userClosedTerminal.exitStatus = { reason: vscodeMock.TerminalExitReason.User };
  for (const handler of closedHandlers) handler(userClosedTerminal);
  await flushAsync();

  const deletes = fetchCalls.filter((call) => call.method === 'DELETE');
  assert.equal(deletes.length, 1);
  assert.match(deletes[0].url, /\/api\/terminals\/term-src$/);
});
