import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import path from 'path';
import { getAgentDir, getAgentMemoryDir } from './config';
import * as sessionManager from './sessionManager';
import { checkToolPermission } from './isolatedCheck';
import { read, write, edit, apply_patch, apply_patch_memory, copy_between_nodes, definitions, modelFacingDefinitions, submit_compact_plan, search_memory, search_vector } from './tools';

test('submit_compact_plan is present in regular tool definitions and guarded outside compact flow', async () => {
  assert.ok(definitions.some(def => def.name === 'submit_compact_plan'));
  assert.ok(modelFacingDefinitions.some(def => def.name === 'submit_compact_plan'));
  const result = await submit_compact_plan();
  assert.match(String(result), /only valid inside the dedicated compact planning flow/i);
});

test('apply_patch_memory is present in regular tool definitions', () => {
  assert.ok(definitions.some(def => def.name === 'apply_patch_memory'));
});

test('search_vector is the public vector-memory tool name while search_memory remains a runtime alias', () => {
  assert.ok(definitions.some(def => def.name === 'search_vector'));
  assert.equal(definitions.some(def => def.name === 'search_memory'), false);
  assert.equal(search_vector, search_memory);
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

test('read lists directories with item-number pagination', async () => {
  const agentDir = getAgentDir('main');
  const baseDir = path.join(agentDir, '.temp', `read-dir-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const nestedDir = path.join(baseDir, 'z-subdir');
  const ctx = { session: { agent: 'main' } };

  try {
    await fs.ensureDir(nestedDir);
    await fs.writeFile(path.join(nestedDir, 'inside.txt'), 'nested');
    for (let i = 1; i <= 55; i += 1) {
      await fs.writeFile(path.join(baseDir, `item-${String(i).padStart(3, '0')}.txt`), `item ${i}`);
    }

    const firstPage = String(await read({ filePath: baseDir }, ctx as any));
    assert.ok(firstPage.includes(`Directory listing for \`${baseDir}\``));
    assert.match(firstPage, /1\. `item-001\.txt` \(file, \d+ B\)/);
    assert.match(firstPage, /50\. `item-050\.txt` \(file, \d+ B\)/);
    assert.doesNotMatch(firstPage, /51\. `item-051\.txt`/);
    assert.match(firstPage, /Showing items 1-50 of 56\./);
    assert.match(firstPage, /Next page: read\(\{ filePath: .*startLine: 51, endLine: 56 \}\)/);

    const secondPage = String(await read({ filePath: baseDir, startLine: 51, endLine: 56 }, ctx as any));
    assert.doesNotMatch(secondPage, /50\. `item-050\.txt`/);
    assert.match(secondPage, /51\. `item-051\.txt` \(file, \d+ B\)/);
    assert.match(secondPage, /55\. `item-055\.txt` \(file, \d+ B\)/);
    assert.match(secondPage, /56\. `z-subdir\/` \(dir\)/);
    assert.doesNotMatch(secondPage, /inside\.txt/);
    assert.match(secondPage, /Showing items 51-56 of 56\./);
    assert.doesNotMatch(secondPage, /Next page:/);
  } finally {
    await fs.remove(baseDir);
  }
});

function extractWriteContentRef(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/contentRef:\s*"([^"]+)"/);
  assert.ok(match, `expected write error to include contentRef, got: ${message}`);
  return match[1];
}

test('write can reuse cached contentRef after existing-file refusal', async () => {
  const agentDir = getAgentDir('main');
  const baseDir = path.join(agentDir, '.temp', `write-ref-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const filePath = path.join(baseDir, 'note.txt');
  const ctx = { sessionId: `main/write_ref_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, session: { agent: 'main' } };

  try {
    await fs.ensureDir(baseDir);
    await fs.writeFile(filePath, 'old');

    let contentRef = '';
    await assert.rejects(
      async () => write({ filePath, content: 'new cached content' }, ctx as any),
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        assert.match(message, /File already exists/);
        assert.doesNotMatch(message, /new cached content/);
        contentRef = extractWriteContentRef(err);
        return true;
      },
    );

    await write({ filePath, contentRef, overwrite: true }, ctx as any);
    assert.equal(await fs.readFile(filePath, 'utf8'), 'new cached content');
  } finally {
    await fs.remove(baseDir);
  }
});

test('write contentRef is scoped to the same session and same path', async () => {
  const agentDir = getAgentDir('main');
  const baseDir = path.join(agentDir, '.temp', `write-ref-scope-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const firstPath = path.join(baseDir, 'first.txt');
  const secondPath = path.join(baseDir, 'second.txt');
  const ctx = { sessionId: `main/write_ref_scope_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, session: { agent: 'main' } };
  const otherCtx = { sessionId: `${ctx.sessionId}_other`, session: { agent: 'main' } };

  try {
    await fs.ensureDir(baseDir);
    await fs.writeFile(firstPath, 'first old');
    await fs.writeFile(secondPath, 'second old');

    let contentRef = '';
    await assert.rejects(
      async () => write({ filePath: firstPath, content: 'first new' }, ctx as any),
      (err: unknown) => {
        contentRef = extractWriteContentRef(err);
        return true;
      },
    );

    await assert.rejects(
      () => write({ filePath: firstPath, contentRef }, otherCtx as any),
      /requires overwrite=true/,
    );
    await assert.rejects(
      () => write({ filePath: firstPath, contentRef, overwrite: true }, otherCtx as any),
      /not available in this session\/agent/,
    );
    await assert.rejects(
      () => write({ filePath: secondPath, contentRef, overwrite: true }, ctx as any),
      /cannot be used to write a different file/,
    );
    await assert.rejects(
      () => write({ filePath: firstPath, contentRef: 'write_missing_ref', overwrite: true }, ctx as any),
      /not found or expired/,
    );

    await write({ filePath: firstPath, contentRef, overwrite: true }, ctx as any);
    assert.equal(await fs.readFile(firstPath, 'utf8'), 'first new');
  } finally {
    await fs.remove(baseDir);
  }
});

