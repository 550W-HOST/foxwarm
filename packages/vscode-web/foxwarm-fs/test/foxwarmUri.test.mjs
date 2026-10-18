import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import Module from 'node:module';

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'vscode') {
    return {};
  }
  return originalLoad.call(this, request, parent, isMain);
};

const require = createRequire(import.meta.url);
const { buildFoxwarmNodeUriString, parseFoxwarmUri } = require('../dist/extension.js');

function uri(input) {
  const parsed = new URL(input);
  return {
    scheme: parsed.protocol.slice(0, -1),
    authority: parsed.host,
    path: parsed.pathname,
    toString: () => input,
  };
}

test('parses foxwarm node URI into node id and absolute real path', () => {
  assert.deepEqual(parseFoxwarmUri(uri('foxwarm://node+master/srv/foxwarm/')), {
    namespace: 'node',
    nodeId: 'master',
    realPath: '/srv/foxwarm',
  });
});

test('preserves namespace layer and supports encoded path segments', () => {
  assert.deepEqual(parseFoxwarmUri(uri('foxwarm://node+master/tmp/hello%20world.txt')), {
    namespace: 'node',
    nodeId: 'master',
    realPath: '/tmp/hello world.txt',
  });
});

test('builds foxwarm node URI strings from absolute paths', () => {
  assert.equal(buildFoxwarmNodeUriString('master', '/tmp/hello world.txt'), 'foxwarm://node+master/tmp/hello%20world.txt');
});

test('parses legacy node path URI shape for existing links', () => {
  assert.deepEqual(parseFoxwarmUri(uri('foxwarm://node/master/app')), {
    namespace: 'node',
    nodeId: 'master',
    realPath: '/app',
  });
});

test('rejects non-node namespaces', () => {
  assert.throws(() => parseFoxwarmUri(uri('foxwarm://repo/example/path')), /authority/);
});

test('qualified Provider IDs stay one encoded authority and preserve the target path', () => {
  const encoded = buildFoxwarmNodeUriString('development/worker:one', '/workspace/file.txt');
  assert.deepEqual(parseFoxwarmUri(uri(encoded)), {
    namespace: 'node', nodeId: 'development/worker:one', realPath: '/workspace/file.txt',
  });
});

test('legacy native leading characters survive Code URI generation', () => {
  for (const nodeId of ['_native-review', '-legacy-native']) {
    const encoded = buildFoxwarmNodeUriString(nodeId, '/workspace/file.txt');
    assert.deepEqual(parseFoxwarmUri(uri(encoded)), {
      namespace: 'node', nodeId, realPath: '/workspace/file.txt',
    });
  }
});
