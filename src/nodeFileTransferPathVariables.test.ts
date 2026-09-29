import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { getAgentDir } from './config';
import { readNodeTransferFile, writeNodeTransferFile } from './nodeFileTransfer';

test('copy transfer legs expand Agent tokens independently in Main and a configured CLI Node environment', async () => {
  const agentName = `copy_paths_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const mainRoot = getAgentDir(agentName);
  const cliRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-cli-copy-root-'));
  try {
    const source = await writeNodeTransferFile('$fw_tmp/source.txt', agentName,
      Buffer.from('copy across roots').toString('base64'), false, true);
    assert.equal(source.absolutePath, path.join(mainRoot, 'tmp/source.txt'));
    const payload = await readNodeTransferFile('$fw_tmp/source.txt', agentName, true);
    const cliHelper = require.resolve('../packages/shared/dist/nodeFileTransfer');
    const script = `
      const transfer = require(process.argv[1]);
      (async () => {
        const result = await transfer.writeNodeTransferFile('$fw_tmp/target.txt', process.argv[2], process.argv[3], false, true);
        const readBack = await transfer.readNodeTransferFile('$fw_tmp/target.txt', process.argv[2], true);
        process.stdout.write(JSON.stringify({ absolutePath: result.absolutePath, content: readBack.dataBase64 }));
      })().catch(error => { console.error(error.message); process.exitCode = 1; });
    `;
    const child = spawnSync(process.execPath, ['-e', script, cliHelper, agentName, payload.dataBase64], {
      cwd: path.dirname(cliHelper), encoding: 'utf8',
      env: { ...process.env, FOXWARM_AGENTS_DIR: cliRoot, FOXWARM_AGENT_DIR: '' },
    });
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout);
    assert.equal(result.absolutePath, path.join(cliRoot, agentName, 'tmp/target.txt'));
    assert.notEqual(result.absolutePath, path.join(mainRoot, 'tmp/target.txt'));
    assert.equal(Buffer.from(result.content, 'base64').toString(), 'copy across roots');
    await assert.rejects(() => readNodeTransferFile('$UNKNOWN/source.txt', agentName, true), /Unknown Agent path variable/);
  } finally {
    await fs.remove(mainRoot);
    await fs.remove(cliRoot);
  }
});
