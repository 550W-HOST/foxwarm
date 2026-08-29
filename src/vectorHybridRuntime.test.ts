import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

test('dense failure aborts detailed hybrid search before any lexical query', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-hybrid-dense-required-'));
  const previousData = process.env.FOXWARM_DATA_DIR;
  const previousFetch = globalThis.fetch;
  process.env.FOXWARM_DATA_DIR = root;
  await fs.outputFile(path.join(root, 'state', 'config.yaml'), [
    'vector:',
    '  baseUrl: http://127.0.0.1:11434/v1',
    '  lexicalIndex: true',
    '  hybridSearch: true',
    '',
  ].join('\n'));
  try {
    const runtime = await import('./vectorRuntime');
    const lexical = await import('./vectorLexicalRuntime');
    await runtime.init();
    await runtime.waitForStartupArchiveVectorBackfill();
    let lexicalQueries = 0;
    lexical.setTestHooks({ beforeQuery: () => { lexicalQueries += 1; } });
    globalThis.fetch = (async () => { throw new Error('injected dense embedding failure'); }) as any;
    await assert.rejects(() => runtime.searchDetailed('DenseMustFail_42', 5, false, { sessionIds: ['missing/session'] }), /dense embedding failure/);
    assert.equal(lexicalQueries, 0);
    lexical.setTestHooks();
    await runtime.shutdown();
  } finally {
    globalThis.fetch = previousFetch;
    if (previousData === undefined) delete process.env.FOXWARM_DATA_DIR;
    else process.env.FOXWARM_DATA_DIR = previousData;
    await fs.remove(root);
  }
});
