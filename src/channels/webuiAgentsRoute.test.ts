import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { spawnSync } from 'node:child_process';

test('Agent memory manifest is bounded to self-owned Markdown without following symlinks', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-webui-agent-memory-'));
  try {
    const script = String.raw`
      const assert = require('node:assert/strict');
      const fs = require('fs-extra');
      const path = require('node:path');
      const config = require('./lib/config.js');
      const { readAgentMemoryManifest } = require('./lib/channels/webuiChannel.js');
      (async () => {
        const memoryRoot = path.join(config.getAgentDir('manifest-agent'), 'memory');
        await fs.outputFile(path.join(memoryRoot, 'USER.md'), 'user');
        await fs.outputFile(path.join(memoryRoot, 'MEMORY.md'), 'memory');
        await fs.outputFile(path.join(memoryRoot, 'projects', 'PROJECT.md'), 'project');
        await fs.outputFile(path.join(memoryRoot, 'archive', 'OLD.md'), 'archive');
        await fs.outputFile(path.join(memoryRoot, 'ignored.txt'), 'ignored');
        const outside = path.join(config.getAgentDir('manifest-agent'), 'outside.md');
        await fs.outputFile(outside, 'outside');
        await fs.symlink(outside, path.join(memoryRoot, 'linked.md'));
        const manifest = await readAgentMemoryManifest('manifest-agent');
        assert.equal(manifest.memoryRoot, memoryRoot);
        assert.deepEqual(manifest.files.map(file => file.path), [
          'MEMORY.md',
          'USER.md',
          'projects/PROJECT.md',
          'archive/OLD.md',
        ]);
        assert.ok(manifest.files.every(file => file.absolutePath.startsWith(memoryRoot + path.sep)));
        await assert.rejects(() => readAgentMemoryManifest('missing-agent'), /not found/);
        process.exit(0);
      })().catch(error => { console.error(error.stack || error); process.exit(1); });
    `;
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: path.resolve(__dirname, '..', '..'),
      env: { ...process.env, FOXWARM_DATA_DIR: tempRoot },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    await fs.remove(tempRoot);
  }
});