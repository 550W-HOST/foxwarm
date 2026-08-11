import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'os';
import path from 'path';
import fs from 'fs-extra';
import { MAX_FULL_TEXT_READ_BYTES } from './boundedTextExcerpt';
import { readFileToolPath } from './fileToolCore';
import { nativeFileOperations, type FileOperations } from './fileOperations';

function recordingFileOperations(reads: Array<{ offset: number; count: number }>): FileOperations {
  return {
    ...nativeFileOperations,
    async read(filePath, offset, count) {
      reads.push({ offset, count });
      return nativeFileOperations.read(filePath, offset, count);
    },
  };
}

test('file reads preserve small-file and line-range behavior', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-file-read-small-'));
  const filePath = path.join(root, 'small.txt');
  try {
    await fs.writeFile(filePath, 'one\ntwo\nthree\n');
    const reads: Array<{ offset: number; count: number }> = [];
    const operations = recordingFileOperations(reads);
    assert.equal(await readFileToolPath(filePath, 'small.txt', undefined, undefined, operations), 'one\ntwo\nthree\n');
    assert.deepEqual(reads, [{ offset: 0, count: 14 }]);
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
    const reads: Array<{ offset: number; count: number }> = [];
    const result = await readFileToolPath(
      filePath,
      'large.txt',
      undefined,
      undefined,
      recordingFileOperations(reads),
    ) as string;
    assert.deepEqual(reads, [
      { offset: 0, count: 5000 },
      { offset: bytes.length - 5000, count: 5000 },
    ]);
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
    const reads: Array<{ offset: number; count: number }> = [];
    const rangeResult = await readFileToolPath(linesPath, 'lines.txt', 2, 2, recordingFileOperations(reads)) as string;
    assert.ok(reads.length > 1);
    assert.ok(reads.every(read => read.count <= 64 * 1024));
    assert.equal(reads[0].offset, 0);
    assert.equal(reads.at(-1)?.offset, MAX_FULL_TEXT_READ_BYTES);
    assert.ok(reads.every((read, index) => index === 0 || read.offset - reads[index - 1].offset === 64 * 1024));
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

test('directory and image reads stay target-local through file operations', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-file-read-kind-'));
  const imagePath = path.join(root, 'tiny.png');
  const linkedPath = path.join(root, 'linked.txt');
  const targetPath = path.join(root, 'target.txt');
  try {
    await fs.writeFile(targetPath, 'target');
    await fs.symlink(targetPath, linkedPath);
    const image = Buffer.from('not-a-real-png-but-preserved');
    await fs.writeFile(imagePath, image);
    const listing = await readFileToolPath(root, 'root') as string;
    assert.match(listing, /`linked\.txt` \(symlink\)/);
    assert.ok(listing.includes(`\`tiny.png\` (file, ${image.length} B)`));

    const reads: Array<{ offset: number; count: number }> = [];
    const result = await readFileToolPath(imagePath, 'tiny.png', undefined, undefined, recordingFileOperations(reads));
    assert.deepEqual(reads, [{ offset: 0, count: image.length }]);
    assert.equal(typeof result, 'object');
    assert.equal((result as any).inlineData.data, image.toString('base64'));
  } finally {
    await fs.remove(root);
  }
});
