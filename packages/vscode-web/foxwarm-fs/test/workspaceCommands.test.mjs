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
  uri: MockUri.parse('foxwarm://node+master/remote/project'),
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
  configFiles: {
    app: { nodeId: 'master', path: '/var/lib/foxwarm/state/config.yaml' },
    models: { nodeId: 'master', path: '/var/lib/foxwarm/state/models.yaml' },
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
    updateWorkspaceFolders: (start, deleteCount, ...folders) => {
      const folder = folders[0];
      updates.push({ start, deleteCount, folder });
      if (!updateAccepted) return false;
      const added = folders.map(folder => ({ name: folder.name || folder.uri.path.split('/').at(-1), uri: folder.uri }));
      workspaceFolders.splice(start, deleteCount, ...added);
      for (const listener of [...folderListeners]) listener({ added, removed: [] });
      return true;
    },
    fs: { stat: async () => {
      if (statError) throw statError;
      return { type: statType, ctime: 0, mtime: 0, size: 0 };
    } },
    textDocuments: [],
  },
  extensions: { getExtension: () => undefined },
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

test('app/data commands add master roots, reveal, and deduplicate repeats', async () => {
  const executedBefore = executed.length;
  const appResult = await commands.get('foxwarm-fs.openAppFolder')();
  assert.deepEqual(appResult, { status: 'added', uri: 'foxwarm://node+master/srv/foxwarm' });
  assert.equal(workspaceFolders[0].uri.authority, 'node+master');
  assert.deepEqual({ name: workspaceFolders[1].name, uri: workspaceFolders[1].uri.toString() }, {
    name: 'Foxwarm App',
    uri: 'foxwarm://node+master/srv/foxwarm',
  });
  assert.deepEqual(executed.slice(executedBefore).map((entry) => entry.id), ['revealInExplorer']);
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
    { name: 'Before', uri: MockUri.parse('foxwarm://node+master/before') },
    { name: 'foxwarm', uri: MockUri.parse('foxwarm://node+master/srv/foxwarm') },
    { name: 'After', uri: MockUri.parse('foxwarm://node+worker-2/after') },
  ];
  statType = 2;
  statError = undefined;
  updateAccepted = true;
  const updatesBefore = updates.length;
  await commands.get('foxwarm-fs.openAppFolder')();
  assert.deepEqual(workspaceFolders.map((folder) => folder.name), ['Before', 'Foxwarm App', 'After']);
  assert.equal(workspaceFolders[1].uri.toString(), 'foxwarm://node+master/srv/foxwarm');
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

test('authoritative master roots preserve spaces and Unicode and merge nested roots', async () => {
  rootsPayload = {
    version: 1,
    roots: {
      app: { nodeId: 'master', path: '/srv/Fox warm/研发' },
      data: { nodeId: 'master', path: '/var/lib/foxwarm' },
    },
  };
  workspaceFolders = [
    { name: 'Other', uri: MockUri.parse('foxwarm://node+master/other') },
    { name: 'Nested', uri: MockUri.parse('foxwarm://node+master/srv/Fox%20warm/%E7%A0%94%E5%8F%91/nested') },
  ];
  await commands.get('foxwarm-fs.openAppFolder')();
  assert.equal(workspaceFolders.length, 2);
  assert.equal(workspaceFolders.at(-1).name, 'Foxwarm App');
  assert.equal(workspaceFolders.at(-1).uri.toString(), 'foxwarm://node+master/srv/Fox%20warm/%E7%A0%94%E5%8F%91');
});

test('folder requests reveal covered descendants and merge only contained same-Node roots', async () => {
  workspaceFolders = [
    { name: 'Project', uri: MockUri.parse('foxwarm://node+remote/project/src') },
    { name: 'Tests', uri: MockUri.parse('foxwarm://node+remote/project/tests') },
    { name: 'Other', uri: MockUri.parse('foxwarm://node+remote/project-other') },
    { name: 'Master', uri: MockUri.parse('foxwarm://node+master/project/src') },
  ];
  const request = commands.get('foxwarm-fs.handleOpenRequest');
  await request({ kind: 'addFolder', nodeId: 'remote', path: '/project' });
  assert.deepEqual(workspaceFolders.map(folder => folder.uri.toString()), [
    'foxwarm://node+remote/project', 'foxwarm://node+remote/project-other', 'foxwarm://node+master/project/src',
  ]);
  const count = updates.length;
  assert.equal((await request({ kind: 'addFolder', nodeId: 'remote', path: '/project/src/nested' })).status, 'existing');
  assert.equal(updates.length, count);
  assert.equal(executed.at(-1).args[0].toString(), 'foxwarm://node+remote/project/src/nested');
});

test('file requests add a containing cwd or parent, then open and focus Explorer for both Nodes', async () => {
  const request = commands.get('foxwarm-fs.handleOpenRequest');
  statType = 1;
  vscodeMock.workspace.openTextDocument = async uri => ({ uri, lineCount: 1 });
  workspaceFolders = [{ name: 'Existing', uri: MockUri.parse('foxwarm://node+remote/existing') }];
  await request({ kind: 'openFile', nodeId: 'remote', path: '/outside/src/file.txt', cwd: '/outside' });
  assert(workspaceFolders.some(folder => folder.uri.toString() === 'foxwarm://node+remote/outside'));
  assert.equal(executed.at(-1).args[0].toString(), 'foxwarm://node+remote/outside/src/file.txt');
  const count = updates.length;
  await request({ kind: 'openFile', nodeId: 'remote', path: '/outside/other.txt', cwd: '/unrelated' });
  assert.equal(updates.length, count);
  await request({ kind: 'openFile', nodeId: 'master', path: '/outside/src/master.txt', cwd: '/unrelated' });
  assert(workspaceFolders.some(folder => folder.uri.toString() === 'foxwarm://node+master/outside/src'));
  assert.equal(executed.at(-1).args[0].toString(), 'foxwarm://node+master/outside/src/master.txt');
  statType = 2;
});

test('master folder commands from a remote workbench route to master without changing remote roots', async () => {
  workspaceFolders = [{ name: 'Remote', uri: MockUri.parse('foxwarm://node+remote/project') }];
  const count = updates.length;
  await commands.get('foxwarm-fs.openDataFolder')();
  assert.equal(updates.length, count);
  assert.equal(executed.at(-1).id, 'foxwarm.routeCodeRequest');
  assert.deepEqual(executed.at(-1).args[0], { kind: 'openManagedRoot', nodeId: 'master', path: '/var/lib/foxwarm', root: 'data' });
});

test('early commands wait for saved roots instead of treating the startup snapshot as an empty workspace', async () => {
  workspaceFolders = [];
  vscodeMock.workspace.workspaceFile = MockUri.parse('foxwarm://node+master/state/node-remote.code-workspace');
  vscodeMock.workspace.fs.readFile = async () => new TextEncoder().encode('{"folders":[{"uri":"foxwarm://node+remote/project"}]}');
  const count = updates.length;
  const pending = commands.get('foxwarm-fs.handleOpenRequest')({ kind: 'addFolder', nodeId: 'remote', path: '/project/src' });
  setTimeout(() => { workspaceFolders = [{ name: 'Project', uri: MockUri.parse('foxwarm://node+remote/project') }]; }, 10);
  assert.equal((await pending).status, 'existing');
  assert.equal(updates.length, count);
  assert.equal(workspaceFolders[0].uri.toString(), 'foxwarm://node+remote/project');
  workspaceFolders = [];
  vscodeMock.workspace.fs.readFile = async () => new TextEncoder().encode('{"folders":[]}');
  await commands.get('foxwarm-fs.handleOpenRequest')({ kind: 'addFolder', nodeId: 'remote', path: '/new' });
  assert.equal(workspaceFolders[0].uri.toString(), 'foxwarm://node+remote/new');
  delete vscodeMock.workspace.workspaceFile;
});

test('explicit file display waits for remembered editor restoration and never retries a rejected display', async () => {
  workspaceFolders = [{ uri: MockUri.parse('foxwarm://node+master/remote/project') }];
  statType = 1;
  statError = undefined;
  const uri = MockUri.parse('foxwarm://node+master/remote/project/notes.txt');
  const document = { uri, lineCount: 1 };
  const documentRead = Promise.withResolvers(), restored = Promise.withResolvers();
  const originalExecute = vscodeMock.commands.executeCommand;
  const originalOpen = vscodeMock.workspace.openTextDocument;
  const originalShow = vscodeMock.window.showTextDocument;
  const calls = [];
  vscodeMock.workspace.textDocuments = [];
  vscodeMock.workspace.openTextDocument = async () => { documentRead.resolve(); return document; };
  vscodeMock.commands.executeCommand = async id => {
    calls.push(id);
    if (id === 'foxwarm-webui.waitForEditorRestore') await restored.promise;
  };
  vscodeMock.window.showTextDocument = async value => { assert.equal(value, document); calls.push('show'); };
  const request = { kind: 'openFile', nodeId: 'master', path: '/remote/project/notes.txt' };
  try {
    const pending = commands.get('foxwarm-fs.handleOpenRequest')(request);
    await documentRead.promise;
    await Promise.resolve();
    assert.deepEqual(calls, ['foxwarm-webui.waitForEditorRestore']);
    restored.resolve();
    assert.equal((await pending).status, 'opened');
    assert.deepEqual(calls, ['foxwarm-webui.waitForEditorRestore', 'show', 'revealInExplorer']);

    calls.length = 0;
    const failure = new Error('editor rejected the input');
    vscodeMock.window.showTextDocument = async () => { calls.push('show'); throw failure; };
    await assert.rejects(commands.get('foxwarm-fs.handleOpenRequest')(request), error => error === failure);
    assert.deepEqual(calls, ['foxwarm-webui.waitForEditorRestore', 'show']);
  } finally {
    restored.resolve();
    vscodeMock.commands.executeCommand = originalExecute;
    vscodeMock.workspace.openTextDocument = originalOpen;
    vscodeMock.window.showTextDocument = originalShow;
  }
});
