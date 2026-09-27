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

test('filesystem extension contributes discoverable fixed master app and data folder commands', async () => {
  const manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  const commands = Object.fromEntries(manifest.contributes.commands.map((entry) => [entry.command, entry]));
  assert.deepEqual(commands['foxwarm-fs.openAppFolder'], {
    command: 'foxwarm-fs.openAppFolder',
    title: 'Open Foxwarm app folder',
    category: 'Foxwarm',
    icon: '$(folder-library)',
  });
  assert.deepEqual(commands['foxwarm-fs.openDataFolder'], {
    command: 'foxwarm-fs.openDataFolder',
    title: 'Open Foxwarm data folder',
    category: 'Foxwarm',
    icon: '$(database)',
  });
  assert.ok(manifest.activationEvents.includes('onCommand:foxwarm-fs.openAppFolder'));
  assert.ok(manifest.activationEvents.includes('onCommand:foxwarm-fs.openDataFolder'));
  const hidden = manifest.contributes.menus.commandPalette || [];
  assert.equal(hidden.some((entry) => entry.command === 'foxwarm-fs.openAppFolder' || entry.command === 'foxwarm-fs.openDataFolder'), false);
});
