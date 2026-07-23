import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import Module from 'node:module';

class MockUri {
  constructor(scheme, authority, path) {
    this.scheme = scheme;
    this.authority = authority;
    this.path = path;
  }
  static parse(value) {
    const parsed = new URL(value);
    return new MockUri(parsed.protocol.slice(0, -1), parsed.host, parsed.pathname);
  }
  toString() {
    return `${this.scheme}://${this.authority}${this.path}`;
  }
}

class MockEventEmitter {
  constructor() {
    this.event = () => ({ dispose() {} });
  }
  fire() {}
  dispose() {}
}

const commands = new Map();
const executed = [];
const updates = [];
const folderListeners = new Set();
let workspaceFolders = [{
  name: 'Remote Project',
  uri: MockUri.parse('foxwarm://node+worker-1/remote/project'),
}];
let updateAccepted = true;
let statType = 2;
let statError;
let rootsPayload = {
  version: 1,
  roots: {
    app: { nodeId: 'master', path: '/srv/foxwarm' },
    data: { nodeId: 'master', path: '/var/lib/foxwarm' },
  },
};

const vscodeMock = {
  Uri: MockUri,
  EventEmitter: MockEventEmitter,
  Disposable: class { constructor(fn) { this.fn = fn; } dispose() { this.fn?.(); } },
  FileType: { File: 1, Directory: 2 },
  FileChangeType: { Changed: 1, Created: 2, Deleted: 3 },
  FileSystemError: class extends Error {
    static FileNotFound() { return new Error('not found'); }
    static FileExists() { return new Error('exists'); }
    static FileNotADirectory() { return new Error('not a directory'); }
    static FileIsADirectory() { return new Error('is a directory'); }
    static NoPermissions() { return new Error('no permissions'); }
    static Unavailable() { return new Error('unavailable'); }
  },
  workspace: {
    get workspaceFolders() { return workspaceFolders; },
    registerFileSystemProvider: () => ({ dispose() {} }),
    onDidChangeWorkspaceFolders: (listener) => {
      folderListeners.add(listener);
      return { dispose: () => folderListeners.delete(listener) };
    },
    updateWorkspaceFolders: (start, deleteCount, folder) => {
      updates.push({ start, deleteCount, folder });
      if (!updateAccepted) return false;
      const added = { name: folder.name || folder.uri.path.split('/').at(-1), uri: folder.uri };
      workspaceFolders.splice(start, deleteCount, added);
      for (const listener of [...folderListeners]) listener({ added: [added], removed: [] });
      return true;
    },
    fs: { stat: async () => {
      if (statError) throw statError;
      return { type: statType, ctime: 0, mtime: 0, size: 0 };
    } },
    textDocuments: [],
  },
  commands: {
    registerCommand: (id, handler) => { commands.set(id, handler); return { dispose() {} }; },
    executeCommand: async (id, ...args) => { executed.push({ id, args }); },
  },
  window: {
    showInputBox: async () => undefined,
    showTextDocument: async () => undefined,
    showWarningMessage: async () => undefined,
  },
  Position: class {},
  Range: class {},
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'vscode') return vscodeMock;
  return originalLoad.call(this, request, parent, isMain);
};

