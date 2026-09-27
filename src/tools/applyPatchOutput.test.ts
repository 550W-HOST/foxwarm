import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { applyPatchOperations } from './helpers';

test('backend apply patch output reports per-file added and deleted line counts', async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-apply-patch-output-'));
  const resolveOperationPath = (filePath: string) => ({
    fullPath: path.join(baseDir, filePath),
    displayPath: filePath,
  });

  try {
    await fs.writeFile(path.join(baseDir, 'replace.txt'), 'first\r\nkeep\r\nthird\r\nlast');
    await fs.writeFile(path.join(baseDir, 'insert.txt'), 'head\ntail');
    await fs.writeFile(path.join(baseDir, 'remove.txt'), 'head\nremove\ntail');
    await fs.writeFile(path.join(baseDir, 'delete.txt'), 'delete me');

    const result = await applyPatchOperations([
      '*** Begin Patch',
      '*** Update File: replace.txt',
      '@@',
      '-first',
      '+FIRST',
      ' keep',
      '@@ third',
      '-last',
      '+LAST',
      '+after',
      '*** Update File: insert.txt',
      '@@ head',
      '+middle one',
      '+middle two',
      ' tail',
      '*** Update File: remove.txt',
      '@@',
      ' head',
      '-remove',
      ' tail',
      '*** Add File: added.txt',
      '+alpha',
      '+beta',
      '*** Add File: empty.txt',
      '*** Delete File: delete.txt',
      '*** End Patch',
    ].join('\n'), resolveOperationPath);

    assert.equal(result, [
      'Patch applied successfully.',
      '- Updated replace.txt (+3 -2)',
      '- Updated insert.txt (+2 -0)',
      '- Updated remove.txt (+0 -1)',
      '- Added added.txt (+2)',
      '- Added empty.txt (+0)',
      '- Deleted delete.txt',
    ].join('\n'));
    assert.equal(await fs.readFile(path.join(baseDir, 'replace.txt'), 'utf8'), 'FIRST\r\nkeep\r\nthird\r\nLAST\r\nafter');
    assert.equal(await fs.readFile(path.join(baseDir, 'insert.txt'), 'utf8'), 'head\nmiddle one\nmiddle two\ntail');
    assert.equal(await fs.readFile(path.join(baseDir, 'remove.txt'), 'utf8'), 'head\ntail');
    assert.equal(await fs.readFile(path.join(baseDir, 'added.txt'), 'utf8'), 'alpha\nbeta');
    assert.equal(await fs.readFile(path.join(baseDir, 'empty.txt'), 'utf8'), '');
    assert.equal(await fs.pathExists(path.join(baseDir, 'delete.txt')), false);
  } finally {
    await fs.remove(baseDir);
  }
});

test('backend partial failure includes counts for operations already applied', async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-apply-patch-partial-'));
  const resolveOperationPath = (filePath: string) => ({
    fullPath: path.join(baseDir, filePath),
    displayPath: filePath,
  });

  try {
    await assert.rejects(
      () => applyPatchOperations([
        '*** Begin Patch',
        '*** Add File: applied.txt',
        '+one',
        '+two',
        '*** Update File: missing.txt',
        '@@',
        '-old',
        '+new',
        '*** Add File: skipped.txt',
        '+skipped',
        '*** End Patch',
      ].join('\n'), resolveOperationPath),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /Cannot update missing file: missing\.txt/);
        assert.match(message, /- Added applied\.txt \(\+2\)/);
        assert.match(message, /1 remaining operation\(s\) were not applied\./);
        return true;
      },
    );
    assert.equal(await fs.readFile(path.join(baseDir, 'applied.txt'), 'utf8'), 'one\ntwo');
    assert.equal(await fs.pathExists(path.join(baseDir, 'skipped.txt')), false);
  } finally {
    await fs.remove(baseDir);
  }
});
