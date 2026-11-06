import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// Bundle only this provider in memory: no extension activation or running host.
const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/provider.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
  external: ['vscode'],
});

class FileSystemError extends Error {
  constructor(message) {
    super(String(message));
    this.code = 'Unknown';
  }
}
for (const code of ['FileNotFound', 'FileExists', 'FileNotADirectory', 'FileIsADirectory', 'NoPermissions', 'Unavailable']) {
  FileSystemError[code] = (detail) => Object.assign(new FileSystemError(detail), { code });
}

let response;
const requests = [];
const module = { exports: {} };
vm.runInNewContext(bundle.outputFiles[0].text, {
  module,
  exports: module.exports,
  URLSearchParams,
  require: (name) => {
    assert.equal(name, 'vscode');
    return {
      FileSystemError,
      EventEmitter: class { event = () => {}; },
    };
  },
  fetch: async (url, init) => {
    requests.push({ url, init });
    return response;
  },
});
const { FoxwarmFileSystemProvider } = module.exports;
const provider = new FoxwarmFileSystemProvider('https://example.test/proxy/api/vscode-web/fs');
const uri = {
  scheme: 'foxwarm',
  authority: 'node+master',
  path: '/Users/test/SOUL.md',
  toString: () => 'foxwarm://node+master/Users/test/SOUL.md',
};

for (const [status, code, error] of [
  [503, 'Unavailable', 'Code filesystem services require a supported native host.'],
  [404, 'FileNotFound', 'File not found.'],
  [403, 'NoPermissions', 'Permission denied.'],
  [409, 'FileExists', 'Path already exists.'],
  [400, 'FileNotADirectory', 'Path is not a directory.'],
  [400, 'FileIsADirectory', 'Path is not a file.'],
]) {
  test(`preserves backend detail, resource URI and VS Code ${code} error code`, async () => {
    response = new Response(JSON.stringify({ code, error }), { status });
    await assert.rejects(provider.stat(uri), (failure) => {
      assert.equal(failure.code, code);
      assert.equal(failure.message, `${error}\n\n${uri.toString()}`);
      return true;
    });
    assert.equal(requests.at(-1).init.credentials, 'include');
    const requested = new URL(requests.at(-1).url);
    assert.equal(requested.searchParams.get('nodeId'), 'master');
    assert.equal(requested.searchParams.get('path'), uri.path);
  });
}

test('non-JSON errors retain status-based classification and resource URI', async () => {
  response = new Response('unavailable', { status: 503 });
  await assert.rejects(provider.readFile(uri), (failure) => {
    assert.equal(failure.code, 'Unavailable');
    assert.equal(failure.message, uri.toString());
    return true;
  });
});

test('unknown error codes keep the backend message and successful stat remains unchanged', async () => {
  response = new Response(JSON.stringify({ code: 'Other', error: 'Backend detail' }), { status: 500 });
  await assert.rejects(provider.stat(uri), /Backend detail/);
  const stat = { type: 1, ctime: 1, mtime: 2, size: 3 };
  response = new Response(JSON.stringify(stat), { status: 200 });
  assert.deepEqual(await provider.stat(uri), stat);
});
