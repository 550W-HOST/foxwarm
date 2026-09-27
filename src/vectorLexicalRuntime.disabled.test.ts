import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

test('disabled dark lexical lane creates no DB and ignores schedule/maintenance', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-lexical-disabled-'));
  const previous = process.env.FOXWARM_DATA_DIR;
  process.env.FOXWARM_DATA_DIR = root;
  await fs.outputFile(path.join(root, 'state', 'config.yaml'), 'vector:\n  baseUrl: http://127.0.0.1:11434/v1\n');
  try {
    const runtime = await import('./vectorLexicalRuntime');
    await runtime.init();
    runtime.schedule('disabled/session', 100, 10);
    runtime.force('disabled/session', 100, 10);
    await runtime.runMaintenance();
    await runtime.shutdown();
    assert.equal(runtime.isConfigured(), false);
    assert.equal(await fs.pathExists(path.join(root, 'state', 'db', 'archive-search.sqlite')), false);
  } finally {
    if (previous === undefined) delete process.env.FOXWARM_DATA_DIR;
    else process.env.FOXWARM_DATA_DIR = previous;
    await fs.remove(root);
  }
});
