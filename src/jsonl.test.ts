import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { streamJsonlLines } from './jsonl';

test('JSONL streaming preserves Unicode line and paragraph separators inside JSON strings', async () => {
  const records = [
    { id: 1, text: 'line\u2028separator' },
    { id: 2, text: 'paragraph\u2029separator' },
  ];
  const input = `${JSON.stringify(records[0])}\r\n${JSON.stringify(records[1])}\n`;
  const separatorIndex = input.indexOf('\u2028');
  const chunks = [
    input.slice(0, separatorIndex + 1),
    input.slice(separatorIndex + 1, separatorIndex + 5),
    input.slice(separatorIndex + 5),
  ];
  const lines: string[] = [];

  await streamJsonlLines(Readable.from(chunks), line => { lines.push(line); });

  assert.deepEqual(lines.map(line => JSON.parse(line)), records);
});

test('JSONL streaming accepts a final record without a newline and skips blank lines', async () => {
  const lines: string[] = [];
  await streamJsonlLines(Readable.from(['\n  \r\n{"id":1}', '\n\n{"id":2}']), line => { lines.push(line); });
  assert.deepEqual(lines, ['{"id":1}', '{"id":2}']);
});
