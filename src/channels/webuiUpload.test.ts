import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWebUiMultipartFilename } from './webuiUpload';

test('normalizes Busboy Latin-1 decoding of a UTF-8 Chinese filename', () => {
  assert.equal(normalizeWebUiMultipartFilename('ä¸­æ\u0096\u0087æµ\u008bè¯\u0095.txt'), '中文测试.txt');
});

test('keeps already-correct Unicode and ASCII multipart filenames unchanged', () => {
  assert.equal(normalizeWebUiMultipartFilename('中文测试.txt'), '中文测试.txt');
  assert.equal(normalizeWebUiMultipartFilename('notes-2026.txt'), 'notes-2026.txt');
});

test('keeps invalid non-UTF-8 Latin-1-shaped filenames unchanged', () => {
  assert.equal(normalizeWebUiMultipartFilename('café.txt'), 'café.txt');
  assert.equal(normalizeWebUiMultipartFilename('bad-ÿ-name.bin'), 'bad-ÿ-name.bin');
});