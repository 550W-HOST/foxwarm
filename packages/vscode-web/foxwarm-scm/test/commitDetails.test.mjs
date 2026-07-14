import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Module from 'node:module';
import * as esbuild from 'esbuild';

class MockUri {
  constructor(scheme, authority, path, query = '') { this.scheme = scheme; this.authority = authority; this.path = path; this.query = query; }
  static from(value) { return new MockUri(value.scheme, value.authority || '', value.path || '', value.query || ''); }
  toString() { return `${this.scheme}://${this.authority}${this.path}${this.query ? `?${this.query}` : ''}`; }
}

const executedCommands = [];
const postedMessages = [];
let panelMessageHandler;
let panelCreateCount = 0;
let panelRevealCount = 0;
const panel = {
  reveal() { panelRevealCount += 1; },
  onDidDispose() { return { dispose() {} }; },
  webview: {
    cspSource: 'vscode-webview:',
    _html: '',
    get html() { return this._html; },
    set html(value) { this._html = value; if (panelMessageHandler) void panelMessageHandler({ type: 'ready' }); },
    onDidReceiveMessage(handler) { panelMessageHandler = handler; return { dispose() {} }; },
    async postMessage(message) { postedMessages.push(message); return true; },
  },
};
const vscodeMock = {
  Uri: MockUri,
  ViewColumn: { Active: 1 },
  workspace: { workspaceFolders: [] },
  commands: { executeCommand: async (id, ...args) => { executedCommands.push({ id, args }); return { status: 'added' }; } },
  window: {
    createWebviewPanel: () => { panelCreateCount += 1; return panel; },
    showInformationMessage: async () => undefined,
  },
};
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'vscode') return vscodeMock;
  return originalLoad.call(this, request, parent, isMain);
};

const tempDir = await mkdtemp(path.join(tmpdir(), 'foxwarm-commit-details-test-'));
const output = path.join(tempDir, 'commitDetails.cjs');
await esbuild.build({
  entryPoints: [new URL('../src/commitDetails.ts', import.meta.url).pathname],
  outfile: output,
  bundle: true,
  format: 'cjs',
  platform: 'node',
  external: ['vscode'],
  logLevel: 'silent',
});
const { normalizeCommitOpenRequest, openCommitDetails } = createRequire(import.meta.url)(output);

const details = {
  nodeId: 'worker-1',
  workspace: '/canonical/repo',
  commit: {
    oid: 'a'.repeat(40),
    parents: ['b'.repeat(40)],
    subject: '</script><img src=x onerror=alert(1)>',
    message: 'body <script>alert(1)</script>',
    author: { name: '<b>Agent</b>', email: 'agent@example.test' },
    authoredAt: '2026-07-15T00:00:00Z',
    committedAt: '2026-07-15T00:00:01Z',
  },
  comparison: { parentOid: 'b'.repeat(40), mode: 'first-parent' },
  stats: { files: 3, additions: 2, deletions: 1, binaryFiles: 1 },
  files: [
    { status: 'R', kind: 'renamed', path: 'new.ts', oldPath: 'old.ts', oldOid: 'c'.repeat(40), newOid: 'd'.repeat(40), oldMode: '100644', newMode: '100644', additions: 2, deletions: 1, binary: false, submodule: false },
    { status: 'A', kind: 'added', path: 'added.ts', oldOid: '0'.repeat(40), newOid: 'e'.repeat(40), oldMode: '000000', newMode: '100644', additions: 1, deletions: 0, binary: false, submodule: false },
    { status: 'M', kind: 'modified', path: 'image.bin', oldOid: '1'.repeat(40), newOid: '2'.repeat(40), oldMode: '100644', newMode: '100644', binary: true, submodule: false },
  ],
};

globalThis.fetch = async () => new Response(JSON.stringify(details), { status: 200, headers: { 'Content-Type': 'application/json' } });

test('validates fixed commit requests and rejects extra command-shaped input', () => {
  assert.deepEqual(normalizeCommitOpenRequest({ kind: 'openCommit', nodeId: 'worker-1', path: '/repo/../canonical/repo', commitId: 'ABCDEF1' }), {
    kind: 'openCommit', nodeId: 'worker-1', path: '/canonical/repo', commitId: 'abcdef1',
  });
  assert.throws(() => normalizeCommitOpenRequest({ kind: 'runCommand', nodeId: 'master', path: '/repo', commitId: 'abcdef1' }), /Expected an openCommit/);
  assert.throws(() => normalizeCommitOpenRequest({ kind: 'openCommit', nodeId: '../node', path: '/repo', commitId: 'abcdef1' }), /node id/);
});

test('persists a canonical pending request before adding a missing workspace root', async () => {
  executedCommands.length = 0;
  const deferred = [];
  const result = await openCommitDetails(
    'http://example.test/api/vscode-web/git',
    { kind: 'openCommit', nodeId: 'worker-1', path: '/requested/path', commitId: 'abcdef1' },
    { deferForWorkspaceReload: async (request) => { deferred.push(request); } },
  );
  assert.equal(result.status, 'reloading');
  assert.deepEqual(deferred, [{ kind: 'openCommit', nodeId: 'worker-1', path: '/canonical/repo', commitId: 'a'.repeat(40) }]);
  assert.deepEqual(executedCommands, [{
    id: 'foxwarm-fs.handleOpenRequest',
    args: [{ kind: 'addFolder', nodeId: 'worker-1', path: '/canonical/repo' }],
  }]);
});

test('opens canonical workspace, renders data by postMessage, and maps file indexes to immutable refs', async () => {
  executedCommands.length = 0;
  postedMessages.length = 0;
  await openCommitDetails('http://example.test/api/vscode-web/git', { kind: 'openCommit', nodeId: 'worker-1', path: '/requested/path', commitId: 'abcdef1' });
  assert.deepEqual(executedCommands[0], {
    id: 'foxwarm-fs.handleOpenRequest',
    args: [{ kind: 'addFolder', nodeId: 'worker-1', path: '/canonical/repo' }],
  });
  assert.doesNotMatch(panel.webview.html, /<img src=x|body <script>|<b>Agent/);
  assert.match(panel.webview.html, /Content-Security-Policy/);
  const panelScript = [...panel.webview.html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].at(-1)?.[1];
  assert.ok(panelScript);
  assert.doesNotThrow(() => new Function(panelScript));
  assert.deepEqual(postedMessages[0], { type: 'details', details });

  await panelMessageHandler({ type: 'openDiff', index: 0, path: '/attacker/chosen' });
  const diff = executedCommands.find((entry) => entry.id === 'vscode.diff');
  assert.ok(diff);
  const [left, right] = diff.args;
  assert.equal(new URLSearchParams(left.query).get('path'), 'old.ts');
  assert.equal(new URLSearchParams(left.query).get('ref'), 'b'.repeat(40));
  assert.equal(new URLSearchParams(right.query).get('path'), 'new.ts');
  assert.equal(new URLSearchParams(right.query).get('ref'), 'a'.repeat(40));
  assert.doesNotMatch(left.query + right.query, /attacker/);

  await panelMessageHandler({ type: 'openAll' });
  const multi = executedCommands.find((entry) => entry.id === '_workbench.openMultiDiffEditor');
  assert.ok(multi);
  assert.equal(multi.args[0].resources.length, 2);
  assert.equal(multi.args[0].resources[1].originalUri, undefined);

  await openCommitDetails('http://example.test/api/vscode-web/git', { kind: 'openCommit', nodeId: 'worker-1', path: '/requested/path', commitId: 'abcdef1' });
  assert.equal(panelCreateCount, 1);
  assert.equal(panelRevealCount, 1);
});
