import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(packageRoot, '..', '..');

async function createBuildLayout(checkoutRoot) {
  const sandboxRoot = path.join(checkoutRoot, 'packages', 'sandbox-node-runtime');
  await fs.mkdir(path.join(sandboxRoot, 'scripts'), { recursive: true });
  await fs.mkdir(path.join(checkoutRoot, 'packages', 'shared'), { recursive: true });
  await Promise.all([
    fs.cp(path.join(packageRoot, 'src'), path.join(sandboxRoot, 'src'), { recursive: true }),
    fs.cp(path.join(repoRoot, 'packages', 'shared', 'dist'), path.join(checkoutRoot, 'packages', 'shared', 'dist'), { recursive: true }),
    fs.copyFile(path.join(repoRoot, 'package.json'), path.join(checkoutRoot, 'package.json')),
    fs.copyFile(path.join(packageRoot, 'package.json'), path.join(sandboxRoot, 'package.json')),
    fs.copyFile(path.join(packageRoot, 'tsconfig.json'), path.join(sandboxRoot, 'tsconfig.json')),
    fs.copyFile(path.join(packageRoot, 'scripts', 'build-bundle.mjs'), path.join(sandboxRoot, 'scripts', 'build-bundle.mjs')),
    fs.symlink(path.join(repoRoot, 'node_modules'), path.join(checkoutRoot, 'node_modules'), 'dir'),
  ]);
  await execFileAsync(process.execPath, ['scripts/build-bundle.mjs'], { cwd: sandboxRoot });
  return fs.readFile(path.join(sandboxRoot, 'dist', 'invoke.bundle.js'));
}

test('sandbox invoke bundle is reproducible across dependency symlink and checkout depths', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-sandbox-bundle-'));
  try {
    const [shallowBundle, deepBundle, committedBundle] = await Promise.all([
      createBuildLayout(path.join(tempRoot, 'checkout')),
      createBuildLayout(path.join(tempRoot, 'nested', 'worktrees', 'checkout')),
      fs.readFile(path.join(packageRoot, 'dist', 'invoke.bundle.js')),
    ]);

    assert.deepEqual(deepBundle, shallowBundle);
    assert.deepEqual(committedBundle, shallowBundle);

    const text = committedBundle.toString('utf8');
    assert.ok(text.startsWith('#!/usr/bin/env node\n'));
    assert.doesNotMatch(text, /(?:^|\n)\s*\/\/[^\n]*(?:node_modules|packages\/)/);
    assert.doesNotMatch(text, /(?:\/home\/|\/Users\/|[A-Za-z]:\\Users\\|temp-worktrees|git\/foxwarm)/);
    assert.doesNotMatch(text, /sourceMappingURL/);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});