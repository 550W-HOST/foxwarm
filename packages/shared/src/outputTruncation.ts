export type OutputTruncationPlaceholderKind = 'line' | 'line-range';

export interface OutputTruncationResult {
  text: string;
  truncated: boolean;
  originalLineCount: number;
  originalCharCount: number;
  lineTruncatedCount: number;
  omittedLineCount: number;
  omittedLineRange?: { begin: number; end: number };
  omittedLineReason?: string;
  placeholderKinds: OutputTruncationPlaceholderKind[];
  footerNotes: string[];
}

export interface TruncateOutputOptions {
  maxChars: number;
  force?: boolean;
  perLineMaxChars?: number;
  perLineHeadChars?: number;
  perLineTailChars?: number;
  lineOmissionReason?: string;
}

const DEFAULT_PER_LINE_MAX_CHARS = 550;
const DEFAULT_PER_LINE_HEAD_CHARS = 250;
const DEFAULT_PER_LINE_TAIL_CHARS = 250;

function replaceLoneSurrogates(text: string): string {
  let output = '';
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        output += text[i] + text[i + 1];
        i += 1;
      } else {
        output += '\uFFFD';
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      output += '\uFFFD';
      continue;
    }
    output += text[i];
  }
  return output;
}

function splitChars(text: string): string[] {
  const sanitized = replaceLoneSurrogates(text);
  const Segmenter = (Intl as any).Segmenter;
  if (typeof Segmenter === 'function') {
    try {
      const segmenter = new Segmenter(undefined, { granularity: 'grapheme' });
      return Array.from(segmenter.segment(sanitized), (part: any) => String(part.segment));
    } catch {
      // Fall through to code point splitting.
    }
  }
  return Array.from(sanitized);
}

function charLength(text: string): number {
  return splitChars(text).length;
}

function takeStart(text: string, count: number): string {
  if (count <= 0) return '';
  const chars = splitChars(text);
  return chars.length <= count ? chars.join('') : chars.slice(0, count).join('');
}

function takeEnd(text: string, count: number): string {
  if (count <= 0) return '';
  const chars = splitChars(text);
  return chars.length <= count ? chars.join('') : chars.slice(-count).join('');
}

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  return replaceLoneSurrogates(text).split(/\r\n|\n|\r/);
}

function joinedLength(lines: string[]): number {
  if (lines.length === 0) return 0;
  return lines.reduce((sum, line) => sum + charLength(line), 0) + Math.max(0, lines.length - 1);
}

function buildFooterNotes(result: Pick<OutputTruncationResult, 'lineTruncatedCount' | 'omittedLineCount' | 'omittedLineRange' | 'omittedLineReason' | 'originalLineCount' | 'originalCharCount'>): string[] {
  const notes: string[] = [];
  if (result.lineTruncatedCount > 0 || result.omittedLineCount > 0) {
    const placeholders: string[] = [];
    if (result.lineTruncatedCount > 0) placeholders.push('line-too-long placeholders');
    if (result.omittedLineCount > 0) placeholders.push('line-range omission placeholders');
    notes.push(`Foxwarm placeholders above (${placeholders.join(', ')}) are not original output content.`);
  }
  if (result.omittedLineCount > 0 && result.omittedLineRange && result.omittedLineReason) {
    notes.push(`Omitted ${result.omittedLineCount} line(s) from original line range ${result.omittedLineRange.begin}-${result.omittedLineRange.end} because ${result.omittedLineReason}.`);
  }
  notes.push(`Original output: ${result.originalLineCount} line(s), ${result.originalCharCount} character(s).`);
  return notes;
}

function truncateLongLines(lines: string[], options: Required<Pick<TruncateOutputOptions, 'perLineMaxChars' | 'perLineHeadChars' | 'perLineTailChars'>>): { lines: string[]; count: number } {
  let count = 0;
  const output = lines.map((line, index) => {
    const length = charLength(line);
    if (length <= options.perLineMaxChars) return line;
    count += 1;
    return `${takeStart(line, options.perLineHeadChars)}...[foxwarm: line too long (${length} chars at line ${index + 1})]...${takeEnd(line, options.perLineTailChars)}`;
  });
  return { lines: output, count };
}

function lineRangeOmissionMessage(omittedCount: number, begin: number, end: number, reason: string): string {
  return `[foxwarm: ${omittedCount} lines (line range ${begin}-${end}) omitted because ${reason}]`;
}

function lineRangePlaceholder(omittedCount: number, begin: number, end: number, reason: string): string {
  return `--- ${lineRangeOmissionMessage(omittedCount, begin, end, reason)} ---`;
}

