import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('filesystem extension contributes Explorer Add Folder to Workspace only for foxwarm folders', async () => {
  const manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  assert.ok(manifest.contributes.commands.some((entry) => entry.command === 'foxwarm-fs.addFolderToWorkspace'));
  assert.ok(manifest.activationEvents.includes('onCommand:foxwarm-fs.addFolderToWorkspace'));
  assert.deepEqual(
    manifest.contributes.menus['explorer/context'].find((entry) => entry.command === 'foxwarm-fs.addFolderToWorkspace'),
    {
      command: 'foxwarm-fs.addFolderToWorkspace',
      when: 'resourceScheme == foxwarm && explorerResourceIsFolder',
      group: 'navigation@20',
    },
  );
});
