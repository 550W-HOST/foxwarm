import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readNodeTransferFile, writeNodeTransferFile } from './nodeFileTransfer';

test('resident CLI transfer retains binary/empty/large bytes, no-overwrite publication and existing digest receipts', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-node-transfer-'));
  try {
    for (const data of [Buffer.alloc(0), Buffer.from([0, 255, 0xc3, 0x28, 13, 10]), Buffer.alloc(12 * 1024 * 1024 + 7, 0xab)]) {
      const file = path.join(root, 'transfer.bin');
      await fs.remove(file);
      const written = await writeNodeTransferFile(file, 'main', data.toString('base64'), false, false);
      assert.equal(written.overwritten, false);
      assert.equal(written.sizeBytes, data.length);
      assert.equal(written.absolutePath, file);
      assert.equal(written.sha256, createHash('sha256').update(data).digest('hex'));
      const read = await readNodeTransferFile(file, 'main', false);
      assert.deepEqual(Buffer.from(read.dataBase64, 'base64'), data);
      assert.equal(read.sha256, written.sha256);
      await assert.rejects(() => writeNodeTransferFile(file, 'main', 'bmV3', false, false), /already exists/);
      assert.deepEqual(await fs.readFile(file), data);
      const replaced = await writeNodeTransferFile(file, 'main', 'bmV3', true, false);
      assert.equal(replaced.overwritten, true);
      assert.equal(await fs.readFile(file, 'utf8'), 'new');
      assert.deepEqual(await fs.readdir(root), ['transfer.bin'], 'native temporary publication files are cleaned');
    }
  } finally { await fs.remove(root); }
});
