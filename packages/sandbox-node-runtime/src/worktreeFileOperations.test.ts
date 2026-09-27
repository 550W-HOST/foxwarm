import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { createWorktreeFileOperations } from './worktreeFileOperations';

test('worktree file operations reject traversal and symlink escapes while allowing safe creation', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-sandbox-runtime-'));
  const root = path.join(dir, 'worktree');
  const outside = path.join(dir, 'outside');
  await fs.ensureDir(root); await fs.ensureDir(outside);
  await fs.writeFile(path.join(root, 'inside.txt'), 'inside');
  await fs.writeFile(path.join(outside, 'secret.txt'), 'secret');
  await fs.symlink(outside, path.join(root, 'escape'));
  const operations = createWorktreeFileOperations(root);
  try {
    assert.equal((await operations.read(path.join(root, 'inside.txt'), 0, 10)).toString(), 'inside');
    await operations.mkdir(path.join(root, 'new', 'nested'));
    await operations.write(path.join(root, 'new', 'nested', 'file.txt'), 'ok', 'wx');
    await assert.rejects(() => operations.read(path.join(root, '..', 'outside', 'secret.txt'), 0, 10), /outside/);
    await assert.rejects(() => operations.read(path.join(root, 'escape', 'secret.txt'), 0, 10), /symlink/);
    await assert.rejects(() => operations.write(path.join(root, 'escape', 'new.txt'), 'bad', 'w'), /symlink/);
    await fs.symlink(path.join(root, 'inside.txt'), path.join(root, 'inside-link'));
    await assert.rejects(() => operations.read(path.join(root, 'inside-link'), 0, 10), /symlink/);
  } finally { await fs.remove(dir); }
});