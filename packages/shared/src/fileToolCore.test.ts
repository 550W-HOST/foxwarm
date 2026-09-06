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

test('ordinary file reads append metadata and preserve exact selected terminators', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-file-read-small-'));
  const filePath = path.join(root, 'small.txt');
  try {
    await fs.writeFile(filePath, 'one\ntwo\nthree\n');
    const reads: Array<{ offset: number; count: number }> = [];
    const operations = recordingFileOperations(reads);
    assert.equal(
      await readFileToolPath(filePath, 'small.txt', undefined, undefined, operations),
      'one\ntwo\nthree\n---\nFile has 3 lines.\nFile size: 14 bytes.',
    );
    assert.deepEqual(reads, [{ offset: 0, count: 14 }]);
    assert.equal(
      await readFileToolPath(filePath, 'small.txt', 2, 3),
      'two\nthree\n---\nSelected lines 2-3 of 3.\nFile size: 14 bytes.',
    );
  } finally {
    await fs.remove(root);
  }
});

test('ordinary ranges use physical line counts and explicit empty/out-of-range feedback', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-file-read-empty-range-'));
  const filePath = path.join(root, 'small.txt');
  try {
    await fs.writeFile(filePath, 'one\r\ntwo\n');
    assert.equal(
      await readFileToolPath(filePath, 'small.txt', 2, 20),
      'two\n---\nSelected line 2 of 2 (requested lines 2-20).\nFile size: 9 bytes.',
    );
    assert.equal(
      await readFileToolPath(filePath, 'small.txt', 4, 8),
      '(no content in requested line range 4-8)\n---\nFile has 2 lines.\nFile size: 9 bytes.',
    );
    assert.equal(
      await readFileToolPath(filePath, 'small.txt', 3.9, 2.9),
      '(no content in requested line range 3-2)\n---\nFile has 2 lines.\nFile size: 9 bytes.',
    );

    await fs.writeFile(filePath, 'one\n\ntwo');
    assert.equal(
      await readFileToolPath(filePath, 'small.txt', 2, 2),
      '\n---\nSelected line 2 of 3.\nFile size: 8 bytes.\nSelected lines contain only empty content.',
    );

    await fs.writeFile(filePath, '\n\nx');
    assert.equal(
      await readFileToolPath(filePath, 'small.txt', 1, 2),
      '\n\n---\nSelected lines 1-2 of 3.\nFile size: 3 bytes.\nSelected lines contain only empty content.',
    );

    await fs.writeFile(filePath, '\r\n\r\nx');
    assert.equal(
      await readFileToolPath(filePath, 'small.txt', 1, 2),
      '\r\n\r\n---\nSelected lines 1-2 of 3.\nFile size: 5 bytes.\nSelected lines contain only empty content.',
    );

    await fs.writeFile(filePath, ' \n\tx');
    assert.equal(
      await readFileToolPath(filePath, 'small.txt', 1, 2),
      ' \n\tx\n---\nSelected lines 1-2 of 2.\nFile size: 4 bytes.\nFile has no trailing newline.',
    );

    await fs.writeFile(filePath, 'a\n');
    assert.equal(
      await readFileToolPath(filePath, 'small.txt', 2, 99),
      '(no content in requested line range 2-99)\n---\nFile has 1 line.\nFile size: 2 bytes.',
    );

    await fs.writeFile(filePath, 'one\n\n');
    assert.equal(
      await readFileToolPath(filePath, 'small.txt', 4, 4),
      '(no content in requested line range 4-4)\n---\nFile has 2 lines.\nFile size: 5 bytes.',
    );

    await fs.writeFile(filePath, '');
    assert.equal(
      await readFileToolPath(filePath, 'small.txt'),
      '(empty file)\n---\nFile has 0 lines.\nFile size: 0 bytes.',
    );
    assert.equal(
      await readFileToolPath(filePath, 'small.txt', 1, 1),
      '(no content in requested line range 1-1)\n---\nFile has 0 lines.\nFile size: 0 bytes.',
    );
  } finally {
    await fs.remove(root);
  }
});

