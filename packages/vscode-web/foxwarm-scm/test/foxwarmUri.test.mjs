import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import Module from 'node:module';

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'vscode') {
    return {
      Uri: {
        parse: (value) => value,
        from: (value) => value,
      },
      workspace: {
        workspaceFolders: undefined,
        registerTextDocumentContentProvider: () => ({ dispose() {} }),
        onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
      },
      commands: { registerCommand: () => ({ dispose() {} }), executeCommand: () => undefined },
      scm: { createSourceControl: () => ({ createResourceGroup: () => ({ resourceStates: [] }), inputBox: {}, dispose() {} }) },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const require = createRequire(import.meta.url);
const { buildFoxwarmNodeUriString, normalizeGitRelativePath, parseFoxwarmUri } = require('../dist/extension.js');

function uri(input) {
  const parsed = new URL(input);
  return {
    scheme: parsed.protocol.slice(0, -1),
    authority: parsed.host,
    path: parsed.pathname,
    toString: () => input,
  };
}

test('parses preferred foxwarm node URI shape', () => {
  assert.deepEqual(parseFoxwarmUri(uri('foxwarm://node+master/app/src/index.ts')), {
    namespace: 'node',
    nodeId: 'master',
    realPath: '/app/src/index.ts',
  });
});

test('builds preferred foxwarm node URI shape', () => {
  assert.equal(buildFoxwarmNodeUriString('master', '/app/hello world.txt'), 'foxwarm://node+master/app/hello%20world.txt');
});

test('normalizes git relative paths and rejects traversal', () => {
  assert.equal(normalizeGitRelativePath('/src/index.ts'), 'src/index.ts');
  assert.throws(() => normalizeGitRelativePath('../secret'), /must not contain/);
  assert.throws(() => normalizeGitRelativePath('src/../index.ts'), /must not contain/);
});
