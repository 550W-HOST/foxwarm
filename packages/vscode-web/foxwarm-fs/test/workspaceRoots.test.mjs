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
const {
  isExactWorkspaceRoot,
  normalizeConfigFilesResponse,
  normalizeWorkspaceRootsResponse,
} = require('../dist/extension.js');

function uri(input) {
  const parsed = new URL(input);
  return {
    scheme: parsed.protocol.slice(0, -1),
    authority: parsed.host,
    path: parsed.pathname,
    toString: () => input,
  };
}

test('normalizes fixed master app/data roots and assigns stable display names', () => {
  assert.deepEqual(normalizeWorkspaceRootsResponse({
    version: 1,
    roots: {
      app: { nodeId: 'master', path: '/srv/foxwarm/./' },
      data: { nodeId: 'master', path: '/var/lib/foxwarm/data/../data' },
    },
  }), {
    app: { kind: 'app', nodeId: 'master', path: '/srv/foxwarm', name: 'Foxwarm App' },
    data: { kind: 'data', nodeId: 'master', path: '/var/lib/foxwarm/data', name: 'Foxwarm Data' },
  });
});

test('same app/data path has one deterministic combined workspace name', () => {
  const roots = normalizeWorkspaceRootsResponse({
    version: 1,
    roots: {
      app: { nodeId: 'master', path: '/srv/foxwarm' },
      data: { nodeId: 'master', path: '/srv/foxwarm/' },
    },
  });
  assert.equal(roots.app.path, roots.data.path);
  assert.equal(roots.app.name, 'Foxwarm App & Data');
  assert.equal(roots.data.name, 'Foxwarm App & Data');
});

test('normalizes authoritative master config files and rejects remote or relative descriptors', () => {
  assert.deepEqual(normalizeConfigFilesResponse({
    version: 1,
    configFiles: {
      app: { nodeId: 'master', path: '/data/state/./config.yaml' },
      models: { nodeId: 'master', path: '/data/state/models.yaml' },
    },
  }), {
    app: { kind: 'app', nodeId: 'master', path: '/data/state/config.yaml' },
    models: { kind: 'models', nodeId: 'master', path: '/data/state/models.yaml' },
  });
  assert.throws(() => normalizeConfigFilesResponse({
    version: 1,
    configFiles: {
      app: { nodeId: 'worker-1', path: '/data/state/config.yaml' },
      models: { nodeId: 'master', path: '/data/state/models.yaml' },
    },
  }), /must use the master node/);
  assert.throws(() => normalizeConfigFilesResponse({
    version: 1,
    configFiles: {
      app: { nodeId: 'master', path: 'config.yaml' },
      models: { nodeId: 'master', path: '/data/state/models.yaml' },
    },
  }), /absolute POSIX/);
});

test('rejects remote, relative, and malformed workspace-root responses', () => {
  assert.throws(() => normalizeWorkspaceRootsResponse({ version: 2, roots: {} }), /Unsupported/);
  assert.throws(() => normalizeWorkspaceRootsResponse({
    version: 1,
    roots: {
      app: { nodeId: 'worker-1', path: '/srv/foxwarm' },
      data: { nodeId: 'master', path: '/data' },
    },
  }), /must use the master node/);
  assert.throws(() => normalizeWorkspaceRootsResponse({
    version: 1,
    roots: {
      app: { nodeId: 'master', path: 'relative' },
      data: { nodeId: 'master', path: '/data' },
    },
  }), /absolute POSIX/);
});

test('exact URI comparison normalizes paths, reads legacy URIs, and does not collapse nested roots', () => {
  const target = { nodeId: 'master', path: '/srv/foxwarm' };
  assert.equal(isExactWorkspaceRoot(uri('foxwarm://node+master/srv/foxwarm/./'), target), true);
  assert.equal(isExactWorkspaceRoot(uri('foxwarm://node/master/srv/foxwarm'), target), true);
  assert.equal(isExactWorkspaceRoot(uri('foxwarm://node+master/srv/foxwarm/data'), target), false);
  assert.equal(isExactWorkspaceRoot(uri('foxwarm://node+worker-1/srv/foxwarm'), target), false);
  assert.equal(isExactWorkspaceRoot(uri('file:///srv/foxwarm'), target), false);
});