test('ordinary scanner preserves LF, CRLF, bare CR, mixed endings, and trailing-newline facts', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-file-read-endings-'));
  const filePath = path.join(root, 'endings.txt');
  try {
    await fs.writeFile(filePath, 'a\r\nb\r\n');
    assert.equal(
      await readFileToolPath(filePath, 'endings.txt', 1, 1),
      'a\r\n---\nSelected line 1 of 2.\nFile size: 6 bytes.',
    );

    await fs.writeFile(filePath, 'a\rb\r');
    assert.equal(
      await readFileToolPath(filePath, 'endings.txt', 2, 2),
      'b\r---\nSelected line 2 of 2.\nFile size: 4 bytes.',
    );

    await fs.writeFile(filePath, 'A\r\nB\rC\n');
    assert.equal(
      await readFileToolPath(filePath, 'endings.txt'),
      'A\r\nB\rC\n---\nFile has 3 lines.\nFile size: 7 bytes.',
    );

    await fs.writeFile(filePath, 'A\u0085B\u2028C\u2029D');
    assert.equal(
      await readFileToolPath(filePath, 'endings.txt'),
      'A\u0085B\u2028C\u2029D\n---\nFile has 1 line.\nFile size: 12 bytes.\nFile has no trailing newline.',
    );

    await fs.writeFile(filePath, 'a\nb');
    assert.equal(
      await readFileToolPath(filePath, 'endings.txt', 1, 1),
      'a\n---\nSelected line 1 of 2.\nFile size: 3 bytes.',
    );
    assert.equal(
      await readFileToolPath(filePath, 'endings.txt', 2, 2),
      'b\n---\nSelected line 2 of 2.\nFile size: 3 bytes.\nFile has no trailing newline.',
    );
    assert.equal(
      await readFileToolPath(filePath, 'endings.txt'),
      'a\nb\n---\nFile has 2 lines.\nFile size: 3 bytes.\nFile has no trailing newline.',
    );
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
    assert.match(result!, new RegExp(`File size: ${bytes.length} bytes\\.`));
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
    assert.match(rangeResult, /File size: \d+ bytes\./);

    const selectedBinary = Buffer.alloc(MAX_FULL_TEXT_READ_BYTES + 64);
    Buffer.from('RANGE_BINARY_HEAD').copy(selectedBinary);
    const rangeBinarySource = Buffer.concat([Buffer.from('first\n'), selectedBinary, Buffer.from('\nignored-after-end\n')]);
    await fs.writeFile(linesPath, rangeBinarySource);
    const binaryRangeResult = await readFileToolPath(linesPath, 'lines.txt', 2, 2) as string;
    assert.match(binaryRangeResult, /selected file range appears binary/);
    assert.match(binaryRangeResult, new RegExp(`from a ${selectedBinary.length + 1}-byte selected range`));
    assert.match(binaryRangeResult, new RegExp(`File size: ${rangeBinarySource.length} bytes\.`));

    for (const [name, ending, trailing] of [
      ['LF', Buffer.from('\n'), Buffer.from('next')],
      ['CRLF', Buffer.from('\r\n'), Buffer.from('next')],
      ['bare CR', Buffer.from('\r'), Buffer.from('next')],
      ['nonterminated', Buffer.alloc(0), Buffer.alloc(0)],
    ] as const) {
      const source = Buffer.concat([Buffer.from('first\n'), selectedBinary, ending, trailing]);
      await fs.writeFile(linesPath, source);
      const result = await readFileToolPath(linesPath, 'lines.txt', 2, 2) as string;
      assert.match(result, /selected file range appears binary/, name);
      assert.match(result, /source file remains unchanged\]\n---\nFile content was shortened for inline display\./, name);
      assert.doesNotMatch(result, /source file remains unchanged\]---/, name);
      if (name === 'nonterminated') assert.match(result, /File has no trailing newline\./);
    }
  } finally {
    await fs.remove(root);
  }
});

test('oversized empty and out-of-range selections return truthful nonempty notices', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-file-read-large-empty-range-'));
  const filePath = path.join(root, 'large.txt');
  const prefix = 'x'.repeat(MAX_FULL_TEXT_READ_BYTES + 64);
  const source = `${prefix}\n\n\nx`;
  try {
    await fs.writeFile(filePath, source);
    const emptyLineResult = await readFileToolPath(filePath, 'large.txt', 2, 3) as string;
    assert.match(emptyLineResult, /^\n\n---\nSelected lines 2-3\./);
    assert.match(emptyLineResult, /Selected lines contain only empty content\./);
    assert.match(emptyLineResult, new RegExp(`File size: ${Buffer.byteLength(source)} bytes\\.`));

    const crlfSource = `${prefix}\r\n\r\n\r\nx`;
    await fs.writeFile(filePath, crlfSource);
    const crlfEmptyResult = await readFileToolPath(filePath, 'large.txt', 2, 3) as string;
    assert.match(crlfEmptyResult, /^\r\n\r\n---\nSelected lines 2-3\./);
    assert.match(crlfEmptyResult, /Selected lines contain only empty content\./);

    const whitespaceSource = `${prefix}\n \n\tx`;
    await fs.writeFile(filePath, whitespaceSource);
    const whitespaceResult = await readFileToolPath(filePath, 'large.txt', 2, 2) as string;
    assert.match(whitespaceResult, /^ \n---/);
    assert.doesNotMatch(whitespaceResult, /contains only empty content/);

    await fs.writeFile(filePath, source);

    const reads: Array<{ offset: number; count: number }> = [];
    const outOfRangeResult = await readFileToolPath(
      filePath,
      'large.txt',
      5,
      8,
      recordingFileOperations(reads),
    ) as string;
    assert.ok(reads.length > 1);
    assert.ok(reads.every(read => read.count <= 64 * 1024));
    assert.match(outOfRangeResult, /^\(no content in requested line range 5-8\)\n---/);
    assert.match(outOfRangeResult, /File has 4 lines\./);
    assert.match(outOfRangeResult, new RegExp(`File size: ${Buffer.byteLength(source)} bytes\\.`));

    const reversedReads: Array<{ offset: number; count: number }> = [];
    const reversedResult = await readFileToolPath(
      filePath,
      'large.txt',
      9.8,
      3.2,
      recordingFileOperations(reversedReads),
    ) as string;
    assert.deepEqual(reversedReads, []);
    assert.match(reversedResult, /^\(no content in requested line range 9-3\)\n---/);
    assert.match(reversedResult, new RegExp(`File size: ${Buffer.byteLength(source)} bytes\\.`));
  } finally {
    await fs.remove(root);
  }
});

