import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'os';
import path from 'path';
import fs from 'fs-extra';
import { MAX_FULL_TEXT_READ_BYTES } from './boundedTextExcerpt';
import { readFileToolPath } from './fileToolCore';

test('file reads preserve small-file and line-range behavior', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-file-read-small-'));
  const filePath = path.join(root, 'small.txt');
  try {
    await fs.writeFile(filePath, 'one\ntwo\nthree\n');
    assert.equal(await readFileToolPath(filePath, 'small.txt'), 'one\ntwo\nthree\n');
    assert.equal(await readFileToolPath(filePath, 'small.txt', 2, 3), 'two\nthree');
  } finally {
    await fs.remove(root);
  }
});

test('oversized file reads use bounded samples without full readFile and preserve valid controls', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-file-read-large-text-'));
  const filePath = path.join(root, 'large.txt');
  const bytes = Buffer.concat([
    Buffer.from('HEAD 中文😀'), Buffer.from([0x00, 0x01, 0xc2, 0x81, 0xff]),
    Buffer.from('m'.repeat(MAX_FULL_TEXT_READ_BYTES + 128)), Buffer.from('TAIL'),
  ]);
  try {
    await fs.writeFile(filePath, bytes);
    const originalReadFile = fs.readFile;
    (fs as any).readFile = async () => { throw new Error('oversized file read must not use readFile'); };
    let result: string;
    try {
      result = await readFileToolPath(filePath, 'large.txt') as string;
    } finally {
      (fs as any).readFile = originalReadFile;
    }
    assert.ok(result!.includes('HEAD 中文😀\x00\x01\u0081\\xff'));
    assert.match(result!, /TAIL/);
    assert.match(result!, /Original file size: \d+ bytes\./);
    assert.match(result!, /Foxwarm \\xNN placeholders above are display conversions, not literal file content\./);
  } finally {
    await fs.remove(root);
  }
});

test('oversized binary file reads use hex previews and line ranges stop at a finite end', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-file-read-range-'));
  const binaryPath = path.join(root, 'binary.bin');
  const linesPath = path.join(root, 'lines.txt');
  try {
    const binary = Buffer.alloc(MAX_FULL_TEXT_READ_BYTES + 128);
    Buffer.from('BINARY_HEAD').copy(binary);
    await fs.writeFile(binaryPath, binary);
    const binaryResult = await readFileToolPath(binaryPath, 'binary.bin') as string;
    assert.match(binaryResult, /file content appears binary/);
    assert.match(binaryResult, /42494e4152595f48454144/);
    assert.doesNotMatch(binaryResult, /Foxwarm \\xNN placeholders above are display conversions/);

    await fs.writeFile(linesPath, `first\n${'x'.repeat(MAX_FULL_TEXT_READ_BYTES + 64)}\nignored-after-end\n`);
    const rangeResult = await readFileToolPath(linesPath, 'lines.txt', 2, 2) as string;
    assert.match(rangeResult, /selected file range middle omitted/);
    assert.doesNotMatch(rangeResult, /ignored-after-end/);
    assert.match(rangeResult, /Original file size: \d+ bytes\./);

    const selectedBinary = Buffer.alloc(MAX_FULL_TEXT_READ_BYTES + 64);
    Buffer.from('RANGE_BINARY_HEAD').copy(selectedBinary);
    const rangeBinarySource = Buffer.concat([Buffer.from('first\n'), selectedBinary, Buffer.from('\nignored-after-end\n')]);
    await fs.writeFile(linesPath, rangeBinarySource);
    const binaryRangeResult = await readFileToolPath(linesPath, 'lines.txt', 2, 2) as string;
    assert.match(binaryRangeResult, /selected file range appears binary/);
    assert.match(binaryRangeResult, new RegExp(`from a ${selectedBinary.length}-byte selected range`));
    assert.match(binaryRangeResult, new RegExp(`Original file size: ${rangeBinarySource.length} bytes\.`));
  } finally {
    await fs.remove(root);
  }
});
