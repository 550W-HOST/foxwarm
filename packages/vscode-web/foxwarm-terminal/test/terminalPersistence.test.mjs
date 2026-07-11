import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import Module from 'node:module';

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
const disposables = () => ({ dispose() {} });

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
        show() {},
      };
      terminals.push(terminal);
      for (const handler of openedHandlers) handler(terminal);
      return terminal;
    },
  },
  workspace: {
    workspaceFolders: [{ uri: workspaceUri }],
    fs: { stat: async () => ({ type: 2 }) },
  },
  commands: {
    registerCommand: (id, handler) => { commands.set(id, handler); return disposables(); },
    executeCommand: async () => undefined,
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
  send() {}
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}
globalThis.WebSocket = MockWebSocket;

const require = createRequire(import.meta.url);
const extension = require('../dist/extension.js');

async function flushAsync() {
  await new Promise((resolve) => setTimeout(resolve, 20));
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

  for (const terminal of terminals) {
    terminal.creationOptions.pty.open(undefined);
  }
  await flushAsync();

  assert.equal(fetchCalls.filter((call) => call.method === 'POST').length, 0);
  assert.equal(sockets.length, 2);
  assert.ok(sockets.some((socket) => socket.url.includes('terminalId=term-root')));
  assert.ok(sockets.some((socket) => socket.url.includes('terminalId=term-src')));

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
