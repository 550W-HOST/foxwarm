import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import Module from 'node:module';

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'vscode') return {};
  return originalLoad.call(this, request, parent, isMain);
};

const require = createRequire(import.meta.url);
const { normalizeFoxwarmOpenRequest } = require('../dist/extension.js');

test('normalizes master folder requests and dot segments', () => {
  assert.deepEqual(normalizeFoxwarmOpenRequest({
    kind: 'addFolder',
    nodeId: 'master',
    path: '/app/./packages/../src/',
  }), {
    kind: 'addFolder',
    nodeId: 'master',
    path: '/app/src',
  });
});

test('normalizes file requests with one-based line ranges', () => {
  assert.deepEqual(normalizeFoxwarmOpenRequest({
    kind: 'openFile',
    nodeId: 'master',
    path: '/app/src/index.ts',
    startLine: 4,
    startColumn: 3,
    endLine: 8,
  }), {
    kind: 'openFile',
    nodeId: 'master',
    path: '/app/src/index.ts',
    startLine: 4,
    startColumn: 3,
    endLine: 8,
  });
});

test('accepts remote nodes and rejects invalid nodes, relative paths, and invalid ranges', () => {
  assert.deepEqual(normalizeFoxwarmOpenRequest({ kind: 'addFolder', nodeId: 'worker-1', path: '/app' }), { kind: 'addFolder', nodeId: 'worker-1', path: '/app' });
  assert.throws(() => normalizeFoxwarmOpenRequest({ kind: 'addFolder', nodeId: '../worker', path: '/app' }), /node id is invalid/);
  assert.throws(() => normalizeFoxwarmOpenRequest({ kind: 'addFolder', nodeId: 'master', path: 'app' }), /absolute POSIX/);
  assert.throws(() => normalizeFoxwarmOpenRequest({ kind: 'openFile', nodeId: 'master', path: '/app/a', startLine: 5, endLine: 2 }), /must not be before/);
  assert.throws(() => normalizeFoxwarmOpenRequest({ kind: 'openFile', nodeId: 'master', path: '/app/a', startColumn: 2 }), /requires startLine/);
});