test('oversized scanner recognizes CRLF split across 64 KiB chunks and pending CR at EOF', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-file-read-large-crlf-boundary-'));
  const filePath = path.join(root, 'large.txt');
  try {
    const firstLine = 'x'.repeat((64 * 1024) - 1);
    const source = `${firstLine}\r\n${'y'.repeat(MAX_FULL_TEXT_READ_BYTES)}\r`;
    await fs.writeFile(filePath, source);
    const firstResult = await readFileToolPath(filePath, 'large.txt', 1, 1) as string;
    assert.ok(firstResult.startsWith(`${firstLine}\r\n---\nSelected line 1.`));
    assert.doesNotMatch(firstResult, /File has no trailing newline/);

    const secondResult = await readFileToolPath(filePath, 'large.txt', 2, undefined) as string;
    assert.match(secondResult, /Selected line 2 of 2\./);
    assert.match(secondResult, new RegExp(`File size: ${Buffer.byteLength(source)} bytes\\.`));
    assert.doesNotMatch(secondResult, /File has no trailing newline/);
  } finally {
    await fs.remove(root);
  }
});

test('oversized range reaching a final nonterminated line reports exact count and newline fact', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-file-read-large-no-newline-'));
  const filePath = path.join(root, 'large.txt');
  const source = `${'x'.repeat(MAX_FULL_TEXT_READ_BYTES + 32)}\nlast`;
  try {
    await fs.writeFile(filePath, source);
    const result = await readFileToolPath(filePath, 'large.txt', 2, 99) as string;
    assert.equal(
      result,
      `last\n---\nSelected line 2 of 2 (requested lines 2-99).\nFile size: ${Buffer.byteLength(source)} bytes.\nFile has no trailing newline.\nComplete content remains in source file: large.txt.`,
    );
  } finally {
    await fs.remove(root);
  }
});

test('oversized selected excerpts use scanner-owned LF, CRLF, bare-CR, and nonterminated footer adjacency', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-file-read-large-footer-ending-'));
  const filePath = path.join(root, 'large.txt');
  const selected = 'x'.repeat(MAX_FULL_TEXT_READ_BYTES + 32);
  try {
    await fs.writeFile(filePath, `first\n${selected}\nnext`);
    const lfResult = await readFileToolPath(filePath, 'large.txt', 2, 2) as string;
    assert.match(lfResult, /x\n---\nFile content was shortened for inline display\./);
    assert.doesNotMatch(lfResult, /x\n\n---\nFile content was shortened/);

    await fs.writeFile(filePath, `first\n${selected}\r\nnext`);
    const crlfResult = await readFileToolPath(filePath, 'large.txt', 2, 2) as string;
    assert.match(crlfResult, /x\r\n---\nFile content was shortened for inline display\./);
    assert.doesNotMatch(crlfResult, /x\r\n\n---\nFile content was shortened/);

    await fs.writeFile(filePath, `first\n${selected}\rnext`);
    const crResult = await readFileToolPath(filePath, 'large.txt', 2, 2) as string;
    assert.match(crResult, /x\r---\nFile content was shortened for inline display\./);
    assert.doesNotMatch(crResult, /x\r\n---\nFile content was shortened/);

    await fs.writeFile(filePath, `first\n${selected}`);
    const nonterminatedResult = await readFileToolPath(filePath, 'large.txt', 2, 2) as string;
    assert.match(nonterminatedResult, /x\n---\nFile content was shortened for inline display\./);
    assert.match(nonterminatedResult, /File has no trailing newline\./);
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
