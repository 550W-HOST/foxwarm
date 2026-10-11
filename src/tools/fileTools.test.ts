import test from 'node:test';
import assert from 'node:assert/strict';
import { tool_edit, tool_read } from './fileTools';

test('Main read and edit report a missing or blank filePath before path resolution', async () => {
  for (const args of [{}, { filePath: '' }]) {
    await assert.rejects(() => tool_read(args as any, {} as any), { message: 'read requires filePath.' });
    await assert.rejects(() => tool_edit({ ...args, oldText: 'old', newText: 'new' } as any, {} as any), { message: 'edit requires filePath.' });
  }
});
