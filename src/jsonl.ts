import type { Readable } from 'node:stream';

/**
 * Adapt a raw Node Readable to decoded UTF-8 JSONL chunks. Setting the stream
 * encoding uses Node's stateful decoder, including when a multi-byte code point
 * is split across Buffer chunks.
 */
export async function streamUtf8JsonlLines(
  stream: Readable,
  onLine: (line: string) => Promise<void> | void,
): Promise<void> {
  try {
    stream.setEncoding('utf8');
    await streamDecodedJsonlLines(stream as Readable & AsyncIterable<string>, onLine);
  } finally {
    stream.destroy();
  }
}

/**
 * Frame already-decoded JSONL chunks using LF, with an optional preceding CR.
 * Node.js 24 readline was observed to split on U+2028/U+2029 as well, but those
 * characters are valid inside JSON strings and are not JSONL record delimiters.
 * Lone CR framing is intentionally unsupported; JSONL records use LF or CRLF.
 */
export async function streamDecodedJsonlLines(
  chunks: AsyncIterable<string>,
  onLine: (line: string) => Promise<void> | void,
): Promise<void> {
  let remainder = '';
  for await (const chunk of chunks) {
    if (typeof chunk !== 'string') throw new TypeError('Decoded JSONL chunks must be strings');
    remainder += chunk;
    let newlineIndex = remainder.indexOf('\n');
    while (newlineIndex >= 0) {
      const rawLine = remainder.slice(0, newlineIndex);
      remainder = remainder.slice(newlineIndex + 1);
      const line = (rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine).trim();
      if (line) await onLine(line);
      newlineIndex = remainder.indexOf('\n');
    }
  }

  const line = remainder.trim();
  if (line) await onLine(line);
}