function truncateWholeLines(lines: string[], maxChars: number, reason: string): { text: string; omittedLineCount: number; omittedLineRange?: { begin: number; end: number } } {
  const currentLength = joinedLength(lines);
  if (currentLength <= maxChars) {
    return { text: lines.join('\n'), omittedLineCount: 0 };
  }

  if (lines.length <= 1) {
    const line = lines[0] || '';
    const marker = lineRangeOmissionMessage(0, 1, 1, reason);
    const available = Math.max(0, maxChars - charLength(marker));
    const head = Math.ceil(available / 2);
    const tail = Math.max(0, available - head);
    return {
      text: `${takeStart(line, head)}${marker}${takeEnd(line, tail)}`,
      omittedLineCount: 0,
    };
  }

  const headBudget = Math.max(0, Math.floor(maxChars * 0.62));
  const tailBudget = Math.max(0, maxChars - headBudget);
  let headCount = 0;
  let headLength = 0;
  while (headCount < lines.length - 1) {
    const nextLength = charLength(lines[headCount]) + (headCount > 0 ? 1 : 0);
    if (headLength + nextLength > headBudget) break;
    headLength += nextLength;
    headCount += 1;
  }

  let tailCount = 0;
  let tailLength = 0;
  while (tailCount < lines.length - headCount - 1) {
    const line = lines[lines.length - 1 - tailCount];
    const nextLength = charLength(line) + (tailCount > 0 ? 1 : 0);
    if (tailLength + nextLength > tailBudget) break;
    tailLength += nextLength;
    tailCount += 1;
  }

  const build = () => {
    const omittedLineCount = Math.max(0, lines.length - headCount - tailCount);
    const begin = headCount + 1;
    const end = lines.length - tailCount;
    const marker = lineRangePlaceholder(omittedLineCount, begin, end, reason);
    const pieces = [
      ...lines.slice(0, headCount),
      marker,
      ...lines.slice(lines.length - tailCount),
    ];
    return { marker, pieces, omittedLineCount, begin, end, text: pieces.join('\n') };
  };

  let built = build();
  while (charLength(built.text) > maxChars && (headCount > 0 || tailCount > 0)) {
    if (tailCount > 0 && (tailCount >= headCount || headCount === 0)) {
      tailCount -= 1;
    } else if (headCount > 0) {
      headCount -= 1;
    } else {
      tailCount -= 1;
    }
    built = build();
  }

  return {
    text: built.text,
    omittedLineCount: built.omittedLineCount,
    omittedLineRange: { begin: built.begin, end: built.end },
  };
}

export function truncateOutputForDisplay(text: string, options: TruncateOutputOptions): OutputTruncationResult {
  const maxChars = Math.max(0, Math.floor(options.maxChars));
  const rawText = String(text ?? '');
  const originalText = replaceLoneSurrogates(rawText);
  const originalCharCount = charLength(originalText);
  const originalLines = splitLines(originalText);
  const originalLineCount = originalLines.length;

  if (!options.force && originalCharCount <= maxChars) {
    return {
      text: rawText,
      truncated: false,
      originalLineCount,
      originalCharCount,
      lineTruncatedCount: 0,
      omittedLineCount: 0,
      placeholderKinds: [],
      footerNotes: [],
    };
  }

  const lineOptions = {
    perLineMaxChars: options.perLineMaxChars ?? DEFAULT_PER_LINE_MAX_CHARS,
    perLineHeadChars: options.perLineHeadChars ?? DEFAULT_PER_LINE_HEAD_CHARS,
    perLineTailChars: options.perLineTailChars ?? DEFAULT_PER_LINE_TAIL_CHARS,
  };
  const longLineResult = truncateLongLines(originalLines, lineOptions);
  const reason = options.lineOmissionReason || 'this file is too long';
  const wholeLineResult = truncateWholeLines(longLineResult.lines, maxChars, reason);
  const placeholderKinds: OutputTruncationPlaceholderKind[] = [];
  if (longLineResult.count > 0) placeholderKinds.push('line');
  if (wholeLineResult.omittedLineCount > 0) placeholderKinds.push('line-range');

  const result: OutputTruncationResult = {
    text: wholeLineResult.text,
    truncated: true,
    originalLineCount,
    originalCharCount,
    lineTruncatedCount: longLineResult.count,
    omittedLineCount: wholeLineResult.omittedLineCount,
    omittedLineRange: wholeLineResult.omittedLineRange,
    omittedLineReason: wholeLineResult.omittedLineCount > 0 ? reason : undefined,
    placeholderKinds,
    footerNotes: [],
  };
  result.footerNotes = buildFooterNotes(result);
  return result;
}

export function formatTruncationFooterNotes(result: OutputTruncationResult): string[] {
  return result.footerNotes.slice();
}