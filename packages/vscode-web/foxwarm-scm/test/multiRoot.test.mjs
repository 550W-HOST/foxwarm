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
  static parse(value) {
    const parsed = new URL(value);
    return new MockUri(parsed.protocol.slice(0, -1), parsed.host, parsed.pathname, parsed.search.slice(1), parsed.hash.slice(1));
  }
  static from(value) {
    return new MockUri(value.scheme, value.authority || '', value.path || '', value.query || '', value.fragment || '');
  }
  toString() {
    return `${this.scheme}://${this.authority}${this.path}${this.query ? `?${this.query}` : ''}${this.fragment ? `#${this.fragment}` : ''}`;
  }
}

const commands = new Map();
const executedCommands = [];
const sourceControls = [];
let contentProvider;
const disposable = () => ({ dispose() {} });

const workspaceFolders = ['/repo', '/repo/sub', '/repo2'].map((realPath) => ({
  uri: MockUri.parse(`foxwarm://node+master${realPath}`),
}));

const vscodeMock = {
  Uri: MockUri,
  workspace: {
    workspaceFolders,
    registerTextDocumentContentProvider: (_scheme, provider) => { contentProvider = provider; return disposable(); },
    onDidChangeWorkspaceFolders: () => disposable(),
  },
  scm: {
    createSourceControl: (id, label, rootUri) => {
      const sourceControl = {
        id,
        label,
        rootUri,
        inputBox: {},
        count: 0,
        disposed: false,
        createResourceGroup: (groupId, groupLabel) => ({ id: groupId, label: groupLabel, resourceStates: [] }),
        dispose() { this.disposed = true; },
      };
      sourceControls.push(sourceControl);
      return sourceControl;
    },
  },
  commands: {
    registerCommand: (id, handler) => { commands.set(id, handler); return disposable(); },
    executeCommand: async (id, ...args) => { executedCommands.push({ id, args }); },
  },
  window: {
    showQuickPick: async () => undefined,
    showInformationMessage: async () => undefined,
  },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'vscode') return vscodeMock;
  return originalLoad.call(this, request, parent, isMain);
};

const statusRequests = [];
globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  if (!url.pathname.endsWith('/status')) throw new Error(`Unexpected fetch ${url}`);
  const workspace = url.searchParams.get('workspace');
  statusRequests.push(workspace);
  if (workspace === '/repo/sub') {
    return new Response(JSON.stringify({
      nodeId: 'master',
      workspace: '/repo',
      topLevel: '/repo',
      changes: [
        { path: 'src/a.ts', indexStatus: '.', workingTreeStatus: 'M', kind: 'modified' },
        {
          path: 'vendor/sub', indexStatus: '.', workingTreeStatus: 'M', kind: 'modified', submoduleState: 'SC..',
          submodule: { headOid: '1111111111111111111111111111111111111111', indexOid: '1111111111111111111111111111111111111111', worktreeOid: '2222222222222222222222222222222222222222', dirty: false },
        },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (workspace === '/repo2') {
    return new Response(JSON.stringify({
      nodeId: 'master', workspace: '/repo2', topLevel: '/repo2',
      changes: [{ path: 'gone.txt', indexStatus: '.', workingTreeStatus: 'D', kind: 'deleted' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  throw new Error(`Duplicate or unexpected status scan for ${workspace}`);
};

const require = createRequire(import.meta.url);
const extension = require('../dist/extension.js');

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for extension refresh');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('scans every workspace root, deduplicates Git top levels, and opens one multi-diff editor', async () => {
  const context = {
    extensionUri: MockUri.parse('http://example.test/proxy/vscode-web/extensions/foxwarm-scm'),
    subscriptions: [],
  };
  extension.activate(context);
  await waitFor(() => sourceControls.length === 2);

  assert.deepEqual(statusRequests, ['/repo/sub', '/repo2']);
  assert.deepEqual(sourceControls.map((sourceControl) => sourceControl.rootUri.path).sort(), ['/repo', '/repo2']);

  const repoSourceControl = sourceControls.find((sourceControl) => sourceControl.rootUri.path === '/repo');
  assert.ok(repoSourceControl);
  await commands.get('foxwarm-scm.openAllChanges')(repoSourceControl);

  const open = executedCommands.find((entry) => entry.id === '_workbench.openMultiDiffEditor');
  assert.ok(open);
  const options = open.args[0];
  assert.equal(options.title, 'Changes in repo');
  assert.equal(options.resources.length, 2);
  assert.ok(options.resources.every((resource) => resource.originalUri && resource.modifiedUri));

  const submoduleResource = options.resources.find((resource) => resource.modifiedUri.path.endsWith('/vendor/sub'));
  assert.ok(submoduleResource);
  assert.equal(await contentProvider.provideTextDocumentContent(submoduleResource.originalUri), 'Subproject commit 1111111111111111111111111111111111111111\n');
  assert.equal(await contentProvider.provideTextDocumentContent(submoduleResource.modifiedUri), 'Subproject commit 2222222222222222222222222222222222222222\n');
});
