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
const { getWorkspaceTerminalTarget, parseFoxwarmUri } = require('../dist/extension.js');

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
  assert.deepEqual(parseFoxwarmUri(uri('foxwarm://node/master/app/packages')), {
    namespace: 'node',
    nodeId: 'master',
    realPath: '/app/packages',
  });
});

test('derives terminal target from first workspace folder', () => {
  const target = getWorkspaceTerminalTarget([{ uri: uri('foxwarm://node/master/tmp/hello%20world') }]);
  assert.equal(target.nodeId, 'master');
  assert.equal(target.realPath, '/tmp/hello world');
});

test('defaults to master root when no workspace folder exists', () => {
  assert.deepEqual(getWorkspaceTerminalTarget(undefined), {
    namespace: 'node',
    nodeId: 'master',
    realPath: '/',
  });
});