const fetches = [];
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  fetches.push({ url, init });
  if (!url.pathname.endsWith('/api/vscode-web/fs/workspace-roots')) throw new Error(`Unexpected fetch ${url}`);
  return new Response(JSON.stringify(rootsPayload), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

const require = createRequire(import.meta.url);
const extension = require('../dist/extension.js');
extension.activate({
  extensionUri: MockUri.parse('https://example.test/proxy/vscode-web/extensions/foxwarm-fs'),
  subscriptions: [],
});

test('app/data commands always add master roots, preserve a remote current folder, reveal, and deduplicate repeats', async () => {
  const appResult = await commands.get('foxwarm-fs.openAppFolder')();
  assert.deepEqual(appResult, { status: 'added', uri: 'foxwarm://node+master/srv/foxwarm' });
  assert.equal(workspaceFolders[0].uri.authority, 'node+worker-1');
  assert.deepEqual({ name: workspaceFolders[1].name, uri: workspaceFolders[1].uri.toString() }, {
    name: 'Foxwarm App',
    uri: 'foxwarm://node+master/srv/foxwarm',
  });
  assert.deepEqual(executed.slice(-2).map((entry) => entry.id), ['workbench.view.explorer', 'revealInExplorer']);
  assert.equal(executed.at(-1).args[0].toString(), 'foxwarm://node+master/srv/foxwarm');
  assert.equal(fetches.at(-1).init.credentials, 'include');

  const updatesAfterFirst = updates.length;
  const existingResult = await commands.get('foxwarm-fs.openAppFolder')();
  assert.equal(existingResult.status, 'existing');
  assert.equal(updates.length, updatesAfterFirst);
  assert.equal(workspaceFolders.filter((folder) => folder.uri.toString() === 'foxwarm://node+master/srv/foxwarm').length, 1);

  await commands.get('foxwarm-fs.openDataFolder')();
  assert.deepEqual({ name: workspaceFolders.at(-1).name, uri: workspaceFolders.at(-1).uri.toString() }, {
    name: 'Foxwarm Data',
    uri: 'foxwarm://node+master/var/lib/foxwarm',
  });
});

test('commands support an empty workspace and report missing/non-directory/update errors', async () => {
  workspaceFolders = [];
  updateAccepted = true;
  statType = 2;
  statError = undefined;
  await commands.get('foxwarm-fs.openAppFolder')();
  assert.equal(workspaceFolders.length, 1);

  workspaceFolders = [];
  statError = new Error('master path is missing');
  await assert.rejects(commands.get('foxwarm-fs.openDataFolder')(), /master path is missing/);

  workspaceFolders = [];
  statError = undefined;
  statType = 1;
  await assert.rejects(commands.get('foxwarm-fs.openDataFolder')(), /is not a directory/);

  workspaceFolders = [];
  statType = 2;
  updateAccepted = false;
  await assert.rejects(commands.get('foxwarm-fs.openDataFolder')(), /Could not update/);
  updateAccepted = true;
});

test('same app/data path creates and reuses one clearly named workspace root', async () => {
  rootsPayload = {
    version: 1,
    roots: {
      app: { nodeId: 'master', path: '/srv/shared' },
      data: { nodeId: 'master', path: '/srv/shared/' },
    },
  };
  workspaceFolders = [];
  statError = undefined;
  statType = 2;
  const updatesBefore = updates.length;
  await commands.get('foxwarm-fs.openAppFolder')();
  await commands.get('foxwarm-fs.openDataFolder')();
  assert.equal(updates.length, updatesBefore + 1);
  assert.deepEqual(workspaceFolders.map((folder) => ({ name: folder.name, uri: folder.uri.toString() })), [{
    name: 'Foxwarm App & Data',
    uri: 'foxwarm://node+master/srv/shared',
  }]);
});

test('preexisting legacy exact root is relabeled in place without reordering or duplication', async () => {
  rootsPayload = {
    version: 1,
    roots: {
      app: { nodeId: 'master', path: '/srv/foxwarm' },
      data: { nodeId: 'master', path: '/var/lib/foxwarm' },
    },
  };
  workspaceFolders = [
    { name: 'Before', uri: MockUri.parse('foxwarm://node+worker-1/before') },
    { name: 'foxwarm', uri: MockUri.parse('foxwarm://node/master/srv/foxwarm') },
    { name: 'After', uri: MockUri.parse('foxwarm://node+worker-2/after') },
  ];
  statType = 2;
  statError = undefined;
  updateAccepted = true;
  const updatesBefore = updates.length;
  await commands.get('foxwarm-fs.openAppFolder')();
  assert.deepEqual(workspaceFolders.map((folder) => folder.name), ['Before', 'Foxwarm App', 'After']);
  assert.equal(workspaceFolders[1].uri.toString(), 'foxwarm://node/master/srv/foxwarm');
  assert.equal(updates.length, updatesBefore + 1);
  const repeatedAt = updates.length;
  await commands.get('foxwarm-fs.openAppFolder')();
  assert.equal(updates.length, repeatedAt);
});

test('same app/data path is order-independent when Data runs before App', async () => {
  rootsPayload = {
    version: 1,
    roots: {
      app: { nodeId: 'master', path: '/srv/shared-reverse' },
      data: { nodeId: 'master', path: '/srv/shared-reverse' },
    },
  };
  workspaceFolders = [];
  await commands.get('foxwarm-fs.openDataFolder')();
  await commands.get('foxwarm-fs.openAppFolder')();
  assert.deepEqual(workspaceFolders.map((folder) => folder.name), ['Foxwarm App & Data']);
});

test('authoritative master roots preserve spaces and Unicode without matching nested roots', async () => {
  rootsPayload = {
    version: 1,
    roots: {
      app: { nodeId: 'master', path: '/srv/Fox warm/研发' },
      data: { nodeId: 'master', path: '/var/lib/foxwarm' },
    },
  };
  workspaceFolders = [
    { name: 'Remote', uri: MockUri.parse('foxwarm://node+worker-1/srv/Fox%20warm/%E7%A0%94%E5%8F%91') },
    { name: 'Nested', uri: MockUri.parse('foxwarm://node+master/srv/Fox%20warm/%E7%A0%94%E5%8F%91/nested') },
  ];
  await commands.get('foxwarm-fs.openAppFolder')();
  assert.equal(workspaceFolders.length, 3);
  assert.equal(workspaceFolders.at(-1).name, 'Foxwarm App');
  assert.equal(workspaceFolders.at(-1).uri.toString(), 'foxwarm://node+master/srv/Fox%20warm/%E7%A0%94%E5%8F%91');
});
