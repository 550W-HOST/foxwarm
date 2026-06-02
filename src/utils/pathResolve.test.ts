import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import { expandHomePath, resolveAgentPath } from './pathResolve';

describe('expandHomePath', () => {
  it('expands ~ to home directory', () => {
    assert.equal(expandHomePath('~'), os.homedir());
  });

  it('expands ~/path to home + path', () => {
    assert.equal(expandHomePath('~/foo/bar'), path.join(os.homedir(), 'foo/bar'));
  });

  it('expands ~\\path on windows-style', () => {
    assert.equal(expandHomePath('~\\foo\\bar'), path.join(os.homedir(), 'foo\\bar'));
  });

  it('returns absolute paths unchanged', () => {
    assert.equal(expandHomePath('/usr/local/bin'), '/usr/local/bin');
  });

  it('returns relative paths unchanged', () => {
    assert.equal(expandHomePath('relative/path'), 'relative/path');
  });

  it('returns empty string unchanged', () => {
    assert.equal(expandHomePath(''), '');
  });
});

describe('resolveAgentPath', () => {
  it('resolves absolute paths directly', () => {
    const result = resolveAgentPath('/absolute/path', 'main');
    assert.equal(result, '/absolute/path');
  });

  it('resolves ~ paths to home directory', () => {
    const result = resolveAgentPath('~/some/file', 'main');
    assert.equal(result, path.join(os.homedir(), 'some/file'));
  });

  it('resolves relative paths against agent directory when no cwd', () => {
    const result = resolveAgentPath('memory/MEMORY.md', 'main');
    // Should resolve relative to the agent dir
    assert.ok(result.endsWith('memory/MEMORY.md'));
    assert.ok(path.isAbsolute(result));
  });

  it('resolves relative paths against session cwd when provided', () => {
    const result = resolveAgentPath('file.txt', 'main', '/tmp/workdir');
    assert.equal(result, '/tmp/workdir/file.txt');
  });

  it('expands ~ in session cwd', () => {
    const result = resolveAgentPath('file.txt', 'main', '~/projects');
    assert.equal(result, path.join(os.homedir(), 'projects', 'file.txt'));
  });

  it('ignores empty/whitespace cwd', () => {
    const result = resolveAgentPath('file.txt', 'main', '   ');
    // Should fall back to agent dir, not use whitespace as cwd
    assert.ok(path.isAbsolute(result));
    assert.ok(result.endsWith('file.txt'));
  });
});
