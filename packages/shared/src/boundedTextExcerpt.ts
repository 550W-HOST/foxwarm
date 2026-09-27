import { open } from 'fs/promises';

/** Above this size, callers must use bounded samples rather than full reads. */
export const MAX_FULL_TEXT_READ_BYTES = 1024 * 1024;
export const BOUNDED_TEXT_SAMPLE_BYTES = 5000;
export const BINARY_HEX_PREVIEW_BYTES = 64;

export interface BoundedTextSampleAnalysis {
  suspiciousByteCount: number;
  escapedByteIndexes: Set<number>;
}

export interface BoundedTextExcerpt {
  isBinary: boolean;
  suspiciousByteCount: number;
  sampledByteCount: number;
  renderedHead?: string;
  renderedTail?: string;
  escapedByteCount: number;
}

export interface BoundedTextExcerptOptions {
  headMayEndMidCodePoint: boolean;
  tailMayStartMidCodePoint: boolean;
}

/**
 * Reads fixed-size samples without decoding or allocating the rest of a file.
 * The caller supplies the stat-time size used for its user-facing metadata.
 */
export async function readBoundedFileSamples(filePath: string, byteLength: number): Promise<{ head: Buffer; tail: Buffer }> {
  const sampleLength = Math.min(BOUNDED_TEXT_SAMPLE_BYTES, byteLength);
  const file = await open(filePath, 'r');
  try {
    const readAt = async (position: number): Promise<Buffer> => {
      const buffer = Buffer.alloc(sampleLength);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
      return buffer.subarray(0, bytesRead);
    };
    return {
      head: await readAt(0),
      tail: await readAt(Math.max(0, byteLength - sampleLength)),
    };
  } finally {
    await file.close();
  }
}

/**
 * Scores text safety without changing valid controls. Invalid UTF-8 and
 * sample-boundary fragments are separately recorded for visible \xNN display.
 */
export function analyzeBoundedTextSample(
  sample: Buffer,
  options: { allowLeadingBoundaryContinuation: boolean; allowTrailingBoundarySequence: boolean },
): BoundedTextSampleAnalysis {
  const escapedByteIndexes = new Set<number>();
  let suspiciousByteCount = 0;
  const mark = (start: number, count: number, suspicious: boolean, escapeForDisplay: boolean): void => {
    if (escapeForDisplay) {
      for (let index = start; index < start + count; index += 1) escapedByteIndexes.add(index);
    }
    if (suspicious) suspiciousByteCount += count;
  };
  const isContinuation = (byte: number): boolean => byte >= 0x80 && byte <= 0xbf;
  let index = 0;

  while (options.allowLeadingBoundaryContinuation && index < Math.min(3, sample.length) && isContinuation(sample[index])) {
    mark(index, 1, false, true);
    index += 1;
  }

  while (index < sample.length) {
    const byte = sample[index];
    if (byte <= 0x7f) {
      // Controls are valid UTF-8 and remain raw, but they still inform the classifier.
      if ((byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) || byte === 0x7f) mark(index, 1, true, false);
      index += 1;
      continue;
    }

    const width = byte >= 0xc2 && byte <= 0xdf ? 2
      : byte >= 0xe0 && byte <= 0xef ? 3
        : byte >= 0xf0 && byte <= 0xf4 ? 4
          : 0;
    if (width === 0) {
      mark(index, 1, true, true);
      index += 1;
      continue;
    }
    if (index + width > sample.length) {
      mark(index, sample.length - index, !options.allowTrailingBoundarySequence, true);
      break;
    }
    let codePoint = byte & (width === 2 ? 0x1f : width === 3 ? 0x0f : 0x07);
    let valid = true;
    for (let offset = 1; offset < width; offset += 1) {
      const continuation = sample[index + offset];
      if (!isContinuation(continuation)) {
        valid = false;
        break;
      }
      codePoint = (codePoint << 6) | (continuation & 0x3f);
    }
    const minimum = width === 2 ? 0x80 : width === 3 ? 0x800 : 0x10000;
    if (!valid || codePoint < minimum || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
      mark(index, 1, true, true);
      index += 1;
      continue;
    }
    // U+0080–U+009F are C1 controls even when correctly UTF-8 encoded.
    if (codePoint >= 0x80 && codePoint <= 0x9f) mark(index, width, true, false);
    index += width;
  }
  return { suspiciousByteCount, escapedByteIndexes };
}

export function renderBoundedTextSample(sample: Buffer, analysis: BoundedTextSampleAnalysis): { text: string; escapedByteCount: number } {
  const parts: string[] = [];
  let segmentStart = 0;
  let escapedByteCount = 0;
  for (let index = 0; index < sample.length; index += 1) {
    if (!analysis.escapedByteIndexes.has(index)) continue;
    if (segmentStart < index) parts.push(sample.subarray(segmentStart, index).toString('utf8'));
    parts.push(`\\x${sample[index].toString(16).padStart(2, '0')}`);
    segmentStart = index + 1;
    escapedByteCount += 1;
  }
  if (segmentStart < sample.length) parts.push(sample.subarray(segmentStart).toString('utf8'));
  return { text: parts.join(''), escapedByteCount };
}

export function buildBoundedTextExcerpt(head: Buffer, tail: Buffer, options: BoundedTextExcerptOptions): BoundedTextExcerpt {
  const headAnalysis = analyzeBoundedTextSample(head, {
    allowLeadingBoundaryContinuation: false,
    allowTrailingBoundarySequence: options.headMayEndMidCodePoint,
  });
  const tailAnalysis = analyzeBoundedTextSample(tail, {
    allowLeadingBoundaryContinuation: options.tailMayStartMidCodePoint,
    allowTrailingBoundarySequence: false,
  });
  const sampledByteCount = head.length + tail.length;
  const suspiciousByteCount = headAnalysis.suspiciousByteCount + tailAnalysis.suspiciousByteCount;
  if (suspiciousByteCount > sampledByteCount * 0.1) {
    return { isBinary: true, suspiciousByteCount, sampledByteCount, escapedByteCount: 0 };
  }
  const renderedHead = renderBoundedTextSample(head, headAnalysis);
  const renderedTail = renderBoundedTextSample(tail, tailAnalysis);
  return {
    isBinary: false,
    suspiciousByteCount,
    sampledByteCount,
    renderedHead: renderedHead.text,
    renderedTail: renderedTail.text,
    escapedByteCount: renderedHead.escapedByteCount + renderedTail.escapedByteCount,
  };
}

export function formatBoundedBinaryHexPreview(head: Buffer, tail: Buffer, byteLength: number, subject: string, byteSource: string = 'file'): string {
  const toHex = (sample: Buffer) => sample.subarray(0, BINARY_HEX_PREVIEW_BYTES).toString('hex');
  return [
    `[foxwarm: ${subject} appears binary; showing hexadecimal previews from a ${byteLength}-byte ${byteSource}]`,
    `Head (${Math.min(head.length, BINARY_HEX_PREVIEW_BYTES)} bytes): ${toHex(head)}`,
    `Tail (${Math.min(tail.length, BINARY_HEX_PREVIEW_BYTES)} bytes): ${toHex(tail)}`,
    '[foxwarm: raw binary content omitted; source file remains unchanged]',
  ].join('\n');
}

export function formatDisplayByteConversionDisclaimer(subject: 'command output' | 'file content'): string {
  return `Foxwarm \\xNN placeholders above are display conversions, not literal ${subject}.`;
}