test('apply_patch_memory is restricted to the current agent memory directory and preserves apply_patch compatibility', async () => {
  const memoryDir = getAgentMemoryDir('main');
  const relativePath = `tools-memory-${Date.now()}-${Math.random().toString(36).slice(2, 8)}/note.txt`;
  const fullPath = path.join(memoryDir, relativePath);

  try {
    await apply_patch_memory({
      input: [
        `*** Add File: ${relativePath}`,
        '+alpha',
        '+beta',
      ].join('\n'),
    }, { session: { agent: 'main' } } as any);
    assert.equal(await fs.readFile(fullPath, 'utf8'), 'alpha\nbeta');

    await apply_patch_memory({
      input: [
        '*** Begin Patch',
        `*** Update File: memory/${relativePath}`,
        '@@',
        '-beta',
        '+patched',
        '*** End Patch',
      ].join('\n'),
    }, { session: { agent: 'main' } } as any);
    assert.equal(await fs.readFile(fullPath, 'utf8'), 'alpha\npatched');

    await apply_patch_memory({
      input: [
        '*** Begin Patch',
        `*** Delete File: ${relativePath}`,
        '*** End Patch',
      ].join('\n'),
    }, { session: { agent: 'main' } } as any);
    assert.equal(await fs.pathExists(fullPath), false);

    await assert.rejects(
      () => apply_patch_memory({
        input: [
          '*** Begin Patch',
          '*** Add File: /tmp/escape.txt',
          '+nope',
          '*** End Patch',
        ].join('\n'),
      }, { session: { agent: 'main' } } as any),
      /relative to the current agent memory\/ directory/i,
    );
  } finally {
    await fs.remove(path.dirname(fullPath));
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

test('copy_between_nodes allows non-isolated absolute master paths outside the agent directory', async () => {
  const sessionId = `main/copy_nonisolated_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const session = await sessionManager.getSession(sessionId);
  const sourcePath = path.join('/tmp', `foxwarm-copy-source-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
  const targetPath = path.join('/tmp', `foxwarm-copy-target-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);

  try {
    await fs.writeFile(sourcePath, 'copy outside agent dir');

    const result = await copy_between_nodes({
      sourceNode: 'master',
      sourcePath,
      targetNode: 'master',
      targetPath,
      overwrite: true,
    }, { sessionId, session } as any);

    assert.match(String(result), /Copied/);
    assert.equal(await fs.readFile(targetPath, 'utf8'), 'copy outside agent dir');
  } finally {
    await fs.remove(sourcePath);
    await fs.remove(targetPath);
  }
});

test('isolated copy_between_nodes restricts master paths but allows absolute paths on the bound node', async () => {
  const agentName = `isolated_copy_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const sessionId = `${agentName}/session`;
  const boundNode = 'sandbox-node';

  try {
    await sessionManager.setAgentMetadata(agentName, { isolated: true, isolatedNode: boundNode } as any);
    const session = await sessionManager.getSession(sessionId);
    session.agent = agentName;
    session.currentNode = boundNode;

    await assert.doesNotReject(() => checkToolPermission('copy_between_nodes', sessionId, 'master', {
      sourceNode: boundNode,
      sourcePath: '/var/tmp/source.txt',
      targetNode: boundNode,
      targetPath: '/var/tmp/target.txt',
    }));

    await assert.doesNotReject(() => checkToolPermission('copy_between_nodes', sessionId, 'master', {
      sourceNode: boundNode,
      sourcePath: '/var/tmp/source.txt',
      targetNode: 'master',
      targetPath: path.join(getAgentDir(agentName), 'copied.txt'),
    }));

    await assert.rejects(
      () => checkToolPermission('copy_between_nodes', sessionId, 'master', {
        sourceNode: 'master',
        sourcePath: '/tmp/outside-source.txt',
        targetNode: boundNode,
        targetPath: '/var/tmp/target.txt',
      }),
      /only read from agents\//,
    );

    await assert.rejects(
      () => checkToolPermission('copy_between_nodes', sessionId, 'master', {
        sourceNode: boundNode,
        sourcePath: '/var/tmp/source.txt',
        targetNode: 'master',
        targetPath: '/tmp/outside-target.txt',
      }),
      /only write to agents\//,
    );
  } finally {
    await sessionManager.setAgentMetadata(agentName, { isolated: false } as any);
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
