import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import Module from 'node:module';

class EventEmitter {
  constructor() {
    this.event = () => undefined;
  }
  fire() {}
  dispose() {}
}

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'vscode') {
    return {
      EventEmitter,
      workspace: { workspaceFolders: undefined },
      window: { registerTerminalProfileProvider: () => ({ dispose() {} }), createTerminal: () => ({ show() {} }) },
      commands: { registerCommand: () => ({ dispose() {} }) },
      TerminalProfile: class TerminalProfile { constructor(options) { this.options = options; } },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const require = createRequire(import.meta.url);
const { getWorkspaceTerminalTarget, isTerminalInsideWorkspace, parseFoxwarmUri, shouldKillBackendTerminal } = require('../dist/extension.js');

function uri(value) {
  const parsed = new URL(value);
  return {
    scheme: parsed.protocol.slice(0, -1),
    authority: parsed.host,
    path: parsed.pathname,
    toString: () => value,
  };
}

test('parses foxwarm workspace URI into terminal target', () => {
  assert.deepEqual(parseFoxwarmUri(uri('foxwarm://node+master/app/packages')), {
    namespace: 'node',
    nodeId: 'master',
    realPath: '/app/packages',
  });
});

test('derives terminal target from first workspace folder', () => {
  const target = getWorkspaceTerminalTarget([{ uri: uri('foxwarm://node+master/tmp/hello%20world') }]);
  assert.equal(target.nodeId, 'master');
  assert.equal(target.realPath, '/tmp/hello world');
});

test('supports legacy workspace URI shape', () => {
  const target = getWorkspaceTerminalTarget([{ uri: uri('foxwarm://node/master/app') }]);
  assert.equal(target.nodeId, 'master');
  assert.equal(target.realPath, '/app');
});

test('defaults to master root when no workspace folder exists', () => {
  assert.deepEqual(getWorkspaceTerminalTarget(undefined), {
    namespace: 'node',
    nodeId: 'master',
    realPath: '/',
  });
});

test('restores only terminals on the workspace node and inside its path boundary', () => {
  const workspace = { nodeId: 'master', realPath: '/app' };
  assert.equal(isTerminalInsideWorkspace({ id: 'one', nodeId: 'master', cwd: '/app' }, workspace), true);
  assert.equal(isTerminalInsideWorkspace({ id: 'two', nodeId: 'master', cwd: '/app/src' }, workspace), true);
  assert.equal(isTerminalInsideWorkspace({ id: 'three', nodeId: 'master', cwd: '/application' }, workspace), false);
  assert.equal(isTerminalInsideWorkspace({ id: 'four', nodeId: 'worker', cwd: '/app' }, workspace), false);
});

test('kills backend terminals only for explicit user close reasons', () => {
  assert.equal(shouldKillBackendTerminal(3), true);
  assert.equal(shouldKillBackendTerminal(1), false);
  assert.equal(shouldKillBackendTerminal(2), false);
  assert.equal(shouldKillBackendTerminal(4), false);
  assert.equal(shouldKillBackendTerminal(undefined), false);
});
