require('../../../scripts/test/test-process-env.cjs').initializeTestEnvironment();
import assert from 'node:assert/strict';
import test from 'node:test';
import { applyTextEdits, parseUnifiedEdit, projectUnifiedEditTools } from './unifiedEdit';
import { edit } from './nodeTools';
import { nativeFileOperations } from './fileOperations';

const run = (source: string, args: Record<string, unknown>) => {
  const parsed = parseUnifiedEdit({ filePath: 'file', ...args });
  assert.ok('edits' in parsed);
  return applyTextEdits(source, parsed.edits);
};

test('unified edit replacements are literal, nonoverlapping and based on original content', () => {
  assert.equal(run('aa aa', { oldText: 'aa', newText: '$$-$&-$`-$\'-$1\n', replaceAll: true }), '$$-$&-$`-$\'-$1\n $$-$&-$`-$\'-$1\n');
  assert.equal(run('aaa', { oldText: 'aa', newText: '' }), 'a');
  assert.equal(run('α\r\nβ\rγ\n', { edits: [{ oldText: 'α', newText: 'β' }, { oldText: 'β', newText: '' }, { oldText: 'γ', newText: '$&' }] }), 'β\r\n\r$&\n');
  assert.equal(run('abcdef', { edits: [{ oldText: 'ab', newText: 'X' }, { oldText: 'cd', newText: 'Y' }] }), 'XYef');
  assert.throws(() => run('one one', { oldText: 'one', newText: 'two' }), /2 occurrences/);
  assert.throws(() => run('one', { oldText: 'missing', newText: '', replaceAll: true }), /Could not find/);
  assert.throws(() => run('abc', { edits: [{ oldText: 'ab', newText: '' }, { oldText: 'bc', newText: '' }] }), /overlap/);
  assert.throws(() => run('a a', { edits: [{ oldText: 'a', newText: '', replaceAll: true }, { oldText: 'a a', newText: '' }] }), /overlap/);
});

test('unified edit rejects empty search, mixed forms and malformed items before IO', async () => {
  for (const args of [
    { oldText: '', newText: '' }, { oldText: 'a' }, { oldText: 'a', newText: '', replaceAll: null },
    { edits: [] }, { edits: [null] }, { edits: [{ oldText: 'a', newText: '' }], oldText: 'a' },
    { edits: [{ oldText: 'a', newText: '', replaceAll: 'true' }] },
    { apply_patch: 'patch', filePath: 'file' }, { apply_patch: 'patch', replaceAll: false },
  ]) {
    await assert.rejects(() => edit({ filePath: 'file', ...args }, { resolveFilePath: () => { throw new Error('IO must not start'); } }), error => !String(error).includes('IO must not start'));
  }
});

test('Node edit validates all ranges before one write and routes patch through canonical executor', async () => {
  let source = 'first second';
  let writes = 0;
  const operations = {
    ...nativeFileOperations,
    stat: async () => ({ kind: 'file' as const, size: Buffer.byteLength(source), modifiedAtMs: 0 }),
    read: async (_path: string, offset: number, count: number) => Buffer.from(source).subarray(offset, offset + count),
    write: async (_path: string, content: string | Buffer) => { source = content.toString(); writes++; },
  };
  const ctx = { fileOperations: operations, resolveFilePath: (file: string) => file };
  await assert.rejects(() => edit({ filePath: 'file', edits: [{ oldText: 'first', newText: 'changed' }, { oldText: 'absent', newText: '' }] }, ctx), /Could not find/);
  assert.equal(source, 'first second');
  assert.equal(writes, 0);
  await edit({ filePath: 'file', edits: [{ oldText: 'first', newText: 'second' }, { oldText: 'second', newText: '$&\n' }] }, ctx);
  assert.equal(source, 'second $&\n');
  assert.equal(writes, 1);
  await edit({ apply_patch: '*** Begin Patch\n*** Update File: file\n@@\n-second $&\n+patched\n*** End Patch' }, ctx);
  assert.equal(source, 'patched\n');
  assert.equal(writes, 2);
});

test('catalog projection hides legacy patch without mutating wire schemas', () => {
  const wire = [{ name: 'edit', parameters: { properties: { filePath: { description: 'target path' } } } }, { name: 'apply_patch' }, { name: 'read' }];
  const projected = projectUnifiedEditTools(wire);
  assert.deepEqual(projected.map(tool => tool.name), ['edit', 'read']);
  assert.ok((projected[0].parameters as any).properties.edits);
  assert.equal((projected[0].parameters as any).properties.filePath.description, 'target path');
  assert.equal(wire[0].parameters!.properties.filePath.description, 'target path');
});
