import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { streamDecodedJsonlLines, streamUtf8JsonlLines } from './jsonl';

test('decoded JSONL framing preserves Unicode separators and LF/CRLF/final/blank semantics', async () => {
  const records = [
    { id: 1, text: 'line\u2028separator' },
    { id: 2, text: 'paragraph\u2029separator' },
    { id: 3, text: 'final record' },
  ];
  const chunks = Readable.from([
    `\n  \r\n${JSON.stringify(records[0])}\r`,
    `\n${JSON.stringify(records[1])}\n\n${JSON.stringify(records[2])}`,
  ]);
  const lines: string[] = [];
  const callbackOrder: number[] = [];

  await streamDecodedJsonlLines(chunks, async line => {
    const id = JSON.parse(line).id;
    await Promise.resolve();
    callbackOrder.push(id);
    lines.push(line);
  });

  assert.deepEqual(lines.map(line => JSON.parse(line)), records);
  assert.deepEqual(callbackOrder, [1, 2, 3]);
});

test('raw Buffer JSONL streaming statefully decodes every multi-byte boundary', async () => {
  const records = [{ text: 'line\u2028paragraph\u2029euro € supplementary 𐍈' }];
  const input = Buffer.from(`${JSON.stringify(records[0])}\n`, 'utf8');
  const oneByteChunks = Array.from(input, byte => Buffer.from([byte]));
  const lines: string[] = [];

  await streamUtf8JsonlLines(Readable.from(oneByteChunks), line => { lines.push(line); });

  assert.deepEqual(lines.map(line => JSON.parse(line)), records);
});

test('decoded framing rejects raw Buffers and the Readable wrapper destroys on callback failure', async () => {
  await assert.rejects(
    streamDecodedJsonlLines(Readable.from([Buffer.from('{"id":1}\n')]) as any, () => {}),
    /Decoded JSONL chunks must be strings/,
  );

  const stream = Readable.from(['{"id":1}\n']);
  await assert.rejects(streamUtf8JsonlLines(stream, () => { throw new Error('callback failed'); }), /callback failed/);
  assert.equal(stream.destroyed, true);
});
