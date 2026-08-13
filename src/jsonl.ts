import type { Readable } from 'node:stream';

/**
 * Stream newline-delimited JSON using only LF (and optional preceding CR) as
 * record delimiters. Node's readline also treats Unicode U+2028/U+2029 as
 * line endings, but those code points are valid unescaped characters inside
 * JSON strings and must not split a JSONL record.
 */
export async function streamJsonlLines(
  stream: Readable & AsyncIterable<string | Buffer>,
  onLine: (line: string) => Promise<void> | void,
): Promise<void> {
  let remainder = '';
  try {
    for await (const chunk of stream) {
      remainder += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
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
  } finally {
    stream.destroy();
  }
}
