import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import path from 'path';
import { getAgentDir } from './config';
import * as sessionManager from './sessionManager';
import { read, write, edit, apply_patch, definitions, submit_compact_plan } from './tools';

test('submit_compact_plan is present in regular tool definitions and guarded outside compact flow', async () => {
  assert.ok(definitions.some(def => def.name === 'submit_compact_plan'));
  const result = await submit_compact_plan();
  assert.match(String(result), /only valid inside the dedicated compact planning flow/i);
});

test('file tools resolve relative paths from session cwd', async () => {
  const agentDir = getAgentDir('main');
  const baseDir = path.join(agentDir, '.temp', `tools-cwd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const nestedDir = path.join(baseDir, 'nested');
  await fs.ensureDir(nestedDir);

  const ctx = {
    session: {
      agent: 'main',
      cwd: nestedDir,
    },
  };

  try {
    await write({ filePath: 'note.txt', content: 'hello', overwrite: true }, ctx as any);
    assert.equal(await fs.readFile(path.join(nestedDir, 'note.txt'), 'utf8'), 'hello');

    const readResult = await read({ filePath: 'note.txt' }, ctx as any);
    assert.equal(readResult, 'hello');

    await edit({ filePath: 'note.txt', oldText: 'hello', newText: 'world' }, ctx as any);
    assert.equal(await fs.readFile(path.join(nestedDir, 'note.txt'), 'utf8'), 'world');

    await apply_patch({
      input: [
        '*** Begin Patch',
        '*** Update File: note.txt',
        '@@',
        '-world',
        '+patched',
        '*** End Patch',
      ].join('\n'),
    }, ctx as any);
    assert.equal(await fs.readFile(path.join(nestedDir, 'note.txt'), 'utf8'), 'patched');
  } finally {
    await fs.remove(baseDir);
  }
});

test('non-isolated read accepts absolute paths outside the agent directory', async () => {
  const outsidePath = path.join('/tmp', `foxwarm-read-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);

  try {
    await fs.writeFile(outsidePath, 'outside');
    const result = await read({ filePath: outsidePath }, { session: { agent: 'main' } } as any);
    assert.equal(result, 'outside');
  } finally {
    await fs.remove(outsidePath);
  }
});

test('isolated read remains restricted to the current agent directory on master', async () => {
  const agentName = `isolated_read_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const outsidePath = path.join('/tmp', `foxwarm-isolated-read-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);

  try {
    await sessionManager.setAgentMetadata(agentName, { isolated: true, isolatedNode: 'sandbox-docker' } as any);
    await fs.writeFile(outsidePath, 'outside');
    await assert.rejects(
      () => read({ filePath: outsidePath }, { session: { agent: agentName }, runtimeNodeId: 'master' } as any),
      new RegExp(`Isolated agent session can only access agents/${agentName}/`),
    );
  } finally {
    await sessionManager.setAgentMetadata(agentName, { isolated: false } as any);
    await fs.remove(outsidePath);
  }
});
